/**
 * 消费分析 Agent v3 —— 省钱建议全 AI 化
 *
 * ## v2 → v3 的核心变化
 *
 * v2：建议受硬规则把关（占比 ≥15%、单类目 ≥3 笔、金额一律代码重算），
 *      结果是用户记 5 笔账、餐饮占 42.6%，却得到「暂时没有可优化空间」。
 * v3：规则全部拆除。模型通过 get_bills_detail 拿到逐笔账单（类目、金额、
 *      日期、备注）与频次统计，像消费顾问一样自由分析——
 *      「买衣服 4 次、间隔 6 天，频次偏高」「备注都是快消品牌，基础款平替能省一半」
 *      这类洞察不需要统计样本，只需要看懂明细。
 *
 * 金额随之从「代码算、模型转述」改为「模型估、prompt 约束口径」：
 * 平替/降档类建议的节省额不是「类目支出 × 固定比例」能表达的，
 * 代码重算反而算错。纯定性建议允许 amount 为 null，不硬造数字。
 *
 * ## 保留的护栏（v2 已验证有效）
 *
 * 1. 铁律零：结论必须有工具支撑（harness 的 findUnsupportedConclusions 会剔除）
 * 2. 刚性拦截：房租/学费/药费不出现在建议里（harness 的 findRigidViolation）
 * 3. 降级诚实：LLM 不可用时 savings 恒为空，前端显示「AI 分析暂不可用」，
 *    不再用规则模板冒充建议
 */

/**
 * 消费分析的结构约束
 *
 * v3 变化：amount 由必填改为可空——纯定性建议（如「试试平替品牌」）
 * 硬配数字容易失真；confidence 升为必填，无备注依据时必须标 low。
 */
const OUTPUT_SCHEMA = {
  name: 'insight',
  required: ['insights', 'savings'],
  fields: {
    insights: { type: 'array', minItems: 1, maxItems: 5, itemType: 'string' },
    savings: {
      type: 'array',
      maxItems: 3,
      itemType: 'object',
      requiredFields: ['title', 'action', 'trigger', 'reason', 'confidence'],
      optionalFields: ['category', 'amount']
    }
  }
};

module.exports = {
  name: 'insight',
  version: 'v3',
  // 判断类任务，需要一点观察力；但发散会变成说教，所以 0.5 是折中
  temperature: 0.5,
  // 1400 而非更大：最终 JSON 实际 600~900 token，输出越大生成越慢、
  // 单轮超时风险越高（线上 trace 实测超时多发生在成文轮）
  maxTokens: 1400,
  jsonMode: true,
  outputSchema: OUTPUT_SCHEMA,
  // 声明走 function calling：数值由 tools 计算，本 Agent 只负责判断与表述
  useTools: true,
  // v3：模型会按类目多次调 get_bills_detail，轮次放宽到 4
  // （默认值取 GUARDRAIL.ANALYSIS_MAX_TOOL_ROUNDS，这里显式写出便于追因）
  maxToolRounds: 4,
  // 分析页是主动查看场景，可放宽（详见 constants.GUARDRAIL 注释）
  budget: {
    maxTokens: 2400,
    timeoutMs: require('../../util/constants').GUARDRAIL.ANALYSIS_LLM_TIMEOUT_MS
  },

  /**
   * 上下文构建
   *
   * ⚠️ 这里**故意不注入账单数据**。
   * 注入就等于给了模型算术的原料，它就会忍不住自己加总，
   * 而 LLM 的加总在几百笔规模下必然出错。数据只留在 tools 侧。
   */
  buildContext(input, options = {}) {
    const lines = [];
    lines.push(`【统计月份】${options.month || '本月'}`);

    // 极简画像：只给模型判断量级所需的信息，不给明细
    if (options.billCount !== undefined) {
      lines.push(`【数据量】本月共 ${options.billCount} 笔记录`);
      if (options.droppedCount > 0) {
        // 明示有脏数据，让模型知道数字可能不完整，避免给出「精确」错觉
        lines.push(`注意：有 ${options.droppedCount} 笔记录格式异常已被排除，结论基于有效数据。`);
      }
    }
    if (options.hasPrevMonth === false) {
      // 上月无数据时必须告知，否则模型会拿环比说事
      lines.push('注意：上月没有记录，环比数据不可用，请不要描述涨跌。');
    }

    return {
      p1_profile: { text: lines.join('\n') },
      context: lines.join('\n')
    };
  },

  promptTemplate(input, contextBlocks) {
    const ctx = (contextBlocks && contextBlocks.p1_profile && contextBlocks.p1_profile.text) || '';

    return `你是家庭记账App「随口记」的消费顾问，帮用户看懂钱花在哪、更要点出哪些能省、怎么省。
用户记账时会写备注（如「和同事吃日料」「优衣库买外套」），备注是你最重要的证据。

## 🚫 铁律零：结论必须有工具支撑

你看不到任何账单，所有事实必须来自工具调用：

| 你想说的结论 | 必须先调用 |
|---|---|
| 某类目占比、花了多少、买了多少次、间隔多久 | get_bills_detail |
| 哪些是刚性支出、刚性占多少 | get_compressibility |
| 某笔消费的性质（依据备注） | get_bills_detail 或 get_noted_bills |
| 周期性/订阅式消费 | get_recurring_patterns |
| 在家吃 vs 外出就餐 | get_dining_detail |
| 总额、笔数、日均 | get_monthly_summary |
| 比上月多花/少花多少 | get_month_over_month |
| 最近几个月趋势 | get_trend |

没有工具支撑的结论会被系统丢弃，白写。
**给建议前必须先调 get_bills_detail**——判断「买太频」「值不值」「能不能换平替」
需要逐笔证据和频次，只看占比会得出错误建议。只关心某一类就传 category。

## 🚫 铁律一：刚性支出的建议边界

先调 get_compressibility，知道每个类目的等级：
- **刚性(rigid)**：房租、学费、药品、物业费、保费、宽带……
  ✗ 不要给「少花点」「控制支出」——这些是生活必需或合约，省了伤生活或违约
  ✓ 可以给「优化方式」：保费比价、套餐降档、年付替代月付
  ✓ 刚性占比高是正常的，在 insights 里如实说「可优化空间有限」即可
- **半刚性(semi)**：日用品、部分会员、衣物……可以提，但要克制，不建议「砍零」
- **弹性(flexible)**：娱乐、零食、非必需服饰、外出就餐……这才是主要优化对象

## 🚫 铁律二：备注是判断必要性的唯一直接证据

| 备注类型 | 例子 | 处理 |
|---|---|---|
| 刚性关键词 | 房租、学费、买药 | 不提建议 |
| 社交必需 | 公司聚餐、同学聚会、请客 | 建议要适度，不要说「少聚餐」 |
| 自我提升 | 课程、买书、健身 | 问必要性，不建议砍掉 |
| 冲动/可选 | 奶茶、零食、打游戏、非必需服饰 | 可以明确建议 |
| **无备注** | — | 允许给通用建议，但 confidence 填 "low"，reason 说明仅基于类目与金额 |

## 💡 建议视角（你的核心价值，规则引擎给不了这些）

1. **频次**：「服饰 4 笔、平均间隔 6 天」→ 这是习惯而非偶发，
   可建议冷静期（想买先等 3 天）、按需集中采购
2. **品牌与档次**：备注里的品牌是关键信号。「优衣库」「星巴克」→
   可以建议平替、降档、比价，或「基础款换白牌能省一半」这类具体替代方案
3. **订阅审视**：周期性消费问「真的用得多吗」——视频会员看得少 → 降档或按季买；
   每周打车 2 次 → 部分改公交/骑行
4. **单笔大额 ≠ 习惯**：只有 1 笔的 500 元更像偶发事件，
   建议「等打折/换季再买」，不要说「你经常买」
5. **社交与提升类支出**：不建议砍，可以建议更优的获得方式（二手书、体验课再办卡）

## 金额规则（重要）

- amount **可选**：有依据就估，并在 action 里写清估算口径
  ✓「每次 175 元的火锅，一个月一次改一个半月一次，约省 115 元」（有单次金额依据）
  ✓「基础款平替通常省一半，约省 200 元」（有类目金额依据）
  ✗ 纯定性建议（如「下次买之前等 3 天」）就传 null，**不要硬造数字**
- amount 是数字字符串（如 "115.00"），不得超过该类目本月实际支出
- 金额无法从工具数据推出时，一律传 null

## 建议写法

### insights（1~5 条）
说具体事实与观察，不要套话。每条都要有工具返回的数字支撑，数字必须与工具返回值一致。
✗「你需要控制开销」
✓「服饰 4 笔共 860 元、平均间隔 6 天，频次偏高」

### savings（0~3 条）
每条字段：
- category：一级类目名（必须与 get_bills_detail 返回的类目名完全一致）
- title：一句话概括
- amount：估算节省金额（数字字符串）或 null（纯定性建议）
- action：具体到能立刻执行；含金额时写清估算口径
  ✗「注意节约」
  ✓「本月 4 次外出就餐共 700 元，若每月少一次、改为在家吃，约省 175 元」
- trigger：什么情况下这条建议成立
- reason：依据是什么（引用备注、频次、周期性或类目占比）
- confidence："high"（有备注支撑）/ "low"（仅基于类目与金额）

### 允许返回空数组
确实没有可优化点（如全部刚性）时，返回空 savings 并在 insights 里解释原因。
给错建议比不给更糟——用户按错误建议减少必要开支，反而受损。

## 输出格式
只输出一个 JSON 对象，不要 markdown 代码块，不要任何解释文字。

${ctx}

## 输出示例（供参考格式，不是模板）

{"insights":["餐饮 620 元占 42.6%，最大一笔 380 元备注「和同事吃日料」，属社交性支出","通讯 300 元占 20.7%，仅 1 笔且无备注，无法判断是套餐费还是一次性购物"],"savings":[{"category":"通讯","title":"确认这笔通讯支出是什么","amount":null,"action":"通讯 300 元没有备注：若是月租套餐，对比套餐与实际用量，降档通常每月省 50~100 元；若是一次性购物（如买配件）则无需处理","trigger":"通讯支出占比超 20% 且无备注","reason":"仅基于类目与金额，无备注支撑","confidence":"low"},{"category":"服饰","title":"买衣服频次偏高，可试试平替","amount":"200.00","action":"本月 4 笔共 860 元、平均间隔 6 天；备注都是快消品牌，基础款换白牌通常省一半，约省 200 元；下次下单前先等 3 天","trigger":"服饰笔数为各类目最多且间隔短","reason":"4 笔均有品牌与渠道备注，判断可靠","confidence":"high"}]}`;
  },

  /**
   * 规则兜底 —— LLM 不可用时用纯代码模板生成结论
   *
   * ## v3 变化：降级不再生成节省建议
   *
   * v2 的降级会按规则拼出建议（占比×30%、单笔×20%），
   * 但那套规则正是 v3 要拆除的东西。
   * 降级时 savings 恒为空数组，analysis-svc 会把 meta.savingsSource 标记为
   * 'unavailable'，前端据此显示「AI 分析暂不可用」+ 重试按钮，
   * 而不是用规则建议冒充 AI 结论。
   *
   * insights 的规则兜底保留：它是描述性的（数字全部来自 bill-stats），
   * 质量虽有折扣但绝不会错，分析页不至于一片空白。
   */
  fallback(input, options = {}) {
    const { billsByMonth = {}, month = '' } = options || {};
    const stats = require('../bill-stats');
    const compressibility = require('../../util/category-compressibility');
    const cur = billsByMonth[month] || [];

    if (!cur.length) {
      return { insights: ['本月还没有足够的记账数据'], savings: [], _fallback: true };
    }

    const insights = [];
    const share = stats.calcCategoryShare(cur);
    const sum = stats.calcMonthlySummary(cur, month);

    // 结论 1：刚性占比 —— 必须如实说明「这是生活必需」，不能暗示用户花超了
    const grouped = compressibility.groupByCompressibility(cur);
    if (grouped.summary.totalCent > 0 && grouped.summary.rigidPercent > 0) {
      insights.push(
        `刚性支出 ${stats.centToYuanStr(grouped.summary.rigidCent)} 元，占 ${grouped.summary.rigidPercent}%` +
        '（房租、学费、药品等生活必需），这部分不需要优化'
      );
    }

    // 结论 2：可优化空间最大的类目
    // ⚠️ 必须排除刚性，否则会输出「在可优化的类目里，居住占比最高」这种自相矛盾的话
    const flexibleNames = new Set(grouped.flexible.map((b) => b.top));
    const flexibleTop = share.items.find((it) => flexibleNames.has(it.name));
    if (flexibleTop) {
      insights.push(
        `在可优化的类目里，${flexibleTop.name} 占比最高，本月 ${flexibleTop.valueYuan} 元`
      );
    }

    // 结论 3：记账节奏
    insights.push(`本月共 ${sum.count} 笔、记了 ${sum.recordedDays} 天，按记账天数算日均 ${sum.avgPerRecordedDayYuan} 元`);

    // 结论 4：周期性消费 —— 这是模型路径最有价值的部分，降级时也要给
    const recurring = stats.calcRecurringPatterns(cur);
    for (const r of recurring.items.slice(0, 2)) {
      insights.push(`检测到${r.cycleLabel}一次的「${r.name}」，${r.count} 次共 ${r.totalYuan} 元，平均每次 ${r.avgAmountYuan} 元`);
    }

    // 结论 5：餐饮结构
    const dining = stats.calcDiningStructure(cur);
    if (dining.hasDining && (dining.homeCent > 0 || dining.awayCent > 0)) {
      const parts = [];
      if (dining.homeYuan !== '0.00') parts.push(`在家吃饭 ${dining.homeYuan} 元（${dining.homePercent}%）`);
      if (dining.awayYuan !== '0.00') parts.push(`外出就餐 ${dining.awayYuan} 元（${dining.awayPercent}%）`);
      insights.push(`餐饮结构：${parts.join('，')}`);
    }

    // 结论 6：环比
    const prev = stats.calcMonthOverMonth(cur, billsByMonth[require('../tools').shiftMonth(month, -1)] || []);
    if (prev.hasBaseline && prev.direction !== 'flat') {
      const word = prev.direction === 'up' ? '多花了' : '少花了';
      insights.push(`相比上月${word} ${prev.deltaYuan} 元（${prev.deltaRate > 0 ? '+' : ''}${prev.deltaRate}%）`);
    }

    return {
      insights: insights.slice(0, 5),
      savings: [],
      _fallback: true
    };
  }
};
