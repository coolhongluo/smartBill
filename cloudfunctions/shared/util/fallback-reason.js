/**
 * 降级原因翻译
 *
 * ## 为什么需要这一层
 *
 * 界面原本只显示「当前为规则版分析」——用户看到的是一个**现象**，
 * 不知道**原因**，也不知道该做什么。
 *
 * 而降级有 12 种触发原因，性质完全不同：
 *   · NO_API_KEY        → 没配 Key，配上就好
 *   · TIMEOUT           → 网络或模型慢，重试可能好
 *   · NUMERIC_MISMATCH  → 模型引用了工具没给的数字，是我们的护栏在工作
 *   · RIGID_CATEGORY_SUGGESTED → 模型建议了刚性支出，护栏拦下了
 *
 * 最后两种其实是**护栏正常工作的证明**，不是故障。
 * 把它们和「没配 Key」混为一谈，用户会以为系统坏了。
 *
 * 所以这里不只是翻译，还要**区分「故障」与「保护」**。
 */

/**
 * 各降级原因对应的说明
 *
 * level:
 *   'config'  → 用户或运维能直接解决（配置问题）
 *   'retry'   → 临时故障，重试可能好
 *   'guard'   → 护栏正常工作，不是故障
 *   'unknown' → 未预期的错误
 */
const REASONS = {
  NO_API_KEY: {
    level: 'config',
    text: '未配置 API Key',
    hint: '在云开发控制台 → 云函数 → analysis-svc → 配置 → 环境变量中添加 DEEPSEEK_API_KEY，然后重新部署'
  },
  MOCK_MODE: {
    level: 'config',
    text: '未配置 API Key',
    hint: '在云开发控制台 → 云函数 → analysis-svc → 配置 → 环境变量中添加 DEEPSEEK_API_KEY，然后重新部署'
  },
  GLOBAL_LLM_DISABLED: {
    level: 'config',
    text: 'LLM 已被关闭',
    hint: '环境变量 LLM_ENABLED 被设为 false。改回 true 后重新部署即可'
  },
  TOKEN_BUDGET_EXCEEDED: {
    level: 'retry',
    text: '模型输出超出长度限制',
    hint: '本月记账较多导致结论过长。可减少记账笔数后重新分析，或等待下次定时任务'
  },
  TOOL_LOOP_ERROR: {
    level: 'retry',
    text: '模型调用工具时出错',
    hint: '通常是网络波动或模型服务暂时不可用，重新分析即可'
  },
  LLM_UNAVAILABLE: {
    level: 'retry',
    text: '模型服务不可用',
    hint: '可能是网络超时或 API Key 无效。可重新分析；若持续失败请检查 Key 是否正确'
  },
  GUARDRAIL_CONTENT_SAFETY: {
    level: 'guard',
    text: '结论包含不合适的内容，已自动过滤',
    hint: '这是内容安全机制在工作，不是故障'
  },
  VALIDATION_FAILED: {
    level: 'retry',
    text: '模型返回格式不符合要求',
    hint: '重新分析通常能解决'
  },
  NUMERIC_CITATION_MISMATCH: {
    level: 'guard',
    text: '结论中的数字未能全部核对上',
    hint: '这是数值校验机制在工作——宁可不给结论，也不给错数字。重新分析可能得到不同结果'
  },
  NO_TOOL_GROUNDING: {
    level: 'guard',
    text: '结论未能建立在实际数据上',
    hint: '这是「没有工具支撑就不下结论」机制在工作——模型没有取到对应的数据，所以不给结论。重新分析通常能解决'
  },
  RIGID_CATEGORY_SUGGESTED: {
    level: 'guard',
    text: '模型建议了刚性支出（如学费、房租），已被拦截',
    hint: '这是刚性支出保护机制在工作——这些钱省不得，不该给建议'
  },
  INVOKE_FAILED: {
    level: 'retry',
    text: '分析调用失败',
    hint: '重新分析即可'
  },
  EXCEPTION: {
    level: 'unknown',
    text: '分析过程出现异常',
    hint: '请到云开发控制台 → 云函数 → analysis-svc → 日志 查看详情'
  }
};

/**
 * 把降级码翻译成可读信息
 *
 * @param {string} reason 降级原因码
 * @returns {{level:string, text:string, hint:string}}
 */
function explainFallback(reason) {
  const r = REASONS[reason];
  if (r) return { level: r.level, text: r.text, hint: r.hint };

  // 未知原因也要给可读文案，不能把原始码丢给用户
  return {
    level: 'unknown',
    text: '已自动切换为规则版分析',
    hint: reason
      ? `原因代码：${reason}`
      : ''
  };
}

/**
 * 汇总成一句话，用于卡片上的小字说明
 */
function fallbackSummary(reason) {
  const e = explainFallback(reason);
  if (e.level === 'guard') {
    // 护栏正常工作不该让用户以为坏了
    return `规则版分析 · ${e.text}`;
  }
  return `规则版分析 · ${e.text}`;
}

module.exports = {
  REASONS,
  explainFallback,
  fallbackSummary
};
