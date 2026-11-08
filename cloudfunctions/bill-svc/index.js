/**
 * 记账主链路云函数 —— 技术文档 §5.1
 *
 * 三条入口：
 *   record  语音记账入账
 *   recall  事后补记
 *   amend   编辑/撤销
 *   manual  手动直填入账（金额 + 类目 + 备注，跳过 LLM）
 *
 * 处理流程（record）：
 *   1. 参数校验
 *   2. 规则层解析（asr-parse）→ ruleParsed，作为置信度基准
 *   3. 三通道分类（category-match）
 *   4. Harness 调用 bill-parse agent（LLM 补齐语义）
 *   5. 置信度融合 → 三档决策
 *   6. 按档处理：高置信直接落库 / 中低置信返回候选
 */

const path = require('path');

/**
 * 加载 shared 共享层
 *
 * 候选路径按「云端可达性」排序，不按本地方便程度排序：
 *   1. `<云函数目录>/shared/`            ← 云端唯一可靠来源，随函数打包上传
 *   2. `process.cwd()/node_modules/shared` ← 本地快路径；选「云端安装依赖」时云端不存在
 *   3. `<云函数目录>/../shared/`          ← 仓库根的shared，是平级兄弟目录，
 *                                          **不在单函数打包范围内，云端找不到**
 *
 * 历史踩坑：只靠 2+3 两条，本地测试全绿、云端必报
 * `Cannot find module '/var/shared/rules/asr-parse'`——
 * 因为手工塞进 node_modules 的东西，「云端安装依赖」时开发者工具不会上传。
 * 记住：本地全绿≠ 云端能跑。
 */
function loadShared(modulePath) {
  const tried = [
    path.join(__dirname, 'shared', modulePath),
    path.join(process.cwd(), 'node_modules/shared', modulePath),
    path.join(__dirname, '..', 'shared', modulePath)
  ];

  for (const p of tried) {
    try {
      return require(p);
    } catch (e) {
      // 只吞「模块找不到」，其他错误（语法错误等）必须暴露出来
      if (e.code !== 'MODULE_NOT_FOUND') throw e;
    }
  }

  throw new Error(
    `找不到共享模块 shared/${modulePath}。已尝试以下路径：\n` +
    tried.map((p) => `  - ${p}`).join('\n') +
    `\n请在项目根目录执行 npm run prepare:cf（它会把 shared 复制进各云函数的 shared/ 子目录），` +
    `然后在开发者工具重新「上传并部署：云端安装依赖」。`
  );
}

const asrRules = loadShared('rules/asr-parse');
const matcher = loadShared('rules/category-match');
const money = loadShared('util/money');
const preset = loadShared('util/category-preset');
const harness = loadShared('agent-harness');
const tracer = loadShared('agent-harness/tracer');
const db = loadShared('db');
const billParseAgent = loadShared('agent-harness/agents/bill-parse.agent');
const noteSummary = loadShared('util/note-summary');
const { BILL_SOURCE, CONFIDENCE, COLLECTIONS, CODE_VERSION, ACCOUNT_TYPE } = loadShared('util/constants');
const dateUtil = loadShared('util/date');
const recurring = loadShared('util/recurring');

/** 单笔金额上限（分）—— 与护栏层 GUARDRAIL.MAX_AMOUNT_YUAN 保持一致 */
const GUARDRAIL_MAX_AMOUNT_CENT = 50000 * 100;
/** 账户未指定时的占位值 */
const ACCOUNT_UNKNOWN = 'unknown';

// 冷启动时注册一次即可
harness.registerAgent(billParseAgent.name, billParseAgent);

/**
 * 解析类目的 path
 *
 * ## 为什么以 id 为准，而不是直接信前端传的 path
 *
 * 前端能拿到完整 path，但**不能完全信任它**：
 * 传错了就会写入一个与 categoryId 不匹配的 path，
 * 而统计侧完全按 path 分组 → 数据自相矛盾且极难排查。
 *
 * 策略：
 *   1. 预置类目 → 一律按 id 反查，忽略前端传的 path（前端传错也无所谓）
 *   2. 自定义类目（不在预置库里）→ 只能信前端传的 path，但必须校验格式非空
 *   3. 两者都拿不到 → 返回空串，调用方应拒绝写入
 *
 * @param {string} categoryId
 * @param {string} [categoryPath] 前端传来的 path（仅自定义类目用）
 * @returns {string} path，取不到返回空串
 */
function resolveCategoryPath(categoryId, categoryPath) {
  const presetPath = preset.pathOf(categoryId);
  if (presetPath) return presetPath;

  // 自定义类目：预置库里没有，只能信前端传的
  const p = String(categoryPath || '').trim();
  if (p) return p;

  // 完全无从确定 → 空串，调用方据此拒绝
  return '';
}

/**
 * 云函数入口
 *
 * 无论成功失败都往返回值里塞 codeVersion：
 * 本地改了代码但忘了部署，是这个项目最高频的坑，
 * 而日志里看不出来。有了版本号，前端和用户一眼就能判断云端是不是最新版。
 */
exports.main = async (event, context) => {
  // 入口全量日志：0:30 到底收到定时器事件还是保活空事件，下一趟日志一眼可分。
  // 只打结构与标识字段，不打业务 payload（语音文本等敏感内容不进日志）。
  console.log('[bill-svc] 入口收到调用:', summarizeEvent(event));
  const { action, payload } = normalizeEvent(event || {});
  const res = await dispatch(action, payload, context);
  if (res && typeof res === 'object') {
    res.codeVersion = CODE_VERSION;
    // diag 之外也带上，方便前端全局比对而不必单独调一次诊断
    if (action === 'diag') res.sdkAvailable = db.isAvailable();
  }
  return res;
};

/**
 * 入口日志的事件摘要
 *
 * 为什么要有它：0:30 的「未知操作: undefined」到底是定时器事件没被归一、
 * 还是平台保活发的空事件，旧日志完全看不出（tcb_log 是空的）。
 * 打全量结构后，下一次 0:30 一眼就能区分：
 *   · Type=Timer 在 keys 里 → 是定时器事件，问题在归一之后
 *   · keys 为空 → 是平台空事件（保活），与定时器无关
 *
 * 业务 payload 不进日志；只有未知形态（既非 Timer 也无 action）才打原始内容，
 * 且截断防超长。
 */
/**
 * 判「是不是定时触发器事件」—— 大小写不敏感
 *
 * **2026-11-08 00:30 云端日志实测**（请求 860de654）：平台实际下发的
 * event 是 `Type:'timer'`（**小写 t**，官方文档写的是大写 `'Timer'`），
 * 且额外带 `tcbContext` / `userInfo` 字段：
 *   { Message:'', Time:'2026-11-07T16:30:00Z', TriggerName:'dailyRecurring',
 *     Type:'timer', tcbContext:0, userInfo:{ appId:'...' } }
 *
 * 此前判据写死 `Type === 'Timer'`（大写）→ 云端真实事件**永不命中** →
 * action=undefined → 「未知操作: undefined」→ 重复记账每天静默不生成，
 * 而测试按文档大写构造 → 本地全绿 ≠ 云端能跑。
 * 所以这里大小写都认，测试两侧形状都覆盖（2026-11-08 修复）。
 */
function isTimerEvent(event) {
  return !!event &&
    typeof event.Type === 'string' &&
    event.Type.toLowerCase() === 'timer';
}

function summarizeEvent(event) {
  if (!event) return 'event 为空';
  if (typeof event !== 'object') {
    return `event 非对象（typeof=${typeof event}）：${String(event).slice(0, 200)}`;
  }
  const keys = Object.keys(event).join(',') || '(无键)';
  const base = `keys=[${keys}] action=${JSON.stringify(event.action)} ` +
    `Type=${JSON.stringify(event.Type)} TriggerName=${JSON.stringify(event.TriggerName)}`;
  if (isTimerEvent(event) || typeof event.action === 'string') return base;
  return `${base} raw=${JSON.stringify(event).slice(0, 500)}`;
}

/**
 * 事件归一 —— 让定时触发器能进到 dailyRecurring
 *
 * 定时触发器下发的 event **没有 action 字段**，直接解构会落
 * 「未知操作: undefined」。这是本项目真实踩过的坑（analysis-svc 的
 * dailyInsight 曾因此每天静默不执行，2026-10-31 修复，
 * 见 docs/wiki/engineering/20-pitfalls.md §19）。
 *
 * 认什么特征：`Type` 作主判据（**大小写不敏感**，见 isTimerEvent），
 * `TriggerName` 交叉校验。
 *
 * ⚠️ 2026-11-08 00:30 云端日志实测：平台实际下发 `Type:'timer'`
 * （**小写 t**，官方文档写大写 `'Timer'`），此前写死大写判据 →
 * 云端真实事件永不命中，重复记账每天静默不生成 ——
 * 本地全绿 ≠ 云端能跑（这是本项目最高频的故障模式）。
 *
 * ⚠ Type/TriggerName 都只是 event 字段、可被前端伪造 —— 真正的
 * 越权防线在 handleDailyRecurring 里的 `SOURCE === 'wx_trigger'` 校验，
 * 外部无法伪造 SOURCE。
 */
function normalizeEvent(event) {
  if (isTimerEvent(event)) {
    const name = String(event.TriggerName || '');
    if (name && name !== 'dailyRecurring') {
      console.warn(`[bill-svc] 未知定时触发器：${name}`);
      return { action: '__unknown_timer__', payload: {} };
    }
    console.log('[bill-svc] 定时触发器已命中 → dailyRecurring');
    return {
      action: 'dailyRecurring',
      payload: { triggeredAt: parseTriggerTime(event.Time) }
    };
  }
  return { action: event.action, payload: event.payload || {} };
}

/**
 * 解析定时触发器的触发时刻
 * 官方 event 的 `Time` 是 ISO 字符串（UTC）。解析失败返回 null →
 * 调用方回落到 Date.now()。
 */
function parseTriggerTime(time) {
  if (!time) return null;
  const ts = Date.parse(time);
  return Number.isFinite(ts) ? ts : null;
}

async function dispatch(action, payload, context) {
  try {
    switch (action) {
      case 'record':
        return await handleRecord(payload, context);
      case 'recall':
        return await handleRecall(payload, context);
      case 'amend':
        return await handleAmend(payload, context);
      case 'manual':
        return await handleManual(payload, context);
      case 'ruleCreate':
        return await handleRuleCreate(payload, context);
      case 'ruleList':
        return await handleRuleList(payload, context);
      case 'ruleUpdate':
        return await handleRuleUpdate(payload, context);
      case 'rulePause':
        return await handleRulePause(payload, context);
      case 'ruleDelete':
        return await handleRuleDelete(payload, context);
      case 'dailyRecurring':
        return await handleDailyRecurring(payload, context);
      case 'diag':
        return await handleDiag(payload, context);
      default:
        // 常见误判来源：本地已加分支但云端还是旧版本。
        // 这时给出可执行动作，避免用户对着「未知操作」干瞪眼。
        return { ok: false, error: `未知操作: ${action}`, hint: buildUnknownActionHint(action) };
    }
  } catch (e) {
    return { ok: false, error: e.message, stack: e.stack };
  }
}

/** 本地已支持、云端旧版本可能尚未包含的 action */
const KNOWN_ACTIONS = [
  'record', 'recall', 'amend', 'manual', 'diag',
  'ruleCreate', 'ruleList', 'ruleUpdate', 'rulePause', 'ruleDelete', 'dailyRecurring'
];

/**
 * 「未知操作」的归因提示
 *
 * 为什么需要它：报「未知操作」时，真实原因九成是云端函数版本落后于本地，
 * 而裸看这句话完全推不出来是部署问题还是参数拼错。
 */
function buildUnknownActionHint(action) {
  if (typeof action !== 'string' || !action) {
    return `缺少 action 字段。请以 { action: 'record', payload: {...} } 的结构调用。`;
  }
  if (KNOWN_ACTIONS.includes(action)) {
    return `本地代码已支持 action="${action}"，说明云端 bill-svc 还是旧版本。` +
      `请右键 cloudfunctions/bill-svc →「上传并部署：云端安装依赖」重新部署后重试。`;
  }
  return `本地 bill-svc 支持的 action 为：${KNOWN_ACTIONS.join(' / ')}。请检查调用方传入的 action 是否拼写错误。`;
}

/**
 * 语音记账
 */
async function handleRecord(payload, context) {
  const { asrText, asrConfidence, recordTs } = payload || {};

  if (!asrText || typeof asrText !== 'string') {
    return { ok: false, error: '缺少 asrText' };
  }

  // 账本归属：缺省走个人路径零新增查询；family 反查 profile 并校验成员
  const ledgerTarget = await resolveLedger(payload, context);
  const userId = getUserId(context);
  const now = recordTs || Date.now();

  // 1. 规则层解析 —— 置信度融合的基准，且在 LLM 不可用时独立可用
  const ruleParsed = asrRules.parse(asrText, now);

  // 2. 用户自定义类目 —— 「类目不匹配可自主新增」的下一环：
  //    建过之后，同样的说法下次要能直接命中（读失败降级为空，不拖垮主链路）
  const customCategories = db.isAvailable()
    ? await db.listCustomCategories(userId)
    : [];

  // 3. 三通道分类（自定义类目与预置末级同权参与关键词通道）
  const ruleCat = matcher.classify(asrText, ruleParsed.amount || 0, [], customCategories);

  // 4-6. Harness 调用 + 置信度融合
  const harnessResult = await harness.invoke({
    agent: 'bill-parse',
    input: asrText,
    options: {
      ruleParsed,
      ruleCategoryId: ruleCat.topCategoryId,
      ruleCategoryCandidates: ruleCat.candidates,
      userId,
      llmEnabled: isLLMEnabled(),
      costContext: { usedTokens: 0, dailyBudget: Number(process.env.TOKEN_DAILY_BUDGET || 200000) }
    }
  });

  // 合并结果：LLM 数据优先，缺失字段回落到规则层
  const finalData = mergeParseResult(harnessResult.data, ruleParsed, ruleCat, asrText);

  // 7. 按置信度分档决策
  let decision;
  let strongRuleApplied = false;
  let customRuleApplied = false;

  if (harnessResult.isFallback) {
    // 兜底路径：置信度按规则层结果给一个保守值（技术文档 §4.3 L2 降级）
    const fallbackConfidence = computeFallbackConfidence(ruleCat, asrConfidence);
    //
    // ⚠ 必须走 loadShared，不能直接 require 拼 __dirname 路径。
    // 云函数运行时 __dirname = /var/user，此时 __dirname/../shared 指向 /var/shared，
    // 该目录不存在 → Cannot find module。而本地 __dirname = cloudfunctions/bill-svc，
    // ../shared 恰好命中 cloudfunctions/shared，
    // 所以**这个 bug 本地永远测不出来，只有上云才炸**（已真实踩到过）。
    decision = loadShared('agent-harness/confidence').decide(
      fallbackConfidence,
      ruleCat.candidates
    );
  } else {
    decision = harnessResult.decision;

    // 强规则优先 —— 这是「规则层作地基」最核心的一环，不能只靠扣分体现。
    //
    // 背景：置信度公式里模型与规则冲突会扣 0.3，但那只影响「是否自动入账」，
    // **不会改变展示的候选**。实测真实链路出现严重语义错误：
    //   「打车去医院 45」→ 规则判医疗（priority=10），模型判交通
    //   → 结果展示的是交通，医院打车被记成普通通勤
    // 这类「场景决定领域归属」的判断是产品的核心诉求（PRD明确要求
    // 大交通归入出游、出租车就医归医疗），必须由规则强制置顶，
    // 模型只能补充候选、不能推翻。
    const strongTop = getStrongRuleCandidate(ruleCat);
    if (strongTop && decision.candidates[0] && decision.candidates[0].categoryId !== strongTop.categoryId) {
      const modelTop = decision.candidates[0];
      strongRuleApplied = true;
      tracer.logEvent(harnessResult.traceId || 'no-trace', 'strong_rule_override', {
        text: asrText,
        modelCategoryId: modelTop.categoryId,
        ruleCategoryId: strongTop.categoryId
      });

      // 强规则置顶，模型候选降级为备选（保留用户改选的能力）
      const modelRest = decision.candidates.filter(
        (c) => c.categoryId !== strongTop.categoryId
      );
      const merged = [strongTop, ...modelRest].slice(0, 4);

      decision = {
        ...decision,
        candidates: merged,
        // 冲突意味着模型没能理解规则层判断，必须让用户确认
        tier: 'mid',
        action: 'ASK_CONFIRM',
        status: 'needConfirm',
        ui: '已按场景规则归类，请确认'
      };
    }

    // 自定义类目置顶 —— 用户亲手建的类目在关键词通道命中了 Top1。
    //
    // 为什么必须置顶：LLM 的合法 ID 清单只含预置类目（防幻觉），
    // 它永远给不出用户的私有类目；但这句话正是用户当初为它建条目的说法，
    // 模型给的任何预置候选都只能是「近似但不对」的答案。
    //
    // 为什么只置顶不自动入账：关键词是子串匹配，存在
    // 自定义「美容」误吃「汽车美容」这类误命中，一次确认挡得住。
    const customTop = ruleCat.candidates[0];
    if (
      !strongRuleApplied &&
      customTop && customTop.custom &&
      decision.candidates[0] &&
      decision.candidates[0].categoryId !== customTop.categoryId &&
      !decision.candidates.some((c) => c.categoryId === customTop.categoryId)
    ) {
      customRuleApplied = true;
      tracer.logEvent(harnessResult.traceId || 'no-trace', 'custom_category_override', {
        text: asrText,
        modelCategoryId: decision.candidates[0].categoryId,
        customCategoryId: customTop.categoryId
      });

      decision = {
        ...decision,
        candidates: [customTop, ...decision.candidates].slice(0, 4),
        tier: 'mid',
        action: 'ASK_CONFIRM',
        status: 'needConfirm',
        ui: '已按你的自定义类目归类，请确认'
      };
    }
  }

  // 模糊金额保护（设计文档 §4.3.1）：
  // 「四十来块」这类表达不能返回一个确定金额，否则用户会误以为系统已确定。
  //
  // 这里要区分两种「不确定」：
  //   · 金额不明确 + 有类目候选 → 走 needConfirm，让用户先确认金额
  //   · 金额不明确 + 无类目候选 → 同样走 needConfirm，因为此时用户的第一
  //     动作一定是「把金额填对」，而不是去 166 个类目里翻找
  // 所以模糊金额一律强制 needConfirm，不低于类目确认。
  const amountIsVague = finalData.amountCertain === false;
  if (amountIsVague && decision.action !== 'ASK_CONFIRM') {
    decision = {
      ...decision,
      action: 'ASK_CONFIRM',
      status: 'needConfirm',
      tier: 'mid',
      ui: decision.candidates && decision.candidates.length
        ? '金额不明确，请确认金额'
        : '金额不明确，请直接填写金额并选择类目',
      amountFirst: true
    };
  }

  let finalConfidence = harnessResult.isFallback
    ? computeFallbackConfidence(ruleCat, asrConfidence)
    : harnessResult.confidence;

  // 强规则 / 自定义类目置顶时，置信度按「模型未能理解规则」处理：
  // 展示的类目来自规则而非模型，此时若仍报高置信就是在替模型背书。
  if (strongRuleApplied || customRuleApplied) {
    finalConfidence = Math.min(finalConfidence, CONFIDENCE.HIGH - 0.01);
  }

  const response = {
    ok: true,
    status: decision.status,
    action: decision.action,
    ui: decision.ui,
    confidence: finalConfidence,
    tier: decision.tier,
    isFallback: harnessResult.isFallback,
    fallbackReason: harnessResult.fallbackReason || null,
    strongRuleApplied,
    customRuleApplied,
    prefill: {
      amountCent: money.yuanToCent(finalData.amount),
      amountYuan: finalData.amount,
      amountCertain: finalData.amountCertain,
      date: finalData.date,
      account: finalData.account,
      scene: finalData.scene,
      splitCount: finalData.splitCount,
      // 备注摘要：用户确认类目时要用它落库，而不是原始口述全文
      note: finalData.note,
      asrText
    },
    candidates: decision.candidates.map((c) => ({
      categoryId: c.categoryId,
      categoryName: c.categoryName || (c.categoryPath || '').split('/').pop(),
      categoryPath: c.categoryPath,
      score: c.score,
      color: c.color,
      custom: !!c.custom
    })),
    reasoning: finalData.reasoning || ''
  };

  // 高置信度：直接落库
  if (decision.action === 'AUTO_SAVE') {
    const top = decision.candidates[0];
    if (!top || !top.categoryId) {
      // 无候选时不能自动入账，降级为确认
      response.status = 'needConfirm';
      response.action = 'ASK_CONFIRM';
      return response;
    }

    const bill = buildBill({
      userId,
      amountCent: response.prefill.amountCent,
      categoryId: top.categoryId,
      categoryPath: top.categoryPath,
      date: finalData.date,
      account: finalData.account,
      // 备注用总结后的一句话，不是 scene。
      // ⚠️ 早期这里写的是 finalData.scene —— scene 是「场景线索」，
      //    兜底路径下还是英文代码（friends/unit），写进账单用户根本看不懂。
      note: finalData.note,
      source: BILL_SOURCE.VOICE,
      confidence: response.confidence,
      agent: 'bill-parse',
      isFallback: harnessResult.isFallback,
      recordTs: now
    });

    // 写入数据库。
    //
    // 本地调试/单元测试环境没有 cloud 全局对象，此时跳过落库但**照常返回结果**——
    // 否则本地跑测试会永远因为"没数据库"而失败，把真实的逻辑问题淹没掉。
    // 真机上 db.isAvailable() 恒为 true，走实际写入。
    if (!db.isAvailable()) {
      response.bill = bill;
      response.saved = false;
      response.savedError = '本地环境未接入数据库，已跳过写入';
      console.warn('[bill-svc] 跳过落库：非云函数环境');
    } else {
      // 关键设计：**写库失败绝不能静默**，也不能把已判定的结果丢掉——
      // 用户已经听到"记好了"的反馈，突然不出现会非常困惑。
      // 因此这里返回 saved=false + savedError，让前端明确提示
      // "记账未保存，请检查网络后重试"，而不是假装成功。
      try {
        const saved = ledgerTarget.kind === 'family'
          ? await db.insertFamilyBill(ledgerTarget.familyId, bill, context)
          : await db.insertBill(bill, context);
        response.bill = saved;
        response.saved = true;
      } catch (e) {
        console.error('[bill-svc] 落库失败', e);
        response.bill = bill;
        response.saved = false;
        response.savedError = e.message || '写入失败';
        // 落库失败时降级为需确认，让用户知道这笔记账还没成立
        response.status = 'needConfirm';
        response.action = 'ASK_CONFIRM';
        response.ui = '记账未保存，请检查网络后重试';
      }
    }
    response.undoWindowMs = 5000;
  }

  return response;
}

/**
 * 事后补记（对应痛点 P6）
 * 关键原则：补记一律给候选，绝不自动入账（设计文档 §4.3.1）
 */
async function handleRecall(payload, context) {
  const { date, candidates, chosenIndex } = payload || {};
  const userId = getUserId(context);

  if (!date || !Array.isArray(candidates)) {
    return { ok: false, error: '缺少 date 或 candidates' };
  }

  // 账本归属（个人路径零新增查询，见 resolveLedger 铁律）
  const ledgerTarget = await resolveLedger(payload, context);

  const idx = typeof chosenIndex === 'number' ? chosenIndex : 0;
  const chosen = candidates[idx];
  if (!chosen) return { ok: false, error: '候选索引越界' };

  const now = Date.now();
  const daysLater = Math.max(0, Math.round((now - new Date(`${date}T00:00:00`).getTime()) / 86400000));

  const bill = buildBill({
    userId,
    amountCent: chosen.amountCent,
    categoryId: chosen.categoryId,
    categoryPath: chosen.categoryPath,
    date,
    account: chosen.account || 'unknown',
    note: chosen.note || '',
    source: BILL_SOURCE.RECALL,
    confidence: chosen.confidence || 0.7,
    agent: 'recall-helper',
    recordTs: now,
    recallDaysLater: daysLater
  });

  if (!db.isAvailable()) {
    console.warn('[bill-svc] 跳过补记落库：非云函数环境');
    return { ok: true, bill, saved: false, savedError: '本地环境未接入数据库' };
  }

  try {
    const saved = ledgerTarget.kind === 'family'
      ? await db.insertFamilyBill(ledgerTarget.familyId, bill, context)
      : await db.insertBill(bill, context);
    return { ok: true, bill: saved, saved: true };
  } catch (e) {
    console.error('[bill-svc] 补记落库失败', e);
    return { ok: false, error: `补记保存失败：${e.message}`, saved: false, bill };
  }
}

/**
 * 编辑 / 撤销
 *
 * ## 可编辑字段的边界
 *
 * 用户能改的是**账目本身的属性**：金额、类目、日期、备注、账户。
 * 不能改的是**系统元数据**：userId、source、isRecall、confidence、
 * aiMeta、createTime —— 那些记录的是「这笔账怎么来的」，
 * 改了会让统计口径和埋点指标失真。
 *
 * ## ⚠️ categoryId 与 categoryPath 必须成对更新（实测踩过）
 *
 * 统计侧（bill-stats.js）**完全依赖 categoryPath** 做分组：
 *   top    = categoryPath.split('/')[0]   ← 占比、刚性判定
 *   leaf   = categoryPath.split('/').pop() ← 末级类目分组
 *   second = categoryPath.split('/')[1]   ← 餐饮的「在家吃饭/外出就餐」
 *
 * 而早期版本的 amend 只更新 categoryId、不动 categoryPath。
 * 后果：界面上类目名还是旧的（明细页显示 path），
 * 统计也按旧类目算 —— 但用户明明已经改了类目。
 * **两个字段必须一起写，否则数据自相矛盾。**
 */
async function handleAmend(payload, context) {
  const { billId, amountCent, categoryId, categoryPath, date, note, account, delFlag } = payload || {};
  if (!billId) return { ok: false, error: '缺少 billId' };

  // 账本归属（个人路径零新增查询，见 resolveLedger 铁律）
  const ledgerTarget = await resolveLedger(payload, context);

  // 撤销：软删除而非物理删除，
  // 因为用户可能在 5 秒撤销窗口内反悔，且保留记录便于排查账目争议
  if (delFlag) {
    if (!db.isAvailable()) {
      return { ok: true, billId, deleted: true, saved: false, savedError: '本地环境未接入数据库' };
    }
    const openid = db.currentOpenId(context);
    if (!openid) return { ok: false, error: '无法获取用户身份' };
    try {
      const updated = ledgerTarget.kind === 'family'
        ? await db.softDeleteFamilyBill(openid, ledgerTarget.familyId, billId)
        : await db.softDelete(openid, billId);
      // 与编辑分支同口径（stats.updated === 0 即拒绝）：
      // where 没命中 = 非记录人 / 记录不存在 / 已删除，必须明确拒绝。
      // 回 ok:true 会让前端弹「已删除」但账单还在 —— 静默失效。
      if (updated === 0) {
        return {
          ok: false,
          error: ledgerTarget.kind === 'family' ? '只能删除自己记的账' : '未找到该记录或已删除'
        };
      }
      return { ok: true, billId, deleted: true, updated };
    } catch (e) {
      return { ok: false, error: `撤销失败：${e.message}` };
    }
  }

  // ── 参数校验 ──
  // 与 handleManual 同口径：宁可报错也不要写一条脏数据进库。
  // 早期 amend 完全没有校验，负数金额、0 元、超大金额都能直接写进去。
  //
  // ⚠️ 校验必须在「本地环境跳过落库」的早退**之前**：
  // 否则本地跑测试时全部走早退分支，校验逻辑一次都没被执行过 ——
  // 测试全绿但校验其实没生效，正是本项目反复踩的那类坑。
  const updateData = { updateTime: Date.now() };

  if (amountCent !== undefined && amountCent !== null) {
    if (typeof amountCent !== 'number' || !isFinite(amountCent) || amountCent <= 0) {
      return { ok: false, error: '金额无效，请输入大于 0 的金额' };
    }
    if (Math.round(amountCent) !== amountCent) {
      return { ok: false, error: '金额精度错误，请使用整数分' };
    }
    if (amountCent > GUARDRAIL_MAX_AMOUNT_CENT) {
      return { ok: false, error: '单笔金额超出上限，请检查输入' };
    }
    updateData.amount = Math.round(amountCent);
  }

  // 类目：两个字段必须成对。缺 path 时从 id 反查补齐，
  // 补不上就报错——宁可让用户重选一次，也不要写出自相矛盾的数据。
  if (categoryId) {
    const path = resolveCategoryPath(categoryId, categoryPath);
    if (!path) {
      return { ok: false, error: '类目不存在，请重新选择' };
    }
    updateData.categoryId = categoryId;
    updateData.categoryPath = path;
  } else if (categoryPath) {
    // 只给了 path 没给 id：无法确定唯一类目，拒绝
    return { ok: false, error: '缺少类目 id，请重新选择类目' };
  }

  if (date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return { ok: false, error: '日期格式错误，应为 YYYY-MM-DD' };
    }
    // 未来日期一定是误操作（家庭记账不会记还没发生的消费）
    if (date > todayStr()) {
      return { ok: false, error: '不能记入未来的日期' };
    }
    updateData.date = date;
  }

  // 备注允许清空（note !== undefined 即视为「用户主动改过」）
  if (note !== undefined) {
    if (typeof note !== 'string') {
      return { ok: false, error: '备注格式错误' };
    }
    if (note.length > 200) {
      return { ok: false, error: '备注过长，请控制在 200 字以内' };
    }
    updateData.note = note;
  }

  // 账户：只接受已知枚举
  if (account !== undefined && account !== null) {
    const valid = Object.keys(ACCOUNT_TYPE).map((k) => ACCOUNT_TYPE[k]);
    if (!valid.includes(account)) {
      return { ok: false, error: '账户类型无效' };
    }
    updateData.account = account;
  }

  // 一个字段都没改：直接回成功，不要白跑一次数据库写入
  if (Object.keys(updateData).length === 1) {
    return { ok: true, billId, updates: {}, saved: true, unchanged: true };
  }

  // 本地环境跳过落库，但仍返回待更新字段供上层确认
  if (!db.isAvailable()) {
    return {
      ok: true,
      billId,
      updates: updateData,
      saved: false,
      savedError: '本地环境未接入数据库'
    };
  }

  const openid = db.currentOpenId(context);
  if (!openid) return { ok: false, error: '无法获取用户身份' };

  try {
    // 家庭账本切 family_bills 集合、where 额外带 familyId；
    // 两处 where 都带 userId —— 成员只能改自己记的账（与撤销同口径）
    const collection = ledgerTarget.kind === 'family'
      ? COLLECTIONS.FAMILY_BILLS : COLLECTIONS.BILLS;
    const where = ledgerTarget.kind === 'family'
      ? { _id: billId, userId: openid, familyId: ledgerTarget.familyId }
      : { _id: billId, userId: openid };

    const res = await db.getDb().collection(collection)
      .where(where)
      .update({ data: updateData });

    if (!res.stats.updated) {
      return { ok: false, error: '未找到该记录或无权修改' };
    }
    return { ok: true, billId, updates: updateData, saved: true };
  } catch (e) {
    return { ok: false, error: `修改失败：${e.message}` };
  }
}

/**
 * 手动直填入账（金额 + 类目 + 备注）
 *
 * 为什么单独一个入口而不是复用 recall：
 * 1. **语义不同**。recall 是「事后补记」，会打 isRecall 标记并记录补记天数；
 *    用户主动手动记账不是补记，混用会污染「补记转化率 ≤35%」这条埋点指标，
 *    也会让明细页的「补记」标记出错。
 * 2. **不经过 LLM**。用户已经明确给出类目和金额，再调一次模型纯属浪费 token
 *    和 1.4 秒延迟，且模型有可能把用户已选定的类目改回去。
 * 3. **置信度天然为 1**。人工录入不存在「不确定」，不该再走三档分档。
 *
 * 参数校验从严：金额与类目缺一不可，宁可报错也不要写一条脏数据进库。
 */
async function handleManual(payload, context) {
  const { amountCent, categoryId, categoryPath, date, note, account } = payload || {};

  // 金额校验：必须是正整数分。浮点数进来一律拒绝，避免 68.5*100=6849.99…
  if (typeof amountCent !== 'number' || !isFinite(amountCent) || amountCent <= 0) {
    return { ok: false, error: '金额无效，请输入大于 0 的金额' };
  }
  if (Math.round(amountCent) !== amountCent) {
    return { ok: false, error: '金额精度错误，请使用整数分' };
  }
  if (amountCent > GUARDRAIL_MAX_AMOUNT_CENT) {
    return { ok: false, error: '单笔金额超出上限，请检查输入' };
  }
  if (!categoryId) {
    return { ok: false, error: '请选择类目' };
  }

  // 账本归属（个人路径零新增查询，见 resolveLedger 铁律）
  const ledgerTarget = await resolveLedger(payload, context);
  const userId = getUserId(context);
  const billDate = date || todayStr();
  const now = Date.now();

  const bill = buildBill({
    userId,
    amountCent,
    categoryId,
    categoryPath: categoryPath || '',
    date: billDate,
    account: account || ACCOUNT_UNKNOWN,
    note: note || '',
    source: BILL_SOURCE.MANUAL,
    confidence: 1,
    agent: 'manual-entry',
    recordTs: now
  });

  if (!db.isAvailable()) {
    console.warn('[bill-svc] 跳过手动落库：非云函数环境');
    return { ok: true, bill, saved: false, savedError: '本地环境未接入数据库' };
  }

  try {
    const saved = ledgerTarget.kind === 'family'
      ? await db.insertFamilyBill(ledgerTarget.familyId, bill, context)
      : await db.insertBill(bill, context);
    return {
      ok: true,
      status: 'saved',
      action: 'AUTO_SAVE',
      saved: true,
      bill: saved,
      confidence: 1,
      prefill: {
        amountCent,
        amountYuan: money.centToYuan(amountCent),
        amountCertain: true,
        date: billDate
      },
      candidates: [
        {
          categoryId,
          categoryName: (categoryPath || '').split('/').pop() || categoryId,
          categoryPath: categoryPath || '',
          score: 1,
          color: colorOfCategory(categoryId)
        }
      ]
    };
  } catch (e) {
    console.error('[bill-svc] 手动落库失败', e);
    return { ok: false, error: `保存失败：${e.message}`, saved: false, bill };
  }
}

/**
 * 数据库诊断
 *
 * 为什么需要它：「数据没写入」这个现象有五种完全不同的原因
 * （集合没建/权限不对/环境 ID 不匹配/云函数连错环境/字段有问题），
 * 靠猜至少要来回试五轮。这里一次性把每种原因都验一遍，
 * 直接告诉调用方「哪一环断了」。
 *
 * 调用：wx.cloud.callFunction({ name:'bill-svc', data:{ action:'diag' } })
 *
 * 返回结构：
 * {
 *   ok: true/false,
 *   envMatched: true/false,   // 环境 ID 是否与前端一致
 *   checks: [ { step, ok, detail } ],
 *   verdict: '一句话结论 + 下一步动作'
 * }
 */
async function handleDiag(payload, context) {
  const checks = [];
  const add = (step, ok, detail) => checks.push({ step, ok, detail });

  // 0. 先自报版本 —— 让「云端没重新部署」这类问题当场暴露，而不是靠猜
  add('代码版本', true, `云端 bill-svc 版本 = ${CODE_VERSION}`);

  // 1. wx-server-sdk 是否可用（云函数里没有全局 cloud，必须 require SDK）
  if (!db.isAvailable()) {
    const why = db.sdkInitError();
    add('SDK 初始化', false, why || 'wx-server-sdk 不可用，请在云函数 package.json 中加入 wx-server-sdk 后重新部署');
    return {
      ok: false,
      checks,
      verdict: why
        ? `wx-server-sdk 未就绪：${why}`
        : 'wx-server-sdk 未就绪。请确认云函数 package.json 已声明 wx-server-sdk，并选择「上传并部署：云端安装依赖」。'
    };
  }
  add('SDK 初始化', true, 'wx-server-sdk 已加载并 init 成功');

  // 2. 环境 ID 是否匹配前端（多环境时极易连错）
  let envInfo = {};
  try {
    const wxCtx = db.getWxContext();
    envInfo.env = wxCtx.ENV;
    envInfo.openid = wxCtx.OPENID;
    add('用户身份', !!wxCtx.OPENID, wxCtx.OPENID ? `openid=${wxCtx.OPENID}` : '拿不到 openid，无法写入（需重新编译/部署）');
  } catch (e) {
    add('用户身份', false, `getWXContext 失败：${e.message}`);
  }

  // 3. 集合是否存在且可读
  let readable = false;
  try {
    const res = await db.getDb().collection(COLLECTIONS.BILLS).limit(1).get();
    readable = true;
    add('集合可读', true, `bills 可读，现有 ${res.data.length} 条（limit 1 探测）`);
  } catch (e) {
    const raw = e.errMsg || e.message || String(e);
    if (/not exist|does not exist|not found|集合/i.test(raw)) {
      add('集合可读', false, `bills 集合不存在。请在云开发控制台 → 数据库 → 新建集合，名称填 bills`);
    } else if (/permission|unauthorized|auth/i.test(raw)) {
      add('集合可读', false, `bills 权限不足。请把权限改为「所有用户可读，仅创建者可读写」或自定义安全规则允许读写`);
    } else {
      add('集合可读', false, `未知错误：${raw}`);
    }
  }

  // 4. 真实写入测试（这是唯一能证明写入通了的检查）
  if (readable) {
    try {
      const probe = {
        userId: envInfo.openid || 'diag',
        amount: 1,                     // 1 分，探针数据
        categoryId: '__diag__',
        categoryPath: '__诊断探针__',
        date: todayStr(),
        ts: Date.now(),
        account: 'unknown',
        note: 'diagnostic probe',
        source: 'diag',
        isRecall: false,
        recallDaysLater: 0,
        aiMeta: { agent: 'diag', isFallback: false },
        delFlag: false,
        createTime: Date.now(),
        updateTime: Date.now()
      };
      const saved = await db.getDb().collection(COLLECTIONS.BILLS).add({ data: probe });

      // 5. 写完立刻读回，验证 read-after-write
      let readBack = false;
      try {
        const back = await db.getDb().collection(COLLECTIONS.BILLS)
          .where({ _id: saved._id }).limit(1).get();
        readBack = back.data && back.data.length === 1;
        add('写入验证', readBack, readBack ? `写入成功并读回，_id=${saved._id}` : '写入返回了 _id 但读不到');
      } catch (e) {
        add('写入验证', false, `写入后读回失败：${e.errMsg || e.message}`);
      }

      // 清理探针数据，别污染账本
      if (readBack) {
        try {
          await db.getDb().collection(COLLECTIONS.BILLS)
            .where({ _id: saved._id }).remove();
          add('探针清理', true, '已删除诊断数据');
        } catch (e) {
          add('探针清理', false, `删除失败（不影响主流程），请手动删掉 _id=${saved._id} 的记录：${e.errMsg || e.message}`);
        }
      }
    } catch (e) {
      const raw = e.errMsg || e.message || String(e);
      if (/permission|unauthorized|auth/i.test(raw)) {
        add('写入验证', false, `无写入权限：${raw}。请把 bills 权限设为「所有用户可读，仅创建者可读写」`);
      } else {
        add('写入验证', false, `写入失败：${raw}`);
      }
    }
  }

  const allOk = checks.every((c) => c.ok);
  return {
    ok: allOk,
    env: envInfo.env,
    openid: envInfo.openid,
    checks,
    verdict: allOk
      ? '数据库一切正常。若小程序里看不到数据，问题在查询条件或索引，不在写入。'
      : '存在失败项，见 checks 中 ok=false 的条目。'
  };
}

/* ══════════════════════════════════════════════════
 * 重复记账规则（recurring）
 *
 * 规则是「配置」，账单由 dailyRecurring 定时生成。
 * 口径（与产品确认）：
 *   · 创建当天不生成，游标从「明天起第一个匹配日」开始
 *   · 编辑仅对未来生效，历史账单不动（可在明细页单独编辑）
 *   · 暂停可恢复；恢复/漏跑不补记，游标直接前移到今天之后
 *   · 同规则同一天只生成一笔（游标 + 存在性双重幂等）
 * ══════════════════════════════════════════════════ */

/**
 * 规则字段校验 —— 与 handleManual / handleAmend 同口径
 * （正整数分、上限 GUARDRAIL_MAX_AMOUNT_CENT、类目成对、备注 ≤200）
 */
function validateRuleFields({ amountCent, categoryId, categoryPath, note, account }) {
  if (typeof amountCent !== 'number' || !isFinite(amountCent) || amountCent <= 0) {
    return { ok: false, error: '金额无效，请输入大于 0 的金额' };
  }
  if (Math.round(amountCent) !== amountCent) {
    return { ok: false, error: '金额精度错误，请使用整数分' };
  }
  if (amountCent > GUARDRAIL_MAX_AMOUNT_CENT) {
    return { ok: false, error: '单笔金额超出上限，请检查输入' };
  }
  if (!categoryId) {
    return { ok: false, error: '请选择类目' };
  }
  const path = resolveCategoryPath(categoryId, categoryPath);
  if (!path) {
    return { ok: false, error: '类目不存在，请重新选择' };
  }
  if (note !== undefined && note !== null) {
    if (typeof note !== 'string') return { ok: false, error: '备注格式错误' };
    if (note.length > 200) return { ok: false, error: '备注过长，请控制在 200 字以内' };
  }
  if (account !== undefined && account !== null) {
    const valid = Object.keys(ACCOUNT_TYPE).map((k) => ACCOUNT_TYPE[k]);
    if (!valid.includes(account)) return { ok: false, error: '账户类型无效' };
  }
  return { ok: true, data: { categoryPath: path } };
}

/** repeat 参数落库前裁剪：只存该类型用得到的字段，文档不携带无关参数 */
function normalizeRepeatParams(type, params) {
  const out = { type };
  if (type === 'weekly') out.dayOfWeek = params.dayOfWeek;
  if (type === 'monthly' || type === 'quarterly') out.dayOfMonth = params.dayOfMonth;
  if (type === 'yearly') {
    out.month = params.month;
    out.dayOfMonth = params.dayOfMonth;
  }
  return out;
}

/**
 * 创建重复记账规则
 *
 * 账本口径（与产品确认）：规则私有（不共享），创建时可选个人/家庭
 * 账本；家庭规则到点生成的账单进 family_bills。账本归属创建后不可改
 * （换账本需删除重建）。家庭归属权威在云端：resolveLedger 反查
 * profile.familyId 并校验成员资格，非成员/无家庭 throw 不回退个人。
 *
 * ⚠ 校验必须在「本地环境跳过落库」的早退之前（与 amend 同一教训）：
 * 否则本地测试全走早退分支，校验逻辑一次都没被执行过。
 */
async function handleRuleCreate(payload, context) {
  const { amountCent, categoryId, categoryPath, note, account, repeat } = payload || {};
  const userId = getUserId(context);

  const fv = validateRuleFields({ amountCent, categoryId, categoryPath, note, account });
  if (!fv.ok) return fv;
  const rv = recurring.validateRepeat(repeat && repeat.type, repeat || {});
  if (!rv.ok) return rv;

  // 账本归属：缺省 personal 零新增查询；family 反查 profile 并校验成员
  const ledgerTarget = await resolveLedger(payload, context);

  const repeatDoc = normalizeRepeatParams(repeat.type, repeat);
  // 游标 = 明天（东八区）起的第一个匹配日 —— 创建当天不生成
  const nextDate = recurring.nextOccurrence(repeat.type, repeat, dateUtil.toDateStrCST(Date.now()));

  // 规则文档（family 才带 familyId；无值字段不写，遵守 null 值纪律）
  const ruleDoc = {
    userId,
    amount: amountCent,
    categoryId,
    categoryPath: fv.data.categoryPath,
    note: note || '',
    account: account || ACCOUNT_UNKNOWN,
    repeat: repeatDoc,
    status: 'active',
    nextDate,
    ledger: ledgerTarget.kind
  };
  if (ledgerTarget.familyId) ruleDoc.familyId = ledgerTarget.familyId;

  if (!db.isAvailable()) {
    console.warn('[bill-svc] 跳过规则落库：非云函数环境');
    return {
      ok: true,
      rule: ruleDoc,
      saved: false,
      savedError: '本地环境未接入数据库'
    };
  }

  try {
    const rule = await db.insertRecurringRule(ruleDoc);
    return { ok: true, rule, saved: true };
  } catch (e) {
    console.error('[bill-svc] 规则落库失败', e);
    return { ok: false, error: `保存失败：${e.message}` };
  }
}

/** 列出用户的重复记账规则 */
async function handleRuleList(payload, context) {
  const userId = getUserId(context);
  try {
    const rules = await db.listRecurringRules(userId);
    return { ok: true, rules };
  } catch (e) {
    return { ok: false, error: `读取失败：${e.message}` };
  }
}

/**
 * 编辑规则 —— 仅对未来生效
 *
 * 只改规则文档本身，历史账单完全不动（账单上只留 ruleId 溯源标记）。
 * 改了 repeat 参数 → 游标从明天起重算（旧模式已生成的账单不受影响）。
 */
async function handleRuleUpdate(payload, context) {
  const { ruleId, amountCent, categoryId, categoryPath, note, account, repeat } = payload || {};
  if (!ruleId) return { ok: false, error: '缺少 ruleId' };
  // 口径（与产品确认）：账本归属创建后不可改，换账本需删除重建 —— 明确拒绝而非静默忽略
  if (payload && payload.ledger !== undefined) {
    return { ok: false, error: '账本归属不可修改，请删除后重新创建规则' };
  }
  const userId = getUserId(context);

  const updateData = {};

  if (amountCent !== undefined && amountCent !== null) {
    if (typeof amountCent !== 'number' || !isFinite(amountCent) || amountCent <= 0) {
      return { ok: false, error: '金额无效，请输入大于 0 的金额' };
    }
    if (Math.round(amountCent) !== amountCent) {
      return { ok: false, error: '金额精度错误，请使用整数分' };
    }
    if (amountCent > GUARDRAIL_MAX_AMOUNT_CENT) {
      return { ok: false, error: '单笔金额超出上限，请检查输入' };
    }
    updateData.amount = Math.round(amountCent);
  }

  if (categoryId) {
    const path = resolveCategoryPath(categoryId, categoryPath);
    if (!path) {
      return { ok: false, error: '类目不存在，请重新选择' };
    }
    updateData.categoryId = categoryId;
    updateData.categoryPath = path;
  } else if (categoryPath) {
    return { ok: false, error: '缺少类目 id，请重新选择类目' };
  }

  if (note !== undefined) {
    if (typeof note !== 'string') {
      return { ok: false, error: '备注格式错误' };
    }
    if (note.length > 200) {
      return { ok: false, error: '备注过长，请控制在 200 字以内' };
    }
    updateData.note = note;
  }

  if (account !== undefined && account !== null) {
    const valid = Object.keys(ACCOUNT_TYPE).map((k) => ACCOUNT_TYPE[k]);
    if (!valid.includes(account)) {
      return { ok: false, error: '账户类型无效' };
    }
    updateData.account = account;
  }

  if (repeat !== undefined && repeat !== null) {
    const rv = recurring.validateRepeat(repeat.type, repeat || {});
    if (!rv.ok) return rv;
    updateData.repeat = normalizeRepeatParams(repeat.type, repeat);
    updateData.nextDate = recurring.nextOccurrence(
      repeat.type, repeat, dateUtil.toDateStrCST(Date.now())
    );
  }

  if (Object.keys(updateData).length === 0) {
    return { ok: true, ruleId, updates: {}, saved: true, unchanged: true };
  }

  if (!db.isAvailable()) {
    return { ok: true, ruleId, updates: updateData, saved: false, savedError: '本地环境未接入数据库' };
  }

  try {
    const updated = await db.updateRecurringRule(userId, ruleId, updateData);
    if (!updated) {
      return { ok: false, error: '未找到该规则或无权修改' };
    }
    return { ok: true, ruleId, updates: updateData, saved: true };
  } catch (e) {
    return { ok: false, error: `修改失败：${e.message}` };
  }
}

/**
 * 暂停 / 恢复规则
 *
 * 恢复时**不重算游标**：游标停在暂停时的 nextDate，恢复后它已过期 →
 * 调度层按「漏跑」处理，跳过不补记、从今天之后继续 —— 恰好就是
 * 「恢复后从明天起继续」的产品口径，不需要再读规则文档。
 */
async function handleRulePause(payload, context) {
  const { ruleId, paused } = payload || {};
  if (!ruleId) return { ok: false, error: '缺少 ruleId' };
  if (typeof paused !== 'boolean') return { ok: false, error: '缺少 paused（true 暂停 / false 恢复）' };
  const userId = getUserId(context);

  // 恢复家庭规则前校验成员资格：退出家庭时规则已被自动暂停，
  // 若还允许无脑恢复，生成时兜底校验会让它「恢复成功但永远不生成」——
  // 静默失效。这里明确拒绝，指路删除后重建为个人规则。
  if (paused === false && db.isAvailable()) {
    const rules = await db.listRecurringRules(userId);
    const rule = rules.find((r) => r._id === ruleId);
    if (rule && rule.ledger === 'family' && rule.familyId) {
      const family = await db.familyGet(rule.familyId);
      const profile = await db.getProfile(userId);
      if (!family || !profile || profile.familyId !== rule.familyId) {
        return { ok: false, error: '已退出该家庭，无法恢复这条家庭规则；可删除后重建为个人规则' };
      }
    }
  }

  const updateData = { status: paused ? 'paused' : 'active' };

  if (!db.isAvailable()) {
    return { ok: true, ruleId, updates: updateData, saved: false, savedError: '本地环境未接入数据库' };
  }
  try {
    const updated = await db.updateRecurringRule(userId, ruleId, updateData);
    if (!updated) {
      return { ok: false, error: '未找到该规则或无权修改' };
    }
    return { ok: true, ruleId, updates: updateData, saved: true };
  } catch (e) {
    return { ok: false, error: `修改失败：${e.message}` };
  }
}

/** 删除规则（软删除，历史账单保留） */
async function handleRuleDelete(payload, context) {
  const { ruleId } = payload || {};
  if (!ruleId) return { ok: false, error: '缺少 ruleId' };
  const userId = getUserId(context);

  if (!db.isAvailable()) {
    return { ok: true, ruleId, deleted: true, saved: false, savedError: '本地环境未接入数据库' };
  }
  try {
    const updated = await db.softDeleteRecurringRule(userId, ruleId);
    if (!updated) {
      return { ok: false, error: '未找到该规则或无权修改' };
    }
    return { ok: true, ruleId, deleted: true };
  } catch (e) {
    return { ok: false, error: `删除失败：${e.message}` };
  }
}

/**
 * 每日定时生成账单 —— 定时触发器专用
 *
 * ## 为什么不能由用户触发
 *
 * 定时触发**没有用户上下文**，扫描的是全量用户的到期规则；
 * 若允许任意前端调用，等于任何人可以让系统给别的用户写账单（DoS）。
 * `SOURCE === 'wx_trigger'` 外部无法伪造，是唯一的可信判据。
 *
 * ## 账单归属
 *
 * 生成时用 `insertBillAsUser(bill, rule.userId)`，userId 来自**规则文档**
 * 而不是 openid（触发器下 openid 为空），由「扫描 + 写库」两步保证
 * 只为用户自己的规则写账单。
 *
 * ## 家庭账本分流
 *
 * 规则 ledger='family' 时写 family_bills（`insertFamilyBillAsUser`，
 * userId 仍 = 规则创建者 = 记录人）。生成前兜底校验家庭存在 +
 * 创建者仍是成员（退出/解散时规则已被自动暂停，这里是第二道防线），
 * 失效则跳过 + 游标前移，绝不写无主家庭账单。幂等查重同样按账本分流。
 *
 * ## 幂等
 *
 * 游标 nextDate 是第一道防线（生成后立刻前移）；写入前再查一次
 * 「同规则同一天是否已有账单」是第二道（防触发器重复下发/并发）。
 * 两条都失败也只多一笔，明细页可删 —— 但绝不能少一笔。
 */
async function handleDailyRecurring(payload, context) {
  if (!isTriggerSource(context)) {
    return { ok: false, error: 'dailyRecurring 仅限定时触发器调用', errorCode: 'TRIGGER_ONLY' };
  }

  // ⚠ 必须用东八区口径：云函数运行时是 UTC+0，触发器 cron 是 UTC+8，
  //   本地时区会在 0:30（UTC 前一日 16:30）把账单记成「昨天」。
  //   且用触发时刻而不是 Date.now()（与 analysis-svc dailyInsight 同口径）。
  const today = dateUtil.toDateStrCST(payload.triggeredAt || Date.now());

  let due;
  try {
    due = await db.listDueRecurringRules(today);
  } catch (e) {
    console.error('[dailyRecurring] 捞到期规则失败', e);
    return { ok: false, error: `捞到期规则失败：${e.message}` };
  }

  let generated = 0;
  let skipped = 0;
  let failed = 0;

  for (const rule of due) {
    try {
      const scheduled = String(rule.nextDate || '');

      // 游标早于今天 = 之前漏跑了 → 不补记，游标前移
      if (scheduled < today) {
        skipped++;
        await advanceRuleCursor(rule, today);
        continue;
      }

      // 账本分流：老规则无 ledger 字段按个人处理（缺省零变化）
      const isFamilyRule = rule.ledger === 'family' && rule.familyId;

      // 家庭规则兜底校验（口径：退出/解散时已自动暂停，这里防数据不一致）：
      // 家庭不存在或创建者已非成员 → 跳过并前移游标，绝不写无主家庭账单
      if (isFamilyRule) {
        const family = await db.familyGet(rule.familyId);
        const profile = await db.getProfile(rule.userId);
        if (!family || !profile || profile.familyId !== rule.familyId) {
          skipped++;
          console.warn(
            `[dailyRecurring] 规则 ${rule._id} 的家庭已失效（成员退出或已解散），跳过生成`
          );
          await advanceRuleCursor(rule, today);
          continue;
        }
      }

      // 幂等第二道防线：同规则同一天只生成一笔（按账本分流）
      const existing = isFamilyRule
        ? await db.findFamilyBillByRuleAndDate(rule.familyId, rule._id, today)
        : await db.findBillByRuleAndDate(rule.userId, rule._id, today);
      if (existing) {
        skipped++;
        await advanceRuleCursor(rule, today);
        continue;
      }

      const path = resolveCategoryPath(rule.categoryId, rule.categoryPath);
      if (!path) {
        throw new Error(`类目 ${rule.categoryId} 不存在，无法生成账单`);
      }

      const bill = buildBill({
        userId: rule.userId,
        amountCent: rule.amount,
        categoryId: rule.categoryId,
        categoryPath: path,
        date: today,
        account: rule.account,
        note: rule.note,
        source: BILL_SOURCE.AUTO,
        agent: 'recurring',
        recordTs: Date.now(),
        ruleId: rule._id
      });
      // 家庭账单 userId = 规则创建者 = 记录人（只有记录人可撤销，与家庭纪律一致）
      if (isFamilyRule) {
        await db.insertFamilyBillAsUser(rule.familyId, bill, rule.userId);
      } else {
        await db.insertBillAsUser(bill, rule.userId);
      }
      generated++;
      await advanceRuleCursor(rule, today);
    } catch (e) {
      // 单条失败不拖垮整批；nextDate 不动，次日自然重试
      failed++;
      console.error(`[dailyRecurring] 规则 ${rule._id} 生成失败`, e);
    }
  }

  console.log(`[dailyRecurring] ${today} 完成：生成 ${generated} / 跳过 ${skipped} / 失败 ${failed}`);
  return { ok: true, date: today, generated, skipped, failed };
}

/** 游标前移：下一个匹配日（基于规则文档里的 repeat 参数） */
async function advanceRuleCursor(rule, today) {
  const r = rule.repeat || {};
  const next = recurring.nextOccurrence(r.type, r, today);
  return db.updateRecurringRule(rule.userId, rule._id, { nextDate: next });
}

/**
 * 是否由定时触发器调用
 * 官方文档：getWXContext().SOURCE === 'wx_trigger' 表示触发器调用，
 * 外部请求无法伪造。本地测试拿不到 SOURCE，用环境变量显式放行。
 */
function isTriggerSource(context) {
  try {
    const ctx = db.getWxContext();
    if (ctx && ctx.SOURCE === 'wx_trigger') return true;
    // 若定时器事件已进到这里却仍被拒，SOURCE 到底是什么必须可见
    console.warn(`[bill-svc] 判定非定时触发器来源：SOURCE=${ctx ? JSON.stringify(ctx.SOURCE) : '取不到'}`);
  } catch (e) {
    // 取不到上下文按「非触发器」处理，走更严格的分支
    console.warn(`[bill-svc] 判定非定时触发器来源：getWxContext 抛错 ${e.message}`);
  }
  return process.env.RECURRING_ALLOW_MANUAL === 'true';
}

/** 取今天日期字符串 YYYY-MM-DD */
function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 取类目配色（用于回显给前端） */
function colorOfCategory(categoryId) {
  // preset 已在模块顶部加载过，这里直接复用
  try {
    return preset.colorOf(categoryId);
  } catch (e) {
    return '#A8A8A8';
  }
}

/**
 * 取规则层的强规则候选（priority > 0）
 * 强规则代表「场景决定领域归属」这类产品硬约束，优先级高于模型判断
 */
function getStrongRuleCandidate(ruleCat) {
  const top = ruleCat.candidates && ruleCat.candidates[0];
  if (!top) return null;
  const hasStrong = (top.channels || []).some(
    (c) => c.channel === 'amount' && (c.priority || 0) > 0
  );
  return hasStrong ? top : null;
}

/**
 * 合并 LLM 与规则层结果
 * LLM 缺失的字段一律回落到规则层，绝不出现空值
 *
 * ## 备注为什么在这里合成
 *
 * LLM 的摘要是「写得好看」，规则层提炼的是「关键词不丢」，
 * 两者都需要。而「关键词不能丢」这件事必须由**代码**判定——
 * 模型自己判断自己有没有说漏，等于没检查。
 * 所以合并逻辑放在这里，由 note-summary.buildNote 统一把关。
 *
 * @param {object} aiData LLM 输出
 * @param {object} ruleParsed 规则层解析结果
 * @param {object} ruleCat 规则层分类结果
 * @param {string} asrText 原始口述文本（备注的关键词来源）
 */
function mergeParseResult(aiData, ruleParsed, ruleCat, asrText) {
  const ai = aiData || {};
  return {
    amount: ai.amount !== undefined && ai.amount !== null ? ai.amount : ruleParsed.amount,
    amountCertain: ai.amountCertain !== undefined ? ai.amountCertain : ruleParsed.amountCertain,
    date: ai.date || ruleParsed.date,
    account: ai.account && ai.account !== 'unknown' ? ai.account : ruleParsed.account,
    scene: ai.scene && ai.scene !== '无' ? ai.scene : (ruleParsed.scenes[0] || ''),
    splitCount: ai.splitCount || ruleParsed.splitCount,
    note: noteSummary.buildNote({ asrText, llmNote: ai.note }),
    reasoning: ai.reasoning || ''
  };
}

/**
 * 兜底路径的置信度估算
 *
 * 设计取舍：兜底结果**绝不给到高置信度**（上限 0.74），否则 LLM 故障时
 * 会让本来需要语义校验的模糊场景自动入账，属于危险的降级。
 *
 * 但也不能一律压到低档：规则层若命中「强规则」（priority > 0，如
 * 「打车去医院→医疗」这类明确领域判断），说明规则本身已给出可靠结论，
 * 不应被误判为「不确定」。
 */
function computeFallbackConfidence(ruleCat, asrConfidence) {
  const top = ruleCat.candidates[0];
  if (!top) return 0;

  // 强规则命中：不受兜底压制，可给到中档偏上
  const hasStrongRule = (top.channels || []).some((c) => c.channel === 'amount' && (c.priority || 0) > 0);
  if (hasStrongRule) {
    const asrFactor = typeof asrConfidence === 'number' ? asrConfidence * 0.1 : 0.05;
    return Math.min(0.7 + asrFactor, 0.74);
  }

  // 普通规则命中：整体压低，反映「未经语义校验」
  // 但只要有明确关键词支撑（「超市」「学费」「水电费」这类无歧义词），
  // 就应至少进入中档下限——否则用户面对 166 个类目手选，体验崩塌。
  const channels = top.channels || [];
  const hasKeyword = channels.some((c) => c.channel === 'keyword' && c.score >= 0.3);
  // 场景/金额规则给出了一个明确默认类目（如「超市→日用百货」），
  // 同样不该让用户去翻类目树
  const hasScenRule = channels.some((c) => c.channel === 'amount' && c.score >= 0.5);
  const floor = hasKeyword || hasScenRule ? 0.5 : 0;

  const base = Math.max(Math.min(top.score, 0.55), floor);
  const asrFactor = typeof asrConfidence === 'number' ? asrConfidence * 0.2 : 0.1;
  return Math.min(base + asrFactor, 0.74);
}

/**
 * 构建流水对象（数据结构见技术文档 §4.1）
 * 注意 amount 用整数分存储
 */
function buildBill({
  userId, amountCent, categoryId, categoryPath, date, account,
  note, source, confidence, agent, isFallback, recordTs, recallDaysLater,
  ruleId
}) {
  const bill = {
    userId,
    amount: amountCent,              // 整数分
    categoryId,
    categoryPath,
    date,
    ts: recordTs,
    account: account || 'unknown',
    // 备注统一裁到 200 字（与 amend 的校验上限一致）。
    // 语音总结本身是 30 字以内，但补记/手动路径的 note 来自前端，
    // 不裁的话一条超长备注能撑爆明细列表。
    note: String(note || '').slice(0, 200),
    source,
    isRecall: source === BILL_SOURCE.RECALL,
    recallDaysLater: recallDaysLater || 0,
    aiMeta: {
      agent,
      isFallback: !!isFallback
    },
    delFlag: false,
    createTime: Date.now(),
    updateTime: Date.now()
  };

  // ⚠ 云开发的数据库是「无 schema」的：
  //   · 字段**不存在**完全没问题，首次写入自动创建，不需要预先定义数据结构
  //   · 但 **null 值**在部分环境下会触发写入异常（不同版本行为不一致）
  // 因此无值时**直接不写该字段**，而不是写 null。
  // 前端读取时用 `confidence || 0` 兜底，语义等价。
  if (confidence !== undefined && confidence !== null) {
    bill.confidence = confidence;
  }

  // 重复记账溯源：账单由哪条规则生成（幂等第二道防线 + 排查用）。
  // 无值时同样不写该字段（见上方 null 值约束）。
  if (ruleId) {
    bill.ruleId = ruleId;
  }

  return bill;
}

/** 获取当前用户 openid —— 必须用 getWXContext，不能从 event 里取 */
/**
 * 获取当前用户 openid
 *
 * 顺序：getWXContext（权威）→ context.OPENID（本地调试）
 * ⚠ 绝不能从 event.userInfo 取——event 由客户端构造，
 *   从那里取 openid 等于把「写任意用户数据」的权限交给前端。
 * db.insertBill 会用 db.currentOpenId 再取一次并覆盖此值，
 * 此处仅用于日志与本地流程。
 *
 * ## 为什么拿不到身份就抛错（血泪教训）
 *
 * 原来这里返回 `'unknown'`。于是 getWXContext 拿不到 openid 时，
 * 照样会写入一条 userId='unknown' 的数据：
 *
 *   写入：{ userId: 'unknown', amount: ..., date: ... }   ✅ 没报错
 *   查询：where({ userId:真实openid })                     ❌ 永远查不到
 *
 * 表现就是「提示记好了、不报错、刷新后数据消失」——
 * 用户以为丢了，开发者查日志也看不到异常，最难查的一类故障。
 *
 * 身份拿不到 = 数据无法归属 = 不能写。这不是降级，是必须中断。
 */
function getUserId(context) {
  const fromDb = db.currentOpenId(context);
  if (fromDb) return fromDb;

  const reason = db.isAvailable()
    ? 'wx-server-sdk 可用但 getWXContext 返回空 OPENID，通常是小程序未重新编译/未登录，' +
      '或该AppID 无云开发权限。'
    : 'wx-server-sdk 不可用，云函数未正确初始化。';

  throw new Error(`无法获取用户身份（openid），已中止记账以免写入无法归属的数据。${reason}`);
}

/**
 * 解析账本归属（家庭模式双空间）
 *
 * ## 铁律：ledger 缺省 / 'personal' 走原路径，零新增查询
 *
 * 本地 test-persist / e2e 的 mock 没有 users 集合的 doc()，
 * 默认路径要是也查 profile 会直接崩 —— 现有 20+ 个人空间用例全靠
 * 这条铁律保持全绿。
 *
 * ## 家庭归属的权威在云端
 *
 * familyId 一律从 profile 反查，前端只传 ledger:'family'。
 * profile 无 familyId 却传 family → **throw 不回退个人**：
 * 静默回退会让用户以为记进了家庭账本，实际记成了个人账 ——
 * 这是本项目最忌讳的「静默失效」。
 */
async function resolveLedger(payload, context) {
  const ledger = (payload && payload.ledger) || 'personal';
  if (ledger === 'personal') return { kind: 'personal' };
  if (ledger !== 'family') throw new Error(`未知账本类型: ${ledger}`);

  const openid = db.currentOpenId(context);
  if (!openid) throw new Error('无法获取用户身份');

  const profile = await db.getProfile(openid);
  if (!profile || !profile.familyId) {
    throw new Error('您还没有加入任何家庭，不能记入家庭账本');
  }
  const family = await db.familyGet(profile.familyId);
  if (!family) throw new Error('家庭不存在或已解散');

  return { kind: 'family', familyId: family._id };
}

/** 全局降级开关 */
function isLLMEnabled() {
  return process.env.LLM_ENABLED !== 'false';
}