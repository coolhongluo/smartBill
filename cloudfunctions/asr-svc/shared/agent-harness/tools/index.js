/**
 * 消费分析工具集 —— 暴露给大模型的 function calling 定义
 *
 * ## 设计原则
 *
 * 每个工具都遵循「模型负责问什么，代码负责算什么」：
 *   · 参数尽量少。模型只需要指定想看的维度，日期范围由代码锁定为「已查出的账单」，
 *     避免模型传出 `month: "2025-13"` 这类无效参数导致算出 0。
 *   · 返回值已经是**结论**，不是原始数据。模型不需要（也不应该）拿账单自己加总。
 *   · 描述里写清单位与口径。模型只能看到 description，描述写错它就会用错。
 *
 * ⚠️ 工具执行体在 tools/index.js 里，与本文件（声明）分离：
 *   本文件可安全地拼进 Prompt 描述，index.js 里是可执行代码，不该被当成提示词。
 */

const stats = require('../bill-stats');

/**
 * 工具声明（OpenAI / DeepSeek function calling 格式）
 *
 * 注意：这些 description 会直接进入模型上下文，写得含糊等于给出错误答案。
 */
const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'get_category_share',
      description:
        '获取本月各一级类目的支出金额、笔数与占比。占比由代码精确计算，' +
        '单位为元（字符串，保留两位）。占比合计约等于 100%。' +
        '当你想说「餐饮占大头」「某类目花了多少」时必须调用本工具，不要自己算占比。',
      parameters: {
        type: 'object',
        properties: {
          category: {
            type: 'string',
            description:
              '只看某一个一级类目（如「餐饮」「交通出行」）。留空则返回全部类目。' +
              '当你只关心某一类时用它，可省去自己筛选的麻烦。'
          }
        },
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_monthly_summary',
      description:
        '获取本月汇总：总支出、总笔数、记账天数、按记账天数的日均、按自然日的日均、' +
        '以及最大单笔支出及其类目与日期。所有金额单位为元（字符串）。' +
        '当你想说「这个月花得多不多」「平均每天花多少」时必须调用本工具。',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_month_over_month',
      description:
        '获取本月与上月的支出对比：上月总额、本月总额、变化金额、变化率（百分比数值）' +
        '与方向（up/down/flat，由代码判定，±1% 以内为 flat）。' +
        '上月为 0 时 hasBaseline 为 false，此时不要描述涨跌。' +
        '当你想说「比上月多花了多少」时必须调用本工具，不要自己减。',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_dining_structure',
      description:
        '获取餐饮支出的内部结构：在家吃饭与外出就餐各自的金额与占比（合计为餐饮总额）。' +
        'hasDining 为 false 表示本月没有餐饮支出。' +
        '这是本产品最核心的分析维度：外出就餐占比高时省钱建议才是「减少外食」。',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_top_categories',
      description:
        '获取支出占比最高的几个一级类目，含金额、笔数、单笔均值。' +
        '当你想说「你主要花在什么上面」时调用本工具。',
      parameters: {
        type: 'object',
        properties: {
          n: {
            type: 'integer',
            description: '返回前几个类目，默认 3，取值范围 1~5',
            minimum: 1,
            maximum: 5
          }
        },
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_trend',
      description:
        '获取最近若干个月（默认 6）的每月支出总额与笔数，缺失月份补 0。' +
        '单位为元（字符串）。当你想说「最近几个月趋势」「相比以往」时调用本工具。',
      parameters: {
        type: 'object',
        properties: {
          monthCount: {
            type: 'integer',
            description: '返回最近几个月，取值 3~12，默认 6',
            minimum: 3,
            maximum: 12
          }
        },
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_compressibility',
      description:
        '**第一个要调用**。获取各类目的可压缩性判定：刚性(rigid) / 半刚性(semi) / 弹性(flexible)，' +
        '含刚性支出总额与占比（金额单位为元）。' +
        '刚性 = 房租、学费、药品、物业费、保费、宽带等生活必需或合约类支出，' +
        '这些**禁止出现在任何节省建议里**。' +
        '⚠️ 刚性占比高是正常的，不要解读成「花太多钱」。',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_noted_bills',
      description:
        '获取**带备注的账单明细**，含金额、日期、类目、备注原文、该笔的可压缩性。' +
        '按金额降序返回。备注是判断消费必要性的关键证据：' +
        '同类目同金额，「公司聚餐」和「随便吃点」性质完全不同。' +
        '同时返回 coveragePercent（有备注的笔数占比），' +
        '占比低说明很多消费缺少上下文，此时给建议要更保守。',
      parameters: {
        type: 'object',
        properties: {
          limit: {
            type: 'integer',
            description: '返回前几笔，默认 20，取值 5~50',
            minimum: 5,
            maximum: 50
          },
          category: {
            type: 'string',
            description:
              '只看某一个一级类目的带备注账单（如「餐饮」）。留空则返回全部。' +
              '当你只关心某一类的备注时用它。'
          }
        },
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_recurring_patterns',
      description:
        '检测周期性消费（每周/每月的固定支出）。判定需同时满足：同类目、≥3 笔、' +
        '金额相近、间隔规整——所以返回的都是可靠的「订阅式」支出。' +
        '含每次金额、总额、间隔天数、出现日期、以及这些笔的备注。' +
        '周期支出往往是最值得建议的：「每月 300 的会员你看了几集」' +
        '比「你餐饮花超了」更有价值。单位为元。',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_dining_detail',
      description:
        '获取餐饮的逐笔明细：在家吃饭与外出就餐各自的金额、占比、笔数，' +
        '以及**外出就餐每一笔的金额、日期、备注**和最大单笔金额。' +
        '逐笔明细很关键：3 笔 80 元日常外卖（压缩空间小）' +
        '和1 笔 250 元商务宴请（该问必要性而非「少吃点」）' +
        '需要完全不同的建议。单位为元。',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_bills_detail',
      description:
        '获取本月账单明细：逐笔的类目、金额、日期、备注，外加按一级类目聚合的频次统计' +
        '（笔数、总额、单笔均值、占比、首末日期、平均间隔天数、备注摘录）。' +
        '这是给节省建议前**必须调用**的工具：判断「买太频」「可以换平替」「订阅值不值」' +
        '都要看逐笔证据和频次，只看占比会得出错误建议。' +
        '无备注的账单也会返回（note 为空串），空白备注本身是信息：说明该类目缺少上下文。' +
        '本月超过 100 笔时逐笔列表会截断（truncated=true），但类目聚合统计始终完整。',
      parameters: {
        type: 'object',
        properties: {
          category: {
            type: 'string',
            description:
              '只看某一个一级类目（如「服饰美容」「餐饮」）。留空返回全部。' +
              '当你只关心某一类时用它，聚合统计会按该类目内的末级类目展开。'
          },
          limit: {
            type: 'integer',
            description: '逐笔列表最多返回几笔，默认 30，取值 10~100。类目聚合不受此限制。',
            minimum: 10,
            maximum: 100
          }
        },
        additionalProperties: false
      }
    }
  }
];

/**
 * 入参校验
 *
 * ## 为什么要校验，而不是静默兜底
 *
 * 原来用 `clampInt(args.n, 1, 5, 3)`——传 99 就夹到 5，传「abc」就当默认。
 * 模型不会知道自己传错了，于是会基于**错误理解的数据**下结论，
 * 而它自己毫不知情。
 *
 * 正确的做法是**把错误回传给模型**，让它自己纠正：
 * 工具报错必须回传，这是模型能自我修复的唯一途径。
 *
 * @returns {{ok:boolean, value?:any, error?:string}}
 */
function validateArgs(name, args, schema) {
  const a = args || {};

  for (const [key, rule] of Object.entries(schema || {})) {
    const v = a[key];
    if (v === undefined || v === null || v === '') continue; // 未传 = 用默认

    if (rule.type === 'integer') {
      const num = Number(v);
      if (!Number.isInteger(num)) {
        return {
          ok: false,
          error: `工具 ${name} 的参数 ${key} 必须是整数，收到「${v}」。请重新调用并传一个整数。`
        };
      }
      if (rule.minimum !== undefined && num < rule.minimum) {
        return {
          ok: false,
          error: `工具 ${name} 的参数 ${key} 最小为 ${rule.minimum}，收到 ${num}。请重新调用。`
        };
      }
      if (rule.maximum !== undefined && num > rule.maximum) {
        return {
          ok: false,
          error: `工具 ${name} 的参数 ${key} 最大为 ${rule.maximum}，收到 ${num}。请重新调用。`
        };
      }
    }

    if (rule.type === 'string' && rule.maxLength && String(v).length > rule.maxLength) {
      return {
        ok: false,
        error: `工具 ${name} 的参数 ${key} 太长了（超过 ${rule.maxLength} 字符）。请传一个简短的类目名。`
      };
    }
  }

  return { ok: true };
}

/**
 * 入参约束表
 *
 * 与 TOOL_DEFINITIONS 的 parameters 保持一致，但**可执行**——
 * definitions 里的 schema 是给模型看的（JSON Schema），
 * 这里的是给代码用的（真正会拒绝非法值）。
 *
 * 为什么要两份：JSON Schema 描述不了「必须报错回传」这个行为，
 * 而这恰恰是关键——模型需要知道自己传错了才能自我纠正。
 */
const TOOL_ARG_SCHEMAS = {
  get_category_share: {
    category: { type: 'string', maxLength: 20 }
  },
  get_top_categories: {
    n: { type: 'integer', minimum: 1, maximum: 5 }
  },
  get_trend: {
    monthCount: { type: 'integer', minimum: 3, maximum: 12 }
  },
  get_noted_bills: {
    limit: { type: 'integer', minimum: 5, maximum: 50 },
    category: { type: 'string', maxLength: 20 }
  },
  get_bills_detail: {
    limit: { type: 'integer', minimum: 10, maximum: 100 },
    category: { type: 'string', maxLength: 20 }
  }
};

/**
 * 工具执行层
 *
 * 所有工具共享同一份已清洗的账单快照（context.billsByMonth）。
 * 这样做的原因：模型可能连续调用多个工具，但**账单只查一次数据库**，
 * 既省时间，也保证多个工具看到的是同一份数据（否则前后结论可能自相矛盾）。
 *
 * @param {object} context
 * @param {string} context.month 当前月（YYYY-MM）
 * @param {object} context.billsByMonth { 'YYYY-MM': [已清洗的账单] }
 * @returns {{ok:boolean, data:any, error?:string}}
 */
function executeTool(name, args, context) {
  const ctx = context || {};
  const month = ctx.month || '';
  const billsByMonth = ctx.billsByMonth || {};
  const cur = billsByMonth[month] || [];

  try {
    /**
     * 入参校验先做
     *
     * 顺序很关键：先校验再执行。校验不过就不执行，
     * 避免用被夹过的值算出「看起来正常但不是模型想要」的结果。
     */
    const schema = TOOL_ARG_SCHEMAS[name];
    if (schema) {
      const check = validateArgs(name, args, schema);
      if (!check.ok) return { ok: false, error: check.error };
    }

    switch (name) {
      case 'get_category_share': {
        const all = stats.calcCategoryShare(cur);
        const cat = args && args.category ? String(args.category).trim() : '';
        if (!cat) return { ok: true, data: all };
        // 只返回指定类目：占比仍按全月总额算（占比的分母不变）
        const hit = (all.items || []).filter(
          (i) => i.name === cat || (i.name || '').includes(cat)
        );
        if (!hit.length) {
          return {
            ok: true,
            data: {
              ...all,
              items: [],
              requestedCategory: cat,
              note: `本月没有「${cat}」这一类目的支出`
            }
          };
        }
        return { ok: true, data: { ...all, items: hit, requestedCategory: cat } };
      }

      case 'get_monthly_summary':
        return { ok: true, data: stats.calcMonthlySummary(cur, month) };

      case 'get_month_over_month': {
        // 上月由代码推导，不让模型传 —— 模型不知道「上个月」是哪个月，
        // 而且传错月份会算出无意义的环比。
        const prevMonth = shiftMonth(month, -1);
        return {
          ok: true,
          data: stats.calcMonthOverMonth(cur, billsByMonth[prevMonth] || [])
        };
      }

      case 'get_dining_structure':
        return { ok: true, data: stats.calcDiningStructure(cur) };

      case 'get_top_categories': {
        const n = clampInt(args && args.n, 1, 5, 3);
        return { ok: true, data: stats.calcTopCategories(cur, n) };
      }

      case 'get_trend': {
        const mc = clampInt(args && args.monthCount, 3, 12, 6);
        return { ok: true, data: { items: stats.calcTrend(billsByMonth, mc) } };
      }

      case 'get_bills_detail': {
        const cat = args && args.category ? String(args.category).trim() : '';
        // 默认 30：逐笔明细拉长上下文 → 每轮 prefill 变慢 → 成文轮更容易超时。
        // 30 笔已覆盖绝大多数月份的重点账单（按金额降序截断，大额优先）
        const limit = clampInt(args && args.limit, 10, 100, 30);
        // 超过则逐笔截断：类目聚合始终完整，防 token 爆炸
        const HARD_CAP = 100;

        // 先按类目过滤（与 get_noted_bills 同一套匹配规则：top / path 包含）
        let list = cur;
        if (cat) {
          list = cur.filter(
            (b) => b.top === cat || String(b.categoryPath || '').includes(cat)
          );
        }

        // ── 聚合层：频次统计由代码算，模型只读不数 ──
        // 判断「一周一次」「三天两头买」需要间隔数据，
        // 让模型自己数日期既费 token 又容易数错
        const byTop = new Map();
        for (const b of list) {
          if (!byTop.has(b.top)) {
            byTop.set(b.top, { top: b.top, cent: 0, count: 0, dates: [], notes: [] });
          }
          const g = byTop.get(b.top);
          g.cent += b.amount;
          g.count++;
          g.dates.push(b.date);
          if (b.note && b.note.trim()) g.notes.push(b.note);
        }
        const totalCent = list.reduce((s, b) => s + b.amount, 0);
        const categories = [...byTop.values()]
          .map((g) => {
            const days = g.dates.slice().sort();
            const span = days.length > 1
              ? Math.round((new Date(days[days.length - 1]) - new Date(days[0])) / 86400000)
              : 0;
            return {
              top: g.top,
              count: g.count,
              totalYuan: stats.centToYuanStr(g.cent),
              avgPerBillYuan: stats.centToYuanStr(Math.round(g.cent / g.count)),
              percent: totalCent > 0 ? Math.round((g.cent / totalCent) * 1000) / 10 : 0,
              firstDate: days[0],
              lastDate: days[days.length - 1],
              // 平均间隔：模型判断「一周一次」还是「偶发」的依据；1 笔时为 null
              avgIntervalDays: g.count > 1 ? Math.round(span / (g.count - 1)) : null,
              notedCount: g.notes.length,
              notes: g.notes.slice(0, 5)
            };
          })
          .sort((a, b) => parseFloat(b.totalYuan) - parseFloat(a.totalYuan));

        // ── 逐笔层：按金额降序截断 ──
        // 大额优先暴露：单笔大额是「偶发还是习惯」判断的关键输入
        const sorted = list.slice().sort((a, b) => b.amount - a.amount);
        const truncated = sorted.length > Math.min(limit, HARD_CAP);
        const bills = sorted.slice(0, Math.min(limit, HARD_CAP)).map((b) => ({
          date: b.date,
          categoryPath: b.categoryPath || '未分类',
          amountYuan: stats.centToYuanStr(b.amount),
          note: b.note || ''
        }));

        return {
          ok: true,
          data: {
            month,
            totalCount: list.length,
            totalYuan: stats.centToYuanStr(totalCent),
            truncated,
            requestedCategory: cat || null,
            note: cat && !list.length ? `本月没有「${cat}」类目的支出` : '',
            categories,
            bills
          }
        };
      }

      /* ── 判断类工具：给模型「依据」，而不是给它「答案」 ── */

      case 'get_compressibility': {
        const compressibility = require('../../util/category-compressibility');
        const grouped = compressibility.groupByCompressibility(cur);

        // 按类目给出明细，让模型能逐类目判断而不只看总额
        const byCategory = new Map();
        for (const b of cur) {
          const key = b.categoryPath || '未分类';
          if (!byCategory.has(key)) {
            byCategory.set(key, {
              categoryPath: key,
              cent: 0,
              count: 0,
              compressibility: compressibility.isRigidBill(b)
                ? compressibility.LEVEL.RIGID
                : compressibility.compressibilityOf(b.categoryId),
              notes: []
            });
          }
          const item = byCategory.get(key);
          item.cent += b.amount;
          item.count++;
          if (b.note) item.notes.push(b.note);
        }

        const share = stats.calcCategoryShare(cur);
        const totalCent = share.totalCent || 1;

        return {
          ok: true,
          data: {
            summary: {
              ...grouped.summary,
              rigidYuan: stats.centToYuanStr(grouped.summary.rigidCent),
              totalYuan: stats.centToYuanStr(grouped.summary.totalCent)
            },
            categories: [...byCategory.values()]
              .map((it) => ({
                categoryPath: it.categoryPath,
                amountYuan: stats.centToYuanStr(it.cent),
                percent: Math.round((it.cent / totalCent) * 1000) / 10,
                count: it.count,
                compressibility: it.compressibility,
                compressibilityLabel: compressibility.LEVEL_LABEL[it.compressibility],
                /** 有备注的类目才可能做出「必要性」判断 */
                notedCount: it.notes.length,
                notes: it.notes.slice(0, 3)
              }))
              .sort((a, b) => b.percent - a.percent)
          }
        };
      }

      case 'get_noted_bills': {
        const limit = clampInt(args && args.limit, 5, 50, 20);
        const cat = args && args.category ? String(args.category).trim() : '';
        const all = stats.collectNotedBills(cur, limit);
        if (!cat) return { ok: true, data: all };
        // 只看某类目的备注：按类目路径的首段（一级类目）匹配
        const items = (all.items || []).filter((i) => {
          const path = String(i.categoryPath || '');
          const top = path.split('/')[0] || '';
          return top === cat || path.includes(cat) || (i.leaf || '').includes(cat);
        });
        return {
          ok: true,
          data: {
            ...all,
            items,
            requestedCategory: cat,
            note: items.length ? '' : `「${cat}」本月没有带备注的账单`
          }
        };
      }

      case 'get_recurring_patterns':
        return { ok: true, data: stats.calcRecurringPatterns(cur) };

      case 'get_dining_detail':
        return { ok: true, data: stats.calcDiningDetail(cur) };

      default:
        // 未知工具不能静默返回空：模型可能幻觉出一个不存在的工具名，
        // 静默会让它以为调用成功，然后在没有数据的情况下编结论
        return {
          ok: false,
          error: `未知工具: ${name}。可用工具: ${TOOL_DEFINITIONS.map((t) => t.function.name).join(', ')}`
        };
    }
  } catch (e) {
    return { ok: false, error: `工具 ${name} 执行失败: ${e.message}` };
  }
}

/** 月份偏移：'2026-10' + (-1) → '2026-09' */
function shiftMonth(month, delta) {
  const m = String(month || '').match(/^(\d{4})-(\d{2})$/);
  if (!m) return '';
  const d = new Date(Number(m[1]), Number(m[2]) - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** 参数收敛到安全区间。模型可能传出 0 或 999，不夹住会让统计逻辑跑飞 */
function clampInt(v, min, max, fallback) {
  const n = parseInt(v, 10);
  if (!isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

module.exports = {
  TOOL_DEFINITIONS,
  TOOL_ARG_SCHEMAS,
  executeTool,
  validateArgs,
  shiftMonth,
  clampInt
};