/**
 * 可观测性 Tracer —— 技术文档 §3.10
 *
 * 核心用途有三个：
 * 1. 定位单次失败（哪一步挂了、什么错误）
 * 2. 监控准确率趋势（兜底率、中置信占比、幻觉率）
 * 3. 成本核算（Token 消耗）
 *
 * ## 为什么必须有「落盘」能力
 *
 * 原来的实现只有内存 buffer，云函数实例一销毁就没了——
 * 真机上看不到任何东西，等于没有。
 * 现在增加 stdout 输出：云函数日志里能直接看到，
 * 配合 tools/trace-view.js 可以把日志还原成可读的调用链。
 *
 * ## 隐私约束
 *
 * trace 中不记录原始语音文本，只记录哈希与解析结果。
 * 账单金额、类目这类财务数据属于用户隐私，
 * 默认**不输出到日志**（TRACE_VERBOSE=false），
 * 需要排查时显式开启。
 */

const crypto = require('crypto');

/** 内存内 trace 缓冲（云函数实例内有效；跨实例统计需接外部日志服务） */
const buffer = [];
const MAX_BUFFER = 200;

/**
 * 按 traceId 聚合的完整调用链
 *
 * 内存 buffer 只存扁平事件，排查时看不出「这次调用经历了什么」。
 * 这里按 traceId 聚合成有序的步骤列表，配合 trace-view.js 可还原全流程。
 */
const chains = new Map();
const MAX_CHAINS = 50;

/** 聚合指标（用于监控告警，技术文档 §8.3） */
const metrics = {
  totalCalls: 0,
  successCalls: 0,
  fallbackCalls: 0,
  hallucinationBlocked: 0,
  repairTotal: 0,
  tokenUsage: 0,
  latencySamples: [],
  tierCounts: { high: 0, mid: 0, low: 0 }
};

/**
 * 是否输出详细日志
 *
 * 默认关闭——账单金额属于用户隐私，不该默认进日志。
 * 排查时在云函数环境变量设 DEBUG_TRACE=true 即可开启。
 */
function isVerbose() {
  return process.env.DEBUG_TRACE === 'true' || process.env.TRACE_VERBOSE === 'true';
}

/** 生成 traceId */
function createTraceId() {
  return crypto.randomBytes(8).toString('hex');
}

/** 输入哈希（不存原文，隐私要求） */
function hashInput(input) {
  const s = typeof input === 'string' ? input : JSON.stringify(input || {});
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
}

/**
 * 记录事件（调用链中的中间步骤）
 *
 * @param {string} traceId
 * @param {string} event 事件名
 * @param {object} payload 附加数据
 */
function logEvent(traceId, event, payload = {}) {
  const entry = { traceId, event, ts: Date.now(), ...payload };
  buffer.push(entry);
  if (buffer.length > MAX_BUFFER) buffer.shift();

  // 聚合成调用链
  if (!chains.has(traceId)) {
    chains.set(traceId, { traceId, startedAt: Date.now(), steps: [] });
    if (chains.size > MAX_CHAINS) {
      // 淘汰最旧的一条
      const oldest = chains.keys().next().value;
      chains.delete(oldest);
    }
  }
  chains.get(traceId).steps.push(entry);

  /**
   * ⚠️ 这里**不**逐条 console.log
   *
   * 逐条输出会导致同一件事出现两次：
   * 一条结构化的（便于 trace-view 解析），一条 dumpChain 的（便于人读）。
   * 日志有长度上限，重复输出等于把预算浪费在重复内容上，
   * 真正有用的信息反而被截断。
   *
   * 所以：结构化事件只进内存链，结束时由 dumpChain 统一输出一次。
   * 只有「非 verbose 模式下也值得知道的事件」才单独打日志。
   */
  if (!isVerbose() && ALWAYS_LOG_EVENTS.has(event)) {
    console.log(`[TRACE:${traceId}] ${event} ${safeStringify(payload)}`);
  }
}

/**
 * 即使非 verbose 模式也要单独打日志的事件
 *
 * 选这几个的理由：它们代表**需要人工介入**的情况
 * （护栏拦下了什么、兜底也失败了），
 * 静默丢失会让问题无从查起。
 */
const ALWAYS_LOG_EVENTS = new Set([
  'fallback_error',
  'rigid_category_violation',
  'numeric_mismatch'
]);

/**
 * 安全序列化：避免循环引用导致 console.log 抛错
 *
 * 踩过的坑：payload 里若含大对象（工具返回的账单列表），
 * 直接 JSON.stringify 可能因循环引用抛异常，
 * 而这会让**埋点本身**成为故障源——
 * 记录日志失败导致主流程失败，是最不该发生的事。
 */
function safeStringify(obj) {
  try {
    const s = JSON.stringify(obj, (key, value) => {
      // 数组太长就截断，日志里没人要看 500 个元素的数组
      if (Array.isArray(value) && value.length > 20) {
        return `[数组 ${value.length} 项，已截断]`;
      }
      return value;
    });
    return s === undefined ? '' : s;
  } catch (e) {
    return '[无法序列化]';
  }
}

/**
 * 记录一次完整调用
 */
function record(entry) {
  metrics.totalCalls++;
  if (entry.ok && !entry.isFallback) metrics.successCalls++;
  if (entry.isFallback) {
    metrics.fallbackCalls++;
    if (entry.reason && /hallucination|business/i.test(entry.reason)) metrics.hallucinationBlocked++;
  }
  if (entry.repairCount) metrics.repairTotal += entry.repairCount;
  if (entry.usage && entry.usage.total_tokens) metrics.tokenUsage += entry.usage.total_tokens;
  if (entry.latencyMs) metrics.latencySamples.push(entry.latencyMs);
  if (entry.tier && metrics.tierCounts[entry.tier] !== undefined) metrics.tierCounts[entry.tier]++;

  const record_ = {
    traceId: entry.traceId,
    agent: entry.agent,
    version: entry.version,
    ok: entry.ok,
    isFallback: entry.isFallback,
    reason: entry.reason || entry.fallbackReason,
    repairCount: entry.repairCount || 0,
    confidence: entry.confidence,
    tier: entry.tier,
    usage: entry.usage,
    latencyMs: entry.latencyMs,
    ts: Date.now()
  };
  buffer.push(record_);
  if (buffer.length > MAX_BUFFER) buffer.shift();

  // 结束时把完整调用链输出到日志（详细模式）
  if (isVerbose()) {
    console.log(`[TRACE:${entry.traceId}] SUMMARY ${safeStringify(record_)}`);
  }
}

/** 取最近 trace（排查用） */
function recent(n = 20) {
  return buffer.slice(-n);
}

/**
 * 取完整调用链
 *
 * @param {string} traceId 指定 trace；不传则取最近一条
 * @returns {object|null} { traceId, startedAt, steps: [...] }
 */
function getChain(traceId) {
  if (traceId) return chains.get(traceId) || null;
  const keys = [...chains.keys()];
  if (!keys.length) return null;
  return chains.get(keys[keys.length - 1]) || null;
}

/** 取所有调用链（排查用） */
function allChains() {
  return [...chains.values()];
}

/** 取聚合指标（监控用） */
function getMetrics() {
  const total = metrics.totalCalls || 1;
  const lat = metrics.latencySamples.slice().sort((a, b) => a - b);
  const p = (q) => (lat.length ? lat[Math.floor(lat.length * q)] : 0);
  const tierTotal = Object.values(metrics.tierCounts).reduce((a, b) => a + b, 0) || 1;

  return {
    ...metrics,
    // 监控告警阈值参考（技术文档 §8.3）
    fallbackRate: metrics.fallbackCalls / total,
    midTierRate: metrics.tierCounts.mid / tierTotal,
    hallucinationRate: metrics.hallucinationBlocked / total,
    avgRepairCount: metrics.repairTotal / total,
    latencyP50: p(0.5),
    latencyP95: p(0.95),
    latencyP99: p(0.99)
  };
}

/**
 * 把整条调用链输出为可读文本
 *
 * 供云函数在结束时调用，直接打到日志里。
 * 排查时把这段日志复制出来就是一份完整的执行报告。
 *
 * ⚠️ 输出**两遍**，各有用途：
 *   1. 结构化行 `[TRACE:xxx] event {json}` —— 给 trace-view.js 解析
 *   2. 人读版（带时间偏移）—— 直接看日志就能懂
 * 只有结构化行是必需的；人读版是为了「不装工具也能看懂」。
 */
function dumpChain(traceId) {
  const chain = getChain(traceId);
  if (!chain) return '';

  // 1) 结构化输出（trace-view.js 靠这个还原调用链）
  for (const s of chain.steps) {
    const { traceId: _t, ts, ...rest } = s;
    console.log(`[TRACE:${traceId}] ${rest.event} ${safeStringify(rest)}`);
  }

  // 2) 人读版
  const lines = [];
  lines.push(`===== TRACE ${chain.traceId} =====`);
  const t0 = chain.startedAt;
  for (const s of chain.steps) {
    const { traceId: _t, event, ts, ...rest } = s;
    const offset = ts - t0;
    lines.push(`  [+${String(offset).padStart(5)}ms] ${event}  ${safeStringify(rest)}`);
  }
  lines.push(`===== END TRACE ${chain.traceId} =====`);
  const text = lines.join('\n');
  console.log(text);
  return text;
}

/** 重置（测试用） */
function reset() {
  buffer.length = 0;
  chains.clear();
  Object.assign(metrics, {
    totalCalls: 0, successCalls: 0, fallbackCalls: 0, hallucinationBlocked: 0,
    repairTotal: 0, tokenUsage: 0, latencySamples: [], tierCounts: { high: 0, mid: 0, low: 0 }
  });
}

module.exports = {
  createTraceId,
  hashInput,
  logEvent,
  record,
  recent,
  getChain,
  allChains,
  getMetrics,
  dumpChain,
  isVerbose,
  safeStringify,
  reset
};
