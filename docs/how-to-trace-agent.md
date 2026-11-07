# 如何查看 Agent 执行链路

排查「模型为什么这么说」「工具到底返回了什么」时用这份指引。

---

## 一、开启详细日志（一次配置）

**位置：微信云开发控制台，不是在代码里。**

```
云开发控制台
  → 云函数
    → 点击 analysis-svc
      → 顶部「配置」标签页
        → 找到「环境变量」区域
          → 点「添加」，填两列：
             键名：DEBUG_TRACE
             值：  true
          → 点「确定」
```

⚠️ **只加在 `analysis-svc`**。`bill-svc` 不需要——它跑的是记账链路，
不产生分析结论，加了也只是浪费额度。

### 加完之后

1. **重新部署** `analysis-svc`（右键 →「上传并部署：云端安装依赖」）

   > 环境变量是**实例启动时**注入 `process.env` 的。
   > 热实例还在跑的话，改了变量它也读不到。
   > 重新部署会重启实例，确保新变量生效。

2. 触发一次分析（分析页点「立即分析」，或等晚上 0 点定时任务）

3. 去 `云函数 → analysis-svc → 日志`，找带 `[TRACE:` 开头的行

---

## 二、查看日志

**在云开发控制台里直接看**也行——日志已经按调用链分段了：

```
[TRACE:3c90a0ae] llm_request {...}
[TRACE:3c90a0ae] llm_response {...}
[TRACE:3c90a0ae] tool_call {...}
...
===== TRACE 3c90a0ae =====
  [+   0ms] llm_request {...}
  [+  12ms] tool_call {...}
===== END TRACE 3c90a0ae =====
```

**但更好用的方式**是复制出来用工具渲染成报告：

```bash
# 1. 从控制台复制日志段落，存成 trace.log

# 2. 渲染成可读报告
node tools/trace-view.js trace.log

# 只看最近一次调用链
node tools/trace-view.js trace.log --last

# 连未分类事件也全部显示
node tools/trace-view.js trace.log --raw
```

报告长这样：

```
结果      : 模型路径
Agent     : insight v2
Token     : 1500 (输入 1200 / 输出 300)

【第 1 轮】模型请求
  模型      : deepseek-chat (temperature=0.5, max_tokens=1400)
  工具数量  : 11
  消息      :
    · system (3065 字符) 「你是家庭记账App「随口记」的消费分析师…」
    · user (23 字符) 「请分析以下记账语句：2026-10 消费分析」

  ── 模型返回（第 1 轮，3ms）
  请求调用工具:
    · get_compressibility({})
    · get_noted_bills({"limit":10})

  ┌─ 工具调用: get_compressibility  (9ms, 成功)
  │  入参: {}
  │  出参:
  │    rigidPercent: 14.2
  │    rigidYuan: 200.00
  │    categories: 4 项
  │        - {"path":"交通出行/日常交通/加油","amount":"504.50","percent":35.9,"level":"弹性"}
  └─
```

---

## 三、报告里各段对应什么

| 段落 | 看什么 | 排查什么问题 |
|---|---|---|
| `llm_request` | 模型收到的消息结构 | Prompt 是不是按预期组装 |
| `llm_response` | 模型输出内容 / 请求调用的工具 | 模型是不是该调工具却没调 |
| `tool_call` | 工具名、入参、出参摘要、耗时 | 工具返回的数据对不对 |
| `numeric_mismatch` | 未被工具背书的数字 | 数值护栏拦下了什么 |
| `rigid_category_violation` | 违规的刚性类目 | 刚性保护拦下了什么 |
| `saving_amount_recomputed` | 修正了几处金额 | 模型填的金额和代码算的差多少 |
| `savings_filtered` | 丢弃了几条建议 | 哪些建议被判定不可信 |
| `SUMMARY` | 总耗时、token、降级原因 | 整体有没有降级、贵不贵 |

---

## 四、排查完记得关掉

`DEBUG_TRACE=true` 会让**账单金额进日志**。排查完请删掉这个环境变量并重新部署。

虽然日志只有云函数管理员可见，但账单数据属于用户隐私，
不该长期留在日志系统里。

---

## 五、常见问题

**Q：日志里没有 `[TRACE:` 开头的行？**

按顺序排查：
1. 环境变量加了吗？加在 `analysis-svc` 上了吗？
2. 加完重新部署了吗？（不重新部署，热实例读不到新变量）
3. 触发分析了吗？（只是打开分析页不触发——分析页只读已存结果）
4. 看的是 `analysis-svc` 的日志吗？（不是 `bill-svc` 的）

**Q：只有一条 SUMMARY，没有中间的步骤？**

说明调用链没被记录到。可能：
- 分析走了**降级路径**，模型压根没被调用
- 看的是降级前的旧日志

降级原因看 `SUMMARY.reason` 字段，或分析页卡片上的提示文字。

**Q：能不能看完整的系统提示词？**

不进日志——3000+ 字符会淹没关键信息。
直接看源文件：`cloudfunctions/shared/agent-harness/agents/insight.agent.js`
的 `promptTemplate` 方法。

**Q：本地怎么测？**

```bash
# 用 mock 的模型响应在本地跑一遍完整链路，输出报告
node tools/trace-demo.js

# 也可把原始日志存下来再渲染
node tools/trace-demo.js > trace.log 2>&1
node tools/trace-view.js trace.log
```

`trace-demo.js` 用假 Key + 替换掉的 `fetch`，不消耗 API、不需要真实 Key。
它验证的是**链路与埋点是否正常**，不是模型效果。
