/**
 * 备注关键词表 —— 判断「这笔钱该不该省」的唯一关键词来源
 *
 * ## 为什么要集中到一个文件
 *
 * 同一批关键词过去散落在三个地方：
 *   · category-compressibility.js 的 isRigidBill 里（局部常量）
 *   · essential-spend.js 的 isEssentialSpend 里（两个局部常量）
 *   · 备注总结逻辑里（判断摘要有没有把关键词丢掉）
 *
 * 分散的必然结果是「改了一处、另一处没改」：
 * 备注一旦改成 LLM 摘要，最容易出的事故就是
 * 「学费」被总结成「教育支出」→ 刚性判定失效 →
 * 分析页建议「学费可以省 30%」——这正是本项目踩过的最严重事故。
 *
 * 所以这里做**单一数据源**：三个消费方都从这里取，
 * 关键词增删只改这一个文件。
 */

/**
 * 刚性关键词 —— 命中即视为刚性支出，禁止出现在任何节省建议里
 *
 * 判定按**备注原文**，因为用户的手动记账经常选错类目，
 * 类目不该是唯一依据（见 category-compressibility.isRigidBill）。
 */
const RIGID_NOTE_KEYWORDS = [
  '学费', '房租', '房贷', '保费', '利息', '物业费',
  '奶粉', '尿布', '药', '看病', '住院', '保险', '宽带', '税'
];

/**
 * 必需性关键词 —— 命中即视为「必需且不可压缩」
 *
 * 注意：社交支出（聚餐、请客、随礼）也算必需，
 * 省它伤的是关系不是钱，所以另列一档。
 */
const ESSENTIAL_NOTE_WORDS = [
  '通勤', '上班', '上班车费', '必需', '必须', '刚需',
  '孩子学费', '房租', '水电', '油费', '加油'
];

/**
 * 社交与礼节性支出关键词
 *
 * 这类开销金额确实可以少花，但建议用户少请客、少随礼是不合适的。
 */
const SOCIAL_NOTE_WORDS = [
  '聚餐', '请客', '随礼', '份子钱', '红包',
  '聚会', '生日', '满月', '婚礼', '乔迁', '看望', '人情'
];

/**
 * 规则层场景标签 → 中文短语
 *
 * asr-parse 抽出的 scene 是英文代码（unit/friends/child…），
 * 直接当备注写进账单，用户看到的是「friends」——不可接受。
 * 这里给出中文映射，供规则兜底用。
 */
const SCENE_LABELS = {
  unit: '单位聚餐',
  friends: '朋友聚会',
  child: '孩子相关',
  spouse: '配偶相关',
  elder: '老人相关',
  treat: '请客',
  celebration: '庆祝',
  medical: '看病',
  travel: '旅游',
  school: '学校相关'
};

module.exports = {
  RIGID_NOTE_KEYWORDS,
  ESSENTIAL_NOTE_WORDS,
  SOCIAL_NOTE_WORDS,
  SCENE_LABELS
};
