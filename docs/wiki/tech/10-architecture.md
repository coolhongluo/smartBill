# 10 系统架构

> 覆盖：5 个云函数的职责与 action 全表 · shared 多副本机制 · 部署四步 · 运行时限制 · 环境变量。
>
> 权威实现：`cloudfunctions/*/index.js`、`cloudfunctions/*/config.json`、`tools/prepare-cloudfunctions.js`。

## 1. 五个云函数一览

| 云函数 | timeout | memory | 职责 | 用 LLM | 定时触发 |
|---|---|---|---|---|---|
| `bill-svc` | 25s | 512MB | 记账主链路：语音入账、补记、手工记账、编辑、重复记账规则 | ✅ | ✅ 每天 0:30 |
| `asr-svc` | 60s | 512MB | 语音识别（腾讯云流式 ASR） | ❌ | — |
| `category-svc` | 10s | 256MB | 类目查询：树、搜索、创建 | ❌ | — |
| `user-svc` | 10s | 256MB | 登录自动注册、用户资料、家庭管理（10 个 action） | ❌ | — |
| `analysis-svc` | 40s | 512MB | 统计分析：概览、明细、分类占比、消费分析 | ✅ | ✅ 每天 0 点 |

> **timeout 不是随便配的**，每个都有对应的耗时结构：

| 云函数 | 耗时结构 | 最低要求 | 实际配置 |
|---|---|---|---|
| `bill-svc` | 单次 LLM（2.2s） | ≥10s | **25s** |
| `asr-svc` | 30s 录音按 1:1 实时率发送需 30s | >30s | **60s** |
| `analysis-svc` | 3~4 轮工具往返 + 数据库 + 冷启动 | ≥11s（建议 30~40） | **40s** |
| `category-svc` / `user-svc` | 纯数据库查询 | ≥5s | 10s |

**`asr-svc` 的 60s 是硬约束** —— 配 20s 必然超时（录音本身就要发 30s）。

### 1.1 analysis-svc 的定时触发器

```json
"triggers": [{
  "name": "dailyInsight",
  "type": "timer",
  "config": "0 0 0 * * * *"
}]
```

⚠️ **cron 是 7 段**（不是 5 段）：`0 0 0 * * * *` = 每天 0 点（UTC+8）。
⚠️ **`config.json` 不能有注释** —— 云开发不解析注释，写了注释会导致配置解析失败。

**触发器下发的 event 结构（官方）**：
```json
{ "Type": "Timer", "TriggerName": "dailyInsight", "Time": "2026-10-31T16:00:00Z", "Message": "" }
```

⚠️ **它没有 `action` 字段** —— 所以 `analysis-svc` 的入口要做**分发归一**
（`normalizeEvent()`）：识别 `Type === 'Timer'` → 映射成 `action = 'dailyInsight'`。
不做这一步 → 落 `default` 分支 → **定时分析每天都静默不执行**。

⚠️ **`Time` 是 UTC**，而 cron 规则是 UTC+8 → 月份必须按**东八区**算
（`dateUtil.toMonthStrCST()`），否则每月 1 号会分析上个月的数据。

⚠️ **部署是两步**：改 `config.json` 后要「云函数增量上传：更新文件」
**再**「上传触发器」——只部署代码，触发器不生效。

### 1.2 定时触发链路全景（每天 0 点批量分析）

> 全部为**已实施**。行号以 `cloudfunctions/analysis-svc/index.js` 为准，`shared/` 指源 `cloudfunctions/shared/`。
>
> ⚠️ **触发与执行全程在云端，手机端不在场**：`wx_trigger` 来源下
> `getWXContext().OPENID` 为空（`index.js:442-445`）——定时任务必须自己从
> 数据库找用户清单。手机端只在事后参与：分析页 `categoryBreakdown` **只读**
> 云端已存结果（读算分离）。

```
每天 0:00（UTC+8，7 段 cron）
   │  config.json:7-13  triggers: [{ name:'dailyInsight', type:'timer', config:'0 0 0 * * * *' }]
   ▼
微信云开发平台 → 调用 analysis-svc 的 index.main
   │  官方 event：{ Type:'Timer', TriggerName:'dailyInsight', Time:'...Z', Message:'' }
   │  ⚠️ 没有 action 字段（2026-10-31 实测修复，之前每天静默不执行）
   ▼
main() → normalizeEvent(event)                          index.js:78 → 142
   │  · 主判据 Type === 'Timer'，交叉校验 TriggerName === 'dailyInsight'
   │  · 显式丢弃平台 payload（防外部构造参数带进批量任务）
   │  · triggeredAt = parseTriggerTime(event.Time)（UTC ISO，解析失败回落 Date.now()）
   ▼
switch(action) → case 'dailyInsight' → dailyInsight()   index.js:90 → 541
   │  ① LLM_ENABLED=false → 直接跳过（skipped）          index.js:545
   │  ② month = toMonthStrCST(triggeredAt)               index.js:568
   │     · 东八区口径；用触发时刻而非 new Date()（防排队延迟跨月）
   │  ③ listPendingInsightUsers(month, { limit:50, cursor })   index.js:572
   │     · 只捞两类：从没分析过的用户 / 账单有新增的用户   shared/db/index.js:162
   │     · lastWrite = max(createTime, updateTime)（编辑也算变动）  shared/db/index.js:184-197
   │     · gen < lastWrite → 过期需重算；按 openid 排序 + cursor 分页
   │        （40s 装不完 → nextCursor 落返回值，下次触发继续）
   │  ④ 时间预算 32s（40s 留 8s 余量），逐个处理         index.js:604-612
   │     · 超预算的用户标 deferred，不硬超时丢结果
   ▼
refreshInsight(context, { targetOpenid, month })        index.js:614-618 → 438
   │  · 定时触发无用户上下文（OPENID 为空），必须显式指定 targetOpenid
   │  · isTriggerSource()：getWXContext().SOURCE === 'wx_trigger'
   │    才允许 targetOpenid（外部无法伪造 SOURCE，防越权写）  index.js:508-520
   │  · 单用户失败不中断整批（try/catch 逐个隔离）       index.js:627-631
   ▼
逐用户 computeInsight + saveInsight 落库
   ▼
返回 { processed, skipped, failed, deferred, nextCursor, hasMore, month }   index.js:637-650
```

**与读算分离的关系**：分析页打开的 `categoryBreakdown` **只读不计算**（§2.5），
用户看到的数据就来自这条链路每天写进 `users` 集合的结果——
定时任务没跑成时，前端不会自动兜底重算，只能靠 `refreshInsight` 手动触发。

### 1.3 bill-svc 的定时触发器（每天 0:30 重复记账）

```json
"triggers": [{
  "name": "dailyRecurring",
  "type": "timer",
  "config": "0 30 0 * * * *"
}]
```

> 已实施（2026-10-31，版本 `20261031-03`）。行号以 `cloudfunctions/bill-svc/index.js` 为准。

```
每天 0:30（UTC+8，7 段 cron，晚于 analysis 的 0:00）
   │  config.json:9-15  triggers: [{ name:'dailyRecurring', type:'timer', config:'0 30 0 * * * *' }]
   ▼
main() → normalizeEvent(event)                          index.js:141-152
   │  · Type === 'Timer' + TriggerName === 'dailyRecurring' → { action:'dailyRecurring', payload:{triggeredAt} }
   │  · 与 analysis-svc 的归一同款（官方 Timer event 没有 action 字段）
   ▼
handleDailyRecurring()                                  index.js:1162-1233
   │  ① isTriggerSource()：getWXContext().SOURCE === 'wx_trigger'，否则拒绝（TRIGGER_ONLY） index.js:1247
   │     · 该 action 不暴露给前端 —— 触发器扫描全量用户，前端可调 = 跨用户写 + DoS
   │  ② today = toDateStrCST(triggeredAt)               index.js:1170
   │     · 东八区口径（运行时 UTC+0、cron UTC+8）
   │  ③ listDueRecurringRules(today)：status='active' + delFlag=false + nextDate <= today
   │  ④ 逐规则 try/catch（单条失败不拖垮整批）：
   │     · nextDate < today → 漏跑，跳过不补记，游标前移
   │     · findBillByRuleAndDate 已存在 → 跳过（幂等第二道防线）
   │     · buildBill({source:'auto', ruleId}) → insertBillAsUser(bill, rule.userId)
   │       ⚠ 触发器无 openid，userId 必须来自规则文档 —— 绝不能走 insertBill
   │  ⑤ 返回 { generated, skipped, failed }
```

**与 `dailyInsight` 的两点不同**：
1. **无用户上下文更彻底** —— `dailyInsight` 至少还有 `refreshInsight` 的用户路径，
   `dailyRecurring` 生成账单只能由触发器完成，没有前端等价物。
2. **幂等靠游标 + 存在性双保险** —— `nextDate` 前移是第一道，写前查
   `findBillByRuleAndDate` 是第二道（防触发器重复下发）。

## 2. action 全表

### 2.1 bill-svc（11 个）

| action | 用途 | LLM | source |
|---|---|---|---|
| `record` | 语音/文字入账 | ✅ | `voice` |
| `recall` | 事后补记（给候选，**绝不自动入账**） | ✅ | `recall` |
| `manual` | 用户直填（跳过 LLM） | ❌ | `manual` |
| `amend` | 编辑/软删除已有账单 | ❌ | — |
| `diag` | 诊断（返回云端版本号等） | ❌ | — |
| `ruleCreate` | 建重复记账规则（游标 = 明天起首个匹配日） | ❌ | — |
| `ruleList` | 列自己的规则（delFlag=false） | ❌ | — |
| `ruleUpdate` | 改规则（仅对未来生效；改 repeat 重算游标） | ❌ | — |
| `rulePause` | 暂停/恢复（恢复不补记，从明天起继续） | ❌ | — |
| `ruleDelete` | 软删除规则（历史账单保留） | ❌ | — |
| `dailyRecurring` | 定时生成账单（**仅触发器**，见 §1.3） | ❌ | `auto` |

**`manual` 与 `recall` 必须分开** —— recall 会打 `isRecall` 标记，混用会污染补记转化率埋点。

**`diag` 是版本对账的锚点** —— 前端用它拿云端 `codeVersion`。

**规则五件套与 `dailyRecurring` 的分工**：前者管「配置」（带用户上下文），
后者管「执行」（仅 `wx_trigger` 来源）。生成链路在 §1.3，
规则字段与口径见 `engineering/23-change-impact.md` 的「重复记账」小节。

**账本归属（已实施 2026-11-01）**：`record` / `recall` / `manual` / `amend` 接受可选 `ledger`
（缺省/`'personal'` 走原路径零新增查询；`'family'` 经 `resolveLedger`，`bill-svc/index.js:1554`，
校验成员后写 `family_bills`，familyId 为空直接 throw 不回退；其他值 throw）。
家庭账单 userId = 记录人，只有记录人能编辑/撤销。详见 `business/04-family-mode.md` §4。

### 2.2 asr-svc（7 个）

| action | 用途 |
|---|---|
| `startRecognize` | 上传音频 → 后台开始流式识别，返回 `jobId` |
| `pollResult` | 轮询识别结果 |
| `recognize` | 同步识别（旧接口） |
| `cleanup` | 清理临时文件 |
| `status` | 查询任务状态 |
| `pluginStatus` | 兼容旧调用名 |
| `selfTest` | 自检 |

**关键设计**：`startRecognize` **立即返回** `jobId`，识别在云函数后台跑，前端轮询。
原因：30 秒录音按 1:1 实时率发送音频本身就要 30 秒，同步等待必然超时。

### 2.3 category-svc（3 个）

| action | 入参 | 用途 |
|---|---|---|
| `tree` | — | 返回完整类目树 |
| `search` | `keyword` | 关键词搜索类目 |
| `create` | `name, level, parentId` | 创建自定义类目 |

### 2.4 user-svc（10 个，已实施 2026-11-01）

| action | 用途 | 关键校验 |
|---|---|---|
| `login` | **幂等自动注册**（首调建档 `isNew=true`，再调不重建档案不重写 createTime） | — |
| `profile` | openid 脱敏 + 资料 + 已记笔数 | — |
| `updateProfile` | 昵称/头像（白名单，null 不写，超长截断） | 空 payload 报错 |
| `familyCreate` | 创建家庭（创建者自动加入，ownerId=创建者） | 已加入者不能再创建 |
| `familyJoin` | 邀请码加入（大小写归一） | 码错/过期/满员/已加入 → 各自明确报错 |
| `familyInfo` | 我的家庭（isOwner/成员数/邀请码）；未加入 → `inFamily:false` | 成员才能看到邀请码 |
| `familyMembers` | 成员列表（**不暴露 userId**，isMe/isOwner 由云端标） | 非成员拒绝 |
| `familyLeave` | 退出（familyId 置空串） | owner 禁止退出 |
| `familyRegenCode` | 重新生成邀请码（旧码立即失效） | 仅 owner |
| `familyDissolve` | 解散（families 置 delFlag + 全员清归属） | 仅 owner |

出处：`user-svc/index.js:67-76`（switch 全表）、各 handler `:119-270`。详见 `business/04-family-mode.md` §6。

### 2.5 analysis-svc（6 个）

| action | 用途 | 跑 LLM | 读/写 |
|---|---|---|---|
| `monthSummary` | 本月概览（总额/笔数） | ❌ | 读 |
| `monthBills` | 某月明细流水 | ❌ | 读 |
| `categoryBreakdown` | 读已存的分类占比 + 分析结论 | ❌ | **只读** |
| `refreshInsight` | 立即分析（算这一个用户） | ✅ | 写 |
| `dailyInsight` | 定时批量 | ✅ | 写 |
| `diag` | 分析链路诊断（7 项检查） | ❌ | — |

**`categoryBreakdown` 绝不触发计算** —— 这是「读算分离」的核心，分析页打开是毫秒级。

**账本参数（已实施 2026-11-01）**：`monthSummary` / `monthBills` / `categoryBreakdown`（→ readInsight）/
`refreshInsight` 接受可选 `ledger`，统一走 `resolveScope(context, payload)`（`analysis-svc/index.js:710`）——
`'family'` 反查 profile.familyId 并校验成员，非成员/无家庭直接 throw 不回退个人。
**`dailyInsight` 定时链路不动**（仍只处理个人；定时家庭聚合留 v2）。
家庭 insight 文档 `users/family_${familyId}_insight` **顶层无 userId/month**（month 进 payload），
靠这条纪律天然挡在每日个人扫描之外。详见 `business/04-family-mode.md` §5。

## 3. shared 多副本机制

### 3.1 副本布局

```
cloudfunctions/
├── shared/                     ← 源（source of truth），27 个非测试文件
├── bill-svc/{index.js, config.json, package.json}
│   ├── shared/                 ← 副本 1（随包上传）
│   └── node_modules/shared/    ← 副本 2（不随包上传）
├── asr-svc/ ... 同上
├── category-svc/ ... 同上
├── user-svc/ ... 同上
└── analysis-svc/ ... 同上
```

**共 5 份源 + 10 份副本 = 15 份拷贝。**

### 3.2 为什么必须是「普通子目录」

> 这是本项目**最贵的教训**（`tools/prepare-cloudfunctions.js` 头部注释原文）：
>
> 最初的做法是把 shared 复制到 `cloudfunctions/<svc>/node_modules/shared`，
> 但选「上传并部署：云端安装依赖」时，开发者工具**不上传本地 node_modules**。
> 于是本地全绿、测试全过，云端却报 `Cannot find module`。

| 加载路径 | 云端可达 |
|---|---|
| `__dirname/shared/` | ✅ **唯一可靠** |
| `process.cwd()/node_modules/shared/` | ❌ 不随包上传 |
| `__dirname/../shared/` | ❌ 指向仓库根的源，云端不存在 |

**结论：本地全绿 ≠ 云端能跑。**

### 3.3 loadShared 的加载顺序

每个云函数 `index.js` 都有同一份 `loadShared()`，按「云端可达性」排序（不是本地方便程度）：

```js
function loadShared(modulePath) {
  const tried = [
    path.join(__dirname, 'shared', modulePath),              // 1. 云端唯一可靠来源
    path.join(process.cwd(), 'node_modules/shared', modulePath), // 2. 本地快路径
    path.join(__dirname, '..', 'shared', modulePath)          // 3. 兄弟目录
  ];
  // 依次尝试，全失败则抛错并列出 tried
}
```

### 3.4 同步脚本

```bash
npm run prepare:cf     # = node tools/prepare-cloudfunctions.js
```

| 事实 | 出处 |
|---|---|
| 排除 `node_modules` / `__tests__` / `.DS_Store` | `EXCLUDE_NAMES` |
| 源有测试目录，副本没有 | 实测 `diff -rq` 只差 `__tests__` |
| 写入 `<svc>/shared/` 与 `<svc>/node_modules/shared/` 两处 | `prepare-cloudfunctions.js` |
| 做文件数校验 | 数量不符直接报错 |
| 改 `constants.js` → **10 份副本** hash 全变 → preflight 报漂移 | 实测 |

### 3.5 共享状态必须挂 globalThis

副本之间**不共享模块级变量**（每个副本是独立的 module 实例）。
需要跨副本共享的状态只能挂 `globalThis`。

> 本地 mock 注入也必须写 `globalThis` —— 写模块变量对副本无效。

## 4. 部署四步

| # | 动作 | 自动化 |
|---|---|---|
| 1 | `shared/util/constants.js` 的 `CODE_VERSION` +1 | ✅ preflight 查 |
| 2 | 同步 `miniprogram/utils/cloud.js` 的 `EXPECTED_CODE_VERSION` | ✅ preflight 查 |
| 3 | `npm run prepare:cf` | ✅ 有脚本 |
| 4 | 开发者工具右键云函数 →「上传并部署：云端安装依赖」 | ❌ **只能人工** |

### 4.1 第 3 步漏跑 = 版本不一致，且报错方向是错的

因为 shared 是**多副本**，只改源没跑同步 → 副本停在旧版本 → 看起来像「忘了部署」，实际是「忘了同步」。

preflight 已做**内容级守卫**（逐文件 sha1）。

> ⚠️ **存在性检查对漂移失灵** —— 旧副本文件也都在，只查「文件是否存在」查不出漂移。必须比对内容哈希。

### 4.2 必须选「云端安装依赖」

否则 `wx-server-sdk` 不进包，diag 报「SDK 初始化」失败。

### 4.3 timeout 可能不生效

真机实测：写 25s 实际按 3s 执行。官方注明**云函数配置只对 `$LATEST` 生效** —— 若调用落到已发布版本，调 timeout 不起作用。

`shared/util/constants.js:68-97` 的注释专门记了这件事，并明确纠正了一个流传很广的错误说法：

> ❌「小程序调用云函数有 3 秒网关上限，客户端只能等 3 秒」—— **这是错的**
> ✅ timeout 默认值确实是 3 秒，但**可调至 1~900 秒**，调高后客户端会等函数执行完
> ✅ `-504003` 里的 "3 seconds" 指的是**你云函数自己的 timeout**，不是平台硬限制

**代价**：代码侧必须假设「只有 3 秒可用」→ 单次 LLM 上限 2200ms、不重试、超时立刻走规则降级。

> 这是**刻意的**——宁可让用户多点一次，也不能让请求失败。

## 5. 运行时限制（云端 ≠ 本地）

| 限制 | 说明 | 对策 |
|---|---|---|
| **没有全局 `cloud`** | 必须显式 `require('wx-server-sdk')` | 走 `shared/db/sdk.js` 的 `ensureSdk()`，不可用返回 null |
| **没有全局 `fetch`** | Node 18 的 fetch 只在 ESM 上下文注入，项目全用 CommonJS | 一律用 `shared/util/http-client.js` 的 `postJson()` |
| **没有内置 WebSocket** | 云函数是精简运行时 | 加 `ws` npm 依赖 |
| **shared 不进包** | 「云端安装依赖」不传本地 node_modules | shared 放函数目录内的**普通子目录** |

### 5.1 fetch 这条最隐蔽

`Nodejs18.15` + **CommonJS** → 全局 `fetch` 不存在 → `ReferenceError`。
Node 18 的 fetch 只在 ESM 上下文注入 globalThis，本项目全用 `require` 拿不到。

> **本地 Node 22 有 `fetch` → 本地全绿、云端必然失败。**

**铁律**：云端发 HTTP 一律用 `shared/util/http-client.js` 的 `postJson()`；禁止写 `fetch(...)`。

**测试必须 mock 同一个东西**：注入 `httpClient.__setImpl()`，且要注入**云函数实际加载的副本**
`cloudfunctions/<svc>/shared/util/http-client.js`，不是源文件。
验证方法：`delete global.fetch;` 后仍能正常发请求。

### 5.2 删代码要查残留引用

删掉 `AbortController` 时 `finally { clearTimeout(timer) }` 引用已删变量 → **每次请求都抛 ReferenceError**。
`node --check` 查不出。

> **删变量必须搜一遍所有引用**（含 `finally`/`catch`）。

## 6. 环境变量

| 变量 | 用途 | 谁用 |
|---|---|---|
| `DEEPSEEK_API_KEY` | DeepSeek 密钥 | `bill-svc`、`analysis-svc` |
| `LLM_ENABLED` | 总开关（`false` → 走 mock） | 同上 |
| `DEBUG_TRACE` | 打开 agent 详细 trace | `analysis-svc` |
| `TENCENT_ASR_APP_ID` / `SECRET_ID` / `SECRET_KEY` | 腾讯云语音识别 | `asr-svc` |

⚠️ **`DEBUG_TRACE` 排查完要删掉** —— 会让账单金额进日志（隐私）。

⚠️ **改了环境变量必须重新部署**才生效。

### 6.1 无 API Key 时的行为

`llm-client.js` 的 `isMockMode()` → `DEEPSEEK_API_KEY` 缺失或 `LLM_ENABLED=false` → 直接返回
`{ ok:false, error:'NO_API_KEY', mock:true }`，**不请求网络**。

> ⚠️ **mock LLM 的坑**：测试时必须设 `process.env.DEEPSEEK_API_KEY`，否则 mock 形同虚设
> （表现为「LLM 明明返回了却 `isFallback=true`」）。

## 7. 版本戳机制

| 位置 | 常量 | 当前值 |
|---|---|---|
| `shared/util/constants.js:183` | `CODE_VERSION` | `20261103-01` |
| `miniprogram/utils/cloud.js:21` | `EXPECTED_CODE_VERSION` | `20261103-01` |

**格式**：`YYYYMMDD-NN`，NN 为当天第几次改动。

### 7.1 为什么需要它

> 云函数部署后，「跑的是哪份代码」完全不可见：日志里不会打版本号，开发者工具也不会提示「上传的是 20 分钟前的版本」。
> 于是「未知操作: diag」这类问题只能靠猜 —— 是代码没写、还是没上传？每次猜错都要来回好几轮。

### 7.2 前端对账逻辑（已实施 2026-11-03：只警告不阻断）

`miniprogram/utils/cloud.js` 的 `warnCodeVersion(result)`：

| 情况 | 处理 |
|---|---|
| `remote === EXPECTED` | 放行 |
| 老版本云函数没有这个字段 | **放行**（不打扰） |
| 格式不认识 / 日期不同 | 只打 `console.warn`，**不阻断** |
| 云端 seq < 本地 seq | `console.warn`「云端版本过旧（不阻断）」+ 部署建议 |
| 云端 seq > 本地 seq | `console.warn`「本地包版本过旧（不阻断）」+ 重新编译建议 |

> ⚠️ **2026-11-03 起改为只警告不阻断**（原 `assertCodeVersion` 会 throw）：
> 云端一部署新版本，已发布线上版（冻结的旧 `EXPECTED_CODE_VERSION`）的每次调用
> 都会撞上跨日期版本差 → 「云端部署完成 → 新版发布」的窗口期内旧版用户功能
> 整段不可用，且窗口取决于审核节奏、不可控。现在差异只进真机日志与诊断面板，
> 不拦业务调用。`action === 'diag'` 仍跳过对账（诊断输出本身已含版本号）。

**版本号比较必须拆成 `{date, seq}` 数字比** —— 字符串比较下 `'20261018-9' > '20261018-14'` 成立，是错的。

## 8. 常见故障速查

| 症状 | 根因 | 修法 |
|---|---|---|
| `Cannot find module 'shared/...'` | 没跑 `prepare:cf` 或 shared 放错位置 | 跑 `prepare:cf`，确认 shared 在函数目录内的普通子目录 |
| 云端报「SDK 初始化」失败 | 选了「上传并部署：覆盖安装」 | 改选「云端安装依赖」 |
| 版本不一致但刚部署过 | 副本漂移 | 跑 `prepare:cf` |
| 真机 3 秒就 -504003 | timeout 只对 `$LATEST` 生效 | 检查调用的版本；或接受 3 秒假设（代码已按此设计） |
| 改了代码云端没变化 | 忘了部署 / 部署了错误版本 | 用 `diag` 拿云端版本号比对 |
| `ReferenceError: fetch is not defined` | 云端用了 `fetch` | 改用 `shared/util/http-client.js` 的 `postJson()` |
| 每次请求都抛 ReferenceError | 删代码后有残留引用 | 搜一遍所有引用（含 `finally`/`catch`） |
| 重复规则到点不生成账单 | 触发器没上传 / `recurring` 集合没建 | `config.json` 走「增量上传」+「上传触发器」两步；集合查 diag 面板 |
| 触发器生成账单记成「昨天」 | 用了本地时区而非东八区 | 全链用 `toDateStrCST`/`getWeekdayCST`（`shared/util/date.js`） |

详见 `engineering/20-pitfalls.md`。
