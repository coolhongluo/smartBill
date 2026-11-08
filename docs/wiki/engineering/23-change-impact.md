# 23 变更影响面索引

> **这页是干什么的**：回答「我要改 X 功能，该动哪些文件、哪些测试会红、哪些地方会静默失效」。
>
> 依据：对 5 个真实变更需求做了**双盲对照实验**（一组只读 Wiki，一组只读源码），实测结论汇总于此。
> **每条都经过 grep / node 实跑验证**，不是推测。

## 0. 怎么用这页

| 你要做的事 | 先查这里 |
|---|---|
| 改金额上限 / 金额规则 | §2 金额相关 |
| 加一个分析维度 / 一个工具 | §3 分析相关 |
| 加或改一个云函数 action | §4 接口相关 |
| 改前端任何字段 | §5 前端相关 |
| 改类目 | §6 类目相关 |
| 改重复记账规则 | §6.5 重复记账相关 |
| 不确定要跑哪些命令 | §7 部署与校验 |

> ⚠️ **本项目最大的坑不是「找不到文件」，是「找到了但漏了一处」** —— 同一个常量在 4 个地方定义、同一份数据存两个字段、同一件事在 3 条路径上各有一份实现。**下面 §1~§6 列的都是这类「漏一处就静默出错」的点。**

## 1. 铁律：改 shared 必须重刷 5 个云函数

| 事实 | 出处 |
|---|---|
| `cloudfunctions/shared/` 是源；每个云函数目录里还有一份**副本** | `tools/prepare-cloudfunctions.js` |
| 副本落两处：`<svc>/shared/`（随包上传）+ `<svc>/node_modules/shared/`（**不随包上传**） | 同上 |
| 改 `shared/**` 后必须跑 `npm run prepare:cf` | `MEMORY.md` 部署四步 |
| `constants.js` 一改 → **10 份副本** hash 全变 → preflight 报漂移 | 实测 |
| **本地全绿 ≠ 云端能跑** | `MEMORY.md` 云函数铁律第 4 条 |

## 2. 金额相关：上限散在 4 处、3 种单位 ⚠️

**改「单笔金额上限」必须同时改这 4 处**（实测 grep 确认）：

| # | 位置 | 单位 | 谁在用 |
|---|---|---|---|
| 1 | `shared/util/constants.js:100` `GUARDRAIL.MAX_AMOUNT_YUAN: 50000` | 元 | `guardrail.js:55` 读它 |
| 2 | `shared/util/money.js:100` `cent <= 50000 * 100` | 分（硬编码） | `asr-parse.js:121` 调 `isReasonableAmount` |
| 3 | `bill-svc/index.js:71` `GUARDRAIL_MAX_AMOUNT_CENT = 50000 * 100` | 分（硬编码） | `bill-svc:538`（manual）、`:645`（amend） |
| 4 | `shared/agent-harness/schemas/bill-parse.schema.js:20` `maximum: 500000` | **元** | LLM 输出校验 |

### 2.1 四个必须知道的陷阱

| 陷阱 | 实测结论 | 后果 |
|---|---|---|
| **单位不一致** | #4 的 500000 是**元**，比 50000 元宽松 10 倍 —— **它从来没生效过** | 改上限时容易误判「LLM 路径不受限」 |
| **record 路径无上限校验** | `handleRecord` 函数体内**没有**上限判断，只有 manual(:538) 和 amend(:645) 有 | 语音记账超大金额只靠规则层抽不出 → 走模糊金额流程 |
| **`arabic_bare` 的 10 万粗筛** | `asr-parse.js:116` `yuan > 100000` 就跳过 | 上限提到 20 万后，裸数字 `150000` 仍进不来 |
| **静默跳过不是报错** | `asr-parse.js:121` 是 `continue` 不是 throw | 超限金额被静默丢弃 → 用户听到「没听清金额」 |

### 2.2 ⚠️ 口语数量级：「12 万」根本解析不出来

实测 `asr-parse`：

```
'12万'      → amountCent = undefined
'二十万'    → amountCent = undefined
'120000元'  → amountCent = undefined, certain = false
'买菜100元5毛' → amountCent = undefined（此例为调用姿势问题，实际函数名不同）
```

**根因**：`cnToNumber` 的单位表只到「千」，`arabic_bare` 的正则先切出「12」，「万」被丢掉。

> **含义**：把上限提到 20 万，光改数字没用 —— **用户说「买了 15 万的车」系统就是解析不出来**。
> 改上限时必须同时处理数量级解析，否则需求实际没生效。

### 2.3 金额字段双名

| 语义 | 字段 | 类型 |
|---|---|---|
| 计算值 | `amountCent` | 整数分 |
| 展示值 | `amount` | 字符串 `"¥120.50"` |

前端回填**必须**用 `yuanInput(bill.amountCent)`。用 `bill.amount` → `Number("¥120.50")` = NaN → 面板显示 0，保存时报「请输入有效金额」，**全程零报错**。

## 3. 分析相关：加一个工具/维度的连锁反应

### 3.1 加第 12 个工具要动 6 处

| # | 文件 | 改什么 | 不改的后果 |
|---|---|---|---|
| 1 | `shared/agent-harness/tools/index.js` | `TOOL_DEFINITIONS` 加声明 | **测试直接红**（`bill-stats.test.js:502` 断言声明与执行层一一对应） |
| 2 | 同上 | `TOOL_ARG_SCHEMAS` 加参数约束 | 越界参数不被拦 |
| 3 | 同上 | `executeTool` 的 `switch` 加 `case` | 工具调用返回空 |
| 4 | 同上 | `llm-client.js:452` `summarizeToolResult` 加摘要分支 | trace 日志看不到关键数字，排查瞎 |
| 5 | `shared/agent-harness/index.js:382` `CONCLUSION_REQUIRES` | 加维度映射 | **结论被静默剔除**（见 3.2） |
| 6 | `shared/agent-harness/agents/insight.agent.js` | 铁律零的工具对照表 | 模型不知道要先调哪个工具 |

### 3.2 ⚠️ 工具依赖校验会误杀新维度（实测复现）

**症状**：模型**确实调了**新工具、**确实写了**结论，但那条结论消失，用户看到「没有订阅分析」。
**误判方向看起来是「模型没调工具」→ 排查会跑偏。**

实测根因：新结论文本含「订阅」→ 命中现有 `dimension: '周期消费'`（patterns 含 `/订阅/`）→ 该维度的 `tools` 只有 `get_recurring_patterns` → 新工具不在其中 → 判定为「无支撑」→ 剔除。
同时「共 3 笔」又命中「消费频次」维度 → 同样被剔。

> **修法**：新维度要把新工具加进 `tools` 列表，或给相关维度的 `tools` 补上新工具。

### 3.3 ⚠️ `calcRecurringPatterns` 检不出月付订阅（实测）

| 输入 | 结果 |
|---|---|
| 本月单笔 30 元月付订阅 | `count: 0` |
| 本月 4 笔周付 | 检出「每周」 |
| 跨 3 个月各 1 笔（合并） | 只算 1 笔 |

**根因**：判定要求**同一末级类目 ≥3 笔**（`MIN_OCCURRENCES = 3`）且间隔规整。而月付订阅在单月内只有 1 笔。

> **含义**：任何「订阅」「续费」「周期提醒」类需求，**不能想当然复用 `calcRecurringPatterns`**，必须写跨月判定。
> 它的入参是**单月**账单数组 —— 架构上就检不出跨月订阅。

### 3.4 ⚠️ `saveInsight` 有硬编码字段白名单

`shared/db/index.js` 的 `saveInsight` 白名单：insights / savings / pie / total / billCount / deltaText / deltaDirection / trend / meta。

**新字段不加进去 → 不落库。** 而 `refreshInsight` 当次返回是有的 → 前端刷新后数据消失，表现为**「时好时坏」**。

`readInsight` 也要同步加读取，且老数据要能处理字段缺失（用 `|| []` / `|| {}`），否则历史月份白屏。

### 3.5 ⚠️ `OUTPUT_SCHEMA` 校验不严（实测）

`schema-validator.js` 的 `validateSchema` 只认 `properties` / `required`，而 insight agent 的 schema 用的是 `fields` / `requiredFields` / `itemType`。

**实测：把 `insights` 写成字符串而非数组，校验照样通过。**

> 加新字段时**别指望 schema 兜住**。它只是给人看的声明，不是真校验。

### 3.6 轮次与预算：加工具会挤压超时

| 参数 | 现值 | 加工具后的影响 |
|---|---|---|
| `maxToolRounds` | 4 | 模型要多花一轮 → 轮次压力直接上升 |
| `budget.timeoutMs` | 20000 | 每轮 `max(800, timeoutMs/maxRounds)` = 5000ms |
| `budget.maxTokens` | **2400**（insight agent 显式声明值） | prompt 变长。⚠️ `GUARDRAIL.MAX_INPUT_TOKENS = 1200` 是 harness 的 fallback 默认值，**insight 不适用** |
| `maxTokens`（输出） | 1400 | 成文轮超时风险最高（线上 trace 实测） |
| `analysis-svc/config.json` timeout | 40 | 需与 LLM 预算匹配，preflight 会查 |

> **v3 血泪史**：总预算 10s ÷ 4 轮 = 每轮 2500ms 对 function-calling 太紧 → 每轮必超时 → **永远走降级**。别把预算调回去。

### 3.7 改完分析代码，必须重新触发一次分析

读算分离下 `categoryBreakdown` **只读不计算** —— 代码改了分析页不会自动变。

## 4. 接口相关：加一个 action

| 要改 | 位置 |
|---|---|
| 云端路由 | `<svc>/index.js` 的 `case 'xxx':` |
| 前端调用 | `miniprogram/utils/cloud.js` 封装 + `EXPECTED_CODE_VERSION` 同步 |
| 版本戳 | `shared/util/constants.js` `CODE_VERSION` +1 |

**注意**：`miniprogram/app.js:17` 有 `monthSummary: null` 这类 `globalData` 预取字段，`app.onLaunch` 会预取 —— 加新 action 时要想清楚要不要进预取（**预取失败是静默的**，别拖累启动）。

## 5. 前端相关：改字段必看

### 5.1 ⚠️ 改「编辑面板字段」会撞上既有测试断言

**本项目最硬的一条**：用户明确不需要的字段，有测试**断言它不存在**。

| 断言位置 | 内容 |
|---|---|
| `tools/__tests__/edit-bill.test.js:93-98` | `编辑面板不含「支付方式」（用户明确不需要）` —— 断言 `!bound.has('editAccount')`、无「支付方式」文案、无 `onPickAccount` |
| `tools/check-frontend.js:473-475` | `明细：编辑面板不含支付方式` —— `!/editAccount|onPickAccount|支付方式/.test(detailJs + detailWxml)` |

> **需求推翻旧决策时，必须同步改这两处**，否则 `npm test` 和 `npm run check` 全红。
> 这类「反向断言」是本项目的特色守卫 —— 改需求前先 `grep` 一下有没有对应的反向断言。

### 5.2 `groupByDate` 是字段白名单

`miniprogram/pages/detail/detail.js` 的 `groupByDate` 只把部分原始字段带进 `items`（`amountCent` / `categoryId` / `date` / `note` 等）。

> **新增可编辑字段必须在这里加一行**，否则编辑面板回填不到原值 —— 与 `amountCent` vs `amount` 是同一类坑。

### 5.3 前端没有金额上限校验

`index.js` 的 `onManualAmountInput` 只过滤字符不限额；`detail.js` 的 `onEditAmountInput` 同样。上限**只在云端**，超了才被拒绝并弹 toast。

### 5.4 WXML 数据绑定断裂检查

`tools/check-frontend.js` 会校验 WXML 绑定的字段在**整个数据链路**（页面 JS + 小程序全部 JS + 云函数全部 JS）上都能找到。新增字段只在 WXML 出现 → 直接报错。

### 5.5 前端有两个「假 searchTimer」

`index.js:84` 与 `:100` 有 `this.searchTimer` 的清理代码，但**首页没有搜索功能** —— 早期设计残留。若在首页实现搜索会与这段冲突。

## 6. 类目相关

| 要改 | 位置 | 注意 |
|---|---|---|
| 加预置类目 | `shared/util/category-preset.js` 的 `CATEGORIES` 数组（166 个，id 形如 `c1_1_1`） | 改完要 `npm run prepare:cf` |
| 调整刚性档 | `shared/util/category-compressibility.js` 的 `RIGID_IDS` / `SEMI_IDS` | **不要写进 `category-preset`** |
| 备注关键词 | `shared/util/note-keywords.js` | **单一数据源**，compressibility / essential-spend / note-summary 三处共用 |

## 6.5 重复记账相关（2026-10-31 实施，版本 `20261031-03`）

### 6.5.1 连动文件清单

改「重复记账」的任何一个口径，至少连动以下文件（实测 grep 确认）：

| # | 文件 | 承载 |
|---|---|---|
| 1 | `cloudfunctions/shared/util/recurring.js` | 调度**纯函数**（`validateRepeat` / `matches` / `nextOccurrence`）—— 建/改规则与定时生成**三处共用**，别在单条路径上另写一份 |
| 2 | `cloudfunctions/shared/util/date.js` | `getWeekdayCST`（东八区星期，触发器下本地时区是 UTC） |
| 3 | `cloudfunctions/shared/util/constants.js:53` | `COLLECTIONS.RECURRING` |
| 4 | `cloudfunctions/shared/db/index.js:1191-1294` | 6 个规则函数 + `insertBillAsUser`（`:124`，触发器写账单专用） |
| 5 | `cloudfunctions/bill-svc/index.js:996-1335` | 6 个 action + `advanceRuleCursor`（`:1335`）+ `normalizeEvent`（`:195`，判据 `isTimerEvent` 大小写不敏感，见 `20-pitfalls.md` §19）+ `buildBill` 的 `ruleId` |
| 6 | `cloudfunctions/bill-svc/config.json:9-15` | 定时触发器 `dailyRecurring`（0:30 UTC+8） |
| 7 | `miniprogram/utils/cloud.js` | 5 个封装（ruleCreate/ruleList/ruleUpdate/rulePause/ruleDelete） |
| 8 | `miniprogram/pages/recurring/manage.*` + `app.json` + `profile.*` | 新页面 + 注册 + 「我的」页入口 |
| 9 | `miniprogram/pages/detail/detail.{js,wxml,wxss}` | `isAuto` 字段 + 「自动」badge（`source='auto'`） |

### 6.5.2 哪些测试会红

| 测试 | 触发条件 |
|---|---|
| `tools/__tests__/recurring-schedule.test.js`（17 用例） | 改调度纯函数（月末跳过 / 闰年 2-29 / 季度 1-4-7-10 月 / CST 独立性） |
| `tools/__tests__/recurring-rule.test.js`（28 用例） | 改规则 CRUD 校验、游标前移、幂等、`insertBillAsUser` 归属、触发器归一（平台实测小写 `Type:'timer'` 形状 + 大写兼容）、家庭账本（创建校验/账本不可改/生成分流/失效跳过/老规则兼容） |
| `tools/check-frontend.js` | 新页面 WXML 绑定字段断裂 / detail 新 badge 字段 |
| preflight 版本戳段 | `CODE_VERSION` / `EXPECTED_CODE_VERSION` 不同步 |

### 6.5.3 静默失效点（比测试红更危险）

| 风险 | 防线 |
|---|---|
| **触发器两步部署漏做**（「增量上传 config.json」≠「上传触发器」）→ 每天静默不生成 | 只能人工，见 §7.1 补充；与 `analysis-svc` 历史上「每天静默不执行」同一坑（`20-pitfalls.md` §19 §20） |
| **归一判据写死大写 `'Timer'`** → 平台实测下发小写 `'timer'`（2026-11-08 云端日志，请求 `860de654`）→ 云端事件永不命中、每天静默不生成 | 判据大小写不敏感（`isTimerEvent`，`bill-svc/index.js:157` / `analysis-svc/index.js:132`）+ preflight 守卫（`20-pitfalls.md` §19） |
| `recurring` 集合没手工建 → 建规则报错、生成失败 | `REQUIRED_COLLECTIONS`（`db/index.js:1461`）+ diag 面板可查 |
| 触发器无 openid 走 `insertBill` → 账单写错用户或直接 throw | 专用 `insertBillAsUser`，`recurring-rule.test.js` 断言 `bill.userId === rule.userId` |
| 时区错（用本地时区算「今天」）→ 0:30 生成「昨天」的账单 | 全链 `toDateStrCST` / `getWeekdayCST`，测试覆盖 |
| 改 shared 漏跑 `prepare:cf` → 云端跑旧调度逻辑 | §1 铁律 |

### 6.5.4 已与产品确认的口径（改前先找产品）

- 创建当天不生成；漏跑**不补记**；编辑规则**仅对未来生效**
- 当天已手工记过同类目同金额 → **照常生成**（不做智能去重）
- 指定日当月不存在（2 月 30 日）→ 跳过当月；每季度 = 固定 1/4/7/10 月
- 恢复暂停**不重算游标** —— 旧游标按漏跑处理，恰好等于「从明天起继续」
- `yearly` 的 2 月 29 日合法（平年跳过、闰年命中）；2 月 30 日被 `validateRepeat` 拒绝

### 6.5.5 家庭账本扩展（2026-11-01 实施，版本 `20261101-03`）

改「重复记账 × 家庭账本」的任何一个口径，注意以下分流点：

| # | 位置 | 承载 |
|---|---|---|
| 1 | `bill-svc/index.js:996` `handleRuleCreate` | `resolveLedger` 云端反查（调用在 `:1006`）→ 规则文档写 `ledger` + `familyId`；缺省 personal 零新增查询 |
| 2 | `bill-svc/index.js:1063` `handleRuleUpdate` | 带 ledger → 明确拒绝（`bill-svc/index.js:1068`，账本归属不可改） |
| 3 | `bill-svc/index.js:1151` `handleRulePause` | 恢复家庭规则前校验成员资格，已退出 → 拒绝 |
| 4 | `bill-svc/index.js:1236` `handleDailyRecurring` | 家庭规则：生成前兜底校验（家庭存在 + 成员，`bill-svc/index.js:1270`）、家庭版幂等、`insertFamilyBillAsUser` 写入 |
| 5 | `shared/db/index.js` | `insertFamilyBillAsUser` / `findFamilyBillByRuleAndDate`（fetchAll + JS 过滤 ruleId，**零新索引**）/ `pauseFamilyRecurringRules` |
| 6 | `shared/db/index.js` `familyLeave`/`familyDissolve` | 退出/解散 → 该成员家庭规则自动 paused（口径） |
| 7 | `miniprogram/pages/recurring/manage.*` | 新建面板账本选择器（编辑只展示）；卡片「家庭」badge + 「家庭已失效」提示。⚠ `manage.*` 被 check-frontend 整页跳过 WXML 校验（`20-pitfalls.md` §62），WXML 绑定人工自查 |

**静默失效点（比测试红更危险）**：

| 风险 | 防线 |
|---|---|
| 退出/解散漏暂停 → 定时器写无主家庭账单 | 生成时二次校验（家庭存在 + 成员资格），失效跳过 + 游标前移；`recurring-rule.test.js` 两条失效用例 |
| 恢复已失效的家庭规则 → 「恢复成功但永远不生成」 | `handleRulePause` 恢复前校验，明确拒绝指路删除重建 |
| 家庭规则误写个人 bills（或反之） | 生成按 `rule.ledger` 分流 + 幂等查重按账本分流，测试断言「家庭规则零写 bills、老规则零写 family_bills」 |
| 老规则文档无 `ledger` 字段 | 代码按 `'personal'` 处理，兼容用例覆盖 |

## 6.6 家庭模式相关（2026-11-01 实施，版本 `20261101-01`）

### 6.6.1 连动文件清单

改「家庭模式」的任何一个口径，至少连动以下文件（实测 grep 确认）：

| # | 文件 | 承载 |
|---|---|---|
| 1 | `cloudfunctions/shared/util/constants.js` | `COLLECTIONS.FAMILIES/FAMILY_BILLS`（`:54-55`）、`FAMILY`（成员上限 8 / 邀请码长度 / 72h 有效期，`:75-80`）、`CODE_VERSION`（`:183`） |
| 2 | `cloudfunctions/shared/db/index.js` | 档案 2 函数（`getProfile`/`saveProfile`，`:386/:428`）+ 家庭 7 函数（`:491-664`）+ 家庭账单 3 函数（`:687-761`）+ 家庭分析 5 函数（`:768-947`）+ `REQUIRED_COLLECTIONS`（`:1392`）+ 45 个导出（`:1401`） |
| 3 | `cloudfunctions/user-svc/index.js` | 10 个 action（switch `:67-76`，handler `:119-270`） |
| 4 | `cloudfunctions/bill-svc/index.js` | `resolveLedger`（`:1481`）+ 4 个 handler（`record`/`recall`/`manual`/`amend`）加 ledger |
| 5 | `cloudfunctions/analysis-svc/index.js` | `resolveScope`（`:710`）+ 5 个入口加 ledger；`computeInsight` 双数据源（`:818`）；**`dailyInsight` 定时链路不动** |
| 6 | `miniprogram/utils/cloud.js` | `login`/`updateProfile`/family 7 件套 + 10 处 ledger 透传；`EXPECTED_CODE_VERSION`（`:21`） |
| 7 | `miniprogram/app.js` | onLaunch 静默 login + `globalData.ledger` |
| 8 | `miniprogram/app.json` + `pages/family/index.*`（新） | 页面注册；**命名必须 `index.*`**（`manage.*` 被 check-frontend 整页跳过，见 `20-pitfalls.md` §62） |
| 9 | `miniprogram/pages/index|detail|analysis/*` | 三处账本切换条（同一 `globalData.ledger` + storage）；index/detail 的记账/编辑透传 ledger；analysis 的 readInsight/refreshInsight 透传 + seq 竞态守卫 |
| 10 | `miniprogram/pages/profile/*` | 头像昵称 + 家庭入口卡片（`openidMasked` 修复） |

### 6.6.2 哪些测试会红

| 测试 | 触发条件 |
|---|---|
| `cloudfunctions/shared/db/__tests__/family-store.test.js`（17 用例） | profile 白名单/null 不写/幂等/无顶层 month；家庭 insight 顶层 userId/month 污染断言、拍平读取、_stale、familyId 不匹配 |
| `tools/__tests__/family.test.js`（39 用例） | 创建/邀请码/成员/退出/解散 + 双空间记账 + 家庭分析全链路 + 越权（**拒绝时不得写任何集合**）+ 家庭规则退出/解散自动暂停 |
| `tools/__tests__/edit-bill.test.js:93-98` | 明细编辑面板加字段（家庭模式也不许加） |
| `tools/check-frontend.js:473-475` | 同上（反向断言） |
| `tools/__tests__/trend-view.test.js` / `trend-detail-jump.test.js` | analysis 页 trend 循环块结构被改动（账本切换条必须加在块外） |
| preflight 版本戳段 | `CODE_VERSION`（`constants.js:183`）/ `EXPECTED_CODE_VERSION`（`cloud.js:21`）不同步 |
| preflight 副本漂移段 | 改 shared 漏跑 `npm run prepare:cf` |

### 6.6.3 静默失效点（比测试红更危险）

| # | 风险 | 防线 |
|---|---|---|
| 1 | 家庭 insight 文档顶层带 userId/month → 污染 `listPendingInsightUsers` 每日扫描、压制 owner 个人分析重算 | 落库结构仅 `{familyId, version, payload, generateTime, updateTime}`；`family-store.test.js` 断言 |
| 2 | 传 `ledger:'family'` 但 profile.familyId 为空 → **静默回退个人账本**，用户以为记进家庭 | 直接 throw 不回退（禁止静默失败纪律）；`family.test.js` 断言「拒绝时零写入」 |
| 3 | `families` / `family_bills` 集合未手工创建 → 家庭 action 全部报错 | `REQUIRED_COLLECTIONS`（`db/index.js:1461`）+ diag 面板 |
| 4 | 非成员读家庭账单/分析/改码（越权） | 每个家庭 action 校验 `profile.familyId`；账单写/删带 `userId: openid` |
| 5 | `saveFamilyInsight` 复用 `saveInsight` → 白名单外字段丢失或顶层 userId/month 落库 | 自持白名单；测试断言 hack 字段被丢弃 |
| 6 | ledger 缺省路径新增查询（如默认也查 profile）→ 现有 e2e/test-persist mock 无 `doc()` 直接崩 | 铁律：`'personal'` 零新增查询 |
| 7 | 新页面命名 `manage.*` → check-frontend 整页跳过 WXML 校验 | `pages/family/index.*` 命名；`20-pitfalls.md` §62 |

### 6.6.4 已与产品确认的口径（改前先找产品）

- 个人 + 家庭**双空间**；分析按**当前账本**聚合；**邀请码**加入（8 位，72h，仅 owner regen）
- **静默自动注册 + 可选资料**（chooseAvatar/nickname；getUserProfile 已废弃）
- 成员上限 8；退出后账单**留在家庭**；一人多家庭 v1 不支持；owner 退出禁止（可解散）
- 家庭重复记账规则 v1 **不共享**（规则私有）；但规则可选**家庭账本**，到点生成的账单进家庭（2026-11-01 已实施，见 §6.5.5）；家庭分析 v1 **仅手动刷新**（定时聚合留 v2）
- 账本切换记忆 `wx.setStorageSync('ledger')`，默认 personal

## 7. 部署与校验：改完跑什么

### 7.1 部署四步

| # | 动作 | 自动化 |
|---|------|--------|
| 1 | `shared/util/constants.js` 的 `CODE_VERSION` +1 | ✅ preflight 查 |
| 2 | 同步 `miniprogram/utils/cloud.js` 的 `EXPECTED_CODE_VERSION` | ✅ preflight 查 |
| 3 | `npm run prepare:cf` | ✅ 有脚本 |
| 4 | 开发者工具右键云函数 →「上传并部署：云端安装依赖」 | ❌ **只能人工** |

> **改了 `config.json`（定时触发器）还要额外两步**（`bill-svc` 的 `dailyRecurring` 与 `analysis-svc` 的 `dailyInsight` 同规则）：
> ① 右键 `config.json` →「云函数增量上传：更新文件」→ ② 右键 `config.json` →「上传触发器」。
> 「更新文件」与「上传触发器」是**两个不同概念** —— 只做前者，云端跑的还是旧触发器。

### 7.2 校验命令

```bash
npm test          # 全量（含规则/统计/保存/趋势/编辑/金额/e2e/持久化）
npm run check:ui  # 前端静态校验（JS 语法真解析 + WXML 数据绑定守卫）
npm run preflight # 版本戳 / SDK 守卫 / 运行时能力 / 语法真解析 / Wiki 一致性
```

### 7.3 ⚠️ `npm test` 里最容易红的三个

| 测试 | 什么时候会红 |
|---|---|
| `tools/__tests__/edit-bill.test.js` | 改了编辑面板字段（反向断言，见 §5.1） |
| `shared/agent-harness/tools/__tests__/bill-stats.test.js:502` | 加了工具但没实现执行层 |
| `shared/db/__tests__/insight-store.test.js` | 改了 insight 落库字段（断言落库与返回一致） |
| `tools/__tests__/recurring-*.test.js` | 改了重复记账口径/游标/幂等（见 §6.5.2） |

### 7.4 preflight 新增的第 10 段

查 `docs/wiki/llms.txt` 里列的链接目标是否都存在。**LLM 按索引读会拿到 404，人从目录页根本发现不了。**

## 8. 实验结论：这页证明了什么

> 方法：5 个真实变更需求，两组 agent 并行作答。**A 组只准读 `docs/wiki/`**，**B 组只准读源码**（互不可见）。判据是已验证的事实。

### 8.1 A 组（只读 Wiki）能做什么

| 能力 | 表现 |
|---|---|
| **判断题**（该做什么、有什么坑、要不要找产品确认） | ✅ 稳定可靠。5 个场景全部答对了「架构原则」层面的判断 |
| **口径与纪律**（数值铁律、读算分离、单一数据源、非目标） | ✅ 准确 |
| **部署步骤** | ✅ 完整无误，与源码组一致 |
| **发现与 PRD 非目标冲突** | ✅ **只有 A 组发现**（B 组被禁止读 PRD） |

### 8.2 A 组做不到什么

| 能力 | 表现 |
|---|---|
| **定位坐标**（常量在哪一行、action 叫什么、字段白名单有哪些） | ❌ 大量推断错误。A 组把金额上限猜成「1 处、可能在 constants.js」，实际是**4 处 3 种单位** |
| **发现既有代码与需求的冲突** | ❌ **A 组完全没发现「编辑面板不含支付方式」的两条反向断言** —— 直接开工会让 CI 全红 |
| **发现隐含的算法缺陷** | ❌ 没发现 `calcRecurringPatterns` 检不出月付、没发现「12 万」解析不出来 |
| **发现字段白名单** | ❌ 没发现 `saveInsight` 白名单、没发现 `groupByDate` 白名单 |

### 8.3 一句话结论

> **Wiki 提供「判断」，源码提供「坐标」。缺任何一半都做不成事。**
>
> 但两者不是对等的：源码是**权威**（坐标必须准确），Wiki 是**加速器**（省掉「为什么要这么设计」的重新推导）。
> **只用 Wiki 会做出架构上正确、细节上出错的实现；只用源码会做出架构上可能跑偏的实现。**

### 8.4 因此 Wiki 的正确用法

| 场景 | 建议 |
|---|---|
| **接需求 / 估工作量** | ✅ 先读 Wiki —— 判断题它全对，能避免 80% 的方向性错误 |
| **动手改** | ✅ 读 Wiki 定方向 → **再 grep 定位坐标** → 改 → 跑测试 |
| **review / 排查线上问题** | ✅ Wiki 能直接给出「这条链路上有哪几个已知坑」 |
| **纯找文件位置** | ❌ 别读 Wiki —— grep 更快更准，Wiki 在这上是负收益 |

**最优流程**：Wiki（判断）→ grep（坐标）→ 改 → `npm test` + `npm run preflight`（守卫）。
