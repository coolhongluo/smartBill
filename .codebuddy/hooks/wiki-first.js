#!/usr/bin/env node
/**
 * UserPromptSubmit hook —— 每次用户提问时注入「Wiki 优先查询」规则
 *
 * ## 为什么要有这个 hook
 *
 * `AGENTS.md` 是**静态文件**，靠 agent 自觉去读。实测过很多次「规则写了但没执行」：
 * agent 直接 grep 就开干，跳过了本该先做的 Wiki 判断。
 *
 * UserPromptSubmit hook 会在**用户每次提交消息时**注入规则到上下文，
 * 变成「环境的一部分」而不是「需要记得遵守的文档」。
 *
 * ## 注入的是什么（重要）
 *
 * 注入的是**分流规则**，不是「一律先读 Wiki」。
 *
 * `docs/wiki/00-overview.md` §7 的双盲对照实验实测：
 * 只读 Wiki 在判断题上 5/5 全对，在坐标题上大量推断错误；
 * 只读源码在判断题上会跑偏。Wiki 提供「判断」，源码提供「坐标」。
 *
 * 所以强制「一律先读 Wiki」反而有害 —— 会让纯找文件位置的问题也去翻 Wiki，
 * 而 Wiki 的行号会随代码变动失效，比 grep 更慢且更不可靠。
 *
 * 正确的规则是**按题型分流**，本 hook 注入的就是这个分流表。
 *
 * ## 契约
 *
 * - stdout **只能**输出协议 JSON（`hookSpecificOutput.additionalContext`）
 * - 调试信息一律走 stderr —— 混进 stdout 会破坏 JSON 解析
 * - 退出码 0 = 成功并注入；1 = 非阻塞错误（允许继续）
 * - **绝不 `continue: false`** —— 那是阻止用户输入，本 hook 无权拦用户
 *
 * ## 幂等与容错
 *
 * - Wiki 目录不存在 → 不注入，静默放行（换个项目也能用同一份配置）
 * - 重复触发 → 每次独立判断，不累积状态
 * - 任何异常 → 兜底输出「不注入」，绝不阻断用户提问
 */

'use strict';

const fs = require('fs');
const path = require('path');

/** 注入文本 —— 精简版分流规则，完整版见 AGENTS.md */
const RULE = [
  '【本项目提问分流规则】（来自 AGENTS.md / docs/wiki/00-overview.md §7 实测结论）',
  '',
  '判断题（该怎么做 / 有什么坑 / 改动连动哪些文件 / 要不要找产品确认）：',
  '  → 先读 docs/wiki/llms.txt 索引 → 只挑相关的 1~2 页 → 再 grep 复核坐标 → 读源码 → 改 → npm test + npm run preflight',
  '',
  '坐标题（某常量在第几行 / 某函数叫什么 / 某文件在哪）：',
  '  → 直接 grep，别读 Wiki（Wiki 在这上是负收益，且行号会随代码变动失效）',
  '',
  '口径题（什么算订阅 / 续费日从哪来 / 搜哪几个月）：',
  '  → 别问 Wiki（那是产品决策），直接找产品',
  '',
  '动手改功能前：必读 docs/wiki/engineering/23-change-impact.md（连动文件 / 会红的测试 / 静默失效点）。',
  '同一常量常散在 3~4 处 —— 改前 grep 全仓确认。',
].join('\n');

/** 判断 cwd 下是否有本项目的 wiki（没有就说明不是这个项目，静默放行） */
function hasProjectWiki(cwd) {
  try {
    return fs.existsSync(path.join(cwd, 'docs', 'wiki', 'llms.txt'));
  } catch (e) {
    return false;
  }
}

function main() {
  let input = {};
  let parsed = false;
  try {
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (raw) {
        try {
          input = JSON.parse(raw);
          parsed = true;
        } catch (e) {
          // 解析失败不是致命错误 —— 但此时拿不到 cwd，
          // 不能回落到 process.cwd()（那会把「不属于本项目」的调用也注入了）
          process.stderr.write(`[wiki-hook] stdin 非 JSON，跳过注入：${e.message}\n`);
        }
      } else {
        process.stderr.write('[wiki-hook] stdin 为空，跳过注入\n');
      }
      emit(input, parsed);
    });
  } catch (e) {
    process.stderr.write(`[wiki-hook] 读取 stdin 失败：${e.message}\n`);
    emit({}, false);
  }
}

function emit(input, parsed) {
  // 只有成功解析出 stdin 才用它的 cwd；否则宁可不注入，也不误判项目归属
  const cwd = parsed ? (input.cwd || process.cwd()) : null;
  let shouldInject = false;
  if (cwd) {
    try {
      shouldInject = hasProjectWiki(cwd);
    } catch (e) {
      shouldInject = false;
    }
  }

  if (!shouldInject) {
    // 不是带 wiki 的项目，或拿不到 cwd —— 静默放行
    process.stdout.write(JSON.stringify({ continue: true }));
    return;
  }

  process.stdout.write(
    JSON.stringify({
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: RULE,
      },
    })
  );
}

main();
