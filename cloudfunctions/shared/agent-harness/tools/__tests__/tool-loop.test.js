/**
 * 工具调用循环的协议测试
 *
 * ## 为什么用 mock fetch 而不是真调 API
 *
 * 这层最容易出的错是**协议错**而不是逻辑错：assistant.tool_calls 没回传、
 * tool_call_id 对不上、模型返回了多个 tool_call 只处理了一个、
 * 轮次失控无限循环。这些用假响应就能全部覆盖，且不花钱、秒级完成。
 * 真实 API 的连通性由 tools/verify-llm-ab.js 负责，两者互补。
 */

const assert = require('assert');
const client = require('../../llm-client');
const { TOOL_DEFINITIONS, executeTool } = require('../index');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
  }
}

const BILLS = [
  { amount: 80000, date: '2026-10-01', categoryPath: '餐饮/在家吃饭/买菜' },
  { amount: 30000, date: '2026-10-02', categoryPath: '餐饮/外出就餐/火锅烧烤' },
  { amount: 20000, date: '2026-10-05', categoryPath: '交通出行/日常交通/加油' }
];
const CTX = { month: '2026-10', billsByMonth: { '2026-10': BILLS } };
const { mockHttp } = require('./http-mock');

/**
 * 安装假 HTTP：按脚本依次返回预设响应
 *
 * ⚠️ 注入的是 http-client 而不是 global.fetch——
 * 云端走的是 https 模块那条路，mock 也必须走同一条。
 */
function mockFetch(responses) {
  let i = 0;
  mockHttp(async () => {
    const body = responses[Math.min(i, responses.length - 1)];
    i++;
    return {
      ok: true, status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body)
    };
  });
  return () => i; // 返回已调用次数
}

function toolCallResp(calls, tokens = 50) {
  return {
    choices: [{ message: { role: 'assistant', content: null, tool_calls: calls } }],
    usage: { prompt_tokens: tokens, completion_tokens: 0, total_tokens: tokens }
  };
}

function finalResp(content, tokens = 30) {
  return {
    choices: [{ message: { role: 'assistant', content } }],
    usage: { prompt_tokens: 0, completion_tokens: tokens, total_tokens: tokens }
  };
}

function tc(id, name, args = {}) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

const run = (opts) => client.chatWithTools({
  messages: [{ role: 'system', content: '你是消费分析师' }],
  tools: TOOL_DEFINITIONS,
  executeTool: (n, a) => executeTool(n, a, CTX),
  jsonMode: true,
  maxRounds: 3,
  timeoutMs: 5000,
  ...opts
});

async function main() {
  process.env.DEEPSEEK_API_KEY = 'mock-key';

  console.log('\n【工具调用往返】');

  await test('模型请求工具 → 本地执行 → 模型据结果成文', async () => {
    const count = mockFetch([
      toolCallResp([tc('c1', 'get_category_share'), tc('c2', 'get_dining_structure')]),
      finalResp('{"insights":["餐饮占92.3%"],"savings":[]}')
    ]);
    const r = await run();

    assert.strictEqual(r.ok, true, `应成功，实际: ${r.error}`);
    assert.strictEqual(r.rounds, 2, '应恰好 2 轮');
    assert.strictEqual(count(), 2, '不应有额外请求');
    // 一轮里多个 tool_call 必须**全部**执行，不能只处理第一个
    assert.strictEqual(r.toolCalls.length, 2, '两个工具都应被执行');
    assert.ok(r.toolCalls.every((c) => c.ok), '工具不应报错');
    assert.ok(r.content.includes('insights'), '应返回最终 JSON');
    // token 必须跨轮累计，否则成本统计会严重低估
    assert.strictEqual(r.usage.total_tokens, 80, 'token 应跨轮累计');
  });

  await test('assistant.tool_calls 原样回传给模型', async () => {
    let capturedBody = null;
    mockHttp(async (url, init) => {
      capturedBody = JSON.parse(init.body);
      return {
        ok: true, status: 200,
        json: async () => (capturedBody.messages.length > 1 && capturedBody.messages[1].role === 'tool'
          ? finalResp('{"insights":[],"savings":[]}')
          : toolCallResp([tc('c1', 'get_monthly_summary')])),
        text: async () => ''
      };
    });
    await run();

    // 第 2 次请求的消息序列必须是 system → assistant(tool_calls) → tool
    const msgs = capturedBody.messages;
    const assistantMsg = msgs.find((m) => m.role === 'assistant');
    const toolMsg = msgs.find((m) => m.role === 'tool');
    assert.ok(assistantMsg, '缺少 assistant 消息');
    assert.ok(assistantMsg.tool_calls, 'assistant 消息缺 tool_calls');
    assert.strictEqual(assistantMsg.tool_calls[0].id, 'c1', 'tool_call id 必须保持一致');
    assert.ok(toolMsg, '缺少 tool 结果消息');
    assert.strictEqual(toolMsg.tool_call_id, 'c1', 'tool_call_id 必须与请求匹配');
  });

  await test('工具报错要回传给模型，不能静默吞掉', async () => {
    let toolContent = null;
    mockHttp(async (url, init) => {
      const body = JSON.parse(init.body);
      if (body.messages.some((m) => m.role === 'tool')) {
        toolContent = body.messages.find((m) => m.role === 'tool').content;
        return { ok: true, status: 200, json: async () => finalResp('{"insights":[],"savings":[]}'), text: async () => '' };
      }
      return { ok: true, status: 200, json: async () => toolCallResp([tc('c1', 'no_such_tool')]), text: async () => '' };
    });
    await run();

    assert.ok(toolContent, '工具错误必须回传');
    const parsed = JSON.parse(toolContent);
    assert.ok(parsed.error, '错误内容应包含 error 字段');
    assert.ok(parsed.error.includes('未知工具'), '应说明是未知工具');
  });

  await test('模型陷入循环时按 maxRounds 止损', async () => {
    // 一直返回 tool_calls，永不成文 —— 必须被轮次上限拦住
    const count = mockFetch([toolCallResp([tc('c1', 'get_category_share')])]);
    const r = await run({ maxRounds: 3 });

    assert.strictEqual(r.ok, false, '无限循环必须判失败而非卡死');
    assert.strictEqual(count(), 3, '应恰好在 maxRounds 处停止');
    assert.ok(r.error.includes('轮次'), `错误信息应说明轮次超限: ${r.error}`);
  });

  await test('模型直接给结论（不调工具）也能工作', async () => {
    mockFetch([finalResp('{"insights":["直接给的结论"],"savings":[]}')]);
    const r = await run();
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.rounds, 1);
    assert.strictEqual(r.toolCalls.length, 0);
  });

  await test('非法 JSON 参数不导致崩溃', async () => {
    mockFetch([
      { choices: [{ message: { role: 'assistant', content: null, tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'get_top_categories', arguments: '{不是JSON' } }
      ]}}] },
      finalResp('{"insights":[],"savings":[]}')
    ]);
    const r = await run();
    assert.strictEqual(r.ok, true, '参数解析失败应降级为空参，而不是抛异常');
  });

  await test('网络持续失败返回明确错误', async () => {
    mockHttp(async () => { throw new Error('network down'); });
    const r = await run();
    assert.strictEqual(r.ok, false);
    assert.ok(r.error, '必须有错误信息');
  });

  await test('无 API Key 时走 mock 标记而非崩溃', async () => {
    const saved = process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    const r = await run();
    process.env.DEEPSEEK_API_KEY = saved;

    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.mock, true, '应标记为 mock 模式让上层降级');
    assert.strictEqual(r.error, 'NO_API_KEY');
  });

  console.log(`\n${failed === 0 ? '✓ 全部通过' : '✗ 有失败'}：${passed} 通过 / ${failed} 失败\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main();