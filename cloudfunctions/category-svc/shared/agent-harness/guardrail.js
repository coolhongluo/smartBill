/**
 * 护栏 —— 技术文档 §3.8
 *
 * 护栏在每次 AI 调用的前后执行，是防止「LLM 一句话毁掉账本」的最后一道闸。
 * 每条护栏都对应一个真实的失败模式，不是形式主义。
 */

const { GUARDRAIL } = require('../util/constants');

/**
 * 隐私脱敏 —— 调用前
 * 语音文本里可能带出手机号、卡号等隐私，出网前必须掩码
 */
function desensitize(text) {
  if (!text) return { text, maskedCount: 0 };
  let masked = 0;
  let out = String(text);

  // 手机号（11 位）
  out = out.replace(/\b1[3-9]\d{9}\b/g, () => { masked++; return '***手机号***'; });
  // 身份证（18 位）
  out = out.replace(/\b\d{17}[\dXx]\b/g, () => { masked++; return '***身份证***'; });
  // 银行卡（16-19 位）
  out = out.replace(/\b\d{16,19}\b/g, () => { masked++; return '***卡号***'; });
  // 银行卡带空格分隔
  out = out.replace(/\b\d{4}[\s-]\d{4}[\s-]\d{4}[\s-]\d{4}\b/g, () => { masked++; return '***卡号***'; });

  return { text: out, maskedCount: masked };
}

/**
 * 成本熔断 —— 调用前
 * 单用户当日 Token 累计超预算后转规则，避免异常用户打爆成本
 */
function checkTokenBudget(usedTokens, dailyBudget) {
  if (!dailyBudget) return { allowed: true, reason: 'no_budget_set' };
  if (usedTokens >= dailyBudget) {
    return { allowed: false, reason: 'daily_token_budget_exceeded', usedTokens, dailyBudget };
  }
  return { allowed: true, usedTokens, dailyBudget };
}

/**
 * 数值校验 —— 调用后
 * 金额超出合理阈值时禁止自动入账，强制走用户确认。
 * 护栏的意图不是拦下错误，而是让错误必须经过人的确认。
 */
function validateAmountGuard(amountYuan) {
  if (amountYuan === null || amountYuan === undefined) {
    return { ok: false, requireConfirm: false, reason: 'amount_missing' };
  }
  if (amountYuan <= 0) {
    return { ok: false, requireConfirm: true, reason: 'amount_not_positive' };
  }
  if (amountYuan > GUARDRAIL.MAX_AMOUNT_YUAN) {
    return { ok: false, requireConfirm: true, reason: 'amount_exceeds_limit', limit: GUARDRAIL.MAX_AMOUNT_YUAN };
  }
  return { ok: true, requireConfirm: false };
}

/**
 * 禁改计算值 —— 调用后（最重要的一条护栏）
 *
 * LLM 归一化倾向：把「环比上涨 22%」写成 23%，把「650 元」凑成「700 元」。
 * 在财务场景这是不可容忍的 —— 用户看到的数字必须与账本一致。
 *
 * 做法：把 LLM 输出里出现的数字，与规则层算出的权威值逐一比对，
 *       不一致则弃用 LLM 叙述，退回规则模板句。
 *
 * @param {string} llmText LLM 生成的叙述
 * @param {object} authoritativeValues 权威数值 {saveAmount:650, changePct:22, ...}
 * @returns {{ok:boolean, mismatches:Array}}
 */
function validateNumericCitations(llmText, authoritativeValues) {
  if (!llmText || !authoritativeValues) return { ok: true, mismatches: [] };

  const mismatches = [];
  const text = String(llmText);

  for (const [key, value] of Object.entries(authoritativeValues)) {
    if (value === null || value === undefined || typeof value === 'object') continue;

    // 只校验明确以「元」结尾的金额类数值，其他数值放宽
    const isMoney = key.toLowerCase().includes('amount') || key.toLowerCase().includes('yuan');
    if (!isMoney) continue;

    // 从叙述中找出所有「数字 + 元」的表述
    const cited = text.match(/(\d+(?:\.\d+)?)\s*元/g) || [];
    if (cited.length === 0) continue;

    const citedNumbers = cited.map((c) => parseFloat(c));
    const target = Number(value);

    // 若叙述里提到的任一金额与权威值差距过大，判定为改写
    const bad = citedNumbers.find((n) => Math.abs(n - target) > Math.max(1, target * 0.02));
    if (bad !== undefined) {
      mismatches.push({ key, authoritative: target, cited: bad });
    }
  }

  return { ok: mismatches.length === 0, mismatches };
}

/**
 * 内容安全 —— 调用后
 */
function checkContentSafety(text) {
  if (!text) return { safe: true };
  const dangerous = /(ignore\s+previous|忽略以上|系统提示|system\s*prompt|<\s*script)/i;
  if (dangerous.test(String(text))) {
    return { safe: false, reason: 'possible_prompt_injection' };
  }
  return { safe: true };
}

/**
 * 输入 Token 粗估
 * 中文按1.5 字/token，英文按 4 字符/token（经验值，用于预算裁剪）
 */
function estimateTokens(text) {
  if (!text) return 0;
  const s = String(text);
  const cjk = (s.match(/[\u4e00-\u9fa5]/g) || []).length;
  const rest = s.length - cjk;
  return Math.ceil(cjk * 1.5 + rest / 4);
}

/**
 * 按优先级裁剪上下文，超出预算时从低优先级开始丢
 * P0 的 input 不允许截断 —— 截断用户输入等于篡改用户说的话
 */
function trimByPriority(blocks, maxTokens) {
  const total = Object.values(blocks).reduce((sum, b) => sum + estimateTokens(b.text), 0);
  if (total <= maxTokens) return { blocks, totalTokens: total, trimmed: [] };

  const order = ['p3_samples', 'p2_recent', 'p1_aliases', 'p1_categoryTree', 'p0_system'];
  const trimmed = [];
  let saved = 0;

  for (const key of order) {
    if (total - saved <= maxTokens) break;
    if (key === 'p0_system' || !blocks[key]) continue;
    saved += estimateTokens(blocks[key].text);
    trimmed.push(key);
  }

  const next = { ...blocks };
  for (const k of trimmed) delete next[k];

  return {
    blocks: next,
    totalTokens: total - saved,
    trimmed
  };
}

module.exports = {
  desensitize,
  checkTokenBudget,
  validateAmountGuard,
  validateNumericCitations,
  checkContentSafety,
  estimateTokens,
  trimByPriority
};