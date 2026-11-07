# 项目长期约定 —— voice-bill

> 背景与踩坑细节见 `.workbuddy/memory/YYYY-MM-DD.md`。本文件只留**可执行规则、阈值、路径**。

## 云函数铁律

**1. 禁止全局 `cloud`**。走 `shared/db/sdk.js` 的 `ensureSdk()`，不可用返回 null。preflight 有守卫。

**2. 改云函数代码必走四步**
| # | 动作 | 自动化 |
|---|------|--------|
| 1 | `shared/util/constants.js` 的 `CODE_VERSION` +1 | ✅ preflight |
| 2 | 同步 `miniprogram/utils/cloud.js` 的 `EXPECTED_CODE_VERSION` | ✅ preflight |
| 3 | `npm run prepare:cf`（同步 shared 到各云函数） | ✅ 有脚本 |
| 4 | 开发者工具右键云函数 →「上传并部署：云端安装依赖」 | ❌ **只能人工** |

**2.1 第 3 步漏跑 = 版本不一致，报错方向是错的。**
shared 是**多副本**。只改源没跑 `prepare:cf` → 副本停在旧版本 → 看着像「忘了部署」，实际是「忘了同步」。
preflight 已做**内容级守卫**（逐文件 sha1）。**存在性检查对漂移失灵**——旧副本文件也都在。

**3. 必须选「云端安装依赖」**，否则 `wx-server-sdk` 不进包，diag 报「SDK 初始化」失败。

**3.1 timeout 要匹配各自的耗时结构**
| 云函数 | 结构 | 最低 |
|--------|------|------|
| bill-svc | 单次 LLM（2.2s） | ≥10s |
| analysis-svc | 3~4 轮工具往返 + 数据库 + 冷启动 | ≥11s（建议 30~40） |

analysis-svc 阈值（**写错过，别照抄简版**）：
```
perRoundSec = ceil(max(800, ANALYSIS_LLM_TIMEOUT_MS / ANALYSIS_MAX_TOOL_ROUNDS) / 1000)
needSec     = perRoundSec + 3（数据处理）+ 5（冷启动）
```
`chatWithTools` 把预算**分摊到每轮**（单轮 ~2.7s 而非 8s）；**冷启动不计入 LLM 预算**却实 eats 总时长。

**3.2 timeout 可能不生效**（真机：写 25s 实际按 3s 执行）。官方注明**云函数配置只对 $LATEST 生效**。

**4. shared 必须放在「函数目录内的普通子目录」**（本项目最贵的教训）
`上传并部署：云端安装依赖` **不会上传本地 node_modules**。复制到 `node_modules/shared`
或 `__dirname/../shared`（仓库根）云端必然失败——本地 require 通、测试全绿，云端却报
`Cannot find module`。唯一可靠：`prepare:cf` 复制到 `cloudfunctions/<svc>/shared/`。
**本地全绿 ≠ 云端能跑。**

**5. shared 是多份副本，共享状态必须挂 globalThis**。本地 mock 注入必须写 `globalThis`。

**6. 云端没有全局 fetch，必须用 https 模块**（最隐蔽的坑，2026-10-24 实测）
`Nodejs18.15` + **CommonJS** → 全局 `fetch` 不存在 → `ReferenceError`。
Node 18 的 fetch 只在 ESM 上下文注入 globalThis，本项目全用 `require` 拿不到。
本地 Node 22 有 → **本地全绿、云端必然失败**。
**铁律**：云端发 HTTP 一律用 `shared/util/http-client.js` 的 `postJson()`；禁止写 `fetch(...)`。
**测试必须 mock 同一个东西**：注入 `httpClient.__setImpl()`（且要注入**云函数实际加载的副本**
`cloudfunctions/<svc>/shared/util/http-client.js`，不是源文件）。验证：`delete global.fetch;` 后仍能正常发请求。

**7. 删代码要查残留引用**：删掉 `AbortController` 时 `finally { clearTimeout(timer) }`
引用已删变量 → **每次请求都抛 ReferenceError**。`node --check` 查不出。
**删变量必须搜一遍所有引用**（含 finally/catch）。

## 版本戳
云端 `shared/util/constants.js` 的 `CODE_VERSION`；前端 `miniprogram/utils/cloud.js` 的
`EXPECTED_CODE_VERSION`。`bill-svc` **每个**响应都带 `codeVersion`。
前端在业务错误判断**之前**对账。`action==='diag'` 放行。当前：`20261031-01`

## 数值计算铁律

**所有涉及金额、比例、涨跌的计算，一律由代码完成，模型只负责表述。**
理由：模型加总不可靠；账单塞进 Prompt 会超 token；工具的数字能追到哪段代码算的，自由文本不能。

```
bills → normalizeBills → bill-stats.js（唯一算数字处）→ 结构化统计
      → insight agent（看不到账单，只看统计）→ 组织语言 → 数值对账（不过则退回兜底）
```
`bill-stats.js` 纯计算不碰 LLM；`tools/index.js` 工具声明+执行体；`insight.agent.js` 只写 Prompt。

约束：**单位**内部一律整数分，对外才转元（签名标注单位）；
**方向判断也是代码的事**（±1% 一律 `flat`）；**模型拿不到原始账单**；
**工具参数尽量少**（日期由代码锁定）；**工具报错必须回传模型**；
**必须有 maxRounds**；**每轮独立超时** `timeoutMs / maxRounds`。

**兜底不是可选项**：LLM 超时 / 校验失败 / 数值对账不过 / 无 API Key，
四条路径全部退回**纯代码模板结论**。

**估算类结论必须有最小样本量门槛**（`MIN_SAVING_BILLS = 3`）。
笔数不足则**不给建议**，改说明「数据还不够」；空卡片同样有害。
**通用教训**：任何「按比例估算」「预测未来」先问「样本量支撑得住吗」。

## 备注总结（2026-10-31 新增）
语音记账的备注 = **LLM 总结**；LLM 失败 → **用户原话全文**。逻辑在
`shared/util/note-summary.js` 的 `buildNote({asrText, llmNote})`，三条路径：
① 总结可用且没丢关键词 → 用总结（≤30 字）② 总结丢了关键词 → 原话全文（≤200 字）
③ 无摘要 → 原话全文。**兜底用原文而非规则提炼**：模型没帮上忙时信息完整优先于简洁。

**关键词不能丢**（刚性/必需/社交）：模型把「孩子学费3200」总结成「教育支出」→
刚性判定失效 → 分析页建议「学费省 30%」。这是本项目最贵的事故类型。
关键词表集中在 `shared/util/note-keywords.js`（**单一数据源**，被 compressibility /
essential-spend / note-summary 三处共用）。检测到丢词就**退回原文**，不拼接
（拼接出来像机器拼的故障）。

⚠️ 兜底路径备注里**带金额**（如「买菜100」）——这是需求明确要求的取舍，
明细页金额是独立字段不参与计算，不会算错。

## 刚性支出：建议的禁区
`util/category-compressibility.js` 三档：`rigid`（房租/学费/药品/物业/保费/宽带/奶粉，
**禁止出现在任何建议里**）/ `semi`（日用品/衣物/部分会员，可提但克制）/
`flexible`（娱乐/零食/外食，真正空间）。实测：学费 2000→省600 / 房租 3500→省1050，
数学全对但结论全错——这些省不动。

三个要点：① **单独成文件**，不写进 category-preset；② **备注关键词兜底**；
③ **刚性不占建议名额**。**顺序必须是：先剔刚性 → 再判笔数 → 最后截断。**

**必需性消费：备注存在 ≠ 该省**（`util/essential-spend.js`）。判定按**末级类目**。
社交支出（聚餐/请客/随礼/红包）也算必需，**省它伤的是关系不是钱**。

**样本量门槛要分场景**：「按比例估算省多少」需样本；
「这一笔值不值得提」**不需要**——备注本身就是判断依据。
⚠️ **`MIN_SAVING_BILLS` 在 v3 已删除**（grep 零命中）——旧文档写的门槛已不存在。
现存 `MIN_OCCURRENCES = 3`（`bill-stats.js:285`）是**周期检测**用的，不是节省门槛。
v3 的建议是否给出**完全由模型判断**，规则层不拦；但刚性白名单与结论依据校验仍在。

**建议卡片不能空**：无建议时说明原因，区分「数据还不够」vs「本月以刚性支出为主」。

## 三道防线（模型路径）
模型**不做数学，但获得「判断」的权力**：
1. **刚性白名单硬拦截** — 数值对账查不出「根本不该提这个类目」
2. **金额白名单对账** — 正文出现工具没返回过的「N 元」即失败
3. **金额兜底重算** — 模型填的 amount **一律作废**，由代码按类目重算覆盖

第 3 条最关键：**让模型只负责选类目和写话术，金额一律代码填**。

**结论的依据：工具依赖校验（不是数值对账）**
由 `CONCLUSION_REQUIRES` 映射表 + `collectToolUsage` 判定：结论涉及的维度里
没有工具被调用过 → 那条结论剔除。**任一维度有支撑即成立**（要求全部支撑会误杀）；
**粒度是「单条结论」**不是整条作废。⚠️ 曾用「逐个数字查白名单」，误伤率极高，已废弃。

**工具入参：报错而非静默夹住**。`clampInt` 曾让越界参数被悄悄夹住——模型会基于
**错误理解的数据**下结论。现由 `validateArgs` + `TOOL_ARG_SCHEMAS` 拦下并**回传错误**。

**降级原因必须可见，且区分「故障」与「保护」**
`util/fallback-reason.js` 把降级码翻译成可执行提示，按 level 分三档：
`config`（用户能直接解决）/ `retry`（临时故障）/ `guard`（**护栏正常工作，不是故障**）。

## 分析结果：读算分离（不在用户路径上跑 LLM）
**分析要 10 秒，绝不能让用户等。**
定时触发器（每天 0 点）→ analysis-svc / dailyInsight → 批量算 → users 集合
分析页 → categoryBreakdown → 只读已存结果 → 0ms
分析页「立即分析」→ refreshInsight → 单独算这一个用户

**定时触发器三个约束**：① **运行时没有用户上下文**（`OPENID` 为空），
必须自己从数据库捞用户（`listPendingInsightUsers`）；② **cron 是 7 段**，
`0 0 0 * * * *` = 每天 0 点（UTC+8）；③ **`config.json` 不能有注释**。
按**实际耗时**判预算，超预算标 `deferred` 并返回 `nextCursor`；单用户失败必须隔离。
**只算「账单有新增或结果过期」的用户**。

**⚠️ 定时触发器 event 没有 `action` 字段**（2026-10-31 修复，`20261031-02`）：
官方下发 `{Type:'Timer', TriggerName, Time, Message}`，
入口必须做**分发归一**（`normalizeEvent()`：`Type==='Timer'` → `action='dailyInsight'`），
否则落 `default` → **定时分析每天都静默不执行**。
`TriggerName` 对不上要拒绝；**`payload` 不透传**（防外部注入 month/cursor）。

**⚠️ 月份必须按东八区算**（`dateUtil.toMonthStrCST()`，固定 +8 偏移）：
云函数运行时 UTC+0 vs cron UTC+8 → **每月 1 号会分析上个月**。
**没改 `toMonthStr`**（被 5 个云函数共用，改口径波及一片）。
用 **`event.Time`（触发时刻）而非 `new Date()`**。
⚠️ **本地时区就是 Asia/Shanghai → 恰好掩盖这个 bug** → 必须 `npm run test:tz-utc` 测。

**⚠️ 部署是两步**：「云函数增量上传:更新文件」**再**「上传触发器」——
两个不同概念，只部署代码触发器不生效（preflight 清单里曾写错成「随部署生效」）。

**targetOpenid 必须校验来源（防越权）**：只在 `SOURCE === 'wx_trigger'` 时接受。

**四个状态必须区分**：`hasResult:false`（从没分析过）/ `hasResult:true` + `savings:[]`
（分析了但没空间）/ `isStale:true`（存的是上月）/ `isOutdated:true`（同月内账单被改过）。
**把上个月结论当本月展示是错误信息，比显示「旧数据」严重得多。**

**落库位置与安全**：`users` 集合，固定 `_id = ${openid}_insight`；
用固定 `_id + set()` 而非 query-then-write；读取时校验 `doc.userId === openid`；
`REQUIRED_COLLECTIONS` 必须**从代码动态读取**。

**前端超时兜底**（`opts.timeout` 此前从未生效）：`wx.cloud.callFunction` 超时**不可配置**，
已用 `Promise.race` 实现。必须区分「客户端主动放弃」与「服务端 -504003」。
计时器必须在 `finally` 里清理。

## 编辑账目（amend）：字段成对 + 校验 + 只传改动

**可编辑**：金额、类目、日期、备注。（**不含支付方式** —— 用户明确不需要。）
**不可编辑**：userId、source、isRecall、confidence、aiMeta、createTime。

**1. `categoryId` 与 `categoryPath` 必须成对写入**
统计侧**完全靠 categoryPath 分组**：`top=split('/')[0]`、`leaf=split('/').pop()`、
`second=split('/')[1]`。只改 id 不改 path → 界面显示旧类目、统计按旧类目算。
**且不信任前端传的 path**：预置类目一律按 id 反查（`preset.pathOf(id)`）。

**2. 校验必须与 `handleManual` 同口径**：金额正数/整数分/不超上限、日期格式、
**拒绝未来日期**、账户枚举、备注长度（≤200）。
⚠️ **校验必须写在「本地环境跳过落库」的早退之前**——否则本地测试全走早退分支，
校验一次都没执行过，测试全绿但校验没生效。

**3. 前端只提交真正改动过的字段**（与原值比较后才带上）。

**4. 编辑只改 `updateTime` → 分析结论的过期判定必须含它**
判据统一为 `max(createTime, updateTime)`，**定时任务与页面的判据必须一致**。

**5. 保存后重新加载列表，不要就地改一行**——只改一行则当日合计、月合计、环比都没变。

**6. 改了日期可能跨月**：这笔账会移出当前月，必须跳到新月份并明确提示。

## 金额：单位必须写在名字里（2026-10-30 实测）
**同一份数据存两个字段、名字又长得像 → 早晚会传错。**
`groupByDate` 里 `amount`（展示用字符串 "¥120.50"）与 `amountCent`（原始分 12050）。
回填传了 `bill.amount` → `Number("¥120.50")` = **NaN** → 面板金额显示 0，点保存报
「请输入有效金额」，全程零报错。修法：`yuanInput(bill.amountCent)`。
**教训**：展示值与计算值不要共名字段。

**金额一律用字符串解析，不用浮点**：`parseFloat('8.115')*100 = 811.4999…` → **811**（少一分）。
`format.js` 的 `yuanToCent(str)` 按位解析，全程整数运算；非法输入返回 **`null`**
（区别于「真的是 0 元」），第三位小数四舍五入。往返一致性必须有测试兜住。

## 单一数据源原则
**同一屏上出现的数字，绝不能来自两次独立计算。** 查一次 → 清洗一次 → 所有统计基于同一份快照。

## 静默失败：五类「零报错」故障与对应防线
| 故障 | 表现 | 防线 |
|------|------|------|
| **WXML 契约断裂** | 绑了数据源没有的字段 → `height:undefined%` 非法 CSS 被丢弃 → 柱子只剩 `min-height:4rpx` | `utils/trend.js` 视图模型 + 契约测试**真解析 WXML**并断言**值不是 undefined**（只查 key 会漏） |
| **布局塌陷** | `max-height` 单独存在 + 滚动区 `flex:1; min-height:0` → 可被压到 **0 高度** | ① 滚动区必须有 min-height 硬下限 ② flex 分配高度时父容器要有确定 `height` ③ 同级兄弟区也要限高 |
| **静默降级** | `Array.isArray` 判定失败 → 建议被无声清空成 `[]` | 不要 `\|\| []`，直接 `throw` 让错误暴露 |
| **虚拟分组** | `custom_{topId}`（customGroup=true）是展示容器不是类目 → 云端 `resolveNode` 找不到 → 拒绝 | 把树的 children 当候选列表时**必须过滤 `customGroup`**；候选计算放纯函数（`utils/cat-tree.js`） |
| **TDZ** | `const` 在声明前引用 → ReferenceError，`npm test` 中途崩溃 | require 必须在使用点上方；改完测试要确认 `npm test` **能跑完整条链** |

**布局 bug 必须用真实浏览器量**（Playwright 复刻 WXML+WXSS，读 `getBoundingClientRect`），
纯读 CSS 看不出塌陷。Playwright bundled chromium 常缺，用 `chromium.launch({channel:'chrome'})`。
**守卫的正则要断言「值 > 0」**——`min-height: 0` 恰是原始 bug。

## 静态检查必须覆盖全部页面 + 真解析
**三个盲区（2026-10-24 修复）**
① **只检查 index 页** → 现在按目录里的实际文件名解析（analysis/detail/profile 三个页面
的 WXML 事件绑定、require 导出**从没被校验过**）。
② **只做文本匹配** → preflight 已用 `node --check` 真解析所有小程序端 JS。
③ **只查循环体内的绑定** → 现在覆盖循环体内 + **循环体之外**两层。列表名可能是**带点的路径**；
提取字段前必须**剔除字符串字面量**。

**通用教训**：「所有检查都通过」不等于「代码是对的」。
**守卫本身也要用「注入 bug」的方式验证**，不能只看它跑绿。

## 契约测试的正则必须对齐实际代码形态
- 花括号块 `if (...) { payload.x = ... }` 写成 `if (...) payload.x` → 永远匹配不上
- 赋值 `payload.categoryId =` 写成对象字面量 `categoryId:` → 误报
- 同一函数里有多处相同文案，`indexOf` 首次匹配会**定位到错的那一处**
- WXML 绑定可能是三元 `{{a === b ? 'x' : ''}}`，只匹配 `{{字段}}` 会漏掉

## 组件化：交互不依附于业务场景
「类目选择器」三级联动约 150 行 JS + 120 行 WXML + 170 行 WXSS。
记账页与明细页编辑面板都要用 → 复制一份就是**第二个真相源**。
已组件化：`components/cat-create`、`components/cat-picker`。
**组件对外只暴露事件，不让父组件反查内部状态**（`initial-id` 例外：正当接口）。

## Agent 执行链路可观测性
流程见 `docs/how-to-trace-agent.md`（加 `DEBUG_TRACE=true` → **必须重新部署**才生效 →
触发分析 → 复制日志 → `node tools/trace-view.js trace.log`）。
⚠️ 排查完删掉 `DEBUG_TRACE`（会让账单金额进日志）。
tracer 三条：① 按 traceId 聚合调用链；② 详细模式默认关闭（账单金额是隐私）；
③ 埋点不能成为故障源。**输出不要重复**：结构化事件只进内存链，结束时统一 dump 一次。

## LLM Wiki（docs/wiki/）
面向 LLM 与新成员的项目知识库。索引 `docs/wiki/llms.txt`（llms.txt 规范），
源码在 `docs/wiki/{00,business,tech,engineering}/`，构建产物 `docs/wiki/_site/`（gitignore）。
**当前 12 页实 / 0 页空**（2026-10-31 补齐 `20-pitfalls` `21-debugging` `22-roadmap`）。
`llms.txt` 索引的 12 个页面**全部存在**，preflight 第 10 段校验通过。

**写作约定（新增页面沿用）**
1. **每条结论标 `文件:行号`** —— 不写无出处的断言
2. **必须区分「已实施」与「规划中」** —— agent v3（已上线）≠ PRD v3（未实施）
3. **代码与文档不一致时如实标注**，别顺着旧文档写
4. 表格优先于散文；页首 blockquote 说明「覆盖什么 + 权威实现在哪」
5. mermaid **本地打包不走 CDN**（离线可看）
6. **行号只作佐证，不作导航** —— 代码一变就失效，动手前 grep 复核

**Wiki 的能力边界（两轮对照实验实测，勿推翻）**
- **能答判断题**：改哪里、怎么改、踩什么坑、要不要找产品
- **不能答口径题**：什么算订阅、续费日从哪来 —— 那是产品决策，写进 Wiki 就是臆造
- 量化：Wiki 4 页时只读 Wiki 能独立落地 1.5/5 场景；补到 10 页后 3/5（源码组 3/5）
- **失败模式会迁移**：补页前失败于「找不到坐标」→ 补页后失败于「找不到口径定义」
  → **补页要补判断，不是补坐标**

**构建**：`npm run wiki:build` → `npm run wiki:verify`（Playwright 真浏览器断言
mermaid 真的渲染成 SVG、表格有行、侧栏高亮、无横向溢出；页面列表**从 llms.txt 自动推导**，
硬编码会漏检新页）。preflight 第 10 段查 llms.txt 链接目标是否都存在。

**build.js 坑**：① 资源路径按页面深度算（`base='../'.repeat(深度)`），写死 `assets/`
子目录页全 404；② 侧栏高亮比完整相对路径，`'_site/'` 是 6 字符（`slice(i+5)` 残留斜杠）。

**提问分流规则（2026-10-31 落地，三层）**
| 层 | 文件 | 作用 |
|---|---|---|
| 静态规则 | `AGENTS.md` | 题型分流表 + 渐进下钻路径，新成员/其他 agent 看得见 |
| **强制层** | `.codebuddy/hooks/wiki-first.js` | `UserPromptSubmit` hook，每次提问自动注入分流规则 |
| 守卫 | `tools/preflight.js` 第 10b 段 | 规则文件被删/注册丢失/JSON 坏掉 → `hardFail` |

**规则内容不是「一律先读 Wiki」，是按题型分流**（依据 §7 双盲实验）：
判断题 → 先读 wiki（`llms.txt`→只挑 1~2 页）→ grep 复核坐标；
坐标题 → 直接 grep（读 wiki 是负收益）；口径题 → 不问 wiki，找产品。
**渐进下钻**：llms.txt → 00-overview → 相关的 1~2 页 → grep → 源码。**不全量读 12 页。**

**WorkBuddy 桌面版 hook 配置路径（实测，非文档推断）**
- 项目级 `.codebuddy/settings.json`（`projectDirName` 默认值 `.codebuddy`）
- 用户级 `~/.workbuddy/settings.json` / `~/.codebuddy/settings.json`（两个都读）
- 事件名 `UserPromptSubmit` 真实存在；注入内容以 `<system-reminder data-role="hook">` 进上下文
- hook 脚本读 **stdin JSON**（`prompt` / `cwd`），stdout 只能输出协议 JSON，调试走 stderr
- **hook 必须在项目根有 `docs/wiki/llms.txt` 才注入**（脚本按 `cwd` 判定，换项目静默放行）
- 退出码 0=注入成功；**绝不用 `continue:false`**（那是拦用户）

⚠️ `AGENTS.md` 会被记忆加载器自动当项目级记忆读（运行时 `L="AGENTS.md"`）。

## 常用命令
```bash
npm run prepare:cf    # 同步 shared 到各云函数（改 shared 后必跑）
npm run preflight     # 预检：版本戳、SDK 守卫、运行时能力、语法真解析、备注链路、Wiki 一致性
npm run check:ui      # 前端检查（JS 语法真解析 + WXML 数据绑定守卫 + 备注链路）
npm test              # 全量测试（规则/统计/节省/趋势/编辑/金额/e2e/持久化）
npm run trace <file>  # 查看 agent 执行链路报告
npm run wiki:build    # 构建 LLM Wiki 静态站点 → docs/wiki/_site
npm run wiki:verify   # 浏览器验证 Wiki 渲染（mermaid/表格/导航）
```
