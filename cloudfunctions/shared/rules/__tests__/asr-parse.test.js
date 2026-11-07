/**
 * 规则层单元测试
 * 运行：node cloudfunctions/shared/rules/__tests__/asr-parse.test.js
 * 说明：无框架依赖，assert 足够。P0 阶段要求规则层全绿。
 */

const assert = require('assert');
const asrParse = require('../asr-parse');
const money = require('../../util/money');

let pass = 0;
let fail = 0;

function check(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ✗ ${name}\n      ${e.message}`);
  }
}

console.log('\n【金额解析】');

check('买菜100 → 100元', () => {
  const r = asrParse.extractAmount('买菜100');
  assert.strictEqual(money.centToYuan(r.amountCent), 100);
  assert.ok(r.certain);
});

check('买菜100元 → 100元', () => {
  assert.strictEqual(money.centToYuan(asrParse.extractAmount('买菜100元').amountCent), 100);
});

check('菜市场68块5 → 68.5元', () => {
  assert.strictEqual(money.centToYuan(asrParse.extractAmount('菜市场68块5').amountCent), 68.5);
});

check('三块五毛五 → 3.55元', () => {
  assert.strictEqual(money.centToYuan(asrParse.extractAmount('三块五毛五').amountCent), 3.55);
});

check('一百五 → 150元（口语省略单位）', () => {
  assert.strictEqual(money.centToYuan(asrParse.extractAmount('一百五').amountCent), 150);
});

check('三百八十 → 380元（中文数字）', () => {
  assert.strictEqual(money.centToYuan(asrParse.extractAmount('三百八十').amountCent), 380);
});

check('打车35 → 35元', () => {
  assert.strictEqual(money.centToYuan(asrParse.extractAmount('打车35').amountCent), 35);
});

check('四十来块 → 金额不确定', () => {
  const r = asrParse.extractAmount('好像买了点菜，四十来块');
  assert.ok(!r.certain, '应标记为不确定');
  assert.strictEqual(r.pattern, 'vague');
});

check('无金额 → null', () => {
  assert.strictEqual(asrParse.extractAmount('买菜').amountCent, null);
});

check('超合理上限(>50000) → 拒绝', () => {
  assert.strictEqual(asrParse.extractAmount('888888').amountCent, null);
});

console.log('\n【账户抽取】');
check('微信付的 → wechat', () => {
  assert.strictEqual(asrParse.extractAccount('微信付的100'), 'wechat');
});
check('刷卡 → card', () => {
  assert.strictEqual(asrParse.extractAccount('刷卡买了'), 'card');
});
check('无 → unknown', () => {
  assert.strictEqual(asrParse.extractAccount('买菜100'), 'unknown');
});

console.log('\n【时间解析】');
check('昨天买 → 昨天', () => {
  const r = asrParse.extractTime('昨天跟朋友下馆子吃了380');
  assert.strictEqual(r.type, 'yesterday');
});
check('前天 → dayBefore/specific', () => {
  const r = asrParse.extractTime('前天买菜');
  assert.ok(['dayBefore', 'specific'].includes(r.type));
});
check('无时间词 → today', () => {
  const r = asrParse.extractTime('买菜100');
  assert.strictEqual(r.type, 'today');
});
check('三天前 → 正确偏移', () => {
  const now = new Date('2026-10-17T10:00:00').getTime();
  const r = asrParse.extractTime('三天前买了点菜', now);
  assert.strictEqual(r.date, '2026-10-14');
});

console.log('\n【场景与拆笔】');
check('同事 → unit 场景', () => {
  assert.ok(asrParse.extractScene('跟同事下馆子').includes('unit'));
});
check('一句多说 → 拆2笔', () => {
  const r = asrParse.detectSplit('买菜100，还有洗衣液39');
  assert.strictEqual(r.count, 2);
  assert.strictEqual(r.parts.length, 2);
});
check('单笔 → 1', () => {
  assert.strictEqual(asrParse.detectSplit('买菜100').count, 1);
});

console.log('\n【金额工具】');
check('整数分往返无损', () => {
  assert.strictEqual(money.formatCent(money.yuanToCent(380.55)), '380.55');
});
check('分转元', () => {
  assert.strictEqual(money.centToYuan(38000), 380);
});
check('中文数字 千二 = 1200', () => {
  assert.strictEqual(money.cnToNumber('千二'), 1200);
});
check('中文数字 一千二百三十四', () => {
  assert.strictEqual(money.cnToNumber('一千二百三十四'), 1234);
});
check('中文数字 三万五千', () => {
  assert.strictEqual(money.cnToNumber('三万五千'), 35000);
});
check('偏离度计算', () => {
  assert.ok(Math.abs(money.deviation(10000, 10000)) < 1e-9);
  assert.ok(money.deviation(10000, 20000) > 0.4);
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail > 0 ? 1 : 0);