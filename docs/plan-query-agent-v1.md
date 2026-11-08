# 问数 Agent V1 实现方案（全新独立栈）

> 状态：**待用户确认**（AGENTS.md §7：确认前不写业务代码）。
> 依据：[prd-query-agent.md](prd-query-agent.md) v0.6（17 项决策全部确认）、`docs/wiki/tech/11-agent-harness.md`、`docs/wiki/engineering/23-change-impact.md`。
> 所有坐标均为 2026-11-08 grep 实测。

## 0. 目标与红线

**目标**：聊天页自然语言问账，代码算数字、模型只表述，多轮追问、流式输出、云端会话历史。

**两条红线（用户原话）**：

1. **不要破坏当前 LLM 能力** —— 记账 agent（bill-parse）与 insight agent（v3）的代码、prompt、工具、schema、降级链**零修改**。
2. **全新搭建一套问数 agent** —— 不复用 `shared/agent-harness/` 的循环/工具协议，独立实现 Agent 循环、工具层、prompt、校验；参考业界成熟对话 agent（Inflection Pi）的对话设计。

## 1. 总体架构：新栈与旧栈的边界

```
旧栈（零修改，红线）                    新栈（analysis-svc 内全新目录）
shared/agent-harness/                analysis-svc/query-agent/
  index.js（8 步链）                    loop.js         Agent 循环（3 工具轮 + 流式成文）
  llm-client.js（stream:false）         llm-stream.js   DeepSeek 流式客户端（独立实现）
  tools/index.js（11 工具）             tools.js        6 问数工具 + 参数校验
  agents/*.agent.js（2 个 agent）       prompts.js      system prompt + 协议
  schema-validator.js                   guard.js        数字引用校验 / 输出协议校验
  guardrail.js ← 只读复用 ──────────→   （desensitize / checkContentSafety /
  bill-stats.js ← 只读复用 ──────────→    estimateTokens / checkTokenBudget /
                                         normalizeBills / median / cv / centToYuanStr）
shared/db/index.js ← 只读复用 ────────→ data-access.js  分片取数（fetchAll + 按月切）
shared/util/* ← 只读复用 ─────────────→ anchors.js      锚点/农历解析
                                         session-store.js 会话历史（users 集合）
                                         job-store.js     job 文档（users 集合）
                                         usage.js         每日 50 次 + token 记账
```

**关键决定**：新栈代码全部放在 `cloudfunctions/analysis-svc/query-agent/`，**不进 shared**。理由：
- shared 是 5 个云函数的多副本，改一处散 10 份（`23-change-impact.md` §1）—— 新栈只需 analysis-svc 一份。
- 对旧 harness **只读 import**（guardrail 工具函数、bill-stats 纯函数、db 导出），import 不算修改。
- 唯一 shared 改动：`constants.js` 的 `CODE_VERSION` +1（版本戳纪律）。

**为什么放 analysis-svc 而不新建第 6 个云函数**：PRD §7.1 已定；且 db/统计/家庭口径都在 analysis-svc 侧（`resolveScope` 在 [analysis-svc/index.js:737](cloudfunctions/analysis-svc/index.js#L737)），复用成本最低；膨胀后再拆。

## 2. 模块设计

### 2.1 `query-agent/anchors.js` —— 锚点解析（纯函数，零 LLM）

模型只选枚举，日期由代码解析（延续「日期由代码锁定」纪律，[11-agent-harness.md §5.2](docs/wiki/tech/11-agent-harness.md#L203-L213)）：

```js
// 入参（工具 window 字段，模型只填枚举 + 可选年份）
this_month | last_month | this_year | last_year_same
last_n_months:N (N∈1..24) | last_n_days:N (N∈1..90)
solar_festival:double_11|double_12|june_18 + year
lunar_festival:spring_festival|mid_autumn|dragon_boat + year
```

- 解析出 `{from, to, label}`；`label` 是**证据卡口径文案**（如「按自然月 2026-11 计」「按 11.1-11.11 预售期计」），由代码生成，模型只引用不创作。
- 校验：`from ≤ to`、窗口 ≤ 24 个月、`last_n_months` 越界 → **报错回传模型**（不静默夹住，同 `validateArgs` 纪律）。
- 节日窗口硬编码表（决策 11/12）：双11 = 11.1-11.11、618 = 6.1-6.18、双12 = 12.1-12.12、春节 = 除夕-正月十五（农历）。
- **农历库**：`lunar-javascript`（6tail，纯 JS 零依赖，支持闰月/跨年/农历节日）—— 加进 [analysis-svc/package.json](cloudfunctions/analysis-svc/package.json) 依赖，**「云端安装依赖」部署**；本地测试需在 `cloudfunctions/analysis-svc` 目录 `npm install lunar-javascript` 装同一版本（PRD §9 已警示：农历库不能放 shared）。

### 2.2 `query-agent/query-stats.js` —— 计算层（纯函数，零 LLM）

所有金额/比例/涨跌在这里算（铁律）。复用 `shared/agent-harness/bill-stats.js` 的 `normalizeBills` / `median` / `cv` / `centToYuanStr`（单一数据源，不复制实现）：

| 函数 | 口径要点 |
|---|---|
| `calcWindowSummary(bills, window)` | 总额/笔数/日均/最大单笔/中位数 |
| `calcCategoryAgg(bills, {level, topN, rankBy})` | 金额 + 占比（代码算）+ 笔数；**`byAmount`/`byCount` 双维度排名**（Q3：笔数排名不得说成金额排名） |
| `calcTrendSeries(billsByMonth, window)` | 月度序列，缺失月补 0 |
| `calcCompare(billsA, billsB, {align, level})` | 变化额/变化率/**方向代码判**（±1% 一律 `flat`，同 [11-agent-harness.md §5.5](docs/wiki/tech/11-agent-harness.md#L249-L257) 口径）；Top 驱动类目分解（Q8 归因引擎）；`align:true` 局部同期对齐（按较短窗口的起止日对齐，等长再算率）；`hasYoYBaseline:false`（基线 <3 笔 → 指定降级文案「记账未满一年，明年此时可看同比」） |
| `calcTopBills(bills, {limit, sortBy})` | 极值明细（含日期/类目/备注） |
| `calcCrossMonthRecurring(bills, window)` | 跨月周期检测（**不复用** `calcRecurringPatterns` —— 它入参是单月数组，检不出月付订阅，[23-change-impact.md §3.3](docs/wiki/engineering/23-change-impact.md#L100-L111) 实测）；阈值参考：同末级类目 ≥3 笔、金额 CV、间隔 CV |

> ⚠️ `calcCompare` 即 PRD v3 F2「驱动因素分解」的**唯一实现**（决策：合并、禁止两套）。将来 insight 侧要用，直接 import 本模块。

### 2.3 `query-agent/data-access.js` —— 分片取数（不碰 LLM）

- **不走 `listBills`**（limit 硬上限 100，[12-data-model.md §6.1](docs/wiki/tech/12-data-model.md#L436-L445)）；**只用 `fetchAll`**（[db/index.js](cloudfunctions/shared/db/index.js)，`fetchAll(collection, where, hardCap)`）。
- **按月分片**：把窗口切成逐月，每月一次 `fetchAll(collection, {userId, delFlag:false, date: gte/lte})`，避开 2000 hardCap 静默截断（[12-data-model.md §6.2](docs/wiki/tech/12-data-model.md#L446-L464)）。
- **笔数预算**：先 `count`（同样按月），超 2000 → 要么继续分片拉全，要么**明确降级**「你的账单超过 X 笔，我按最近 N 笔统计」—— 绝不允许静默少算（PRD §7.4）。
- **家庭账本**：`family_bills` 同构取数（`{familyId, delFlag:false}`）；24 个月全窗口版家庭取数是**新函数**（现有 `familyRecentBillsByMonth` 只 6 个月）。账本归属走 analysis-svc 已有的 `resolveScope`（云端反查 profile，不信任前端，PRD §5.5）。
- **备注关键词过滤走应用侧**（JS filter），**不用 `db.RegExp`**（会毁掉 `test-persist.js`，[12-data-model.md §6.4](docs/wiki/tech/12-data-model.md#L476-L483)）。

### 2.4 `query-agent/tools.js` —— 6 工具（独立实现，不 import 旧 tools）

| 工具 | 入参 | 出参要点 |
|---|---|---|
| `query_summary` | `window` + 可选 `category` | 概览统计 + `evidence`（windowLabel/billCount/scopeLabel） |
| `query_category_breakdown` | `window` + `level`(1/2/3) + `topN` + `rankBy:amount\|count` | 金额/占比/笔数 + 双维度排名 |
| `query_trend` | `window` + 可选 `category` | 月度序列（补 0） |
| `query_compare` | `windowA` + `windowB` + `level` + `align` | 变化额/率/方向/驱动分解/`hasYoYBaseline` |
| `query_bills` | `window` + `sort` + `limit`(≤50) + `keyword` | 逐笔 + **代码预聚合 sum/count**（模型禁止自己加总） |
| `query_recurring` | `window` + 可选 `category` | 周期标签/次数/均价/稳定性 |

- **参数 schema 独立实现**：越界 → `{error}` 回传模型（模型唯一自我修复途径，同 [11-agent-harness.md §5.2](docs/wiki/tech/11-agent-harness.md#L203-L213) 纪律）；`additionalProperties:false`。
- ⚠️ 无 `account`/`source`/`weekday`/`hour` 入参（决策 8：V1 不加，模型收到此类问题按拒绝清单回答）。
- 每个工具返回都带 `evidence` 块（代码生成的口径文案），供引用校验与证据卡使用。

### 2.5 `query-agent/llm-stream.js` —— DeepSeek 流式客户端（独立实现）

- 不复用 `llm-client.js`（它固定 `stream:false`，[11-agent-harness.md §2](docs/wiki/tech/11-agent-harness.md#L74-L84)）。
- 基于 Node 内置 `https`（**云端没有全局 fetch**，[http-client.js:6-14](cloudfunctions/shared/util/http-client.js#L6-L14) 的教训），支持：
  - `chatOnce({messages, tools, jsonMode})` —— 工具轮用，非流式（缓冲完整响应）。
  - `chatStream({messages, onDelta})` —— 成文轮用，`stream:true`，按 SSE `data:` 行解析增量；`onDelta` 逐段回调。
- 成文轮请求**不带 tools 字段**（或 `tool_choice:'none'`）；防御性处理：若仍收到 `tool_calls` delta，累积并抛错回退非流式重跑。
- 请求体对齐旧客户端纪律：`model: deepseek-chat`、`user: makeUserId(openid)` 哈希（不传原始 openid）、超时 destroy。

### 2.6 `query-agent/loop.js` —— Agent 循环（新栈核心）

```
ask(question, sessionId, scope)
  ① usage.checkDailyLimit（50 次/日，决策 15）→ 超限立即返回 error
  ② 组装 messages：system(prompts) + 会话历史（≤20 轮，旧轮先截断） + 当前问题
  ③ 工具循环（maxToolRounds=3，每轮 timeout 5000ms，总预算 15000ms —— 不低过 insight 每轮 5000，v3 血泪史 [23-change-impact.md §3.6](docs/wiki/engineering/23-change-impact.md#L139)）：
       LLM → tool_calls? → tools.execute → 结果回传（报错也回传）
       LLM → clarify JSON → 结束（状态 clarify，前端渲染候选 chips）
       LLM → final JSON → 进入成文
  ④ 成文轮：llm-stream.chatStream → 增量节流写 job 文档（每 300-500ms 或 ~50 token）
  ⑤ guard.checkCitations：numbers[].value 必须出现在工具返回值里
       不通过 → 带反馈重生成（≤2 次，重新流式）→ 仍不通过 → error「AI 暂不可用」（零假数字）
  ⑥ session-store.appendRound（问题 + 回答摘要）；job 文档置 done
  ⑦ 置信度由**代码判定**（ThoughtSpot 答案分级借鉴）：evidence.billCount < 3 或窗口数据不全 → `confidence:'low'`，否则 `normal`；前端弱化呈现而非隐藏
  兜底：任何异常 → job 文档置 error；job 带 expiresAt（45s，超时 poll 返回 JOB_LOST）
```

- **Pi 式澄清即对话**：类目模糊不猜，直接返回 `{clarify:{question, options}}`，用户点 chip 即追问（一轮澄清失败再问一次，决策 10）。
- **时间模糊走快路径**：按默认口径执行（「最近」=近 7 天），答案带代码生成的口径 label，不反问。

### 2.7 `query-agent/prompts.js` —— Prompt 协议（Pi 借鉴点）

**人设块（Pi 式，一次性写进 system prompt）**：
> 你是「随口记」的账务问答助手，像一位熟悉用户账本的可靠朋友：直接、诚实、温和、不评判、不谄媚。你只说账单里**真实存在**的数字，每个数字都能指出出处；不确定就反问，答不上就明说，绝不编造。

**借鉴 Inflection Pi 的 5 点**（注明哪些不学）：

| Pi 特点 | 问数版落地 | 不学的部分 |
|---|---|---|
| 跨会话记忆 | 云端会话历史（10 会话 × 20 轮，决策 17） | 不做开放域闲聊记忆 |
| 自然追问（clarifying questions） | clarify 协议 + 候选 chips；时间模糊默认执行不打断（决策 10） | 不无限追问，≤2 轮澄清 |
| 温和诚实的人设 | 人设块 + 不评判措辞铁律（PRD v3 坑 #9） | 不谄媚、不给建议 |
| 主动建议下一步 | 回答末尾附 1-2 条 `suggestions[]` 追问气泡（前端渲染可点击） | 不主动开启新话题 |
| 体面拒绝 | 拒绝清单 + 一句原因（PRD §5.4/决策 6/7/8） | 不编造兜底答案 |

**其余协议**（全部进 system prompt）：
- 铁律：金额/比例/涨跌**一律引用工具返回值**，禁止自己算；「能一次问完的工具调用不要拆多次」（PRD §7.6）。
- 输出协议（final JSON）：`{answer, numbers:[{value, source}], evidence:{...工具返回的原样引用}, suggestions:[...]}`。
- 拒绝清单：建议类（引导分析页）、成员间比较（只聚合）、收入/预算/预测、账户/来源/星期/时段筛选、超 24 个月窗口。
- 澄清协议：类目模糊 → `{clarify:{question, options}}`。
- 无数据诚实降级：明说「X 时间窗内没有 Y 的记录」+ 实际笔数。

### 2.8 `query-agent/guard.js` —— 数字引用校验（新写，不复用旧 schema-validator）

- 结构化引用比对：`numbers[].value` 与所有工具返回值（stringify）逐项匹配 —— 比旧「正文数字白名单」误伤率低（PRD §5.2 已论证）。
- 校验 `clarify` / `final` JSON 结构（旧 schema-validator 只认 `properties`，实际不校验 —— [23-change-impact.md §3.5](docs/wiki/engineering/23-change-impact.md#L121-L128) 实测，新写必须真校验）。
- 复用（只读 import）`guardrail.desensitize` / `checkContentSafety`（注入防护）/ `estimateTokens` / `checkTokenBudget`。

### 2.9 `query-agent/session-store.js` —— 会话历史（决策 4/17）

- 文档：`users/${openid}_askhistory_${sessionId}`；字段 `{userId, sessionId, rounds:[{q, a, ts}], updateTime}`。
- 读时校验 `userId === openid`（[12-data-model.md §3.5](docs/wiki/tech/12-data-model.md#L237-L243) 双保险）；**顶层不得有 `month`**（防 `listPendingInsightUsers` 每日扫描捞走，[§3.8](docs/wiki/tech/12-data-model.md#L290-L292)）。
- 保留策略（决策 17）：最近 10 个会话 × 每会话 20 轮；每次新 `ask` 惰性清理该用户 7 天未更新的会话。无定时器。
- 前端只传 sessionId；新会话由云端生成并随首答返回。

### 2.10 `query-agent/job-store.js` —— job 文档（决策 16 路线 B）

- 文档：`users/${openid}_askjob_${jobId}`；状态机 `running → done | clarify | error`；字段含 `answerChunks`（增量节流 300-500ms/~50 token 写）、`numbers`、`evidence`、`suggestions`、`confidence`（`normal|low`，代码据有效笔数判定）、`expiresAt`。
- 完成/失败后立即 `remove`；每次新 `ask` 惰性清理该用户 1 小时前残留。
- `pollAsk` 读时校验 `userId === openid`，不匹配返回空（同 insight 读时校验）；`now > expiresAt` → `JOB_LOST`（同 ASR `JOB_EXPIRED` 语义）。

### 2.11 `query-agent/usage.js` —— 每日限额与 token 记账（决策 15）

- 文档：`users/${openid}_askusage`；字段 `{userId, date:'YYYY-MM-DD'(CST), count, tokens}`。⚠️ 字段名用 `date` **不用 `month`**（同 §2.9 坑）。
- `ask` 入口：`count ≥ 50` → `{ok:false, error:'ASK_DAILY_LIMIT'}`（前端文案「今日问数次数已达上限，明天再来」）。
- 每轮 LLM 前后累计 `tokens`（响应 `usage` 字段），`checkTokenBudget(tokens, DAILY_TOKEN_BUDGET)` 熔断（复用 insight 同款预算常量，M5 调参）。
- 计数用读改写；并发下可能 ±1 次溢出 —— 可接受（token 预算熔断是硬兜底），注释说明。

### 2.12 `query-agent/tracer.js` —— 内置 trace（对齐老栈体系，LangSmith 类问题的 V1 答案）

- 薄封装：内部复用 `shared/agent-harness/tracer.js` 的 `logEvent`（纯 crypto 实现、零 harness 依赖，**import 不算破坏红线，老文件零修改**）；事件名 `ask_*` 前缀与 insight 链区分；共用 `DEBUG_TRACE` 开关。
- 事件模型与载荷纪律见详设 §15.3：敏感内容一律 `hashInput`/截断，金额不进原文。
- **trace 随 job 文档持久化**：`finalize` 时把末 40 条事件 + `ask_summary` 写进 job 文档 `trace` 字段 —— 兜底「后台任务中途被 40s 预算杀死、内存 trace 全丢」。
- `tools/trace-view.js` 加 `ask_*` 解析段（dev 工具，不触红线）。
- **外部导出（LangSmith/Langfuse/OTel）V1 默认关闭**，只留 `TRACE_EXPORT_URL` + `TRACE_EXPORT_FORMAT` 适配口（Node https、异步失败静默）；是否启用 = 数据出境口径，待产品确认（V1.1）。

## 3. 云端 action 与前端

### 3.1 analysis-svc 两个新 action（additive，不动 insight 路径）

在 [analysis-svc/index.js:85-98](cloudfunctions/analysis-svc/index.js#L85-L98) 的 switch 加两个 case（**只加不改**）：

- `ask {question, sessionId?, ledger?}`：校验 → 每日限额 → 生成 jobId → 写 job 文档（running）→ **立即返回 `{jobId}`（毫秒级，躲 3 秒网关）** → 后台继续跑 loop（事件循环保持忙碌，同 asr-svc 后台识别模式；整体必须 ≤ config.json timeout 40s，预算见 §5 风险表）。
- `pollAsk {jobId}`：读 job 文档（userId 校验）→ `{status, answerChunks, numbers, evidence, suggestions, clarify, error}`；前端每 500ms 轮询。

### 3.2 前端

| 文件 | 改动 |
|---|---|
| `miniprogram/app.json` | 注册 `pages/query-chat/index`（**命名 index.\*，防 check-frontend 整页跳过**，[23-change-impact.md §6.6.3](docs/wiki/engineering/23-change-impact.md#L298-L304)） |
| `miniprogram/pages/query-chat/index.*`（新） | 聊天页：消息列表 + 输入框 + 语音按钮 + 空态 4-6 个预置问题气泡（决策 13，走同一问答管道）+ 澄清 chips + 追问建议气泡 |
| `miniprogram/pages/index/index.*` | 首页卡片入口 → `navigateTo` 聊天页（决策 2：不占底部 tab） |
| `miniprogram/utils/cloud.js` | `ask` / `pollAsk` 封装 + `EXPECTED_CODE_VERSION` 同步（[cloud.js:21](miniprogram/utils/cloud.js#L21)） |

**渲染纪律**（决策 16）：
- 分段渲染：已完成的句子立即显示，未完成段显示光标；**数字证据卡只在 `status:'done'` 后显示**（防半截数字被误读）。
- `confidence:'low'`（有效笔数 <3 或窗口数据不全）：答案正常显示，证据卡附灰字「数据较少，结论仅供参考」—— 借鉴 ThoughtSpot 答案分级：弱化呈现，不隐藏答案。
- 流式中途刷新 → 凭本地 sessionId + 未完成的 jobId 尝试续取，拿不到就明确提示重试。
- 降级兜底：job 缺失/超时 → 前端退化为「直接等待完整答案」（`ask` 第二段仍落最终结果）；LLM 不可用 → 「AI 暂不可用，请稍后重试」，**绝无假数字兜底**（问数没有模板答案，PRD §8）。
- 语音：**复用 `utils/voice.js` 零修改**（VoiceInput 的 `onResult` 接到输入框 → 同一问答管道）。

## 4. 测试与守卫

### 4.1 新增测试（挂在根 [package.json](package.json) `test` 链）

| 测试 | 覆盖 |
|---|---|
| `analysis-svc/query-agent/__tests__/query-stats.test.js` | 聚合/占比/双维度排名/趋势补 0/方向 ±1% flat/对齐/驱动分解/`hasYoYBaseline`/跨月周期（月付检出，单月检不出对照）/2000 笔分片边界 |
| `analysis-svc/query-agent/__tests__/anchors.test.js` | 锚点枚举解析/窗口上限越界报错/节日窗口表（双11 11.1-11.11、春节除夕-正月十五）/农历闰月/跨年/春节年份边界 |
| `analysis-svc/query-agent/__tests__/guard.test.js` | 引用校验（对上/对不上/剔除重试）/clarify 与 final schema 真校验/注入防护 |
| `analysis-svc/query-agent/__tests__/session-store.test.js` | 10×20 保留/7 天惰性清理/userId 越权读/顶层无 `month` |
| `analysis-svc/query-agent/__tests__/job-store.test.js` | 状态机/增量节流/完成后删除/1h 残留清理/越权 poll 返回空/JOB_LOST |
| `analysis-svc/query-agent/__tests__/loop.mock.test.js` | mock LLM 冒烟：澄清路径/工具轮路径/轮次上限/工具报错回传/引用校验失败重试/成文流式/confidence 判定 |
| `analysis-svc/query-agent/__tests__/eval-questions.js` | **BIRD 式固定问题集（长期回归资产）**：断言工具选择/锚点参数/排名维度正确，不靠人工感觉 |

### 4.2 既有守卫（改动后必须全绿）

- `npm test`：既有用例**全部不红**（红线：旧 harness 零修改 → `bill-stats.test.js:502` 等不受影响）。
- `npm run preflight`：版本戳段（CODE_VERSION + EXPECTED 同步后绿）、副本漂移段（prepare:cf 后绿）、SDK 守卫。
- `npm run check:ui`：新页面 WXML 绑定字段必须能在全链路 JS 中找到（[23-change-impact.md §5.4](docs/wiki/engineering/23-change-impact.md#L180-L184)）。
- `edit-bill.test.js:93-98` 反向断言：**不碰 detail 编辑面板**，不会红。

## 5. 关键风险与防线（按「漏一处就静默出错」排）

| # | 风险 | 防线 |
|---|---|---|
| 1 | **后台任务受 40s 实例预算**：ask 返回后靠事件循环保持运行，超时即死 → job 卡 running | 预算 ≤35s（取数 5s + 3×5s 工具轮 + 成文 5s + 余量）；job `expiresAt=45s` → poll 返回 `JOB_LOST` 前端提示重试 |
| 2 | 云端无全局 fetch → 流式客户端 `ReferenceError` | `llm-stream.js` 全用 Node `https`（http-client 教训） |
| 3 | `fetchAll` 2000 硬顶静默截断 / `listBills` limit 100 | 按月分片 + 笔数预算，超限明确降级文案，绝不静默少算 |
| 4 | `db.RegExp` 毁掉 `test-persist.js` | 备注关键词一律应用侧过滤 |
| 5 | 新文档顶层 `month` → 被 `listPendingInsightUsers` 每日扫描捞走（askjob/askhistory/askusage 三种文档同坑） | 字段纪律写进 store 函数 + 单测断言 |
| 6 | 农历库本地云端版本不一致 | 本地 `npm install lunar-javascript` 与 package.json 版本锁死；锚点单测全过才部署 |
| 7 | 流式成文轮意外返回 tool_calls | 成文轮不带 tools；防御性累积 delta 报错 → 非流式重跑 |
| 8 | 流式增量写 DB 太密 → 成本/限流 | 节流 300-500ms 或 ~50 token 写一次（决策 16） |
| 9 | `saveInsight` 字段白名单坑 | **不落 insight**：问数结果与 job/会话文档独立，不碰 `saveInsight`/`readInsight` |
| 10 | 引用校验失败重生成时前端已渲染半截 | 重生成时 job 文档带 generation 序号重置 answerChunks，前端整段重渲染（罕见路径） |
| 11 | 部署漏「云端安装依赖」→ lunar 库缺失 | 部署四步 + 人工步骤清单（AGENTS.md §2） |
| 12 | 版本戳不同步 | CODE_VERSION +1（[constants.js](cloudfunctions/shared/util/constants.js)）+ `EXPECTED_CODE_VERSION` 同步（[cloud.js:21](miniprogram/utils/cloud.js#L21)）+ `npm run prepare:cf` |
| 13 | 埋点成为故障源 / 账单数据外发 | 事件一律 hashInput/截断，金额不进原文；trace 随 job 文档（末 40 条）持久化；外部导出默认关（`TRACE_EXPORT_URL` 缺省零上报），异步失败静默；`DEBUG_TRACE` 沿用「排查完关闭并重新部署」纪律 |

## 6. 文件清单

**新建（`cloudfunctions/analysis-svc/query-agent/`）**：`anchors.js`、`query-stats.js`、`data-access.js`、`tools.js`、`llm-stream.js`、`loop.js`、`prompts.js`、`guard.js`、`session-store.js`、`job-store.js`、`usage.js`、`tracer.js`、`index.js`（模块入口）+ `__tests__/` 6 个。

**修改（5 处 + 3 前端）**：
1. `cloudfunctions/analysis-svc/index.js` —— switch 加 `ask`/`pollAsk` 两个 case（additive）
2. `cloudfunctions/analysis-svc/package.json` —— 加 `lunar-javascript`
3. `cloudfunctions/shared/util/constants.js` —— `CODE_VERSION` +1（**唯一 shared 改动**）
4. `package.json` —— `test` 链追加新测试
5. `tools/trace-view.js` —— 加 `ask_*` 事件解析段（dev 工具，不触红线）
6. `miniprogram/utils/cloud.js` —— `ask`/`pollAsk` 封装 + `EXPECTED_CODE_VERSION`
7. `miniprogram/app.json` —— 注册新页面
8. `miniprogram/pages/query-chat/index.{js,wxml,wxss,json}`（新）+ `pages/index/*` 入口卡片

**不动（红线清单）**：`shared/agent-harness/` 全部 11 个文件、`bill-svc`/`user-svc`/`category-svc`/`asr-svc` 全部、`utils/voice.js`、`REQUIRED_COLLECTIONS`、analysis-svc 的 insight 路径（refreshInsight/dailyInsight/computeInsight）与 `config.json` 触发器。

## 7. 里程碑与 TODO

### M1 计算层（先纯函数后取数）
- [ ] `query-agent/anchors.js`：锚点解析 + 农历库接入 + 节日窗口表（analysis-svc package.json 加依赖，本地 npm install）
- [ ] `query-agent/query-stats.js`：7 个 calc 纯函数（复用 normalizeBills/median/cv/centToYuanStr）
- [ ] `query-agent/data-access.js`：按月分片取数 + 笔数预算 + 家庭全窗口取数
- [ ] `__tests__/query-stats.test.js` + `anchors.test.js` 全绿
- [ ] **出口**：`node analysis-svc/query-agent/__tests__/*.test.js` 全过

### M2 Agent 循环（新栈核心，mock 驱动）
- [ ] `llm-stream.js`：非流式 chatOnce + 流式 chatStream（SSE 解析 + 增量回调 + 超时 destroy）
- [ ] `tools.js`：6 工具声明/参数 schema/执行分发/evidence 块
- [ ] `prompts.js`：人设块 + 5 条 Pi 借鉴协议 + 输出协议 + 拒绝清单 + 澄清协议
- [ ] `guard.js`：数字引用校验 + 输出协议真校验
- [ ] `loop.js`：3 轮工具循环 + 澄清 + 流式成文 + 引用校验重试
- [ ] `session-store.js` / `job-store.js` / `usage.js` + 对应 3 个测试
- [ ] `tracer.js`：`ask_*` 事件模型（详设 §15.3）+ finalize 落 job 文档 trace（末 40 条 + ask_summary）+ `tools/trace-view.js` 解析段
- [ ] `loop.mock.test.js` 冒烟全绿 + `eval-questions.js` 固定问题集落地（BIRD 式：断言工具选择/参数，作长期回归资产）
- [ ] **出口**：mock LLM 下「金额聚合/对比/明细/澄清/拒绝」5 类问题走通，eval-questions 调对率达标

### M3 云端 action + 前端聊天页
- [ ] analysis-svc 加 `ask`/`pollAsk`（复用 `resolveScope`；日志/降级语义齐全）
- [ ] `constants.js` CODE_VERSION +1 + `cloud.js` EXPECTED 同步 + `npm run prepare:cf`
- [ ] `utils/cloud.js` 封装 + 新页面 `pages/query-chat/index.*`（聊天 UI/分段渲染/证据卡/骨架态/空态预置气泡/澄清 chips/建议气泡）+ 首页卡片入口 + app.json 注册
- [ ] 根 package.json test 链追加新测试
- [ ] **出口**：`npm test` + `npm run preflight` + `npm run check:ui` 全绿 + 真机抽检（预置气泡点击即问）

### M4 语音 + 多轮 + 限额
- [ ] 语音按钮复用 `voice.js`（零修改）接输入框
- [ ] sessionId 本地存取 + 云端会话历史链路（多轮条件继承验证）
- [ ] 每日 50 次 + token 记账熔断
- [ ] **出口**：语音问数端到端 ≤15s；第 51 次提问被拒文案正确；刷新/重进凭 sessionId 续聊

### M5 调参 + 文档同步 + 部署
- [ ] 真机延迟/成本实测，限额与超时调参；评估 **Vanna 式自查轮**（工具结果回传后模型自查是否满足问题）是否纳入 —— +1 轮成本换更少漏答，V1 不加
- [ ] **部署四步**：CODE_VERSION 已在 M3 改 → 右键 analysis-svc「上传并部署：**云端安装依赖**」（lunar 库必需）—— 仅人工
- [ ] Wiki 同步（代码落地后）：新增 `docs/wiki/tech/14-query-agent.md`（新栈架构/6 工具/会话与 job 文档纪律/坑，全部标 文件:行号、标「已实施」）；更新 `10-architecture.md` action 表、`12-data-model.md` users 集合文档结构、`llms.txt` 索引
- [ ] **出口**：NFR 达标（≤10s P95）后全量

## 8. 业界参考与借鉴（2026-11-08 补充）

| 参考 | 借鉴点 | 落地位置 |
|---|---|---|
| Monarch Money AI Assistant | 逐条回答带交易引用、无数据明说 | 证据卡 + 诚实降级（PRD §5.2/§5.3） |
| ThoughtSpot Sage | Trusted Answers：未经验证数字绝不展示；**答案分级** | 引用校验 + `confidence` 档（§2.10/§3.2） |
| Tableau Pulse Trust Layer | LLM 输出必须 grounded 在认证语义层 | 铁律 + 工具聚合结果唯一数据源（PRD §5.1） |
| Gemini in Looker | LookML 语义层防幻觉 | 模型只见聚合结果、只见带 ID 类目树 |
| Wren AI | 语义层 + 多轮澄清对话 | clarify 协议（§2.6/§2.7） |
| Vanna | RAG 注入 schema + **自校正循环** | 类目树注入（防幻觉）；自查轮留 M5 评估 |
| LangChain SQL toolkit | 最小工具集 + 查询前 validate | 6 工具 + validateArgs 报错回传 |
| BIRD / Spider 基准 | 执行准确率评测，不靠人工感觉 | `eval-questions.js` 固定问题集（§4.1/M2） |
| Cleo / Pi | 对话人设与记忆 | 人设块 + 会话历史（§2.7/§2.9）；数字处理不学 Cleo |

**与 text-to-SQL 类的关键差异**：业界主流是「NL→SQL 自由查询 + 后验校验」，本项目走 ThoughtSpot 的 **constrained search** 路线 —— 模型只选锚点枚举与工具参数，连查询语句的权都没有。自由度更低，但幻觉面更小，且与「日期由代码锁定」纪律一致（[11-agent-harness.md §5.2](docs/wiki/tech/11-agent-harness.md#L203-L213)）。

## 9. 显式不做（本次范围外）

- ❌ insight 侧 13 个月窗口改造（PRD v3 M1 的 `ANALYSIS_MONTHS 6→13`）—— **本次不动**（红线：不破坏当前 LLM 能力）。问数 Q2 同比用自己 24 个月窗口即可答；insight 侧合并时机需与产品再确认。
- ❌ Q10 异常发现（与 PRD v3 F4 同步，不在 V1）
- ❌ 问答历史列表/搜索 UI（V1.1，决策已定）
- ❌ 账户/来源/星期/时段筛选、建议类、成员比较、收入/预算/预测（PRD §10）
- ❌ 新集合：不建任何集合，`REQUIRED_COLLECTIONS` 不变
- ❌ LangSmith/Langfuse/OTel 外部导出：V1 默认关闭，只留 `TRACE_EXPORT_URL` 适配口；是否启用 = 数据出境口径，待产品确认（V1.1）
