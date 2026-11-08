/**
 * 云开发调用封装
 *
 * 为什么必须封装而不是各处直接 wx.cloud.callFunction：
 * 1. 统一失败语义 —— 云函数返回 { ok, error }，这里统一转成异常或 null，
 *    避免每个页面各写一套 if 判断，最终必然出现漏判。
 * 2. 统一耗时观测 —— 真机网络远慢于模拟器，必须能区分
 *    「接口慢」和「接口错」，否则线上问题无法定位。
 * 3. 统一降级 —— 云函数未部署时给出可操作的提示，而非空白页。
 */

let cloudReady = false;

/**
 * 本地期望的云函数代码版本
 *
 * ⚠ 每次改动 cloudfunctions/ 下的代码，请同步更新这里。
 * 否则前端会一直提示「云端版本过旧」，那是误报。
 * 值必须与 cloudfunctions/shared/util/constants.js 的 CODE_VERSION 一致。
 */
const EXPECTED_CODE_VERSION = '20261108-01';

/**
 * 对账云端代码版本 —— 只警告，不阻断（2026-11-03 起）
 *
 * 原本不一致会 throw，把整次调用挡掉。但小程序有「已发布线上版」：
 * 云端一部署新版本，线上版（冻结的旧 EXPECTED_CODE_VERSION）的每次
 * 调用都会撞上跨日期版本差 → 在「云端部署完成 → 新版发布」的窗口期内
 * 旧版用户功能整段不可用，而窗口长短取决于审核节奏、不可控。
 * 2026-11-03 决定：改为只 console.warn + 保留诊断面板比对，
 * 「本地改了没部署」依然能从真机日志/诊断面板看出来，但不拦用户。
 *
 * ## 为什么仍要区分「谁更新」
 * 云端旧 → 要部署云函数；云端新 → 要重新编译小程序。
 * 方向性建议写进 warn 文案，排查时不用再猜。
 */
function warnCodeVersion(result) {
  const remote = result && result.codeVersion;
  if (!remote) return; // 老版本云函数还没这个字段，不打扰
  if (remote === EXPECTED_CODE_VERSION) return;

  // 版本号形如 20261018-14，按 '-' 拆成 [日期, 序号]，后者是可比的数字。
  // 不用字符串比较：'20261018-9' > '20261018-14' 在字符串比较下成立，是错的。
  const parse = (v) => {
    const m = String(v).match(/^(\d{8})-(\d+)$/);
    return m ? { date: m[1], seq: parseInt(m[2], 10) } : null;
  };

  const r = parse(remote);
  const l = parse(EXPECTED_CODE_VERSION);

  // 版本号格式不认识（比如云端跑了别的分支）→ 只陈述事实，不给方向性建议
  if (!r || !l || r.date !== l.date) {
    console.warn(`[cloud] 版本不一致（不阻断）：云端=${remote} 本地=${EXPECTED_CODE_VERSION}`);
    return;
  }

  const remoteIsOlder = r.seq < l.seq;

  if (remoteIsOlder) {
    console.warn(
      `[cloud] 云端版本过旧（不阻断）：云端=${remote} 本地=${EXPECTED_CODE_VERSION}。` +
      `若功能异常，请右键 cloudfunctions/bill-svc →「上传并部署：云端安装依赖」`
    );
    return;
  }

  // 云端更新：说明本地小程序包是旧的
  console.warn(
    `[cloud] 本地包版本过旧（不阻断）：云端=${remote} 本地=${EXPECTED_CODE_VERSION}。` +
    `若功能异常，请重新编译小程序`
  );
}

/**
 * 初始化云开发
 * @param {string} envId 云环境 ID，留空用默认环境
 */
function initCloud(envId) {
  if (!wx.cloud) {
    throw new Error('当前基础库版本过低，不支持云开发。请在开发者工具中将基础库版本调至 2.2.3 及以上');
  }

  const options = { traceUser: true };
  if (envId) options.env = envId;

  wx.cloud.init(options);
  cloudReady = true;
}

/**
 * 调用云函数
 * @param {string} name 云函数名
 * @param {object} payload 业务参数
 * @param {object} opts { timeout, loadingText }
 * @returns {Promise<any>} 云函数返回的 data；失败抛异常
 */
async function callFunction(name, payload = {}, opts = {}) {
  if (!cloudReady) {
    throw new Error('云开发未初始化');
  }

  if (opts.loadingText) {
    wx.showLoading({ title: opts.loadingText, mask: true });
  }

  const startedAt = Date.now();

  /**
   * 客户端超时兜底
   *
   * 为什么要自己兜：wx.cloud.callFunction 的超时**不可配置**，
   * 长耗时任务（如跑 LLM 的分析，10 秒起）只能由我们主动放弃，
   * 否则用户只能干等平台报 -504003 才知道失败。
   *
   * 重要：这只放弃「等待」，**云函数仍会跑完并落库**，
   * 所以下次读结果时数据其实已经在了。
   */
  const timeoutMs = Number(opts.timeout) > 0 ? Number(opts.timeout) : 0;
  const callPromise = wx.cloud.callFunction({ name, data: payload });

  let timer = null;
  let timedOut = false;

  try {
    let res;
    if (timeoutMs > 0) {
      // 超时分支与正常分支竞争；Promise.race 不会取消落败的分支，
      // 但给它挂上 catch 避免 unhandledRejection
      const timeoutBranch = new Promise((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new Error(`${name} 等待超时（已等 ${timeoutMs}ms）。分析可能仍在云端继续，稍后刷新即可看到结果`));
        }, timeoutMs);
      });
      callPromise.catch(() => { /* 交由 race 处理，避免 unhandledRejection */ });
      res = await Promise.race([callPromise, timeoutBranch]);
    } else {
      res = await callPromise;
    }

    const cost = Date.now() - startedAt;
    // 真机日志是这个项目唯一可靠的观测手段，必须打全
    console.log(`[cloud] ${name} ${JSON.stringify(payload.action || '')} 耗时${cost}ms`);

    const result = res.result;

    // 云函数内部异常（throw）时 result 可能是 undefined
    if (!result) {
      throw new Error(`${name} 无返回，检查云函数是否部署成功及日志`);
    }

    // 版本对账只警告不阻断（2026-11-03 起）：真机日志与诊断面板
    // 仍能看到版本差异，但不挡业务结果。diag 例外——诊断输出本身已含版本号。
    if (payload.action !== 'diag') {
      warnCodeVersion(result);
    }

    if (result.ok === false) {
      // 云函数失败时可能带三类信息，**全部**要带出去：
      //   error   机器可读的错误码（如 ASR_NOT_CONFIGURED）
      //   message 给人看的详细说明（含第三方服务的原始报错）
      //   hint    下一步该做什么
      // 只拼 error + hint 会把 message 丢掉——而 message 往往才是定位问题的关键，
      // 导致前端只剩一句「执行失败」，无法排查。
      const detail = [result.error, result.message, result.hint].filter(Boolean).join('\n');
      const err = new Error(detail || `${name} 执行失败`);
      // 结构化字段挂到 error 上，调用方可直接判断而不用正则匹配文案
      err.errorCode = result.error;
      err.hint = result.hint;
      err.raw = result;
      throw err;
    }
    return result;
  } catch (e) {
    const cost = Date.now() - startedAt;
    console.error(`[cloud] ${name} 失败(${cost}ms)`, e);

    // 区分「云函数不存在」与「业务逻辑报错」，前者是部署问题，
    // 用户按业务提示去排查会完全走错方向
    const msg = String(e.errMsg || e.message || '');
    if (/FUNCTION_NOT_FOUND/.test(msg) || /function.*not\s*found/i.test(msg)) {
      throw new Error(`${name} 未部署。请在开发者工具中右键 cloudfunctions/${name}，选择「上传并部署：云端安装依赖」`);
    }
    if (/Cannot find module/i.test(msg)) {
      // -504002 FUNCTION_EXECUTE_FAIL 会被平台包装成统一文案，
      // 原始原因（通常是某个模块没打进包）被吞掉，
      // 这里只给出「最可能的原因 + 对应动作」，不去猜具体是哪个模块
      throw new Error(
        `${name} 内部缺少文件（云端返回 -504002）。` +
        `最常见原因：改了 cloudfunctions/shared/ 下的代码但没重新同步。` +
        `请在项目根目录执行 npm run prepare:cf，再右键 ${name} 重新「上传并部署：云端安装依赖」。` +
        `若仍失败，检查 ${name}/node_modules/shared 目录是否存在。`
      );
    }
    if (/-504002|FUNCTION_EXECUTE_FAIL/i.test(msg)) {
      throw new Error(
        `${name} 执行失败（-504002）。请到云开发控制台 → 云函数 → ${name} → 日志 查看具体堆栈。`
      );
    }
    if (/timeout/i.test(msg) || /Timeout/i.test(msg)) {
      // ⚠️ 必须区分两种超时：
      //   客户端主动放弃（我们等够了）vs 平台/服务端超时（-504003）。
      // 前者云函数通常还在跑并会落库，提示用户「升级套餐」会把人引向错误的操作。
      if (timedOut) {
        throw new Error(e.message || `${name} 等待超时`);
      }
      throw new Error(`${name} 服务端超时（-504003）。请到云开发控制台 → 云函数 → ${name} → 配置 里调大超时时间并重新部署`);
    }
    throw e;
  } finally {
    // 计时器必须清理：否则每次调用都留一个 pending 的 setTimeout，
    // 页面久了会累积成百上千个定时器，吃内存并拖慢渲染。
    if (timer) clearTimeout(timer);
    if (opts.loadingText) wx.hideLoading();
  }
}

/**
 * 记账主链路
 *
 * ledger 参数（家庭模式双空间）：'personal' | 'family' | 缺省。
 * 缺省 = personal，云端走零新增查询的旧路径；
 * 家庭归属的权威在云端（profile.familyId 反查），前端只传开关。
 */
function record(asrText, asrConfidence, ledger) {
  return callFunction('bill-svc', {
    action: 'record',
    payload: { asrText, asrConfidence, ledger }
  });
}

/** 事后补记 */
function recall(date, candidates, chosenIndex, ledger) {
  return callFunction('bill-svc', {
    action: 'recall',
    payload: { date, candidates, chosenIndex, ledger }
  });
}

/**
 * 手动直填入账（金额 + 类目 + 备注，跳过 LLM）
 *
 * 为什么需要独立入口而不是复用 recall：
 *   recall 的语义是「事后补记」，会打 isRecall 标记并记录补记天数，
 *   用它承载「今天的主动手动记账」会污染补记转化率等埋点指标。
 */
function manualRecord({ amountCent, categoryId, categoryPath, date, note, account, ledger }) {
  return callFunction('bill-svc', {
    action: 'manual',
    payload: { amountCent, categoryId, categoryPath, date, note, account, ledger }
  });
}

/** 取完整类目树（手动选类目用） */
function categoryTree() {
  return callFunction('category-svc', { action: 'tree' });
}

/** 关键词搜索类目（手动选类目时用于快速定位） */
function categorySearch(keyword) {
  return callFunction('category-svc', { action: 'search', payload: { keyword } });
}

/**
 * 新增自定义类目（「类目不匹配可自主新增」，支持一级/二级/三级全层级）
 *
 * level: 1|2|3。level=1 不需要 parentId；level=2 传一级 id；level=3 传二级 id。
 * 不传 level 走兼容模式（挂一级下的末级）——仅旧入口使用，新代码请显式传。
 *
 * 与 tree/search 不同：create 需要 openid（云函数从 getWXContext 取），
 * 本地模拟器没登录态时云端会明确报错，不静默降级——
 * 用户建类目是显式动作，失败必须让用户知道。
 */
function createCategory({ name, level, parentId }) {
  return callFunction('category-svc', { action: 'create', payload: { name, level, parentId } });
}

/** 解析一段文本（手动输入的「文字模式」用，走与语音完全相同的 AI 链路） */
function parseText(text, ledger) {
  return callFunction('bill-svc', {
    action: 'record',
    payload: { asrText: text, asrConfidence: 0.9, ledger }
  });
}

/**
 * 本月概览（首页顶部数字）
 * ledger 透传给 analysis-svc（家庭账本 = 全家聚合）
 */
function monthSummary(ledger) {
  return callFunction('analysis-svc', { action: 'monthSummary', payload: { ledger } });
}

/** 数据库诊断：一次性验证环境/身份/集合可读/写入/读回 */
function diag() {
  return callFunction('bill-svc', { action: 'diag' }, { timeout: 15000 });
}

/**
 * 静默登录 + 自动注册（幂等）
 *
 * 小程序无显式登录页：openid 由云端 getWXContext 静默提供，
 * 首调即自动建用户档案。app.js onLaunch 调用，失败不阻断启动。
 */
function login() {
  return callFunction('user-svc', { action: 'login' });
}

/**
 * 更新可选资料（昵称/头像）
 * 未填的字段不要传 —— 云端只接受非空字符串
 */
function updateProfile(payload) {
  return callFunction('user-svc', { action: 'updateProfile', payload });
}

/**
 * 家庭模式（user-svc）
 *
 * 家庭归属的权威在云端（profile.familyId），前端一律不传 familyId ——
 * 传了也会被忽略，防止伪造身份读写别人的家庭数据。
 */
function familyCreate(name) {
  return callFunction('user-svc', { action: 'familyCreate', payload: { name } });
}

function familyJoin(inviteCode) {
  return callFunction('user-svc', { action: 'familyJoin', payload: { inviteCode } });
}

function familyInfo() {
  return callFunction('user-svc', { action: 'familyInfo' });
}

function familyMembers() {
  return callFunction('user-svc', { action: 'familyMembers' });
}

function familyLeave() {
  return callFunction('user-svc', { action: 'familyLeave' });
}

/** 重新生成邀请码（仅创建者；旧码立即失效） */
function familyRegenCode() {
  return callFunction('user-svc', { action: 'familyRegenCode' });
}

/** 解散家庭（仅创建者；软删除，历史账单保留在库） */
function familyDissolve() {
  return callFunction('user-svc', { action: 'familyDissolve' });
}

/** 编辑/撤销 */
function amend(payload) {
  return callFunction('bill-svc', { action: 'amend', payload });
}

/**
 * 重复记账规则（recurring）
 *
 * 规则只是「配置」，账单由云端 dailyRecurring 定时触发器每天 0:30 生成，
 * 前端不参与生成环节 —— 这些接口只管建/查/改/暂停/删规则本身。
 * 自动生成的账单在明细页带「自动」标记（source='auto'）。
 */
function ruleCreate(payload) {
  return callFunction('bill-svc', { action: 'ruleCreate', payload });
}

function ruleList() {
  return callFunction('bill-svc', { action: 'ruleList' });
}

function ruleUpdate(payload) {
  return callFunction('bill-svc', { action: 'ruleUpdate', payload });
}

/** 暂停（paused=true）或恢复（paused=false）；恢复不补记，从明天起继续 */
function rulePause(ruleId, paused) {
  return callFunction('bill-svc', { action: 'rulePause', payload: { ruleId, paused } });
}

/** 软删除规则；已生成的账单保留 */
function ruleDelete(ruleId) {
  return callFunction('bill-svc', { action: 'ruleDelete', payload: { ruleId } });
}

/**
 * 读取消费分析结果（**不触发分析**，毫秒级返回）
 *
 * 分析结果由记账后异步生成并存好，这里只读。
 * 所以打开分析页不需要等 LLM，也不需要额外 loading 很久。
 */
function readInsight(ledger) {
  return callFunction('analysis-svc', { action: 'categoryBreakdown', payload: { ledger } });
}

/**
 * 手动触发一次分析（分析页的「立即重新分析」按钮）
 *
 * ⚠️ 这条会跑 LLM，耗时 10 秒起，所以 timeout 单独放宽。
 * 记账后的自动触发不走这里（那是云函数内部直连），不受这条限制。
 */
function refreshInsight(ledger) {
  return callFunction('analysis-svc', { action: 'refreshInsight', payload: { ledger } }, { timeout: 40000 });
}

/**
 * 分析链路诊断
 *
 * ## 为什么单独要一个
 *
 * 「界面显示规则版分析」有好几种原因：
 * 代码没部署 / Key 没配 / 读到的是旧结果 / LLM 被关 / 模型调用失败。
 * 靠猜会浪费大量时间——每次排查都要翻控制台看日志。
 *
 * 这个接口一次性给出答案，且**包含一次真实的模型调用**，
 * 所以它验的是「现在到底能不能用」，而不只是「环境变量配了没」。
 *
 * ⚠️ timeout 放宽到 40 秒：诊断里含一次真实模型请求。
 */
function analysisDiag() {
  return callFunction('analysis-svc', { action: 'diag' }, { timeout: 40000 });
}

module.exports = {
  initCloud, callFunction, record, recall, amend,
  manualRecord, categoryTree, categorySearch, createCategory, parseText, monthSummary, diag,
  login, updateProfile,
  familyCreate, familyJoin, familyInfo, familyMembers, familyLeave, familyRegenCode, familyDissolve,
  readInsight, refreshInsight, analysisDiag,
  ruleCreate, ruleList, ruleUpdate, rulePause, ruleDelete,
  EXPECTED_CODE_VERSION
};