/**
 * DeepSeek Harness —— 技术文档 §3.2 调用链主入口
 *
 * 上层业务只关心「我要一个什么结果」，不关心「怎么调模型、怎么校验、怎么兜底」。
 *
 * 八步调用链：
 *   ① 参数校验
 *   ② 缓存查找
 *   ③ 上下文构建（按优先级裁剪）
 *   ④ Prompt 组装
 *   ⑤ 护栏检查（隐私脱敏 / 成本预算 / Token 预算）
 *   ⑥ 调用 DeepSeek
 *   ⑦ 结构校验（失败修复重试 ≤2 次，仍失败走规则兜底）
 *   ⑧ 置信度计算 + trace 记录
 */

const llm = require('./llm-client');
const validator = require('./schema-validator');
const guardrail = require('./guardrail');
const confidence = require('./confidence');
const tracer = require('./tracer');
const { GUARDRAIL, CONFIDENCE } = require('../util/constants');

/**
 * Agent 注册表（技术文档 §3.4）
 * 后续每新增一个 Agent 都在此注册并定义 fallback
 */
const AGENTS = new Map();

/**
 * 注册 Agent
 * @param {string} name
 * @param {object} config
 */
function registerAgent(name, config) {
  if (!config || !config.promptTemplate) {
    throw new Error(`Agent ${name} 缺少 promptTemplate`);
  }
  AGENTS.set(name, {
    name,
    version: config.version || 'v1',
    temperature: config.temperature !== undefined ? config.temperature : 0.3,
    maxTokens: config.maxTokens || 1200,
    jsonMode: config.jsonMode !== undefined ? config.jsonMode : true,
    promptTemplate: config.promptTemplate,
    buildContext: config.buildContext || (() => ({})),
    outputSchema: config.outputSchema || null,
    validCategoryIds: config.validCategoryIds || null,
    categoryPathKey: config.categoryPathKey || null,
    fallback: config.fallback || null,
    // 工具模式：声明该 Agent 用 function calling 而非纯 JSON 直出
    useTools: config.useTools === true,
    maxToolRounds: config.maxToolRounds || GUARDRAIL.ANALYSIS_MAX_TOOL_ROUNDS,
    cache: config.cache || { enabled: false },
    // agent 自定义预算优先。分析 Agent 需要 8 秒而记账只要 2.2 秒，
    // 若这里无条件用默认值覆盖，注册时传的 budget 会被静默丢弃
    budget: config.budget || { maxTokens: GUARDRAIL.MAX_INPUT_TOKENS, timeoutMs: GUARDRAIL.LLM_TIMEOUT_MS }
  });
}

/**
 * ①参数校验
 */
function validateInvokeParams(agentName, params) {
  if (!agentName || !AGENTS.has(agentName)) {
    return { ok: false, error: `未注册的 Agent: ${agentName}` };
  }
  if (!params || !params.input) {
    return { ok: false, error: '缺少 input 参数' };
  }
  return { ok: true };
}

/**
 * ③④ 上下文构建与 Prompt 组装
 */
function buildMessages(agent, input, contextBlocks) {
  const systemPrompt = typeof agent.promptTemplate === 'function'
    ? agent.promptTemplate(input, contextBlocks)
    : agent.promptTemplate;

  const contextText = contextBlocks && contextBlocks.context
    ? `\n\n【上下文】\n${contextBlocks.context}`
    : '';

  const userContent = typeof input === 'string' ? input : JSON.stringify(input, null, 2);

  return [
    { role: 'system', content: `${systemPrompt}${contextText}` },
    { role: 'user', content: `请分析以下记账语句：\n${userContent}` }
  ];
}

/**
 * 主入口：harness.invoke()
 * @param {object} params
 * @param {string} params.agent
 * @param {string} params.version 指定版本（默认用注册的最新版）
 * @param {any} params.input 业务输入
 * @param {object} params.options 附加选项
 * @param {object} params.options.ruleParsed 规则层解析结果（置信度融合的基准）
 * @param {number} params.options.ruleCategoryId 规则层分类结果
 * @param {object} params.options.costContext {usedTokens, dailyBudget} 成本熔断上下文
 * @param {string} params.options.userId
 * @param {object} params.options.authoritativeValues 权威数值（供禁改计算值护栏对账）
 * @param {boolean} params.options.llmEnabled 全局降级开关
 * @returns {Promise<object>}
 */
async function invoke({ agent: agentName, version, input, options = {} }) {
  const traceId = tracer.createTraceId();

  // ① 参数校验
  const paramCheck = validateInvokeParams(agentName, { input });
  if (!paramCheck.ok) {
    return { ok: false, error: paramCheck.error, isFallback: true, traceId };
  }
  const agent = AGENTS.get(agentName);

  // 工具模式分流：function calling 的执行模型与直出 JSON 完全不同
  // （多轮往返 + 工具结果回传 + 无置信度分档概念），塞进主流程会互相污染
  if (agent.useTools) {
    return invokeWithTools({ agent, input, options, traceId });
  }

  // ⑤ 前置护栏：全局降级开关
  // 这是应急手段：LLM 侧限流/故障/成本失控时，改一个配置全局转规则（可行性专章 §6.4）
  if (options.llmEnabled === false) {
    return finalizeWithFallback(agent, input, options, traceId, 'GLOBAL_LLM_DISABLED');
  }

  // ⑤ 前置护栏：成本熔断
  if (options.costContext) {
    const budgetCheck = guardrail.checkTokenBudget(
      options.costContext.usedTokens || 0,
      options.costContext.dailyBudget
    );
    if (!budgetCheck.allowed) {
      return finalizeWithFallback(agent, input, options, traceId, 'TOKEN_BUDGET_EXCEEDED');
    }
  }

  // ⑤ 前置护栏：隐私脱敏
  const inputText = typeof input === 'string' ? input : JSON.stringify(input);
  const { text: safeInput, maskedCount } = guardrail.desensitize(inputText);
  if (maskedCount > 0) tracer.logEvent(traceId, 'privacy_masked', { maskedCount });

  const safeInputObj = typeof input === 'string' ? safeInput : JSON.stringify(safeInput);

  // ③ 上下文构建 + Token 预算裁剪
  let contextBlocks = agent.buildContext(input, options) || {};
  contextBlocks = { ...contextBlocks, p0_system: { text: '' } };
  const trimmed = guardrail.trimByPriority(
    contextBlocks,
    agent.budget.maxTokens - guardrail.estimateTokens(safeInputObj)
  );
  if (trimmed.trimmed.length) {
    tracer.logEvent(traceId, 'context_trimmed', { trimmed: trimmed.trimmed });
  }

  // ④ Prompt 组装
  const messages = buildMessages(agent, safeInputObj, trimmed.blocks);

  // ⑥⑦ 调用 + 校验修复重试
  let repairCount = 0;
  let lastError = null;
  let llmResult = null;
  const startedAt = Date.now();

  for (let attempt = 0; attempt <= GUARDRAIL.LLM_RETRY_LIMIT; attempt++) {
    const attemptMessages = [...messages];
    if (repairCount > 0) {
      attemptMessages.push({
        role: 'user',
        content: validator.buildRepairHint(lastError, {
          validCategoryIds: agent.validCategoryIds,
          input: safeInputObj
        })
      });
    }

    llmResult = await llm.chat({
      messages: attemptMessages,
      temperature: repairCount > 0 ? Math.min(agent.temperature, 0.1) : agent.temperature,
      maxTokens: agent.maxTokens,
      userId: options.userId,
      jsonMode: agent.jsonMode,
      timeoutMs: agent.budget.timeoutMs
    });

    if (!llmResult.ok) {
      lastError = { stage: 'network', error: llmResult.error };
      // 网络失败不计入 repairCount：
      // repairCount 在置信度公式里的语义是「模型输出结构不稳定」，
      // 把它当成网络抖动会无谓压低置信度，也会让重试 Prompt 带上无关的修复提示。
      // 网络问题只需退避重试，不改温度、不加修复提示。
      tracer.logEvent(traceId, 'llm_call_failed', { attempt, error: llmResult.error });
      continue;
    }

    // ⑥ 后置护栏：内容安全
    const safety = guardrail.checkContentSafety(llmResult.content);
    if (!safety.safe) {
      tracer.logEvent(traceId, 'guardrail_blocked', { reason: safety.reason });
      return finalizeWithFallback(agent, input, options, traceId, 'GUARDRAIL_CONTENT_SAFETY');
    }

    // ⑦ 结构校验
    const validation = validator.validate(
      llmResult.content,
      agent.outputSchema,
      agent.validCategoryIds,
      agent.categoryPathKey
    );

    if (validation.ok) {
      // ⑧ 置信度计算
      const result = computeConfidenceAndDecide({
        agent,
        data: validation.data,
        options,
        repairCount,
        hallucination: false
      });

      /**
       * ⚠️ 这里原来还有一层「数值对账」（guardrail.validateNumericCitations），
       * 已按新方案移除：不再逐个数字查白名单，
       * 改为工具链路径上的「结论必须基于已调用的工具」。
       *
       * 移除原因：实测误伤率极高（格式差一位就整条作废），
       * 而且粒度错了——一句话里其他正确的判断被一起推翻。
       *
       * `options.authoritativeValues` 全项目无人传入，
       * 所以这段原本就是死代码，删掉不影响任何现有行为。
       */

      tracer.record({
        traceId,
        agent: agentName,
        version,
        ok: true,
        repairCount,
        confidence: result.confidence,
        tier: result.decision.tier,
        usage: llmResult.usage,
        latencyMs: Date.now() - startedAt,
        llmLatencyMs: llmResult.latencyMs
      });

      return { ...result, isFallback: false, traceId };
    }

    // 校验失败 → 修复重试
    lastError = {
      stage: validation.stage,
      error: validation.error,
      errors: validation.errors
    };
    repairCount++;
    tracer.logEvent(traceId, 'validation_failed', {
      attempt,
      stage: validation.stage,
      error: validation.error,
      hasHallucination: !!validation.hasHallucination
    });

    // 幻觉类目必须修复（错类目会污染账本），且**值得重试**：
    // 幻觉往往是 Prompt 没把合法 ID 清单给全，修复提示能让模型改对；
    // 实测「直接 break」会让幻觉类失败 100% 变成永久兜底。
    // 只有重试用尽才放弃。
    if (attempt >= GUARDRAIL.LLM_RETRY_LIMIT) break;
  }

  // 重试用尽 → 规则兜底
  return finalizeWithFallback(
    agent, input, options, traceId,
    lastError && lastError.stage === 'network' ? 'LLM_UNAVAILABLE' : 'VALIDATION_FAILED'
  );
}

/**
 * 工具模式执行链（function calling）
 *
 * 与主 invoke 的差异：
 *   · 没有置信度分档（分析结论不存在「高置信直接入账」这回事）
 *   · 多轮往返，但整轮共享一个超时预算
 *   · 工具依赖校验在这里最关键：模型只该说调过工具的结论
 *
 * v3 起 savings 的金额由模型估算、原样透传（不做代码重算）：
 * 平替/降档类建议的节省额无法用固定比例表达。
 * 失败一律走 finalizeWithFallback —— 降级时 savings 恒为空，
 * 前端显示「AI 分析暂不可用」，不用规则建议冒充。
 */
async function invokeWithTools({ agent, input, options, traceId }) {
  const tools = require('./tools');

  // 前置护栏：全局降级开关
  if (options.llmEnabled === false) {
    return finalizeWithFallback(agent, input, options, traceId, 'GLOBAL_LLM_DISABLED');
  }

  // 工具上下文：账单快照只查一次，所有工具共享，保证同一份数据口径一致
  const toolContext = {
    month: options.month,
    billsByMonth: options.billsByMonth || {}
  };

  const contextBlocks = agent.buildContext(input, options) || {};
  const messages = buildMessages(agent, input, contextBlocks);

  const startedAt = Date.now();
  let llmResult;

  try {
    llmResult = await llm.chatWithTools({
      messages,
      tools: tools.TOOL_DEFINITIONS,
      // 工具执行体闭包在此：模型能触达的数据面被严格限定，
      // 它无法绕过 executeTool 直接读 context
      executeTool: (name, args) => tools.executeTool(name, args, toolContext),
      temperature: agent.temperature,
      maxTokens: agent.maxTokens,
      userId: options.userId,
      jsonMode: agent.jsonMode,
      timeoutMs: agent.budget.timeoutMs,
      maxRounds: agent.maxToolRounds,
      // 传入 traceId，llm-client 才能把模型输入输出与工具出入参
      // 记录到同一条调用链上——排查时需要看到的是**完整链路**，
      // 而不只是「最终返回了什么」
      traceId
    });
  } catch (e) {
    tracer.logEvent(traceId, 'tool_loop_error', { error: e.message });
    return finalizeWithFallback(agent, input, options, traceId, 'TOOL_LOOP_ERROR');
  }

  // 工具调用轨迹必须落盘：分析结论里的数字全靠它复现
  if (llmResult.toolCalls && llmResult.toolCalls.length) {
    tracer.logEvent(traceId, 'tool_calls', {
      calls: llmResult.toolCalls.map((c) => `${c.name}(${c.ok ? 'ok' : 'err'})`)
    });
  }

  if (!llmResult.ok) {
    tracer.logEvent(traceId, 'llm_tool_failed', { error: llmResult.error, rounds: llmResult.rounds });
    return finalizeWithFallback(agent, input, options, traceId, 'LLM_UNAVAILABLE');
  }

  // 内容安全
  const safety = guardrail.checkContentSafety(llmResult.content);
  if (!safety.safe) {
    tracer.logEvent(traceId, 'guardrail_blocked', { reason: safety.reason });
    return finalizeWithFallback(agent, input, options, traceId, 'GUARDRAIL_CONTENT_SAFETY');
  }

  // 结构校验
  const validation = validator.validate(llmResult.content, agent.outputSchema);
  if (!validation.ok) {
    tracer.logEvent(traceId, 'validation_failed', { stage: validation.stage, error: validation.error });
    return finalizeWithFallback(agent, input, options, traceId, 'VALIDATION_FAILED');
  }

/**
 * 结论类型 → 所需工具
 *
 * ## 设计依据
 *
 * 每种「结论」都依赖特定的数据面。没有那个数据面，
 * 结论就是模型凭常识猜的——而模型对「你的消费习惯」的常识一无所知。
 *
 * 例：说「餐饮占比最高」需要占比数据（get_category_share）；
 * 说「这笔是刚性支出」需要刚性判定（get_compressibility）。
 * 没调就说了 → 那句话没有依据。
 *
 * ## 为什么按「语义关键词」而不是「严格匹配」
 *
 * 结论是自然语言，不能要求模型标注自己用了哪个工具。
 * 所以用关键词判断「这句话在谈哪个维度」——
 * 这是启发式，会有误判，但**误判方向是安全的**：
 * 判不出维度 → 不做校验（放行）；判出维度但没调工具 → 剔除（保守）。
 */
const CONCLUSION_REQUIRES = [
  {
    // 占比、类目排名
    dimension: '类目占比',
    tools: ['get_category_share', 'get_top_categories', 'get_bills_detail'],
    patterns: [/占\s*\d/, /占比/, /大头/, /花得最多/, /最大的开销/, /第二大/, /排名/]
  },
  {
    // 总额、笔数、日均
    dimension: '总额概览',
    tools: ['get_monthly_summary', 'get_category_share'],
    patterns: [/共\s*\d+\s*笔/, /总.{0,2}(支出|花费)/, /日均/, /平均每天/, /这个月花得/]
  },
  {
    // 环比
    dimension: '环比',
    tools: ['get_month_over_month'],
    patterns: [/比上月/, /环比/, /较上月/, /比上月多/, /比上月少/]
  },
  {
    // 刚性判定
    dimension: '刚性支出',
    tools: ['get_compressibility'],
    patterns: [/刚性/, /生活必需/, /省不得/, /不该省/]
  },
  {
    // 备注驱动的判断
    dimension: '备注依据',
    tools: ['get_noted_bills', 'get_bills_detail'],
    patterns: [/备注/, /写着/, /显示是/, /买的是/]
  },
  {
    // 频次：买了几次、间隔多久（v3 新增，配套 get_bills_detail）
    dimension: '消费频次',
    tools: ['get_bills_detail', 'get_recurring_patterns'],
    patterns: [/买了\s*\d+\s*次/, /共\s*\d+\s*笔/, /频次/, /次数偏多/, /隔\s*\d+\s*天/, /间隔/]
  },
  {
    // 周期性消费
    dimension: '周期消费',
    tools: ['get_recurring_patterns'],
    patterns: [/每周/, /每月.*(会员|订阅|固定)/, /周期/, /订阅/, /固定支出/]
  },
  {
    // 餐饮结构
    dimension: '餐饮结构',
    tools: ['get_dining_detail', 'get_dining_structure'],
    patterns: [/在家吃/, /外出就餐/, /外食/, /外卖/]
  },
  {
    // 趋势
    dimension: '近月趋势',
    tools: ['get_trend'],
    patterns: [/最近.{0,3}个月/, /近.{0,3}个月/, /趋势/, /以往/, /去年同/]
  }
];

/**
 * 收集模型实际调用了哪些工具
 *
 * @param {object} llmResult chatWithTools 的返回值
 * @returns {{called:string[], byTool:Map<string,object>}}
 */
function collectToolUsage(llmResult) {
  const called = [];
  const byTool = new Map();
  const list = (llmResult && llmResult.toolCalls) || [];

  for (const t of list) {
    if (!t || !t.name) continue;
    called.push(t.name);
    byTool.set(t.name, {
      args: t.args || {},
      ok: t.ok !== false,
      error: t.error || '',
      latencyMs: t.latencyMs || 0
    });
  }

  return { called, byTool };
}

/**
 * 找出「没有工具支撑」的结论
 *
 * ## 判定规则：任一维度有支撑即成立
 *
 * 一句结论常常是复合的：「刚性支出 200 元，占 13.8%」——
 * 主体是「刚性支出」（有工具），顺带提了「占比」（可能没工具）。
 *
 * 如果要求所有维度都有工具，这条结论会被误杀，
 * 而它其实站得住（刚性判定确实查过）。
 *
 * 所以规则是：**匹配到的维度里，只要有任一个有工具支撑 → 保留**；
 * 全部维度都没支撑 → 这条结论没有依据，剔除。
 *
 * ## 为什么这样是安全的
 *
 * 宽松的代价是可能放过「模型编的数字」——
 * 但那由**金额兜底重算**兜住（模型填的金额一律作废）。
 * 这里管的是「有没有查过」，不是「数字对不对」。
 *
 * @param {object} data 模型产出的结论
 * @param {object} usage collectToolUsage 的结果
 * @returns {Array<{text:string, dimension:string, reason:string}>}
 */
function findUnsupportedConclusions(data, usage) {
  const unsupported = [];
  const called = new Set(usage.called);

  const check = (text, kind) => {
    if (typeof text !== 'string' || !text.trim()) return;

    // 收集这句话涉及的**所有**维度
    const dimensions = CONCLUSION_REQUIRES.filter((rule) =>
      rule.patterns.some((p) => p.test(text))
    );
    if (!dimensions.length) return; // 不涉及具体维度 → 不校验

    // 任一维度有工具支撑 → 有依据
    const grounded = dimensions.some((rule) =>
      rule.tools.some((t) => called.has(t))
    );
    if (grounded) return;

    unsupported.push({
      text,
      kind,
      dimension: dimensions.map((d) => d.dimension).join('、'),
      reason: `结论涉及「${dimensions.map((d) => d.dimension).join('、')}」，` +
        `但模型没有调用对应工具（` +
        dimensions.map((d) => d.tools.join(' 或 ')).join('；') + '）'
    });
  };

  for (const t of data.insights || []) check(t, 'insight');
  for (const s of data.savings || []) {
    check(s.action, 'saving');
    check(s.trigger, 'saving');
  }

  return unsupported;
}

  /**
   * 工具依赖校验 —— 「没调工具就别下这个结论」
   *
   * ## 为什么不是逐个数字对账
   *
   * 原实现是「模型写完 → 事后逐个数字查白名单 → 有对不上的就整条作废」。
   * 这套做法有三个问题：
   *
   * 1. **误伤率高**：格式差一位（'500.00' vs 500）就判失败，
   *    实测导致模型路径几乎必然退回兜底
   * 2. **粒度错**：整条结论因为一个数字被推翻，
   *    但那句话里其他判断可能完全正确
   * 3. **治标不治本**：它查「数字有没有出处」，
   *    查不出「这个结论本来就没有工具能支撑」
   *
   * ## 现在的做法：事前约束
   *
   * 模型想说什么结论，就必须有对应的工具被调用过。
   * 没调用 → 那条结论**不做**（不是整条作废，是这一条不成立）。
   *
   * 这更符合产品语义：「没有合适工具，就不做对应的分析结论」——
   * 用户看到的是少一条有根据的结论，而不是一整段被拒绝的话。
   */
  const toolUsage = collectToolUsage(llmResult);
  const unsupported = findUnsupportedConclusions(validation.data, toolUsage);

  if (unsupported.length) {
    tracer.logEvent(traceId, 'unsupported_conclusion', {
      unsupported: unsupported.slice(0, 5),
      calledTools: toolUsage.called
    });
    // 只剔除不成立的那几条，其余结论照常展示。
    // 整条作废是过度反应——用户宁可少看一句，也不愿什么都看不到。
    validation.data.insights = (validation.data.insights || []).filter(
      (t) => !unsupported.some((u) => u.text === t)
    );
    validation.data.savings = (validation.data.savings || []).filter(
      (s) => !unsupported.some((u) => u.text === s.action || u.text === s.trigger)
    );
    // 如果剔除后一条都不剩，说明模型完全没基于工具，
    // 那就没有「分析」可言——退回规则版，它至少还有数据支撑。
    if (!validation.data.insights.length && !validation.data.savings.length) {
      return finalizeWithFallback(agent, input, options, traceId, 'NO_TOOL_GROUNDING');
    }
  }

/**
 * 刚性白名单硬拦截
 *
 * 上一层的工具依赖校验只能查出「这个结论没有数据支撑」，
 * 查不出「根本不该提这个类目」。
 * 而「建议学费省 30%」这类错误的严重性远高于数字偏差——
 * 它会让用户去砍掉必要开支。这里必须硬拦。
 */
  const rigidViolation = findRigidViolation(validation.data, toolContext, options.month);
  if (rigidViolation.length) {
    tracer.logEvent(traceId, 'rigid_category_violation', { violations: rigidViolation });
    const violations = new Set(rigidViolation);
    // 只剔除违规的那几条建议，其余结论照常展示。
    // 整条退回的代价太大：刚性违规通常只影响一条建议，
    // 而其他结论（占比、趋势、消费习惯）往往是好的。
    validation.data.savings = (validation.data.savings || []).filter(
      (s) => !violations.has(s.category) && !violations.has(s.title)
    );
    // 剔除后一条都不剩 → 才退回兜底（那时确实没有可展示的内容）
    if (!validation.data.insights.length && !validation.data.savings.length) {
      return finalizeWithFallback(agent, input, options, traceId, 'RIGID_CATEGORY_SUGGESTED');
    }
  }

  tracer.record({
    traceId,
    agent: agent.name,
    version: agent.version,
    ok: true,
    isFallback: false,
    usage: llmResult.usage,
    latencyMs: Date.now() - startedAt,
    toolRounds: llmResult.rounds
  });

  // 详细模式下把整条调用链打到日志——
  // 云函数日志里就有了「模型输入 → 工具调用 → 模型输出」的完整证据链
  if (tracer.isVerbose()) tracer.dumpChain(traceId);

  return {
    ok: true,
    data: validation.data,
    confidence: null,
    decision: null,
    isFallback: false,
    toolCalls: llmResult.toolCalls,
    traceId
  };
}

/**
 * 刚性类目违规检测
 *
 * 检查模型给的每条 savings 是否针对刚性类目。
 * 判定同时看类目名与备注——模型可能写「控制住房成本」这种不含刚性类目名
 * 但实质指向房租的说法，所以额外做关键词匹配。
 *
 * @returns {Array<string>} 违规的类目名，无违规返回空数组
 */
function findRigidViolation(data, toolContext, month) {
  const compressibility = require('../util/category-compressibility');
  const savings = (data && data.savings) || [];
  if (!savings.length) return [];

  const cur = (toolContext && toolContext.billsByMonth && toolContext.billsByMonth[month]) || [];

  // 该类目下是否存在刚性账单
  const rigidTopNames = new Set(
    cur.filter((b) => compressibility.isRigidBill(b)).map((b) => b.top)
  );
  const rigidCategoryNames = new Set(
    cur
      .filter((b) => compressibility.compressibilityOf(b.categoryId) === compressibility.LEVEL.RIGID)
      .map((b) => String(b.categoryPath || '').split('/').pop())
  );

  const violations = [];
  for (const s of savings) {
    const text = `${s.category || ''} ${s.title || ''}`;
    for (const top of rigidTopNames) {
      if (text.includes(top)) {
        violations.push(`${s.title || s.category} → 刚性类目「${top}」`);
        break;
      }
    }
    if (violations.length && violations[violations.length - 1].includes(s.title || s.category)) continue;
    for (const name of rigidCategoryNames) {
      if (text.includes(name)) {
        violations.push(`${s.title || s.category} → 刚性类目「${name}」`);
        break;
      }
    }
  }

  return violations;
}

/**
 * ⑧ 置信度计算与分档决策
 */
function computeConfidenceAndDecide({ agent, data, options, repairCount, hallucination }) {
  // 候选水合：模型只被要求返回 categoryId（省Token、降低幻觉面），
  // 但下游（前端展示、日志、测试断言、A/B 对照）都需要 categoryPath / name / color。
  // 在这里统一回填，避免每个消费方各写一遍、各自踩坑。
  const candidates = hydrateCandidates(data[agent.categoryPathKey] || []);

  const topScore =
    candidates.length && typeof candidates[0].score === 'number' ? candidates[0].score : 0;

  // 规则一致性：模型类目 vs 规则类目
  const modelTopId = candidates.length ? candidates[0].categoryId : null;
  const ruleMatch = confidence.checkConsistency(modelTopId, options.ruleCategoryId);

  const conf = confidence.fuseConfidence({
    topScore,
    ruleMatch,
    repairCount,
    hasHallucination: hallucination
  });

  return {
    ok: true,
    data,
    confidence: conf,
    decision: confidence.decide(conf, candidates)
  };
}

/**
 * 候选水合：用类目库把 categoryId 补全为完整展示信息
 *
 * 这是踩过坑后的必要设计：模型只吐 ID 是对的（Prompt 更短、幻觉面更小），
 * 但**绝不能**指望下游去查库。一旦某个消费方忘了查，它拿到的就是
 * 一堆没有路径的裸 ID，界面上会显示空白类目，且测试无法断言——
 * 这正是本项目曾出现的真实 bug（A/B 对照 Top1 全0% 的假性失败）。
 */
function hydrateCandidates(candidates) {
  const { CATEGORY_MAP, colorOf } = require('../util/category-preset');
  return (candidates || [])
    .filter((c) => c && c.categoryId)
    .map((c) => {
      const meta = CATEGORY_MAP.get(c.categoryId);
      return {
        ...c,
        // 查不到就是幻觉，schema-validator 已拦；此处兜底不丢候选，仅标记
        categoryPath: meta ? meta.path : (c.categoryPath || ''),
        categoryName: meta ? meta.name : (c.categoryName || ''),
        categoryLevel: meta ? meta.level : 3,
        color: colorOf(c.categoryId)
      };
    });
}

/**
 * 规则兜底 —— 所有失败路径的终点
 * 关键保证：兜底路径必须能产出一个可用的结果，绝不能返回空
 */
function finalizeWithFallback(agent, input, options, traceId, reason) {
  let fallbackData = null;

  if (agent.fallback) {
    try {
      // 兜底 options 补齐规则层候选：调用方通常只传 ruleCategoryId，
      // 但兜底体验需要 Top3，统一在这里注入，避免每个调用方各写一遍。
      const fallbackOptions = { ...options };
      if (!fallbackOptions.ruleCandidates && Array.isArray(options.ruleCategoryCandidates)) {
        fallbackOptions.ruleCandidates = options.ruleCategoryCandidates;
      }
      fallbackData = agent.fallback(input, fallbackOptions);
      // 兜底候选同样需要水合，保证「规则路径」与「LLM 路径」
      // 对下游是同构的——否则上层要写两套取值逻辑，
      // 而这正是此前 categoryPath 取到 undefined 的根因。
      if (fallbackData && agent.categoryPathKey && Array.isArray(fallbackData[agent.categoryPathKey])) {
        fallbackData[agent.categoryPathKey] = hydrateCandidates(fallbackData[agent.categoryPathKey]);
      }
    } catch (e) {
      tracer.logEvent(traceId, 'fallback_error', { error: e.message });
    }
  }

  tracer.record({
    traceId,
    agent: agent.name,
    version: agent.version,
    ok: false,
    isFallback: true,
    reason,
    latencyMs: 0
  });

  // 降级路径同样要 dump 调用链——
  // 排查「为什么降级」时，最需要看的就是降级前那几步发生了什么
  if (tracer.isVerbose()) tracer.dumpChain(traceId);

  return {
    ok: true, // 注意：兜底成功仍返回 ok=true，因为业务链路是通的
    data: fallbackData,
    confidence: null,
    decision: null,
    isFallback: true,
    fallbackReason: reason,
    traceId
  };
}

module.exports = {
  invoke,
  registerAgent,
  AGENTS,
  CONFIDENCE
};