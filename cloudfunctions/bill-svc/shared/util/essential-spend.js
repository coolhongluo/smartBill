/**
 * 必需性消费判定
 *
 * ## 为什么需要它
 *
 * 「刚性」（房租、学费）和「可选」（买外套）之间还有第三类：
 * **必需但可优化**与**必需且不可动**。
 *
 * 具体问题：截图场景里「95号油」有备注、「同事聚餐」有备注，
 * 看起来都有信息，但这两笔都是**该花的**——
 * 通勤加油不省就没法上班，请客不省就没法做人。
 *
 * **备注只证明「有信息」，不证明「可压缩」。**
 * 混淆这两者，就会产出「建议少加点油」这种荒唐建议。
 *
 * ## 判定依据：末级类目名
 *
 * 必须精确到末级（加油 vs 旅游度假），因为同一一级类目下
 * 既有必需的也有可选的。用一级判定会误伤。
 */

const { ESSENTIAL_NOTE_WORDS, SOCIAL_NOTE_WORDS } = require('./note-keywords');

/**
 * 必需性末级类目名清单
 *
 * 收录标准：再穷也得花。省了会影响生活、违反合约或损害关系。
 */
const ESSENTIAL_LEAF_NAMES = new Set([
  // 交通：通勤必需
  '加油', '油费', '打车', '出租车', '地铁', '公交', '公共交通',
  '高铁', '火车票', '飞机票', '车票', '加油费',
  // 食品：基本生活
  '买菜', '肉蛋', '水产', '蔬菜', '水果', '粮油', '生鲜', '米面', '食品',
  // 居住基础
  '水电燃气', '电费', '水费', '燃气费', '取暖费', '物业费', '房租房贷',
  // 通讯基础
  '话费流量', '宽带',
  // 医疗
  '药费', '药品', '看病', '门诊挂号', '门诊', '住院',
  // 育儿必需
  '奶粉', '纸尿裤', '尿布',
  // 金融合约
  '保费', '保险保费', '贷款利息'
]);

/**
 * 判断一笔消费是否属于「必需且不可压缩」
 *
 * @param {object} bill 账单（需含 categoryPath）
 * @returns {boolean} true = 不该建议省
 */
function isEssentialSpend(bill) {
  if (!bill) return false;

  const path = String(bill.categoryPath || '');
  const leaf = path.split('/').pop() || '';

  // 末级类目命中即判定必需
  if (ESSENTIAL_LEAF_NAMES.has(leaf)) return true;

  // 备注里出现明显的必需语义也要拦住
  // （用户可能把买菜记在「其他」类目下）
  const note = String(bill.note || '');
  if (!note) return false;

  if (ESSENTIAL_NOTE_WORDS.some((w) => note.includes(w))) return true;

  /**
   * 社交与礼节性支出：不该建议省
   *
   * 「同事聚餐」「请客」「随礼」这类开销，
   * 金额确实可以少花，但建议用户少请客、少随礼是不合适的——
   * 它伤的是关系，不是理财。
   *
   * 这类支出的正确说法是「这笔是一次性事件，不用每月都花」，
   * 而不是「省 X 元」。
   */
  return SOCIAL_NOTE_WORDS.some((w) => note.includes(w));
}

module.exports = {
  ESSENTIAL_LEAF_NAMES,
  isEssentialSpend
};
