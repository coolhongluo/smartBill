#!/usr/bin/env bash
# PostToolUse 钩子（matcher: Write|Edit）：文件刚被修改后，提醒模型判断 docs/wiki 是否需要同步更新。
# 不读 stdin、不做路径过滤（改的若就是 wiki 本身，按文案自行忽略），宁多勿漏。
printf '%s' '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"【wiki 同步检查】刚刚修改了文件：若本次改动影响 docs/wiki 既有结论（口径/坑/架构/文件:行号），需同步更新对应 wiki 页面，每条结论标 文件:行号、区分「已实施」与「规划中」；若改的只是 wiki 本身或纯重构不影响结论，忽略本条。"}}'
