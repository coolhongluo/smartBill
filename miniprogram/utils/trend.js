/**
 * 趋势图视图模型
 *
 * ## 为什么需要这个文件
 *
 * 云函数返回的 trend 是**原始统计**：
 *   [{ month: '2026-10', totalCent: 12345, totalYuan: '123.45', count: 8 }, ...]
 *
 * 但 WXML 画柱子需要两个云端**从来没有返回过**的字段：
 *   item.height —— 柱子高度（相对最高月亮的百分比）
 *   item.label —— 月份标签（"10月"）
 *
 * 缺了它们，WXML 里的 `style="height:{{item.height}}%"` 会渲染成
 * `height:undefined%` —— 这条 CSS 声明无效被丢弃，
 * 柱子只剩 wxss 里的 `min-height: 4rpx`，
 * 于是整张「近半年趋势」看起来就是**空的**。
 * 这就是「趋势图没画出来」的真正原因：没有任何报错，只是图不见了。
 *
 * ## 为什么放在前端而不是云端补字段
 *
 * 1. 分析结果**已落库**在 users 集合，存的是旧结构。
 *    云端补字段也要等下一次分析（凌晨 0 点定时任务）才生效；
 *    前端补则**立刻对存量数据生效**，不需要重算、不需要部署。
 * 2. 柱子多高是**展示层**的事，云端不知道画布多高。
 * 3. `get_trend` 工具的输出直接进模型视野，塞 height/label 会污染模型读数
 *    （模型可能把 "66.7" 当成消费额，数字对账立刻失效）。
 *
 * ## 高度口径
 *
 * 相对**当月最大值**：最高的一根占满，其余按比例。
 *
 * 零消费月份的高度必须是**数字 0**（不是 "0.00"、不是 "0%"）——
 * wxss 里 `.trend-bar[style*="height:0%"]` 靠这个精确匹配来画基线。
 * 有消费但金额极小的月份给一个最小可见高度，
 * 否则四舍五入成 0 会被当成「没花钱」，那比柱子矮更误导。
 */

/** 最小可见高度（%）：金额不为 0 的月份至少要有这么高 */
const MIN_VISIBLE_PERCENT = 2;

/**
 * 原始 trend → 视图模型
 *
 * @param {Array} rawTrend 云函数返回的 trend 数组
 * @returns {Array<{month:string,label:string,totalYuan:string,count:number,height:number}>}
 */
function buildTrendView(rawTrend) {
  const list = Array.isArray(rawTrend) ? rawTrend : [];
  if (!list.length) return [];

  // 高度只依据整数分计算，不用 totalYuan 字符串 —— 避免浮点误差
  const cents = list.map(toCent);
  const maxCent = Math.max.apply(null, cents.concat([0]));

  const labels = buildLabels(list.map((t) => t.month));

  return list.map((t, i) => ({
    month: t.month || '',
    label: labels[i],
    totalYuan: t.totalYuan || '0.00',
    count: t.count || 0,
    height: barHeight(cents[i], maxCent)
  }));
}

/**
 * 取某个月的整数分
 *
 * 优先用 totalCent；旧数据可能只有 totalYuan 字符串，那就换算回来。
 * 拿不到就当 0 —— 宁可画成基线，也不要画出一个错误的柱子。
 */
function toCent(item) {
  if (!item) return 0;
  if (typeof item.totalCent === 'number' && isFinite(item.totalCent)) {
    return item.totalCent;
  }
  const yuan = parseFloat(item.totalYuan);
  return isFinite(yuan) ? Math.round(yuan * 100) : 0;
}

/**
 * 柱子高度（百分比，数字）
 *
 * @param {number} cent 该月消费（分）
 * @param {number} maxCent 当月最高消费（分）
 */
function barHeight(cent, maxCent) {
  if (!(cent > 0) || !(maxCent > 0)) return 0;
  const percent = (cent / maxCent) * 100;
  // 有消费但金额极小：给个最小可见高度，
  // 否则会被四舍五入成 0，视觉上等同于「这个月没花钱」
  return Math.max(MIN_VISIBLE_PERCENT, Math.round(percent * 10) / 10);
}

/**
 * 月份标签
 *
 * '2026-10' → '10月'
 * 跨年时（窗口里有上一年的月份）首列带上年份，避免「1月」是哪一年看不出来。
 */
function buildLabels(months) {
  const years = months.map((m) => String(m || '').slice(0, 4));
  const lastYear = years.length ? years[years.length - 1] : '';

  return months.map((m, i) => {
    const y = years[i];
    const mm = parseInt(String(m || '').slice(5, 7), 10);
    if (!mm) return String(m || '');

    const crossesYear = y && lastYear && y !== lastYear;
    return crossesYear ? `${y.slice(2)}年${mm}月` : `${mm}月`;
  });
}

module.exports = {
  buildTrendView,
  MIN_VISIBLE_PERCENT
};
