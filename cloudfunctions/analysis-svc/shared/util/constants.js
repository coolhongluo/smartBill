/**
 * 全局常量 —— 集中管理，避免魔法数字散落各处
 */

/** 置信度分档阈值（设计文档 §5.1 三档固定不变） */
const CONFIDENCE = {
  HIGH: 0.75,      // ≥ 此值直接入账
  MID: 0.4         // ≥ 此值且 < HIGH 时请求用户确认；< 此值引导手动选类目
};

/** 流水来源 */
const BILL_SOURCE = {
  VOICE: 'voice',
  AUTO: 'auto',
  RECALL: 'recall',
  MANUAL: 'manual'
};

/** 账户类型 */
const ACCOUNT_TYPE = {
  WECHAT: 'wechat',
  ALIPAY: 'alipay',
  CASH: 'cash',
  CARD: 'card',
  UNKNOWN: 'unknown'
};

/** 时间类型 */
const TIME_TYPE = {
  TODAY: 'today',
  YESTERDAY: 'yesterday',
  DAY_BEFORE: 'dayBefore',
  LAST_WEEK: 'lastWeek',
  SPECIFIC: 'specific',
  NONE: 'none'
};

/** 未知类目 ID —— 三通道全不命中时使用 */
const UNKNOWN_CATEGORY_ID = 'unknown';

/**
 * 数据库集合名（技术文档 §4.1）
 *
 * 注意：这些集合必须在云开发控制台**手工创建**。
 * 云开发的 createCollection 接口需要管理员权限，从云函数调用会失败，
 * 因此代码里不做自动建表，只在报错时给出明确指引。
 */
const COLLECTIONS = {
  BILLS: 'bills',// 流水（主集合）
  CATEGORIES: 'categories',   // 类目（支持用户自定义扩展）
  TEMPLATES: 'templates',     // 自动记账模板
  USERS: 'users',             // 用户设置与画像
  RECURRING: 'recurring',     // 重复记账规则（dailyRecurring 定时生成账单）
  FAMILIES: 'families',       // 家庭（创建者 + 邀请码 + 成员数）
  FAMILY_BILLS: 'family_bills' // 家庭账本流水（与 bills 同构 + familyId）
};

/**
 * 账本类型（家庭模式双空间）
 *
 * 每笔账记入个人或家庭账本之一。家庭账本全员可见可记，
 * 个人账本仍按 openid 隔离 —— 与现有 bills 集合的行为完全一致。
 */
const LEDGER = {
  PERSONAL: 'personal',
  FAMILY: 'family'
};

/**
 * 家庭模式常量
 *
 * 邀请码字符集排除易混字符 0/O/1/I —— 手输 8 位字符
 * 还要抄写比对时，看错一位等于从头再来。
 */
const FAMILY = {
  MAX_MEMBERS: 8,               // 成员上限（含创建者），familyJoin 时云端强制
  INVITE_CODE_LENGTH: 8,        // 邀请码长度
  INVITE_TTL_MS: 72 * 3600 * 1000,  // 邀请码有效期 72 小时
  INVITE_ALPHABET: '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'  // 32 字符，排除 0/O/1/I
};

/** 漏记信号类型 */
const LEAK_SIGNAL = {
  BASELINE: 'baseline',   // A：周期基线未命中
  GAP: 'gap',             // B：日支出缺口
  BILL: 'bill'            // C：账单流水未匹配
};

/** 账期 / 时间 */
const DAY_MS = 86400000;

/**
 * LLM 调用护栏
 *
 * ## 为什么超时只有 2200ms（不是 5000）
 *
 * ⚠️ **先纠正一个流传很广的错误说法**：
 *    「小程序调用云函数有3 秒网关上限，客户端只能等 3 秒」——**这是错的**。
 *    查证腾讯云官方文档：
 *      · 云函数 timeout 默认值确实是 3 秒
 *      · 但 timeout **可调至 1~900 秒**，调高后客户端会等函数执行完
 *      · -504003 报错里的 "3 seconds" 指的是**你云函数自己的 timeout**，
 *        不是平台硬限制
 *      · 另有一个已知坑：云函数配置只对 $LATEST 生效，
 *        若调用落到已发布版本，调timeout 不起作用
 *
 *    官方 FAQ 建议的长耗时方案是：调大 timeout + 函数内 callback() 提前返回
 *    + 结果写库/客户端轮询。
 *
 * ## 那为什么还是按保守值配
 *
 * 真机上实测仍是 -504003（3 秒），说明**当前 timeout 配置没生效**
 * （bill-svc/config.json 写的是 25，实际按 3 秒执行）。
 * 在这个问题定位清楚之前，代码侧必须假设「只有 3 秒可用」：
 *   · 单次 LLM 上限 2200ms
 *   · 不重试（LLM_RETRY_LIMIT = 0）
 *   · 超时立刻走规则降级，由规则层保证一定有结果
 *
 * 代价：LLM 超时会更多落到「规则分类」，置信度偏保守，更多弹确认框。
 * 这是刻意的——**宁可让用户多点一次，也不能让请求失败**。
 *
 * 待办：确认 timeout 为何未生效（大概率需在云开发控制台改并重新部署，
 * 或调用的是已发布版本而非 $LATEST）。生效后可把
 * LLM_TIMEOUT_MS 恢复到 5000~8000、LLM_RETRY_LIMIT 恢复到 1~2。
 */
const GUARDRAIL = {
  MAX_AMOUNT_YUAN: 50000,        // 单笔上限，超出强制人工确认
  MAX_DAILY_REMINDER: 2,         // 全天提醒上限
  MAX_LEAK_PROMPT_PER_DAY: 1,    // 单日补记提示上限
  LLM_RETRY_LIMIT: 0,            // ⚠ 在 timeout 问题定位前不重试（原 2）
  LLM_TIMEOUT_MS: 2200,          // ⚠ 单次调用上限 2.2 秒（原 5000）
  MAX_INPUT_TOKENS: 1200,        // 单次输入 Token 预算
  /**
   * 消费分析专用预算 —— 与记账主链路分开
   *
   * 为什么可以放宽：记账要求端到端 ≤2.5s，因为用户在录音后立刻等结果；
   * 而消费分析是「打开分析页主动去看」的场景，多等几秒完全无感。
   *
   * v3 实测教训（2026-10-24 线上 trace）：
   * 总预算 10s ÷ 4 轮 = 每轮 2500ms，对 function-calling 太紧——
   * 最终成文轮要输出大 JSON 且上下文含账单明细，DeepSeek 响应轻松超 2.5s，
   * 导致每轮必超时 → 永远走降级。
   * 现在给到 20s（每轮 5000ms）：云函数 timeout 40s、前端等待 40s，
   * 扣除数据库查询与冷启动约 5s 仍有余量。
   */
  ANALYSIS_LLM_TIMEOUT_MS: 20000,
  ANALYSIS_MAX_TOOL_ROUNDS: 4
};

/** 缓存 TTL（秒） */
const CACHE_TTL = {
  CATEGORY_MATCH: 86400,   // 分类语义映射 24h
  ANALYSIS: 86400,         // 分析结果至次日
  RECALL_HELPER: 43200     // 补记候选 12h
};

/** 成本保护：单用户日Token 预算 */
const TOKEN_BUDGET_PER_USER_DAY = 200000;

/** 补记有效期（天） */
const RECALL_VALID_DAYS = 90;

/**
 * 云函数代码版本戳 —— 排查「本地改了、云端没生效」的唯一依据
 *
 * ## 为什么需要它
 *
 * 微信云函数部署后，「跑的是哪份代码」完全不可见：日志里不会打版本号，
 * 开发者工具也不会提示"上传的是 20 分钟前的版本"。
 * 于是「未知操作: diag」这类问题只能靠猜——是代码没写、还是没上传？
 * 每次猜错都要来回好几轮，而每轮都在等用户操作，反馈周期极长。
 *
 * 有版本戳后：云函数每次响应都带上云端版本，
 * 与本地 constants.js 里的版本一比，立刻知道同步没同步。
 *
 * ## 规则
 *
 * **每次改动 cloudfunctions/ 下的代码，都要把版本号 +1。**
 * preflight 会校验它是否同步递增，不改就当没改过。
 *
 * 版本号格式：`YYYYMMDD-NN`，NN 为当天第几次改动。
 */
const CODE_VERSION = '20261108-01';

module.exports = {
  CONFIDENCE,
  BILL_SOURCE,
  ACCOUNT_TYPE,
  TIME_TYPE,
  UNKNOWN_CATEGORY_ID,
  COLLECTIONS,
  LEDGER,
  FAMILY,
  LEAK_SIGNAL,
  DAY_MS,
  GUARDRAIL,
  CACHE_TTL,
  TOKEN_BUDGET_PER_USER_DAY,
  RECALL_VALID_DAYS,
  CODE_VERSION
};