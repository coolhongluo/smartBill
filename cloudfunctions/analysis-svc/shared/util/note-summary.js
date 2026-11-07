/**
 * 备注总结 —— 把用户口述整理成账单备注
 *
 * ## 规则（产品口径）
 *
 *   LLM 总结成功  → 备注 = 模型概括的一句话
 *   LLM 失败/不可用 → 备注 = **用户口述原文**（全文照搬，不做删减）
 *
 * 兜底为什么用原文而不是规则提炼：
 * 规则提炼必然丢信息（「昨天晚上跟同事在海底捞吃火锅庆祝她生日一共花了380」
 * 会被削成「同事吃火锅生日」），而兜底路径本来就意味着「模型没帮上忙」，
 * 此时**信息完整比简洁更重要**——用户至少能在明细里看到自己到底说了什么。
 *
 * ## 两条护栏
 *
 * 1. **备注不含金额**（LLM 路径）
 *    金额是独立字段（amount），备注里再写一遍就成了同屏两个数字，
 *    且改金额后备注里的旧金额会变成错的。模型偶尔会不听话，所以代码再剥一次。
 *
 * 2. **关键词不能丢**（LLM 路径）
 *    刚性/必需/社交关键词是下游判断「这笔钱该不该省」的唯一直接证据
 *    （category-compressibility.isRigidBill、essential-spend.isEssentialSpend）。
 *    模型把「孩子学费3200」总结成「教育支出」，刚性判定立刻失效，
 *    分析页就会建议「学费可以省 30%」——这类错误的严重性远高于数字偏差。
 *
 *    所以一旦发现关键词丢失，**直接退回原文**，不拼接、不折中。
 *    这与「模型可以改写，但不能改判」是同一条原则。
 */

const {
  RIGID_NOTE_KEYWORDS,
  ESSENTIAL_NOTE_WORDS,
  SOCIAL_NOTE_WORDS
} = require('./note-keywords');

/** LLM 总结的备注长度上限（一行短句，与手动输入框一致） */
const MAX_NOTE_LENGTH = 30;

/**
 * 原文兜底的长度上限
 *
 * 200 是硬约束：明细页的备注编辑框 maxlength=200，
 * 云端 amend 也拒绝超过 200 字的备注。
 * 超了就改不动了，所以写入前必须先裁。
 */
const MAX_FALLBACK_LENGTH = 200;

/**
 * 全部判定关键词（刚性 + 必需 + 社交）
 *
 * 长关键词排在前面：'孩子学费' 命中时就不该再单独要求命中 '学费'
 */
const ALL_KEYWORDS = Array.from(new Set([
  ...RIGID_NOTE_KEYWORDS,
  ...ESSENTIAL_NOTE_WORDS,
  ...SOCIAL_NOTE_WORDS
])).sort((a, b) => b.length - a.length);

/**
 * 剥掉备注里的金额表达
 *
 * ⚠ 只剥「明确带货币单位」的部分：
 *   · 数字 + 元/块/钱（三块五毛五、380元）
 *   · 中文数字 + 元/块/钱（一百块）
 *
 * **不带单位的裸数字不动**：「38度」「3斤」里的数字不是金额，
 * 剥掉只会把句子改坏。
 */
function stripAmounts(text) {
  let t = String(text || '');
  t = t.replace(/\d+(?:\.\d+)?\s*(?:块钱|块|元|圆|毛|分|钱)/g, '');
  t = t.replace(/[零一二三四五六七八九十百千两]+\s*(?:块钱|块|元|圆|毛|分|钱)/g, '');
  return t;
}

/**
 * 找出文本命中的关键词
 *
 * ## 为什么还要「去子串」
 *
 * '学费' 是 '孩子学费' 的子串。一条备注写着「孩子学费」时，
 * 刚性关键词表里两个都会命中——但它们表达的是同一件事。
 * 若不去重，判定「关键词是否丢失」时会误判成丢了 '学费'，
 * 于是一份本来没问题的总结被无谓地打回原文。
 *
 * @param {string} text
 * @param {string[]} list 关键词表
 * @returns {string[]} 命中的关键词（已剔除被更长命中项包含的短词）
 */
function keywordsIn(text, list) {
  const t = String(text || '');
  const found = (list || []).filter((k) => t.includes(k));
  return found.filter((k) => !found.some((other) => other !== k && other.includes(k)));
}

/**
 * 清洗模型给的摘要
 *
 * - 去掉引号包裹
 * - 剥掉金额
 * - 「无」「暂无」这类占位一律视为「模型没给」
 */
function cleanLlmNote(note) {
  let s = String(note === null || note === undefined ? '' : note).trim();
  if (!s) return '';
  s = s.replace(/^["'“”「『]+|["'“”「』]+$/g, '').trim();
  if (!s) return '';
  if (/^(无|没有|暂无|不详|none|null|n\/a|-)$/i.test(s)) return '';
  s = stripAmounts(s);
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/**
 * 裁剪到指定长度，并去掉尾部残留的标点/空白
 */
function fit(text, max) {
  let s = String(text || '');
  if (s.length <= max) return s;
  s = s.slice(0, max);
  s = s.replace(/[\s，、。·！？!?,，]+$/g, '');
  return s;
}

/**
 * 判断总结是否丢了原文里的关键词
 *
 * @param {string} summary 模型总结
 * @param {string} asrText 用户原话
 * @returns {string[]} 丢失的关键词（空数组 = 没丢）
 */
function lostKeywords(summary, asrText) {
  const srcKw = keywordsIn(String(asrText || ''), ALL_KEYWORDS);
  const sumKw = keywordsIn(String(summary || ''), ALL_KEYWORDS);
  return srcKw.filter((k) => !sumKw.some((f) => f.includes(k) || k.includes(f)));
}

/**
 * 生成最终备注
 *
 * ## 三条路径
 *
 *   ① LLM 总结可用且没丢关键词 → 用总结（≤30 字）
 *   ② LLM 总结可用但丢了关键词 → 用**原话全文**（≤200 字）
 *   ③ LLM 不可用/没给摘要   → 用**原话全文**（≤200 字）
 *
 * ②③ 之所以用原文而不是拼接关键词：
 * 拼接出来的东西（「教育支出·学费」）是机器拼的，读起来像故障；
 * 而原文本来就是用户自己说的话，最自然也最完整。
 *
 * ## ⚠️ 原文里带着金额，这是有意为之
 *
 * 需求明确要求「模型失败时把用户语音输入内容全部设置为备注」，
 * 所以兜底路径下备注里会有金额（如「买菜100」）。
 * 这与「备注不含金额」的原则冲突，但取舍很明确：
 *   · 兜底意味着「模型没帮上忙」，此时**信息完整优先于格式规整**
 *   · 用户在明细里看到「买菜100」，比看到空白备注更有用
 *   · 且明细页的金额是独立字段（bill.amount），不会算错
 *
 * 金额字段与备注里的文字不参与任何计算，不会对账出错。
 *
 * @param {object} params
 * @param {string} params.asrText 用户原始口述（兜底来源 + 关键词来源）
 * @param {string} [params.llmNote] LLM 给出的摘要（主路径）
 * @returns {string} 备注
 */
function buildNote({ asrText, llmNote }) {
  const raw = String(asrText || '').trim();
  const summary = cleanLlmNote(llmNote);

  // 模型没给出可用摘要 → 原文兜底
  if (!summary) return fit(raw, MAX_FALLBACK_LENGTH);

  // 摘要丢了关键词 → 原文兜底（宁可啰嗦，不可改判）
  if (lostKeywords(summary, asrText).length) {
    return fit(raw, MAX_FALLBACK_LENGTH);
  }

  // 正常路径：用模型总结
  return fit(summary, MAX_NOTE_LENGTH);
}

module.exports = {
  MAX_NOTE_LENGTH,
  MAX_FALLBACK_LENGTH,
  ALL_KEYWORDS,
  cleanLlmNote,
  keywordsIn,
  lostKeywords,
  buildNote
};
