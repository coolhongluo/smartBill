# 04 家庭模式（登录 + 自动注册 + 家庭共享账单）

> 覆盖：双空间账本口径 · 邀请码加入 · 成员与权限 · 家庭账单 · 家庭分析 v1 · 存储隔离纪律。
>
> 权威实现：`cloudfunctions/user-svc/index.js`、`cloudfunctions/bill-svc/index.js`（`resolveLedger`）、`cloudfunctions/analysis-svc/index.js`（`resolveScope`）、`cloudfunctions/shared/db/index.js`。
>
> **状态**：登录/自动注册、家庭创建与加入、双空间记账、家庭分析 v1 均**已实施**（版本 `20261101-01`）；家庭定时聚合与家庭规则共享为**规划中**（见 `engineering/22-roadmap.md` §10）。

## 1. 已与产品确认的口径（2026-11-01）

| 口径 | 决策 |
|---|---|
| 共享范围 | 个人 + 家庭**双空间**，每笔账记入其一，家庭账本全员可见可记 |
| 分析口径 | 按**当前账本**聚合（家庭账本 = 全家聚合） |
| 加入机制 | **邀请码**加入（8 位，排除易混字符 0/O/1/I） |
| 登录形式 | **静默自动注册 + 可选资料**（wx.login + 首调建档案；头像昵称用 chooseAvatar/nickname 能力，getUserProfile 已废弃） |
| 成员上限 | 8 人（含创建者，`FAMILY.MAX_MEMBERS` 云端强制，`constants.js:76`） |
| 邀请码有效期 | 72 小时（`INVITE_TTL_MS`，`constants.js:78`），仅 owner 可 regen，旧码立即失效 |
| 退出家庭后账单归属 | 留在家庭（`family_bills` 保留 userId），退出者不可再读 |
| 一人多家庭 | v1 **不能**（profile.familyId 单值），多家庭留 v2 |
| 重复记账规则 | v1 **不共享**（规则仍个人，`dailyRecurring` 只写 bills） |
| owner 退出 | v1 禁止；提供「解散家庭」（families 置 delFlag + 全员 familyId 清空，账单保留不可达） |
| 账本切换记忆 | `wx.setStorageSync('ledger')` 持久化，默认 personal |

## 2. 架构选型（评审裁定）

1. **独立集合 `families` / `family_bills`**，不给 bills 加 ledger 字段 —— 个人空间 20+ 现有查询**零回归**（本地持久化 mock 只支持等值 + 范围查询，混存会弄坏对 bills 的精确计数断言）。
2. **familyId 云端权威**：一律从 profile 文档反查（`getProfile`，`db/index.js:386`），**不信任前端传的 familyId**。
3. **不新建第 6 个云函数**：9 个新 action 全放 user-svc（preflight 硬编码 5 个 svc）。
4. 家庭 insight 复用 `users` 集合，`_id = family_${familyId}_insight` —— 但**顶层不得有 userId/month**（见 §5.1，两条真实踩坑）。

## 3. 数据模型

```
families:     { name, ownerId, inviteCode, inviteExpiresAt, delFlag, createTime, updateTime }
              ⚠️ 不维护 memberCount 字段 —— 成员数是真实文档计数（避免缓存不一致）
family_bills: bills 同构 + familyId；userId = 记录人（只有记录人能编辑/撤销自己的账）
users/${openid}_profile: { userId, nickname, avatarUrl, familyId, createTime, updateTime }
              ⚠️ nickname/avatarUrl 不写 null；familyId='' 表示无家庭
users/family_${familyId}_insight: { familyId, version, payload{month,...}, generateTime, updateTime }
```

出处：`constants.js:54-55`（两个新集合）、`db/index.js:691`（insertFamilyBill）、`db/index.js:428`（saveProfile）、`db/index.js:889`（saveFamilyInsight）。

> 新集合必须在云开发控制台**手工创建**（权限同 bills）。`REQUIRED_COLLECTIONS`（`db/index.js`）追加后，preflight 与 diag 面板动态生效。

## 4. 双空间记账（bill-svc）

4 个 handler（`record` / `recall` / `manual` / `amend`）接受可选 `ledger` 参数，入口统一走 `resolveLedger(payload, context)`（`bill-svc/index.js:1554`）：

| ledger | 行为 |
|---|---|
| 缺省 / `'personal'` | **原路径零新增查询**（铁律：默认路径不查 profile，测试 mock 无 doc() 会崩） |
| `'family'` | 反查 profile.familyId → 校验家庭存在且是成员 → 写 `family_bills`；**profile.familyId 为空 → 直接 throw，不回退个人** |
| 其他值 | throw `未知账本类型` |

- `amend` 按 ledger 切集合：家庭账单的 where 仍带 `userId: openid`（**只有记录人能改/删**，`softDeleteFamilyBill`，`db/index.js:755`）
- 家庭账单列表 `listFamilyBills`（`db/index.js:769`）：`where({ familyId, delFlag:false })` + 月份范围，全员可见
- rule* 与 `dailyRecurring` **完全不动**（定时器无 openid，家庭规则留 v2）

## 5. 家庭分析（analysis-svc，v1 手动刷新）

5 个入口加 `ledger`（`monthSummary` / `monthBills` / `categoryBreakdown`→readInsight / `refreshInsight` / `computeInsight`），统一走 `resolveScope(context, payload)`（`analysis-svc/index.js:710`）；**`dailyInsight` 定时链路不动**（定时家庭聚合留 v2）。

- 家庭数据源：`familyMonthStat`（`db/index.js:794`）/ `familyRecentBillsByMonth`（`:813`）/ `familyGetLatestBillChangeTime`（`:851`）—— 与个人版同口径，只是 `where` 换成 `{ familyId, delFlag:false, 日期范围 }`
- 计算管道与个人**完全同一条**（`computeInsight`，`analysis-svc/index.js:818`）：查一次 → `normalizeBills` 清洗一次 → 占比/环比/趋势/结论全部基于同一份快照
- LLM 会话归属用合成 id `family_${familyId}` —— 家庭结论的对话上下文与任何个人结论互不串扰
- `getFamilyInsight`（`db/index.js:945`）返回**拍平结构**（payload 内容提升到顶层）→ readInsight 的过期判断与组装逻辑**零分支复用**
- 越权：非成员 / 已退出 / 家庭已解散 → resolveScope 直接 throw，不回退个人

### 5.1 ⚠️ 家庭 insight 存储纪律（两条真实踩过的坑）

**顶层不得有 `userId` / `month` 字段**（month 放进 payload），原因各一条：

1. **顶层 month** 会被 `listPendingInsightUsers` 的 `where({month})`（每日扫描）把 `family_*` 文档捞进个人分析批次 —— 家庭文档没有个人 userId，扫描结果被污染。
2. **顶层 userId**（若写成 owner 的）会与 owner 个人 insight 的 `generateTime` 混算 —— 家庭重算时 updateTime 变新 → owner 个人结论**永远不过期、永不重算**。

落库形态只有 `{ familyId, version, payload, generateTime, updateTime }`；`saveFamilyInsight`（`db/index.js:889`）**自持字段白名单，绝不复用 saveInsight**（后者硬编码 userId+month 顶层）。

断言守护：`cloudfunctions/shared/db/__tests__/family-store.test.js`。

## 6. user-svc 的 10 个 action

| action | 用途 | 关键校验 |
|---|---|---|
| `profile` | openid 脱敏 + 资料 + 已记笔数 | — |
| `login` | **幂等自动注册**（首调建档 `isNew=true`，再调不重建档案不重写 createTime） | — |
| `updateProfile` | 昵称/头像（白名单，null 不写，超长截断） | 空 payload 报错 |
| `familyCreate` | 创建家庭（创建者自动加入，ownerId=创建者） | 已加入者不能再创建 |
| `familyJoin` | 邀请码加入（大小写归一） | 码错/过期/满员/已加入 → 各自明确报错 |
| `familyInfo` | 我的家庭（isOwner/成员数/邀请码）；未加入 → `inFamily:false` | 成员才能看到邀请码 |
| `familyMembers` | 成员列表（**不暴露 userId**，isMe/isOwner 由云端标） | 非成员拒绝 |
| `familyLeave` | 退出（familyId 置空串） | owner 禁止退出 |
| `familyRegenCode` | 重新生成邀请码（旧码立即失效） | 仅 owner |
| `familyDissolve` | 解散（families 置 delFlag + 全员清归属） | 仅 owner |

出处：`user-svc/index.js:67-76`（switch 全表）、各 handler `:119-270`。

## 7. 前端

- 新页面 `pages/family/index`（非 tabBar，从「我的」页进入）—— **命名必须含 `index.*`**：`check-frontend.js` 的 `resolvePageFiles` 只认同名文件或 index.*，`manage.*` 命名会被整页跳过 WXML 绑定校验（见 `engineering/20-pitfalls.md` §62）
- 账本切换条：首页 / 明细页 / 分析页各一条，读写同一个 `globalData.ledger`（`wx.setStorageSync('ledger')` 持久化，默认 personal）；家庭 tab 守卫：无 familyId → toast 引导去「我的」创建/加入
- `app.js` onLaunch 静默 `login()`（失败弹 toast「登录异常，家庭账单暂时不可用」+ 每 10s 自动重试，成功自动恢复；重试失败静默不弹框）
- cloud.js 新增 `login` / `updateProfile` / `familyCreate` / `familyJoin` / `familyInfo` / `familyMembers` / `familyLeave` / `familyRegenCode` / `familyDissolve` 封装；`record`/`recall`/`manualRecord`/`amend`/`monthSummary`/`readInsight`/`refreshInsight` 全部透传 `ledger`
- 明细页编辑面板**不加任何字段**（`edit-bill.test.js` + `check-frontend.js` 反向断言）；`groupByDate` 白名单不动 —— family_bills 返回结构与 bills 完全同构

## 8. 四条铁律（违反任一条 = 测试红或静默失效）

| # | 铁律 | 防线 |
|---|---|---|
| 1 | ledger 缺省/`'personal'` 走原路径**零新增查询** | test-persist/e2e mock 无 doc()，默认路径查 profile 直接崩 |
| 2 | 传 `'family'` 但 profile.familyId 为空 → **throw 不回退个人** | `family.test.js` 明确断言「拒绝时不得写任何集合」 |
| 3 | 家庭 insight 顶层**无 userId/month** | `family-store.test.js` 污染断言 |
| 4 | familyId 一律云端反查，**不信任前端** | 每个家庭 action 校验 `profile.familyId`；账单写读带 userId |

## 9. 重复记账与家庭账本（已实施 2026-11-01，版本 `20261101-03`）

重复记账规则支持**账本区分**：创建规则时可选「个人/家庭」，家庭规则到点生成的账单进 `family_bills`，全家可见、进入家庭分析。

### 9.1 口径（已与产品确认）

| 口径 | 说明 |
|---|---|
| **规则私有，账单进家庭** | 规则仍归创建者私有管理（不共享）；只有生成的账单进家庭账本 |
| **退出/解散自动暂停** | `familyLeave`/`familyDissolve` 自动把该成员的全部家庭规则置 `paused`（`pauseFamilyRecurringRules`，`db/index.js:1317`）；列表标「家庭已失效」 |
| **账本归属不可改** | 创建后账本定死；`ruleUpdate` 带 ledger → 明确拒绝「删除后重新创建」（`bill-svc/index.js:1068`） |
| **失效不生成（兜底）** | 定时生成时二次校验家庭存在 + 创建者仍是成员（`bill-svc/index.js:1270`），失效 → 跳过 + 游标前移，绝不写无主家庭账单 |

### 9.2 实现要点

- 规则文档：`ledger`（缺省 `'personal'`，兼容老文档）+ `familyId`（仅家庭规则；`ruleCreate` 复用 `resolveLedger` 云端反查，`bill-svc/index.js:1006`）
- 家庭规则生成写 `insertFamilyBillAsUser(rule.familyId, bill, rule.userId)`（`db/index.js:709`）—— userId = 规则创建者 = 记录人，只有创建者能撤销，与家庭账单纪律一致
- 幂等查重按账本分流：家庭版 `findFamilyBillByRuleAndDate`（`db/index.js:1294`）查 `family_bills`（fetchAll + JS 过滤 ruleId，零新索引需求）
- 恢复暂停的家庭规则前校验成员资格（`handleRulePause`，`bill-svc/index.js:1151`）：已退出家庭 → 拒绝并指路删除重建，防「恢复成功但永远不生成」的静默失效
- 全程不加新的 where 条件/索引；定时器 `dailyRecurring` 链路与 `config.json` 触发器不动

## 10. 测试与守卫

| 测试文件 | 覆盖 |
|---|---|
| `cloudfunctions/shared/db/__tests__/family-store.test.js`（17 用例） | profile 白名单/null 不写/幂等 + 家庭 insight 存储隔离与拍平读取 |
| `tools/__tests__/family.test.js`（39 用例） | 创建/邀请码/成员/退出/解散 + 双空间记账 + 家庭分析 v1 全链路 + 越权 + 家庭规则退出/解散自动暂停 |
| `tools/__tests__/recurring-rule.test.js`（28 用例） | 规则 CRUD 校验 + 家庭账本创建校验/账本不可改/生成分流/幂等/失效跳过/老规则兼容 |

守卫收尾：`npm test` → `npm run preflight` → `npm run check:ui` → `npm run prepare:cf` → 部署 user-svc / bill-svc / analysis-svc（「云端安装依赖」）。

## 11. 规划中（v2）

- 家庭定时聚合（`dailyInsight` 扩展）—— 现家庭 insight 文档被「顶层无 month」纪律天然挡在每日个人扫描之外，v2 接入时同样不能破坏这条隔离
- 家庭**共享**重复记账规则（全员可见可管理）—— 规则记家庭账本已实施（§9）；共享规则库需规则挂家庭的新数据模型，仍留 v2
- 一人多家庭（profile.familyId 数组 + 成员集合重构）
