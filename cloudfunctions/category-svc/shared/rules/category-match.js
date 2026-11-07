/**
 * 三通道分类引擎 —— 技术文档 §6.2
 *
 * 通道 1：关键词精确匹配（权重 0.5）
 * 通道 2：金额-阈值规则匹配（权重 0.2）
 * 通道 3：语义向量匹配（权重 0.3）—— 本阶段留接口，由 Harness 的 LLM 通道承担
 *
 * 融合：总分 = Σ(通道得分 × 通道权重)，取 Top3
 * 三通道全不命中 → unknown，入账后作为学习样本
 *
 * 重要：这是纯规则实现，不依赖 LLM。LLM 只在通道 3 作为「语义判断」补充，
 *      且模型输出仍需经置信度融合与幻觉校验。
 */

const { LEAF_CATEGORIES, CATEGORY_MAP } = require('../util/category-preset');
const { UNKNOWN_CATEGORY_ID } = require('../util/constants');

/**
 * 通道 2：金额-阈值规则（PRD §7.3 关键归类决策规则）
 * 这些规则体现产品最强的领域判断，不能交给模型
 */
const AMOUNT_RULES = [
  {
    // 「打车去医院」→ 就医优先。
    // 注意：此规则必须排在「打车+小额」规则之前，否则会被抢走（PRD §7.3）
    condition: (ctx) => /打车|滴滴|出租车/.test(ctx.text) && /医院|看病|挂号|买药|大夫|急诊/.test(ctx.text),
    categoryId: 'c5_1_1',
    score: 0.85,
    // 高优先级领域场景：就医场景应压过「打车=通勤」的默认判断
    priority: 10,
    reason: '打车 + 医疗场景 → 优先医疗'
  },
  {
    // 地铁/公交 + 小额 → 日常交通
    condition: (ctx) => /地铁|公交|乘车码/.test(ctx.text) && ctx.amountYuan < 50,
    categoryId: 'c2_1_1',
    score: 0.85,
    reason: '关键词「地铁/公交」+ 金额 < 50 元'
  },
  {
    // 打车 + 金额小 → 日常交通
    condition: (ctx) => /打车|滴滴|出租车|网约车/.test(ctx.text) && ctx.amountYuan < 100,
    categoryId: 'c2_1_2',
    score: 0.8,
    // 优先级低于医疗/学校等场景规则：领域场景判断应压过「通勤默认」
    priority: 0,
    reason: '关键词「打车」+ 金额 < 100 元 → 日常交通'
  },
  {
    // 高铁/机票 → 大交通（跨城长途）
    condition: (ctx) => /高铁|飞机|机票|动车|火车|卧铺/.test(ctx.text),
    categoryId: 'c2_2_1',
    score: 0.9,
    reason: '关键词命中跨城交通'
  },
  {
    // 金额 ≥ 200 且无明确小类线索 → 大交通倾向
    condition: (ctx) => ctx.amountYuan >= 200 && /车|票|出行/.test(ctx.text),
    categoryId: 'c2_2_1',
    score: 0.6,
    reason: '金额 ≥ 200 元 + 交通类词'
  },
  {
    // 节假日/景区/出游 + 交通属性 → 出游相关交通
    condition: (ctx) => /旅游|出游|包车|景区|门票|导游|国庆|春节|假期/.test(ctx.text) && /车|交通|包车/.test(ctx.text),
    categoryId: 'c2_3_1',
    score: 0.85,
    reason: '出游场景词 + 交通属性'
  },
  {
    // 米面粮油关键词 → 餐饮/在家吃饭/米面粮油
    condition: (ctx) => /买米|买面|米面|粮油|食用油/.test(ctx.text),
    categoryId: 'c1_1_5',
    score: 0.85,
    reason: '关键词「米面粮油」'
  },
  {
    // 「食堂」→ 单位与集体/工作餐（而非在家吃饭）
    condition: (ctx) => /食堂|工作餐|单位餐/.test(ctx.text),
    categoryId: 'c1_4_1',
    score: 0.85,
    reason: '关键词「食堂」→ 工作餐'
  },
  {
    // 下馆子/聚餐 且 金额 ≥ 150 → 外出就餐/聚餐宴请
    condition: (ctx) => /下馆子|聚餐|请客|宴请/.test(ctx.text) && ctx.amountYuan >= 150,
    categoryId: 'c1_2_8',
    score: 0.85,
    reason: '外出就餐 + 金额 ≥ 150 元 → 聚餐宴请'
  },
  {
    // 「超市」无细分线索 → 默认日用百货，但分数压低以便触发二次确认
    // PRD §7.3：默认居家生活 > 日用百货，并推荐候选「买菜」
    condition: (ctx) => /超市|商场|百货商店/.test(ctx.text),
    categoryId: 'c3_1_1',
    score: 0.55,
    reason: '关键词「超市」+ 无细分线索 → 默认日用百货（需二次确认）'
  },
  {
    // 超市 + 生鲜类词 → 买菜
    condition: (ctx) => /超市/.test(ctx.text) && /菜|蔬菜|水果|生鲜|肉|米面/.test(ctx.text),
    categoryId: 'c1_1_1',
    score: 0.85,
    reason: '超市 + 生鲜线索 → 买菜'
  },
  {
    // 蛋糕/烘焙成品 → 外出就餐（生日蛋糕场景 PRD 要求二次确认，此处给外出就餐作首选候选）
    condition: (ctx) => /蛋糕|面包|烘焙|甜品/.test(ctx.text),
    categoryId: 'c1_2_4',
    score: 0.6,
    reason: '关键词「蛋糕/烘焙」→ 西餐快餐（生日送礼场景需二次确认）'
  },
  {
    // 生日/送礼场景 → 人情往来送礼
    condition: (ctx) => /生日|母亲节|父亲节|礼物|送礼/.test(ctx.text) && /蛋糕|鲜花|礼/.test(ctx.text),
    categoryId: 'c7_2_1',
    score: 0.7,
    reason: '生日/送礼场景 → 人情往来'
  },
  {
    // 学费类关键词
    condition: (ctx) => /学费|保育费/.test(ctx.text),
    categoryId: 'c4_2_1',
    score: 0.9,
    reason: '关键词「学费」'
  }
];

/**
 * 通道 1：关键词精确匹配
 * @param {string} text
 * @param {Array} extraCategories 追加参与匹配的类目（用户自定义类目，可为空）
 * @returns {Array<{categoryId, score, matchedKeyword}>}
 */
function keywordChannel(text, extraCategories = []) {
  if (!text) return [];
  const results = [];
  const pool = extraCategories.length ? [...LEAF_CATEGORIES, ...extraCategories] : LEAF_CATEGORIES;
  for (const cat of pool) {
    const keys = [...(cat.keywords || []), ...(cat.aliases || [])];
    for (const kw of keys) {
      if (kw && text.includes(kw)) {
        // 关键词越长越可信（「买菜」比「菜」更具体）
        const specificity = Math.min(kw.length / 4, 1);
        results.push({
          categoryId: cat.id,
          score: 0.5 + specificity * 0.45, // 0.5~0.95
          matchedKeyword: kw
        });
        break; // 每个类目只记最强命中
      }
    }
  }
  return results;
}

/**
 * 通道 2：金额-阈值规则匹配
 */
function amountChannel(text, amountYuan) {
  const ctx = { text: text || '', amountYuan: amountYuan || 0 };
  const results = [];
  for (const rule of AMOUNT_RULES) {
    try {
      if (rule.condition(ctx)) {
        results.push({
          categoryId: rule.categoryId,
          score: rule.score,
          priority: rule.priority || 0,
          reason: rule.reason
        });
      }
    } catch (e) {
      // 单条规则出错不影响其他规则
    }
  }
  return results;
}

/**
 * 融合多通道结果
 * @param {Array<{categoryId, score, channel, detail}>} channelResults
 */
function fuse(channelResults) {
  const WEIGHTS = { keyword: 0.5, amount: 0.2, semantic: 0.3 };
  const agg = new Map();

  for (const r of channelResults) {
    const w = WEIGHTS[r.channel] || 0;
    const contribution = r.score * w;
    const entry = agg.get(r.categoryId) || {
      categoryId: r.categoryId,
      score: 0,
      channels: [],
      maxPriority: 0
    };
    entry.score += contribution;
    // priority 表达领域判断的优先级：高 priority 的规则应压过低 priority 的默认推断
    if (r.priority !== undefined) {
      entry.maxPriority = Math.max(entry.maxPriority, r.priority);
    }
    entry.channels.push({ channel: r.channel, score: r.score, detail: r.detail, priority: r.priority });
    agg.set(r.categoryId, entry);
  }

  const sorted = Array.from(agg.values()).sort((a, b) => b.score - a.score);

  // 规则覆盖机制（PRD §7.3 歧义处理原则）：
  //
  // 金额-阈值通道承载产品明确写下的领域判断（如「打车去医院」优先医疗、
  // 「蛋糕」不应因命中「蛋」字而归入肉蛋）。这类判断一旦命中就应压过
  // 关键词通道的模糊误命中——加权求和做不到，因为关键词通道权重更高，
  // 一个误命中就能盖过正确的规则。
  //
  // 因此：priority > 0 的规则命中项直接置顶，仅关键词支撑的项降权。
  const strongRules = sorted.filter((c) => c.maxPriority > 0);

  if (strongRules.length) {
    const strongIds = new Set(strongRules.map((c) => c.categoryId));
    for (const c of sorted) {
      if (strongIds.has(c.categoryId)) continue;
      const onlyKeyword = c.channels.every((ch) => ch.channel === 'keyword');
      if (onlyKeyword) c.score *= 0.5;
    }
    // 强规则按 priority 降序置顶，同 priority 按聚合分排序
    strongRules.sort((a, b) => b.maxPriority - a.maxPriority || b.score - a.score);
    const rest = sorted.filter((c) => !strongIds.has(c.categoryId)).sort((a, b) => b.score - a.score);
    return [...strongRules, ...rest];
  }

  return sorted;
}

/**
 * 主入口：规则通道分类
 * @param {string} text ASR 文本
 * @param {number} amountYuan 金额（元）
 * @param {Array} semanticCandidates 语义通道候选（由 Harness/LLM 提供，可为空）
 * @param {Array} customCategories 用户自定义类目（db.categories 文档，可为空）。
 *   与预置末级同权参与关键词通道——用户亲手为某说法建过类目，
 *   下次同样的话必须能命中，否则「自主新增」只对当笔有效。
 * @returns {{candidates:Array, topCategoryId:string, hitAllMiss:boolean}}
 */
function classify(text, amountYuan, semanticCandidates = [], customCategories = []) {
  // 归一化自定义类目并建索引：水合（name/path/color）与匹配共用一份
  // 注意 db 文档的主键是 _id（add 落库后没有 id 字段），两处都要认
  const customIndex = new Map();
  for (const c of customCategories || []) {
    const cid = c && (c.id || c._id);
    if (!c || !cid) continue;
    customIndex.set(cid, {
      id: cid,
      name: c.name,
      path: c.path || c.name,
      color: c.color || '#A8A8A8',
      keywords: c.keywords || [c.name].filter(Boolean),
      aliases: c.aliases || [],
      level: 3,
      custom: true
    });
  }
  const customs = Array.from(customIndex.values());

  const kw = keywordChannel(text, customs).map((r) => ({ ...r, channel: 'keyword', detail: `命中「${r.matchedKeyword}」` }));
  const am = amountChannel(text, amountYuan).map((r) => ({ ...r, channel: 'amount', detail: r.reason }));
  const sem = (semanticCandidates || []).map((r) => ({ ...r, channel: 'semantic' }));

  const fused = fuse([...kw, ...am, ...sem]);

  // 取Top3，补全路径（预置查 CATEGORY_MAP，自定义查本地索引）
  const lookup = (id) => CATEGORY_MAP.get(id) || customIndex.get(id);
  const candidates = fused.slice(0, 3).map((c) => {
    const cat = lookup(c.categoryId);
    return {
      categoryId: c.categoryId,
      categoryName: cat ? cat.name : '未知',
      categoryPath: cat ? cat.path : '',
      color: cat ? cat.color : '#C0C0C0',
      score: Math.min(c.score, 1),
      custom: !!(cat && cat.custom),
      channels: c.channels
    };
  });

  const hitAllMiss = candidates.length === 0;

  return {
    candidates,
    topCategoryId: candidates.length ? candidates[0].categoryId : UNKNOWN_CATEGORY_ID,
    hitAllMiss,
    channelStats: {
      keyword: kw.length,
      amount: am.length,
      semantic: sem.length
    }
  };
}

module.exports = {
  classify,
  keywordChannel,
  amountChannel,
  fuse,
  AMOUNT_RULES
};