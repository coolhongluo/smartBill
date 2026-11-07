/**
 * DeepSeek 客户端 —— 技术文档 §3.9
 *
 * 关键决策（技术文档 §3.9）：
 * 全部使用 deepseek-chat，不使用 deepseek-reasoner。
 * 理由：记账要求端到端 ≤2.5s，reasoner 的延迟与成本都不适配；
 *      分析类任务通过 Prompt 分步拆解即可，无需深度推理。
 *
 * 另：每次调用传 user_id（openid 的哈希，不用原始 openid），
 * 实现 DeepSeek 侧的 KVCache 隔离与用户级调度隔离。
 */

const DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1/chat/completions';
const MODEL = 'deepseek-chat';

/**
 * 从环境变量取API Key
 * 注意：云函数环境变量单函数上限 4KB，不要在此存长 Prompt。
 * 本地开发时若未配置，返回 mock 模式。
 */
function getApiKey() {
  return process.env.DEEPSEEK_API_KEY || '';
}

/** 是否为本地/mock 模式（无 Key 时） */
function isMockMode() {
  return !getApiKey();
}

/**
 * openid → 安全的 user_id（哈希，不传原始 openid）
 */
function makeUserId(openid) {
  if (!openid) return 'anonymous';
  let hash = 0;
  for (let i = 0; i < openid.length; i++) {
    hash = (hash * 31 + openid.charCodeAt(i)) >>> 0;
  }
  return `u${hash.toString(36)}`;
}

/**
 * 单轮调用（不含工具）
 *
 * 拆出独立函数的原因：工具调用循环里每轮都是「普通调用 + 带 tools 参数」，
 * 若不拆开，循环里就得复制一遍请求组装逻辑，改一处漏一处。
 *
 * @returns {{ok:boolean, message:object, usage:object, error:string, mock:boolean}}
 */
async function callOnce({ messages, tools, temperature, maxTokens, userId, jsonMode, timeoutMs, traceId, round }) {
  const apiKey = getApiKey();
  const tracer = require('./tracer');
  const httpClient = require('../util/http-client');

  if (isMockMode()) {
    return {
      ok: false,
      message: null,
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      error: 'NO_API_KEY',
      mock: true
    };
  }

  /**
   * ⚠️ 这里不再用 AbortController + setTimeout
   *
   * 那是配合 fetch 的 signal 用的。现在走 http-client（https 模块），
   * 超时由它内部的 req.setTimeout + destroy 处理。
   *
   * 保留 AbortController 反而有害：它的 abort() 不会真的中断
   * https 请求，只会让 fetch 抛错——而我们没有 fetch 了。
   */
  const startedAt = Date.now();

  try {
    const body = {
      model: MODEL,
      messages,
      temperature,
      max_tokens: maxTokens,
      stream: false,
      user: makeUserId(userId)
    };
    // DeepSeek 支持 JSON 模式，可显著降低解析失败率（可行性专章 P0 验收项）
    if (jsonMode) body.response_format = { type: 'json_object' };
    // tools 与 json_object 可共存（DeepSeek 支持），但只在真的有工具时传
    if (tools && tools.length) body.tools = tools;

    /**
     * 记录模型输入
     *
     * ⚠️ 只在 DEBUG_TRACE=true 时才构造这份快照——
     * messages 里含完整系统提示词（3000+ 字符），
     * 无条件构造会让每次调用都有额外开销与内存占用。
     *
     * 而且**只记摘要不记全文**：
     * 系统提示词全文进日志会淹没其他信息，且日志有长度上限，
     * 真正被截断时反而丢掉了关键的 tool_calls 与工具结果。
     * 需要看全文时用 trace-view.js 配合 --raw，或本地直接看 agent 文件。
     */
    if (traceId && tracer.isVerbose()) {
      tracer.logEvent(traceId, 'llm_request', {
        round: (round || 0) + 1,
        model: MODEL,
        temperature,
        maxTokens,
        jsonMode,
        toolCount: (tools && tools.length) || 0,
        messages: summarizeMessages(messages)
      });
    }

    /**
     * 发起请求
     *
     * ⚠️ 必须用 http-client（基于 Node 内置 https 模块），**不能用 fetch**
     *
     * 实测踩坑：云函数运行时 Nodejs18.15 + CommonJS 上下文下，
     * 全局 fetch 不存在 → ReferenceError: fetch is not defined。
     * 而本地 Node 22 有 fetch，所以本地测试全绿、云端从未跑通。
     *
     * 详见 shared/util/http-client.js 的说明。
     */
    const res = await httpClient.postJson(DEEPSEEK_BASE_URL, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(body),
      timeoutMs
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      if (traceId) {
        tracer.logEvent(traceId, 'llm_response_error', {
          round: (round || 0) + 1,
          status: res.status,
          error: `HTTP ${res.status}: ${text.slice(0, 200)}`
        });
      }
      return {
        ok: false,
        message: null,
        usage: {},
        error: `HTTP ${res.status}: ${text.slice(0, 200)}`,
        mock: false,
        status: res.status
      };
    }

    const data = await res.json();
    // 保留完整 message（含 tool_calls），不能只取 content——
    // 有工具调用时 content 是 null，真正的指令在 tool_calls 里
    const message = (data.choices && data.choices[0] && data.choices[0].message) || null;

    // 记录模型输出
    if (traceId) {
      const usage = data.usage || {};
      tracer.logEvent(traceId, 'llm_response', {
        round: (round || 0) + 1,
        latencyMs: Date.now() - startedAt,
        usage: {
          prompt_tokens: usage.prompt_tokens || 0,
          completion_tokens: usage.completion_tokens || 0,
          total_tokens: usage.total_tokens || 0
        },
        // 输出可能有 tool_calls（此时 content 为 null），两者都要记
        content: message ? message.content || '' : '',
        toolCalls: (message && message.tool_calls) || [],
        finishReason: (data.choices && data.choices[0] && data.choices[0].finish_reason) || ''
      });
    }

    return {
      ok: true,
      message,
      content: message ? message.content || '' : '',
      usage: data.usage || {},
      error: '',
      mock: false,
      latencyMs: Date.now() - startedAt
    };
  } catch (e) {
    // 超时由 http-client 内部处理，它抛的错误 message 里含「请求超时」
    const isTimeout = /超时|timeout/i.test(e.message || '');
    return {
      ok: false,
      message: null,
      content: '',
      usage: {},
      error: isTimeout ? `请求超时 (${timeoutMs}ms)` : e.message,
      mock: false,
      isTimeout
    };
  }
  // ⚠️ 这里不再需要 finally 清理定时器——
  // 旧的 fetch 实现需要 clearTimeout(timer)，
  // 但那个 timer 变量已随 AbortController 一起删除。
  // 留着这行会引用未定义变量，导致**每次请求都抛 ReferenceError**。
}

/**
 * 调用 DeepSeek（不含工具）
 * @param {object} params
 * @param {Array} params.messages OpenAI 格式消息数组
 * @param {number} params.temperature
 * @param {number} params.maxTokens
 * @param {string} params.userId
 * @param {boolean} params.jsonMode 是否启用 JSON 模式（DeepSeek 支持 response_format）
 * @param {number} params.timeoutMs
 * @returns {Promise<{ok:boolean, content:string, usage:object, error:string, mock:boolean}>}
 */
async function chat({
  messages,
  temperature = 0.3,
  maxTokens = 1200,
  userId = 'anonymous',
  jsonMode = false,
  timeoutMs = 5000
}) {
  const r = await callOnce({
    messages, temperature, maxTokens, userId, jsonMode, timeoutMs, tools: null
  });
  return {
    ok: r.ok,
    content: r.content || '',
    usage: r.usage,
    error: r.error,
    mock: r.mock,
    latencyMs: r.latencyMs,
    isTimeout: r.isTimeout
  };
}

/**
 * 带工具调用的对话 —— 技术文档 §9.4 C档「数值由代码算」的执行方式
 *
 * 流程：
 *   模型请求调工具 → 本地执行工具 → 把结果作为 tool 消息回传 → 模型据此写结论
 *
 * ## 三条不能省的约束
 *
 * 1. **最大轮次**：模型可能反复请求同一个工具（实测不会自己停）。
 *    没有上限就是无限循环 + 无限烧钱。设 3 轮足够（一次取数 + 一次补充 + 一次成文）。
 * 2. **每轮独立超时**：不能用一个大 timeout 覆盖整个循环，
 *    否则 3 轮各 2 秒 = 6 秒必然超网关。默认按 timeoutMs/轮 计算总预算。
 * 3. **工具报错要回传给模型**：不能吞掉。模型看到错误才知道「这个数据拿不到」，
 *    可以改为基于其他数据说话；静默吞掉会让它在缺数据的情况下编结论。
 *
 * @param {object} params
 * @param {Array} params.tools OpenAI 格式工具声明
 * @param {Function} params.executeTool (name, args) => {ok, data, error}
 * @returns {Promise<{ok, content, usage, toolCalls, rounds, error, mock}>}
 */
async function chatWithTools({
  messages,
  tools,
  executeTool,
  temperature = 0.3,
  maxTokens = 1600,
  userId = 'anonymous',
  jsonMode = false,
  timeoutMs = 5000,
  maxRounds = 3,
  traceId = ''
}) {
  const allUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const toolCalls = [];
  const convo = [...messages];
  const tracer = require('./tracer');

  // 每轮可用时长 = 总预算 / 轮数，保证整体不超网关
  const perRoundTimeout = Math.max(800, Math.floor(timeoutMs / maxRounds));

  for (let round = 0; round < maxRounds; round++) {
    const r = await callOnce({
      messages: convo,
      tools,
      temperature,
      maxTokens,
      userId,
      jsonMode,
      timeoutMs: perRoundTimeout,
      traceId,
      round
    });

    if (!r.ok) {
      // 最后一轮才失败才放弃：中途失败说明还有重试机会（网络抖动）
      if (round >= maxRounds - 1) {
        return {
          ok: false,
          content: '',
          usage: allUsage,
          toolCalls,
          rounds: round,
          error: r.error,
          mock: r.mock,
          isTimeout: r.isTimeout
        };
      }
      continue;
    }

    allUsage.prompt_tokens += r.usage.prompt_tokens || 0;
    allUsage.completion_tokens += r.usage.completion_tokens || 0;
    allUsage.total_tokens += r.usage.total_tokens || 0;

    const msg = r.message;
    const calls = (msg && msg.tool_calls) || [];

    // 没有工具调用 → 模型已给出最终文本，结束
    if (!calls.length) {
      return {
        ok: true,
        content: msg.content || '',
        usage: allUsage,
        toolCalls,
        rounds: round + 1,
        error: '',
        mock: false,
        latencyMs: r.latencyMs
      };
    }

    // 把 assistant 的 tool_calls 原样回传（OpenAI 协议要求）
    convo.push({
      role: 'assistant',
      content: msg.content || null,
      tool_calls: calls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.function.name, arguments: c.function.arguments }
      }))
    });

    // 执行每个工具调用，逐个回传 role:tool
    for (const call of calls) {
      let args = {};
      try {
        // arguments 是 JSON 字符串，模型偶尔会给非法 JSON
        args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
      } catch (e) {
        args = {};
      }

      const toolStartedAt = Date.now();
      let result;
      try {
        result = await executeTool(call.function.name, args);
      } catch (e) {
        result = { ok: false, error: `工具执行异常: ${e.message}` };
      }
      const toolLatency = Date.now() - toolStartedAt;

      /**
       * 记录工具调用：入参、出参、耗时
       *
       * ⚠️ 出参只记**概要**（条数、关键字段），不记完整数据——
       * 工具返回的是账单明细，全量进日志既刷屏又泄露隐私。
       * 需要看细节时用 summarizeToolResult 里的结构描述。
       */
      if (traceId) {
        tracer.logEvent(traceId, 'tool_call', {
          round: round + 1,
          name: call.function.name,
          args,
          ok: !!(result && result.ok),
          error: (result && result.error) || '',
          latencyMs: toolLatency,
          resultSummary: summarizeToolResult(call.function.name, result)
        });
      }

      toolCalls.push({
        round: round + 1,
        name: call.function.name,
        args,
        ok: !!(result && result.ok),
        error: (result && result.error) || '',
        latencyMs: toolLatency
      });

      convo.push({
        role: 'tool',
        tool_call_id: call.id,
        // 错误也要如实回传：模型需要知道哪个数据拿不到
        content: JSON.stringify(result && result.ok ? result.data : { error: (result && result.error) || '未知错误' })
      });
    }
  }

  // 轮次用尽仍未拿到最终文本 → 视为失败，交由调用方降级
  return {
    ok: false,
    content: '',
    usage: allUsage,
    toolCalls,
    rounds: maxRounds,
    error: `工具调用轮次达上限（${maxRounds}），模型未给出最终结论`,
    mock: false
  };
}

/**
 * 消息摘要
 *
 * 系统提示词动辄几千字符，全量打进日志会淹没关键信息，
 * 而且云函数日志有长度上限——真正该看的 tool_calls 反而被截断。
 * 摘要保留「谁说了什么」的结构，正文截断到 200 字。
 *
 * ⚠️ 完整提示词不进日志。要看全文直接看 agent 源文件
 * （`agent-harness/agents/insight.agent.js` 的 promptTemplate）。
 */
function summarizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.map((m) => {
    const role = m.role || 'unknown';
    if (role === 'tool') {
      // 工具结果：记录长度与是否成功，不记录完整账单数据
      const content = String(m.content || '');
      return { role, toolCallId: m.tool_call_id, length: content.length };
    }
    if (role === 'assistant' && m.tool_calls) {
      return {
        role,
        toolCalls: m.tool_calls.map((c) => ({
          id: c.id,
          name: c.function && c.function.name,
          args: c.function && c.function.arguments
        }))
      };
    }
    const content = String(m.content || '');
    return {
      role,
      length: content.length,
      // 前 200 字足以看清意图，不用全文
      preview: content.slice(0, 200)
    };
  });
}

/**
 * 工具返回结果摘要
 *
 * 目的是「一眼看出这次工具拿到了什么」，而不是把账单明细全量抄进日志。
 * 各工具返回结构不同，所以按工具名定制摘要字段。
 */
function summarizeToolResult(name, result) {
  if (!result || !result.ok) {
    return { ok: false, error: (result && result.error) || '未知错误' };
  }

  const d = result.data;
  if (d === null || d === undefined) return { ok: true };

  // 按工具名提取关键信息
  switch (name) {
    case 'get_category_share':
      return {
        ok: true,
        total: d.totalYuan,
        categories: (d.items || []).map((i) => ({
          name: i.name, amount: i.valueYuan, percent: i.percent, count: i.count
        }))
      };
    case 'get_compressibility':
      return {
        ok: true,
        rigidPercent: d.summary && d.summary.rigidPercent,
        rigidYuan: d.summary && d.summary.rigidYuan,
        categories: (d.categories || []).map((c) => ({
          path: c.categoryPath, amount: c.amountYuan,
          percent: c.percent, level: c.compressibilityLabel
        }))
      };
    case 'get_noted_bills':
      return {
        ok: true,
        coveragePercent: d.coveragePercent,
        total: d.total,
        notes: (d.items || []).map((i) => ({
          amount: i.amountYuan, note: i.note, level: i.compressibilityLabel
        }))
      };
    case 'get_recurring_patterns':
      return {
        ok: true,
        count: d.count,
        patterns: (d.items || []).map((p) => ({
          name: p.name, cycle: p.cycleLabel,
          avg: p.avgAmountYuan, times: p.count, gapDays: p.avgGapDays
        }))
      };
    case 'get_dining_detail':
      return {
        ok: true,
        home: d.homeYuan, away: d.awayYuan,
        awayPercent: d.awayPercent, awayCount: d.awayCount,
        bills: (d.awayBills || []).map((b) => ({ amount: b.amountYuan, note: b.note }))
      };
    case 'get_bills_detail':
      return {
        ok: true,
        totalCount: d.totalCount, total: d.totalYuan, truncated: d.truncated,
        categories: (d.categories || []).map((c) => ({
          top: c.top, count: c.count, amount: c.totalYuan,
          percent: c.percent, avgIntervalDays: c.avgIntervalDays
        })),
        billCount: (d.bills || []).length
      };
    case 'get_monthly_summary':
      return {
        ok: true,
        total: d.totalYuan, count: d.count,
        avgPerDay: d.avgPerRecordedDayYuan, recordedDays: d.recordedDays
      };
    case 'get_month_over_month':
      return {
        ok: true,
        direction: d.direction, rate: d.deltaRate,
        delta: d.deltaYuan, hasBaseline: d.hasBaseline
      };
    case 'get_trend':
      return { ok: true, points: (d.items || []).map((t) => ({ month: t.month, total: t.totalYuan })) };
    case 'get_top_categories':
      return { ok: true, items: (d.items || []).map((i) => ({ name: i.name, amount: i.valueYuan })) };
    default:
      // 未知工具：只记结构，不猜内容
      return { ok: true, keys: Object.keys(d).slice(0, 12) };
  }
}

module.exports = { chat, chatWithTools, makeUserId, isMockMode, MODEL, DEEPSEEK_BASE_URL, summarizeMessages, summarizeToolResult };