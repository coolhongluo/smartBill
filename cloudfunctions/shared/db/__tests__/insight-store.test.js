/**
 * 分析结果「读 / 算 / 存」三段分离的测试
 *
 * ## 为什么单独测这一层
 *
 * 拆分的目的只有一个：**打开分析页不再等 10 秒**。
 * 而这依赖三件事同时成立——
 *   读取路径真的不调 LLM、落库真的成功、跨月不会被当成本月数据。
 * 任何一件坏了，页面都会「显示得很正常但内容是错的」，
 * 那种 bug 比直接报错更难发现。
 *
 * 用内存版 users 集合模拟云开发，跑完整链路不花钱、秒级完成。
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

/* ── 内存版SDK 注入 ── */

// 路径从 shared/db/__tests__/ 出发：../ 是 db 目录
const sdk = require('../sdk');

let store = null;
const notFound = () => {
  const e = new Error('document not exist');
  e.errMsg = 'document.get:fail -502005 document not exist';
  throw e;
};

// ⚠️ doc() 必须同时实现 get 与 set。
// 只实现 set 时读取路径报「doc(...).get is not a function」，
// 而 getInsight 的 catch 会把它吞成「文档不存在」——
// 于是现象是「明明写进去了却读不到」，根因却在 mock 上，极难定位。
const userCol = {
  async get() { if (!store) notFound(); return { data: store }; },
  doc(id) {
    return {
      async get() { if (!store) notFound(); return { data: store }; },
      async set({ data }) { store = { _id: id, ...data }; return {}; }
    };
  }
};

const BILL_COL = (rows) => ({
  where() { return this; },
  skip() { return this; },
  limit() { return this; },
  orderBy() { return this; },
  async get() { return { data: rows }; }
});

const BILLS = [
  { amount: 350000, date: '2026-10-01', categoryPath: '居住/房租房贷/房租房贷', categoryId: 'c9_1_1', note: '10月房租' },
  { amount: 60000, date: '2026-10-05', categoryPath: '餐饮/外出就餐/火锅烧烤', categoryId: 'c1_2_2', note: '周末请朋友' },
  { amount: 60000, date: '2026-10-12', categoryPath: '餐饮/外出就餐/火锅烧烤', categoryId: 'c1_2_2', note: '周末请朋友' },
  { amount: 60000, date: '2026-10-19', categoryPath: '餐饮/外出就餐/火锅烧烤', categoryId: 'c1_2_2', note: '周末请朋友' }
];

sdk.__injectSdk({
  database: () => ({
    collection: (name) => (name === 'users' ? userCol : BILL_COL(BILLS)),
    command: { gte: () => ({ and: () => ({}) }), lte: () => ({ and: () => ({}) }) }
  }),
  getWXContext: () => ({ OPENID: 'u_test', ENV: 'test' })
});

const db = require('../index');
/**
 * analysis-svc 用绝对路径引入。
 * 这个测试文件位于 shared/db/__tests__/，而 analysis-svc 是它的**兄弟目录**，
 * 用相对路径数层级非常脆弱（数错一级就是 MODULE_NOT_FOUND）。
 */
const svc = require('../../../analysis-svc/index.js');
const CTX = { OPENID: 'u_test', ENV: 'test' };

// 无 API Key 环境，agent 会走纯代码兜底——这里只验数据通路，不验模型质量
delete process.env.DEEPSEEK_API_KEY;

async function main() {
  console.log('\n【未分析过】');

  await test('读取时明确返回 hasResult=false（而非空数组）', async () => {
    store = null;
    const r = await svc.main({ action: 'categoryBreakdown' }, CTX);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.data.hasResult, false,
      '必须区分「还没分析过」与「分析了但没发现」——前端引导完全不同');
    assert.deepStrictEqual(r.data.insights, []);
  });

  await test('读取不触发任何计算（不能有 LLM 调用）', async () => {
    store = null;
    // 没有 API Key 时若触发计算，会走 agent 并产出结论；
    // 所以「hasResult 仍为 false」就证明读取路径没有偷偷跑分析
    const r = await svc.main({ action: 'categoryBreakdown' }, CTX);
    assert.strictEqual(r.data.hasResult, false);
    assert.strictEqual(store, null, '读取不应产生任何写入');
  });

  console.log('\n【触发分析并落库】');

  let computed = null;

  await test('refreshInsight 计算并落库', async () => {
    store = null;
    const r = await svc.main({ action: 'refreshInsight' }, CTX);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.data.persisted, true, '应落库成功');
    assert.ok(store, '应写入 users 集合');
    assert.strictEqual(store.userId, 'u_test');
    computed = r.data;
  });

  await test('落库内容与返回内容一致（同一份计算）', async () => {
    assert.strictEqual(store.insights.length, computed.insights.length,
      '「显示的」与「存起来的」必须是同一批数据，否则用户刷新后会看到变化');
    assert.deepStrictEqual(store.savings.map((s) => s.amount),
      computed.savings.map((s) => s.amount));
  });

  await test('记录 generateTime 供前端提示新鲜度', async () => {
    assert.ok(store.generateTime > 0, '必须有生成时间');
  });

  await test('固定 _id，一用户一份', async () => {
    assert.strictEqual(store._id, 'u_test_insight');
  });

  await test('刚性支出被排除在建议之外', async () => {
    const titles = store.savings.map((s) => `${s.title}${s.category}`).join(' ');
    assert.ok(!titles.includes('房租'), '刚性类目不该出现在建议里');
    assert.ok(!titles.includes('居住'), '刚性类目不该出现在建议里');
  });

  console.log('\n【读取已存结果】');

  await test('再次读取直接返回结果，不重算', async () => {
    const before = store.generateTime;
    const r = await svc.main({ action: 'categoryBreakdown' }, CTX);
    assert.strictEqual(r.data.hasResult, true);
    assert.strictEqual(store.generateTime, before, '读取不应重新生成');
    assert.strictEqual(r.data.total, store.total);
    assert.ok(r.data.generateTime > 0, '应带上生成时间给前端展示');
  });

  await test('读取是快速的（不跑 LLM 的核心收益）', async () => {
    const t0 = Date.now();
    await svc.main({ action: 'categoryBreakdown' }, CTX);
    const cost = Date.now() - t0;
    assert.ok(cost < 200, `读取耗时 ${cost}ms，应在毫秒级（跑 LLM 需 10 秒）`);
  });

  console.log('\n【跨月与越权】');

  await test('读别的月份时标记 _stale，不能当成本月数据', async () => {
    const r = await svc.main({ action: 'categoryBreakdown', payload: { month: '2026-11' } }, CTX);
    assert.strictEqual(r.data.isStale, true,
      '把上个月的结论当本月展示是**错误信息**，比显示"旧数据"严重得多');
  });

  await test('userId 不匹配时拒绝返回', async () => {
    const saved = store;
    store = { ...saved, userId: 'someone_else' };
    const r = await svc.main({ action: 'categoryBreakdown' }, CTX);
    assert.strictEqual(r.data.hasResult, false, '越权读取必须被拒绝');
    store = saved;
  });

  await test('无数据时不产出结论，而是标记 isEmpty', async () => {
    sdk.__injectSdk({
      database: () => ({
        collection: (name) => (name === 'users' ? userCol : BILL_COL([])),
        command: { gte: () => ({ and: () => ({}) }), lte: () => ({ and: () => ({}) }) }
      }),
      getWXContext: () => ({ OPENID: 'u_test', ENV: 'test' })
    });
    const r = await svc.main({ action: 'refreshInsight' }, CTX);
    assert.strictEqual(r.data.meta.isEmpty, true, '空数据要让前端显示引导，不是空白卡片');
    assert.deepStrictEqual(r.data.insights, []);
  });

  console.log(`\n${failed === 0 ? '✓ 全部通过' : '✗ 有失败'}：${passed} 通过 / ${failed} 失败\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main();