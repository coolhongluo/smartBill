/**
 * ASR 文本规则解析 —— 金额、账户、时间的确定性抽取
 *
 * 定位：这是 Harness 的规则兜底层，也是置信度融合的「基准」。
 * 技术文档 §9.4 A1 档说明：中文数字口语变体太多，规则无法全覆盖，
 * 所以规则层追求的不是 100% 覆盖，而是「高精度的可靠子集」——
 * 宁可漏给LLM，不要错在这里。
 *
 * 输出与 LLM 的 bill-parse 输出同构，便于置信度融合时逐字段比对。
 */

const { cnToNumber, yuanToCent, isReasonableAmount } = require('../util/money');
const { parseRelativeDate, toDateStr, startOfDay } = require('../util/date');
const { ACCOUNT_TYPE, TIME_TYPE } = require('../util/constants');

/** 金额模式：按优先级从高到低。倒序很重要，先匹配精确的再匹配模糊的 */
const AMOUNT_PATTERNS = [
  {
    // 数字 + 单位 + 角分：「3块5毛5」「32块8」「68块5」
    // 注意：必须排在 arabic_with_unit 之前，否则「68块5」会只取到 68
    name: 'arabic_cny_fen',
    re: /(\d+)\s*(?:块钱|块|元|圆)\s*(\d)\s*毛?\s*(?:(\d)\s*分?)?/,
    type: 'exact',
    build: (m) => Number(m[1]) + Number(m[2]) / 10 + (m[3] ? Number(m[3]) / 100 : 0),
    // 需确认「毛/分」语义：32块8 → 32.8，3块5毛5 → 3.55
    guard: (m, yuan) => m[3] || m[2] !== undefined
  },
  {
    // 阿拉伯数字 + 明确单位：380元 / 380块 / 380.5 元
    name: 'arabic_with_unit',
    re: /(\d+(?:\.\d{1,2})?)\s*(?:块钱|块|元|圆|rmb|￥)/i,
    type: 'exact'
  },
  {
    // 纯阿拉伯数字（无单位）：「100」「268.5」
    name: 'arabic_bare',
    re: /(?<![\d.])(\d+(?:\.\d{1,2})?)(?![\d.%])/,
    type: 'exact'
  },
  {
    // 中文数字 + 单位 + 角分：「三块五毛五」（末尾「分」可省略）
    name: 'chinese_cny_fen',
    re: /([零一二三四五六七八九十百千两]+)\s*块\s*([零一二三四五六七八九])\s*毛\s*(?:([零一二三四五六七八九])\s*分?)?/,
    type: 'exact',
    build: (m) => cnToNumber(m[1]) + cnDigit(m[2]) / 10 + (m[3] ? cnDigit(m[3]) / 100 : 0)
  },
  {
    // 中文数字 + 明确单位：「一百块」
    // 守卫：后面若跟「毛X」则让位给 chinese_cny_fen
    name: 'chinese_with_unit',
    re: /([零一二三四五六七八九十百千两]+)\s*(?:块钱|块|元|圆)/,
    type: 'exact',
    guard: (m, yuan, full, input) => !/^\s*[零一二三四五六七八九]\s*毛/.test(input.slice(input.search(m[0]) + m[0].length))
  },
  {
    // 中文数字无单位（口语）：「三百八十」「一百五」
    // 必须排在 vague 之前，但要用较长匹配避免截断
    name: 'chinese_bare',
    re: /[零一二三四五六七八九十百千两]{2,}(?!来|多|几|左|右)/,
    type: 'exact',
    build: (m) => cnToNumber(m[0])
  },
  {
    // 口语模糊：四十来块 / 三十多 / 一百左右
    name: 'vague',
    re: /([零一二三四五六七八九十百千两]+)\s*(来|多|几|左|右)/,
    type: 'vague'
  }
];

/** 中文小数字（0-9） */
const SMALL_CN = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
function cnDigit(ch) {
  return SMALL_CN[ch] !== undefined ? SMALL_CN[ch] : null;
}

const ACCOUNT_PATTERNS = [
  { re: /微信(?:付|支付|的钱)?|wechat|weixin/i, value: ACCOUNT_TYPE.WECHAT },
  { re: /支付宝|花呗|alipay/i, value: ACCOUNT_TYPE.ALIPAY },
  { re: /现金|现金付|找的零钱/i, value: ACCOUNT_TYPE.CASH },
  { re: /刷卡|信用卡|储蓄卡|银行卡|卡里/i, value: ACCOUNT_TYPE.CARD }
];

/** 场景/事由线索——帮助细分类目判定 */
const SCENE_PATTERNS = [
  { re: /同事|单位|工作餐|食堂|食堂饭/, scene: 'unit' },
  { re: /朋友|同学|闺蜜/, scene: 'friends' },
  { re: /孩子|儿子|女儿|宝宝/, scene: 'child' },
  { re: /老公|先生|爱人/, scene: 'spouse' },
  { re: /爸妈|父母|老人/, scene: 'elder' },
  { re: /请客|宴请|招待/, scene: 'treat' },
  { re: /生日|结婚|满月/, scene: 'celebration' },
  { re: /医院|看病|挂号|买药|大夫/, scene: 'medical' },
  { re: /旅游|旅游|景区|门票|旅行/, scene: 'travel' },
  { re: /学校|幼儿园|老师/, scene: 'school' }
];

/**
 * 抽取金额
 * @returns {{amountCent:number|null, certain:boolean, pattern:string}}
 */
function extractAmount(text) {
  if (!text) return { amountCent: null, certain: false, pattern: 'none' };

  for (const p of AMOUNT_PATTERNS) {
    const m = text.match(p.re);
    if (!m) continue;

    const yuan = p.build ? p.build(m) : (p.type === 'exact' ? Number(m[1]) : cnToNumber(m[1]));

    if (yuan === null || yuan === undefined || isNaN(yuan)) continue;
    // 模式自带语义守卫时不通过则继续尝试下一个模式
    if (p.guard && !p.guard(m, yuan, m[0], text)) continue;

    // 粗筛：明显不是金额的直接跳过（年份、日期、时长等）
    if (p.name === 'arabic_bare' && (yuan > 100000 || yuan < 0.01)) continue;
    // 中文裸数字的粗筛：单个「十」这类太小的片段不作为金额
    if (p.name === 'chinese_bare' && yuan < 0.01) continue;

    const cent = yuanToCent(yuan);
    if (!isReasonableAmount(cent)) continue;

    return {
      amountCent: cent,
      // 「四十来块」这类模糊表达，金额不确定，需要给候选
      certain: p.type === 'exact',
      pattern: p.name
    };
  }

  return { amountCent: null, certain: false, pattern: 'no_match' };
}

/** 抽取账户 */
function extractAccount(text) {
  if (!text) return ACCOUNT_TYPE.UNKNOWN;
  for (const p of ACCOUNT_PATTERNS) {
    if (p.re.test(text)) return p.value;
  }
  return ACCOUNT_TYPE.UNKNOWN;
}

/** 抽取时间 */
function extractTime(text, now = Date.now()) {
  const rel = parseRelativeDate(text, now);
  if (rel && rel.date) {
    const today = toDateStr(now);
    const yesterday = toDateStr(startOfDay(now) - 86400000);
    let type = TIME_TYPE.NONE;
    if (rel.date === today) type = TIME_TYPE.TODAY;
    else if (rel.date === yesterday) type = TIME_TYPE.YESTERDAY;
    else type = TIME_TYPE.SPECIFIC;
    return { type, date: rel.date };
  }
  return { type: TIME_TYPE.TODAY, date: toDateStr(now) };
}

/** 抽取场景线索 */
function extractScene(text) {
  if (!text) return [];
  const scenes = [];
  for (const p of SCENE_PATTERNS) {
    if (p.re.test(text)) scenes.push(p.scene);
  }
  return scenes;
}

/**
 * 检测「一句多说」：「买菜100，还有洗衣液39」
 * @returns {{count:number, parts:string[]}}
 */
function detectSplit(text) {
  if (!text) return { count: 1, parts: [] };
  const parts = text
    .split(/[，,。;；]|还有|然后|另外|以及/)
    .map((s) => s.trim())
    // 过滤掉纯连接词残留（如「还有」单独成段）
    .filter((s) => s.length > 0 && /\d|[零一二三四五六七八九十百]/.test(s));
  return parts.length >= 2 ? { count: parts.length, parts } : { count: 1, parts };
}

/**
 * 主入口：规则解析 ASR 文本
 * @returns 与 bill-parse LLM 输出同构的对象
 */
function parse(text, now = Date.now()) {
  const amount = extractAmount(text);
  const time = extractTime(text, now);
  return {
    amount: amount.amountCent !== null ? amount.amountCent / 100 : null,
    amountCertain: amount.certain,
    amountPattern: amount.pattern,
    timeType: time.type,
    date: time.date,
    account: extractAccount(text),
    scenes: extractScene(text),
    splitCount: detectSplit(text).count,
    splitParts: detectSplit(text).parts,
    source: 'rules'
  };
}

module.exports = {
  parse,
  extractAmount,
  extractAccount,
  extractTime,
  extractScene,
  detectSplit
};