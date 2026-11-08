# 问数 Agent V1 详细设计

> 状态：**设计稿，待评审确认后进入编码**（AGENTS.md §7）。
> 上游：[prd-query-agent.md](prd-query-agent.md)（v0.6，17 项决策）、[plan-query-agent-v1.md](plan-query-agent-v1.md)（实现方案）。
> 本详设把函数签名、数据结构、协议 JSON、状态机、prompt 全文全部钉死。坐标均为 2026-11-08 grep 实测。
>
> **当前版本戳状态**：`CODE_VERSION`（[constants.js:183](cloudfunctions/shared/util/constants.js#L183)）与 `EXPECTED_CODE_VERSION`（[cloud.js:21](miniprogram/utils/cloud.js#L21)）当前均为 `20261108-01` 且同步。实施时两处同步 +1 → `20261108-02`。

## 1. 模块总览与依赖边界

```
analysis-svc/query-agent/
  constants.js     ← 新栈自有预算常量（不碰 shared GUARDRAIL）
  anchors.js       ← lunar-javascript（npm 依赖）
  query-stats.js   ← import shared bill-stats（normalizeBills/median/cv/centToYuanStr，只读）
  data-access.js   ← import shared db（fetchAll/getProfile/…，只读）
  tools.js         ← query-stats + data-access + anchors
  llm-stream.js    ← Node https（不 import llm-client）
  prompts.js       ← 无依赖（纯文本/JSON）
  guard.js         ← import shared guardrail（desensitize/checkContentSafety/estimateTokens/checkTokenBudget，只读）
  loop.js          ← 编排以上全部
  session-store.js ┐
  job-store.js     ├→ shared db（users 集合，自持白名单）
  usage.js         ┘
  index.js         ← 对 analysis-svc 暴露 runAsk / pollAsk
```

**红线**：本目录任何文件不得 import `shared/agent-harness/index.js`、`llm-client.js`、`tools/index.js`、`agents/*`、`schema-validator.js`。只读 import 白名单：`shared/agent-harness/bill-stats.js`、`shared/agent-harness/guardrail.js`、`shared/db/index.js`、`shared/util/*`。

## 2. 常量（`query-agent/constants.js`）

```js
module.exports = {
  ASK_MAX_TOOL_ROUNDS: 3,        // 工具轮上限（PRD §7.6）
  ASK_ROUND_TIMEOUT_MS: 5000,    // 每轮超时（= insight 每轮 5000，不低）
  ASK_FINALIZE_TIMEOUT_MS: 8000, // 流式成文轮超时
  ASK_TOTAL_BUDGET_MS: 35000,    // 硬总预算（config.json timeout=40 留 5s 余量）
  ASK_JOB_TTL_MS: 45000,         // job expiresAt = 创建 + 45s
  ASK_DAILY_LIMIT: 50,           // 决策 15
  ASK_QUESTION_MAX_CHARS: 200,   // 问题长度上限
  ASK_HISTORY_MAX_ROUNDS: 20,    // 每会话轮数上限（决策 17）
  ASK_HISTORY_MAX_SESSIONS: 10,  // 会话数上限（决策 17）
  ASK_HISTORY_TTL_MS: 7 * 86400000, // 7 天未更新惰性清理（决策 17）
  ASK_JOB_LAZY_CLEAN_MS: 3600000,   // job 残留 1h 惰性清理
  ASK_STREAM_FLUSH_MS: 400,      // 增量节流（决策 16）
  ASK_STREAM_FLUSH_CHARS: 100,   // ~50 token 中文字符估算
  ASK_WINDOW_MAX_MONTHS: 24,     // 决策 14
  ASK_RECURRING_MIN_OCCURRENCES: 3, // 跨月周期 ≥3 笔
  ASK_CATEGORY_LEVELS: [1, 2, 3]
};
```

## 3. 数据模型（3 种文档，全部复用 `users` 集合，不新建集合）

### 3.1 job 文档 `users/${openid}_askjob_${jobId}`

```js
{
  userId, jobId,
  status: 'running' | 'done' | 'clarify' | 'error',
  gen: 1,                 // 重生成序号；引用校验重试时 +1，前端据变化整段重渲染
  chunks: [],             // 流式增量字符串数组（节流写入，见 §8）
  answer: '',             // status='done' 时合并后的完整答案
  numbers: [],            // 引用校验通过的 numbers（§10）
  evidence: {},           // 代码生成的口径块（§7），模型只引用
  suggestions: [],        // 追问建议 ≤2 条
  confidence: 'normal' | 'low',
  clarify: { question: '', options: [] },  // status='clarify' 时
  error: '', reason: '',  // status='error'；reason 取 §13 原因码
  expiresAt,              // 创建 + ASK_JOB_TTL_MS
  createTime, updateTime
}
```

纪律：**顶层不得有 `month`**（`listPendingInsightUsers` 的 `where({month})` 每日扫描，[12-data-model.md §3.8](docs/wiki/tech/12-data-model.md#L290-L292)）；完成/失败后立即 `remove`；每次新 `ask` 惰性清理该用户 1 小时前残留（`createTime < now-1h` 的 `_askjob_` 文档）；读时校验 `userId === openid`，不匹配按不存在处理（同 insight 读时校验 [§3.5](docs/wiki/tech/12-data-model.md#L237-L243)）。

### 3.2 会话历史文档 `users/${openid}_askhistory_${sessionId}`

```js
{ userId, sessionId,
  rounds: [{ q, a, ts }],  // ≤20 轮，超了丢最旧
  updateTime }
```

纪律：同 §3.1（无顶层 `month`、读时校验）；保留策略（决策 17）：每次新 `ask` 惰性执行——① 删该用户 `updateTime < now-7d` 的会话；② 若剩余会话数 > 10，按 `updateTime` 升序删最旧的。会话不绑定账本（§12 逐问 resolveScope）。

### 3.3 用量文档 `users/${openid}_askusage`

```js
{ userId, date: 'YYYY-MM-DD',  // 东八区（⚠ 字段名 date，不用 month）
  count: 0, tokens: 0 }
```

纪律：`date ≠ 今天` → 重置 count/tokens 再写入；计数读改写（并发 ±1 溢出可接受，token 熔断是硬兜底）；tokens 累计 LLM 响应 `usage.total_tokens`，每轮调用前 `guardrail.checkTokenBudget(tokens, TOKEN_BUDGET_PER_USER_DAY)`（[constants.js:158](cloudfunctions/shared/util/constants.js#L158)，与 insight 共用日预算 200000）。

## 4. 锚点解析 `anchors.js`

```js
/** spec → {from:'YYYY-MM-DD', to:'YYYY-MM-DD', label:string}
 *  非法/越界 → {error:{code:'ANCHOR_INVALID', message}} —— 报错回传模型，不静默夹住 */
resolveWindow(spec, todayCST)
// spec 枚举（模型只选这些）：
//   this_month | last_month | this_year | last_year_same
//   last_n_months:N   N∈[1,24]   （滚动月）
//   last_n_days:N     N∈[1,90]
//   solar_festival:double_11[:year] | june_18[:year] | double_12[:year]
//   lunar_festival:spring_festival[:year] | mid_autumn[:year] | dragon_boat[:year]

/** 公历节日窗口表（决策 11/12） */
FESTIVAL_WINDOWS = {
  double_11: { m1:11, d1:1,  m2:11, d2:11, label:'按 11.1-11.11 预售期计' },
  june_18:   { m1:6,  d1:1,  m2:6,  d2:18, label:'按 6.1-6.18 计' },
  double_12: { m1:12, d1:1,  m2:12, d2:12, label:'按 12.1-12.12 计' }
};

/** 农历：lunar-javascript 的 Solar/Lunar 换算 → 春节=除夕(腊月三十/廿九)~正月十五 */
lunarFestivalRange(name, year)   // 模型不自己算农历日期（决策 5）
```

**时间基准纪律（⚠ 本项目踩过实坑，必须显式规定）**：

- `todayCST` 是 `'YYYY-MM-DD'`（东八区），**由 ask 入口捕获一次**，贯穿锚点解析 / 节日缺省年份 / 用量计数，整次请求唯一基准 —— 不在各函数里各自 `new Date()`，防跨午夜不一致。
- 取法：复用 [shared/util/date.js](cloudfunctions/shared/util/date.js) 的 `toDateStrCST(Date.now())`（`:72`）。**云函数运行时是 UTC**，`new Date()` 的 getFullYear/getMonth 是 UTC 语义——直接用会踩「定时器生成昨天账单」同款坑（[23-change-impact §6.5.3](docs/wiki/engineering/23-change-impact.md#L225-L230) 实测）。
- 账单 `date` 字段本身是东八区日期（用户记账口径），窗口边界必须用 CST 计算才能与账单对齐：北京时间 00:30 问「今天花了多少」，`from=to=今天 CST`，不能漂到昨天。
- 节日锚点缺年份 → 用 `todayCST` 的年份（「双十一花了多少」= 今年双十一；1 月问「去年春节」由模型选 `:2025` 年份参数）。
- `resolveWindow(spec, todayCST)` 是纯函数：测试直接传参覆盖跨午夜/跨年边界，不 mock 时钟。

- `last_n_months`/窗口校验：`from ≤ to`、跨度 ≤ 24 个月，越界报错回传。
- label 即证据卡口径文案，**代码生成**（如「按近 7 天滚动计」「按 2026-01-01 至 2026-10-31 计」），模型只引用不创作。
- 农历库依赖：`cloudfunctions/analysis-svc/package.json` 加 `"lunar-javascript": "^1.7.x"`（锁具体版本号）；本地测试 `cd cloudfunctions/analysis-svc && npm install` 装同版本；部署必须「云端安装依赖」。

## 5. 计算层 `query-stats.js`（纯函数，零 LLM；金额内部一律整数分）

```js
calcWindowSummary(bills, win) → {
  sumCent, count, avgCent, maxBill:{date,amountCent,categoryPath,note}, medianCent }
calcCategoryAgg(bills, {level, topN, rankBy}) → {
  totalCent,
  items: [{ path, sumCent, pct, count }],          // pct 代码算
  rankedBy: rankBy,                                 // 'amount'|'count'，模型不得混说（Q3）
  byAmount: [...], byCount: [...] }                 // 双维度并列返回
calcTrendSeries(billsByMonth) → { series: [{ month, sumCent, count }] }  // 缺失月补 0
calcCompare(billsA, billsB, {align, level}) → {
  deltaCent, deltaRate,                              // rate 基于等长窗口（align 后）
  direction: 'up'|'down'|'flat',                     // ±1% 一律 flat（代码判）
  drivers: [{ path, deltaCent, contributionPct }],   // Top 驱动分解（Q8 引擎）
  hasYoYBaseline: true|false,                        // 基线 <3 笔 → false + 指定文案
  aligned, alignNote }
calcTopBills(bills, {limit, sortBy}) → {
  items: [{ date, amountCent, categoryPath, note }], sumCent, count }   // sum/count 代码预聚合
calcCrossMonthRecurring(bills) → {
  patterns: [{ categoryPath, count, avgCent, cv, gapDays, tag:'monthly'|'weekly'|'other' }] }
  // ⚠ 不复用 calcRecurringPatterns（单月入参检不出月付，23-change-impact §3.3）；
  //   跨月窗口 ≥3 笔 + 金额 CV ≤0.25 + 间隔规整
```

- 复用（只读 import）：`normalizeBills`（脏数据剔除）、`median`/`cv`、`centToYuanStr`（对外转元字符串，如 `'842.50'`）。
- `calcCompare` 是 PRD v3 F2 的唯一实现；insight 未来直接 import，禁止第二套。

## 6. 取数层 `data-access.js`

```js
/** 按月分片拉全，绕开 fetchAll 2000 硬顶（12-data-model §6.2）与 listBills limit 100（§6.1） */
async fetchWindowBills(scope, win) → {
  bills, byMonth: { 'YYYY-MM': [...] }, totalCount,
  truncated: boolean,          // 单月 >2000 且按日分片仍超 → true（不静默）
  note: '' }                    // truncated 时给降级文案：「账单超过 X 笔，按最近 N 笔统计」
// 算法：
//   for each month in 窗口:
//     月内 fetchAll(collection, {userId|familyId, delFlag:false, date: gte(月初).and(lte(月末))})
//     该月 count > 2000 → 改按日循环 fetchAll
//     按日仍超 2000（极端）→ truncated=true，按 date 序取最近 2000，附 note
// 过滤：备注关键词一律 JS filter（禁用 db.RegExp，12-data-model §6.4）
// scope: resolveScope 结果 {kind:'personal',openid} | {kind:'family',familyId}
//   family → family_bills where {familyId, delFlag:false, date 范围}
```

依赖（只读 import db 导出，[db/index.js module.exports](cloudfunctions/shared/db/index.js)）：`fetchAll`、`getDb`（取 `db.command`）、`QUERY_PAGE_SIZE`、`currentOpenId`、`getProfile`。

## 7. 工具层 `tools.js`（6 工具，独立声明与执行）

### 7.1 声明（OpenAI function-calling 格式，`additionalProperties:false`）

| 工具 | parameters |
|---|---|
| `query_summary` | `window`(str,req)、`category`(str,opt) |
| `query_category_breakdown` | `window`(req)、`level`(1\|2\|3,默认1)、`topN`(1..10,默认5)、`rankBy`(`amount`\|`count`,默认`amount`) |
| `query_trend` | `window`(req)、`category`(opt) |
| `query_compare` | `windowA`(req)、`windowB`(req)、`level`(opt)、`align`(bool,默认false) |
| `query_bills` | `window`(req)、`sort`(`date_desc`\|`amount_desc`,默认`amount_desc`)、`limit`(1..50,默认10)、`keyword`(str,opt,备注关键词) |
| `query_recurring` | `window`(req)、`category`(opt) |

- ⚠ 无 `account`/`source`/`weekday`/`hour` 入参（决策 8）。
- 参数校验独立实现：越界 → `{ok:false, error:{code:'ARG_INVALID', message, hint:'请按 schema 重新调用'}}` **回传模型**（不静默夹住，[11-agent-harness §5.2](docs/wiki/tech/11-agent-harness.md#L203-L213) 纪律）。

### 7.2 返回信封

```js
// 成功
{ ok:true,
  data: { /* §5 对应统计结构，金额对外转元字符串 */ },
  evidence: { windowLabel, billCount, scopeLabel, aligned?, hasYoYBaseline? } }
// 失败（回传模型，唯一自我修复途径）
{ ok:false, error: { code, message } }
```

`evidence` 由代码生成：`windowLabel`（§4 label）、`billCount`（实际有效笔数）、`scopeLabel`（`'个人账本'`/`'家庭账本'`）。`query_bills` 的 data 含代码预聚合 `sumCent/count`，**模型禁止自己加总**（PRD §5.1）。

## 8. LLM 客户端 `llm-stream.js`（独立实现，不 import llm-client）

```js
/** 工具轮：非流式 */
async function chatOnce({ messages, temperature=0.1, maxTokens=800, jsonMode=false, timeoutMs, userId })
  → { ok, content, toolCalls: [{id,name,arguments}], usage:{totalTokens} }

/** 成文轮：流式（决策 16：只流式成文轮） */
async function chatStream({ messages, temperature=0.3, maxTokens=800, timeoutMs, userId, onDelta })
  → { ok, content, usage }
// onDelta(textChunk) 逐段回调
```

- 请求体：`model:'deepseek-chat'`、`stream:true`（仅 chatStream）、`user: makeUserId(openid)`（`'u'+base36(hash)`，不传原始 openid —— 与旧客户端同口径，复用 `llm-client.js` 导出的 `makeUserId`？**否**：为守住「不 import llm-client」红线，在本文件内实现同算法（一行 base36 哈希）并注释对齐）。
- 传输：Node 内置 `https`（**云端无全局 fetch**，[http-client.js:6-14](cloudfunctions/shared/util/http-client.js#L6-L14)）；超时 `req.destroy()`（同教训）。
- SSE 解析：`res.on('data')` 累积 buffer，按 `\n\n` 切帧，帧内行前缀 `data: `；`[DONE]` 结束；`choices[0].delta.content` 拼接。
- 防御：chatStream 收到 `tool_calls` delta → 累积后标记 `unexpectedToolCalls:true`，loop 转非流式重跑（chatOnce 带 tools）。
- 错误归因：网络/超时/HTTP≠2xx → `{ok:false, error:'LLM_UNAVAILABLE', detail}`。

## 9. Agent 循环 `loop.js`（状态机 + 伪代码）

```
runAsk({ question, sessionId, scope, openid, context })
  ⓪ 时间基准：todayCST = dateUtil.toDateStrCST(Date.now()) —— 本请求唯一「今天」，
     传入 resolveWindow / usage（§4 时间基准纪律；UTC 运行时必须 CST 换算）
  ① 前置：usage.checkAndIncrement（50 次/日，todayCST）→ 超限 throw ASK_DAILY_LIMIT
     session-store.lazyCleanup + job-store.lazyCleanup
  ② 消息构造：
     system = prompts.buildSystem(scope)          // §10，含类目树（带 ID，防幻觉）
     history = sessionStore.getSession(...) → 最近 20 轮 {q,a} 拼成 messages
     messages.push({role:'user', content:question})
  ③ 工具循环（i = 1..ASK_MAX_TOOL_ROUNDS，每轮 chatOnce+工具，timeout ASK_ROUND_TIMEOUT_MS）：
     res = chatOnce({messages, tools: TOOL_DEFINITIONS, jsonMode:false})
     res.toolCalls? → 逐工具 tools.execute（报错也回传 {role:'tool', content:{error}}）→ 回到循环头
     res.content 解析出 clarify JSON → finishClarify（§10 协议）→ END
     res.content 解析出 final JSON → 进入 ④
     轮次用尽 → fail('TOOL_ROUNDS_EXCEEDED')
  ④ 成文轮（流式）：chatStream({onDelta: chunk 节流写 job 文档 chunks，gen 不变})
  ⑤ guard.checkCitations(final, 全部工具返回值)：
     失败 → gen+1、chunks 清空、带反馈重生成（≤2 次，重生成同样流式）→ 仍失败 fail('NUMERIC_CITATION_MISMATCH')
  ⑥ finishDone：job 文档置 done（合并 answer/numbers/evidence/suggestions/confidence）
     session-store.appendRound({q, a:answer 摘要≤150字})
     usage.addTokens(累计 usage.totalTokens)
  END
兜底：任何异常 → failJob(reason)；job expiresAt = 创建+45s；
     硬总预算 ASK_TOTAL_BUDGET_MS 由 Promise.race 定时器守卫 → 超时 fail('ASK_TIMEOUT')
```

**confidence 由代码判定**（§7 evidence）：`billCount < 3 || truncated || hasYoYBaseline===false` → `'low'`（ThoughtSpot 答案分级借鉴），否则 `'normal'`。

## 10. Prompt 详设 `prompts.js`

### 10.1 system prompt 全文草案

```
你是「随口记」的账务问答助手，像一位熟悉用户账本的可靠朋友：直接、诚实、温和、不评判、不谄媚。

【铁律】
1. 所有金额、比例、涨跌、排名**一律引用工具返回值**，禁止自己计算或估算。
2. 工具返回的 evidence 块（时间窗、笔数、账本口径）必须原样写入输出的 evidence 字段。
3. 无数据时明说：「X 时间窗内没有 Y 的记录（实际 N 笔）」，禁止编造。
4. 类目对应不上（用户说法模糊）→ 输出 clarify 反问，列候选，不猜。
5. 能一次工具调用拿全的问题，不要拆成多次调用。

【时间口径】（决策 9）
「最近」= 近 7 天滚动；「这个月/上个月」= 自然月；「今年/去年」= 自然年，
「去年」优先理解为去年同期；答案必须带 evidence.windowLabel 标注口径。

【拒绝清单】以下情况明确说「这不是我的能力范围」+ 一句原因，绝不编造：
- 省钱建议（引导用户去分析页）；成员间比较（「我只统计全家整体」）
- 收入/结余/预算/预测/投资；按支付方式/记账方式/星期/时段筛选
- 统计范围外（超过最近 24 个月的账单）

【澄清协议】类目模糊 → 只输出 clarify JSON，不调工具；
时间模糊 → 不反问，按默认口径执行并在答案标注。澄清最多两轮。

【输出协议】
- 正常回答输出 final JSON：
{"answer":"…","numbers":[{"value":"842.50","source":"query_category_breakdown:sum"}],
 "evidence":{"windowLabel":"按自然月 2026-11 计","billCount":47,"scopeLabel":"个人账本"},
 "suggestions":["水果里细分呢","和上月比呢"]}
  numbers[].value 必须与工具返回的数值字符串完全一致；suggestions 给 1-2 条自然的追问建议。
- 需要澄清时只输出：
{"clarify":{"question":"「吃饭」指哪个类目？","options":["正餐","外卖","全部餐饮"]}}

【表述基调】陈述事实不评判：说「餐饮多花了 180 元」，不说「你花得太多了」。
```

### 10.2 注入物

| 块 | 内容 | 来源 |
|---|---|---|
| p0 system | §10.1 全文 | prompts.js 常量 |
| p1 categoryTree | 压缩类目树**带 ID**（`category-preset.buildPromptCategoryTree()` 复用，防幻觉 14%→低） | 只读 import |
| p2 scope | `{scopeLabel, 家庭/个人}` | resolveScope 结果 |
| p3 history | 最近 20 轮 `Q/A` | session-store |

输入预算：`estimateTokens(messages)` 累计，历史块超限时**丢最旧轮**（每次丢一轮直至达标）。

## 11. 引用校验 `guard.js`

```js
checkCitations(final, toolResults, jobStore, ...) → { ok } | { fail: [values] }
// 算法：
//   corpus = toolResults 全部 JSON.stringify 的拼接
//   normalize(v) = v 去千分位逗号、去空格、'842.5'→'842.50'（补齐两位小数比较，规避旧坑 '500.00' vs 500）
//   for n in final.numbers: corpus 不含 normalize(n.value) → fail
// 处理：失败 → 带反馈「以下数字在工具结果中不存在：…，请重新组织回答」重生成（≤2 次）
//      仍失败 → failJob('NUMERIC_CITATION_MISMATCH')（零假数字）
```

同时真校验输出 JSON 结构（旧 schema-validator 只认 `properties` 不真校验，[23-change-impact §3.5](docs/wiki/engineering/23-change-impact.md#L121-L128) —— 新写必须逐字段验证：answer 为字符串、numbers 元素含 value/source、evidence 含 windowLabel/billCount）。

## 12. 存储层（函数签名）

```js
// session-store.js
createSession(openid) → sessionId                 // crypto.randomBytes(8).toString('hex')
getSession(openid, sessionId) → {rounds} | null   // userId 校验，不匹配 → null
appendRound(openid, sessionId, {q, a})            // 内部裁剪 >20 轮丢最旧；写 updateTime
lazyCleanup(openid)                               // 7d 未更新删除 + 会话数 >10 删最旧

// job-store.js
createJob(openid, jobId)                          // 文档置 running + expiresAt
appendChunks(openid, jobId, gen, chunk)           // 内部节流：≥400ms 或累计 ≥100 字才落库
finishDone(openid, jobId, {answer, numbers, evidence, suggestions, confidence})
finishClarify(openid, jobId, {clarify})
failJob(openid, jobId, reason)
getJob(openid, jobId) → job | null                // userId 不匹配/不存在 → null
                                                  // expiresAt 已过且 status='running' → 置 error('JOB_LOST') 后返回
lazyCleanup(openid)                               // 1h 前 createTime 的残留文档 remove
// 完成/失败：先写终态再调度 remove（poll 拿得到最终结果；remove 失败无害，懒清理兜底）

// usage.js
checkAndIncrement(openid, todayCST) → {allowed:boolean, count:number}
addTokens(openid, n)                              // 累计 total_tokens
checkBudget(openid) → {allowed, reason}           // guardrail.checkTokenBudget(tokens, TOKEN_BUDGET_PER_USER_DAY)
```

## 13. 云端 action 协议（analysis-svc 新 action，additive）

### 13.1 `ask {question, sessionId?, ledger?}`

| 响应 | 含义 |
|---|---|
| `{ok:true, jobId, sessionId}` | 已受理，前端开始 pollAsk（毫秒级返回，躲 3s 网关） |
| `{ok:false, error:'ASK_BAD_ARGUMENT'}` | 问题为空 / >200 字 |
| `{ok:false, error:'ASK_DAILY_LIMIT'}` | 当日 ≥50 次（决策 15） |
| `{ok:false, error:'TOKEN_BUDGET_EXCEEDED'}` | 日 token 熔断 |
| `{ok:false, error:'LLM_DISABLED'}` | 未配 Key / LLM_ENABLED=false（复用配置语义） |

实现：在 [analysis-svc/index.js:85-98](cloudfunctions/analysis-svc/index.js#L85-L98) switch 加两个 case；`resolveScope(context, payload)` 复用（[index.js:763](cloudfunctions/analysis-svc/index.js#L763)，family 非成员/未加入直接 throw，语义不变）；返回后**后台继续跑 loop**（事件循环保持忙碌，同 asr-svc 后台识别模式；总预算 ≤35s < timeout 40）。

### 13.2 `pollAsk {jobId}`

```js
{ ok:true, job: { status, gen,
                  chunks?, answer?, numbers?, evidence?, suggestions?, confidence?,
                  clarify?, error?, reason? } }
// job 不存在/越权 → { ok:false, error:'ASK_JOB_NOT_FOUND' }（不区分「不存在/越权」，不泄露存在性）
```

### 13.3 原因码 → 前端文案（降级语义：数据没有 ≠ 故障）

| reason | 用户看到 |
|---|---|
| `JOB_LOST` / `ASK_TIMEOUT` | 「这次回答超时了，请重新提问」 |
| `LLM_UNAVAILABLE` / `LLM_DISABLED` | 「AI 暂不可用，请稍后重试」 |
| `NUMERIC_CITATION_MISMATCH` / `TOOL_ROUNDS_EXCEEDED` | 「AI 暂不可用，请稍后重试」 |
| `ASK_DAILY_LIMIT` | 「今日问数次数已达上限（50 次），明天再来」 |
| `TOKEN_BUDGET_EXCEEDED` | 「今日 AI 预算已用完，明天再来」 |
| （无数据/基线不存在） | 不是 error：正常答案走诚实降级文案 + `confidence:'low'` |

**问数没有模板兜底**（PRD §8）：LLM 不可用时绝不输出任何数字。

## 14. 前端详设

### 14.1 cloud.js 封装（[cloud.js:98](miniprogram/utils/cloud.js#L98) `callFunction` 模式）

```js
function ask(question, sessionId, ledger) { return callFunction('analysis-svc', { action:'ask', payload:{ question, sessionId, ledger } }); }
function pollAsk(jobId) { return callFunction('analysis-svc', { action:'pollAsk', payload:{ jobId } }); }
```

### 14.2 新页面 `pages/query-chat/index.*`（命名 index.\*，防 check-frontend 整页跳过）

```js
data: {
  messages: [ { id, role:'user'|'assistant', text,
                status:'pending'|'streaming'|'done'|'error'|'clarify',
                clarify, numbers, evidence, suggestions, confidence } ],
  inputText:'', sessionId:'', asking:false, jobId:'', lastGen:0,
  presetQuestions: [ '这个月花了多少', '今年买水果花了多少', '相比去年哪类涨得最多',
                     '我最大的一笔开销是什么', '话费平均每月多少', '双十一花了多少' ],
  voiceState:'idle', partialText:'' }
```

方法：
- `onSend()` / `onPickPreset(e)` / `onPickSuggestion(e)` / `onPickClarify(e)` —— 同一问答管道（决策 13/16：气泡点击与手输完全一致）
- `startPolling()` —— 500ms 轮询 pollAsk；`gen` 变化 → 清空该条消息重渲染（引用校验重生成场景）；chunks 追加 + 末段光标
- `onAskResult(res)` —— done：合并 answer，**证据卡此时才渲染**（numbers/evidence/suggestions/confidence）；clarify：渲染候选 chips；error：按 §13.3 文案
- 语音：`const { VoiceInput, STATE } = require('../../utils/voice.js')` **零修改复用**（同 [index.js:1](miniprogram/pages/index/index.js#L1) 用法），`onResult({text})` → `inputText = text` → `onSend()`
- `onLoad/onUnload` —— sessionId 读写 `wx.getStorageSync('ask_session_id')`；卸载时 `voice.abort()` + 清 pollTimer
- 流式中途刷新：本地存 `ask_job_id`，重进时先 pollAsk 一次，能续取就续（chunks 已落库），拿不到 → 提示重试（决策 16 兜底）

WXML 关键结构（绑定字段必须在全链路 JS 可查，[23-change-impact §5.4](docs/wiki/engineering/23-change-impact.md#L180-L184)）：消息列表（分 role 气泡）、`status==='streaming'` 光标、证据卡块（`numbers/evidence`）、suggestions 气泡、clarify chips、空态预设问题气泡、输入栏 + 语音按钮（bindtap `onVoicePress`/`onVoiceRelease`）。

### 14.3 首页入口卡片

- [index.wxml](miniprogram/pages/index/index.wxml) summary 区块（:18-25）之后加：`<view class="query-entry" bindtap="onOpenQueryChat">💬 对账单提问</view>`
- [index.js](miniprogram/pages/index/index.js) 加 `onOpenQueryChat()` → `wx.navigateTo({ url:'/pages/query-chat/index' })`
- [app.json](miniprogram/app.json) pages 注册 `pages/query-chat/index`；**不占 tabBar**（决策 2）

## 15. 可观测性与追踪（LangSmith 类问题的 V1 答案）

> **结论**：V1 不上任何外部 SaaS。内置 trace 对齐现有 `[TRACE:]` 体系 + trace 随 job 文档持久化（LangSmith「持久化」价值的本地等价物）；外部导出（LangSmith / Langfuse / OTel）只留适配口、默认关闭，开关 = 产品确认数据出境。

### 15.1 现状：老栈已有 trace 体系（新栈只对齐、不重造）

- `shared/agent-harness/tracer.js` 是纯内存日志器：只 require `crypto`（[tracer.js:24](cloudfunctions/shared/agent-harness/tracer.js#L24)），导出 `createTraceId`/`hashInput`/`logEvent`（[tracer.js:274](cloudfunctions/shared/agent-harness/tracer.js#L274)），缓冲上限 `MAX_BUFFER=200`、`MAX_CHAINS=50`，`DEBUG_TRACE=true` 环境变量开关（[tracer.js:58](cloudfunctions/shared/agent-harness/tracer.js#L58)）。
- 查看链路：`[TRACE:<id>]` 日志行 → `node tools/trace-view.js trace.log`（流程见 [docs/how-to-trace-agent.md](docs/how-to-trace-agent.md)）。
- 隐私纪律（沿用，不新造）：`DEBUG_TRACE=true` 会让账单金额进日志，**排查完删除环境变量并重新部署**（how-to-trace-agent §四）。
- 新栈与老栈共用同一个 `DEBUG_TRACE` 开关（同在 analysis-svc）：开一次，两条链一起记。
- ⚠️ ask 是**后台任务**：函数返回后 `[TRACE:]` 日志行仍会持续写入云函数日志，直到实例被回收或 40s 预算耗尽 —— 中途死亡时内存 trace 全丢，这正是 15.4「落 job 文档」要兜的底。

### 15.2 红线判定：import 老 tracer.js 不算破坏红线

红线是「不碰老栈 agent 逻辑」（llm-client / tools / schema-validator 等 11 文件）。tracer.js 零 harness 依赖（仅 crypto）、无任何 agent 逻辑，import 它属于**只读观测**。但保守起见不直接散用：新栈内包一层 `query-agent/tracer.js`（事件名统一 `ask_*` 前缀，与 insight 链的 `llm_request`/`tool_call` 等区分），内部复用老 `logEvent`。老文件零修改。

### 15.3 事件模型（敏感内容一律 hashInput / 截断）

| 事件 | 载荷要点 |
|---|---|
| `ask_received` | question 截断 50 字、sessionId、ledger、todayCST |
| `ask_anchor` | 锚点解析结果（窗口/类目 ID） |
| `ask_llm_request` | round、gen、工具列表、messages 摘要 |
| `ask_llm_response` | round、gen、toolCalls 或内容摘要、usage tokens |
| `ask_tool_call` | 工具名、参数摘要、耗时 ms、结果行数 |
| `ask_clarify` | 澄清问题与选项 |
| `ask_citation_check` | pass/fail、被剔除的 value |
| `ask_stream` | 首字节延迟、chunk 数、flush 次数 |
| `ask_fallback_error` | reason（**不设 DEBUG_TRACE 也打印**，与老栈 fallback 同待遇） |
| `ask_summary` | 轮数、总 token、总耗时、status、confidence、reason |

`tools/trace-view.js` 增加 `ask_*` 解析段（dev 工具，改动不触红线）。金额类载荷只进 hash 后的引用校验结果，**原始账单数字不进事件**。

### 15.4 trace 随 job 文档持久化（对外部平台核心价值的本地等价物）

- 规则：loop 每产一个事件，同步 push 内存 buffer；`finalize`（done / clarify / error）时把**末 40 条 + `ask_summary`** 写入 job 文档 `trace` 字段（JSON 字符串数组，一行一条；无账单明细）。job 过期清理时一并删除，随 TTL 自然滚动。
- 好处：① 实例中途被 40s 预算杀死，已落事件仍可读；② 排查不必抓日志，云开发控制台直接看 job 文档；③ 老栈内存 tracer 不改一行。
- 前端不渲染 `trace` 字段；仅排查用。

### 15.5 外部导出（LangSmith / Langfuse / OTel）—— 留口、默认关、待产品确认

- **为什么 V1 不接**：① 云端无全局 fetch，上报需自写 Node https 客户端；② 40s 预算下上报必须异步 fire-and-forget、失败静默 —— **埋点不能成为故障源**（纪律同 [11-agent-harness.md §11](docs/wiki/tech/11-agent-harness.md)）；③ 账单金额/问题/回答上传第三方 SaaS 是**数据出境口径题**，需产品确认（现有纪律是「账单数据不该长期留在日志系统里」，何况外发）。
- 留的适配口：环境变量 `TRACE_EXPORT_URL` + `TRACE_EXPORT_FORMAT`（`langfuse` \| `otel`，缺省 = 不导出）。`finalize` 时若已配置，异步批量 POST（Node https、2s 超时、失败静默、绝不阻塞 ask 主链路）。格式取 OTel GenAI semantic conventions 子集，老栈未来可零改动复用。
- 若产品批准外发（V1.1）：优先 **Langfuse 自托管**（开源、docker 部署、数据不出自己服务器，折中最优）；其次 Langfuse Cloud / LangSmith（SaaS 便利但数据出境）。老栈 insight 链是否同样接入：本次不动（红线）。

## 16. 测试详设（新增 7 个测试文件，挂根 package.json `test` 链）

| 文件 | 关键用例（节选） |
|---|---|
| `anchors.test.js` | 各锚点日期解析；`last_n_months:25` 越界报错；双11=11.1-11.11、618=6.1-6.18、双12=12.1-12.12；春节 2025 → 除夕(2025-01-28)~正月十五(2025-02-12) 区间；农历闰月年（2025 闰六月不炸）；跨年春节；年份缺省 = 今年；**CST 边界**：todayCST='2026-11-08' 时 `last_n_days:7` → from='2026-11-02'；1 月 todayCST 问 `last_year_same` → 去年 1 月窗口（跨年锚点） |
| `query-stats.test.js` | 聚合 sum/count/pct；双维度排名（金额 Top ≠ 笔数 Top 用例）；趋势缺月补 0；方向 ±1% flat / +5% up；对齐（本月前 10 天 vs 上月前 10 天等长后算率）；驱动分解贡献率合计 = 100%；基线 <3 笔 → hasYoYBaseline:false；跨月周期：3 个月各 1 笔月付检出、单月 1 笔检不出（对照组）；2000 笔分片取全 |
| `guard.test.js` | 引用对上通过；`'842.50'` vs `'842.5'` 归一通过（旧坑回归）；对不上剔除重试 2 次后 error；final JSON 缺 evidence.windowLabel 被拒；clarify 结构校验 |
| `session-store.test.js` | 21 轮写入丢最旧；11 个会话 → 删最旧 1 个；7d 未更新被清理、6d 保留；越权读 null；文档顶层无 `month` 断言 |
| `job-store.test.js` | running→done/clarify/error 状态机；节流（400ms 内两次 append 只落一次）；done 后 remove；1h 残留清理；越权 getJob null；expiresAt 过期 running → error('JOB_LOST')；finalize 落 trace 末 40 条 + ask_summary（无金额原文）断言 |
| `usage.test.js` | 50 次上限；跨天重置（todayCST 传参驱动，北京时间 00:30 归入新一天）；token 累计 + 熔断 |
| `loop.mock.test.js` | mock LLM：单工具轮直达成文；两轮工具；澄清路径（不调工具）；轮次用尽 error；工具报错回传后自我纠正；引用校验失败重生成（gen+1）；成文流式 chunk 序列；confidence 判定 |
| `eval-questions.js` | BIRD 式固定问题集（长期回归）：每例断言工具选择/锚点参数/排名维度，如「今年买水果花了多少」→ query_category_breakdown + this_year + category=水果 |

既有守卫：`npm test`（旧用例零红，红线）、`npm run preflight`（版本戳 `20261108-02` 双端同步 + 副本漂移）、`npm run check:ui`（新页面 WXML 绑定）。

## 17. 部署清单（AGENTS.md §2 四步 + 依赖）

1. `constants.js` `CODE_VERSION` `20261108-01` → `20261108-02`；`cloud.js:21` `EXPECTED_CODE_VERSION` 同步
2. `npm run prepare:cf`（shared 副本同步，虽只改 constants 也必跑）
3. `cloudfunctions/analysis-svc/package.json` 加 `lunar-javascript`；本地 `cd cloudfunctions/analysis-svc && npm install`
4. 开发者工具右键 analysis-svc →「上传并部署：**云端安装依赖**」（lunar 库必需；**只能人工**）
5. config.json 无改动（不加定时器）→ 无需上传触发器

## 18. 显式不做

- insight 侧 13 个月窗口改造（PRD v3 M1）：本次不动，红线（plan §8 已定，待产品确认合并时机）
- Q10 异常发现（随 PRD v3 F4）；问答历史列表/搜索 UI（V1.1）
- Vanna 式自查轮（M5 评估）；账户/来源/星期/时段筛选；建议类、成员比较、收入/预算/预测
- 新建任何集合；改动 `REQUIRED_COLLECTIONS`
- LangSmith/Langfuse/OTel 外部导出：留 `TRACE_EXPORT_URL` 适配口但 V1 默认关闭；是否启用 = 数据出境口径，待产品确认（V1.1）
