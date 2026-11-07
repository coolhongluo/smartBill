/**
 * 「可以这样省」v3 契约测试
 *
 * ## v3 的变化
 *
 * 建议不再由规则生成（v2 的占比×30%、单笔×20% 已随 calcSavingsPotential 删除），
 * 完全交给大模型基于 get_bills_detail 的明细与频次分析。
 * 规则层只保留两个职责：
 *
 * 1. **必需性判定**（essential-spend）——供提示词哲学与后续校验使用，
 *    「95号油」有备注但通勤必需，「同事聚餐」有备注但社交必需，
 *    备注存在 ≠ 该省
 * 2. **降级输出契约**——LLM 不可用时 savings 恒为空，
 *    前端显示「AI 分析暂不可用」，不得用规则建议冒充
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

/**
 * 路径说明：本文件位于 shared/agent-harness/tools/__tests__/
 *   ../../                → shared/agent-harness   （agent-harness 本身）
 *   ../../bill-stats      → shared/agent-harness/bill-stats
 *   ../../../util         → shared/util
 */
const stats = require('../../bill-stats');
const essential = require('../../../util/essential-spend');
const compressibility = require('../../../util/category-compressibility');

const mk = (amountYuan, categoryPath, note, categoryId) => ({
  amount: Math.round(amountYuan * 100),
  date: '2026-10-01',
  categoryPath,
  note: note || '',
  categoryId: categoryId || 'x'
});

console.log('\n【必需性判定】');

test('通勤加油是必需消费，不该建议省', () => {
  const b = mk(504.5, '交通出行/日常交通/加油', '95号油', 'c2_1_5');
  assert.strictEqual(essential.isEssentialSpend(b), true,
    '通勤加油省了就没法上班，备注有信息不代表可压缩');
});

test('买菜是必需消费', () => {
  assert.strictEqual(essential.isEssentialSpend(mk(80, '餐饮/在家吃饭/买菜', '', 'c1_1_1')), true);
});

test('社交聚餐是必需支出（省它伤的是关系）', () => {
  assert.strictEqual(essential.isEssentialSpend(mk(200, '餐饮/外出就餐/火锅烧烤', '同事聚餐', 'c1_2_2')), true,
    '建议用户少请客是不合适的');
});

test('随礼/红包同理', () => {
  assert.strictEqual(essential.isEssentialSpend(mk(800, '其他/其他/其他', '同事随礼')), true);
});

test('买外套是可选消费，可以建议', () => {
  assert.strictEqual(essential.isEssentialSpend(mk(500, '服饰美容/衣物鞋帽/衣物', '买外套', 'c6_1_1')), false,
    '衣物非必需，可以延后购买');
});

test('旅游是可压缩的（与加油区分）', () => {
  assert.strictEqual(
    essential.isEssentialSpend(mk(3000, '文旅娱乐/旅游度假/旅游度假', '三亚旅行', 'c7_1_1')), false,
    '同一级类目下必需与可选必须区分到末级'
  );
});

test('备注含「通勤」也算必需（类目可能选错）', () => {
  assert.strictEqual(essential.isEssentialSpend(mk(50, '其他/其他/其他', '通勤打车')), true);
});

console.log('\n【数值格式归一化】');

test('工具返回 500.00 与模型写 500 元应视为同一数字', () => {
  // 复现原bug：collectNumbersDeep 收集 '500.00'，正文抽出 '500'
  const collect = (v, out) => {
    if (v === null || v === undefined) return;
    if (typeof v === 'number') { if (isFinite(v)) out.add(String(v)); return; }
    if (typeof v === 'string') {
      const m = v.match(/^\d+(?:\.\d+)?$/);
      if (m) out.add(String(Number(m[0]))); return;
    }
    if (Array.isArray(v)) { for (const x of v) collect(x, out); return; }
    if (typeof v === 'object') { for (const k of Object.keys(v)) collect(v[k], out); }
  };
  const allowed = new Set();
  collect({ amountYuan: '500.00' }, allowed);
  assert.ok(allowed.has('500'), `归一化后应含 '500'，实际 ${[...allowed]}`);
});

test('归一化不会把不同数值混为一谈', () => {
  const collect = (v, out) => {
    if (typeof v === 'string') { const m = v.match(/^\d+(?:\.\d+)?$/); if (m) out.add(String(Number(m[0]))); }
  };
  const allowed = new Set();
  collect('500.00', allowed);
  collect('500.50', allowed);
  collect('38.10', allowed);
  assert.ok(allowed.has('500'));
  assert.ok(allowed.has('500.5'));
  assert.ok(allowed.has('38.1'));
  assert.ok(!allowed.has('501'), '不同数值不能混');
});

console.log('\n【降级输出契约：savings 恒空】');

const agent = require('../../agents/insight.agent');

function buildFallback(bills) {
  const { bills: cleaned } = stats.normalizeBills(bills);
  return agent.fallback('test', { billsByMonth: { '2026-10': cleaned }, month: '2026-10' });
}

test('v3 降级不再生成节省建议，insights 兜底保留', () => {
  const res = buildFallback([
    mk(504.5, '交通出行/日常交通/加油', '95号油', 'c2_1_5'),
    mk(200, '餐饮/外出就餐/火锅烧烤', '同事聚餐', 'c1_2_2'),
    mk(200, '育儿教育/教育支出/学费', '孩子学费', 'c4_2_1'),
    mk(500, '服饰美容/衣物鞋帽/衣物', '买外套', 'c6_1_1'),
    mk(50, '交通出行/日常交通/打车', '', 'c2_1_3')
  ]);
  // v2 会在这里拼出「买外套这笔可以缓一缓」；v3 起规则建议整体废除，
  // 用规则建议冒充 AI 结论会掩盖「AI 没跑成」这个事实
  assert.deepStrictEqual(res.savings, [], '降级时 savings 必须为空');
  assert.ok(res.insights.length >= 1, 'insights 的规则兜底保留，分析页不能空白');
});

test('全部刚性时 insights 说明刚性占比，savings 仍为空', () => {
  const res = buildFallback([
    mk(3500, '居住/房租房贷/房租房贷', '房租', 'c9_1_1'),
    mk(2000, '育儿教育/教育支出/学费', '学费', 'c4_2_1')
  ]);
  assert.deepStrictEqual(res.savings, []);
  assert.ok(res.insights.some((i) => /刚性支出/.test(i)), '应说明刚性支出情况');
});

test('无数据时降级返回占位说明', () => {
  const res = agent.fallback('test', { billsByMonth: {}, month: '2026-10' });
  assert.deepStrictEqual(res.savings, []);
  assert.ok(res.insights.length >= 1);
});

console.log('\n【v3 提示词契约】');

test('提示词要求先调 get_bills_detail 才能给建议', () => {
  const t = agent.promptTemplate('x', { p1_profile: { text: '' } });
  assert.ok(t.includes('get_bills_detail'), '必须引导模型拉明细');
  assert.ok(t.includes('必须先调 get_bills_detail'), '必须写明强制顺序');
});

test('提示词允许定性建议（amount 可为 null）', () => {
  const t = agent.promptTemplate('x', { p1_profile: { text: '' } });
  assert.ok(t.includes('null'), '纯定性建议传 null 的规则必须在提示词里');
  assert.ok(t.includes('平替'), '平替/降档视角是 v3 的核心增量');
  // schema 同步：amount 已移出必填
  const s = agent.outputSchema.fields.savings;
  assert.ok(!s.requiredFields.includes('amount'), 'amount 不再必填');
  assert.ok(s.requiredFields.includes('confidence'), 'confidence 升为必填');
});

console.log(`\n${failed === 0 ? '✓ 全部通过' : '✗ 有失败'}：${passed} 通过 / ${failed} 失败\n`);
process.exit(failed === 0 ? 0 : 1);
