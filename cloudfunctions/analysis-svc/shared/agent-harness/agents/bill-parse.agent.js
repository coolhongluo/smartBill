/**
 * bill-parse Agent —— P0 阶段实现的第一个 Agent
 *
 * A档能力（技术文档 §9.2）：中文口语解析必须用模型，规则无法枚举。
 * 定位：补齐规则层覆盖不到的部分，而不是替代规则层。
 *
 * 关键约束：
 * 1. 金额只做「提取」不做「计算」，数值由规则层交叉校验（§9.4 C1）
 * 2. 类目 ID 必须来自合法清单，杜绝幻觉（护栏会拦截）
 * 3. 规则层解析结果会作为上下文给出，供模型对齐，同时用于置信度融合
 */

const preset = require('../../util/category-preset');
const asrRules = require('../../rules/asr-parse');
const money = require('../../util/money');

/** 合法类目 ID 清单（防幻觉校验用） */
const VALID_CATEGORY_IDS = preset.LEAF_CATEGORIES.map((c) => c.id);

/** 合法 ID → 类目对象的映射，供 Prompt 注入候选清单 */
const ID_MAP = new Map(preset.LEAF_CATEGORIES.map((c) => [c.id, c]));

module.exports = {
  name: 'bill-parse',
  version: 'v1',
  temperature: 0.1,   // 提取类任务低温保稳定
  maxTokens: 800,
  jsonMode: true,
  outputSchema: require('../schemas/bill-parse.schema'),
  validCategoryIds: VALID_CATEGORY_IDS,
  categoryPathKey: 'categoryCandidates',

  /**
   * 构建上下文：注入压缩类目树 + 用户别名 + 规则层解析结果
   * 这是「规则与模型混合」的落地：规则先给基准，模型在此基础上补充
   */
  buildContext(input, options = {}) {
    const text = typeof input === 'string' ? input : input.text || '';
    const ruleParsed = options.ruleParsed || asrRules.parse(text);
    const ruleCategoryId = options.ruleCategoryId || null;

    const lines = [];

    lines.push('【可用类目】');
    lines.push(preset.buildPromptCategoryTree());

    // 规则层候选注入：让模型知道规则层已判定的结果，用于对齐而非盲猜
    if (ruleCategoryId && ID_MAP.has(ruleCategoryId)) {
      const c = ID_MAP.get(ruleCategoryId);
      lines.push('');
      lines.push('【规则层已判定】');
      lines.push(`${ruleCategoryId}（${c.path}）—— 请判断这个判定是否正确，不正确则给出你更倾向的类目。`);
    }

    lines.push('');
    lines.push('【规则层解析参考】');
    lines.push(`金额: ${ruleParsed.amount}（${ruleParsed.amountCertain ? '明确' : '模糊'}）`);
    lines.push(`日期: ${ruleParsed.date}（${ruleParsed.timeType}）`);
    lines.push(`账户: ${ruleParsed.account}`);
    if (ruleParsed.scenes.length) lines.push(`场景线索: ${ruleParsed.scenes.join(', ')}`);

    if (options.userAliases && options.userAliases.length) {
      lines.push('');
      lines.push('【用户自定义别名】');
      lines.push(options.userAliases.join('、'));
    }

    return {
      p1_categoryTree: { text: lines.join('\n') },
      context: lines.join('\n')
    };
  },

  /**
   * Prompt 模板
   * 说明：这里用函数形式，因为需要按上下文动态注入合法类目 ID 清单
   */
  promptTemplate(input, contextBlocks) {
    const ctx = (contextBlocks && contextBlocks.p1_categoryTree && contextBlocks.p1_categoryTree.text) || '';

    return `你是家庭记账App「随口记」的语义解析引擎，负责把家庭主妇的日常口语转换为结构化账目。

## 你的任务
从用户的口语句子中抽取五类要素：金额、时间、类目、账户、场景，并给出至多 3 个按可能性降序排列的类目候选。
另外写一句 **note（账单备注）**：把用户这句话概括成一句短话，作为这笔账的备注。

## 抽取规则
### 金额
- 必须精确到「分」，例如「三块五毛五」= 3.55，「六十八块五」= 68.5
- 中文口语常省略单位：「一百五」= 150，「三十块八」= 30.8
- 若表达本身模糊（「四十来块」「三十多」「一百左右」），amountCertain 必须为 false
- 你只负责提取金额，不要做任何加减乘除运算

### 时间
- 今天 / 昨天 / 前天 / 上周三 / 上个月5号 都要正确换算为具体日期
- 语句未提时间时，timeType 为 "none"，date 填今天
- 不要返回未来的日期

### 类目
- 必须使用【可用类目】中逐条列出的 ID，**照抄即可，严禁自行推导或编造**
  （注意：ID 与序号没有对应关系，例如「洗衣」不属于任何以 c5开头的 ID，不要按位置猜）
- 餐饮必须严格区分「在家吃饭」与「外出就餐」——这是产品最核心的分类诉求
- 交通必须区分「日常交通」「大交通」「出游相关交通」
- 候选按可能性降序，最多 3 个，score 为0~1 的置信值
- 若语句语义模糊（如「超市 268」无法判断买什么），应给出 2~3 个并列候选而非强行单选

### 场景
- 提取人物关系与事由，用于更细的类目判定
- 没有则填「无」

### 备注（note）
备注是**用户日后回看这笔账时唯一的上下文线索**，必须做到：
- **15 字以内**的一句话，用中文短语
- **保留人物关系与事由**：
  ✓「和同事吃火锅」「孩子学费」「妈妈生日蛋糕」「楼下超市」
  ✗「餐饮」「教育」「日用品」——太笼统，等于没写
- **绝不写金额**（金额已经是独立字段，写进备注会变成同屏两个数字）
- **绝不写日期**（日期也是独立字段）
- **绝不编造**用户没说过的信息。没提到是谁就写事情本身（「买牛奶」），不要臆造「给孩子买牛奶」
- 用户原话本身就很短时（如「买菜 100」），备注写「买菜」即可，不要凑字数

## 输出格式
只输出一个 JSON 对象，不要输出任何解释文字，不要使用 markdown 代码块标记。

${ctx}

## 输出示例
输入：昨天跟朋友下馆子吃了380
输出：
{"amount":380,"amountCertain":true,"timeType":"yesterday","date":"2026-10-16","categoryCandidates":[{"categoryId":"c1_2_1","score":0.92}],"account":"unknown","scene":"朋友聚餐","splitCount":1,"note":"和朋友下馆子","reasoning":"出现下馆子关键词且金额较大，归入外出就餐/下馆子点菜"}`;
  },

  /**
   * 规则兜底 —— LLM 不可用时保证链路不断
   * 降级后的置信度由调用方另行标注（技术文档 §4.3 L2 降级）
   */
  fallback(input, options = {}) {
    const text = typeof input === 'string' ? input : input.text || '';
    const ruleParsed = options.ruleParsed || asrRules.parse(text);

    // 优先使用规则层已算好的完整候选列表（Top3），
    // 这样兜底路径的体验与 LLM 路径一致——用户仍能在中档看到多个选项。
    // 只有当调用方没给（如某些早期调用）才退化为单个 ruleCategoryId。
    let candidates = [];
    if (Array.isArray(options.ruleCandidates) && options.ruleCandidates.length) {
      candidates = options.ruleCandidates.map((c) => ({
        categoryId: c.categoryId,
        score: c.score
      }));
    } else if (options.ruleCategoryId && ID_MAP.has(options.ruleCategoryId)) {
      const c = ID_MAP.get(options.ruleCategoryId);
      candidates = [{ categoryId: c.id, score: 0.7 }];
    }

    // 场景要转成中文短语。
    // ⚠ 规则层的 scene 是英文代码（unit/friends/child…），
    //   直接当备注写进账单，用户看到的就是「friends」——不可接受。
    const scene = describeScene(ruleParsed.scenes);

    return {
      amount: ruleParsed.amount,
      amountCertain: ruleParsed.amountCertain,
      timeType: ruleParsed.timeType,
      date: ruleParsed.date,
      categoryCandidates: candidates,
      account: ruleParsed.account,
      scene: scene || '无',
      splitCount: ruleParsed.splitCount,
      // 兜底路径不产出 note：LLM 失败时备注用**用户原话全文**，
      // 由 bill-svc 统一合成（见 util/note-summary.js 的 buildNote）。
      // 这里给空串而不是规则提炼——规则提炼必然丢信息，
      // 而「模型没帮上忙」的时候，信息完整比简洁更重要。
      note: '',
      reasoning: '规则层解析（LLM 不可用时的降级路径）',
      _fallback: true
    };
  }
};

/**
 * 规则层场景代码 → 中文短语
 *
 * 拿不到可读描述时返回空串，让调用方回落到原话提炼，
 * 而不是写一个「unit」这种用户看不懂的词。
 */
function describeScene(scenes) {
  if (!Array.isArray(scenes) || !scenes.length) return '';
  const { SCENE_LABELS } = require('../../util/note-keywords');
  const labels = scenes.map((s) => SCENE_LABELS[s]).filter(Boolean);
  return labels.join('、');
}