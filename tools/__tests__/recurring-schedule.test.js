/**
 * 重复记账规则的调度纯函数测试
 *
 * 覆盖 6 种模式的 `matches` / `nextOccurrence` 与参数校验。
 *
 * ## 为什么这层必须有测试
 *
 * dailyRecurring 每天 0:30 静默跑（触发器没有 UI 反馈），
 * 算错「今天该不该生成」的表现是**该生成的没生成 / 不该生成的生成了**，
 * 用户只会觉得「这功能坏了」，且要等到第二天才能发现。
 * 所有日期运算用 Date.UTC 实现，与运行时区无关，本地必须能全绿。
 *
 * 关键口径（与产品确认过）：
 *   · 月/季/年指定日在该月不存在 → 跳过当月，不补记不顺延
 *   · 每季度 = 固定 1/4/7/10 月
 *   · 工作日 = 周一至周五；每周 = 单个星期几（0=周日）
 */

const assert = require('assert');
const path = require('path');
const { validateRepeat, matches, nextOccurrence } = require(path.join(
  __dirname, '..', '..', 'cloudfunctions', 'shared', 'util', 'recurring.js'));

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

console.log('\n【validateRepeat：参数校验】');

test('六种类型全部合法', () => {
  ['daily', 'weekday', 'weekly', 'monthly', 'quarterly', 'yearly']
    .forEach((t) => {
      const params = t === 'weekly' ? { dayOfWeek: 1 }
        : (t === 'monthly' || t === 'quarterly') ? { dayOfMonth: 15 }
        : t === 'yearly' ? { month: 3, dayOfMonth: 15 } : {};
      assert.strictEqual(validateRepeat(t, params).ok, true, `${t} 应合法`);
    });
});

test('未知类型与越界参数被拒绝', () => {
  assert.strictEqual(validateRepeat('hourly', {}).ok, false);
  assert.strictEqual(validateRepeat('weekly', {}).ok, false);
  assert.strictEqual(validateRepeat('weekly', { dayOfWeek: 7 }).ok, false);
  assert.strictEqual(validateRepeat('weekly', { dayOfWeek: -1 }).ok, false);
  assert.strictEqual(validateRepeat('monthly', { dayOfMonth: 0 }).ok, false);
  assert.strictEqual(validateRepeat('monthly', { dayOfMonth: 32 }).ok, false);
  assert.strictEqual(validateRepeat('yearly', { month: 0, dayOfMonth: 1 }).ok, false);
  assert.strictEqual(validateRepeat('yearly', { month: 13, dayOfMonth: 1 }).ok, false);
  assert.strictEqual(validateRepeat('yearly', { month: 1 }).ok, false);
  assert.strictEqual(validateRepeat('monthly', { dayOfMonth: 1.5 }).ok, false);
});

console.log('\n【daily：每天】');

test('明天命中，且严格晚于今天', () => {
  assert.strictEqual(nextOccurrence('daily', {}, '2026-10-31'), '2026-11-01');
  assert.strictEqual(matches('daily', {}, '2026-10-31'), true);
  // 闰日也照常命中
  assert.strictEqual(nextOccurrence('daily', {}, '2024-02-28'), '2024-02-29');
});

console.log('\n【weekday：工作日】');

test('周五的下一个工作日是周一（跨周末）', () => {
  assert.strictEqual(nextOccurrence('weekday', {}, '2026-10-30'), '2026-11-02');
});

test('周日的下一个工作日是周一', () => {
  assert.strictEqual(nextOccurrence('weekday', {}, '2026-11-01'), '2026-11-02');
});

test('周末不命中、工作日命中', () => {
  assert.strictEqual(matches('weekday', {}, '2026-10-31'), false); // 周六
  assert.strictEqual(matches('weekday', {}, '2026-11-01'), false); // 周日
  assert.strictEqual(matches('weekday', {}, '2026-11-02'), true);  // 周一
  assert.strictEqual(matches('weekday', {}, '2026-11-06'), true);  // 周五
});

console.log('\n【weekly：每周指定星期几】');

test('下周同日，7 天内必命中', () => {
  // 2026-10-28 是周三；指定周三 → 11-04
  assert.strictEqual(nextOccurrence('weekly', { dayOfWeek: 3 }, '2026-10-28'), '2026-11-04');
  // 指定周一，从周三出发 → 11-02
  assert.strictEqual(nextOccurrence('weekly', { dayOfWeek: 1 }, '2026-10-28'), '2026-11-02');
  // 指定周日（0），从周三出发 → 11-01
  assert.strictEqual(nextOccurrence('weekly', { dayOfWeek: 0 }, '2026-10-28'), '2026-11-01');
});

test('matches 只认指定的那一天', () => {
  assert.strictEqual(matches('weekly', { dayOfWeek: 1 }, '2026-11-02'), true);
  assert.strictEqual(matches('weekly', { dayOfWeek: 1 }, '2026-11-03'), false);
});

console.log('\n【monthly：每月指定日】');

test('每月 15 日：从 14 日出发是当天，从 15 日出发是下月', () => {
  // 严格晚于 2026-10-14 → 2026-10-15
  assert.strictEqual(nextOccurrence('monthly', { dayOfMonth: 15 }, '2026-10-14'), '2026-10-15');
  // 严格晚于 2026-10-15 → 2026-11-15
  assert.strictEqual(nextOccurrence('monthly', { dayOfMonth: 15 }, '2026-10-15'), '2026-11-15');
});

test('每月 31 日：跳过没有 31 日的月份，不补记不顺延', () => {
  // 从 1 月 20 日出发：1-31 命中
  assert.strictEqual(nextOccurrence('monthly', { dayOfMonth: 31 }, '2026-01-20'), '2026-01-31');
  // 从 1 月 31 日出发：2 月无 31 日 → 跳过 → 3-31
  assert.strictEqual(nextOccurrence('monthly', { dayOfMonth: 31 }, '2026-01-31'), '2026-03-31');
});

test('matches 只认指定日', () => {
  assert.strictEqual(matches('monthly', { dayOfMonth: 31 }, '2026-03-31'), true);
  assert.strictEqual(matches('monthly', { dayOfMonth: 31 }, '2026-03-30'), false);
});

console.log('\n【quarterly：每季度（固定 1/4/7/10 月）】');

test('从 5 月出发 → 7 月', () => {
  assert.strictEqual(nextOccurrence('quarterly', { dayOfMonth: 10 }, '2026-05-01'), '2026-07-10');
});

test('从 10 月出发 → 跨年到次年 1 月', () => {
  assert.strictEqual(nextOccurrence('quarterly', { dayOfMonth: 10 }, '2026-10-20'), '2027-01-10');
});

test('只认季度月', () => {
  assert.strictEqual(matches('quarterly', { dayOfMonth: 10 }, '2026-07-10'), true);
  assert.strictEqual(matches('quarterly', { dayOfMonth: 10 }, '2026-05-10'), false);
});

console.log('\n【yearly：每年指定月日】');

test('未到今年指定日 → 今年；已过 → 明年', () => {
  assert.strictEqual(nextOccurrence('yearly', { month: 3, dayOfMonth: 15 }, '2026-01-01'), '2026-03-15');
  assert.strictEqual(nextOccurrence('yearly', { month: 3, dayOfMonth: 15 }, '2026-03-20'), '2027-03-15');
});

test('闰年 2 月 29 日：平年跳过，下个闰年命中', () => {
  // 2024-02-29 是闰日；之后 2025/2026/2027 平年跳过 → 2028-02-29
  assert.strictEqual(nextOccurrence('yearly', { month: 2, dayOfMonth: 29 }, '2024-02-29'), '2028-02-29');
  // 平年 2 月没有 29 日
  assert.strictEqual(matches('yearly', { month: 2, dayOfMonth: 29 }, '2026-02-28'), false);
  assert.strictEqual(matches('yearly', { month: 2, dayOfMonth: 29 }, '2024-02-29'), true);
});

console.log('\n【非法参数调用 nextOccurrence 必须抛错】');

test('未知类型抛错（调用方应先 validateRepeat）', () => {
  assert.throws(() => nextOccurrence('hourly', {}, '2026-10-31'));
  assert.throws(() => nextOccurrence('monthly', {}, '2026-10-31'));
});

console.log(`\n${failed === 0 ? '✓ 全部通过' : '✗ 有失败'}：${passed} 通过 / ${failed} 失败\n`);
process.exit(failed === 0 ? 0 : 1);
