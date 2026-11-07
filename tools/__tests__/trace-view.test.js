/**
 * trace-view 报告生成器的测试
 *
 * ## 为什么这个工具需要测试
 *
 * 它是**排查工具**——出问题时你正依赖它。
 * 一个平时不触发、只在特定事件分支里崩溃的 bug，
 * 恰好会在你最需要它的时候发作。
 *
 * 实测踩过：`case` 分支里写了 `p.payload` 但那个作用域里没定义 `p`，
 * 9 处。只有走到「数值对账未通过」这类事件才会崩——
 * 而那正是最需要看报告的时刻。
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

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

const ROOT = path.resolve(__dirname, '..', '..');
const VIEWER = path.join(ROOT, 'tools', 'trace-view.js');

/** 构造一份覆盖所有事件类型的日志 */
function makeTraceLog() {
  const id = 'abc123def456';
  const events = [
    ['llm_request', { round: 1, model: 'deepseek-chat', temperature: 0.5, maxTokens: 1400, jsonMode: true, toolCount: 11, messages: [{ role: 'system', length: 3065, preview: '你是消费分析师' }] }],
    ['llm_response', { round: 1, latencyMs: 12, usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }, content: '', toolCalls: [{ id: 'c1', type: 'function', function: { name: 'get_compressibility', arguments: '{}' } }], finishReason: '' }],
    ['tool_call', { round: 1, name: 'get_compressibility', args: {}, ok: true, error: '', latencyMs: 8, resultSummary: { ok: true, rigidPercent: 14.2, categories: [{ path: 'a/b/c', amount: '500.00' }] } }],
    ['tool_call', { round: 1, name: 'some_tool', args: {}, ok: false, error: '出错了', latencyMs: 3, resultSummary: { ok: false, error: '出错了' } }],
    ['llm_request', { round: 2, model: 'deepseek-chat', temperature: 0.5, maxTokens: 1400, jsonMode: true, toolCount: 11, messages: [{ role: 'tool', toolCallId: 'c1', length: 1030 }] }],
    ['llm_response', { round: 2, latencyMs: 9, usage: { prompt_tokens: 200, completion_tokens: 80, total_tokens: 280 }, content: '{"insights":["x"],"savings":[]}', toolCalls: [], finishReason: 'stop' }],
    // ↓ 下面这些是「只有触发才会崩」的分支
    ['numeric_mismatch', { uncited: [{ text: '554.5', sentence: '交通出行 554.50 元' }] }],
    ['rigid_category_violation', { violations: ['控制学费支出 → 刚性类目「育儿教育」'] }],
    ['saving_amount_recomputed', { fixed: 1 }],
    ['savings_filtered', { dropped: 2 }],
    ['validation_failed', { stage: 'schema', error: '缺少字段' }],
    ['llm_tool_failed', { error: '模型工具链失败', rounds: 3 }],
    ['fallback_error', { error: '兜底也出错' }],
    ['SUMMARY', { agent: 'insight', version: 'v2', ok: false, isFallback: true, reason: 'NUMERIC_CITATION_MISMATCH', usage: { total_tokens: 400 }, latencyMs: 55 }]
  ];

  const lines = [];
  for (const [event, payload] of events) {
    lines.push(`[TRACE:${id}] ${event} ${JSON.stringify(payload)}`);
  }
  lines.push(`===== TRACE ${id} =====`);
  for (const [event, payload] of events) {
    lines.push(`  [+   0ms] ${event}  ${JSON.stringify(payload)}`);
  }
  lines.push(`===== END TRACE ${id} =====`);
  return lines.join('\n');
}

console.log('\n【全事件覆盖】');

test('所有事件类型都能渲染，不抛异常', () => {
  const tmp = path.join(require('os').tmpdir(), 'trace-view-test.log');
  fs.writeFileSync(tmp, makeTraceLog(), 'utf8');
  try {
    const out = execFileSync(process.execPath, [VIEWER, tmp], { encoding: 'utf8' });
    assert.ok(out.length > 0, '应有输出');
    // 每种事件都应在报告里留下痕迹
    assert.ok(out.includes('数值对账未通过'), '应显示数值对账事件');
    assert.ok(out.includes('刚性类目违规'), '应显示刚性违规事件');
    assert.ok(out.includes('金额重算'), '应显示金额重算事件');
    assert.ok(out.includes('过滤不可信建议'), '应显示过滤事件');
    assert.ok(out.includes('结构校验失败'), '应显示校验失败事件');
    assert.ok(out.includes('模型工具链失败'), '应显示工具链失败事件');
    assert.ok(out.includes('兜底也出错'), '应显示兜底错误事件');
  } catch (e) {
    const out = (e.stdout && e.stdout.toString()) || '';
    const err = (e.stderr && e.stderr.toString()) || e.message;
    throw new Error(`渲染失败：${err.split('\n').slice(0, 3).join(' ')}\n输出片段：${out.slice(0, 200)}`);
  } finally {
    fs.unlinkSync(tmp);
  }
});

test('源码里不该有未定义的 p 变量', () => {
  const src = fs.readFileSync(VIEWER, 'utf8');
  // p.payload 曾经是个未定义变量的笔误
  assert.ok(!/[^a-zA-Z_.]p\.payload/.test(src),
    '发现 p.payload —— 该变量在 case 分支里未定义，应为 s.payload');
});

test('无参数时给出用法提示而不是崩溃', () => {
  try {
    execFileSync(process.execPath, [VIEWER], { encoding: 'utf8', stdio: 'pipe' });
    throw new Error('无参数时应当以非零码退出');
  } catch (e) {
    // 预期：非零退出 + 有提示文字
    assert.strictEqual(e.status, 1, '应以非零码退出');
    const err = (e.stderr && e.stderr.toString()) || '';
    assert.ok(err.includes('用法'), '应给出用法提示');
  }
});

test('日志里没有 TRACE 时给出可操作的提示', () => {
  const tmp = path.join(require('os').tmpdir(), 'trace-view-empty.log');
  fs.writeFileSync(tmp, '普通日志，没有任何 trace 标记\n', 'utf8');
  try {
    execFileSync(process.execPath, [VIEWER, tmp], { encoding: 'utf8', stdio: 'pipe' });
    throw new Error('没有 TRACE 时应当以非零码退出');
  } catch (e) {
    assert.strictEqual(e.status, 1);
    const err = (e.stderr && e.stderr.toString()) || '';
    assert.ok(err.includes('DEBUG_TRACE'), '应提示检查 DEBUG_TRACE 环境变量');
    assert.ok(err.includes('analysis-svc'), '应指明是哪个云函数');
  } finally {
    fs.unlinkSync(tmp);
  }
});

test('文件不存在时给出明确提示', () => {
  try {
    execFileSync(process.execPath, [VIEWER, '/no/such/file.log'], { encoding: 'utf8', stdio: 'pipe' });
    throw new Error('文件不存在时应当以非零码退出');
  } catch (e) {
    assert.strictEqual(e.status, 1);
    const err = (e.stderr && e.stderr.toString()) || '';
    assert.ok(err.includes('文件不存在'), '应提示文件不存在');
  }
});

console.log('\n【本地 demo 脚本】');

test('trace-demo 能跑通并产出可解析的日志', () => {
  const demo = path.join(ROOT, 'tools', 'trace-demo.js');
  const out = execFileSync(process.execPath, [demo], { encoding: 'utf8' });
  assert.ok(out.includes('[TRACE:'), '应产出 TRACE 记录');
  assert.ok(out.includes('tool_call'), '应记录工具调用');
  assert.ok(out.includes('llm_request'), '应记录模型请求');
  // 再喂给查看器，确认能渲染
  const tmp = path.join(require('os').tmpdir(), 'trace-demo-out.log');
  fs.writeFileSync(tmp, out, 'utf8');
  try {
    const report = execFileSync(process.execPath, [VIEWER, tmp], { encoding: 'utf8' });
    assert.ok(report.includes('TRACE'), '报告应能渲染');
  } finally {
    fs.unlinkSync(tmp);
  }
});

console.log(`\n${failed === 0 ? '✓ 全部通过' : '✗ 有失败'}：${passed} 通过 / ${failed} 失败\n`);
process.exit(failed === 0 ? 0 : 1);
