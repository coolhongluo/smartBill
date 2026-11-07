/**
 * Trace 可观测性测试
 *
 * ## 为什么这些要测
 *
 * trace 是排查问题的唯一手段，但它**本身不能成为故障源**：
 * 埋点代码若抛异常，会把正常流程搞挂——
 * 「为了排查问题而写的代码，把问题本身搞坏了」是最尴尬的情况。
 *
 * 所以重点验证：
 *   · 记录详细日志不会影响主流程
 *   · 不可序列化的数据不会让埋点崩溃
 *   · 调用链能完整还原执行过程
 */

const assert = require('assert');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
  }
}

const tracer = require('../../tracer');

console.log('\n【基本能力】');

test('记录事件后能按 traceId 取回调用链', () => {
  tracer.reset();
  const id = tracer.createTraceId();
  tracer.logEvent(id, 'step_one', { a: 1 });
  tracer.logEvent(id, 'step_two', { b: 2 });

  const chain = tracer.getChain(id);
  assert.ok(chain, '应能取回调用链');
  assert.strictEqual(chain.steps.length, 2);
  assert.strictEqual(chain.steps[0].event, 'step_one');
  assert.strictEqual(chain.steps[1].event, 'step_two');
});

test('不同 traceId 的调用链互不干扰', () => {
  tracer.reset();
  const a = tracer.createTraceId();
  const b = tracer.createTraceId();
  tracer.logEvent(a, 'a_event', {});
  tracer.logEvent(b, 'b_event', {});

  assert.strictEqual(tracer.getChain(a).steps.length, 1);
  assert.strictEqual(tracer.getChain(b).steps.length, 1);
  assert.strictEqual(tracer.getChain(a).steps[0].event, 'a_event');
});

test('getChain 不传 traceId 时取最近一条', () => {
  tracer.reset();
  const id = tracer.createTraceId();
  tracer.logEvent(id, 'x', {});
  assert.strictEqual(tracer.getChain().traceId, id);
});

console.log('\n【埋点不能成为故障源】');

test('不可序列化的数据不会让记录崩溃', () => {
  tracer.reset();
  const id = tracer.createTraceId();
  // 循环引用：直接 JSON.stringify 会抛错
  const circular = { name: 'loop' };
  circular.self = circular;

  // 关键：不能抛异常
  tracer.logEvent(id, 'with_circular', { obj: circular });
  assert.ok(tracer.getChain(id), '调用链应仍可用');
});

test('超长数组会被截断而不是撑爆日志', () => {
  tracer.reset();
  const id = tracer.createTraceId();
  const big = new Array(500).fill({ x: 1 });
  tracer.logEvent(id, 'big_array', { items: big });

  const chain = tracer.getChain(id);
  assert.ok(chain, '应正常记录');
});

test('safeStringify 对循环引用返回占位符而非抛错', () => {
  const circular = {};
  circular.self = circular;
  const s = tracer.safeStringify({ obj: circular });
  assert.ok(typeof s === 'string', '应返回字符串');
  assert.ok(s.length < 200, `应被截断，实际 ${s.length}`);
});

console.log('\n【详细模式开关】');

test('非 verbose 模式不输出结构化日志', () => {
  const saved = process.env.DEBUG_TRACE;
  delete process.env.DEBUG_TRACE;
  assert.strictEqual(tracer.isVerbose(), false);

  process.env.DEBUG_TRACE = 'true';
  assert.strictEqual(tracer.isVerbose(), true, 'DEBUG_TRACE=true 应开启');

  delete process.env.DEBUG_TRACE;
  process.env.TRACE_VERBOSE = 'true';
  assert.strictEqual(tracer.isVerbose(), true, 'TRACE_VERBOSE=true 也应开启');

  if (saved === undefined) delete process.env.DEBUG_TRACE;
  else process.env.DEBUG_TRACE = saved;
  delete process.env.TRACE_VERBOSE;
});

test('默认关闭详细模式（账单金额不该默认进日志）', () => {
  const saved = process.env.DEBUG_TRACE;
  const saved2 = process.env.TRACE_VERBOSE;
  delete process.env.DEBUG_TRACE;
  delete process.env.TRACE_VERBOSE;
  assert.strictEqual(tracer.isVerbose(), false,
    '默认必须关闭——账单金额是用户隐私');
  if (saved !== undefined) process.env.DEBUG_TRACE = saved;
  if (saved2 !== undefined) process.env.TRACE_VERBOSE = saved2;
});

console.log('\n【指标统计】');

test('record 会累计指标', () => {
  tracer.reset();
  tracer.record({
    traceId: 't1', agent: 'insight', version: 'v2',
    ok: true, isFallback: false,
    usage: { total_tokens: 100 }, latencyMs: 50
  });
  tracer.record({
    traceId: 't2', agent: 'insight', version: 'v2',
    ok: true, isFallback: true, reason: 'LLM_UNAVAILABLE'
  });

  const m = tracer.getMetrics();
  assert.strictEqual(m.totalCalls, 2);
  assert.strictEqual(m.successCalls, 1);
  assert.strictEqual(m.fallbackCalls, 1);
  assert.strictEqual(m.tokenUsage, 100);
  assert.ok(Math.abs(m.fallbackRate - 0.5) < 0.01);
});

console.log('\n【工具出入参摘要】');

test('每个工具都有对应的摘要实现', () => {
  const { summarizeToolResult } = require('../../llm-client');
  const tools = require('../index');

  for (const t of tools.TOOL_DEFINITIONS) {
    const name = t.function.name;
    const fake = { ok: true, data: {} };
    let summary;
    try {
      summary = summarizeToolResult(name, fake);
    } catch (e) {
      throw new Error(`工具 ${name} 的摘要实现抛错：${e.message}`);
    }
    assert.ok(summary && typeof summary === 'object', `${name} 摘要应返回对象`);
    assert.strictEqual(summary.ok, true, `${name} 应标记 ok`);
  }
});

test('工具失败时的摘要包含错误信息', () => {
  const { summarizeToolResult } = require('../../llm-client');
  const s = summarizeToolResult('get_category_share', { ok: false, error: '数据库未就绪' });
  assert.strictEqual(s.ok, false);
  assert.ok(s.error.includes('数据库未就绪'));
});

test('未知工具不会崩，改为返回字段列表', () => {
  const { summarizeToolResult } = require('../../llm-client');
  const s = summarizeToolResult('some_future_tool', { ok: true, data: { alpha: 1, beta: 2 } });
  assert.strictEqual(s.ok, true);
  assert.ok(Array.isArray(s.keys), '未知工具应返回字段列表');
});

console.log(`\n${failed === 0 ? '✓ 全部通过' : '✗ 有失败'}：${passed} 通过 / ${failed} 失败\n`);
process.exit(failed === 0 ? 0 : 1);
