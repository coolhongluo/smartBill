/**
 * 重复记账规则 —— 调度纯函数
 *
 * 只做「哪一天该生成」的数学，不含任何 I/O：
 *   · validateRepeat     规则参数校验（建/改规则时用）
 *   · matches            某天是否命中规则
 *   · nextOccurrence     「严格晚于」某天的下一个命中日
 *
 * ## 口径（与产品确认过的决策）
 *
 * 1. 所有日期均为东八区 YYYY-MM-DD 字符串。调用方负责把时间戳转成
 *    `toDateStrCST(ts)` 再传入 —— 云函数运行时是 UTC+0，本地时区
 *    在这里会算错「今天」，详见 util/date.js 的 CST 说明。
 * 2. 月/季/年规则指定的日期在当月不存在（2 月 30 日、4 月 31 日、
 *    平年 2 月 29 日）→ **跳过当月**，不补记、不顺延。
 * 3. 每季度 = 固定 1/4/7/10 月的指定日。
 * 4. 每周 = 单个星期几（0=周日，1=周一）；工作日 = 周一至周五。
 * 5. 星期几一律用东八区日历（parse 成 UTC 字段计算），
 *    与本地时区/夏令时无关。
 *
 * ## 为什么纯函数单独成模块
 *
 * dailyRecurring（定时生成）与 ruleCreate/ruleUpdate/rulePause（游标初始化）
 * 共用同一套「下一个命中日」逻辑。三处各写一份必然漂移 ——
 * 本项目最大的坑就是「同一件事在 3 条路径上各有一份实现」。
 */

/** 全部合法类型 */
const REPEAT_TYPES = ['daily', 'weekday', 'weekly', 'monthly', 'quarterly', 'yearly'];

/** 季度固定的月份（1-12） */
const QUARTER_MONTHS = [1, 4, 7, 10];

/**
 * 解析 YYYY-MM-DD 为 { y, m, d }（1-12 月 / 1-31 日）
 * 格式非法返回 null
 */
function parseDateStr(dateStr) {
  if (typeof dateStr !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) return null;
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

/** { y, m, d } → YYYY-MM-DD */
function formatDateStr({ y, m, d }) {
  const p = (n) => String(n).padStart(2, '0');
  return `${y}-${p(m)}-${p(d)}`;
}

/** 某年某月的天数（y 年、m 1-12 月）—— Date.UTC 自动处理闰年 */
function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** 某日期（YYYY-MM-DD）的东八区星期几，0=周日，1=周一 */
function weekdayOfDateStr(dateStr) {
  const t = parseDateStr(dateStr);
  return new Date(Date.UTC(t.y, t.m - 1, t.d)).getUTCDay();
}

/** dateStr 加 n 天 → 新日期字符串（n 可为负） */
function addDays(dateStr, n) {
  const t = parseDateStr(dateStr);
  const dt = new Date(Date.UTC(t.y, t.m - 1, t.d + n));
  return formatDateStr({
    y: dt.getUTCFullYear(),
    m: dt.getUTCMonth() + 1,
    d: dt.getUTCDate()
  });
}

/**
 * 校验重复规则参数
 *
 * @param {string} type 规则类型
 * @param {object} params { dayOfWeek?, dayOfMonth?, month? }
 * @returns {{ok:boolean, error?:string}}
 */
function validateRepeat(type, params = {}) {
  if (!REPEAT_TYPES.includes(type)) {
    return { ok: false, error: `重复类型无效，应为：${REPEAT_TYPES.join(' / ')}` };
  }
  const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

  if (type === 'weekly' && !isInt(params.dayOfWeek, 0, 6)) {
    return { ok: false, error: '每周规则需要 dayOfWeek（0=周日 ~ 6=周六）' };
  }
  if ((type === 'monthly' || type === 'quarterly') && !isInt(params.dayOfMonth, 1, 31)) {
    return { ok: false, error: '每月/每季度规则需要 dayOfMonth（1-31）' };
  }
  if (type === 'yearly') {
    if (!isInt(params.month, 1, 12)) {
      return { ok: false, error: '每年规则需要 month（1-12）' };
    }
    if (!isInt(params.dayOfMonth, 1, 31)) {
      return { ok: false, error: '每年规则需要 dayOfMonth（1-31）' };
    }
    // 该月在任何年份都不存在这一天（2 月 30/31 日、4 月 31 日…）
    // → 规则永远无法触发，属于输入错误，直接拒绝。
    // 2 月 29 日是合法参数：平年跳过、闰年命中（见 nextOccurrence）。
    const maxDay = params.month === 2 ? 29 : ([4, 6, 9, 11].includes(params.month) ? 30 : 31);
    if (params.dayOfMonth > maxDay) {
      return { ok: false, error: `${params.month} 月没有 ${params.dayOfMonth} 日，请重新选择` };
    }
  }
  return { ok: true };
}

/**
 * 某天（YYYY-MM-DD）是否命中规则
 * 参数合法性由 validateRepeat 保证，这里不再重复校验
 */
function matches(type, params, dateStr) {
  const t = parseDateStr(dateStr);
  if (!t) return false;

  switch (type) {
    case 'daily':
      return true;
    case 'weekday':
      return weekdayOfDateStr(dateStr) >= 1 && weekdayOfDateStr(dateStr) <= 5;
    case 'weekly':
      return weekdayOfDateStr(dateStr) === params.dayOfWeek;
    case 'monthly':
      return t.d === params.dayOfMonth;
    case 'quarterly':
      return QUARTER_MONTHS.includes(t.m) && t.d === params.dayOfMonth;
    case 'yearly':
      return t.m === params.month && t.d === params.dayOfMonth;
    default:
      return false;
  }
}

/**
 * 「严格晚于」afterDateStr 的第一个命中日
 *
 * 未命中月份直接跳过（2 月 30 日 → 3 月 30 日，不补记不顺延），
 * 与产品口径一致。任何类型最多迭代 12 个月 + 7 天，保证终止。
 *
 * @param {string} afterDateStr YYYY-MM-DD
 * @returns {string} 下一个命中日 YYYY-MM-DD；参数非法抛错（调用方先 validateRepeat）
 */
function nextOccurrence(type, params, afterDateStr) {
  const v = validateRepeat(type, params);
  if (!v.ok) throw new Error(v.error);

  switch (type) {
    case 'daily':
      return addDays(afterDateStr, 1);
    case 'weekday': {
      let d = addDays(afterDateStr, 1);
      for (let i = 0; i < 7; i++) {
        if (matches(type, params, d)) return d;
        d = addDays(d, 1);
      }
      throw new Error('weekday 规则 7 天内未找到命中日（不应发生）');
    }
    case 'weekly': {
      let d = addDays(afterDateStr, 1);
      for (let i = 0; i < 7; i++) {
        if (matches(type, params, d)) return d;
        d = addDays(d, 1);
      }
      throw new Error('weekly 规则 7 天内未找到命中日（不应发生）');
    }
    case 'monthly':
    case 'quarterly':
    case 'yearly': {
      // ⚠ 不能把 afterDateStr 逐月 +1 并钳日：那会把起始日的「日」一直带下去
      //   （从 2 月 15 日找「每月 31 日」会永远钳在 15）。
      //   正确做法：从**当月**开始逐月构造候选日（y, m, dayOfMonth），
      //   用日期字符串比较保证「严格晚于」afterDateStr —— 同月内更晚的
      //   指定日（10-14 → 10-15）会命中，已过的（10-15 → 11-15）会跳过。
      //   该月没有这一天（2 月 30 日 / 平年 2 月 29 日）就跳过当月。
      //   最多迭代 60 个月：覆盖 yearly 的最坏情形（闰年 2 月 29 日
      //   → 下一个闰年最多隔 8 年）。
      const t = parseDateStr(afterDateStr);
      let y = t.y;
      let m = t.m;
      for (let i = 0; i < 60; i++) {
        if (m > 12) { m = 1; y += 1; }
        if (daysInMonth(y, m) >= params.dayOfMonth) {
          const day = formatDateStr({ y, m, d: params.dayOfMonth });
          if (day > afterDateStr && matches(type, params, day)) return day;
        }
        m += 1;
      }
      throw new Error(`${type} 规则 60 个月内未找到命中日（不应发生）`);
    }
    default:
      throw new Error(`未知重复类型: ${type}`);
  }
}

module.exports = {
  REPEAT_TYPES,
  validateRepeat,
  matches,
  nextOccurrence
};
