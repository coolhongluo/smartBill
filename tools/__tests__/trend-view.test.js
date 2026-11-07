/**
 * 趋势图视图模型（miniprogram/utils/trend.js）的测试
 *
 * ## 为什么这个测试存在
 *
 * 真实故障：「近半年趋势图没有画出来」——**全程零报错**。
 *
 * 根因是 WXML 与数据源的契约断裂：
 *   WXML 写 `style="height:{{item.height}}%"` 和 `{{item.label}}`，
 *   而云函数返回的 trend 只有 { month, totalCent, totalYuan, count }。
 *   `height` 是 undefined → `height:undefined%` 是非法 CSS，被浏览器丢弃 →
 *   柱子只剩 wxss 里的 min-height: 4rpx，看起来就是「图没画出来」。
 *
 * 这个 bug 特别难发现，因为它**没有任何错误信号**：
 *   · 云函数返回正常
 *   · 数据字段看起来齐全（month/totalYuan 都在）
 *   · 只是少了两个「画图专用」的字段
 *
 * 所以这里最后一条测试是**契约测试**：
 * 直接从 analysis.wxml 里解析出趋势循环实际绑定了哪些字段，
 * 断言视图模型必须全部产出。
 * 以后谁再改 WXML 加字段、忘了在视图模型里补，测试立刻失败。
 *
 * 这就是 MEMORY 里那条教训的落地：
 * 「所有检查都通过」不等于「代码是对的」——
 * 只有**真解析** WXML 并与数据契约对账，才能发现这类静默断裂。
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { buildTrendView, MIN_VISIBLE_PERCENT } = require('../../miniprogram/utils/trend.js');

const ROOT = path.resolve(__dirname, '..', '..');
const ANALYSIS_WXML = path.join(ROOT, 'miniprogram', 'pages', 'analysis', 'analysis.wxml');

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

console.log('\n【输入防御】');

test('非数组输入返回空数组，不抛异常', () => {
  assert.deepStrictEqual(buildTrendView(undefined), []);
  assert.deepStrictEqual(buildTrendView(null), []);
  assert.deepStrictEqual(buildTrendView([]), []);
  assert.deepStrictEqual(buildTrendView('2026-10'), []);
});

test('空 trend 时不产生空对象占位', () => {
  const r = buildTrendView([]);
  assert.strictEqual(r.length, 0);
});

console.log('\n【柱高计算】');

test('最高的月份占满 100%，其余按比例', () => {
  const r = buildTrendView([
    { month: '2026-08', totalCent: 10000, totalYuan: '100.00', count: 3 },
    { month: '2026-09', totalCent: 30000, totalYuan: '300.00', count: 9 },
    { month: '2026-10', totalCent: 60000, totalYuan: '600.00', count: 12 }
  ]);

  // 基准是当月最高值（60000 分），不是第二个月
  assert.strictEqual(r[0].height, 16.7);   // 10000/60000
  assert.strictEqual(r[1].height, 50);     // 30000/60000
  assert.strictEqual(r[2].height, 100);    // 60000/60000
});

test('零消费月份高度是数字 0（wxss 靠 height:0% 画基线）', () => {
  const r = buildTrendView([
    { month: '2026-09', totalCent: 0, totalYuan: '0.00', count: 0 },
    { month: '2026-10', totalCent: 50000, totalYuan: '500.00', count: 8 }
  ]);

  // 必须是数字 0，不能是字符串 "0" 或 "0%"：
  // wxss 的 `.trend-bar[style*="height:0%"]` 靠精确匹配生效
  assert.strictEqual(r[0].height, 0);
  assert.strictEqual(typeof r[0].height, 'number');
  assert.strictEqual(r[1].height, 100);
});

test('全部为零时不会除零出 NaN', () => {
  const r = buildTrendView([
    { month: '2026-09', totalCent: 0, totalYuan: '0.00', count: 0 },
    { month: '2026-10', totalCent: 0, totalYuan: '0.00', count: 0 }
  ]);
  r.forEach((it) => {
    assert.strictEqual(it.height, 0);
    assert.ok(!isNaN(it.height), '高度不能是 NaN');
  });
});

test('金额极小但不为 0 的月份有最小可见高度（不能被当成没花钱）', () => {
  const r = buildTrendView([
    { month: '2026-09', totalCent: 100, totalYuan: '1.00', count: 1 },
    { month: '2026-10', totalCent: 1000000, totalYuan: '10000.00', count: 20 }
  ]);

  // 100/1000000 = 0.01%，四舍五入会变成 0 → 视觉上等同「没花钱」
  assert.ok(r[0].height >= MIN_VISIBLE_PERCENT,
    `小额月份高度应 ≥ ${MIN_VISIBLE_PERCENT}%，实际 ${r[0].height}%`);
  assert.ok(r[0].height > 0, '有消费的月份高度不能是 0');
});

test('柱高只认整数分，不受 totalYuan 字符串影响', () => {
  // totalYuan 故意写成与 totalCent 不一致的值：
  // 若实现偷偷用了 totalYuan，比例会算错
  const r = buildTrendView([
    { month: '2026-09', totalCent: 10000, totalYuan: '9999.00', count: 3 },
    { month: '2026-10', totalCent: 20000, totalYuan: '1.00', count: 5 }
  ]);

  assert.strictEqual(r[0].height, 50);   // 10000/20000
  assert.strictEqual(r[1].height, 100);
});

test('旧数据缺 totalCent 时，从 totalYuan 换算回来', () => {
  const r = buildTrendView([
    { month: '2026-09', totalYuan: '100.00', count: 3 },
    { month: '2026-10', totalYuan: '200.00', count: 5 }
  ]);

  assert.strictEqual(r[0].height, 50);
  assert.strictEqual(r[1].height, 100);
});

test('金额与笔数原样透传，不被视图层改写', () => {
  const r = buildTrendView([
    { month: '2026-10', totalCent: 12345, totalYuan: '123.45', count: 8 }
  ]);

  assert.strictEqual(r[0].totalYuan, '123.45');
  assert.strictEqual(r[0].count, 8);
  assert.strictEqual(r[0].month, '2026-10');
});

console.log('\n【月份标签】');

test('标签是「10月」这种中文短标签', () => {
  const r = buildTrendView([
    { month: '2026-05', totalCent: 1000, totalYuan: '10.00', count: 1 },
    { month: '2026-10', totalCent: 1000, totalYuan: '10.00', count: 1 }
  ]);
  assert.strictEqual(r[0].label, '5月');
  assert.strictEqual(r[1].label, '10月');
});

test('跨年窗口首列带年份，避免「1月」是哪一年看不出来', () => {
  const r = buildTrendView([
    { month: '2025-12', totalCent: 1000, totalYuan: '10.00', count: 1 },
    { month: '2026-01', totalCent: 1000, totalYuan: '10.00', count: 1 }
  ]);
  assert.strictEqual(r[0].label, '25年12月');
  assert.strictEqual(r[1].label, '1月');
});

test('同一年内不显示年份（不制造视觉噪音）', () => {
  const r = buildTrendView([
    { month: '2026-01', totalCent: 0, totalYuan: '0.00', count: 0 },
    { month: '2026-06', totalCent: 0, totalYuan: '0.00', count: 0 }
  ]);
  assert.strictEqual(r[0].label, '1月');
  assert.strictEqual(r[1].label, '6月');
});

console.log('\n【契约测试：WXML 绑定的字段必须都能产出】');

/**
 * 从 WXML 里抽出趋势循环实际使用的字段
 *
 * ⚠️ 必须限定在 trend 那个 wx:for 块里：
 *    同一个文件里还有 savings / pie 两个 wx:for，它们的 item 结构完全不同。
 */
function extractTrendBindings(wxml) {
  const start = wxml.indexOf('wx:for="{{trend}}"');
  assert.ok(start > -1, 'analysis.wxml 里应存在 trend 的 wx:for');

  // 找到该 wx:for 所属元素的结束位置：从 start 往后找配对的 </view>
  const block = wxml.slice(start);
  // 趋势循环内用到的字段都在这一段里（trend-col 内部的绑定）
  const end = block.indexOf('</view>\n      </view>\n      <view class="trend-tip"');
  const scope = end > -1 ? block.slice(0, end) : block;

  const fields = new Set();
  const re = /\{\{\s*item\.([A-Za-z0-9_]+)\s*\}\}/g;
  let m;
  while ((m = re.exec(scope)) !== null) fields.add(m[1]);
  return fields;
}

test('趋势循环绑定的每个字段，视图模型都必须产出', () => {
  const wxml = fs.readFileSync(ANALYSIS_WXML, 'utf8');
  const bound = extractTrendBindings(wxml);

  assert.ok(bound.size > 0, '应能从 WXML 解析出趋势绑定的字段');

  const item = buildTrendView([
    { month: '2026-10', totalCent: 10000, totalYuan: '100.00', count: 3 }
  ])[0];

  const missing = [...bound].filter((f) => !(f in item));
  assert.strictEqual(missing.length, 0,
    `WXML 绑定了这些字段但视图模型没产出：${missing.join(', ')}`);

  // ⚠️ 光有 key 不够——**有 key 但值是 undefined 正是原始 bug**：
  //   `height: undefined` → `height:undefined%` → 非法 CSS 被丢弃 → 柱子不显示。
  //   这种情况下 WXML 绑定「看起来是好的」，运行时才塌掉。
  const undef = [...bound].filter((f) => item[f] === undefined);
  assert.strictEqual(undef.length, 0,
    `这些字段的值是 undefined（WXML 绑定看着正常，运行时却拿不到值）：${undef.join(', ')}`);

  // 数值字段还必须是数字：null / NaN 都会让高度失效
  ['height'].forEach((f) => {
    assert.strictEqual(typeof item[f], 'number', `${f} 必须是数字，实际 ${typeof item[f]}`);
    assert.ok(!isNaN(item[f]), `${f} 不能是 NaN`);
  });

  // 字符串字段不能为空串（空标签在界面上就是「没画出来」）
  ['label', 'month'].forEach((f) => {
    assert.ok(typeof item[f] === 'string' && item[f].length > 0, `${f} 不能为空`);
  });
});

test('WXML 必须绑定 height（否则柱子画不出来）', () => {
  const wxml = fs.readFileSync(ANALYSIS_WXML, 'utf8');
  const bound = extractTrendBindings(wxml);
  assert.ok(bound.has('height'),
    '趋势循环里应绑定 item.height，否则 style="height:{{item.height}}%" 拿不到值');
  assert.ok(bound.has('label'),
    '趋势循环里应绑定 item.label，否则月份标签是空的');
});

console.log(`\n${failed === 0 ? '✓ 全部通过' : '✗ 有失败'}：${passed} 通过 / ${failed} 失败\n`);
process.exit(failed === 0 ? 0 : 1);
