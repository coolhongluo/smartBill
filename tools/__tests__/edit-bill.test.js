/**
 * 明细页编辑功能的契约测试
 *
 * ## 为什么这个测试存在
 *
 * 编辑功能是本项目里**唯一会让用户改到已有数据**的入口。
 * 改错了不会立刻暴露，而是：
 *   · 统计口径悄悄错乱（categoryPath 与 categoryId 不一致）
 *   · 分析页展示基于旧金额的结论，用户以为是新的
 *   · 明细页这行显示 120、当天总额却是旧的 200 —— 同屏两个数字对不上
 *
 * 这类问题在真机上极难定位，而所有静态检查当时都是绿的。
 * 所以这里做**契约层面**的断言：界面绑定的字段、提交的字段、
 * 云端写入的字段，三者必须对得上。
 *
 * 关键一条：**从 WXML 真解析**出编辑面板绑了哪些字段，
 * 再与 JS 里提交的字段对账——而不是靠正则猜。
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const DETAIL_JS = path.join(ROOT, 'miniprogram', 'pages', 'detail', 'detail.js');
const DETAIL_WXML = path.join(ROOT, 'miniprogram', 'pages', 'detail', 'detail.wxml');
const BILL_SVC = path.join(ROOT, 'cloudfunctions', 'bill-svc', 'index.js');
const DB_INDEX = path.join(ROOT, 'cloudfunctions', 'shared', 'db', 'index.js');

const detailJs = fs.readFileSync(DETAIL_JS, 'utf8');
const detailWxml = fs.readFileSync(DETAIL_WXML, 'utf8');
const billSvc = fs.readFileSync(BILL_SVC, 'utf8');
const dbIndex = fs.readFileSync(DB_INDEX, 'utf8');

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

/** 取出编辑面板（edit-mask）里的所有绑定字段 */
function extractEditBindings(wxml) {
  const start = wxml.indexOf('class="edit-mask"');
  assert.ok(start > -1, 'detail.wxml 里应存在编辑面板');

  // 面板本体到 cat-picker 组件之后。
  // ⚠️ cat-picker 的 initial-id 也要算进来——它绑的也是 editCategoryId，
  //    那个字段同样必须在 data 里声明。
  const end = wxml.indexOf('/>', wxml.indexOf('<cat-picker', start));
  const scope = end > -1 ? wxml.slice(start, end) : wxml.slice(start);

  const fields = new Set();
  // ⚠️ 绑定可能是三元表达式：{{editAccount === item.value ? 'is-on' : ''}}
  //    所以不能只匹配 {{字段}}——那样会漏掉全部三元里的字段。
  // 这里统一取 {{ 后面第一个标识符。
  const re = /\{\{\s*([A-Za-z0-9_]+)/g;
  let m;
  while ((m = re.exec(scope)) !== null) fields.add(m[1]);
  // item 是 wx:for 的循环别名，不是页面 data 里的字段
  fields.delete('item');
  return fields;
}

console.log('\n【编辑面板的字段契约】');

test('编辑面板绑定的字段都能在页面 data 里找到', () => {
  const bound = extractEditBindings(detailWxml);
  assert.ok(bound.size >= 6, `应解析出多个绑定字段，实际 ${bound.size}`);

  // data 块里应声明这些字段
  const dataBlock = detailJs.slice(detailJs.indexOf('data: {'), detailJs.indexOf('onShow()'));
  const missing = [...bound].filter((f) => !new RegExp(`\\b${f}\\b`).test(dataBlock));
  assert.strictEqual(missing.length, 0,
    `WXML 绑定了这些字段但 data 里没有：${missing.join(', ')}`);
});

test('可编辑字段齐全：金额 / 类目 / 日期 / 备注', () => {
  const bound = extractEditBindings(detailWxml);
  ['editAmount', 'editCategoryId', 'editDate', 'editNote'].forEach((f) => {
    assert.ok(bound.has(f), `编辑面板应能编辑「${f}」`);
  });
});

test('编辑面板不含「支付方式」（用户明确不需要）', () => {
  const bound = extractEditBindings(detailWxml);
  assert.ok(!bound.has('editAccount'), '支付方式不该是可编辑字段');
  assert.ok(!/支付方式/.test(detailWxml), '编辑面板不该有「支付方式」文案');
  assert.ok(!/onPickAccount/.test(detailJs), '不该再有账户选择的方法');
});

test('不可编辑字段不出现：系统元数据不该给用户改', () => {
  const bound = extractEditBindings(detailWxml);
  // source / confidence / aiMeta / userId / createTime 记录的是「这笔账怎么来的」，
  // 改了会让统计口径与埋点指标失真
  ['source', 'confidence', 'aiMeta', 'userId', 'createTime', 'isRecall'].forEach((f) => {
    assert.ok(!bound.has(f), `「${f}」是系统元数据，不该出现在编辑面板`);
  });
});

console.log('\n【金额回填与换算】');

test('金额回填用「原始整数分」而不是展示字符串', () => {
  // ⚠️ 这是真实踩过的 bug：
  //    groupByDate 里 amount = formatCent(b.amount) = "¥120.00"（展示用），
  //    amountCent = b.amount = 12000（原始分）。
  //    回填时传了 bill.amount → Number("¥120.00") = NaN → 兜底成 0
  //    → 打开编辑面板金额显示 0，直接保存还会报「请输入有效金额」。
  assert.ok(/yuanInput\(bill\.amountCent\)/.test(detailJs),
    '回填必须传 bill.amountCent（原始整数分）');
  assert.ok(!/yuanInput\(bill\.amount\)/.test(detailJs),
    '不能把展示用字符串 bill.amount 当数值传');
});

test('列表项同时提供展示金额与原始分值', () => {
  // 两个字段长得像，用途不同：amount 给人看，amountCent 给代码算
  const groupFn = detailJs.slice(detailJs.indexOf('groupByDate(bills)'));
  assert.ok(/amount:\s*formatCent\(b\.amount\)/.test(groupFn), '应保留展示用金额');
  assert.ok(/amountCent:\s*b\.amount/.test(groupFn), '应保留原始整数分');
});

console.log('\n【提交的字段契约】');

test('提交时 categoryId 与 categoryPath 成对出现', () => {
  // 统计侧（bill-stats.js）完全靠 categoryPath 分组：
  //   top / leaf / second 全从 path 切出来
  // 只传 id 不传 path → 界面显示旧类目、统计按旧类目算，数据自相矛盾
  const payloadBlock = detailJs.slice(detailJs.indexOf('const payload = {'), detailJs.indexOf('cloud.amend(payload)'));
  assert.ok(/categoryId\s*=/.test(payloadBlock), '提交应带 categoryId');
  assert.ok(/categoryPath\s*=/.test(payloadBlock), '提交应带 categoryPath');
});

test('只提交改动过的字段（未改的不重发）', () => {
  const payloadBlock = detailJs.slice(
    detailJs.indexOf('const payload = {'), detailJs.indexOf('cloud.amend(payload)'));

  // 每个字段都应带「与原值比较」的判断。
  // ⚠️ 比较对象可能是 this.data.editX、也可能是本地变量 amountCent，
  //    且可能跨行 —— 所以只检查「同一个 if 条件里出现了 !== 比较」，
  //    不去匹配具体是哪个变量跟哪个变量比。
  // 金额的编辑态字段叫 editAmount，落库字段叫 amountCent，两者不同名，
  // 所以金额单独用「editAmount 与 bill.amountCent 比较」来判定。
  const checks = [
    ['amountCent', /if\s*\(\s*amountCent\s*!==\s*bill\.amountCent\s*\)/],
    ['categoryId', /if\s*\([^)]*editCategoryId[^)]*!==[^)]*bill\.categoryId[^)]*\)/],
    ['date', /if\s*\([^)]*editDate[^)]*!==[^)]*bill\.date[^)]*\)/],
    ['note', /if\s*\([^)]*editNote[^)]*!==[^)]*bill\.note[^)]*\)/],
  ];
  checks.forEach(([f, re]) => {
    assert.ok(re.test(payloadBlock), `${f} 应先与原值比较再提交`);
    assert.ok(new RegExp(`payload\\.${f}\\s*=`).test(payloadBlock), `${f} 应被写入 payload`);
  });

  // 兜底：不能出现「无条件全量提交」
  assert.ok(!/payload\s*=\s*\{[^}]*amountCent[^}]*categoryId[^}]*date[^}]*note/.test(payloadBlock),
    '不应一次性提交全部字段（未改的字段会白写一次，还可能覆盖并发改动）');
});

test('改了日期跨月时会跳到新月份并给出提示', () => {
  // 改了日期这笔账可能移出当前月，若不处理用户会以为「这笔记账凭空消失了」
  assert.ok(/movedMonth/.test(detailJs), '应判断是否跨月');
  assert.ok(/loadBills\(newMonth\)/.test(detailJs), '跨月后应加载新月份');
  assert.ok(/已移到/.test(detailJs), '跨月应给出明确提示');
});

console.log('\n【云端 amend 的写入契约】');

test('云端把 categoryId 与 categoryPath 一起写入', () => {
  assert.ok(/updateData\.categoryId\s*=/.test(billSvc), '应写 categoryId');
  assert.ok(/updateData\.categoryPath\s*=/.test(billSvc), '应写 categoryPath');
});

test('云端按 id 反查预置类目的 path，不信前端传的', () => {
  // 前端传的 path 可能与 id 不匹配 → 写入后统计口径错乱
  assert.ok(/preset\.pathOf\(categoryId\)/.test(billSvc),
    '预置类目应按 id 反查 path');
});

test('云端有金额校验（正数 / 整数分 / 不超上限）', () => {
  assert.ok(/amountCent <= 0/.test(billSvc), '应拒绝非正金额');
  assert.ok(/Math\.round\(amountCent\) !== amountCent/.test(billSvc), '应拒绝浮点金额');
  assert.ok(/GUARDRAIL_MAX_AMOUNT_CENT/.test(billSvc), '应校验金额上限');
});

test('云端拒绝未来日期', () => {
  assert.ok(/不能记入未来的日期/.test(billSvc), '应拒绝未来日期');
});

test('云端只接受已知账户枚举', () => {
  // 云端仍保留 account 的校验与写入能力（ASR 链路会写入账户），
  // 只是**前端编辑面板不再暴露这个字段**。
  assert.ok(/ACCOUNT_TYPE/.test(billSvc), '应校验账户枚举');
  assert.ok(/updateData\.account\s*=/.test(billSvc), '应支持写入账户');
});

test('校验在「本地环境早退」之前执行', () => {
  // ⚠️ 若校验写在早退之后，本地跑测试时全部走早退分支，
  //    校验逻辑一次都没执行过 —— 测试全绿但校验其实没生效。
  //
  // ⚠️ 定位要精确：handleAmend 里有**两处**「本地环境未接入数据库」——
  //   delFlag 分支一处（删除不需要金额校验，那是对的），
  //   校验之后的主流程一处（这处必须排在校验**之后**）。
  //   所以不能拿字符串的首次出现位置来判断，要取「校验之后那一处」。
  const fn = billSvc.slice(billSvc.indexOf('async function handleAmend'));

  const validateAt = fn.indexOf('金额无效');
  assert.ok(validateAt > -1, '应存在金额校验');

  // 校验之后的那处本地早退
  const localExitAt = fn.indexOf('本地环境未接入数据库', validateAt);
  assert.ok(localExitAt > -1, '校验之后应存在本地环境早退分支');
  assert.ok(validateAt < localExitAt, '校验必须早于本地环境早退，否则本地测不到');
});

console.log('\n【分析结论的过期判定】');

test('分析过期判定同时看 createTime 与 updateTime', () => {
  // 编辑只改 updateTime。若只看 createTime，
  // 用户把 100 改成 500 后分析结论永远不会过期 → 展示的是旧金额的结论。
  const fn = dbIndex.slice(dbIndex.indexOf('async function listPendingInsightUsers'));
  assert.ok(/createTime/.test(fn), '应包含 createTime');
  assert.ok(/updateTime/.test(fn), '应包含 updateTime（编辑只改它）');
});

test('分析页能区分「结论已过期」并提示重新分析', () => {
  const analysisJs = fs.readFileSync(
    path.join(ROOT, 'miniprogram', 'pages', 'analysis', 'analysis.js'), 'utf8');
  const analysisWxml = fs.readFileSync(
    path.join(ROOT, 'miniprogram', 'pages', 'analysis', 'analysis.wxml'), 'utf8');
  assert.ok(/isOutdated/.test(analysisJs), '分析页应处理 isOutdated');
  assert.ok(/isOutdated/.test(analysisWxml), '分析页应展示过期提示');
  assert.ok(/重新分析/.test(analysisWxml), '过期提示应引导用户重新分析');
});

console.log(`\n${failed === 0 ? '✓ 全部通过' : '✗ 有失败'}：${passed} 通过 / ${failed} 失败\n`);
process.exit(failed === 0 ? 0 : 1);
