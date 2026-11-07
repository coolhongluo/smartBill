# AGENTS.md —— 随口记 voice-bill

> 面向在本仓库工作的 AI agent 与新成员。
> 权威业务/技术口径在 `docs/wiki/`；本文件只讲**怎么查、怎么改**。

## 0. 一句话铁律

**所有涉及金额、比例、涨跌的计算由代码完成，模型只负责表述。**
详见 `docs/wiki/business/02-analysis-rules.md`。

## 1. 提问分流：先判题型，再决定查不查 Wiki

> 这不是「一律先读 Wiki」。`docs/wiki/00-overview.md` §7 的双盲对照实验实测：
> 只读 Wiki 在**判断题**上 5/5 全对，在**坐标题**上大量推断错误；
> 只读源码在判断题上会跑偏。
> **Wiki 提供「判断」，源码提供「坐标」。缺任何一半都做不成事。**

| 题型 | 判据 | 动作 |
|---|---|---|
| **判断题** | 该怎么做 / 有什么坑 / 要不要找产品确认 / 这个改动连动哪些文件 | **先读 Wiki** → 再 grep 复核坐标 |
| **坐标题** | 某常量在第几行 / 某函数叫什么 / 某文件在哪 | **直接 grep**，别读 Wiki（Wiki 在这上是负收益） |
| **口径题** | 「什么算订阅」「续费日从哪来」「搜哪几个月」 | **别问 Wiki** —— 这是产品决策，直接找产品 |

### 1.1 判断题的渐进式下钻路径

**不要一次性读完整 Wiki** —— 按需下钻，每层读完再决定要不要再往下一层：

```
第 0 层  docs/wiki/llms.txt              索引（~2.6KB）—— 先看这个，认页面名
   ↓  只挑与问题相关的那 1~2 页
第 1 层  docs/wiki/00-overview.md        全局架构 + 四条旅程 + §7 使用边界
   ↓
第 2 层  按 llms.txt 的分类挑最深的一页
         business/  → 业务口径（记账规则 / 分析规则 / 类目体系）
         tech/      → 技术实现（架构 / agent / 数据模型 / 前端）
         engineering/ → 坑与纪律（踩坑 / 调试 / 变更影响面）
   ↓  拿到「方向 + 候选坐标」后
第 3 层  grep 复核关键行号                ← Wiki 的行号会随代码变动失效
   ↓
第 4 层  读实际源码确认
```

**只读 1~2 页就够**。Wiki 全量 12 页读完再动手，是浪费上下文。

### 1.2 四个强制检查点

| 时机 | 动作 |
|---|---|
| **动手改功能前** | 先读 `docs/wiki/engineering/23-change-impact.md` —— 它列出「改一个功能会连动哪些文件、哪些测试会红、哪些地方会静默失效」 |
| **大需求开工前** | 先出实现方案 + TODO 清单，**用户确认后才动代码**（判「大」的标准与流程见 §7） |
| **改完代码后** | `npm test` + `npm run preflight` —— 守卫全绿才算完 |
| **拿不准某个常量有几处时** | grep 全仓，**同一常量常常散在 3~4 处**（例：金额上限 4 处、3 种单位） |

> 本项目最大的坑不是「找不到文件」，是**找到了但漏了一处**。

## 2. 改云函数代码的四步（缺一步就报错的错方向）

| # | 动作 | 自动化 |
|---|------|--------|
| 1 | `cloudfunctions/shared/util/constants.js` 的 `CODE_VERSION` +1 | preflight 校验 |
| 2 | 同步 `miniprogram/utils/cloud.js` 的 `EXPECTED_CODE_VERSION` | preflight 校验 |
| 3 | `npm run prepare:cf`（同步 shared 到 5 个云函数目录） | 有脚本 |
| 4 | 开发者工具右键云函数 →「上传并部署：云端安装依赖」 | ❌ **只能人工** |

**第 3 步漏跑 = 版本不一致，而报错方向是错的。**
shared 是**多副本**（复制进每个云函数目录）。只改源没跑 `prepare:cf` → 副本停在旧版本 →
看着像「忘了部署」，实际是「忘了同步」。

**第 4 步必须选「云端安装依赖」**，否则 `wx-server-sdk` 不进包。

**改了 `config.json`（定时触发器）还要额外两步**：
① 右键 `config.json` →「云函数增量上传：更新文件」→ ② 右键 `config.json` →「上传触发器」。
**「更新文件」与「上传触发器」是两个不同概念** —— 只做前者，云端跑的还是旧触发器。

> ⚠️ 定时分析曾经**每天都静默不执行**（2026-10-31 修复）：
> 官方触发器 event 没有 `action` 字段，而入口只认 `event.action`。
> 详见 `docs/wiki/engineering/20-pitfalls.md` §19 §20。

## 3. 改代码前必看的两条硬约束

| 约束 | 说明 |
|---|---|
| **shared 必须在函数目录内的普通子目录** | 「上传并部署：云端安装依赖」**不上传本地 node_modules**。复制到 `node_modules/shared` 或仓库根的 `__dirname/../shared`，云端必然 `Cannot find module` |
| **云端没有全局 `fetch`** | `Nodejs18.15` + CommonJS → 全局 `fetch` 不存在 → `ReferenceError`。本地 Node 22 有 → **本地全绿、云端必然失败**。云端发 HTTP 一律用 `shared/util/http-client.js` 的 `postJson()` |

> **本地全绿 ≠ 云端能跑。** 这是本项目最高频的故障模式。

## 4. 常用命令

```bash
npm run prepare:cf    # 同步 shared 到各云函数（改 shared 后必跑）
npm run preflight     # 预检：版本戳、SDK 守卫、语法真解析、备注链路、Wiki 一致性
npm run check:ui      # 前端检查（JS 语法真解析 + WXML 数据绑定守卫）
npm test              # 全量测试
npm run trace <file>  # 查看 agent 执行链路报告
npm run wiki:build    # 构建 LLM Wiki 静态站点 → docs/wiki/_site
npm run wiki:verify   # 浏览器验证 Wiki 渲染
```

## 5. 写代码与写文档时的自我检查

- **金额单位**：内部一律整数分，对外才转元；展示值与计算值**不要共名字段**（`amount` vs `amountCent`）
- **单一数据源**：同一屏上出现的数字，绝不能来自两次独立计算
- **静默失败**：不要 `|| []` 兜底 —— 直接 `throw` 让错误暴露。`Array.isArray` 判定失败会把建议无声清空
- **删代码要搜残留引用**：删掉变量后 `finally { clearTimeout(timer) }` 仍引用它 → **每次请求都抛 ReferenceError**，`node --check` 查不出
- **Wiki 文档**：每条结论标 `文件:行号`；必须区分「已实施」与「规划中」；代码与文档不一致时**如实标注**

## 6. 排查入口

| 症状 | 先看 |
|---|---|
| 改完代码行为没变 | 读算分离下必须重算；用分析页「诊断」按钮看 7 项检查 |
| 分析页一直显示规则版分析 | `categoryBreakdown` 只读不计算 → 需重新触发一次分析 |
| 建议整块消失 | 查 `meta.savingsSource`：`'unavailable'`（AI 没跑成）vs `'llm'`（跑了但没空间） |
| 定时任务没产出 | 查 `deferred` / `nextCursor`；查 cron 是否 7 段；查 `config.json` 有无注释 |
| 云端报 `Cannot find module` | 查 shared 副本是否同步（跑 `prepare:cf`） |

详细排查见 `docs/wiki/engineering/21-debugging.md`（若该页尚未生成，见 `tools/preflight.js` 的诊断面板）。

## 7. 大需求：先方案后编码

**先判大小**。命中**任意一条**就算「大需求」，必须走下面的流程：

- 新增或改动云函数 action / 云端逻辑
- 涉及业务口径（金额、比例、类目、订阅、分析规则）
- 改动散在多处的常量 / 字段（本项目同类常量常散 3~4 处）
- 新增页面 / 组件 / 功能
- 会连动测试、preflight 守卫或 Wiki 既有结论

**不算大、可直接做**：typo、注释、单文件小修、Wiki 小更新、纯回答问题。
**拿不准算不算大 → 按大需求处理**，宁可多确认一次。

**流程（用户确认 = 编码启动闸门，确认前不写业务代码）**：

1. 出**实现方案**：改哪些文件（对照 `docs/wiki/engineering/23-change-impact.md`）、每处怎么改、哪些测试会红、哪些地方会静默失效、Wiki 要不要同步
2. 出**TODO 清单**：按序可勾选的步骤；收尾必须含 `npm test` + `npm run preflight` 守卫，改 shared 还要含 `npm run prepare:cf`
3. 用户确认后，才按 TODO 顺序动手；方案需要调整时**回到第 1 步重新确认**，不要边改边悄悄扩大范围

（Claude Code 里可用计划模式 / EnterPlanMode 呈现方案，确认通过后再编码。）
