#!/usr/bin/env node
/**
 * Agent 执行链路查看器
 *
 * ## 用途
 *
 * 把云函数日志里的 TRACE 行还原成一份可读的调用链报告：
 *   模型输入 → 工具调用（入参/出参）→ 模型输出 → 护栏判定 → 最终结论
 *
 * ## 怎么用
 *
 * 1. 在云开发控制台 → 云函数 → analysis-svc → 日志，
 *    复制包含 `[TRACE:xxx]` 的日志段落，存成文件（如 trace.log）
 * 2. 执行：
 *    node tools/trace-view.js trace.log
 *
 * 也可以直接管道输入：
 *   云函数日志 | node tools/trace-view.js
 *
 * 只想看最近一次：
 *    node tools/trace-view.js trace.log --last
 *
 * ## 为什么需要这个工具
 *
 * 云函数日志是**扁平的时间流**，几十行 TRACE 混在一起很难看出
 * 「哪一步失败」「工具返回了什么」「模型最终说了什么」。
 * 这个工具按 traceId 分组、按事件类型分节，输出一份报告。
 */

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const fileArg = args.find((a) => !a.startsWith('--'));
const onlyLast = args.includes('--last');
const showRaw = args.includes('--raw');

if (!fileArg) {
  // 用法提示走 stderr：与「没找到 TRACE」「文件不存在」保持一致，
  // 都属于「用法错误」而非正常输出
  console.error('用法：node tools/trace-view.js <日志文件> [--last] [--raw]');
  console.error('');
  console.error('日志文件应包含 [TRACE:xxx] 标记的行，');
  console.error('从云开发控制台 → 云函数 → analysis-svc → 日志 复制即可。');
  process.exit(1);
}

let content;
if (fileArg === '-') {
  content = fs.readFileSync(0, 'utf8');
} else {
  const p = path.resolve(fileArg);
  if (!fs.existsSync(p)) {
    console.error(`文件不存在：${p}`);
    process.exit(1);
  }
  content = fs.readFileSync(p, 'utf8');
}

/* ── 解析 TRACE 行 ── */

// 形如： [TRACE:abc123] event_name {"payload":...}
const TRACE_RE = /\[TRACE:([a-f0-9]+)\]\s*(\S+)\s*(\{.*\})?\s*$/;
// 人读版： [  +   52ms] event_name  {json}
const HUMAN_RE = /^\s*\[\s*\+(\d+)ms\]\s*(\S+)\s*(\{.*\})?\s*$/;

const chains = new Map();
let matched = 0;
let unmatched = 0;
let currentTraceId = null;

for (const line of content.split(/\r?\n/)) {
  // 人读版的分界行：===== TRACE abc123 =====
  const boundary = line.match(/^=+\s*TRACE\s+([a-f0-9]+)\s*=+/);
  if (boundary) {
    currentTraceId = boundary[1];
    if (!chains.has(currentTraceId)) {
      chains.set(currentTraceId, { traceId: currentTraceId, steps: [], dump: [] });
    }
    continue;
  }
  if (/^=+\s*END TRACE/.test(line.trim())) {
    currentTraceId = null;
    continue;
  }

  // 优先用结构化行（含 traceId）
  const m = line.match(TRACE_RE);
  if (m) {
    matched++;
    const [, traceId, event, payloadStr] = m;
    if (!chains.has(traceId)) {
      chains.set(traceId, { traceId, steps: [], dump: [] });
    }
    chains.get(traceId).steps.push({
      event,
      payload: parsePayload(payloadStr)
    });
    continue;
  }

  // 其次用人读版（需要 currentTraceId 上下文）
  const h = line.match(HUMAN_RE);
  if (h && currentTraceId) {
    const [, offset, event, payloadStr] = h;
    if (!chains.has(currentTraceId)) {
      chains.set(currentTraceId, { traceId: currentTraceId, steps: [], dump: [] });
    }
    chains.get(currentTraceId).steps.push({
      event,
      offsetMs: Number(offset),
      payload: parsePayload(payloadStr)
    });
    matched++;
    continue;
  }

  // 多行 dump 里的续行，归到当前 trace
  const current = currentTraceId ? chains.get(currentTraceId) : null;
  if (current && /^\s+\S/.test(line)) {
    current.dump.push(line);
  }
}

/** 解析 payload，失败时保留原文而不是丢弃 */
function parsePayload(str) {
  if (!str) return {};
  try {
    return JSON.parse(str);
  } catch (e) {
    return { _unparsed: str.slice(0, 300) };
  }
}

if (!matched) {
  console.error('没有找到 TRACE 记录。');
  console.error('');
  console.error('可能原因：');
  console.error('  1. 云函数没有开启 DEBUG_TRACE=true（环境变量）');
  console.error('  2. 复制的日志段落不含 [TRACE:xxx] 标记');
  console.error('');
  console.error('开启方式：云开发控制台 → 云函数 → analysis-svc → 配置 → 环境变量');
  console.error('  添加 DEBUG_TRACE=true，然后重新部署并触发一次分析。');
  process.exit(1);
}

console.log(`解析到 ${matched} 条 TRACE 记录，${chains.size} 条调用链`);
console.log('');

const list = onlyLast ? [...chains.values()].slice(-1) : [...chains.values()];

for (const chain of list) {
  printChain(chain, showRaw);
}

/* ── 渲染 ── */

function printChain(chain, raw) {
  const steps = chain.steps;
  console.log('='.repeat(72));
  console.log(`TRACE ${chain.traceId}`);
  console.log('='.repeat(72));

  // 汇总
  const toolCalls = steps.filter((s) => s.event === 'tool_call');
  const llmReqs = steps.filter((s) => s.event === 'llm_request');
  const llmRes = steps.filter((s) => s.event === 'llm_response');
  const summary = steps.find((s) => s.event === 'SUMMARY');

  if (summary) {
    const p = summary.payload;
    console.log(`\n结果      : ${p.isFallback ? '降级（规则版）' : '模型路径'}`);
    const verLabel = /^v/i.test(p.version || '') ? p.version : `v${p.version || '-'}`;
    console.log(`Agent     : ${p.agent} ${verLabel}`);
    if (p.reason) console.log(`降级原因  : ${p.reason}`);
    if (p.usage) {
      console.log(`Token     : ${p.usage.total_tokens || 0} ` +
        `(输入 ${p.usage.prompt_tokens || 0} / 输出 ${p.usage.completion_tokens || 0})`);
    }
    if (p.latencyMs) console.log(`耗时      : ${p.latencyMs}ms`);
  }

  console.log(`\n工具调用  : ${toolCalls.length} 次`);
  console.log(`模型往返  : ${llmReqs.length} 次`);

  // 逐段输出
  let currentRound = null;

  for (const s of steps) {
    if (s.event === 'SUMMARY') continue;

    switch (s.event) {
      case 'llm_request': {
        const p = s.payload;
        currentRound = p.round;
        console.log(`\n${'─'.repeat(68)}`);
        console.log(`【第 ${p.round} 轮】模型请求`);
        console.log(`${'─'.repeat(68)}`);
        console.log(`  模型      : ${p.model}  (temperature=${p.temperature}, max_tokens=${p.maxTokens})`);
        console.log(`  工具数量  : ${p.toolCount}`);
        console.log(`  消息      :`);
        for (const m of p.messages || []) {
          if (m.role === 'tool') {
            console.log(`    · tool (${m.toolCallId}) 返回 ${m.length} 字符`);
          } else if (m.role === 'assistant' && m.toolCalls) {
            console.log(`    · assistant 请求调用工具:`);
            for (const c of m.toolCalls) {
              console.log(`        ${c.name}(${c.args})`);
            }
          } else {
            console.log(`    · ${m.role} (${m.length} 字符) ${m.preview ? '「' + m.preview.slice(0, 80) + '」' : ''}`);
          }
        }
        break;
      }

      case 'llm_response': {
        const p = s.payload;
        console.log(`\n  ── 模型返回（第 ${p.round} 轮，${p.latencyMs}ms，${p.usage.total_tokens} tokens）`);
        if (p.toolCalls && p.toolCalls.length) {
          console.log('  请求调用工具:');
          for (const c of p.toolCalls) {
            console.log(`    · ${c.function.name}(${c.function.arguments})`);
          }
        }
        if (p.content) {
          console.log(`  输出内容:`);
          console.log(indent(p.content, 4));
        } else if (!p.toolCalls || !p.toolCalls.length) {
          console.log('  输出内容: (空)');
        }
        break;
      }

      case 'tool_call': {
        const p = s.payload;
        console.log(`\n  ┌─ 工具调用: ${p.name}  (${p.latencyMs}ms, ${p.ok ? '成功' : '失败'})`);
        console.log(`  │  入参: ${JSON.stringify(p.args)}`);
        console.log(`  │  出参: ${formatResult(p.resultSummary)}`);
        if (p.error) console.log(`  │  错误: ${p.error}`);
        console.log('  └─');
        break;
      }

      case 'numeric_mismatch':
        console.log(`\n  ⚠ 数值对账未通过: ${JSON.stringify(s.payload.uncited)}`);
        break;

      case 'rigid_category_violation':
        console.log(`\n  ⚠ 刚性类目违规: ${JSON.stringify(s.payload.violations)}`);
        break;

      case 'saving_amount_recomputed':
        console.log(`\n  ℹ 金额重算: 修正 ${s.payload.fixed} 处`);
        break;

      case 'savings_filtered':
        console.log(`\n  ℹ 过滤不可信建议: ${s.payload.dropped} 条`);
        break;

      case 'validation_failed':
        console.log(`\n  ⚠ 结构校验失败: ${s.payload.stage || ''} ${s.payload.error || ''}`);
        break;

      case 'llm_tool_failed':
        console.log(`\n  ⚠ 模型工具链失败: ${s.payload.error} (${s.payload.rounds} 轮)`);
        break;

      case 'fallback_error':
        console.log(`\n  ⚠ 兜底也出错: ${s.payload.error}`);
        break;

      default:
        if (raw) {
          console.log(`\n  · ${s.event}: ${JSON.stringify(s.payload)}`);
        }
        break;
    }
  }

  if (chain.dump && chain.dump.length && raw) {
    console.log('\n--- 原始 dump ---');
    chain.dump.forEach((l) => console.log(l));
  }

  console.log('');
}

/** 把对象格式化成多行，便于阅读 */
function formatResult(summary) {
  if (!summary) return '(无)';
  if (!summary.ok) return `失败: ${summary.error || '未知'}`;

  const parts = [];
  for (const [k, v] of Object.entries(summary)) {
    if (k === 'ok') continue;
    if (Array.isArray(v)) {
      if (!v.length) continue;
      parts.push(`${k}: ${v.length} 项`);
      // 数组只展示前 3 项，避免刷屏
      v.slice(0, 3).forEach((item) => {
        parts.push(`    - ${JSON.stringify(item)}`);
      });
      if (v.length > 3) parts.push(`    … 还有 ${v.length - 3} 项`);
    } else if (v && typeof v === 'object') {
      parts.push(`${k}: ${JSON.stringify(v)}`);
    } else if (v !== undefined && v !== null && v !== '') {
      parts.push(`${k}: ${v}`);
    }
  }
  return parts.length ? '\n  │    ' + parts.join('\n  │    ') : '(空)';
}

function indent(text, n) {
  const pad = ' '.repeat(n);
  return String(text).split('\n').map((l) => pad + l).join('\n');
}
