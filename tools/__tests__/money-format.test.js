/**
 * 金额换算的单元测试
 *
 * ## 为什么单独测这两个函数
 *
 * `yuanInput`（分 → 元字符串）与 `yuanToCent`（元字符串 → 分）
 * 是编辑面板的**数据入口与出口**。任何一处出错，用户看到的都是
 * 「金额不对」，而界面上没有任何报错。
 *
 * 真实踩过的坑：
 *   1. 回填时传了展示用字符串 "¥120.00" → Number() = NaN → 兜底成 0
 *      （面板里金额显示 0，点保存报「请输入有效金额」）
 *   2. 用 parseFloat(str) * 100 转分 → 8.115 * 100 = 811.4999…
 *      → Math.round → 811，少一分钱且毫无征兆
 *
 * 这两个都是**静默错误**，必须有测试兜住。
 */

const assert = require('assert');
const path = require('path');
const { yuanInput, yuanToCent } = require(path.join(
  __dirname, '..', '..', 'miniprogram', 'utils', 'format.js'));

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

console.log('\n【yuanInput：整数分 → 元字符串】');

test('整数分转成两位小数的元', () => {
  assert.strictEqual(yuanInput(12000), '120.00');
  assert.strictEqual(yuanInput(0), '0.00');
  assert.strictEqual(yuanInput(1), '0.01');
});

test('保留角分，不丢精度', () => {
  assert.strictEqual(yuanInput(12050), '120.50');
  assert.strictEqual(yuanInput(123), '1.23');
  assert.strictEqual(yuanInput(5), '0.05');
});

test('非法输入兜底为 0，不返回 NaN', () => {
  // ⚠️ 关键：不能返回 NaN。
  // Number("¥120.00") 是 NaN，NaN 再经 toFixed 会变成 "NaN"，
  // 直接显示在输入框里。
  assert.strictEqual(yuanInput(undefined), '0.00');
  assert.strictEqual(yuanInput(null), '0.00');
  assert.strictEqual(yuanInput('¥120.00'), '0.00');
  assert.strictEqual(yuanInput('abc'), '0.00');
});

test('不接受「分」当「元」用（防呆）', () => {
  // 传入 12000 应该得到 120.00 元，不是 12000.00 元。
  // 这个函数只认分，不认元 —— 名字与参数名必须说清单位。
  assert.strictEqual(yuanInput(12000), '120.00');
  assert.notStrictEqual(yuanInput(12000), '12000.00');
});

console.log('\n【yuanToCent：元字符串 → 整数分】');

test('常规换算', () => {
  assert.strictEqual(yuanToCent('120.00'), 12000);
  assert.strictEqual(yuanToCent('120'), 12000);
  assert.strictEqual(yuanToCent('0.05'), 5);
  assert.strictEqual(yuanToCent('123.45'), 12345);
});

test('不受浮点误差影响（parseFloat 做不到）', () => {
  // 8.115 * 100 = 811.4999999999999 → Math.round → 811（少一分钱）
  assert.strictEqual(yuanToCent('8.115'), 812);
  assert.strictEqual(yuanToCent('1.005'), 101);
  assert.strictEqual(yuanToCent('0.29'), 29);
  assert.strictEqual(yuanToCent('70.10'), 7010);
});

test('第三位小数起四舍五入', () => {
  assert.strictEqual(yuanToCent('0.004'), 0);
  assert.strictEqual(yuanToCent('0.005'), 1);
  assert.strictEqual(yuanToCent('0.014'), 1);
  assert.strictEqual(yuanToCent('0.015'), 2);
});

test('非法输入返回 null（而不是 0 或 NaN）', () => {
  // ⚠️ 必须能区分「非法」与「真的是 0」：
  // 0 元是非法金额，但「没填」也是 0 —— 两者要分开处理。
  assert.strictEqual(yuanToCent(''), null);
  assert.strictEqual(yuanToCent('   '), null);
  assert.strictEqual(yuanToCent(null), null);
  assert.strictEqual(yuanToCent(undefined), null);
  assert.strictEqual(yuanToCent('abc'), null);
  assert.strictEqual(yuanToCent('1.2.3'), null);
  assert.strictEqual(yuanToCent('.'), null);
  assert.strictEqual(yuanToCent('-5'), null);
  assert.strictEqual(yuanToCent('1e3'), null);
});

console.log('\n【往返一致性】');

test('分 → 元 → 分 是恒等的', () => {
  [1, 5, 99, 100, 1234, 12000, 12050, 999999].forEach((cent) => {
    assert.strictEqual(yuanToCent(yuanInput(cent)), cent,
      `${cent} 分往返后应不变`);
  });
});

test('两位小数的元字符串往返恒等', () => {
  ['0.01', '1.23', '120.00', '120.50', '9999.99'].forEach((yuan) => {
    assert.strictEqual(yuanInput(yuanToCent(yuan)), yuan,
      `${yuan} 元往返后应不变`);
  });
});

console.log(`\n${failed === 0 ? '✓ 全部通过' : '✗ 有失败'}：${passed} 通过 / ${failed} 失败\n`);
process.exit(failed === 0 ? 0 : 1);
