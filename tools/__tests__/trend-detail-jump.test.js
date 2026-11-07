/**
 * 「近半年趋势」点柱跳明细（miniprogram）的契约测试
 *
 * ## 为什么这个测试存在
 *
 * 这条链路横跨三个文件，任何一环断了都是**静默失败**：
 *   analysis.wxml 柱子绑 data-month + bindtap → analysis.js onTrendTap
 *   → app.globalData.detailMonth 中转（tab 页 switchTab 无法带参）
 *   → detail.js onLoad/onShow 消费 → monthBills 按 payload.month 查询
 *
 * 曾经的真实状态：柱子点了只弹 toast「明细待接入」——不报错、不跳转。
 * 这类「占位实现」没有任何错误信号，只有契约测试能拦住回退。
 *
 * 断言方式是**真解析源码**（对齐 trend-view.test.js 的做法）：
 * mock 一个 wx 环境跑 onTrendTap 意义不大——
 * 断言的恰恰是「源码里这条链还在不在」，而不是某次执行的快照。
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { shiftMonth } = require('../../miniprogram/utils/format.js');

const ROOT = path.resolve(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const ANALYSIS_WXML = read('miniprogram/pages/analysis/analysis.wxml');
const ANALYSIS_JS = read('miniprogram/pages/analysis/analysis.js');
const DETAIL_JS = read('miniprogram/pages/detail/detail.js');
const DETAIL_WXML = read('miniprogram/pages/detail/detail.wxml');

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

console.log('\n【入口：趋势柱可点且带月份】');

test('趋势柱绑定了 data-month 与 onTrendTap', () => {
  assert.ok(/wx:for="\{\{trend\}\}"/.test(ANALYSIS_WXML), '趋势循环应存在');
  assert.ok(/data-month="\{\{item\.month\}\}"/.test(ANALYSIS_WXML),
    '柱子必须带 data-month，否则点按时拿不到月份');
  assert.ok(/bindtap="onTrendTap"/.test(ANALYSIS_WXML),
    '柱子必须绑定 onTrendTap');
});

test('onTrendTap 不是占位 toast，而是走 globalData 中转 + switchTab', () => {
  const m = ANALYSIS_JS.match(/onTrendTap\(e\)\s*\{[\s\S]*?\n  \}/);
  assert.ok(m, 'analysis.js 应定义 onTrendTap');
  const body = m[0];
  assert.ok(body.includes('detailMonth'), '必须写入 globalData.detailMonth');
  assert.ok(body.includes('switchTab'), '必须跳转到明细 tab');
  assert.ok(body.includes('/pages/detail/detail'), '跳转目标应是明细页');
  assert.ok(!body.includes('showToast'), '不应再是占位 toast');
});

console.log('\n[' + '中转：globalData 槽位配套]');
test('app.js 提供 detailMonth 槽位（tab 页无法 URL 带参）', () => {
  const appJs = read('miniprogram/app.js');
  assert.ok(/detailMonth:\s*null/.test(appJs), 'globalData 应声明 detailMonth');
});

console.log('\n【消费：明细页接到月份并查询】');

test('明细页 onLoad 与 onShow 都消费 detailMonth，且消费后清空', () => {
  // onLoad：首次打开就带着跳转请求时避免先闪现当前月
  const onLoad = DETAIL_JS.match(/onLoad\(\)\s*\{[\s\S]*?\n  \}/)[0];
  assert.ok(onLoad.includes('detailMonth'), 'onLoad 应检查跳转请求');
  assert.ok(onLoad.includes('null'), 'onLoad 消费后应清空');

  // onShow：页面已加载后再跳转的场景
  const onShow = DETAIL_JS.match(/onShow\(\)\s*\{[\s\S]*?\n  \},/)[0];
  assert.ok(onShow.includes('detailMonth'), 'onShow 应检查跳转请求');
  assert.ok(onShow.includes('null'), 'onShow 消费后应清空——不清空的话下次进明细页仍跳旧月份');
});

test('loadBills 接受月份参数并传给 monthBills（而非写死当前月）', () => {
  const m = DETAIL_JS.match(/async loadBills\(month\)\s*\{[\s\S]*?\n  \},/);
  assert.ok(m, 'loadBills 应接受 month 参数');
  assert.ok(m[0].includes('month: target') || m[0].includes('month,'), '查询时应使用目标月份');
  assert.ok(!/new Date\(\)/.test(m[0]), '不应在 loadBills 内重新推导当前月');
});

test('上/下月按钮是真实切月，不是占位 toast', () => {
  const prev = DETAIL_JS.match(/onPrevMonth\(\)\s*\{[\s\S]*?\n  \}/)[0];
  const next = DETAIL_JS.match(/onNextMonth\(\)\s*\{[\s\S]*?\n  \}/)[0];
  assert.ok(prev.includes('shiftMonth'), '上月应调用 shiftMonth');
  assert.ok(next.includes('shiftMonth'), '下月应调用 shiftMonth');
  assert.ok(next.includes('currentMonth'), '下月应封顶当前月');
  assert.ok(!prev.includes('showToast') && !next.includes('showToast'), '不应再弹「待接入」');
});

test('下月按钮的置灰绑定与 atCurrentMonth 数据配套', () => {
  assert.ok(/atCurrentMonth \? 'disabled' : ''/.test(DETAIL_WXML),
    'WXML 应按 atCurrentMonth 给下月按钮加 disabled 类');
  assert.ok(/atCurrentMonth:/.test(DETAIL_JS), 'detail.js 应产出 atCurrentMonth');
  assert.ok(/\.nav-btn\.disabled/.test(read('miniprogram/pages/detail/detail.wxss')),
    'wxss 应有置灰样式');
});

test('空态文案随月份变化（看历史月时不说「本月」）', () => {
  assert.ok(/\{\{emptyText\}\}/.test(DETAIL_WXML), '空态主文案应绑定 emptyText');
  assert.ok(/buildEmptyText/.test(DETAIL_JS), '应有按月份生成空态文案的逻辑');
});

console.log('\n【shiftMonth：切月的跨年边界】');

test('同年内平移', () => {
  assert.strictEqual(shiftMonth('2026-05', -1), '2026-04');
  assert.strictEqual(shiftMonth('2026-05', 1), '2026-06');
  assert.strictEqual(shiftMonth('2026-05', 0), '2026-05');
});

test('跨年：年初往前、年末往后', () => {
  assert.strictEqual(shiftMonth('2026-01', -1), '2025-12');
  assert.strictEqual(shiftMonth('2025-12', 1), '2026-01');
});

test('连续平移多次（趋势半年窗口可点最早一根柱子）', () => {
  let m = '2026-05';
  for (let i = 0; i < 5; i++) m = shiftMonth(m, -1);
  assert.strictEqual(m, '2025-12');
});

test('月份补零（不用 String padStart 的等价路径也应两位）', () => {
  assert.strictEqual(shiftMonth('2026-09', 1), '2026-10');
  assert.strictEqual(shiftMonth('2026-10', 1), '2026-11');
});

console.log(`\n${failed === 0 ? '✓ 全部通过' : '✗ 有失败'}：${passed} 通过 / ${failed} 失败\n`);
process.exit(failed === 0 ? 0 : 1);
