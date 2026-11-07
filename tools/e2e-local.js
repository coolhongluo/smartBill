/**
 * 端到端本地模拟 —— 不依赖云环境
 *
 * 覆盖：
 *   1. 高置信自动入账
 *   2. 模糊金额强制确认（「四十来块」）
 *   3. 强规则命中不被兜底压到低档（「打车去医院 45」）
 *   4. 事后补记
 *   5. 编辑
 *
 * 运行：node tools/e2e-local.js
 */

const path = require('path');

process.env.LLM_ENABLED = process.env.LLM_ENABLED || 'false';

const svc = require(path.join(__dirname, '..', 'cloudfunctions', 'bill-svc', 'index.js'));

// 模拟微信云函数上下文
const context = { OPENID: 'local_test_openid' };

const CASES = [
  '买菜100',
  '四十来块',
  '打车去医院 45',
  '超市 268',
  '孩子学费 3200',
  '微信话费 100',
  '交水电费 260',
  '妈妈过生日买蛋糕 200'
];

async function call(action, payload) {
  return svc.main({ action, payload }, context);
}

function assert(cond, label) {
  console.log(`  ${cond ? '✓' : '✗ 失败:'} ${label}`);
  if (!cond) process.exitCode = 1;
}

async function main() {
  console.log('==================================================================');
  console.log(' 端到端本地模拟（LLM 关闭，走规则兜底）');
  console.log('==================================================================\n');

  console.log('【record 链路】');
  const results = {};
  for (const text of CASES) {
    const r = await call('record', { asrText: text, asrConfidence: 0.9 });
    results[text] = r;
    const cat = (r.candidates[0] && r.candidates[0].categoryPath) || '(无候选)';
    console.log(
      `  ${text.padEnd(14)} → ${String(r.status).padEnd(12)} 置信 ${Number(r.confidence).toFixed(3)} ` +
      `${r.tier} 档  金额 ${r.prefill.amountYuan} 元  候选 ${cat}` +
      (r.prefill.amountCertain === false ? '  [金额不明确]' : '')
    );
  }

  console.log('\n【断言】');

  // 1. 模糊金额
  const vague = results['四十来块'];
  assert(vague.prefill.amountCertain === false, '「四十来块」标记 amountCertain=false');
  assert(vague.action !== 'AUTO_SAVE', '「四十来块」不自动入账');
  assert(vague.status === 'needConfirm', '「四十来块」进入 needConfirm');
  assert(!vague.saved, '「四十来块」未落库');

  // 2. 强规则
  const strong = results['打车去医院 45'];
  assert(strong.tier !== 'low', '「打车去医院 45」不被压到低档（实际 ' + strong.tier + '）');
  assert(
    (strong.candidates[0] || {}).categoryPath === '医疗健康/门诊挂号/门诊挂号',
    '「打车去医院 45」Top1 = 医疗健康'
  );
  assert(strong.confidence <= 0.74, '兜底置信度不超过 0.74（实际 ' + strong.confidence + '）');

  // 3. 兜底上限
  const allFallback = CASES.every((t) => results[t].isFallback);
  assert(allFallback, 'LLM 关闭时全部走兜底路径');

  // 4. 高置信不误入账
  const anyAuto = CASES.some((t) => results[t].action === 'AUTO_SAVE');
  assert(!anyAuto, '兜底路径下无误自动入账');

  console.log('\n【recall 补记】');
  const recall = await call('recall', {
    date: '2026-10-15',
    candidates: [
      { amountCent: 6800, categoryId: 'cat_food_home_buy', categoryPath: '餐饮/在家吃饭/买菜', note: '菜市场' },
      { amountCent: 3900, categoryId: 'cat_home_daily', categoryPath: '居家生活/日用百货/纸巾清洁', note: '洗衣液' }
    ],
    chosenIndex: 0
  });
  console.log(`  状态 ${recall.ok}, source=${recall.bill.source}, isRecall=${recall.bill.isRecall}, recallDaysLater=${recall.bill.recallDaysLater}`);
  assert(recall.bill.source === 'recall', '补记 source=recall');
  assert(recall.bill.isRecall === true, '补记标记 isRecall');
  assert(recall.bill.amount === 6800, '补记金额为整数分');

  console.log('\n【amend 编辑】');
  const amend = await call('amend', { billId: 'mock_id_1', amountCent: 7000, categoryId: 'c1_1_1' });
  console.log(`  ${JSON.stringify(amend.updates)}`);
  assert(amend.ok === true, '编辑返回成功');
  // ⚠️ updates 里是**落库用的字段名**（amount / categoryId / categoryPath），
  //    不是入参名（amountCent）—— 云端统一把整数分写进 amount
  assert(amend.updates.amount === 7000, '编辑返回待更新字段（amount 为整数分）');
  assert(amend.updates.categoryId === 'c1_1_1', '编辑返回待更新的类目 id');

  console.log('\n【amend 参数校验】');
  // 金额：与 manual 同口径（正数、整数分、不超上限）
  const aNeg = await call('amend', { billId: 'x', amountCent: -100 });
  assert(aNeg.ok === false && /金额/.test(aNeg.error), '拒绝负数金额');
  const aZero = await call('amend', { billId: 'x', amountCent: 0 });
  assert(aZero.ok === false && /金额/.test(aZero.error), '拒绝 0 元');
  const aFloat = await call('amend', { billId: 'x', amountCent: 6849.99 });
  assert(aFloat.ok === false && /精度/.test(aFloat.error), '拒绝浮点金额（防精度残留）');
  const aTooBig = await call('amend', { billId: 'x', amountCent: 999999999 });
  assert(aTooBig.ok === false && /上限/.test(aTooBig.error), '拒绝超上限金额');
  // 日期
  const aBadDate = await call('amend', { billId: 'x', date: '2026/10/01' });
  assert(aBadDate.ok === false && /日期/.test(aBadDate.error), '拒绝错误日期格式');
  const aFuture = await call('amend', { billId: 'x', date: '2099-01-01' });
  assert(aFuture.ok === false && /未来/.test(aFuture.error), '拒绝未来日期');
  // 账户：只认已知枚举
  const aBadAcct = await call('amend', { billId: 'x', account: 'bitcoin' });
  assert(aBadAcct.ok === false && /账户/.test(aBadAcct.error), '拒绝未知账户类型');
  // 类目：必须成对
  const aPathOnly = await call('amend', { billId: 'x', categoryPath: '餐饮/在家吃饭/买菜' });
  assert(aPathOnly.ok === false && /类目/.test(aPathOnly.error), '只给 path 不给 id 时报错');
  const aBadCat = await call('amend', { billId: 'x', categoryId: 'not_exist' });
  assert(aBadCat.ok === false && /类目/.test(aBadCat.error), '不存在的类目被拒绝');
  const aNoId = await call('amend', { amountCent: 1000 });
  assert(aNoId.ok === false && /billId/.test(aNoId.error), '缺 billId 时报错');

  console.log('\n【amend 类目 id/path 成对】');
  // 回归：早期 amend 只改 categoryId 不改 categoryPath，
  // 而统计侧完全靠 categoryPath 分组 → 改了类目但统计按旧类目算。
  const aCat = await call('amend', {
    billId: 'x', categoryId: 'c1_1_1', categoryPath: '错误路径/不该被采用'
  });
  assert(aCat.ok === true, '合法类目编辑成功');
  assert(aCat.updates.categoryId === 'c1_1_1', 'categoryId 已更新');
  assert(aCat.updates.categoryPath === '餐饮/在家吃饭/买菜',
    `预置类目的 path 必须按 id 反查（实际 ${aCat.updates.categoryPath}），不能信前端传的`);

  // 自定义类目：id 不在预置库里，只能用前端传的 path
  const aCustom = await call('amend', {
    billId: 'x', categoryId: 'custom_abc123', categoryPath: '餐饮/我的口味/火锅'
  });
  assert(aCustom.ok === true, '自定义类目编辑成功');
  assert(aCustom.updates.categoryPath === '餐饮/我的口味/火锅',
    '自定义类目沿用前端传的 path（预置库里没有它）');

  console.log('\n【amend 支持账户与备注清空】');
  const aAcct = await call('amend', { billId: 'x', account: 'alipay', note: '' });
  assert(aAcct.ok === true, '账户与备注编辑成功');
  assert(aAcct.updates.account === 'alipay', '账户已更新');
  assert(aAcct.updates.note === '', '备注可被清空（不是被忽略）');

  console.log('\n【manual 手动直填】');
  const manual = await call('manual', {
    amountCent: 10000,
    categoryId: 'c1_1_1',
    categoryPath: '餐饮/在家吃饭/买菜',
    note: '菜市场'
  });
  console.log(`  ok=${manual.ok}, saved=${manual.saved}, source=${manual.bill && manual.bill.source}, amount=${manual.bill && manual.bill.amount}`);
  assert(manual.ok === true, '手动入账返回成功');
  assert(manual.bill.source === 'manual', '手动入账 source=manual（不污染 recall 埋点）');
  assert(manual.bill.isRecall === false, '手动入账不标记为补记');
  assert(manual.bill.amount === 10000, '手动入账金额为整数分');
  assert(manual.bill.confidence === 1, '人工录入置信度为 1');

  console.log('\n【manual 参数校验】');
  const mNoCat = await call('manual', { amountCent: 1000, categoryPath: '餐饮/在家吃饭/买菜' });
  assert(mNoCat.ok === false && /类目/.test(mNoCat.error), '缺类目时报错');
  const mNoAmt = await call('manual', { categoryId: 'c1_1_1' });
  assert(mNoAmt.ok === false && /金额/.test(mNoAmt.error), '缺金额时报错');
  const mFloat = await call('manual', { amountCent: 6849.99, categoryId: 'c1_1_1' });
  assert(mFloat.ok === false && /精度/.test(mFloat.error), '拒绝浮点金额（防精度残留）');
  const mNeg = await call('manual', { amountCent: -100, categoryId: 'c1_1_1' });
  assert(mNeg.ok === false, '拒绝负数金额');
  const mTooBig = await call('manual', { amountCent: 999999999, categoryId: 'c1_1_1' });
  assert(mTooBig.ok === false && /上限/.test(mTooBig.error), '拒绝超上限金额');

  console.log('\n【record 缺参校验（手动文字模式共用）】');
  const bad = await call('record', {});
  assert(bad.ok === false, '缺少 asrText 时返回错误');
  const badAction = await svc.main({ action: 'nope' }, context);
  assert(badAction.ok === false, '未知 action 返回错误');

  console.log('\n==================================================================');
  console.log(process.exitCode ? ' 结论：存在失败项' : ' 结论：端到端全部通过 ✅');
  console.log('==================================================================');
}

main().catch((e) => {
  console.error('运行异常：', e);
  process.exit(1);
});