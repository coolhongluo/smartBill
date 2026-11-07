/**
 * 语音识别云函数 —— 腾讯云实时语音识别（流式）
 *
 * action：
 *   recognize    从云存储取录音并识别（真实实现，WebSocket 流式）
 *   cleanup      删除录音文件（隐私要求：识别后立即删除）
 *   status       语音通道自检：凭证是否配好、能否识别
 *
 * ## 为什么是腾讯云而不是微信同声传译插件
 *
 * 插件方案（WechatSI, wx069ba97219f66d99）已放弃，两个原因：
 *   1. **仅对非个人主体开放**。个人主体小程序在插件管理里根本搜不到该插件，
 *      微信服务端返回 permission deny（错误码 80082），预览直接失败。
 *   2. **不支持流式上屏**。官方 recordRecoManager 只有 onStart/onStop/onError
 *      三个回调（没有部分博客宣称的 onRecognize），松手才出字。
 *
 * 腾讯云流式 ASR 不挑主体，且支持边说边出字，个人开发者可直接用。
 *
 * ## 必配的环境变量（三个都在云函数环境变量里，**绝不能写进代码或小程序**）
 *
 *   TENCENT_ASR_APP_ID      腾讯云 AppID（API 密钥管理页面获取）
 *   TENCENT_ASR_SECRET_ID   SecretId
 *   TENCENT_ASR_SECRET_KEY  SecretKey
 *   TENCENT_ASR_ENGINE      可选，默认 16k_zh（中文通用）
 *
 * 详见 output/家庭语音记账小程序_可行性专章_v1.md §4.2
 */

const path = require('path');
const asrClient = require('./asr-client');

/** 读取 ASR 凭证，缺失时给出逐项清单 */
function readAsrEnv() {
  return {
    TENCENT_ASR_APP_ID: process.env.TENCENT_ASR_APP_ID,
    TENCENT_ASR_SECRET_ID: process.env.TENCENT_ASR_SECRET_ID,
    TENCENT_ASR_SECRET_KEY: process.env.TENCENT_ASR_SECRET_KEY,
    TENCENT_ASR_ENGINE: process.env.TENCENT_ASR_ENGINE
  };
}

/** 凭证是否齐备 */
function missingEnvKeys(env) {
  return ['TENCENT_ASR_APP_ID', 'TENCENT_ASR_SECRET_ID', 'TENCENT_ASR_SECRET_KEY']
    .filter((k) => !env[k]);
}

/**
 * 任务表：jobId → 识别状态
 *
 * ## 为什么用内存而不是数据库
 *
 * 识别只需几秒到几十秒，前端轮询期间云函数实例大概率还是同一个，
 * 内存足够。落库会带来额外集合与读写成本，不划算。
 *
 * 局限要说清楚：**云函数实例可能被回收或调度到别处**，此时查不到 job。
 * 前端必须能处理「job 丢失」这种情况（提示重试），
 * 而不是无限轮询卡死。expiresAt 就是为此设的。
 */
const JOBS = new Map();

/** 任务保留时长：超时未取结果的直接丢弃，避免内存无限增长 */
const JOB_TTL_MS = 5 * 60 * 1000;

/** 顺手清掉过期任务 */
function sweepJobs() {
  const now = Date.now();
  for (const [id, job] of JOBS) {
    if (job.expiresAt && job.expiresAt < now) JOBS.delete(id);
  }
}

/**
 * 启动识别（立即返回 jobId，不等结果）
 *
 * ## 为什么必须这样设计
 *
 * 小程序调用云函数有**3 秒网关上限**（-504003 FUNCTIONS_TIME_LIMIT_EXCEEDED），
 * 而腾讯云流式识别要求按 1:1 实时率发送音频——10 秒录音就要传10 秒。
 * 同步等待必然超时。
 *
 * 微信官方的标准解法就是「异步 + 轮询」：
 *   ① startRecognize 立刻返回 jobId（毫秒级）
 *   ② 云函数在后台继续跑识别，把结果写入 JOBS
 *   ③ 前端每 1~1.5 秒调 pollResult 取
 *
 * 注意 context.callbackWaitsForEmpty = false —— 不设这句，
 * 云函数会等后台任务结束才返回，3 秒上限照样触发。
 */
function startRecognize({ fileID, cloudPath, durationMs }, context) {
  sweepJobs();

  const env = readAsrEnv();
  const missing = missingEnvKeys(env);
  if (missing.length) {
    return {
      ok: false,
      error: 'ASR_NOT_CONFIGURED',
      message: `腾讯云语音识别未配置，缺少环境变量：${missing.join('、')}。`,
      fallbackable: true
    };
  }
  if (!fileID) {
    return {
      ok: false,
      error: 'ASR_BAD_ARGUMENT',
      message: '缺少 fileID（录音文件标识）。',
      fallbackable: true
    };
  }

  // 关键：不等后台任务。否则云函数会等识别结束才返回，3 秒上限照样爆
  if (context) context.callbackWaitsForEmpty = false;

  const jobId = `asr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  JOBS.set(jobId, {
    status: 'running',
    text: '',
    error: '',
    startedAt: Date.now(),
    expiresAt: Date.now() + JOB_TTL_MS,
    partials: []
  });

  // 后台跑识别：这里必须catch，否则失败会让云函数报未处理异常
  runRecognition(jobId, { fileID, cloudPath, durationMs }, env).catch((e) => {
    console.error('[asr] 后台识别失败', e);
    const job = JOBS.get(jobId);
    if (job) {
      job.status = 'error';
      job.error = e.message || String(e);
    }
  });

  return {
    ok: true,
    jobId,
    // 告诉前端大概要等多久，避免用户以为卡住了
    estimateMs: Math.min(30000, Math.max(3000, (durationMs || 3000) + 2000)),
    pollHint: '每 1~1.5 秒调 pollResult，取到 text 后即完成'
  };
}

/** 后台执行识别，结果写回 JOBS */
async function runRecognition(jobId, { fileID, cloudPath, durationMs }, env) {
  const job = JOBS.get(jobId);
  if (!job) return;

  const text = await asrClient.recognizeStream({
    fileID,
    cloudPath,
    durationMs,
    env,
    onPartial: (t) => {
      const j = JOBS.get(jobId);
      if (j) j.partials.push(t);
    }
  });

  const finalText = String(text || '').trim();

  const done = JOBS.get(jobId);
  if (!done) return; // 已被清理，丢弃结果

  if (!finalText) {
    done.status = 'error';
    done.error = 'EMPTY_RESULT';
    return;
  }

  done.status = 'done';
  done.text = finalText;
  done.confidence = 0.8;
  done.hadPartial = done.partials.length > 1;

  // 识别完立即删除录音（隐私要求）
  cleanup({ fileID }).catch(() => { /* 清理失败不影响结果 */ });
}

/**
 * 轮询识别结果
 *
 * @param {object} args { jobId }
 */
function pollResult({ jobId }) {
  sweepJobs();

  if (!jobId) {
    return { ok: false, error: 'MISSING_JOB_ID', message: '缺少 jobId' };
  }

  const job = JOBS.get(jobId);

  if (!job) {
    // 云函数实例被回收 / 任务已过期。
    // 必须明确返回而不是让前端继续等，否则会无限轮询卡死。
    return {
      ok: false,
      error: 'JOB_EXPIRED',
      message: '识别任务已失效（云函数实例可能被回收）。请重新说一次。',
      retryable: true
    };
  }

  if (job.status === 'running') {
    const elapsed = Date.now() - job.startedAt;
    return {
      ok: true,
      status: 'running',
      elapsed,
      // 超过 45 秒基本可以判定出问题了，别让用户干等
      warn: elapsed > 45000 ? '识别耗时偏长，可能网络较慢' : ''
    };
  }

  if (job.status === 'error') {
    return {
      ok: false,
      error: job.error || 'ASR_FAILED',
      message: job.error === 'EMPTY_RESULT'
        ? '没听清，请靠近麦克风再说一次，或手动输入'
        : `识别失败：${job.error}`,
      retryable: true
    };
  }

  return {
    ok: true,
    status: 'done',
    text: job.text,
    confidence: job.confidence || 0.8,
    hadPartial: job.hadPartial || false
  };
}

exports.main = async (event, context) => {
  const { action, payload = {} } = event || {};

  try {
    switch (action) {
      case 'recognize':
        return await recognize(payload);
      // 长任务模式：小程序端云函数调用有 3 秒网关上限，
      // 而流式识别按 1:1 实时率发送音频，30 秒录音必然超过。
      // 因此立即返回 jobId，识别在后台跑，前端轮询取结果。
      case 'startRecognize':
        return startRecognize(payload, context);
      case 'pollResult':
        return pollResult(payload);
      case 'cleanup':
        return await cleanup(payload);
      case 'status':
      case 'pluginStatus':// 兼容旧调用名
        return status();
      case 'selfTest':
        // 自检：真出问题时用来确认「云函数到底能不能跑通到腾讯云」。
        // 会真正发起一次 WebSocket 握手（用假密钥也能跑到鉴权那一步），
        // 从而把「部署/运行时问题」与「腾讯云侧问题」区分开。
        return await selfTest(payload);
      default:
        return { ok: false, error: `未知操作: ${action}` };
    }
  } catch (e) {
    console.error('[asr-svc]', action, e);
    // 把 message 单独返回：前端要靠它显示具体失败原因。
    // 只回 error 字段的话，前端只能显示「执行失败」，无从排查。
    return {
      ok: false,
      error: e.errorCode || 'ASR_INTERNAL_ERROR',
      message: `${action} 失败：${e.message || '未知错误'}`,
      stack: process.env.NODE_ENV === 'development' ? e.stack : undefined
    };
  }
};

/**
 * 流式识别
 *
 * @param {object} args { fileID, cloudPath, durationMs }
 *   fileID 必须是完整 cloud:// URL（wx.cloud.uploadFile 的返回值），
 *   相对路径（asr/xxx.mp3）会让 downloadFile 报 -503003。
 * @returns {Promise<object>} { ok, text, confidence }
 */
async function recognize({ fileID, cloudPath, durationMs }) {
  const env = readAsrEnv();

  const missing = missingEnvKeys(env);
  if (missing.length) {
    // 用结构化错误码，前端据此判断该不该降级到手动输入
    return {
      ok: false,
      error: 'ASR_NOT_CONFIGURED',
      message: `腾讯云语音识别未配置，缺少环境变量：${missing.join('、')}。` +
        `请在云开发控制台 → 云函数 → asr-svc → 配置 → 环境变量中补齐后重新部署。`,
      fallbackable: true
    };
  }

  if (!fileID) {
    return {
      ok: false,
      error: 'ASR_BAD_ARGUMENT',
      message: '缺少 fileID（录音文件标识）。请确认前端上传后传的是 uploadFile 返回的 fileID。',
      fallbackable: true
    };
  }

  // 流式识别本质是「边收边出」，但云函数与前端是一次性调用关系，
  // 无法真正把中间结果推给前端（那需要 WebSocket 通道 + 额外的长连接服务）。
  //
  // 因此这里的取舍：中间结果只打日志供云端观察，
  // 前端拿到的是最终完整文本。
  // 要做到前端实时上屏，需要 P2 阶段接WebSocket 网关（小程序端长连接）。
  const partials = [];
  const text = await asrClient.recognizeStream({
    fileID,
    cloudPath,
    durationMs,
    env,
    onPartial: (t) => {
      partials.push(t);
      console.log('[asr] 中间结果:', t);
    },
    onFinal: (t) => console.log('[asr] 稳态结果:', t)
  });

  const finalText = String(text || '').trim();

  if (!finalText) {
    return {
      ok: false,
      error: 'EMPTY_RESULT',
      message: '没有识别到语音内容，请靠近麦克风重试或手动输入',
      fallbackable: true
    };
  }

  return {
    ok: true,
    text: finalText,
    // 腾讯云流式识别不返回 confidence。
    // 流式识别本身已完成句末断句（slice_type=2 才是稳态），文本质量较高，
    // 给出偏高的置信度，让它走「确认后入账」而非直接跳过确认。
    confidence: 0.8,
    engine: env.TENCENT_ASR_ENGINE || asrClient.DEFAULT_ENGINE,
    // 是否经历了中间结果迭代，可用于观测识别质量
    hadPartial: partials.length > 1
  };
}

/**
 * 语音通道自检
 *
 * 前端真机连不上、或识别一直失败时，用它区分
 * 「凭证没配」与「网络/音频问题」—— 这两者的排查方向完全不同。
 */
function status() {
  const env = readAsrEnv();
  const missing = missingEnvKeys(env);
  const ready = missing.length === 0;

  // 一并检测 WebSocket：这是流式识别的硬前提，与凭证缺失是两个独立故障。
  // ⚠ 注意：本地 Node 22 有全局 WebSocket，但**云函数运行时没有**。
  //   这里探测的是 ws 包（已写入 package.json），才是云端真正会有的。
  const wsType = typeof asrClient.resolveWebSocket();
  const hasGlobalWs = typeof globalThis.WebSocket === 'function';

  return {
    ok: true,
    ready,
    engine: env.TENCENT_ASR_ENGINE || asrClient.DEFAULT_ENGINE,
    channel: '腾讯云实时语音识别（WebSocket 流式）',
    missing,
    webSocket: wsType === 'function' ? '可用（ws 包）' : '不可用',
    // 把这两个都报出来：本地有全局、依赖 ws 包时，云端表现完全不同
    runtime: process.version,
    globalWebSocket: hasGlobalWs ? '有' : '无（正常，云函数走 ws 包）',
    // 直接告诉用户该做什么，而不是甩一堆环境变量名
    hint: !wsType
      ? '未找到 WebSocket 实现：请确认 asr-svc/package.json 已声明 "ws" 依赖，' +
        '并使用「上传并部署：云端安装依赖」重新部署（普通上传不会带 node_modules）。'
      : ready
        ? '凭证与 WebSocket 均已就绪，可直接录音识别。'
        : `缺少环境变量：${missing.join('、')}。` +
          '请到云开发控制台 → 云函数 → asr-svc → 配置 → 环境变量 补齐后重新部署。'
  };
}

/**
 * 端到端自检——真正发一次 WebSocket 握手
 *
 * ## 为什么需要这个
 *
 * 「云函数测试 status 正常，但小程序识别失败」说明问题出在 status 之后：
 * 音频下载、WebSocket 连接、腾讯云鉴权、协议交互这几步之一。
 * status 只检查了凭证存在与WebSocket 可用，覆盖不到这些。
 *
 * 这个自检会用**当前环境变量里的真实凭证**发起一次握手
 * （不发送音频，只等握手响应）：
 *   · 握手成功 → 说明部署、运行时、签名、凭证全部正常，问题在音频或前端
 *   · 4003→ 腾讯云服务未开通
 *   · 4002 → 签名/密钥错误
 *   · 0但随后断开 → 协议层问题
 *
 * 这样一次调用就能把范围缩到很小，不用反复试真实录音。
 */
async function selfTest() {
  const env = readAsrEnv();
  const missing = missingEnvKeys(env);
  if (missing.length) {
    return { ok: false, error: 'ASR_NOT_CONFIGURED', missing };
  }

  // 探测 ws 包是否装上——这是流式识别的硬前提。
  // 注意不能只看全局 WebSocket：本地 Node 22 有，但云函数运行时没有，
  // 云端真正会用的是 ws 包。
  const wsCtor = asrClient.resolveWebSocket();
  if (typeof wsCtor !== 'function') {
    return {
      ok: false,
      error: 'NO_WEBSOCKET',
      runtime: process.version,
      message: '未找到 WebSocket 实现。请确认 asr-svc/package.json 已声明 "ws" 依赖，' +
        '并使用「上传并部署：云端安装依赖」重新部署（普通上传不带 node_modules，ws 不会装上）。'
    };
  }

  // 复用真实连接逻辑：会用当前凭证算签名并发起握手
  const crypto = require('crypto');
  const appId = env.TENCENT_ASR_APP_ID;
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = Math.floor(Math.random() * 9000000000) + 1000;

  const query = {
    engine_model_type: env.TENCENT_ASR_ENGINE || asrClient.DEFAULT_ENGINE,
    secretid: env.TENCENT_ASR_SECRET_ID,
    timestamp,
    expired: timestamp + 24 * 3600,
    nonce,
    voice_id: crypto.randomUUID(),
    voice_format: String(asrClient.FORMAT_MP3),
    needvad: '1',
    filter_dirty: '0',
    filter_punc: '0',
    filter_modal: '0',
    word_info: '0'
  };

  const signature = asrClient.buildSignature({
    appId,
    secretId: env.TENCENT_ASR_SECRET_ID,
    secretKey: env.TENCENT_ASR_SECRET_KEY,
    query
  });

  const qs = Object.keys(query)
    .sort()
    .map((k) => `${k}=${encodeURIComponent(query[k])}`)
    .join('&');
  const url = `wss://asr.cloud.tencent.com/asr/v2/${appId}?${qs}&signature=${signature}`;

  return new Promise((resolve) => {
    let done = false;
    let socket = null;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (socket) socket.close();
      resolve(r);
    };

    // 30 秒兜底：握手通常 1-2 秒，久等无意义
    const timer = setTimeout(
      () => finish({ ok: false, error: 'HANDSHAKE_TIMEOUT', message: '30 秒未收到握手响应，请检查网络与腾讯云服务状态' }),
      30000
    );

    try {
      // 用同一套封装，避免 selfTest 与主流程在 WebSocket 实现上出现分歧
      socket = asrClient.openSocket(url, {
        onOpen: () => {
          console.log('[asr-selfTest] WebSocket 已连接（握手成功）');
        },

        onMessage: (text) => {
          let msg;
          try {
            msg = JSON.parse(text);
          } catch (e) {
            return finish({ ok: false, error: 'BAD_MESSAGE', raw: String(text).slice(0, 200) });
          }

          if (msg.code === 0) {
            // 握手成功 = 部署、运行时、签名、凭证全部正常
            finish({
              ok: true,
              handshake: '成功',
              code: msg.code,
              voiceId: msg.voice_id,
              message: '握手成功：部署、运行时、签名、凭证均正常。若小程序仍识别失败，问题在音频上传或前端调用环节。'
            });
          } else {
            const advice = {
              4002: '签名或密钥错误：请检查 TENCENT_ASR_SECRET_ID / SECRET_KEY 是否填错',
              4003: 'AppID 未开通语音识别服务：请到腾讯云控制台开通',
              4004: '额度耗尽：请开通后付费或购买资源包',
              4005: '账户欠费：请充值',
              4006: '并发超限'
            };
            finish({
              ok: false,
              code: msg.code,
              error: 'HANDSHAKE_REJECTED',
              message: msg.message,
              advice: advice[msg.code] || '请查阅腾讯云语音识别错误码文档'
            });
          }
        },

        onError: (e) => {
          finish({ ok: false, error: 'WS_ERROR', message: (e && e.message) || '连接失败' });
        },

        onClose: (code) => {
          if (!done) finish({ ok: false, error: 'WS_CLOSED', code, message: '连接被关闭，未收到握手响应' });
        }
      });
    } catch (e) {
      // openSocket 失败通常是 ws 包没装
      finish({ ok: false, error: 'WS_CREATE_FAILED', message: e.message });
    }
  });
}

/**
 * 清理录音
 *
 * 隐私要求：录音仅用于生成记账条目，用完即删。
 * 这里是兜底——正常流程在前端识别后就会删，
 * 但前端崩溃/断网时可能留下残留，因此需要服务端清理机制。
 *
 * ⚠ 云函数里没有全局 cloud，必须走 wx-server-sdk
 * （这坑 db 层已经踩过一次：typeof cloud !== 'undefined' 恒为 false）
 */
async function cleanup({ fileID, cloudPath }) {
  // deleteFile 同样只认完整 fileID
  const target = fileID || cloudPath;
  if (!target) return { ok: true, deleted: 0 };

  const sdkBoot = require(path.join(__dirname, 'shared', 'db', 'sdk.js'));
  const sdk = sdkBoot.ensureSdk();
  if (!sdk) {
    return {
      ok: false,
      error: `wx-server-sdk 不可用，无法清理云文件：${sdkBoot.getInitError() || '未知原因'}`
    };
  }

  try {
    const files = [].concat(target);
    let deleted = 0;
    for (const f of files) {
      try {
        await sdk.deleteFile({ fileList: [f] });
        deleted++;
      } catch (e) {
        console.warn('[asr-svc] 删除失败', f, e.message);
      }
    }
    return { ok: true, deleted };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}