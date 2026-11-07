/**
 * 金额处理 —— 全项目唯一金额出入口
 *
 * 铁律：账目金额一律用「整数分」存储和传输，展示时才转元。
 * 原因：浮点数存钱必然有精度问题（0.1 + 0.2 !== 0.3），
 *      记账涉及资金，累计误差会让月度对账失真。
 */

/** 元 → 分（四舍五入到分） */
function yuanToCent(yuan) {
  if (typeof yuan !== 'number' || !isFinite(yuan)) return null;
  return Math.round(yuan * 100);
}

/** 分 → 元 */
function centToYuan(cent) {
  if (typeof cent !== 'number' || !isFinite(cent)) return null;
  return cent / 100;
}

/** 分 → 展示字符串（38000 → "380.00"，38050→ "380.50"） */
function formatCent(cent) {
  if (cent === null || cent === undefined) return '0.00';
  const negative = cent < 0;
  const abs = Math.abs(Math.round(cent));
  const yuan = Math.floor(abs / 100);
  const fen = abs % 100;
  return `${negative ? '-' : ''}${yuan}.${String(fen).padStart(2, '0')}`;
}

/**
 * 中文数字转阿拉伯数字（用于「三百八十」这类表达）
 * 支持：零一二三四五六七八九十百千万 两
 */
const CN_DIGIT = {
  零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4,
  五: 5, 六: 6, 七: 7, 八: 8, 九: 9
};
const CN_UNIT = { 十: 10, 百: 100, 千: 1000, 万: 10000 };

/**
 * @param {string} text 仅含中文数字，如「三百八十」「一千二」「十」
 * @returns {number|null}
 *
 * 口语省略规则（中文数字常见）：
 *   「十二」   → 12   （「一」省略）
 *   「千二」   → 1200 （末尾裸数字继承前一个单位：2 × 千 ÷ 10）
 *   「百五」   → 150
 *   「一千二」 → 1200
 */
function cnToNumber(text) {
  if (!text) return null;
  let total = 0;        // 已结算部分（万以上）
  let section = 0;      // 当前段
  let current = 0;      // 当前数字
  let lastUnit = 0;     // 最近一次使用的单位（用于末尾裸数字推断）
  let seen = false;

  for (const ch of text) {
    if (ch in CN_DIGIT) {
      current = CN_DIGIT[ch];
      seen = true;
    } else if (ch in CN_UNIT) {
      const unit = CN_UNIT[ch];
      seen = true;
      if (unit === 10000) {
        section = (section + current) * unit;
        total += section;
        section = 0;
      } else {
        // 「十二」这类省略了「一」的写法
        if (current === 0) current = 1;
        section += current * unit;
        lastUnit = unit;
      }
      current = 0;
    } else {
      return null; // 含非法字符
    }
  }

  if (!seen) return null;

  // 末尾裸数字且前面已有单位 → 按口语习惯推断
  // 例：「千二」 section=1000, lastUnit=1000, current=2 → 1000 + 2*(1000/10) = 1200
  if (current > 0 && lastUnit >= 10) {
    section += current * (lastUnit / 10);
  } else {
    section += current;
  }

  return total + section;
}

/**
 * 校验金额是否落在合理区间
 * 上限 50000 元：日消费超过此值极可能是识别错误或单位理解错误
 */
function isReasonableAmount(cent) {
  return typeof cent === 'number' && cent > 0 && cent <= 50000 * 100;
}

/**
 * 找出两个金额的偏离度（用于「LLM 抽取 vs 规则解析」的一致性校验）
 * @returns {number} 0 表示完全一致，>0.5 表示差异过半
 */
function deviation(centA, centB) {
  if (!centA || !centB) return 1;
  const max = Math.max(Math.abs(centA), Math.abs(centB));
  return Math.abs(centA - centB) / max;
}

module.exports = {
  yuanToCent,
  centToYuan,
  formatCent,
  cnToNumber,
  isReasonableAmount,
  deviation
};