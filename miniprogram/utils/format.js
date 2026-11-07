/** 金额展示工具 —— 统一口径，避免各页面自行 toFixed 产生不一致 */

/**
 * 金额格式化
 * @param {number} yuan
 * @param {boolean} withSymbol
 */
function formatMoney(yuan, withSymbol = true) {
  if (yuan === null || yuan === undefined || isNaN(yuan)) return withSymbol ? '¥0.00' : '0.00';
  const fixed = Number(yuan).toFixed(2);
  // 整数金额不显示小数（家庭记账里「买菜100」比「¥100.00」更自然）
  const trimmed = fixed.endsWith('.00') ? fixed.slice(0, -3) : fixed;
  return withSymbol ? `¥${trimmed}` : trimmed;
}

/** 整数分转展示金额 */
function formatCent(cents, withSymbol = true) {
  return formatMoney((Number(cents) || 0) / 100, withSymbol);
}

/** 今天 YYYY-MM-DD */
function today() {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/** YYYY-MM */
function currentMonth() {
  return today().slice(0, 7);
}

/** 月份平移：shiftMonth('2026-01', -1) → '2025-12'（跨年正确） */
function shiftMonth(month, delta) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** 友好日期：今天 / 昨天 / 10-15 */
function friendlyDate(dateStr) {
  if (!dateStr) return '';
  const t = today();
  if (dateStr === t) return '今天';
  const y = new Date();
  y.setDate(y.getDate() - 1);
  const ymd = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, '0')}-${String(y.getDate()).padStart(2, '0')}`;
  if (dateStr === ymd) return '昨天';
  return dateStr.slice(5);
}

/**
 * 整数分 → 可编辑的「元」字符串
 *
 * ## ⚠️ 入参必须是「整数分」，不能是展示用的格式化字符串
 *
 * 踩过的坑：明细页 groupByDate 里同时存了
 *   · `amount`     = formatCent(b.amount) → "¥120.00"（**展示用字符串**）
 *   · `amountCent` = b.amount             → 12000（**原始分**）
 * 回填时传了 `bill.amount`，
 * 于是 `Number("¥120.00")` = NaN → 被 `|| 0` 兜成 0
 * → 打开编辑面板金额显示 0，直接点保存还会报「请输入有效金额」。
 *
 * 教训：**同一份数据存在两个字段上时，名字必须说清单位**。
 * 拿展示字符串当数值用，是最难自查的一类错。
 *
 * 保留两位小数：金额天生两位小数，"120.5" 会让人怀疑是不是丢了精度。
 *
 * @param {number} cent 整数分
 * @returns {string} 形如 "120.00"
 */
function yuanInput(cent) {
  return ((Number(cent) || 0) / 100).toFixed(2);
}

/**
 * 「元」字符串 → 整数分
 *
 * ## 为什么不用 parseFloat(str) * 100
 *
 * 浮点误差：8.115 * 100 = 811.4999999999999 → Math.round → 811，
 * 而正确答案是 812。**少一分钱**，且用户完全看不出错在哪。
 *
 * 改成按字符串逐位解析：整数部分 ×100 + 小数前两位 + 第三位四舍五入。
 * 全程整数运算，没有浮点。
 *
 * @param {string} input 形如 "120.00" / "120" / "8.115"
 * @returns {number|null} 整数分；格式非法返回 null
 */
function yuanToCent(input) {
  const s = String(input === null || input === undefined ? '' : input).trim();
  if (!s) return null;

  // 只接受纯数字 + 最多一个小数点（前面的输入过滤已挡掉其他字符，这里再兜一层）
  const m = /^(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m) return null;

  const intPart = m[1] || '';
  const decPart = m[2] || '';
  // "." 这种只有一个符号的输入没有意义
  if (!intPart && !decPart) return null;

  const d1 = decPart[0] ? parseInt(decPart[0], 10) : 0;
  const d2 = decPart[1] ? parseInt(decPart[1], 10) : 0;
  const d3 = decPart[2] ? parseInt(decPart[2], 10) : 0;

  const base = (parseInt(intPart || '0', 10) || 0) * 100;
  let cent = base + d1 * 10 + d2;
  // 第三位小数起四舍五入（0.005 元 → 1 分）
  if (d3 >= 5) cent += 1;

  if (!Number.isFinite(cent)) return null;
  return cent;
}

/**
 * 涨跌配色 —— 遵循 A 股惯例：涨=红、跌=绿
 * ⚠ 注意：这只用于「支出环比」这类指标，绝不能用于分类配色，
 * 否则用户会把「某类目变红」误读为「超支预警」。
 */
function trendColor(delta) {
  if (delta > 0) return '#D94F4F';
  if (delta < 0) return '#3D9970';
  return '#A8A29E';
}

module.exports = {
  formatMoney, formatCent, today, currentMonth, shiftMonth, friendlyDate,
  trendColor, yuanInput, yuanToCent
};