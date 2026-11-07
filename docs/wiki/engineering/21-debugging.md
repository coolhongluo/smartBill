# 21 调试与可观测性

> 覆盖：preflight / check:ui / trace 链路 · 云端诊断面板 · 排查路径表 · 守卫的注入式验证。
>
> 权威实现：`tools/preflight.js`、`tools/check-frontend.js`、
> `tools/trace-view.js`、`cloudfunctions/analysis-svc/index.js`（`diag` action）。
> 单独的操作手册见 `docs/how-to-trace-agent.md`。

## 0. 三条链路，先搞清走哪条

| 想知道什么 | 用哪条 | 代价 |
|---|---|---|
| **我的改动有没有引入问题** | `npm test` + `npm run preflight` | 秒级，**每次改完都跑** |
| **云端跑的是不是最新代码、LLM 通不通** | 分析页「诊断」按钮 | 一次模型调用（约 1~2 元以内） |
| **模型为什么这么说、工具返回了什么** | `DEBUG_TRACE` + `trace-view.js` | 有隐私风险，**排查完必须关** |

> ⚠️ **最常见的误判**：改了代码发现行为没变 → 以为是缓存。
> 读算分离下 `categoryBreakdown` **只读已存结果**，不重算 —— 必须重新触发一次分析。

---

## 1. preflight：本地守卫

```bash
npm run preflight
```

11 段检查，覆盖：工程配置、shared 副本漂移、版本戳、SDK 守卫、运行时能力、
**JS 语法真解析**、备注链路、本地测试、Wiki 一致性、提问分流规则、云侧状态清单。

### 1.1 它守什么

| 段 | 守什么 | 典型失败 |
|---|---|---|
| 2 | shared 副本**内容级**漂移（逐文件 sha1） | 改了 shared 忘跑 `prepare:cf` |
| 3~4 | `CODE_VERSION` ↔ `EXPECTED_CODE_VERSION` | 云端旧版本 |
| 5 | `wx-server-sdk` 可加载 | 忘装依赖 / 没选「云端安装依赖」 |
| 6 | 运行时能力（全局 `fetch` 等） | 本地有云端没有 |
| 7 | **所有**小程序端 JS 的 `node --check` 真解析 | 语法错误（文本匹配查不出） |
| 8 | WXML 数据绑定（真解析 WXML，断言值不是 undefined） | 柱子只剩 `min-height: 4rpx` |
| 9 | 端到端本地模拟 | 记账主链路断了 |
| 10 | `llms.txt` 链接目标都存在 | LLM 按索引读拿到 404 |
| 10b | 提问分流规则三件套 | 规则被删/注册丢失/JSON 坏掉 |

### 1.2 ⚠️ 它自己曾经是坏的

`bad()` 只 `console.log`，`hardFail++` 是**手写的** → 漏一处就白检。
曾报 7 条 `✗` 却 `exit 0`。

**已修**（`tools/preflight.js`）。现在缺页会正确 `exit 1`。

> **教训**：「所有检查都通过」不等于「检查是对的」。
> **守卫本身也要用「注入 bug」的方式验证**，不能只看它跑绿。

### 1.3 怎么验证守卫真的有效

```bash
# ① 删掉规则文件 → 应报错并 exit 1
mv AGENTS.md /tmp/ && npm run preflight; echo "exit=$?"; mv /tmp/AGENTS.md .

# ② 清空 hook 注册 → 应报错
echo '{"hooks":{"UserPromptSubmit":[{"hooks":[]}]}}' > .codebuddy/settings.json
npm run preflight; echo "exit=$?"

# ③ 制造语法错误 → 应被真解析抓到
echo 'const x = ;' > miniprogram/utils/cloud.js
npm run preflight; echo "exit=$?"
```

**每次改守卫后都跑一遍这三条。** 只看它跑绿等于没验证。

---

## 2. check:ui：前端静态检查

```bash
npm run check:ui
```

和 preflight 的区别：**只管前端**（WXML 绑定 / WXSS 布局 / JS 语法），跑得快，可单独用。

### 2.1 三个曾经漏掉的盲区

| 盲区 | 现状 |
|---|---|
| 只检查 index 页 | 按目录里的**实际文件名**解析全部页面 |
| 只做文本匹配 | 用 `node --check` **真解析**所有小程序端 JS |
| 只查循环体内的绑定 | 覆盖循环体内 + **循环体之外**两层 |

> ⚠️ 列表名可能是**带点的路径**（如 `list.data.items`）；
> 提取字段前必须**剔除字符串字面量**，否则会误判。

### 2.2 WXML 绑定断言必须断言「值」

只查「key 存在」会漏 —— key 在但值是 `undefined` 一样炸。

```js
// 错：只查 key
assert.ok('height' in item)
// 对：断言值不是 undefined，且 > 0
assert.ok(typeof item.height === 'number' && item.height > 0)
```

> ⚠️ `min-height: 0` **恰是原始 bug 的形态** —— 正则要断言「值 > 0」。

### 2.3 布局 bug 必须用真实浏览器量

纯读 CSS **看不出塌陷**。用 Playwright 复刻 WXML + WXSS，读 `getBoundingClientRect`：

```bash
# Playwright bundled chromium 常缺，用系统 Chrome
chromium.launch({ channel: 'chrome' })
```

---

## 3. 云端诊断面板（7 项检查）

分析页点「诊断」按钮 → 调 `analysis-svc` 的 `diag` action（`index.js:126`）。
**这是唯一能确认「云端到底跑的是哪版代码」的手段。**

| # | 检查项 | 看什么 |
|---|---|---|
| ① | **SDK 就绪** | `ensureSdk()` 是否返回 null（`shared/db/sdk.js`） |
| ② | **用户身份** | 能否拿到 openid（未登录 / 无云开发权限） |
| ③ | **数据库可读** | `bills` / `users` 集合是否可访问 |
| ④ | **LLM 开关** | `LLM_ENABLED` 是否被设成 false |
| ⑤ | **API Key** | `DEEPSEEK_API_KEY` 是否设置（只看长度，不显示内容） |
| ⑥ | **已存结果** | 本月有没有结果、生成时间、**当时是规则版还是模型版** |
| ⑦ | **模型实测** | **真的发一次最小请求** —— 同时验证 Key + 网络 + 模型服务 |
| ⑧ | **云端代码版本** | `CODE_VERSION` —— 刚改完没部署的话这里会是旧版本号 |

> ⚠️ 第 ⑦ 项**最有价值**：它一次性排除了「Key 没配」「网络不通」「模型服务异常」三种可能。
> 前几项只是「看配置」，第 ⑦ 项是「**实测**」。
>
> ⚠️ 前端版本对账 2026-11-03 起**只警告不阻断**（`warnCodeVersion`），
> `diag` 仍跳过对账 —— 诊断要能穿透，否则云端旧代码会挡住
> 「用诊断确认云端版本」这条路（死锁）。

---

## 4. trace：看模型到底做了什么

完整操作手册见 **`docs/how-to-trace-agent.md`**。这里只列骨架。

### 4.1 开启（**在控制台，不在代码里**）

```
云开发控制台 → 云函数 → analysis-svc →「配置」→ 环境变量 → 添加
   键名：DEBUG_TRACE    值：true
```

⚠️ **只加在 `analysis-svc`**（`bill-svc` 不产生分析结论，加了只是浪费额度）。
⚠️ **必须重新部署** —— 环境变量是实例启动时注入 `process.env` 的，热实例读不到。

### 4.2 看

```bash
node tools/trace-view.js trace.log            # 渲染报告
node tools/trace-view.js trace.log --last     # 只看最近一次调用链
node tools/trace-view.js trace.log --raw      # 连未分类事件也显示
```

本地不用真 Key 也能跑：`node tools/trace-demo.js`（假 Key + 替换 `fetch`，
验证**链路与埋点是否正常**，不是模型效果）。

### 4.3 报告各段对应什么

| 段落 | 看什么 | 排查什么问题 |
|---|---|---|
| `llm_request` | 模型收到的消息结构 | Prompt 是不是按预期组装 |
| `llm_response` | 模型输出 / 请求调用的工具 | 模型是不是该调工具却没调 |
| `tool_call` | 工具名、入参、出参摘要、耗时 | 工具返回的数据对不对 |
| `numeric_mismatch` | 未被工具背书的数字 | 数值护栏拦下了什么 |
| `rigid_category_violation` | 违规的刚性类目 | 刚性保护拦下了什么 |
| `saving_amount_recomputed` | 修正了几处金额 | 模型填的金额和代码算的差多少 |
| `savings_filtered` | 丢弃了几条建议 | 哪些建议被判为不可信 |
| `SUMMARY` | 总耗时、token、降级原因 | 整体有没有降级、贵不贵 |

### 4.4 ⚠️ 排查完必须关掉

`DEBUG_TRACE=true` 会让**账单金额进日志**。排查完删掉环境变量并重新部署。

---

## 5. 排查路径表

| 症状 | 先看 | 再看 |
|---|---|---|
| 分析页一直显示规则版分析 | `categoryBreakdown` 只读不计算 → **重新触发一次分析** | 诊断面板第 ④⑤⑦ 项 |
| 分析页显示旧结论 | 是不是存的上个月的结果（`isStale`） | `isOutdated`（同月内账单被改过） |
| 建议整块消失 | `meta.savingsSource`：`'unavailable'`（AI 没跑成）vs `'llm'`（跑了但没空间） | 诊断面板第 ⑥ 项看当时是否 fallback |
| 结论为空但数据齐全 | `NO_TOOL_GROUNDING` —— 模型没调工具，结论被依赖校验剔掉 | trace 看 `llm_response` 有没有 tool_call |
| 定时任务没产出 | 查 `deferred` / `nextCursor`；cron 是否 7 段；`config.json` 有无注释 | **event 结构**（`Type==='Timer'` → 映射 `dailyInsight`）；**月份时区**（云端 UTC+0 vs cron UTC+8）；触发器是否「上传触发器」；**先看入口日志** `[xxx-svc] 入口收到调用:`（2026-11-03 加）—— `keys=[Type,...] Type="Timer"` 是定时器事件，`keys=(无键)` 是平台保活空调用（3ms 返回「未知操作: undefined」，别当定时器） |
| 定时任务跑的是上个月 | 云函数运行时 UTC+0、cron 是 UTC+8 → 月初差 8 小时 | 已用 `toMonthStrCST()` 固定 +8 偏移；**仍要确认 `TZ` 环境变量配了**（影响日志时间等其他地方） |
| 定时触发器完全不执行 | 「上传触发器」是**独立一步**，只部署代码不生效 | 右键 `config.json` →「云函数增量上传:更新文件」→ 再「上传触发器」 |
| 测试有红字但显示「全部通过」 | `test()` 漏了 `await` → 断言失败变成未捕获的 Promise 拒绝 | `test()` 必须 `async` + `await fn()`；用 `process.exitCode` 而非 `process.exit()` |
| 云端报 `Cannot find module` | shared 副本是否同步（跑 `prepare:cf`） | 部署是否选了「云端安装依赖」 |
| 改了代码行为没变 | 云端代码版本（诊断面板第 ⑧ 项） | 前端版本戳对账（只警告不阻断，2026-11-03 起，看真机日志 `[cloud]` warn） |
| 金额差一分 | 用的是哪个 `yuanToCent`（**有两个同名函数**） | 见 `20-pitfalls.md` §9 §10 |
| 柱子 / 元素不显示 | WXML 绑定的值是不是 undefined | `npm run check:ui` |
| 布局塌陷 | 滚动区有没有 `min-height` 下限 | 用 Playwright 量，别只读 CSS |
| 接口报 -504003 | 云函数 timeout（**只对 `$LATEST` 生效**） | 前端 `Promise.race` 超时是否误报 |
| 前端一直转圈 | `opts.timeout` 此前从未生效 → 已改 `Promise.race` | 计时器是否在 `finally` 清理 |

---

## 6. 降级语义：分清「故障」与「保护」

排查时最容易被误导的就是这个。用户看到「出错了」，可能其实是**护栏正常工作**。

`shared/util/fallback-reason.js` 把降级码翻译成可执行提示，按 level 分三档：

| level | 含义 | 用户该做什么 |
|---|---|---|
| `config` | 配置问题 | **用户能直接解决**（如去控制台配 Key） |
| `retry` | 临时故障 | 重试即可 |
| `guard` | **护栏正常工作，不是故障** | 不用管，这是设计如此 |

> ⚠️ 把 `guard` 当成故障报给用户 → 用户会做无用操作。
> 排查降级问题**先看 level 是哪一档**。

---

## 7. 四个结果状态必须区分

分析页的四种状态**含义完全不同**，混起来会给出错误信息：

| 状态 | 判据 | 含义 |
|---|---|---|
| `hasResult: false` | 从没分析过 | 本月还没结果，需要触发一次 |
| `hasResult: true` + `savings: []` | 分析了但没空间 | 正常结果，不是故障 |
| `isStale: true` | 存的是上个月的 | 结论不是本月的 |
| `isOutdated: true` | 同月内账单被改过 | 结论基于改动前的数据 |

> ⚠️ **把上个月结论当本月展示是错误信息，比显示「旧数据」严重得多。**

---

## 8. 过期判据：定时任务与页面必须一致

```
max(createTime, updateTime)  >  generateTime   →  结果过期
```

⚠️ **必须取 `max`** —— 编辑账单只更新 `updateTime`，`createTime` 不变。
只看 `createTime` → 用户把 100 改成 500 后结论不重算 → 占比、节省建议全错。

**定时任务（`listPendingInsightUsers`）与页面判据必须是同一个。**
不一致 → 结论该过期时不过期，或反过来无意义地重算（烧额度）。

---

## 9. 静默失败清单（零报错但结果错）

这几类**都不会报错**，只能靠比对发现：

| 故障 | 表现 |
|---|---|
| WXML 绑定断裂 | 柱子只剩 `min-height: 4rpx` |
| 布局塌陷 | 滚动区被压到 0 高度 |
| `\|\| []` 兜底 | 建议被无声清空 |
| `saveInsight` 字段白名单 | 当次有值、刷新后消失 |
| `bad()` 不计数 | preflight 报 ✗ 却 exit 0 |
| 共享副本漂移 | 部署的是旧代码 |
| 备注关键词丢失 | 刚性判定失效 → 建议荒谬 |

详见 `20-pitfalls.md`。

---

## 10. 改完代码的标准动作

```bash
npm run prepare:cf    # 改了 shared 才需要
npm test              # 全量测试
npm run preflight     # 本地守卫（含规则资产）
npm run check:ui      # 前端（preflight 已含时可省）
```

云函数改动还要走**四步**（见 `23-change-impact.md` §7.1）——
其中第 4 步「上传并部署：云端安装依赖」**只能人工**。

> ⚠️ 改完代码**必须重新触发一次分析**才能看到效果（读算分离）。
