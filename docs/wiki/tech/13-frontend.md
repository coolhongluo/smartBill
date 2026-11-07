# 13 前端实现

> 覆盖：7 个页面职责与 data 字段 · 5 个 utils 模块契约 · 2 个自定义组件 · 金额字段流向 · 前端防错清单。
>
> 权威实现：`miniprogram/`（页面 JS/WXML/WXSS/JSON 共约 6340 行，含 2026-11-01 新增的 `pages/family/` 与账本切换条）。

## 1. 全局配置

`app.json`（约 45 行）：

| 项 | 值 |
|---|---|
| 页面 | `index` / `detail` / `analysis` / `profile` / `category/manage` / `recurring/manage` / `family/index`（7 个） |
| **tabBar** | **只有 4 项**：记账 / 明细 / 分析 / 我的 |
| tabBar 样式 | 纯文字（**无 `iconPath`**），`color: #A8A29E`，`selectedColor: #7C6F64` |
| 窗口 | `navigationBarBackgroundColor: #FAF8F5`，标题「随口记」 |
| 权限 | 只声明 `scope.record` |
| 其他 | `style: "v2"`、`lazyCodeLoading: "requiredComponents"`、`sitemapLocation` |

> ⚠️ **`pages/category/manage`、`pages/recurring/manage`、`pages/family/index` 都不在 tabBar 里** —— 都是从「我的」页 `wx.navigateTo` 进入的二级页（`profile.js` 的 `onGoCategoryManage` / `onGoRecurringManage` / `onGoFamily`）。
> ⚠️ **新二级页必须用 `index.*` 或与目录同名的文件名** —— `tools/check-frontend.js` 的 `resolvePageFiles` 只认同名或 index.* 文件，`manage.*` 命名会被**整页跳过** WXML 绑定校验（见 `engineering/20-pitfalls.md` §62）。

`sitemap.json` 全放行：`{ "rules": [{ "action": "allow", "page": "*" }] }`。

### 1.1 `app.js`（95 行）

```js
globalData: {
  cloudEnvId: '',      // 云环境 ID，留空用默认环境
  openid: null,
  monthSummary: null,  // 本月概览，首页展示
  detailMonth: null,   // 明细页待查看月份（YYYY-MM），tab 页无法 URL 带参，经此中转
  ledger: 'personal'   // 当前账本：personal|family。wx.getStorageSync('ledger') 恢复，默认 personal
}
```

| 生命周期 | 行为 |
|---|---|
| `onLaunch` | `initCloud()` 失败 → 弹 modal「云开发未就绪」→ **直接 return**（不继续预取） |
| `onLaunch` | 静默 `cloud.login()` 自动注册（**失败弹 toast「登录异常，家庭账单暂时不可用」+ 每 10s 自动重试，重试失败静默，成功自动恢复**；`miniprogram/app.js:55-100`） |
| `onLaunch` | `preloadMonthSummary()` 调 `analysis-svc/monthSummary`，失败**静默**（仅 `console.warn`） |
| `onError` | `console.error('[app] uncaught', err)` |

> ⚠️ `globalData.detailMonth` 是**一次性中转变量** —— 分析页 → 明细页传月，消费后立即置 `null`。
> 加新参数时要确保这两条路径不互相干扰。
>
> ⚠️ **账本切换记忆**：`ledger` 由首页/明细页/分析页三处账本切换条共同读写
> （`globalData.ledger` + `wx.setStorageSync('ledger')` 双写），默认 personal。
> 切「家庭」tab 有守卫：无 `profile.familyId` → toast 引导去「我的」创建/加入。

## 2. 七个页面

### 2.1 index 记账页（tabBar 第 1 项）

**文件**：`index.js`（691 行）、`index.wxml`（255 行）、`index.wxss`（480 行）

**职责**：语音记账主入口 + 手动兜底 + 本月概览 + 5 秒撤销。

**data 字段**：

```js
// 录音状态机
recordState,      // idle|recording|recognizing|done|failed
partialText,      // 实时上屏文本
finalText,        // 识别完成的文本
result,           // 结果区对象 kind: saved|confirm|guide
errorMsg, canManual, fallbackTip,
// 本月概览
monthTotal,       // ⚠ 展示值，来自云端 res.data.total（字符串，无 ¥ 符号）
monthCount,
// 手动输入
manualPanel, manualMode, manualText, mpFocus,
manualAmount, manualCategoryIndex, manualCategoryLabel, manualNote, manualDate,
// 类目选择器
catPickerVisible,
// 撤销
undoBill, undoCountdown
```

**云调用**：`cloud.record(text, confidence)` / `cloud.parseText(text)` / `cloud.manualRecord(...)` / `cloud.amend({billId, delFlag:true})` / `analysis-svc.monthSummary`

**账本切换条（已实施 2026-11-01）**：页顶 `ledger-switch`（家庭 / 个人两个 tab，家庭在前；
默认账本仍 personal）；`onShow` 先 `syncLedger()` 从 globalData 同步切换条（与明细/分析页同款，
2026-11-01 修复「分析页切账本后记账页切换条不跟」）；`onSwitchLedger` 写 `globalData.ledger` + storage 后重载概览，
切换期间概览区回「切换中…」加载态（`summaryLoading`，`loadMonthSummary` 带 seq 竞态守卫）；
`record`/`manualRecord`/`amend`/`recall` 全部透传当前 `ledger`。

**防错点**：
- 松手瞬间置 `RECOGNIZING`，**不等结果** → 保证 300ms 内有反馈
- 落库失败检查 `res.saved === false`（**不能只看有没有抛异常**）→ 显示错误条 + 仍列出候选供改类目重试
- `onManualDirectSubmit` 与 `onConfirmCategory` 都写死 `account: 'unknown'`

### 2.2 detail 明细页（tabBar 第 2 项）

**文件**：`detail.js`（约 370 行）

**职责**：按月看流水、编辑账单、软删除。

**data 字段**：

```js
month, total, deltaText, deltaColor,
groups,            // groupByDate 的结果（每项含 isAuto = source==='auto'，WXML 标「自动」badge）
loading, empty, emptyText, emptySub,
atCurrentMonth, currentDate,
// 编辑面板
editOpen, editSaving, editBill,
editAmount,        // ⚠ 展示值（字符串），回填用 yuanInput(bill.amountCent)
editCategoryId, editCategoryLabel, editDate, editNote,
catPickerVisible, datePickerVisible
```

**云调用**：`analysis-svc/monthBills`（`detail.js:81`）/ `cloud.amend(payload)`（`:303`）/ `cloud.amend({billId, delFlag:true})`（`:350`）

**⚠️ 三个关键点**：

| # | 坑 | 说明 |
|---|---|---|
| 1 | **回填用 `yuanInput(bill.amountCent)`** | 用 `bill.amount` → `Number("¥120.50")` = NaN → 面板显示 0，保存报「请输入有效金额」，**全程零报错** |
| 2 | **`groupByDate` 是字段白名单** | 只把部分原始字段带进 `items`。**新增可编辑字段必须在这里加一行**，否则编辑面板回填不到原值 |
| 3 | **只提交真正改动过的字段** | 与原值比较后才带上。全量提交会导致「用户自定义类目 id 不在预置库里 → 云端反查不到 path → 可能拒绝这次编辑」 |

**保存后必须重新加载列表**，不要就地改一行 —— 只改一行则当日合计、月合计、环比都没变。

**改了日期可能跨月** → 必须跳到新月份并明确提示。

**账本切换条（已实施 2026-11-01）**：与首页同款（tab 顺序家庭在前；切换账本先回
`loading` 加载态）；`loadBills` 与 `saveEdit`/`onDeleteEdit`
的 `amend` 透传当前 `ledger`。**编辑面板不加任何字段** —— `edit-bill.test.js` 与
`check-frontend.js` 有反向断言（面板多出支付方式类字段直接全红）；
`groupByDate` 白名单不动（family_bills 返回结构与 bills 完全同构）。

### 2.3 analysis 分析页（tabBar 第 3 项）

**文件**：`analysis.js`（约 210 行）

**data 字段**（分组）：

```js
// 加载
loading, refreshing, errorMsg,
// 数据
pie, trend, insights, savings, month, total, billCount,
deltaText, deltaDirection,
// 状态四态
hasResult, isStale, isOutdated, outdatedText,
// 降级
isFallback, fallbackNote, fallbackHint, fallbackLevel,
savingsEmptyText, savingsEmptyHint, savingsRetry,
// 诊断
diagRunning, diagResult
```

**云调用**：`cloud.readInsight()`（`:73`）/ `cloud.refreshInsight()`（`:136`）/ `cloud.analysisDiag()`（`:196`）

**账本切换条（已实施 2026-11-01）**：页顶 `ledger-switch`（与首页/明细页同款，tab 顺序
家庭在前；切换账本先回 `loading` 加载态；读同一份 `globalData.ledger`）；`loadInsight` 带
**seq 竞态守卫**（`this._seq` 自增，旧响应直接丢弃）；
`readInsight(ledger)` / `refreshInsight(ledger)` 透传；**trend 循环块结构一字不动**
（`trend-view.test.js` / `trend-detail-jump.test.js` 依赖其锚点与 `onTrendTap`）。

**⚠️ 四种状态必须区分**：

| 状态 | 呈现 |
|---|---|
| `!hasResult` | 空态「📊 还没有分析结果」+「每天凌晨会自动生成，也可以现在手动分析一次」+ 按钮「立即分析」「去记一笔」 |
| `isStale` | 工具栏「本月尚未生成」 |
| `isOutdated` | 独立告警条「账目有改动，下面是改动前的结论，点「重新分析」更新」 |
| `isFallback` | 显示 `fallbackNote` + `fallbackHint` |

**「可以这样省」为空的三态**（`buildSavingsEmpty`）：

| 情况 | 判据 | 文案 | 重试 |
|---|---|---|---|
| ① AI 没跑成 | `meta.savingsSource === 'unavailable'` | 「AI 分析暂不可用」+「省钱建议由大模型生成，本次未能完成」 | ✅ |
| ② AI 跑过但没空间 | insights 含「可优化空间有限/以刚性支出为主/都是刚性/数据还太少」 | 「暂时没有可优化空间」+ 复用后端说法 | ❌ |
| ③ 有数据但信息少 | `meta.billCount > 0` | 「暂时没有可优化空间」+「多记几笔、备注写清楚消费用途，建议会更具体」 | ❌ |

**空卡片同样有害** —— 用户会以为「我没有可优化的地方」。

**趋势视图模型在前端补**（`utils/trend.js` 的 `buildTrendView`）—— 原因见 §4.3。

### 2.4 profile 我的页（tabBar 第 4 项）

**文件**：`profile.js`

**data**：`openid, billCount, loading, diagResult, diagRunning`（2026-11-01 新增 `nickname, avatarUrl, familyId, inFamily, familyEntryText`）

**云调用**：`user-svc/profile`（`:29`）/ `cloud.diag()`（`:57`）/ `cloud.updateProfile(...)`

**职责**：显示 openid 与已记笔数 + **头像昵称**（`chooseAvatar` + nickname input，`getUserProfile` 已废弃）+ **家庭入口卡片**（未加入 → 去创建/加入；已加入 → 进家庭页）+ **诊断面板**（排查用）+ 入口到类目管理与重复记账。

> ⚠️ **修复过的坑**：页面读 openid 必须用云端返回的 `openidMasked`（user-svc 只返回脱敏值，
> 不返回裸 openid）—— 曾读 `r.data.openid` 导致永远 undefined。

### 2.5 category/manage 类目管理页（非 tabBar）

**文件**：`pages/category/manage.js`（注意路径是 `category/manage`，不是 `manage/manage`）

**云调用**：`cloud.categoryTree()`（`:37`）/ `cloud.createCategory(...)`

**职责**：查看类目树、创建自定义类目、删除自定义类目。

### 2.6 recurring/manage 重复记账页（非 tabBar，已实施）

**文件**：`pages/recurring/manage.{js,wxml,wxss,json}`（4 件套，`app.json` 已注册）

**data 字段**：

```js
rules,             // 已装饰的规则列表 —— 展示字段全部预计算（decorateRule）
                   //   amountText（formatCent）、repeatText、paused、nextText（friendlyDate）、
                   //   ledgerText（'个人'/'家庭'）、familyInvalid（退出后标「家庭已失效」，20261101-03）
loading,
typeOptions,       // 6 种重复方式的 picker 文案（与云端 REPEAT_TYPES 下标一致）
weekOptions, dayOptions, monthOptions,
ledgerOptions,     // ['个人账单','家庭账单']（与 LEDGER_VALUES 下标一致）
// 新建/编辑面板
formOpen, formSaving, formEdit,
formAmount,        // ⚠ 展示值（元字符串），回填用 yuanInput(rule.amount)（原始整数分）
formCategoryId, formCategoryLabel,
formType, formTypeIndex, formDayOfWeek, formDayOfMonth, formMonth,
formNote, typeHint,    // typeHint 随重复方式变化（WXML 不能调函数，预计算）
catPickerVisible,
// 账本选择（20261101-03）：仅新建可选；编辑面板只展示不可改（口径：账本不可改，删除重建）
formLedgerIndex, formLedger,
hasFamily         // 已加入家庭才可建家庭规则（展示开关，权威校验在云端）
```

**云调用**：`cloud.ruleList()` / `cloud.ruleCreate(...)` / `cloud.ruleUpdate(...)` / `cloud.rulePause(ruleId, paused)` / `cloud.ruleDelete(ruleId)`（新建 payload 带 `ledger`；编辑不传）

**设计要点**（沿用明细页编辑面板的纪律）：
- 回填金额用 `yuanInput(rule.amount)` —— 规则文档的 `amount` 是**原始整数分**，
  不是展示字符串（与 bills 的 `amountCent` 同语义，别被字段名骗了）
- 编辑只提交**真正改动过的**字段（金额/类目成对/备注/repeat 逐项比较），
  与 `saveEdit` 同一纪律
- repeat 只携带当前类型用得到的参数（与云端 `normalizeRepeatParams` 同口径）
- 类目选择复用 `cat-picker` 组件（`manage.json` 注册）
- 金额转换复用 `format.js` 的 `yuanToCent` / `yuanInput`
- 暂停/恢复/删除都先 `wx.showModal` 确认；删除 confirmColor `#A32D2D`（软删除，历史账单保留）
- **不进 `app.onLaunch` 预取** —— 预取失败是静默的，规则列表进页面再拉
- 账本选择（20261101-03）：`hasFamily` 来自 `app.globalData.profile.familyId`（登录自动注册后可用）；未加入家庭选「家庭账单」→ toast 指路「我的」页；家庭归属权威在云端（ruleCreate 的 resolveLedger 反查）
- ⚠ `manage.*` 被 check-frontend 整页跳过 WXML 校验（`20-pitfalls.md` §62），WXML 绑定需人工自查

### 2.7 family/index 家庭模式页（非 tabBar，已实施 2026-11-01）

**文件**：`pages/family/index.{js,wxml,wxss,json}`（4 件套，`app.json` 已注册；
**命名必须含 `index.*`** —— `manage.*` 会被 `check-frontend.js` 整页跳过，见 `engineering/20-pitfalls.md` §62）

**职责**：创建家庭 / 我的家庭（家庭名、邀请码展示 + 复制 + 重新生成）/ 成员列表（退出与解散入口）/ 输邀请码加入。

**data 字段**：

```js
inFamily,          // 是否已加入家庭（familyInfo 返回）
family,            // { name, isOwner, memberCount, inviteCode, inviteExpiresAt }
members,           // 云端标好 isMe/isOwner 的成员列表（不含 userId）
loading, submitting,
createMode, createName,      // 创建面板
joinMode, joinCode           // 加入面板（8 位邀请码，大小写归一）
```

**云调用**：`cloud.familyInfo()` / `cloud.familyCreate(name)` / `cloud.familyJoin(code)` /
`cloud.familyMembers()` / `cloud.familyLeave()` / `cloud.familyRegenCode()` / `cloud.familyDissolve()`

**交互纪律**：
- 邀请码展示给**所有成员**（可复制），但「重新生成」仅 owner 可见（云端也仅 owner 可调）
- 退出 / 解散先 `wx.showModal` 确认；解散 confirmColor `#A32D2D`（不可逆：账单保留但不可达）
- 所有失败 toast 后端 errorMessage（码错/过期/满员各自明确文案），**不静默**

## 3. 五个 utils 模块

### 3.1 `cloud.js` —— 云调用封装

```js
module.exports = {
  initCloud, callFunction, record, recall, amend,
  manualRecord, categoryTree, categorySearch, createCategory, parseText, monthSummary, diag,
  login, updateProfile,
  familyCreate, familyJoin, familyInfo, familyMembers, familyLeave, familyRegenCode, familyDissolve,
  readInsight, refreshInsight, analysisDiag,
  ruleCreate, ruleList, ruleUpdate, rulePause, ruleDelete,
  EXPECTED_CODE_VERSION
};
```

| 封装 | 目标 | action |
|---|---|---|
| `record` | bill-svc | `record`（**透传 ledger**） |
| `recall` | bill-svc | `recall`（**透传 ledger**） |
| `manualRecord` | bill-svc | `manual`（**透传 ledger**） |
| `amend` | bill-svc | `amend`（**透传 ledger**） |
| `parseText` | bill-svc | `record`（文字模式复用同一 AI 链路） |
| `monthSummary` | analysis-svc | `monthSummary`（**透传 ledger**；首页/明细页预取用） |
| `diag` | bill-svc | `diag`（timeout 15s） |
| `categoryTree` | category-svc | `tree` |
| `categorySearch` | category-svc | `search` |
| `createCategory` | category-svc | `create` |
| `login` | user-svc | `login`（**幂等自动注册**，app.onLaunch 静默调用，timeout 10s） |
| `updateProfile` | user-svc | `updateProfile`（昵称/头像） |
| `familyCreate` / `familyJoin` / `familyInfo` / `familyMembers` / `familyLeave` / `familyRegenCode` / `familyDissolve` | user-svc | 同名 action（家庭 7 件套） |
| `readInsight` | analysis-svc | `categoryBreakdown`（**透传 ledger**） |
| `refreshInsight` | analysis-svc | `refreshInsight`（**透传 ledger**；timeout 40s） |
| `analysisDiag` | analysis-svc | `diag`（timeout 40s） |
| `ruleCreate` | bill-svc | `ruleCreate` |
| `ruleList` | bill-svc | `ruleList` |
| `ruleUpdate` | bill-svc | `ruleUpdate` |
| `rulePause` | bill-svc | `rulePause`（`{ruleId, paused}`） |
| `ruleDelete` | bill-svc | `ruleDelete`（`{ruleId}`） |

> 规则五件套只管「配置」—— 账单由云端 `dailyRecurring` 定时生成，
> 前端**没有**（也不该有）触发生成的接口（`TRIGGER_ONLY`）。
>
> **ledger 透传纪律**：ledger 缺省时**不写进 payload**（云端走个人原路径零新增查询）——
> 个人路径绝不因为「默认值也传」而多查一次 profile。

#### ⚠️ 超时兜底必须用 Promise.race

```js
const callPromise = wx.cloud.callFunction({ name, data: payload });
```

`wx.cloud.callFunction` 的超时**不可配置** → 已用 `Promise.race` 自己实现。

**必须区分「客户端主动放弃」与「服务端 -504003」** —— 两者的处理方式完全不同（前者不该弹「云端出错」）。

**计时器必须在 `finally` 里清理**，否则超时后定时器仍在跑。

#### ⚠️ 版本对账 `warnCodeVersion`（已实施 2026-11-03：只警告不阻断）

原名 `assertCodeVersion`，2026-11-03 起**不再 throw** —— 差异只打
`console.warn`，业务调用照常返回。原因：云端部署新版本会让已发布线上版
（冻结的旧 `EXPECTED_CODE_VERSION`）在「部署 → 发布」窗口期内整段不可用。

`action === 'diag'` 仍跳过对账（诊断输出本身已含版本号）。

见 `tech/10-architecture.md` §7.2 —— 版本号比较必须拆成 `{date, seq}` 数字比。

### 3.2 `voice.js` —— 录音与 ASR

```js
module.exports = { VoiceInput, ASR_CHANNEL, STATE, RECORDER_OPTIONS, explainAsrError };
```

| 常量 | 值 |
|---|---|
| `ASR_CHANNEL.CLOUD` | `'cloud'` —— 腾讯云流式 ASR（主力） |
| `ASR_CHANNEL.MANUAL` | `'manual'` —— 手动输入（兜底） |
| `STATE.IDLE` | `'idle'` |
| `STATE.RECORDING` | `'recording'` |
| `STATE.RECOGNIZING` | `'recognizing'` |
| `STATE.DONE` | `'done'` |
| `STATE.FAILED` | `'failed'` |

**录音参数固定不可调**（`RECORDER_OPTIONS`）：

| 参数 | 值 | 理由 |
|---|---|---|
| 格式 | AAC | iOS 必须 |
| 采样率 | 16000Hz | 8kHz 会导致「四十/事实」混淆；48kHz 无增益 |

`explainAsrError` 把 ASR 错误码翻译成用户能懂的话。

### 3.3 `format.js` —— 金额与日期

```js
module.exports = {
  formatMoney, formatCent, today, currentMonth, shiftMonth, friendlyDate,
  trendColor, yuanInput, yuanToCent
};
```

| 函数 | 规则 |
|---|---|
| `yuanToCent(str)` | 按位解析；非法输入返回 **`null`**；第三位小数四舍五入 |
| `yuanInput(cent)` | `(Number(cent) \|\| 0) / 100` → `.toFixed(2)` |
| `formatCent(cents, withSymbol = true)` | 分 → `"¥120.50"` |
| `formatMoney(yuan, withSymbol)` | 元 → 带符号字符串 |
| `today` / `currentMonth` / `shiftMonth` | 日期与月份运算 |
| `friendlyDate(date)` | 友好日期文案 |
| `trendColor` | 涨跌配色 |

⚠️ **`yuanInput` 的静默陷阱**：`Number(cent) || 0` → 非数字输入静默变 `0.00`，**无任何报错**。

详见 `tech/12-data-model.md` §7.4 / §7.5。

### 3.4 `trend.js` —— 趋势视图模型

```js
module.exports = { buildTrendView, MIN_VISIBLE_PERCENT };
```

```js
function buildTrendView(rawTrend) {
  const list = Array.isArray(rawTrend) ? rawTrend : [];
  if (!list.length) return [];
  const cents = list.map(toCent);              // 高度只依据整数分
  const maxCent = Math.max.apply(null, cents.concat([0]));
  const labels = buildLabels(list.map((t) => t.month));
  return list.map((t, i) => ({
    month: t.month || '',
    label: labels[i],
    totalYuan: t.totalYuan || '0.00',
    count: t.count || 0,
    height: barHeight(cents[i], maxCent)
  }));
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `month` | string | `YYYY-MM` |
| `label` | string | 展示用短标签 |
| `totalYuan` | string | 展示值 |
| `count` | number | 笔数 |
| `height` | number | **柱高百分比（数字）** |

**三个关键约定**：

| # | 约定 | 原因 |
|---|---|---|
| 1 | 高度**只依据整数分**计算 | 不用 `totalYuan` 字符串 —— 避免浮点误差 |
| 2 | 零消费月份高度必须是**数字 0** | 不是 `"0.00"`、不是 `"0%"` —— 非法 CSS 会被浏览器丢弃，柱子只剩 `min-height:4rpx` |
| 3 | 有消费但金额极小 → 最小可见高度 `MIN_VISIBLE_PERCENT = 2` | 真实存在但看不见是另一种错误 |

### 3.5 `cat-tree.js` —— 类目树纯函数

```js
module.exports = { l2OptionsOf };
```

**只有 1 个导出** —— 候选计算放纯函数，方便单测。

⚠️ **虚拟分组必须过滤**：`custom_{topId}`（`customGroup = true`）是**展示容器**不是类目 → 云端 `resolveNode` 找不到 → 必须拒绝。

> 把树的 children 当候选列表时**必须过滤 `customGroup`**。

## 4. 两个自定义组件

### 4.1 `cat-picker` 类目选择器

| prop | 类型 | 默认 | 说明 |
|---|---|---|---|
| `visible` | Boolean | `false` | 面板是否显示 |
| `initialId` | String | `''` | 初始高亮的类目 id（编辑时定位当前层级） |

**事件**：

| 事件 | 携带 data |
|---|---|
| `select` | `{ id, path, name }` |
| `cancel` | — |

`initialId` 是**正当接口**（对外暴露初始状态），其余状态不外露。

### 4.2 `cat-create` 新建类目

| prop | 类型 | 默认 | 说明 |
|---|---|---|---|
| `visible` | Boolean | `false` | 面板是否显示 |
| `tree` | Array | `[]` | 类目树（父类 chips 数据源，结构与 `category-svc tree` 一致） |
| `initName` | String | `''` | 初始名（搜索无结果场景带入关键词） |
| `initLevel` | Number | `1` | 初始层级 |
| `initParent1` | String | `''` | 一级父类 |
| `initParent2` | String | `''` | 二级父类 |

**事件**：

| 事件 | 携带 data |
|---|---|
| `created` | `{ category: cat }` 或 `{ category: e.raw.presetCategory }` |
| `cancel` | — |

### 4.3 ⚠️ 组件化的理由

「类目选择器」三级联动约 150 行 JS + 120 行 WXML + 170 行 WXSS。
记账页与明细页编辑面板都要用 → **复制一份就是第二个真相源**。

**原则**：组件对外只暴露**事件**，不让父组件反查内部状态。

## 5. 金额字段在前端的流向

### 5.1 字段名对照

| 语义 | 字段 | 类型 | 转换 |
|---|---|---|---|
| **计算值** | `amountCent` | number（分） | — |
| **计算值** | `totalCent` | number（分） | — |
| **计算值** | `dayTotal` | number（分） | — |
| **展示值** | `amount` | string `"¥120.50"` | `formatCent()` |
| **展示值** | `total` / `dayTotalText` | string | `formatCent()` |
| **展示值** | `monthTotal` | string（**无 ¥ 符号**） | 来自云端 `res.data.total` |
| **输入框** | `editAmount` / `manualAmount` | string | `yuanInput()` 回填，`yuanToCent()` 提交 |

### 5.2 ⚠️ 同名不同义 —— 最大的传错来源

| 场景 | 正确 | 错误 | 错误后果 |
|---|---|---|---|
| 编辑页回填 | `yuanInput(bill.amountCent)` | `bill.amount` | `Number("¥120.50")` = NaN → 显示 0 → 保存报「请输入有效金额」，**全程零报错** |
| 云端返回 | `amountCent` | `amount` | 同上 |
| 提交 | `yuanToCent(str)` | `parseFloat(str)*100` | `parseFloat('8.115')*100 = 811.4999…` → **811**，少一分 |

**记忆点**：**展示值与计算值不要共名字段。**

### 5.3 趋势高度为什么在前端算

| 原因 | 说明 |
|---|---|
| 1 | 分析结果已落库在 `users` 集合（存旧结构），前端补则**立刻对存量数据生效**，不需重算/部署 |
| 2 | 柱高是展示层的事 |
| 3 | `get_trend` 工具输出直接进模型视野，塞 `height`/`label` 会污染模型读数 |

## 6. 前端防错清单

### 6.1 已有防护

| # | 防护 | 位置 |
|---|---|---|
| 1 | 松手立即置 `RECOGNIZING`，不等结果 | index.js |
| 2 | 落库失败检查 `res.saved === false` | index.js |
| 3 | 金额回填用 `amountCent` | detail.js |
| 4 | 只提交真正改动过的字段 | detail.js |
| 5 | 保存后重新加载列表 | detail.js |
| 6 | 跨月跳转到新月份 + 明确提示 | detail.js |
| 7 | 超时用 `Promise.race` + `finally` 清理计时器 | utils/cloud.js |
| 8 | 版本对账只警告不阻断（2026-11-03 起），`diag` 跳过 | utils/cloud.js |
| 9 | `Array.isArray` 判定失败 → 直接 throw（不 `\|\| []`） | utils/trend.js 等 |
| 10 | `customGroup` 过滤 | utils/cat-tree.js |
| 11 | 规则列表展示字段全部预计算（`decorateRule`），WXML 不重复拼接 | recurring/manage.js |
| 12 | 编辑规则只提交真正改动过的字段 | recurring/manage.js |

### 6.2 ⚠️ 三个残留陷阱

| # | 陷阱 | 后果 |
|---|---|---|
| 1 | `index.js:84` 与 `:100` 有 `this.searchTimer` 清理代码，但**首页没有搜索功能** | 早期设计残留。若在首页实现搜索会与这段冲突 |
| 2 | `index.js` 的 `onManualDirectSubmit` / `onConfirmCategory` **写死 `account: 'unknown'`** | 所有手填账单支付方式都是 unknown |
| 3 | `pages/index/index.json` 注册了 `cat-create`，但 `index.wxml` **并未使用** | 无害但是冗余 |

### 6.3 ⚠️ WXML 数据绑定断裂检查

`tools/check-frontend.js` 会校验 WXML 里绑定的字段在**整个数据链路**（页面 JS + 小程序全部 JS + 云函数全部 JS）上都能找到。

> **新增字段只在 WXML 出现 → 直接报错。**
> 症状：`height: undefined%` → 非法 CSS 被丢弃 → 柱子只剩 `min-height:4rpx`（肉眼几乎看不见）。

**这个守卫必须真解析 WXML 并断言「值不是 undefined」** —— 只查 key 会漏。

## 7. 前端验证命令

```bash
npm run check:ui    # JS 语法真解析 + WXML 数据绑定守卫 + 备注链路
npm test            # 含 edit-bill / money-format / trend-detail-jump 等前端相关测试
```

**布局 bug 必须用真实浏览器量**（Playwright 复刻 WXML+WXSS，读 `getBoundingClientRect`）——
纯读 CSS 看不出塌陷。Playwright bundled chromium 常缺，用 `chromium.launch({channel:'chrome'})`。

> **守卫的正则要断言「值 > 0」** —— `min-height: 0` 恰是原始 bug。

详见 `engineering/21-debugging.md`。
