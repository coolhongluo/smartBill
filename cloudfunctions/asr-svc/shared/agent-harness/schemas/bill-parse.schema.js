/**
 * bill-parse 输出 Schema —— 技术文档 §3.6.1
 *
 * 字段设计要点：
 * - amountCertain：区分「明确的100」与「四十来块」这类模糊金额，
 *   模糊时前端要展示 Top3 候选而非直接入账
 * - reasoning：要求模型给出判断依据，便于事后排查归类错误
 * - splitCount：支持「一句多说」
 * - note：用户口述的摘要备注。**刻意不列入 required**——
 *   少一个字段不该让整笔账退回规则兜底（LLM_RETRY_LIMIT=0 时
 *   一次校验失败就是永久降级），缺失时由规则层补一句即可。
 */
module.exports = {
  type: 'object',
  required: ['amount', 'amountCertain', 'timeType', 'date', 'categoryCandidates', 'splitCount'],
  properties: {
    amount: {
      type: 'number',
      minimum: 0,
      maximum: 500000,
      description: '金额，单位「元」。必须是最小货币单位（分）除以 100 后的值，例如 3.55'
    },
    amountCertain: {
      type: 'boolean',
      description: '金额是否被明确说出。「四十来块」这类模糊表达必须为 false'
    },
    timeType: {
      type: 'string',
      enum: ['today', 'yesterday', 'dayBefore', 'lastWeek', 'specific', 'none']
    },
    date: {
      type: 'string',
      description: '账目日期 YYYY-MM-DD。timeType 为 none 时默认今天'
    },
    categoryCandidates: {
      type: 'array',
      minItems: 1,
      maxItems: 3,
      description: '按可能性降序排列的候选类目，最多 3 个',
      items: {
        type: 'object',
        required: ['categoryId', 'score'],
        properties: {
          categoryId: { type: 'string', description: '必须是给定合法类目 ID 之一' },
          score: { type: 'number', minimum: 0, maximum: 1 }
        }
      }
    },
    account: {
      type: 'string',
      enum: ['wechat', 'alipay', 'cash', 'card', 'unknown']
    },
    scene: {
      type: 'string',
      description: '场景/事由，如「单位聚餐」「朋友请客」「自己在家吃」。没有则为「无」'
    },
    note: {
      type: 'string',
      maxLength: 60,
      description:
        '账单备注：把用户原话概括成一句 15 字以内的话，' +
        '保留人物关系与事由（如「和同事吃火锅」「孩子学费」「妈妈生日蛋糕」）。' +
        '**不要写金额**（金额是独立字段，重复会变成同屏两个数字），不要写日期。' +
        '没有可概括的信息时填空字符串。'
    },
    splitCount: {
      type: 'integer',
      minimum: 1,
      description: '一句多说的拆笔数。只表达一笔时为 1'
    },
    reasoning: {
      type: 'string',
      maxLength: 200,
      description: '归类判断依据，简洁说明为什么选这个类目'
    }
  }
};