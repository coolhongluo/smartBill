/**
 * 分析云函数 —— 技术文档 §5.1
 *
 * action：
 *   monthSummary     首页概览（本月总额 + 笔数）
 *   monthBills       明细页（月度流水，日期倒序）
 *   categoryBreakdown 读取**已保存**的分析结果（不触发分析，分析页走这条）
 *   refreshInsight   触发一次分析并落库（记账后自动调 / 用户点「立即分析」）
 *
 * ## 为什么拆成「读」与「算」两个 action
 *
 * 分析要跑 LLM + 最多 3 轮工具往返，10 秒起步。
 * 而结果**当天基本不变**——昨天算的结论今天早上依然成立。
 * 让用户点开分析页等 10 秒是不可接受的，所以：
 *   · 读（categoryBreakdown）：直接返回已存结果，毫秒级
 *   · 算（refreshInsight）：记账后异步跑，跑完存起来
 *
 * 关键原则（技术文档 §9.4 C档刻意不用 LLM）：
 *   这里的**数值全部由代码计算**，模型只在 P2 阶段负责"怎么表述"。
 *   绝不能让模型决定"该不该触发分析"或"算出多少钱"。
 */

const path = require('path');

/**
 * 加载 shared 共享层
 *
 * 候选路径按「云端可达性」排序，不按本地方便程度排序：
 *   1. `<云函数目录>/shared/`             ← 云端唯一可靠来源，随函数打包上传
 *   2. `process.cwd()/node_modules/shared` ← 本地快路径；选「云端安装依赖」时云端不存在
 *   3. `<云函数目录>/../shared/`           ← 平级兄弟目录，不在打包范围内，云端找不到
 *
 * 历史踩坑：只靠 2+3 两条，本地测试全绿、云端却报
 * Cannot find module '/var/shared/...' —— 因为「云端安装依赖」不上传本地 node_modules。
 * 记住：本地全绿 ≠ 云端能跑。
 */
function loadShared(modulePath) {
  const candidates = [
    path.join(__dirname, 'shared', modulePath),
    path.join(process.cwd(), 'node_modules', 'shared', modulePath),
    path.join(__dirname, '..', 'shared', modulePath)
  ];

  for (const p of candidates) {
    try {
      return require(p);
    } catch (e) {
      // 只吞「模块找不到」，其他错误（语法错误等）必须暴露
      if (e.code !== 'MODULE_NOT_FOUND') throw e;
    }
  }

  throw new Error(
    `找不到共享模块 shared/${modulePath}。已尝试：\n` +
    candidates.map((p) => `  - ${p}`).join('\n') +
    `\n请执行 npm run prepare:cf，然后重新「上传并部署：云端安装依赖」。`
  );
}

const db = loadShared('db');
const sdkBoot = loadShared('db/sdk');
const preset = loadShared('util/category-preset');
const money = loadShared('util/money');
const dateUtil = loadShared('util/date');
const harness = loadShared('agent-harness');
const billStats = loadShared('agent-harness/bill-stats');
const insightAgent = loadShared('agent-harness/agents/insight.agent');
const tracer = loadShared('agent-harness/tracer');
const { CODE_VERSION } = loadShared('util/constants');

// 冷启动时注册一次即可
harness.registerAgent(insightAgent.name, insightAgent);

/** 分析需要的月份跨度：本月 + 环比上月 + 趋势回溯 */
const ANALYSIS_MONTHS = 6;

exports.main = async (event, context) => {
  // 入口全量日志：0:00 到底收到定时器事件还是保活空事件，下一趟日志一眼可分。
  // 只打结构与标识字段，不打业务 payload。
  console.log('[analysis-svc] 入口收到调用:', summarizeEvent(event));
  const { action, payload = {} } = normalizeEvent(event || {});

  let res;
  try {
    switch (action) {
      case 'monthSummary':  res = await monthSummary(context, payload); break;
      case 'monthBills':    res = await monthBills(context, payload); break;
      // 读取已存结果（不触发分析）—— 分析页走这条
      case 'categoryBreakdown': res = await readInsight(context, payload); break;
      // 触发一次分析并落库 —— 用户点「立即重新分析」
      case 'refreshInsight':    res = await refreshInsight(context, payload); break;
      // 每日批量分析 —— 定时触发器入口（无用户上下文，需自带用户清单）
      case 'dailyInsight':      res = await dailyInsight(context, payload); break;
      // 诊断入口 —— 一键确认云端环境状态
      case 'diag':              res = await diag(context); break;
      default:
        res = { ok: false, error: `未知操作: ${action}` };
    }
  } catch (e) {
    console.error('[analysis-svc]', action, e);
    res = { ok: false, error: e.message };
  }

  // 无论成功失败都带版本号：前端据此判断云端代码是否已更新
  if (res && typeof res === 'object') res.codeVersion = CODE_VERSION;
  return res;
};

/**
 * 入口日志的事件摘要（与 bill-svc 同款）
 *
 * 0:00 的「未知操作: undefined」是定时器事件没被归一、还是平台保活空事件，
 * 旧日志看不出（tcb_log 为空）。打全量结构后一眼可分：
 *   · Type=Timer 在 keys 里 → 是定时器事件，问题在归一之后
 *   · keys 为空 → 是平台空事件（保活），与定时器无关
 * 业务 payload 不进日志；未知形态才打原始内容（截断防超长）。
 */
/**
 * 判「是不是定时触发器事件」—— 大小写不敏感
 *
 * 官方文档写的是 `Type:'Timer'`（大写 T），但 **2026-11-08 云端日志实测**
 * 平台实际下发的是 `Type:'timer'`（**小写 t**），且额外带
 * `tcbContext` / `userInfo` 字段（bill-svc 的 dailyRecurring 0:30 触发实测）：
 *   { Message:'', Time:'2026-11-07T16:30:00Z', TriggerName:'dailyRecurring',
 *     Type:'timer', tcbContext:0, userInfo:{ appId:'...' } }
 *
 * 2026-10-31 的修复判据写死 `Type === 'Timer'`（大写）→ 云端真实事件
 * **永不命中** → action=undefined → 「未知操作: undefined」→
 * 定时任务每天静默失败，而测试按文档大写构造 → 本地全绿 ≠ 云端能跑。
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
 * 事件归一 —— 让定时触发器能进到 dailyInsight
 *
 * ## 为什么必须有这一步
 *
 * 官方定时触发器下发的 event **没有 `action` 字段**，而 switch 认的是
 * `event.action` → 解构出 `undefined` → 落 `default` 分支 →
 * 返回「未知操作: undefined」→ 定时任务每天静默什么都没发生，且没有任何报错。
 *
 * 真实故障（2026-10-31 实测）：
 *   喂官方真实 event → ok=false、落库 0 条
 *   喂 {action:'dailyInsight'} → ok=true、processed=1
 * 之前测试全绿，是因为测试**手工构造了 `action`**，
 * 绕过了「平台怎么下发 event」这一层 —— 本地全绿 ≠ 云端能跑。
 *
 * ## 认什么特征
 *
 * 用 `Type`（定时触发器事件的固定字段）作为**主判据**，
 * `TriggerName` 作为交叉校验。
 *
 * ⚠️ **判据必须大小写不敏感（2026-11-08 云端日志实测）**：
 * 官方文档写 `Type:'Timer'`（大写 T），但平台实际下发的是
 * **`Type:'timer'`（小写 t）**，且额外带 `tcbContext`/`userInfo` 字段：
 *   { Message:'', Time:'...Z', TriggerName:'dailyInsight',
 *     Type:'timer', tcbContext:0, userInfo:{ appId:'...' } }
 * 2026-10-31 的修复判据写死大写 `'Timer'` → 云端真实事件**永不命中**，
 * 定时分析每天照样静默失败（bill-svc 的 dailyRecurring 于
 * 2026-11-08 00:30 在云端日志实测复现同一故障）。判据统一走
 * `isTimerEvent()`：大小写都认，测试两侧形状都覆盖。
 *
 * ⚠️ 为什么不用 `TriggerName` 单独判：它是可以被外部伪造的普通字段。
 * `Type` 虽然也只是 event 里的字段，但外部调用要伪造它
 * 必须**主动构造**这个形状 —— 而 `isTriggerSource()` 会在下游
 * 再次校验 `getWXContext().SOURCE === 'wx_trigger'`，
 * **外部无法伪造 SOURCE**，所以伪造 event 也拿不到越权能力。
 *
 * ## 为什么不让 payload 透传
 *
 * 定时触发器不该带 payload（平台不会传）。
 * 这里显式丢弃 —— 避免外部构造 `{Type:'timer', payload:{...}}` 时
 * 把 `cursor`/`month` 等参数带进批量任务。
 */
function normalizeEvent(event) {
  const isTimer = isTimerEvent(event);

  if (isTimer) {
    // 触发器名对不上 → 不静默放行，返回一个必然落 default 的 action
    const name = String(event.TriggerName || '');
    if (name && name !== 'dailyInsight') {
      console.warn(`[analysis-svc] 未知定时触发器：${name}`);
      return { action: '__unknown_timer__', payload: {} };
    }
    console.log('[analysis-svc] 定时触发器已命中 → dailyInsight');
    return {
      action: 'dailyInsight',
      payload: { triggeredAt: parseTriggerTime(event.Time) }
    };
  }

  // 普通调用：小程序端 / 内部调用，action 由调用方指定
  return { action: event.action, payload: event.payload || {} };
}

/**
 * 解析定时触发器的触发时刻
 *
 * 官方 event 里 `Time` 是 ISO 字符串（如 `2026-10-31T16:00:00Z`，UTC 时区）。
 * 解析失败返回 null → 调用方回落到 `Date.now()`。
 *
 * ⚠️ 这个时刻决定「分析哪个月」——
 * 必须用它而不是函数开始执行的时刻（见 dailyInsight 里的说明）。
 */
function parseTriggerTime(time) {
  if (!time) return null;
  const ts = Date.parse(time);
  return Number.isFinite(ts) ? ts : null;
}

/**
 * 诊断入口
 *
 * ## 为什么必须有它
 *
 * 「界面显示规则版分析」这个现象有多种可能原因：
 *   1. 云函数代码没重新部署（跑的还是旧副本）
 *   2. DEEPSEEK_API_KEY 没配
 *   3. 分析页读的是**已存的旧结果**，本次没重算
 *   4. LLM_ENABLED 被设成了 false
 *   5. 模型真的调用失败了（网络/Key 失效）
 *
 * 靠猜会浪费很多时间。这个入口一次性把答案给出来。
 *
 * ## 关键：实测而不是看环境变量
 *
 * 只读 `process.env` 是不够的——环境变量可能配了但没生效
 * （热实例没重启、或配到了别的函数）。
 * 所以这里**真的发一次最小请求**，用结果说话。
 */
async function diag(context) {
  const checks = [];

  // ① SDK 与身份
  const sdk = sdkBoot.ensureSdk();
  checks.push({
    name: 'SDK 就绪',
    ok: !!sdk,
    detail: sdk ? 'wx-server-sdk 已初始化' : 'SDK 不可用——shared/db/sdk.js 的 ensureSdk() 返回 null'
  });

  const openid = db.currentOpenId(context);
  checks.push({
    name: '用户身份',
    ok: !!openid,
    detail: openid ? '已获取 openid' : '无法获取 openid（小程序未登录或无云开发权限）'
  });

  // ② 数据库
  const dbOk = db.isAvailable();
  checks.push({
    name: '数据库可读',
    ok: dbOk,
    detail: dbOk ? 'bills / users 集合可访问' : '数据库不可用'
  });

  // ③ 环境变量（仅供参考，真正的结论看 ⑤）
  const llmEnabled = isLLMEnabled();
  const hasKey = !!(process.env.DEEPSEEK_API_KEY || '');
  checks.push({
    name: 'LLM 开关',
    ok: llmEnabled,
    detail: llmEnabled ? 'LLM_ENABLED 未被关闭' : 'LLM_ENABLED=false，所有分析都会走规则版'
  });
  checks.push({
    name: 'API Key',
    ok: hasKey,
    detail: hasKey
      ? `DEEPSEEK_API_KEY 已设置（长度 ${process.env.DEEPSEEK_API_KEY.length}）`
      : '未设置 DEEPSEEK_API_KEY —— 必然走规则版'
  });

  // ④ 本次已存的分析结果
  let stored = null;
  try {
    const month = dateUtil.toMonthStr(new Date());
    const doc = await db.getInsight(openid, month);
    stored = doc
      ? {
          exists: true,
          month,
          generateTime: doc.generateTime,
          isFallback: !!(doc.meta && doc.meta.isFallback),
          fallbackReason: (doc.meta && doc.meta.reason) || ''
        }
      : { exists: false, month };
  } catch (e) {
    stored = { exists: false, error: e.message };
  }
  checks.push({
    name: '已存结果',
    ok: true,
    detail: stored.exists
      ? `本月已有结果，生成于 ${new Date(stored.generateTime).toLocaleString('zh-CN')}，` +
        (stored.isFallback ? `当时是规则版（${stored.fallbackReason || '原因未记录'}）` : '当时是模型版')
      : '本月还没有结果'
  });

  // ⑤ 实测：真的发一次最小模型请求
  // 这是最有价值的一项——它同时验证了 Key、网络、模型服务
  let modelTest = { attempted: false };
  if (llmEnabled && hasKey) {
    modelTest.attempted = true;
    const startedAt = Date.now();
    try {
      const llm = loadShared('agent-harness/llm-client');
      const r = await llm.chat({
        messages: [{ role: 'user', content: '回复"ok"两个字即可' }],
        temperature: 0,
        maxTokens: 20,
        userId: 'diag',
        timeoutMs: 10000
      });
      modelTest.ok = !!r.ok;
      modelTest.latencyMs = Date.now() - startedAt;
      modelTest.detail = r.ok
        ? `模型调用成功（${modelTest.latencyMs}ms），返回：${String(r.content).slice(0, 40)}`
        : `模型调用失败：${r.error}`;
      modelTest.usage = r.usage;
    } catch (e) {
      modelTest.ok = false;
      modelTest.latencyMs = Date.now() - startedAt;
      modelTest.detail = `模型调用异常：${e.message}`;
    }
  } else {
    modelTest.detail = !llmEnabled
      ? 'LLM 已关闭，跳过实测'
      : '没有 API Key，无法实测（这本身就是规则版的原因）';
  }
  checks.push({
    name: '模型实测',
    ok: modelTest.ok === true,
    detail: modelTest.detail
  });

  // ⑥ 代码版本
  checks.push({
    name: '云端代码版本',
    ok: true,
    detail: `当前云端跑的是 ${CODE_VERSION}。` +
      `若你刚改过代码但没重新部署，这里会是旧版本号`
  });

  const allOk = checks.every((c) => c.ok);
  return {
    ok: true,
    codeVersion: CODE_VERSION,
    allOk,
    checks,
    stored,
    modelTest,
    /** 给出可执行的下一步，而不是让用户自己推断 */
    advice: buildDiagAdvice(checks, stored)
  };
}

/**
 * 根据检查结果给出可执行的下一步
 */
function buildDiagAdvice(checks, stored) {
  const advice = [];
  const byName = {};
  for (const c of checks) byName[c.name] = c;

  if (!byName['API Key'].ok) {
    advice.push('去 云开发控制台 → 云函数 → analysis-svc → 配置 → 环境变量，添加 DEEPSEEK_API_KEY');
  }
  if (!byName['LLM 开关'].ok) {
    advice.push('把环境变量 LLM_ENABLED 从 false 改成 true（或删掉该变量）');
  }
  if (byName['模型实测'] && byName['模型实测'].ok === false && byName['API Key'].ok) {
    advice.push('Key 已配但模型调用失败——检查 Key 是否有效、网络是否可达');
  }
  if (stored && stored.exists && stored.isFallback) {
    advice.push('数据库里存的是**旧的规则版结果**。点分析页的「立即分析」按钮重算一次');
  }
  if (!stored || !stored.exists) {
    advice.push('本月还没有分析结果。点分析页的「立即分析」按钮触发一次');
  }
  if (!advice.length) {
    advice.push('环境正常。若界面仍显示规则版，请开 DEBUG_TRACE=true 后重新分析，查看日志');
  }
  return advice;
}

/**
 * 读取已保存的分析结果（**不触发分析**）
 *
 * 为什么分析页不再现算：
 *   分析要跑 LLM + 最多 3 轮工具往返，10 秒起步。
 *   而这些结果**当天基本不变**——昨天算的结论今天早上依然成立。
 *   让用户点开页面等 10 秒是不可接受的，改为「记账后算好存起来」。
 *
 * 没有结果时明确返回 `hasResult: false` 而不是空数组，
 * 因为「还没分析过」和「分析了但没发现什么」是完全不同的两件事，
 * 前端要给出不同的引导（提示点分析 vs 告知确实没有优化空间）。
 */
async function readInsight(context, payload) {
  const scope = await resolveScope(context, payload);

  const month = payload.month || dateUtil.toMonthStr(new Date());
  // 家庭 insight 存储与读取分离：getFamilyInsight 返回的已是拍平结构，
  // 与 getInsight 同构，下面的过期判断与组装逻辑零分支复用
  const doc = scope.kind === 'family'
    ? await db.getFamilyInsight(scope.familyId, month)
    : await db.getInsight(scope.openid, month);

  if (!doc) {
    return {
      ok: true,
      data: {
        hasResult: false,
        month,
        insights: [],
        savings: [],
        pie: []
      }
    };
  }

  // ── 结论是否已过期 ──
  //
  // 「跨月」是 _stale（存的是上个月的结论）。
  // 但还有另一种过期：**同月内账单被编辑过**。
  // 编辑只改 updateTime，结论却还停留在编辑前的金额上，
  // 展示出来的是基于旧数据的占比与节省建议 —— 比不显示更糟。
  //
  // 判据与定时任务 dailyInsight 保持一致：
  // 账单的「最后变动时间」晚于结论的「生成时间」→ 已过期。
  let isOutdated = false;
  try {
    const genTime = Number(doc.generateTime) || 0;
    const lastChange = scope.kind === 'family'
      ? await db.familyGetLatestBillChangeTime(scope.familyId, month)
      : await db.getLatestBillChangeTime(scope.openid, month);
    isOutdated = !!(genTime && lastChange && lastChange > genTime);
  } catch (e) {
    // 查不到就按「未过期」处理：宁可让用户点一次「重新分析」，
    // 也不要把一条其实是过期的结论标成过期（用户会白折腾一次）
    console.warn('[analysis-svc] 判断结论是否过期失败', e.message);
  }

  return {
    ok: true,
    data: {
      hasResult: true,
      month: doc.month || month,
      insights: doc.insights || [],
      savings: doc.savings || [],
      pie: doc.pie || [],
      total: doc.total || '',
      billCount: doc.billCount || 0,
      deltaText: doc.deltaText || '',
      deltaDirection: doc.deltaDirection || '',
      trend: doc.trend || [],
      meta: doc.meta || {},
      // 前端据此提示「更新于 X」；跨月时 _stale 告诉它数据已过期
      generateTime: doc.generateTime || 0,
      isStale: !!doc._stale,
      // 账单在结论生成后被改动过 → 结论已过期，需提示重新分析
      isOutdated
    }
  };
}

/**
 * 触发一次分析并落库
 *
 * 被两处调用：
 *   1. bill-svc 记账成功后（异步，不阻塞记账）
 *   2. 用户点「立即重新分析」
 *
 * ⚠️ 落库失败**不视为失败**：分析结果是锦上添花，
 * 记账本身已经成功了，不能因为存分析失败而让用户看到「保存失败」。
 */
async function refreshInsight(context, payload) {
  /**
   * 家庭账本分支（v1：仅手动刷新）
   *
   * targetOpenid 语义是「某个**用户**的分析」，家庭分析的对象是家庭，
   * 两者不可混用；家庭定时聚合留 v2（dailyInsight 的 listPendingInsightUsers
   * 只扫个人 insight，家庭文档被「顶层无 month」的存储纪律挡在扫描之外）。
   */
  if ((payload && payload.ledger) === 'family') {
    const scope = await resolveScope(context, payload);
    const month = payload.month || dateUtil.toMonthStr(new Date());
    const computed = await computeInsight({ familyId: scope.familyId, month });

    try {
      const saved = await db.saveFamilyInsight(scope.familyId, computed, month);
      if (!saved.saved) {
        return {
          ok: true,
          data: { ...computed, persisted: false, savedError: saved.savedError || '' }
        };
      }
    } catch (e) {
      console.error('[analysis-svc] 家庭分析结果落库失败', e);
      return {
        ok: true,
        data: { ...computed, persisted: false, savedError: e.message }
      };
    }

    return { ok: true, data: { ...computed, persisted: true } };
  }

  /**
   * 目标用户的确定顺序：显式指定 > 云函数上下文
   *
   * ⚠️ 定时触发器运行时**没有用户上下文**：
   * 官方文档明确 getWXContext() 在 wx_trigger 来源下 OPENID 为空。
   * 所以定时任务必须显式传入 targetOpenid，
   * 否则 db.currentOpenId 返回 null → 整个定时任务什么也做不了。
   *
   * 显式传入优先于上下文，是为了让批量调度能逐个指定用户；
   * 但**只允许定时/内部路径使用**——外部调用若能任意指定 openid，
   * 就等于可以给任意用户写数据，那是个越权漏洞。
   * 因此下面会用 `isTriggerSource` 校验调用来源。
   */
  const targetOpenid = String(payload.targetOpenid || '').trim();
  const isTrigger = isTriggerSource(context);

  let openid;
  if (targetOpenid) {
    // 只信任来自定时触发器的显式指定
    if (!isTrigger) {
      return {
        ok: false,
        error: '不允许指定 targetOpenid。该参数仅供定时触发器内部调度使用'
      };
    }
    openid = targetOpenid;
  } else {
    openid = db.currentOpenId(context);
  }

  if (!openid) {
    return {
      ok: false,
      error: isTrigger
        ? '定时触发缺少目标用户（定时触发无用户上下文，需由批量入口显式指定）'
        : '无法获取用户身份'
    };
  }

  const month = payload.month || dateUtil.toMonthStr(new Date());
  const computed = await computeInsight({ openid, month });

  try {
    // computeInsight 返回的就是数据本体（不是 {data:...} 包装）
    const saved = await db.saveInsight(openid, computed, month);
    if (!saved.saved) {
      // 数据库没就绪时如实告知，但不抛错——记账链路不受影响
      return {
        ok: true,
        data: { ...computed, persisted: false, savedError: saved.savedError || '' }
      };
    }
  } catch (e) {
    console.error('[analysis-svc] 分析结果落库失败', e);
    return {
      ok: true,
      data: { ...computed, persisted: false, savedError: e.message }
    };
  }

  return { ok: true, data: { ...computed, persisted: true } };
}

/**
 * 判断是否由定时触发器调用
 *
 * 官方文档：getWXContext().SOURCE === 'wx_trigger' 表示触发器调用。
 * 这是唯一可信的「内部调用」判据——外部请求无法伪造 SOURCE。
 */
function isTriggerSource(context) {
  const sdk = sdkBoot.ensureSdk();
  try {
    if (sdk && typeof sdk.getWXContext === 'function') {
      const ctx = sdk.getWXContext();
      if (ctx && ctx.SOURCE === 'wx_trigger') return true;
      // 若定时器事件已进到这里却仍被拒，SOURCE 到底是什么必须可见
      console.warn(`[analysis-svc] 判定非定时触发器来源：SOURCE=${ctx ? JSON.stringify(ctx.SOURCE) : '取不到'}`);
    }
  } catch (e) {
    // 取不到上下文时按「非触发器」处理，走更严格的分支
    console.warn(`[analysis-svc] 判定非定时触发器来源：getWXContext 抛错 ${e.message}`);
  }
  // 本地测试与旧版本 SDK 可能拿不到 SOURCE，此时允许内层自行校验
  return process.env.INSIGHT_ALLOW_TARGET_OPENID === 'true';
}

/**
 * 每日批量分析（定时触发器入口）
 *
 * ## 定时触发器的两个硬约束
 *
 * 1. **没有用户上下文**：getWXContext().OPENID 为空，
 *    必须自己从数据库找出「有哪些用户需要分析」。
 * 2. **40 秒超时**：单个用户分析就要 10 秒（LLM + 工具往返），
 *    串行最多处理 4 个用户。所以必须：
 *    · 先算出「谁需要分析」的全量清单
 *    · 只处理能装进时间预算的那一批
 *    · 把「下一个游标」落库，下次触发时从游标继续
 *
 * ## 为什么不全量重算
 *
 * 每天给所有用户重跑会持续烧 LLM 额度，而绝大多数用户当天没有新账单，
 * 重算出来的结论与昨天一模一样。改成「按需增量」：
 * 只分析「账单有新增或结果过期」的用户。
 */
async function dailyInsight(context, payload) {
  const startedAt = Date.now();

  // 提前声明 LLM 关闭开关 —— 定时任务不能被一次调用拖垮
  if (!isLLMEnabled()) {
    return {
      ok: true,
      data: { skipped: true, reason: 'LLM_ENABLED=false，跳过定时分析' }
    };
  }

  // ⚠️ 这里必须用 **东八区** 口径，不能用 `toMonthStr`（本地时区）。
  //
  // 云函数运行时是 UTC+0，而定时触发器的 cron 规则时区是 UTC+8。
  // 两者差 8 小时 → 每月 1 号 0 点触发时，UTC 还停在上月最后一天 16:00
  // → `toMonthStr(new Date())` 返回**上个月**
  // → 定时任务分析了上个月的账单，用户看到的却是本月。
  //
  // 只有定时任务用这个口径：其余 action（monthSummary / monthBills /
  // readInsight / refreshInsight）都是**用户主动触发**，
  // 用户此刻正在看的就是「当前月」，本地时区口径反而与用户直觉一致，
  // 改它们会波及既有语义。
  //
  // ⚠️ 用**触发时刻**而不是 `new Date()`：
  // ① 平台给的 `event.Time` 是权威触发时刻，口径确定、可复现、可测试；
  // ② `new Date()` 是「函数开始执行的那一刻」—— 触发器排队延迟时
  //    两者可能跨月（0 点排队、1 点才执行 → 算成下个月）。
  const month = payload.month || dateUtil.toMonthStrCST(payload.triggeredAt || Date.now());

  let targets;
  try {
    targets = await db.listPendingInsightUsers(month, {
      limit: 50,
      cursor: payload.cursor || 0
    });
  } catch (e) {
    console.error('[dailyInsight] 取待分析用户失败', e);
    return { ok: false, error: `取待分析用户失败：${e.message}` };
  }

  const candidates = targets.users || [];
  if (!candidates.length) {
    return {
      ok: true,
      data: {
        processed: 0, skipped: 0, failed: 0,
        // ⚠️ 这里也要带 month —— 早退路径与主路径的返回结构必须一致，
        // 否则「无待分析用户」时调用方拿不到月份（前端对账 / 排查都要用）。
        month,
        reason: targets.exhausted ? '所有用户的分析结果都是最新的' : '没有符合条件的用户',
        nextCursor: targets.nextCursor,
        totalCandidates: targets.totalCandidates
      }
    };
  }

  /**
   * 时间预算：留 8 秒安全余量给落库与函数退出
   *
   * 单用户分析约 10 秒，所以 40 秒能装 3 个左右。
   * 这里不按固定数量而是按**实际耗时**判定——
   * 冷启动、LLM 慢响应时能自动少处理几个，而不是硬超时丢结果。
   */
  const TOTAL_BUDGET_MS = 32_000;
  const results = { processed: 0, skipped: 0, failed: 0, details: [] };

  for (const user of candidates) {
    const elapsed = Date.now() - startedAt;
    if (elapsed > TOTAL_BUDGET_MS) {
      results.details.push({ openid: maskOpenid(user), status: 'deferred', reason: '超出本次时间预算' });
      continue;
    }

    try {
      const r = await refreshInsight(context, {
        targetOpenid: user,
        month
      });
      if (r.ok && r.data && r.data.persisted) {
        results.processed++;
        results.details.push({ openid: maskOpenid(user), status: 'ok' });
      } else {
        results.skipped++;
        const why = (r.data && r.data.savedError) || r.error || '未知原因';
        results.details.push({ openid: maskOpenid(user), status: 'skipped', reason: why });
      }
    } catch (e) {
      // 单用户失败绝不能中断整批 —— 一个用户的问题不该让其他人也没结果
      results.failed++;
      results.details.push({ openid: maskOpenid(user), status: 'failed', reason: e.message });
    }
  }

  const deferred = results.details.filter((d) => d.status === 'deferred').length;
  const hasMore = deferred > 0 || (targets.nextCursor !== undefined && targets.nextCursor > 0);

  return {
    ok: true,
    data: {
      processed: results.processed,
      skipped: results.skipped,
      failed: results.failed,
      deferred,
      costMs: Date.now() - startedAt,
      nextCursor: hasMore ? (targets.nextCursor || 0) : 0,
      hasMore,
      month,
      details: results.details
    }
  };
}

/** 日志里的 openid 要脱敏：云函数日志任何人都可能看到 */
function maskOpenid(openid) {
  const s = String(openid || '');
  return s.length > 10 ? `${s.slice(0, 6)}***${s.slice(-4)}` : '***';
}

/**
 * 账本作用域解析 —— 家庭模式双空间的分析口径入口
 *
 * ## 铁律：ledger 缺省 / 'personal' 走原路径**零新增查询**
 *
 * 本地测试与持久化 mock 没有 profile 的 doc() 查询能力，
 * 默认路径一旦多查一次 profile 就会直接崩。
 *
 * ## 家庭账本不静默回退
 *
 * profile.familyId 为空或家庭不存在 → 直接 throw：
 * 让用户以为记进了家庭账本而实际落到个人账本，是比报错更糟的静默失效。
 *
 * @returns {Promise<{kind:'personal', openid:string}|{kind:'family', familyId:string}>}
 */
async function resolveScope(context, payload) {
  const ledger = (payload && payload.ledger) || 'personal';

  if (ledger === 'personal') {
    const openid = db.currentOpenId(context);
    if (!openid) throw new Error('无法获取用户身份');
    return { kind: 'personal', openid };
  }

  if (ledger !== 'family') throw new Error(`未知账本类型: ${ledger}`);

  const openid = db.currentOpenId(context);
  if (!openid) throw new Error('无法获取用户身份');

  const profile = await db.getProfile(openid);
  if (!profile || !profile.familyId) {
    throw new Error('您还没有加入任何家庭，不能查看家庭分析');
  }

  const family = await db.familyGet(profile.familyId);
  if (!family) throw new Error('家庭不存在或已解散');

  return { kind: 'family', familyId: family._id };
}

/** 首页概览 */
async function monthSummary(context, payload) {
  const scope = await resolveScope(context, payload);

  const month = dateUtil.toMonthStr(new Date());
  const stat = scope.kind === 'family'
    ? await db.familyMonthStat(scope.familyId, month)
    : await db.monthStat(scope.openid, month);

  return {
    ok: true,
    data: {
      month,
      // 前端要展示字符串金额，避免各端格式化不一致
      total: money.formatCent(stat.total),
      count: stat.count
    }
  };
}

/** 明细页流水 */
async function monthBills(context, payload) {
  const scope = await resolveScope(context, payload);

  const month = payload.month || dateUtil.toMonthStr(new Date());
  const bills = scope.kind === 'family'
    ? await db.listFamilyBills(scope.familyId, { month, limit: 100 })
    : await db.listBills(scope.openid, { month, limit: 100 });

  // 附上展示色，避免前端各自维护一份类目配色映射
  const withColor = bills.map((b) => ({
    ...b,
    color: preset.colorOf(b.categoryId)
  }));

  let total = 0;
  for (const b of bills) total += b.amount || 0;

  // 环比：明细页要展示「比上月多/少多少」，
  // 但此前前端读了 deltaText/deltaRate 而云函数没返回，环比栏一直是空的
  let deltaText = '';
  let deltaRate = 0;
  let deltaDirection = 'flat';
  let hasBaseline = false;

  if (db.isAvailable()) {
    const prevMonth = shiftMonth(month, -1);
    const snap = scope.kind === 'family'
      ? await db.familyRecentBillsByMonth(scope.familyId, 2, month)
      : await db.recentBillsByMonth(scope.openid, 2, month);
    const byMonth = (snap && snap.byMonth) || {};
    const cur = billStats.normalizeBills(bills).bills;
    const prev = billStats.normalizeBills(byMonth[prevMonth] || []).bills;
    const mom = billStats.calcMonthOverMonth(cur, prev);
    deltaRate = mom.deltaRate;
    deltaDirection = mom.direction;
    hasBaseline = mom.hasBaseline;
    deltaText = mom.hasBaseline ? buildDeltaText(mom) : '';
  }

  return {
    ok: true,
    data: {
      month,
      bills: withColor,
      totalCent: total,
      total: money.formatCent(total),
      deltaText,
      deltaRate,
      deltaDirection,
      hasBaseline
    }
  };
}

/**
 * 计算分析结果（**不含存储**）
 *
 * 抽出来的原因：`refreshInsight` 落库时要返回它，
 * 而万一落库失败也要返回它——用户点「立即分析」时至少能立刻看到结果，
 * 只是没存下来而已。两者必须用同一份计算，否则会出现
 * 「页面上显示的」和「存起来的」不是同一批数据。
 */
async function computeInsight({ openid, familyId, month }) {
  // ⚠️ 单一数据源：占比卡与分析结论必须来自**同一次**计算。
  // 之前占比走 db.categoryBreakdown、分析走 recentBillsByMonth，
  // 两条路径的清洗规则不同 → 同一屏上「餐饮占 85.5%」
  // 而结论里写「占 85.4%」，用户会以为应用算错了。
  // 现在统一：查一次 → 清洗一次 → 所有统计都基于清洗后的结果。
  //
  // 家庭账本 = 全家聚合：同一套清洗与统计管道，只是数据源换成
  // family_bills（按 familyId 过滤、全员账单一起算）。
  const snap = familyId
    ? await db.familyRecentBillsByMonth(familyId, ANALYSIS_MONTHS, month)
    : await db.recentBillsByMonth(openid, ANALYSIS_MONTHS, month);
  const billsByMonth = (snap && snap.byMonth) || {};
  const totalFetched = (snap && snap.totalFetched) || 0;

  const cleaned = {};
  let droppedCount = 0;
  for (const mo of Object.keys(billsByMonth)) {
    const r = billStats.normalizeBills(billsByMonth[mo]);
    cleaned[mo] = r.bills;
    droppedCount += r.dropped;
  }

  const cur = cleaned[month] || [];

  // 占比直接由清洗后的数据算出，与分析结论共用同一份快照
  const share = billStats.calcCategoryShare(cur);
  const pie = share.items.map((it) => ({
    name: it.name,
    value: it.valueYuan,
    percent: it.percent,
    color: colorOfTop(it.name)
  }));

  // 消费分析结论：LLM 取数 + 表述，失败自动退回纯代码模板
  // 家庭分析以 family_ 前缀的合成 id 作为 LLM 会话归属，
  // 保证家庭结论的对话上下文与任何个人结论互不串扰
  const insightResult = await buildInsights({
    month,
    cleaned,
    droppedCount,
    userId: familyId ? `family_${familyId}` : openid
  });

  // 环比与趋势同样由代码算（前端明细页也在用这两个字段）
  const prevMonth = shiftMonth(month, -1);
  const mom = billStats.calcMonthOverMonth(cur, cleaned[prevMonth] || []);

  return {
    month,
    pie,
    total: share.totalYuan,
    billCount: cur.length,

    // 环比：明细页 deltaText / deltaColor 依赖这两个字段，
    // 之前前端读了但云函数没返回，导致环比栏永远空白
    deltaRate: mom.deltaRate,
    deltaText: mom.hasBaseline ? buildDeltaText(mom) : '',
    deltaDirection: mom.direction,
    hasBaseline: mom.hasBaseline,

    // 趋势（供前端画折线）
    trend: billStats.calcTrend(cleaned, ANALYSIS_MONTHS),

    // 消费分析结论
    insights: insightResult.insights,
    savings: insightResult.savings,

    // meta 统一收敛到一个字段，前端只认 meta
    meta: {
      isFallback: insightResult.isFallback,
      /**
       * savings 来源：'llm' = AI 分析过（含分析后确实无建议）；
       * 'unavailable' = AI 没跑成。v3 起降级不再生成规则建议，
       * 前端据此区分「暂时没有可优化空间」与「AI 分析暂不可用 + 重试」。
       */
      savingsSource: insightResult.isFallback ? 'unavailable' : 'llm',
      reason: insightResult.fallbackReason || '',
      // 降级原因翻译成人话：前端不该直接展示 'LLM_UNAVAILABLE' 这种码
      fallbackInfo: buildFallbackInfo(insightResult),
      droppedCount,
      totalFetched,
      /** 本月笔数：前端据此区分「没记账」与「有数据但无建议」 */
      billCount: cur.length,
      /** 本月无数据：前端要显示「本月还没有记账」而不是空卡片 */
      isEmpty: cur.length === 0
    }
  };
}

/**
 * 构造降级说明
 *
 * ⚠️ 「护栏正常工作」与「系统故障」必须区分：
 * 模型建议学费省 30% 被拦下，这是保护机制在起作用，
 * 不是分析失败。若都显示成「分析失败」，用户会以为系统坏了。
 */
function buildFallbackInfo(insightResult) {
  if (!insightResult || !insightResult.isFallback) return null;
  // ⚠️ 必须用 loadShared 而不是 require('../shared/...')：
  // 后者解析到仓库根的 shared/，那是**平级兄弟目录**，
  // 不在云函数打包范围内，云端会报 Cannot find module。
  // loadShared 按「云端可达性」排序，首选 <函数目录>/shared/。
  const fallbackReason = loadShared('util/fallback-reason');
  return fallbackReason.explainFallback(insightResult.fallbackReason || '');
}

/** 环比文案也由代码拼，不让模型措辞（避免「仅微增 2%」这类夸大或缩小） */
function buildDeltaText(mom) {
  if (mom.direction === 'flat') return '与上月基本持平';
  const word = mom.direction === 'up' ? '较上月多支出 ' : '较上月少支出 ';
  return `${word}${mom.deltaYuan} 元（${Math.abs(mom.deltaRate)}%）`;
}

/**
 * LLM 全局降级开关
 *
 * 与 bill-svc 同一套语义：未设置时默认开启（只有显式 false 才关）。
 * 作用是应急——LLM 侧限流、故障或成本失控时，改一个环境变量即可全量切回规则版，
 * 不需要重新部署。
 */
function isLLMEnabled() {
  return process.env.LLM_ENABLED !== 'false';
}

function shiftMonth(month, delta) {
  const m = String(month || '').match(/^(\d{4})-(\d{2})$/);
  if (!m) return '';
  const d = new Date(Number(m[1]), Number(m[2]) - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * 调 insight agent 生成消费分析
 *
 * ⚠️ 这条路径可能失败，但**绝不能让它让分析页变空白**：
 * agent 内部已注册 fallback，LLM 超时/校验失败/数值对账不过都会退回
 * 纯代码模板结论——每个数字仍来自 bill-stats，只是措辞不如模型灵活。
 */
async function buildInsights({ userId, month, cleaned, droppedCount }) {
  const cur = cleaned[month] || [];
  const hasPrevMonth = !!(cleaned[shiftMonth(month, -1)] || []).length;

  if (!cur.length) {
    return {
      insights: [],
      savings: [],
      isFallback: false,
      // 无数据时明确告知前端「数据不足」而不是返回空数组，
      // 前端要区分「分析失败」与「还没记账」
      _empty: true
    };
  }

  try {
    const res = await harness.invoke({
      agent: 'insight',
      input: `${month} 消费分析`,
      options: {
        month,
        billsByMonth: cleaned,
        billCount: cur.length,
        // 显式传降级开关：与 bill-svc 保持一致，
        // 否则出问题时无法通过 LLM_ENABLED=false 快速切回规则版
        llmEnabled: isLLMEnabled(),
        // 上月无数据时告知模型，避免它凭空描述涨跌
        hasPrevMonth,
        droppedCount,
        userId
      }
    });

    if (res && res.ok && res.data) {
      return {
        insights: res.data.insights || [],
        savings: res.data.savings || [],
        isFallback: !!res.isFallback,
        fallbackReason: res.fallbackReason || ''
      };
    }

    return { insights: [], savings: [], isFallback: true, fallbackReason: 'INVOKE_FAILED' };
  } catch (e) {
    tracer.logEvent('analysis', 'insight_error', { error: e.message });
    // 兜底兜底：agent 自己也失败了，这里用 billStats 直接拼一份结论，
    // 保证「分析页永远有话可说」这条底线
    return {
      insights: buildFallbackInsights(cleaned[month] || [], month),
      savings: [],
      isFallback: true,
      fallbackReason: 'EXCEPTION'
    };
  }
}

/** 极端兜底：连 agent 的 fallback 都用不了时，直接用 stats 拼结论 */
function buildFallbackInsights(bills, month) {
  if (!bills.length) return [];
  const share = billStats.calcCategoryShare(bills);
  const sum = billStats.calcMonthlySummary(bills, month);
  const out = [];
  if (share.items.length) {
    const t = share.items[0];
    out.push(`${t.name}是本月最大的开销，${t.valueYuan} 元，占 ${t.percent}%`);
  }
  out.push(`本月共 ${sum.count} 笔、记了 ${sum.recordedDays} 天，日均 ${sum.avgPerRecordedDayYuan} 元`);
  return out;
}

/** 一级类目名 → 配色 */
function colorOfTop(topName) {
  const found = preset.CATEGORIES.find(
    (c) => c.level === 1 && c.name === topName
  );
  return found ? preset.colorOf(found.id) : preset.DEFAULT_COLOR;
}