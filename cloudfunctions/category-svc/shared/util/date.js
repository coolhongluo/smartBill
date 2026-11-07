/**
 * 时间处理 —— 相对时间解析 + 账期计算
 *
 * 语音里说「昨天」「上礼拜三」「前天」，需要转成 YYYY-MM-DD。
 * 时间解析交给 LLM 兜底，但规则层必须能独立处理常见表达，
 * 否则 LLM 不可用时整条链路会断。
 */

/** 取当天 00:00:00 的时间戳 */
function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** YYYY-MM-DD */
function toDateStr(ts) {
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/** 账期字符串 YYYY-MM */
function toMonthStr(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * 东八区（UTC+8）账期 —— 定时任务专用
 *
 * ## 为什么需要单独一个函数
 *
 * **云函数运行时时区是 UTC+0，而定时触发器的 cron 规则时区是 UTC+8。**
 * 这两套时区混用会在**每月 1 号 0 点**算错月份：
 * 触发那一刻 UTC 是上月最后一天 16:00 → `toMonthStr(new Date())` 拿到**上个月** →
 * 定时任务分析了上个月的账单，而用户看到的是本月。
 *
 * ⚠️ 不能直接改 `toMonthStr` —— 它被 5 个云函数共用
 * （`db/index.js` 的区间查询、`user-svc` 的笔数统计等），
 * 那些路径的语义是「服务器本地时区的月份」，改口径会波及一片。
 * **只有定时任务需要「东八区的自然月」这个明确口径。**
 *
 * ## 为什么用固定偏移而不是依赖 TZ 环境变量
 *
 * 官方推荐给云函数配 `TZ=Asia/Shanghai`。但那是**控制台手工配置**，
 * 换环境、漏配、复制函数时都可能丢 —— 而漏配的后果是**静默算错月份**，
 * 没有任何报错。
 *
 * 代码内显式偏移：无论环境变量怎么配，结果都一致。
 * （`TZ` 环境变量仍然建议配上 —— 它影响日志时间等其他地方，
 * 但**本函数不依赖它**。）
 *
 * ## 实现
 *
 * 用固定 +8 小时偏移后取 UTC 字段 ——
 * 不依赖运行时本地时区，也避开夏令时（东八区没有夏令时）。
 *
 * @param {number} ts 时间戳
 * @returns {string} YYYY-MM
 */
const CST_OFFSET_MS = 8 * 60 * 60 * 1000;

function toMonthStrCST(ts) {
  const d = new Date(Number(ts) + CST_OFFSET_MS);
  // 用 getUTC* 取「偏移后」的 UTC 字段，等价于东八区的日历字段
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** 东八区日期 YYYY-MM-DD（定时任务配套用） */
function toDateStrCST(ts) {
  const d = new Date(Number(ts) + CST_OFFSET_MS);
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${d.getUTCFullYear()}-${m}-${day}`;
}

/** 星期几，0=周日，1=周一 */
function getWeekday(ts) {
  return new Date(ts).getDay();
}

/**
 * 东八区星期几，0=周日，1=周一 —— 定时任务专用
 *
 * 与 toMonthStrCST 同理：云函数运行时是 UTC+0，`getWeekday` 取本地时区，
 * 定时任务（重复记账 dailyRecurring）用它会在 0:30（UTC 前一日 16:30）
 * 拿到**前一天**的星期几 → 「工作日」规则在该生成的日子被跳过。
 */
function getWeekdayCST(ts) {
  const d = new Date(Number(ts) + CST_OFFSET_MS);
  return d.getUTCDay();
}

/** 相对天数：'今天'|'昨天'|'前天'|'N天前'|null */
const RELATIVE_DAYS = [
  { keys: ['今天', '今儿', '今儿个', '本日'], offset: 0 },
  { keys: ['昨天', '昨儿', '昨日'], offset: -1 },
  { keys: ['前天', '前日'], offset: -2 },
  { keys: ['大前天'], offset: -3 }
];

const CN_NUM = {
  一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7,
  八: 8, 九: 9, 十: 10, 天: -1
};

/**
 * 规则解析相对时间
 * @returns {{type:string, date:string|null}|null}
 */
function parseRelativeDate(text, now = Date.now()) {
  if (!text) return null;

  for (const item of RELATIVE_DAYS) {
    if (item.keys.some((k) => text.includes(k))) {
      return { type: 'relative', date: toDateStr(startOfDay(now) + item.offset * 86400000) };
    }
  }

  // 「N天前」「三天前」
  const daysAgo = text.match(/([一二两三四五六七八九十])?\s*天前/);
  if (daysAgo) {
    const n = daysAgo[1] ? CN_NUM[daysAgo[1]] : 1;
    return { type: 'relative', date: toDateStr(startOfDay(now) - n * 86400000) };
  }

  // 「上礼拜X」「上周X」「上星期X」
  const lastWeek = text.match(/上(?:个)?(?:周|星期|礼拜)\s*([一二三四五六日天])/);
  if (lastWeek) {
    const map = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 };
    const target = map[lastWeek[1]];
    return { type: 'relative', date: lastWeekdayOf(now, target) };
  }

  // 「本周X」「这周X」
  const thisWeek = text.match(/(?:这|本)(?:周|星期|礼拜)\s*([一二三四五六日天])/);
  if (thisWeek) {
    const map = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 };
    const target = map[thisWeek[1]];
    return { type: 'relative', date: weekdayOf(now, target) };
  }

  // 「上个月X号」「上月X」
  const lastMonth = text.match(/上(?:个)?月\s*([\d一二三四五六七八九十]+)\s*[号日]?/);
  if (lastMonth) {
    const { yuanToCent } = require('./money');
    const { cnToNumber } = require('./money');
    const dayNum = /^\d+$/.test(lastMonth[1]) ? parseInt(lastMonth[1], 10) : cnToNumber(lastMonth[1]);
    if (dayNum >= 1 && dayNum <= 31) {
      const d = new Date(now);
      const y = d.getFullYear();
      const m = d.getMonth(); // 上个月 = 当前月 -1
      const dt = new Date(y, m, 0); // 取上月最后一天
      if (dayNum <= dt.getDate()) {
        return { type: 'relative', date: toDateStr(new Date(y, m - 1, dayNum).getTime()) };
      }
    }
  }

  // 「这个月X号」——只在不晚于今天时才认为合理（防止说未来日期）
  const thisMonth = text.match(/(?:这个|本)月\s*([\d一二三四五六七八九十]+)\s*[号日]/);
  if (thisMonth) {
    const { cnToNumber } = require('./money');
    const dayNum = /^\d+$/.test(thisMonth[1]) ? parseInt(thisMonth[1], 10) : cnToNumber(thisMonth[1]);
    const d = new Date(now);
    if (dayNum >= 1 && dayNum <= d.getDate()) {
      return { type: 'relative', date: toDateStr(new Date(d.getFullYear(), d.getMonth(), dayNum).getTime()) };
    }
  }

  return null;
}

/** 本周指定星期几的日期（target: 0=周日, 1=周一...） */
function weekdayOf(now, target) {
  const d = new Date(startOfDay(now));
  const cur = d.getDay();
  let diff = target - cur;
  if (diff < 0) diff += 7;
  return toDateStr(d.getTime() + diff * 86400000);
}

/** 上周指定星期几的日期 */
function lastWeekdayOf(now, target) {
  const d = new Date(startOfDay(now));
  const cur = d.getDay();
  let diff = target - cur;
  if (diff >= 0) diff -= 7; // 保证严格早于本周
  return toDateStr(d.getTime() + diff * 86400000);
}

/**
 * 生成近 N 个月的账期列表（用于走势图）
 * @returns {['2026-05','2026-06',...] 从早到晚
 */
function recentMonths(n = 6, now = Date.now()) {
  const result = [];
  const d = new Date(now);
  for (let i = n - 1; i >= 0; i--) {
    const t = new Date(d.getFullYear(), d.getMonth() - i, 1);
    result.push(toMonthStr(t.getTime()));
  }
  return result;
}

/** 两个 YYYY-MM 之间的月份差 */
function monthDiff(fromMonth, toMonth) {
  const [fy, fm] = fromMonth.split('-').map(Number);
  const [ty, tm] = toMonth.split('-').map(Number);
  return (ty - fy) * 12 + (tm - fm);
}

module.exports = {
  startOfDay,
  toDateStr,
  toMonthStr,
  toMonthStrCST,
  toDateStrCST,
  getWeekday,
  getWeekdayCST,
  parseRelativeDate,
  weekdayOf,
  lastWeekdayOf,
  recentMonths,
  monthDiff
};