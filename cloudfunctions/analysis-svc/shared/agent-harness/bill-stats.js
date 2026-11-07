/**
 * 账单统计工具集 —— 技术文档 §9.4 C档的落地实现
 *
 * ##⚠️ 为什么必须用 tools，而不是把数字塞进 Prompt 让模型自己算
 *
 * 这是整个功能的地基，踩错方向后面全白做。三条硬理由：
 *
 * 1. **模型算数不可靠**。让 LLM「根据这些账单算一下餐饮占比」，
 *    它会给出一个看起来合理、实际错误的数字。用户看到「餐饮占 42%」
 *    却实际是 37%，比不给结论更糟——它摧毁的是用户对整个产品的信任。
 * 2. **Prompt 会炸**。把一个月上百笔账单塞进 Prompt，成本高且会超 token 预算。
 *    而「算一下占比」只需要模型调一次工具、拿一个结构化结果。
 * 3. **不可审计**。工具的每个数字都能追到是哪段代码算的，
 *    模型的自由文本不能。账目类产品必须能说清「这个数从哪来」。
 *
 * 因此本文件遵循一条铁律：
 *   **所有数值由这里算出，模型只负责把它组织成人话。**
 *   模型永远拿不到原始账单，只拿得到本文件加工后的结构化统计。
 *
 * ## 单位约定（最容易出错的地方）
 *   内部一律 **分**（整数），避免浮点累积误差。
 *   只有在面向模型/用户输出时才转成「元」，且转一次就够。
 *   所有函数入参和返回都明确标注单位，不靠猜。
 */

/** 金额分 → 人类可读（元），保留两位 */
function centToYuanStr(cent) {
  const n = Number(cent) || 0;
  return (n / 100).toFixed(2);
}

/**
 * 校验账单数组结构
 * 脏数据（amount 为字符串、date 缺失）会让后面所有统计静默算错，
 * 所以在入口处一次性挡掉，并明确告知调用方有多少条被丢弃。
 */
function normalizeBills(rawBills) {
  const ok = [];
  let dropped = 0;

  for (const b of Array.isArray(rawBills) ? rawBills : []) {
    if (!b) { dropped++; continue; }

    const amount = Number(b.amount);
    // amount 必须是有限正整数分。0 元与负数一律视为脏数据
    // （本应用只记支出，收入不入账；出现负数说明上游有问题）
    if (!isFinite(amount) || amount <= 0 || !Number.isInteger(amount)) { dropped++; continue; }

    const date = String(b.date || '');
    // 日期必须是 YYYY-MM-DD，否则无法按月/按天聚合
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { dropped++; continue; }

    ok.push({
      amount,
      date,
      month: date.slice(0, 7),
      day: date.slice(8, 10),
      categoryId: b.categoryId || '',
      categoryPath: String(b.categoryPath || ''),
      top: (String(b.categoryPath || '未分类').split('/')[0]) || '未分类',
      note: String(b.note || '')
    });
  }

  return { bills: ok, dropped };
}

/** 取一级类目名：无路径时归到「未分类」，与 db.categoryBreakdown 口径保持一致 */
function topOf(b) {
  return b.top || '未分类';
}

/* ══════════════════════════════════════════════════
 *  以下为各统计工具的实现
 * ══════════════════════════════════════════════════ */

/**
 * 分类占比 —— 按一级类目聚合，算出总额与各自占比
 * @returns {{totalCent:number, totalYuan:string, count:number, items:Array}}
 */
function calcCategoryShare(bills) {
  const map = new Map();
  let totalCent = 0;

  for (const b of bills) {
    const name = topOf(b);
    map.set(name, (map.get(name) || 0) + b.amount);
    totalCent += b.amount;
  }

  const items = [...map.entries()]
    .map(([name, value]) => ({
      name,
      valueCent: value,
      valueYuan: centToYuanStr(value),
      count: bills.filter((b) => topOf(b) === name).length,
      // 占比保留一位小数。模型若要说「过半」「占四成」够用了，
      // 给两位反而会让它编出「47.83% 是显著高于均值」这种过度解读
      percent: totalCent > 0 ? Math.round((value / totalCent) * 1000) / 10 : 0
    }))
    .sort((a, b2) => b2.valueCent - a.valueCent);

  return {
    totalCent,
    totalYuan: centToYuanStr(totalCent),
    count: bills.length,
    items
  };
}

/**
 * 环比 —— 本月 vs 上月
 *
 * 注意：这里同时返回 deltaRate（变化率）和 direction（方向），
 * 因为**方向判断也是代码的事**。让模型看两个数字说「涨了不少」
 * 属于让它做判断，它会说错（「下降 3%」也能被描述成「略有下降」，
 *  但 3% 的上升它可能说成「大幅上涨」）。
 */
function calcMonthOverMonth(curBills, prevBills) {
  const cur = curBills.reduce((s, b) => s + b.amount, 0);
  const prev = prevBills.reduce((s, b) => s + b.amount, 0);

  let deltaCent = 0;
  let deltaRate = 0;
  let direction = 'flat';

  if (prev > 0) {
    deltaCent = cur - prev;
    deltaRate = Math.round(((cur - prev) / prev) * 1000) / 10;
    if (deltaRate > 1) direction = 'up';
    else if (deltaRate < -1) direction = 'down';
    // ±1% 以内视为持平，避免「0.3% 的波动」被渲染成涨跌箭头
  }

  return {
    currentCent: cur,
    currentYuan: centToYuanStr(cur),
    previousCent: prev,
    previousYuan: centToYuanStr(prev),
    deltaCent,
    deltaYuan: centToYuanStr(Math.abs(deltaCent)),
    deltaRate,
    direction,
    // 上月为 0 时环比无意义（除零），显式标记而非让模型自行处理
    hasBaseline: prev > 0
  };
}

/**
 * 月度汇总 —— 日均、单笔最大、记账天数
 * 日均必须区分「有记录的天数」和「自然天数」：
 * 用户一周记 3 天账，算日均时用 3 天比用 7 天更能反映实际消费水平。
 */
function calcMonthlySummary(bills, month) {
  const totalCent = bills.reduce((s, b) => s + b.amount, 0);
  const distinctDays = new Set(bills.map((b) => b.date)).size;

  const sorted = [...bills].sort((a, b) => b.amount - a.amount);
  const max = sorted[0] || null;

  // 当月已过天数（用于「按自然日均摊」），不能拿整月 30 天去除
  const now = new Date();
  const [y, m] = String(month || '').split('-').map(Number);
  const isCurrentMonth = y === now.getFullYear() && m === now.getMonth() + 1;
  const elapsedDays = isCurrentMonth ? now.getDate() : new Date(y, m, 0).getDate();

  return {
    month: month || '',
    totalCent,
    totalYuan: centToYuanStr(totalCent),
    count: bills.length,
    recordedDays: distinctDays,
    // 有记账的天数：更贴近真实消费能力
    avgPerRecordedDayYuan: distinctDays > 0 ? centToYuanStr(Math.round(totalCent / distinctDays)) : '0.00',
    // 自然日均摊：含没记账的日子，用于「这个月整体超没超」
    avgPerCalendarDayYuan: elapsedDays > 0 ? centToYuanStr(Math.round(totalCent / elapsedDays)) : '0.00',
    maxBillCent: max ? max.amount : 0,
    maxBillYuan: max ? centToYuanStr(max.amount) : '0.00',
    maxBillPath: max ? max.categoryPath || '未分类' : '',
    maxBillDate: max ? max.date : ''
  };
}

/**
 * 近 N 个月趋势 —— 供分析页画趋势用
 * 缺失的月份补 0，否则折线会跳空，模型也会误以为「中间没花钱」
 */
function calcTrend(billsByMonth, monthCount = 6) {
  const months = [];
  const now = new Date();
  for (let i = monthCount - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }

  return months.map((mo) => {
    const list = billsByMonth[mo] || [];
    const total = list.reduce((s, b) => s + b.amount, 0);
    return {
      month: mo,
      totalCent: total,
      totalYuan: centToYuanStr(total),
      count: list.length
    };
  });
}

/**
 * Top N 高频类目 —— 用于「你最近主要花在xx上」
 * 同时给出单笔均值，因为「买了 12 次买菜」和「买了 2 次大额买菜」含义完全不同
 */
function calcTopCategories(bills, n = 3) {
  const share = calcCategoryShare(bills);
  return {
    items: share.items.slice(0, n).map((it) => ({
      ...it,
      avgPerBillYuan: it.count > 0 ? centToYuanStr(Math.round(it.valueCent / it.count)) : '0.00'
    }))
  };
}

/**
 * 餐饮结构 —— 在家吃饭 vs 外出就餐
 *
 * 这是本产品最核心的分类诉求（设计文档 §7.1），值得单独一个工具：
 * 它回答的是「省钱建议是否可执行」——
 * 如果外出就餐占比高，省钱建议就该是「减少外食」；
 * 如果在家吃饭占比高，同样的总支出下可优化空间在菜价与囤货。
 */
function calcDiningStructure(bills) {
  const DINING = '餐饮';
  const dine = bills.filter((b) => topOf(b) === DINING);
  if (!dine.length) {
    return { hasDining: false, homeCent: 0, awayCent: 0, homePercent: 0, awayPercent: 0 };
  }

  let home = 0;
  let away = 0;
  for (const b of dine) {
    const second = String(b.categoryPath || '').split('/')[1] || '';
    if (second === '在家吃饭') home += b.amount;
    else if (second === '外出就餐') away += b.amount;
    // 单位与集体、饮品与零食不计入这两类，避免污染口径
  }

  const total = home + away;
  return {
    hasDining: true,
    homeCent: home,
    homeYuan: centToYuanStr(home),
    awayCent: away,
    awayYuan: centToYuanStr(away),
    homePercent: total > 0 ? Math.round((home / total) * 1000) / 10 : 0,
    awayPercent: total > 0 ? Math.round((away / total) * 1000) / 10 : 0,
    totalCent: total
  };
}

/**
 * 周期性消费检测
 *
 * ## 为什么必须有这个
 *
 * 现状问题：「每周三火锅 200 元」被算成 3 笔独立消费，
 * 分析只能说「餐饮花了 600 元」，看不出这是**订阅式支出**。
 * 而周期性支出恰恰是最值得建议的——「每月 300 的会员，你看了几集？」
 * 和「你餐饮花超了」是完全不同的两类建议。
 *
 * ## 判定条件（缺一不可）
 *
 * 1. **同一末级类目** —— 不同类目不算周期
 * 2. **≥3 笔** —— 2 笔是巧合，3 笔才有统计意义
 * 3. **金额相近** —— 变异系数 ≤0.25 才算「固定支出」，
 *    否则是「同类波动」而非「周期」（如旅游住宿每次金额都不同）
 * 4. **间隔规整** —— 间隔中位数在周期窗口内，且变异系数 ≤0.4
 *
 * 第 3、4 条是刻意加严的：宁可漏检也不要误判。
 * 把「每次金额不同的消费」误判成周期，会得出「每月固定支出 800 元」
 * 这种完全错误的结论。
 *
 * @param {Array} bills 已清洗账单
 * @returns {{items:Array, count:number}}
 */
function calcRecurringPatterns(bills) {
  const MIN_OCCURRENCES = 3;
  // 间隔中位数的天数窗口
  const WEEKLY_MAX_DAYS = 10;
  const MONTHLY_MAX_DAYS = 40;
  // 变异系数容忍度
  const AMOUNT_CV_MAX = 0.25;
  const GAP_CV_MAX = 0.4;

  // 按「末级类目」分组（categoryPath 的最后一段）
  const groups = new Map();
  for (const b of bills || []) {
    const leaf = String(b.categoryPath || '').split('/').pop() || b.top || '未分类';
    if (!groups.has(leaf)) groups.set(leaf, []);
    groups.get(leaf).push(b);
  }

  const items = [];

  for (const [leaf, list] of groups) {
    if (list.length < MIN_OCCURRENCES) continue;

    // 按日期升序，算相邻间隔
    const sorted = [...list].sort((a, b) => (a.date < b.date ? -1 : 1));
    const gaps = [];
    for (let i = 1; i < sorted.length; i++) {
      const d1 = new Date(sorted[i - 1].date);
      const d2 = new Date(sorted[i].date);
      const days = Math.round((d2 - d1) / 86400000);
      if (days > 0) gaps.push(days);
    }
    if (gaps.length < MIN_OCCURRENCES - 1) continue;

    const gapMedian = median(gaps);
    const gapCv = cv(gaps);

    // 金额变异系数
    const amounts = sorted.map((b) => b.amount);
    const amountCv = cv(amounts);

    // 金额太散 → 不是固定支出，跳过
    if (amountCv > AMOUNT_CV_MAX) continue;
    // 间隔太乱 → 不是周期，跳过
    if (gapCv > GAP_CV_MAX) continue;

    let cycle = '';
    if (gapMedian <= WEEKLY_MAX_DAYS) cycle = 'weekly';
    else if (gapMedian <= MONTHLY_MAX_DAYS) cycle = 'monthly';
    if (!cycle) continue;

    const total = amounts.reduce((s, v) => s + v, 0);

    items.push({
      name: leaf,
      categoryPath: sorted[0].categoryPath,
      cycle,
      cycleLabel: cycle === 'weekly' ? '每周' : '每月',
      count: list.length,
      avgAmountYuan: centToYuanStr(Math.round(total / list.length)),
      totalYuan: centToYuanStr(total),
      avgGapDays: gapMedian,
      gapVariance: Math.round(gapCv * 100) / 100,
      amountVariance: Math.round(amountCv * 100) / 100,
      dates: sorted.map((b) => b.date),
      // 有备注的周期支出更可能是「订阅制决策」，值得单独说
      notes: sorted.map((b) => b.note).filter(Boolean)
    });
  }

  // 按总额降序：周期性支出里总额大的更值得关注
  items.sort((a, b) => parseFloat(b.totalYuan) - parseFloat(a.totalYuan));

  return { items, count: items.length };
}

/**
 * 取出带备注的账单
 *
 * ## 备注为什么重要
 *
 * 备注是判断「必要性」的唯一直接证据：
 *   「公司聚餐」vs「随便吃点」——同类目同金额，性质完全不同
 *   「孩子学费」vs「兴趣班」——一个刚性一个半刚性
 *
 * 但**不能把所有带备注的账单都丢给模型**：
 * 一个月 200 笔全塞进 Prompt 既超预算又会淹没重点。
 * 策略：按金额降序取前 N 笔，优先暴露「高价值 + 有备注」的组合。
 *
 * @param {Array} bills 已清洗账单
 * @param {number} limit 最多返回几笔
 */
function collectNotedBills(bills, limit = 20) {
  const noted = (bills || []).filter((b) => b.note && b.note.trim());
  const compressibility = require('../util/category-compressibility');

  return {
    total: noted.length,
    /** 有备注的笔数占比，模型据此判断「有多少信息可用」 */
    coveragePercent: bills && bills.length
      ? Math.round((noted.length / bills.length) * 1000) / 10
      : 0,
    items: noted
      .slice()
      .sort((a, b) => b.amount - a.amount)
      .slice(0, limit)
      .map((b) => ({
        amountYuan: centToYuanStr(b.amount),
        date: b.date,
        categoryPath: b.categoryPath,
        leaf: String(b.categoryPath || '').split('/').pop() || '',
        note: b.note,
        compressibility: compressibility.compressibilityOf(b.categoryId),
        compressibilityLabel: compressibility.LEVEL_LABEL[
          compressibility.compressibilityOf(b.categoryId)
        ]
      }))
  };
}

/**
 * 餐饮明细（替代原 calcDiningStructure 的粗粒度视角）
 *
 * 原结构只给「在家/外出各多少钱」，看不出**单笔大小**与**场合**。
 * 而这两点决定建议是否可行：
 *   3 笔 80 元的日常外卖（压缩空间小）
 *   1 笔 250 元的商务宴请（看必要性，不是「少吃点」）
 *
 * @param {Array} bills 已清洗账单
 */
function calcDiningDetail(bills) {
  const DINING = '餐饮';
  const dine = (bills || []).filter((b) => b.top === DINING);
  if (!dine.length) {
    return { hasDining: false, count: 0, home: null, away: null, items: [] };
  }



  let home = 0;
  let away = 0;
  const homeList = [];
  const awayList = [];

  for (const b of dine) {
    const second = String(b.categoryPath || '').split('/')[1] || '';
    const entry = {
      amountYuan: centToYuanStr(b.amount),
      date: b.date,
      leaf: String(b.categoryPath || '').split('/').pop() || '',
      note: b.note || ''
    };
    if (second === '在家吃饭') { home += b.amount; homeList.push(entry); }
    else if (second === '外出就餐') { away += b.amount; awayList.push(entry); }
  }

  const total = home + away;
  // 外出就餐逐笔明细，模型需要看到「是 1 笔大额还是 5 笔小额」
  const awaySorted = awayList.slice().sort((a, b) => parseFloat(b.amountYuan) - parseFloat(a.amountYuan));

  return {
    hasDining: true,
    count: dine.length,
    homeCent: home,
    homeYuan: centToYuanStr(home),
    awayCent: away,
    awayYuan: centToYuanStr(away),
    homePercent: total > 0 ? Math.round((home / total) * 1000) / 10 : 0,
    awayPercent: total > 0 ? Math.round((away / total) * 1000) / 10 : 0,
    totalCent: total,
    homeCount: homeList.length,
    awayCount: awayList.length,
    /** 外出就餐最大单笔——判断是「偶尔大额」还是「日常高频」的关键 */
    maxAwayBillYuan: awaySorted.length ? awaySorted[0].amountYuan : '0.00',
    awayBills: awaySorted
  };
}

/** 中位数 */
function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

/** 变异系数（标准差 / 均值）——衡量波动幅度，比极差更适合跨量级比较 */
function cv(arr) {
  if (!arr.length) return 0;
  const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
  if (mean === 0) return 0;
  const variance = arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length;
  return Math.sqrt(variance) / mean;
}

module.exports = {
  normalizeBills,
  centToYuanStr,
  calcCategoryShare,
  calcMonthOverMonth,
  calcMonthlySummary,
  calcTrend,
  calcTopCategories,
  calcDiningStructure,
  calcDiningDetail,
  calcRecurringPatterns,
  collectNotedBills
};