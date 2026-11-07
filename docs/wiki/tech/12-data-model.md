# 12 数据模型

> 覆盖：7 个集合的文档结构 · 数据访问层 45 个导出 · 金额单位约定 · 软删除 · 索引与查询上限。
>
> 权威实现：`cloudfunctions/shared/db/index.js`（1518 行）、`cloudfunctions/shared/util/constants.js`。

## 1. 七个集合

`shared/util/constants.js:48-55`：

```js
const COLLECTIONS = {
  BILLS: 'bills',           // 流水（主集合）
  CATEGORIES: 'categories', // 类目（支持用户自定义扩展）
  TEMPLATES: 'templates',   // 自动记账模板 —— ⚠️ 代码中无任何写入
  USERS: 'users',           // 用户设置与画像
  RECURRING: 'recurring',   // 重复记账规则（dailyRecurring 定时生成账单）
  FAMILIES: 'families',     // 家庭（创建者 + 邀请码）
  FAMILY_BILLS: 'family_bills'  // 家庭账本流水（与 bills 同构 + familyId）
};
```

| 集合 | 用途 | 写入方 | 读取方 |
|---|---|---|---|
| `bills` | 账目流水 | `insertBill` / `insertBillAsUser` | `listBills` / `monthStat` / `recentBillsByMonth` / `fetchAll` |
| `categories` | 预置（代码内）+ 自定义（用户建） | `insertCustomCategory` | `listCustomCategories` |
| `users` | 用户档案（`_profile`）+ 个人 insight + **家庭 insight**（`family_*`） | `saveProfile` / `saveInsight` / `saveFamilyInsight` | `getProfile` / `getInsight` / `getFamilyInsight` |
| `templates` | 自动记账模板 | **无** | **无** |
| `recurring` | 重复记账规则（已实施，2026-10-31） | `insertRecurringRule` / `updateRecurringRule` / `softDeleteRecurringRule` | `listRecurringRules` / `listDueRecurringRules` |
| `families` | 家庭（已实施，2026-11-01） | `familyCreate` / `familyJoin` / `familyRegenCode` / `familyDissolve` | `familyGet` / `familyMembers` |
| `family_bills` | 家庭账本流水（bills 同构 + familyId；userId = 记录人） | `insertFamilyBill` / `softDeleteFamilyBill` | `listFamilyBills` / `familyMonthStat` / `familyRecentBillsByMonth` |

⚠️ **`templates` 是死集合** —— 全仓无写入/读取代码。做 Wiki 时不要把它写成「有功能」。

⚠️ **`families` / `family_bills` 必须在控制台手工创建**（权限同 bills：所有用户可读，仅创建者可读写），
`REQUIRED_COLLECTIONS`（`db/index.js:1461`）已纳入，diag 面板动态生效。

### 1.1 集合必须手工创建

```js
/**
 * 注意：这些集合必须在云开发控制台**手工创建**。
 * 云开发的 createCollection 接口需要管理员权限，从云函数调用会失败，
 * 因此代码里不做自动建表，只在报错时给出明确指引。
 */
```

`ensureCollections()` 存在但**不做建表**，只读 `REQUIRED_COLLECTIONS`（**从代码动态读取**）并检查。

> `listCustomCategories` 对「集合不存在」做了特殊处理 —— 识别到 `not exist|does not exist|not found|集合` 就返回 `[]`，
> 因为该用户从未创建过自定义类目是正常初始态，不是错误。

### 1.2 recurring 集合文档结构

`insertRecurringRule(rule)`（`db/index.js:1191`，已实施）：

```js
{
  userId,            // 归属 —— 定时生成账单时是账单归属的唯一来源
  amount,            // 整数分（与 bills 同口径）
  categoryId, categoryPath,   // 必须成对（同 bills）
  note,              // ≤200 字
  account,           // wechat|alipay|cash|card|unknown，默认 unknown
  repeat: {          // 参数只存该类型用得到的字段（normalizeRepeatParams 裁剪）
    type,            // daily|weekday|weekly|monthly|quarterly|yearly
    dayOfWeek,       // weekly：0-6（东八区星期）
    dayOfMonth,      // monthly/quarterly/yearly：1-31
    month            // yearly：1-12
  },
  status: 'active' | 'paused',
  nextDate,          // 'YYYY-MM-DD'（东八区）—— 调度游标，见下
  ledger,            // 账本归属（已实施 2026-11-01，20261101-03）：'personal'（缺省，兼容老文档）| 'family'
  familyId,          // 仅 ledger='family' 有值；创建时云端反查（resolveLedger），前端不传
  delFlag: false,    // 软删除（同 bills 纪律）
  createTime, updateTime
}
```

**调度游标 `nextDate` 是幂等与「不补记」的核心**：
- 创建/改 repeat 参数 → 游标 = **明天起**第一个匹配日（创建当天不生成）
- 定时扫描命中 → 生成账单 → 游标前移到下一个匹配日
- `nextDate < 今天`（漏跑/暂停恢复）→ **不补记**，游标直接跳到今天之后
- 生成前再查账本分流的幂等函数：个人 `findBillByRuleAndDate(userId, ruleId, today)`；家庭 `findFamilyBillByRuleAndDate(familyId, ruleId, today)`（查 family_bills，fetchAll + JS 过滤 ruleId）—— 已存在则跳过（第二道防线）

**账本归属口径**（与产品确认）：规则私有；账本创建后不可改；退出/解散家庭 → 该成员家庭规则自动 paused（`pauseFamilyRecurringRules`）；定时生成时兜底校验家庭存在 + 创建者仍是成员，失效跳过 + 游标前移。家庭账单 userId = 规则创建者 = 记录人。

**校验口径**（`validateRepeat`，`shared/util/recurring.js:80`）：monthly/quarterly 的
`dayOfMonth` 只查 1-31 区间；**yearly 额外拒绝当月不存在的那天**
（2 月 30/31 日、4 月 31 日…），2 月 29 日合法（平年跳过、闰年命中）。
调度纯函数见 `shared/util/recurring.js`（`matches` / `nextOccurrence`）。

### 1.3 家庭集合文档结构（已实施，2026-11-01）

`families`（`familyCreate`，`db/index.js:520`）：

```js
{
  name,              // 家庭名
  ownerId,           // 创建者 openid —— 唯一能 regen 邀请码 / 解散
  inviteCode,        // 8 位，排除易混字符 0/O/1/I（大小写归一）
  inviteExpiresAt,   // 时间戳，72 小时有效期（INVITE_TTL_MS，constants.js:78）
  delFlag,           // 解散软删（familyDissolve）
  createTime, updateTime
  // ⚠️ 不维护 memberCount 字段 —— 成员数是真实文档计数（避免缓存不一致）
}
```

`family_bills`（`insertFamilyBill`，`db/index.js:691`）：**bills 同构 + familyId**，
`userId` = 记录人（只有记录人能编辑/撤销自己的账，where 带 `userId: openid`）；
查询一律带 `delFlag: false`（与 bills 同纪律）。

用户归属：`profile.familyId` 单值指向 `families` 的 `_id`；`''` = 无家庭。
**familyId 云端权威**：一律从 profile 反查，不信任前端。

## 2. bills 文档结构

`insertBill(bill, context)`（`db/index.js:104`）：

```js
{
  userId,            // 强制取 getWXContext().OPENID（覆盖传入值）
  amount,            // 整数分 —— Math.round(bill.amount)，杜绝浮点残留
  categoryId,
  categoryPath,      // '餐饮/外出就餐/火锅烧烤' ← 统计侧完全靠这个分组
  date,              // 'YYYY-MM-DD'
  ts,                // 时间戳，用于 orderBy
  account,           // wechat|alipay|cash|card|unknown
  note,              // 统一裁到 200 字
  source,            // voice|auto|recall|manual
  ruleId,            // 仅 source='auto' 的账单：来源重复规则 _id（溯源标记，可空）
  isRecall,          // source === 'recall'
  recallDaysLater,
  aiMeta: { agent, isFallback },
  confidence,
  delFlag: false,    // 软删除标记
  createTime,        // 首次写入
  updateTime         // 最后修改 —— 过期判定用 max(createTime, updateTime)
}
```

### 2.1 ⚠️ 云开发数据库无 schema，但 null 会出问题

> 无值时**直接不写该字段**，而不是写 `null` —— null 值在部分环境会触发写入异常。

### 2.2 `categoryId` 与 `categoryPath` 必须成对

统计侧**完全靠 `categoryPath` 分组**：

```js
top    = split('/')[0]     // 一级
leaf   = split('/').pop()   // 末级
second = split('/')[1]      // 二级
```

只改 id 不改 path → 界面显示旧类目、统计按旧类目算。

**且不信任前端传的 path** —— 预置类目一律按 id 反查（`preset.pathOf(id)`）。

### 2.3 `source` 的四个值

`shared/util/constants.js:12-17`：

```js
const BILL_SOURCE = { VOICE:'voice', AUTO:'auto', RECALL:'recall', MANUAL:'manual' };
```

| source | 场景 | `isRecall` |
|---|---|---|
| `voice` | 语音记账 | false |
| `auto` | 自动入账：重复记账规则定时生成（历史模板账单同值）；明细页标「自动」badge | false |
| `recall` | 事后补记 | **true** |
| `manual` | 用户直填 | false |

## 3. users 集合与 insight 文档

### 3.1 固定 `_id`

```js
const docId = `${openid}_insight`;   // 一用户一份，天然隔离
```

用**固定 `_id` + `set()`**，不是 query-then-write（避免并发覆盖窗口）。

### 3.2 完整字段（`saveInsight`，`db/index.js:266-288`）

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `userId` | string | — | 归属用户 |
| `month` | string | — | `YYYY-MM` |
| `version` | string | `'v2'` | 分析版本 |
| `insights` | array | `[]` | 文字洞察（≤5 条） |
| `savings` | array | `[]` | 结构化建议（≤3 条） |
| `pie` | array | `[]` | 分类占比 |
| `total` | string | `''` | 本月总额（展示值） |
| `billCount` | number | `0` | 本月笔数 |
| `deltaText` | string | `''` | 环比文案 |
| `deltaDirection` | string | `''` | `up`/`down`/`flat` |
| `trend` | array | `[]` | 多月趋势 |
| `meta` | object | `{}` | 见下 |
| `generateTime` | number | — | 生成时间戳 |
| `updateTime` | number | — | 最后更新 |

### 3.3 ⚠️ 硬编码字段白名单 —— 加字段必须改这里

```js
const data = {
  userId, month, version,
  insights: insight.insights || [],
  savings:  insight.savings  || [],
  pie:       insight.pie       || [],
  total:     insight.total     || '',
  billCount: insight.billCount || 0,
  deltaText: insight.deltaText || '',
  deltaDirection: insight.deltaDirection || '',
  trend:     insight.trend     || [],
  meta:      insight.meta      || {},
  generateTime: now, updateTime: now
};
```

**新字段不加进这个对象 → 不落库。**

> 症状极其隐蔽：`refreshInsight` 当次返回是有的（内存里有），
> 但前端刷新后从 `readInsight` 读不到 → **表现为「时好时坏」**。

`readInsight` 也要同步加读取，且老数据要能处理字段缺失（`|| []` / `|| {}`），否则历史月份白屏。

### 3.4 `meta` 的内容

| 字段 | 值 | 含义 |
|---|---|---|
| `savingsSource` | `'llm'` / `'unavailable'` | `'unavailable'` → AI 没跑成，savings 恒空 |
| `billCount` | number | 本月有效笔数 |
| `droppedCount` | number | 被 `normalizeBills` 排除的脏数据数 |
| `agentVersion` | string | 如 `'v3'` |

### 3.5 读时校验归属

```js
if (doc.userId && doc.userId !== openid) return null;
```

**不信任文档里的 userId** —— 固定 `_id` 已提供隔离，这层是双保险。

### 3.6 过期判定

| 判据 | 含义 |
|---|---|
| `hasResult: false` | 从没分析过 |
| `hasResult: true` + `savings: []` | 分析了但没空间 |
| `isStale: true` | 存的是上个月（`doc._stale`） |
| `isOutdated: true` | 同月内账单被改过 |

判据统一为 **`max(createTime, updateTime)`** —— 定时任务与页面必须一致。

查不到变更时间时**按「未过期」处理**（宁可让用户多点一次）。

> ⚠️ **把上个月结论当本月展示是错误信息，比显示「旧数据」严重得多。**

### 3.7 用户档案文档（`saveProfile`，`db/index.js:428`，已实施 2026-11-01）

```js
users/${openid}_profile: {
  userId,            // openid
  nickname,          // ≤30 字；⚠️ 不写 null（无值不落字段）
  avatarUrl,         // ≤500 字；同上
  familyId,          // 家庭 _id；'' = 无家庭。⚠️ 不传 = 保留旧值（防误退家庭）
  createTime, updateTime
}
```

- **字段白名单**：白名单外字段一律不落库（测试断言 `hack`/`isAdmin` 被丢弃）
- **顶层不得有 `month`** —— 否则被 `listPendingInsightUsers` 的 `where({month})` 捞进每日分析扫描
- `login` 幂等：首调建档（`isNew=true`），再调**不重建档案、不重写 createTime**
- `updateProfile` 空 payload 明确报错，不静默成功

### 3.8 家庭 insight 文档（`saveFamilyInsight`，`db/index.js:889`，已实施 2026-11-01）

```js
users/family_${familyId}_insight: {
  familyId,
  version,           // 'v2'
  payload: {         // 与个人 insight 同构，month 放这里
    month, insights, savings, pie, total, billCount, deltaText, deltaDirection, trend, meta
  },
  generateTime, updateTime
}
```

⚠️ **顶层不得有 `userId` / `month`**（两条真实踩坑，见 `business/04-family-mode.md` §5.1）：
① 顶层 month 会被 `listPendingInsightUsers` 的 `where({month})` 每日扫描把 `family_*` 文档捞进个人批次；
② 顶层 userId（owner 的）会与 owner 个人 insight 的 `generateTime` 混算 → owner 个人结论**永不重算**。

- `saveFamilyInsight` **自持字段白名单，绝不复用 `saveInsight`**（后者硬编码顶层 userId+month）
- `getFamilyInsight`（`db/index.js:945`）返回**拍平结构**（payload 提升到顶层 + generateTime/updateTime）
  → readInsight 的 `isStale`/`isOutdated` 判定零分支复用；跨月读返回 `_stale: true`；familyId 不匹配返回 null（双保险）

## 4. categories 集合

### 4.1 自定义类目文档（`insertCustomCategory`）

```js
{
  userId,           // 归属
  name,             // 类目名
  path,             // '餐饮/外出就餐/用户自定义'
  color,            // 默认 '#A8A8A8'
  keywords,         // 默认 [name]
  custom: true,     // ← 标记自定义
  delFlag: false,
  createTime, updateTime
}
```

> ⚠️ **自定义类目没有 `categoryId` 字段** —— 只有 `name` + `path` + `keywords`。
> 这是「自定义类目 id 不在预置库里 → 云端反查不到 path」的根源。

### 4.2 查询

```js
db.collection(COLLECTIONS.CATEGORIES)
  .where({ userId: openid, delFlag: false })
  .limit(100)
  .get();
```

量级很小（几十个封顶），一次取完。

### 4.3 预置类目不在数据库里

166 个预置类目**硬编码在 `shared/util/category-preset.js`**，不在 `categories` 集合。
`categories` 集合**只存用户自建的**。

> 这就是 `category-svc` 的 `tree` action 要「预置 + 自定义合并」的原因。

## 5. 数据访问层：45 个导出

`shared/db/index.js` 的 `module.exports`（`:1401`）：

### 5.1 连接与状态（6 个）

| 函数 | 作用 |
|---|---|
| `currentOpenId(context)` | 取当前用户 openid |
| `getWxContext()` | 包装 `getWXContext()` |
| `isAvailable()` | SDK 是否可用 |
| `sdkInitError()` | 初始化失败原因 |
| `getDb()` | 拿 db 实例（不可用返回 null） |
| `ensureCollections()` | 检查集合存在（**不建表**） |

### 5.2 账单（7 个）

| 函数 | 签名 | 作用 |
|---|---|---|
| `insertBill` | `(bill, context)` | 写入，强制取 OPENID |
| `listBills` | `(openid, opts = {})` | 按月/日查询 |
| `monthStat` | `(openid, month)` | 本月总额 + 笔数 |
| `recentBillsByMonth` | `(openid, monthCount = 6, endMonth = null)` | 跨月拉数据 |
| `getLatestBillChangeTime` | `(openid, month)` | 该月最后一次变更时间 |
| `softDelete` | `(openid, billId)` | 软删除 |
| `insertBillAsUser` | `(bill, userId)` | 以**指定 userId** 写账单 —— **定时触发器专用**（无 openid，`insertBill` 会 throw）。不暴露给前端 action |

### 5.3 分析（4 个）

| 函数 | 作用 |
|---|---|
| `categoryBreakdown(openid, month)` | 应用侧聚合分类占比 |
| `saveInsight(openid, insight, month, version = 'v2')` | 落库（**字段白名单**） |
| `getInsight(openid, month)` | 读取 + 算 `isStale`/`isOutdated` |
| `listPendingInsightUsers(month, opts = {})` | 捞待分析用户（**定时任务用**） |

### 5.4 档案（2 个，已实施 2026-11-01）

| 函数 | 签名 | 作用 |
|---|---|---|
| `getProfile` | `(openid)` | 读 `users/${openid}_profile`；未注册返回 null（正常初始态） |
| `saveProfile` | `(openid, data)` | 落库（**字段白名单**：nickname/avatarUrl/familyId；null 不写；超长截断 30/500） |

### 5.5 家庭（7 个，已实施 2026-11-01）

| 函数 | 签名 | 作用 |
|---|---|---|
| `familyGet` | `(familyId)` | 读家庭（含 delFlag 校验） |
| `familyCreate` | `(openid, name)` | 创建（创建者自动加入，ownerId=创建者） |
| `familyJoin` | `(openid, inviteCode)` | 邀请码加入（码错/过期/满员/已加入 → 明确报错；成员上限 `FAMILY.MAX_MEMBERS`，`constants.js:76`） |
| `familyMembers` | `(familyId, openid)` | 成员列表（**不暴露 userId**，isMe/isOwner 云端标） |
| `familyLeave` | `(openid, familyId)` | 退出（owner 禁止） |
| `familyRegenCode` | `(openid, familyId)` | 重发邀请码（仅 owner，旧码立即失效） |
| `familyDissolve` | `(openid, familyId)` | 解散（仅 owner；families 置 delFlag + 全员清归属，账单保留不可达） |

### 5.6 家庭账单（3 个，已实施 2026-11-01）

| 函数 | 签名 | 作用 |
|---|---|---|
| `insertFamilyBill` | `(familyId, bill, openid)` | 写 family_bills（bills 同构 + familyId；userId = 记录人） |
| `softDeleteFamilyBill` | `(familyId, billId, openid)` | 软删除（where 带 `userId: openid` —— 只有记录人可删） |
| `listFamilyBills` | `(familyId, opts)` | 列家庭账单（`{familyId, delFlag:false}` + 月份范围，全员可见） |

### 5.7 家庭分析（5 个，已实施 2026-11-01）

| 函数 | 签名 | 作用 |
|---|---|---|
| `familyMonthStat` | `(familyId, month)` | 家庭月度总额 + 笔数（与 `monthStat` 同口径，where 换 `{familyId, delFlag:false, 日期范围}`） |
| `familyRecentBillsByMonth` | `(familyId, monthCount = 6, endMonth = null)` | 跨月拉家庭账单（months 骨架 + byMonth） |
| `familyGetLatestBillChangeTime` | `(familyId, month)` | 该月家庭账单 `max(createTime, updateTime)` |
| `saveFamilyInsight` | `(familyId, insight, month, version = 'v2')` | 落库 `users/family_${familyId}_insight`；**顶层无 userId/month**；自持白名单，不复用 saveInsight |
| `getFamilyInsight` | `(familyId, month)` | 拍平读取（payload 提升顶层）；跨月 → `_stale:true`；familyId 不匹配 → null |

### 5.8 重复记账（6 个）

| 函数 | 签名 | 作用 |
|---|---|---|
| `insertRecurringRule` | `(rule)` | 建规则（含集合缺失的建表指引报错） |
| `listRecurringRules` | `(openid)` | 列自己的规则（`delFlag:false`，按 createTime 排序） |
| `updateRecurringRule` | `(openid, ruleId, data)` | 改规则，返回 `stats.updated`（0 = 没找到） |
| `softDeleteRecurringRule` | `(openid, ruleId)` | 软删除规则 |
| `listDueRecurringRules` | `(dateCST)` | 捞到期规则（`status:'active'` + `delFlag:false` + `nextDate <= dateCST`，`fetchAll` 分页） |
| `findBillByRuleAndDate` | `(userId, ruleId, date)` | 查「同规则同一天」已有账单（幂等第二道防线，`limit:1`） |

> ⚠️ **`insertBillAsUser` 的安全边界**：userId 来自调用方传入的**规则文档**，
> 由「扫描 + 写库」两步保证只为用户自己的规则写账单；
> `dailyRecurring` 入口有 `SOURCE === 'wx_trigger'` 硬校验，前端调不到这条路径。

### 5.9 类目与工具（2 个 + 3 个）

| 函数 | 作用 |
|---|---|
| `listCustomCategories(openid)` | 读自定义类目 |
| `insertCustomCategory(cat)` | 建自定义类目 |
| `fetchAll(collection, where, hardCap = 2000)` | 分页拉全量 |
| `QUERY_PAGE_SIZE` | 每页条数 |
| `REQUIRED_COLLECTIONS` | 必需集合（**从代码动态读取**，`db/index.js:1461`） |

## 6. 查询上限与索引

### 6.1 ⚠️ `limit: 100` 硬上限

```js
const limit = Math.min(Number(opts.limit) || 20, 100); // 硬上限 100
```

**一个月超过 100 笔时，查询只覆盖前 100 笔。**

> 影响：任何「搜索」「筛选」「统计」功能都会漏数据。源码实测：明细页一个月 >100 笔时列表不全。

### 6.2 `fetchAll` 的 2000 硬顶

```js
async function fetchAll(collection, where, hardCap = 2000) {
  const all = []; let offset = 0;
  while (all.length < hardCap) {
    const page = await collection.where(where).skip(offset).limit(QUERY_PAGE_SIZE).get();
    const data = page.data || [];
    all.push(...data);
    if (data.length < QUERY_PAGE_SIZE) break;  // 最后一页
    offset += QUERY_PAGE_SIZE;
  }
  return all;
}
```

超过 2000 笔**静默截断**（不报错）。

> `monthStat` 用的是 `fetchAll` → 一个月 >2000 笔时总额会少算，且**无任何提示**。

### 6.3 建议的复合索引

`listBills` 的注释原文：

```
⚠ orderBy + where 组合要求索引里同时包含 where 字段与排序字段，
否则云开发会退化为全表扫描。建议在控制台为 bills 建复合索引：
  userId(升序) + date(升序) + ts(降序)
```

### 6.4 ⚠️ `db.RegExp` 不能用

项目里**零处使用 `db.RegExp`**（只有 `db.command.gte/lte`）。

原因：`tools/test-persist.js` 的 mock `matches()` 只支持 `gte/lte/gt/lt` 与等值，**不支持正则** → 用数据库正则会直接让本地持久化测试失效。

> 而这个测试的存在理由正是「真实落库逻辑从未被本地测试覆盖过」。
> **结论：搜索类需求走应用侧过滤，不要走数据库正则。**

### 6.5 `categoryBreakdown` 是应用侧聚合

```js
// hardCap 2000 笔以内准确
```

**已在代码注释里标明精度边界** —— 超过 2000 笔不准。

## 7. 金额单位约定

### 7.1 存储层：整数分

```js
amount: Math.round(bill.amount),  // 强制取整，杜绝浮点残留
```

**所有涉及金额的计算一律用整数分**，对外才转元。

### 7.2 ⚠️ 同名不同义的字段

| 层 | 字段 | 类型 | 说明 |
|---|---|---|---|
| **存储** | `amount` | number | 整数分 |
| **存储** | `total`（users 集合） | string | **展示值** |
| **存储** | `pie` | array | 占比（展示用） |
| **前端** | `amountCent` | number | 整数分（计算值） |
| **前端** | `amount` | string | `"¥120.50"`（展示值） |
| **前端** | `totalCent` | number | 整数分 |
| **前端** | `dayTotal` | number | 整数分 |
| **前端** | `monthTotal` | string | 展示值，**无 ¥ 符号** |
| **前端** | `dayTotalText` / `totalText` | string | 展示值 |

> ⚠️ **存储层的 `amount` 是分，前端的 `amount` 是字符串** —— 同一个字段名，两种语义。
> 前端从云端拿数据时**必须用 `amountCent`**，用 `amount` 会 `Number("¥120.50")` = NaN。

### 7.3 转换函数

| 函数 | 位置 | 规则 |
|---|---|---|
| `yuanToCent(str)` | `miniprogram/utils/format.js` | 按位解析，非法输入返回 **`null`** |
| `yuanInput(cent)` | 同上 | `(Number(cent) \|\| 0) / 100` → `.toFixed(2)` |
| `formatCent(cents, withSymbol = true)` | 同上 | 分 → `"¥120.50"` |
| `formatMoney(yuan, withSymbol)` | 同上 | 元 → 带符号字符串 |
| `centToYuanStr(cent)` | `shared/agent-harness/bill-stats.js:27` | 分 → 元字符串 |

### 7.4 ⚠️ `yuanToCent` 的精确规则

```js
function yuanToCent(input) {
  const s = String(input === null || input === undefined ? '' : input).trim();
  if (!s) return null;
  const m = /^(\d*)(?:\.(\d*))?$/.exec(s);   // 只接受纯数字 + 最多一个小数点
  if (!m) return null;
  const intPart = m[1] || '', decPart = m[2] || '';
  if (!intPart && !decPart) return null;      // "." 无意义
  const d1 = decPart[0] ? parseInt(decPart[0],10) : 0;
  const d2 = decPart[1] ? parseInt(decPart[1],10) : 0;
  const d3 = decPart[2] ? parseInt(decPart[2],10) : 0;
  const base = (parseInt(intPart || '0', 10) || 0) * 100;
  let cent = base + d1*10 + d2;
  if (d3 >= 5) cent += 1;                    // 第三位小数起四舍五入（0.005 → 1 分）
  if (!Number.isFinite(cent)) return null;
  return cent;
}
```

| 特性 | 说明 |
|---|---|
| **非法输入返回 `null`** | 区别于「真的是 0 元」 |
| **第三位小数四舍五入** | `0.005` → 1 分；`8.115` → 812 分 |
| **全程整数运算** | 不用浮点 —— `parseFloat('8.115')*100 = 811.4999…` → **811**，少一分 |
| **只接受正数** | 正则不含负号 |

### 7.5 ⚠️ `yuanInput` 的静默陷阱

```js
function yuanInput(cent) {
  return ((Number(cent) || 0) / 100).toFixed(2);
}
```

`Number(cent) || 0` → **非数字输入静默变成 0**。

若传了 `undefined`/`null`/`'abc'` → 显示 `0.00`，**无任何报错**。

> 回填金额时必须确保传的是 `amountCent`（整数分）。
> 传 `bill.amount`（`"¥120.50"`）→ `Number(...)` = NaN → `|| 0` → **`0.00`** → 面板显示 0，
> 保存报「请输入有效金额」，**全程零报错**。

### 7.6 往返一致性

```
yuanToCent(yuanInput(12050)) === 12050
```

**必须有测试兜住** —— `tools/__tests__/money-format.test.js` 覆盖。

## 8. 软删除

| 事实 | 出处 |
|---|---|
| 账单删除是 `update({ delFlag: true, updateTime })`，**记录不删** | `softDelete` / `amend` |
| 撤销（5 秒窗口）走 `amend { billId, delFlag: true }` | 同上 |
| `listBills` / `monthStat` / `fetchAll` 都带 `delFlag: false` 过滤 | 实测 |

### 8.1 ⚠️ 哪些查询可能漏掉过滤

| 查询 | 带 `delFlag: false`？ |
|---|---|
| `listBills` | ✅ |
| `monthStat` | ✅ |
| `fetchAll`（由上两者调用） | ✅（where 里带了） |
| `recentBillsByMonth` | ✅（实测带 `delFlag: false`） |
| `getLatestBillChangeTime` | **不查账单内容，只取时间戳** |
| `listCustomCategories` | ✅ |

> **新增查询函数时务必带上 `delFlag: false`** —— 漏了会把已撤销账单算进统计。

### 8.2 查询常量

| 常量 | 值 | 出处 |
|---|---|---|
| `QUERY_PAGE_SIZE` | 100 | `db/index.js:385` |
| `fetchAll` 的 `hardCap` | 2000 | 默认参数 |
| `listBills` 的 `limit` 上限 | 100 | 硬编码 |
| `REQUIRED_COLLECTIONS` | `[BILLS, USERS, CATEGORIES, RECURRING, FAMILIES, FAMILY_BILLS]` | `db/index.js:1461` —— **从代码动态读取** |

> 注意 `REQUIRED_COLLECTIONS` **不含 `TEMPLATES`** —— 印证了它是死集合；
> `RECURRING` / `FAMILIES` / `FAMILY_BILLS` 均已纳入必需（缺集合时报错带建表指引，diag 面板能查出）。
> **`families` / `family_bills` 必须手工创建**（§1.1），否则家庭 action 全部报「集合不存在」。

## 9. 单一数据源原则

> **同一屏上出现的数字，绝不能来自两次独立计算。**

查一次 → 清洗一次 → 所有统计基于同一份快照。

**违反案例**：搜索功能复用 `monthBills` → 页面顶部「本月合计」变成「搜索命中笔数的合计」，环比的分母也变了。

详见 `engineering/23-change-impact.md`。
