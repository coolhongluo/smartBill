#!/usr/bin/env bash
# UserPromptSubmit 钩子：每次用户提交需求时，把「先查 Wiki + 渐进式下钻」规则注入模型上下文。
# 规则全文见 AGENTS.md §1。本脚本只做注入、不做判断（不读 stdin，失败也照常输出，宁多勿漏）。
# 注意：必须是单行 JSON，且规则文本里的换行要写成 \n 转义。
printf '%s' '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"【voice-bill 强制流程】回答本次需求前，先按 AGENTS.md §1 分流：\n1. 判断题（该怎么做/有什么坑/连动哪些文件）：先读 docs/wiki/llms.txt 索引，只挑相关 1~2 页读，再 grep 复核行号、读源码；不要一次读完整个 Wiki。\n2. 坐标题（常量第几行/函数名/文件在哪）：直接 grep，别读 Wiki。\n3. 口径题（产品决策，如“什么算订阅”）：别问 Wiki，直接找产品。\n4. 涉及金额/比例/涨跌：计算一律由代码完成，模型只负责表述（docs/wiki/business/02-analysis-rules.md）。\n5. 需求变更完成后：判断本次变更是否影响 docs/wiki 既有结论（口径/坑/架构/文件:行号），影响则同步更新对应页面（先查 llms.txt 定位），每条结论标 文件:行号、区分「已实施」与「规划中」；不影响则不改。"}}'
