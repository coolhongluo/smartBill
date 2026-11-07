/**
 * 置信度融合 —— 技术文档 §3.7
 *
 * 这是全项目最关键的 30 行代码。它决定了一笔记账是自动入账、
 * 还是让用户确认、还是引导手动选类目。分档阈值固定不变（设计文档 §5.1），
 * 用户因此能建立稳定的心理模型：知道什么时候该信系统、什么时候该自己来。
 *
 * 融合四要素：
 *   模型最高候选分  —— LLM 对自己判断的把握
 *   规则一致性    —— 规则层与模型是否指向同一类目（最强信号）
 *   修复次数     —— 校验失败重试说明模型输出不稳定
 *   幻觉         —— 给出不存在的类目，直接归零
 */

const { CONFIDENCE } = require('../util/constants');

const W = {
  MODEL: 0.5,
  RULE: 0.3,
  REPAIR: 0.2
};

/**
 * 规则一致性系数
 * 一致 = 1.0（模型与规则指向同一类目，最可信）
 * 仅模型 = 0.4（模型独立判断，缺少规则印证）
 * 冲突 = 0（模型与规则矛盾，必须让用户确认）
 */
function ruleConsistency(ruleMatch) {
  if (ruleMatch === 1) return 1.0;   // 一致
  if (ruleMatch === -1) return 0;    // 冲突
  return 0.4;                         // 仅模型 / 无规则命中
}

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

/**
 * @param {object} params
 * @param {number} params.topScore        模型给出的最高候选分0~1
 * @param {number} params.ruleMatch       1=一致 / -1=冲突 / 0或undefined=仅模型
 * @param {number} params.repairCount     校验修复重试次数
 * @param {boolean} params.hasHallucination 模型是否给出不存在的类目
 * @returns {number} 0~1
 */
function fuseConfidence({ topScore, ruleMatch, repairCount = 0, hasHallucination = false }) {
  // 幻觉：模型编造了类目库中不存在的 ID。这类错误无法靠数值调和挽救，直接归零。
  if (hasHallucination) return 0;

  const s =
    W.MODEL * clamp(topScore || 0, 0, 1) +
    W.RULE * ruleConsistency(ruleMatch) -
    W.REPAIR * 0.2 * repairCount;

  return clamp(s, 0, 1);
}

/**
 * 分档 —— 界面行为的唯一依据（设计文档 §5.1）
 * @returns {'high'|'mid'|'low'}
 */
function tier(confidence) {
  if (confidence >= CONFIDENCE.HIGH) return 'high';
  if (confidence >= CONFIDENCE.MID) return 'mid';
  return 'low';
}

/**
 * 分档后的系统行为与界面表现
 * 直接返回给前端，避免前端各处硬编码阈值
 */
function decide(confidence, candidates = []) {
  const t = tier(confidence);
  switch (t) {
    case 'high':
      return {
        tier: t,
        action: 'AUTO_SAVE',
        status: 'saved',
        ui: '轻提示 + 5 秒撤销入口',
        candidates: candidates.slice(0, 1)
      };
    case 'mid':
      return {
        tier: t,
        action: 'ASK_CONFIRM',
        status: 'needConfirm',
        ui: '展示 Top3 候选，一键选择',
        candidates: candidates.slice(0, 3)
      };
    default:
      return {
        tier: t,
        action: 'GUIDE_CATEGORY',
        status: 'needCategory',
        ui: '引导手动选类目，入账后写入学习库',
        candidates: candidates.slice(0, 3)
      };
  }
}

/**
 * 判断模型候选与规则候选是否一致
 * @param {string} modelCategoryId 模型给出的类目
 * @param {string} ruleCategoryId 规则给出的类目
 * @returns {1|-1|0}
 */
function checkConsistency(modelCategoryId, ruleCategoryId) {
  if (!modelCategoryId || !ruleCategoryId) return 0;
  if (modelCategoryId === ruleCategoryId) return 1;
  // 同一条路径下的不同层级（如模型给「餐饮/在家吃饭/买菜」，规则给「买菜」）
  return 0;
}

module.exports = {
  fuseConfidence,
  tier,
  decide,
  checkConsistency,
  ruleConsistency
};