/**
 * 「结论必须基于已调用的工具」测试
 *
 * ## 为什么要换掉数值对账
 *
 * 原机制：模型写完 → 事后逐个数字查白名单 → 有对不上的整条作废。
 * 三个问题：
 *   1. 误伤率高（格式差一位就失败）
 *   2. 粒度错（一句话里其他正确的判断被一起推翻）
 *   3. 治标——查「数字有没有出处」，查不出「这个结论本就没有工具支撑」
 *
 * 新机制：**事前约束**。要说什么结论，就必须有对应工具被调用过。
 * 没调用 → 那条结论不做（不是整条作废）。
 *
 * ## 关键区分
 *
 * 「不做这条结论」≠「整条退回兜底」。
 * 用户看到少一句有根据的话，比什么都看不到要好。
 */

const assert = require('assert');

/**
 * ⚠️ 这个 require 必须在下面 mockHttp(...) 调用**之前**
 *
 * `const` 有暂时性死区（TDZ）：声明之前的引用会抛
 * ReferenceError: Cannot access 'mockHttp' before initialization，
 * 而不是 undefined。所以 require 必须提到使用点上方。
 */
const { mockHttp } = require('./http-mock');

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

/* ── 模拟模型调用 ── */

let mockResponses = [];
let fetchCount = 0;

/**
 * ⚠️ 注入 http-client 而不是 global.fetch——
 * 云端走的是 https 模块那条路，mock 必须走同一条。
 * （mock global.fetch 会让测试通过、但测的是本地 Node 22 的假路径）
 */
mockHttp(async () => {
  const r = mockResponses[fetchCount] || mockResponses[mockResponses.length - 1];
  fetchCount++;
  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: r }],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }
    }),
    text: async () => ''
  };
});

const ROOT = '../../';
const harness = require(`${ROOT}index`);
const agent = require(`${ROOT}agents/insight.agent`);
harness.registerAgent(agent.name, agent);

const mk = (amountYuan, categoryPath, note, categoryId) => ({
  amount: Math.round(amountYuan * 100),
  date: '2026-10-01',
  categoryPath,
  note: note || '',
  categoryId: categoryId || 'x'
});

const BILLS = [
  mk(504.5, '交通出行/日常交通/加油', '95号油', 'c2_1_5'),
  mk(200, '餐饮/外出就餐/火锅烧烤', '同事聚餐', 'c1_2_2'),
  mk(200, '育儿教育/教育支出/学费', '孩子学费', 'c4_2_1'),
  mk(500, '服饰美容/衣物鞋帽/衣物', '买外套', 'c6_1_1')
];

const stats = require(`${ROOT}bill-stats`);
const { bills } = stats.normalizeBills(BILLS);

process.env.DEEPSEEK_API_KEY = 'test-key';

function toolCall(name, args = '{}') {
  return {
    role: 'assistant',
    content: null,
    tool_calls: [{ id: 'c_' + name, type: 'function', function: { name, arguments: args } }]
  };
}

function final(content) {
  return { role: 'assistant', content };
}

async function run(responses) {
  mockResponses = responses;
  fetchCount = 0;
  return harness.invoke({
    agent: 'insight',
    input: '2026-10 消费分析',
    options: {
      month: '2026-10',
      billsByMonth: { '2026-10': bills },
      billCount: bills.length,
      droppedCount: 0,
      hasPrevMonth: false,
      llmEnabled: true,
      userId: 'u1'
    }
  });
}

async function main() {
console.log('\n【无工具支撑的结论应被剔除】');

await test('调了占比工具 → 占比类结论保留', async () => {
  const r = await run([
    toolCall('get_category_share'),
    final(JSON.stringify({
      insights: ['交通出行占 38.1%，是最大的开销'],
      savings: []
    }))
  ]);
  assert.strictEqual(r.isFallback, false, '有工具支撑，不该降级');
  assert.ok(r.data.insights.some((i) => /38.1%/.test(i)),
    '占比结论应保留');
});

await test('没调占比工具 → 占比类结论被剔除', async () => {
  const r = await run([
    toolCall('get_compressibility'),
    final(JSON.stringify({
      insights: ['交通出行占 38.1%，是最大的开销'],
      savings: []
    }))
  ]);
  assert.ok(!r.data.insights.some((i) => /38.1%/.test(i)),
    '没有占比数据支撑，这条结论不该出现');
});

await test('没调刚性工具 → 刚性结论被剔除', async () => {
  const r = await run([
    toolCall('get_category_share'),
    final(JSON.stringify({
      insights: ['刚性支出占 14.2%，属于生活必需'],
      savings: []
    }))
  ]);
  assert.ok(!r.data.insights.some((i) => /刚性/.test(i)),
    '没查刚性等级就说刚性占比，不该出现');
});

await test('没调备注工具 → 基于备注的结论被剔除', async () => {
  const r = await run([
    toolCall('get_category_share'),
    final(JSON.stringify({
      insights: ['备注显示这是通勤加油，属固定支出'],
      savings: []
    }))
  ]);
  assert.ok(!r.data.insights.some((i) => /备注/.test(i)),
    '没看备注就不能引用备注');
});

await test('一条有依据 + 一条没依据 → 只剔除没依据那条', async () => {
  const r = await run([
    toolCall('get_category_share'),
    final(JSON.stringify({
      insights: [
        '交通出行占 38.1%，是最大的开销',
        '刚性支出占 14.2%，属于生活必需'
      ],
      savings: []
    }))
  ]);
  assert.ok(r.data.insights.some((i) => /38.1%/.test(i)), '有依据的应保留');
  assert.ok(!r.data.insights.some((i) => /刚性/.test(i)), '没依据的应剔除');
  assert.strictEqual(r.isFallback, false, '不应整条降级');
});

await test('复合结论：主体有依据就保留，不因顺带提及而误杀', async () => {
  // 「刚性支出 200 元，占 13.8%」——主体是刚性（查过），
  // 顺带提了占比（没查）。不该因为占比没工具就整条剔除。
  const r = await run([
    toolCall('get_compressibility'),
    final(JSON.stringify({
      insights: ['刚性支出 200.00 元，占 13.8%（孩子学费），属于生活必需'],
      savings: []
    }))
  ]);
  assert.ok(r.data.insights.some((i) => /刚性/.test(i)),
    '主体维度有依据，结论应保留');
  assert.strictEqual(r.isFallback, false);
});

console.log('\n【完全没调工具 → 退回兜底】');

await test('一条工具都没调 → 退回规则版', async () => {
  const r = await run([
    final(JSON.stringify({
      insights: ['交通出行占 38.1%，是最大的开销'],
      savings: []
    }))
  ]);
  assert.strictEqual(r.isFallback, true, '完全无依据，应退回兜底');
  assert.strictEqual(r.fallbackReason, 'NO_TOOL_GROUNDING');
});

console.log('\n【不受影响的维度】');

await test('不涉及具体维度的判断应保留', async () => {
  const r = await run([
    toolCall('get_noted_bills'),
    final(JSON.stringify({
      insights: ['这几笔消费的性质差异较大，值得逐笔看看'],
      savings: []
    }))
  ]);
  assert.strictEqual(r.isFallback, false);
  assert.ok(r.data.insights.length > 0, '不涉及具体维度的判断应保留');
});

console.log('\n【工具入参校验】');

await test('非法入参会报错回传，让模型能自我纠正', async () => {
  const r = await run([
    toolCall('get_top_categories', '{"n":999}'),
    final(JSON.stringify({ insights: [], savings: [] }))
  ]);
  // 第一轮工具返回错误，第二轮模型给结论
  assert.ok(r.ok !== undefined);
  // 关键：工具调用记录里应能看到错误
  const calls = r.toolCalls || [];
  assert.ok(calls.length > 0, '应记录工具调用');
  assert.strictEqual(calls[0].ok, false, '非法入参的工具调用应标记为失败');
  assert.ok(calls[0].error.includes('重新调用'), '错误信息应指导模型修正');
});

await test('合法的 category 入参能正常过滤', async () => {
  const r = await run([
    toolCall('get_category_share', '{"category":"餐饮"}'),
    final(JSON.stringify({ insights: [], savings: [] }))
  ]);
  const calls = r.toolCalls || [];
  assert.strictEqual(calls[0].ok, true, `合法入参不应失败: ${calls[0].error}`);
});

console.log('\n【数值本身不再被逐个校验】');

await test('模型写了格式不同的数字不再导致整条作废', async () => {
  // 这正是旧机制的误伤场景：工具返回 '500.00'，模型写「500元」
  const r = await run([
    toolCall('get_category_share'),
    final(JSON.stringify({
      insights: ['服饰美容 500元是本月第二大开销'],
      savings: []
    }))
  ]);
  assert.strictEqual(r.isFallback, false,
    '格式差异不该导致降级——已改为工具依赖校验');
  assert.ok(r.data.insights.length > 0, '结论应保留');
});

console.log(`\n${failed === 0 ? '✓ 全部通过' : '✗ 有失败'}：${passed} 通过 / ${failed} 失败\n`);
process.exit(failed === 0 ? 0 : 1);
}

main();
