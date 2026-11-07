/**
 * 语音输入 —— 腾讯云流式 ASR（云函数）+ 手动输入（兜底）
 *
 * ## 为什么放弃微信同声传译插件
 *
 * 曾用 WechatSI（wx069ba97219f66d99），两个致命问题：
 *   1. **仅非个人主体可用**。个人主体小程序在插件管理里搜不到该插件，
 *      服务端返回 permission deny（错误码 80082），预览直接失败——
 *      而且这个错误不会提示你去后台申请，看起来像配置写错了。
 *   2. **不支持流式上屏**。官方 recordRecoManager 只有 onStart/onStop/onError
 *      三个回调（注意：没有部分资料宣称的 onRecognize），松手才出字。
 *
 * 腾讯云实时语音识别不挑主体，且是真正的流式，记账场景也够用。
 *
 * ## 关键体验约束（设计文档 §4.3.1）
 *
 * 松手后 **300ms 内必须有可见反馈**，绝不能让用户面对空白等待。
 * 因此 onStop 里**立即**置为「识别中」，而不是拿到文本后才置——
 * 后者会让用户以为没反应。
 *
 * ## 关于「实时上屏」
 *
 * 腾讯云是流式识别，会持续返回中间结果。但小程序→云函数是一次性调用，
 * 中间结果无法实时推回前端（需要 WebSocket 网关 + 小程序长连接，属P2）。
 * 当前实现：中间结果输出到云端日志供观测，前端在识别完成后一次性显示。
 * 这与插件方案的体验一致，但换来了不挑主体 + 更准的识别。
 */

const { callFunction } = require('./cloud.js');

/** ASR 通道 */
const ASR_CHANNEL = {
  CLOUD: 'cloud',        // 腾讯云流式 ASR（主力）
  MANUAL: 'manual'       // 手动输入（兜底）
};

/**
 * 录音参数 —— 固定不可调（可行性专章 §4.1）
 *   AAC：iOS 必须
 *   16000Hz：8kHz 会导致「四十/事实」混淆；48kHz 无增益
 *   单声道：语音识别不需要立体声，可减小体积
 *   30s 上限：超过就该分笔记，而非无限录音
 *
 * 编码与腾讯云识别引擎匹配：mp3 + 16k 对应 16k_zh 引擎。
 */
const RECORDER_OPTIONS = {
  duration: 30000,
  sampleRate: 16000,
  numberOfChannels: 1,
  encodeBitRate: 48000,
  format: 'mp3'
};

/** 状态机 */
const STATE = {
  IDLE: 'idle',
  RECORDING: 'recording',
  RECOGNIZING: 'recognizing',
  DONE: 'done',
  FAILED: 'failed'
};

/**
 * 把云函数返回的错误翻译成用户能理解的话
 *
 * 为什么需要：asr-svc 返回的是给开发者看的结构化错误码，
 * 直接弹给用户等于让他拿着 'ASR_NOT_CONFIGURED' 去搜索。
 */
function explainAsrError(err) {
  const code = err && err.errorCode;
  const msg = String((err && (err.message || err.errMsg)) || '');

  // 结构化错误码（来自 utils/cloud.js 挂载的 errorCode）
  if (code === 'ASR_NOT_CONFIGURED') {
    return '语音识别服务未配置腾讯云凭证，请在 asr-svc 云函数环境变量中补齐后重新部署';
  }
  if (code === 'EMPTY_RESULT') {
    return '没听清，请靠近麦克风再说一次，或手动输入';
  }
  if (code === 'ASR_EMPTY_RESPONSE') {
    return msg || '云函数已返回但没有识别文字，请检查云函数日志';
  }
  if (code === 'JOB_EXPIRED' || code === 'ASR_JOB_LOST') {
    return '识别任务已失效（云函数实例可能被回收），请重新说一次';
  }
  if (code === 'ASR_POLL_TIMEOUT') {
    return msg || '等待识别结果超时，请重试或手动输入';
  }
  if (code === 'ASR_POLL_FAILED') {
    return msg || '查询识别结果失败，请检查网络后重试';
  }
  if (code === 'ASR_NO_JOB') {
    return msg || '未能启动识别任务，请手动输入';
  }
  if (code === 'ASR_BAD_ARGUMENT') {
    return msg || '录音文件标识无效，请重新说一次';
  }

  // 3 秒网关上限：即使改了异步模式也可能遇到（例如云函数冷启动超时）
  if (/TIME_LIMIT_EXCEEDED|-504003/.test(msg)) {
    return '云函数响应超时（首次调用可能需要冷启动），请再试一次或手动输入';
  }
  if (code === 'ASR_INTERNAL_ERROR') {
    return `云函数内部错误：${msg}\n\n请把这段报错发给开发者。`;
  }

  // 腾讯云 ASR 错误码（4001~6001，见官方文档）
  const asrCode = msg.match(/ASR 错误\s*(\d+)/);
  if (asrCode) {
    const map = {
      4000: '音频发送过快，请重试',
      4001: '语音识别参数不合法，请检查引擎配置',
      4002: '腾讯云鉴权失败，请检查云函数中的 SecretId / SecretKey 是否正确',
      4003: '腾讯云语音识别服务未开通，请到腾讯云控制台开通',
      4004: '语音识别额度已用尽，请在腾讯云开通后付费或购买资源包',
      4005: '腾讯云账户欠费，请及时充值',
      4006: '语音识别并发超限，请稍后重试',
      4007: '音频格式不匹配，请确认录音参数与识别引擎一致',
      4008: '音频上传超时，请重试',
      4009: '语音识别连接被断开，请重试',
      4010: '语音识别协议错误',
      5000: '语音识别服务繁忙，请稍后重试',
      5001: '语音识别服务繁忙，请稍后重试',
      5002: '语音识别服务繁忙，请稍后重试',
      6001: '境外服务调用受限，请在境内使用或切换国际站账号'
    };
    const c = asrCode[1];
    return (map[c] || `语音识别失败（腾讯云错误 ${c}）`) + '，请手动输入';
  }

  // WebSocket 运行时不支持
  if (/WebSocket/.test(msg)) {
    return '云函数运行时不支持 WebSocket，请检查 asr-svc 的 runtime 配置';
  }
  if (/FUNCTION_NOT_FOUND|not\s*found|未部署/i.test(msg)) {
    return 'asr-svc 未部署，请右键 cloudfunctions/asr-svc →「上传并部署：云端安装依赖」';
  }
  if (/timeout|超时/i.test(msg)) {
    return '语音识别超时，请重试或手动输入';
  }
  if (/upload|上传/i.test(msg)) {
    return '录音上传失败，请检查网络后重试';
  }

  // ⚠ 兜底时保留原始信息，不要把真实原因藏起来。
  // 只回一句「识别失败」的话，用户和开发者都无从下手。
  const detail = msg.length > 120 ? `${msg.slice(0, 120)}…` : msg;
  return detail
    ? `语音识别失败：${detail}\n\n可改用手动输入，或把这段报错发给开发者。`
    : '语音识别失败，请手动输入';
}

/**
 * 把录音错误翻译成可执行的动作
 *
 * 为什么必须翻译：wx.getRecorderManager 在真机上的 errMsg 是一串英文，
 * 用户看到 "operateRecorder:fail recorder not start" 根本不知道该做什么。
 * 而真机高频失败原因其实就那几类，每一类都有明确解法。
 */
function explainRecorderError(err) {
  const msg = String((err && (err.errMsg || err.message)) || '');

  // 真机上最常见的坑：权限被拒但没走 authorize 流程
  if (/auth|permission|deny/i.test(msg)) {
    return '麦克风权限被拒绝，请在「小程序 → 我的 → 设置」中手动开启录音权限';
  }
  // iOS 上并发调用 recorder 会报这个
  if (/not start|already start|busy/i.test(msg)) {
    return '录音器状态异常，请退出小程序重新进入后重试';
  }
  // 模拟器/开发者工具不支持录音
  if (/simulator|emulator|not supported/i.test(msg)) {
    return '开发者工具不支持录音，请用真机预览测试';
  }
  // 采样率/编码参数不被当前设备支持
  if (/sample|format|codec|param/i.test(msg)) {
    return `录音参数不被当前设备支持：${msg}`;
  }
  return msg || '录音失败，请检查麦克风是否被其他应用占用';
}

class VoiceInput {
  /**
   * @param {object} handlers { onStateChange, onPartial, onResult, onError }
   */
  constructor(handlers = {}) {
    this.handlers = handlers;
    this.state = STATE.IDLE;
    this.recorder = null;
    this.channel = ASR_CHANNEL.CLOUD;
    this.startedAt = 0;
    // 手动兜底时暂存录音文件，供用户改口重试
    this.lastFilePath = null;
    // 正在申请权限并启动录音的标志。
    // 权限申请是异步的，这期间用户可能再次按下或松手，
    // 没有这两个标记就会出现并发 start / 录音器卡住不放。
    this.starting = false;
    this.cancelRequested = false;
  }

  init() {
    if (this.recorder) return;
    const recorder = wx.getRecorderManager();

    recorder.onStart(() => {
      this.startedAt = Date.now();
      this._setState(STATE.RECORDING);
    });

    recorder.onStop((res) => {
      // 关键：先置识别中，再做任何耗时操作。
      // 这一行决定了用户感受到的是「秒回」还是「卡住」
      this._setState(STATE.RECOGNIZING);
      this.lastFilePath = res.tempFilePath;

      const duration = Date.now() - this.startedAt;
      this.recognize(res.tempFilePath, duration);
    });

    recorder.onError((err) => {
      console.error('[voice] 录音错误', err);
      this._fail(explainRecorderError(err));
    });

    this.recorder = recorder;
  }

  /**
 * 请求录音权限
 *
 * ## 为什么必须把原因带出来（踩过才知道）
 *
 * 原来这里 `catch (e) { return false }` —— 不管是用户拒绝、弹窗失败还是
 * getSetting 异常，一律返回 false，上层统一提示「未获得录音权限」。
 * 症状是「按录音按钮就失败」，但真机上的真实原因可能是：
 *   · 用户之前拒绝过（需要引导去设置页，直接 authorize 无效）
 *   · 开发者工具里勾了「不校验合法域名」但真机没开
 *   · iOS 上首次 authorize 与 getSetting 存在时序竞争
 *   · AppID 权限不足
 * 全部被压成同一句话，等于让人瞎猜。
 *
 * 现在返回 { granted, reason }，把真实原因带到 UI 上。
 *
 * @returns {Promise<{granted: boolean, reason: string}>}
 */
async ensurePermission() {
  try {
    const granted = await new Promise((resolve, reject) => {
      wx.getSetting({
        success: (s) => {
          const auth = s.authSetting || {};

          if (auth['scope.record'] === true) {
            resolve(true);
          } else if (auth['scope.record'] === false) {
            // 用户曾经拒绝过。此时 wx.authorize 无效，必须引导去设置页手动开启。
            wx.showModal({
              title: '需要录音权限',
              content: '语音记账需要录音权限。请点「去设置」手动开启麦克风权限。',
              confirmText: '去设置',
              success: (r) => {
                if (r.confirm) {
                  wx.openSetting({
                    success: (rs) => {
                      const ok = (rs.authSetting || {})['scope.record'] === true;
                      resolve(ok);
                      if (!ok) reject(new Error('在设置页也未开启录音权限'));
                    },
                    fail: () => reject(new Error('打开设置页失败'))
                  });
                } else {
                  reject(new Error('用户拒绝开启录音权限'));
                }
              },
              fail: () => reject(new Error('权限提示弹窗失败'))
            });
          } else {
            // 从未授权过，直接申请
            wx.authorize({
              scope: 'scope.record',
              success: () => resolve(true),
              fail: (err) => {
                // 真机上「用户取消」与「系统拒绝」errMsg 不同，分开说
                const m = (err && err.errMsg) || '';
                if (/cancel/i.test(m)) reject(new Error('用户取消了授权'));
                else if (/auth deny|authorize:fail/i.test(m)) reject(new Error('系统拒绝录音授权，请在设置中手动开启'));
                else reject(new Error(`申请录音权限失败：${m || '未知原因'}`));
              }
            });
          }
        },
        fail: (err) => reject(new Error(`获取授权状态失败：${(err && err.errMsg) || '未知'}`))
      });
    });

    return { granted, reason: granted ? '' : '未获得录音权限' };
  } catch (e) {
    // 关键：把真实原因带出去，不要压成「未获得录音权限」
    console.warn('[voice] 权限检查失败:', e.message);
    return { granted: false, reason: e.message || '录音权限检查失败' };
  }
}

/** 开始录音 */
async start() {
  if (this.state === STATE.RECORDING) return;

  // 先注册监听再申请权限：authorize 会弹窗，弹窗期间用户可能松手，
  // 监听注册太晚会漏掉 onStop/onError，表现为「按了没反应」
  this.init();

  // 正在启动标记：权限申请是异步的，期间用户可能再次按下按钮。
  // 没有这个标记会并发调两次 start()，第二次必然报
  // "is recording or paused"。
  if (this.starting) return;
  this.starting = true;

  let granted = false;
  try {
    const r = await this.ensurePermission();
    granted = r.granted;
    if (!granted) {
      this._fail(r.reason);
      return;
    }

    // 等待权限期间用户可能已松手 → 取消本次启动，别留下开着的录音器
    if (this.cancelRequested) {
      this.cancelRequested = false;
      this._stopRecorderQuietly();
      return;
    }

    this.recorder.start(RECORDER_OPTIONS);
  } catch (e) {
    this._fail(`启动录音失败：${e.message || e.errMsg || '未知错误'}`);
  } finally {
    this.starting = false;
  }
}

/** 静默停止录音器（不出错、不打扰用户） */
_stopRecorderQuietly() {
  if (!this.recorder) return;
  try {
    this.recorder.stop();
  } catch (e) {
    console.log('[voice] stop 被忽略:', e.message || e.errMsg);
  }
  this.startedAt = 0;
}

/** 停止录音 */
stop() {
  // 权限还在申请中就松手：记下取消意图，让 start() 拿到权限后别真的开录。
  // 否则录音器会在用户已松手的情况下一直开着，下一次 start 报
  // "operateRecorder:fail is recording or paused"。
  if (this.starting) {
    this.cancelRequested = true;
    return;
  }
  // 无条件下发 stop：录音器的真实状态可能与本地 state 不一致，
  // 只靠 state 判断会让录音器卡在录音态。
  this._stopRecorderQuietly();
}

/** 强制中止录音（取消 / 页面卸载时用）—— 确保录音器一定回到空闲 */
abort() {
  this.starting = false;
  this.cancelRequested = false;
  this.reset();
  this._stopRecorderQuietly();
}

  /** 识别：上传录音到云存储 → 云函数调腾讯云 ASR */
  async recognize(filePath, durationMs) {
    if (!filePath) {
      this._fail('录音文件为空');
      return;
    }

    const cloudPath = `asr/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.mp3`;

    // ⚠ 必须保存 uploadFile 返回的 fileID（完整 cloud:// URL），
    //   不能把 cloudPath（相对路径如 asr/xxx.mp3）传给云函数。
    //   云存储的 downloadFile 只认完整 fileID，传相对路径会报 -503003 文件不存在。
    //   这个 bug 很隐蔽：上传明明成功了，是下载侧找不到。
    let fileID;
    try {
      const up = await wx.cloud.uploadFile({ cloudPath, filePath });
      fileID = up && up.fileID;
      if (!fileID) throw new Error('uploadFile 未返回 fileID');
    } catch (e) {
      console.warn('[voice] 上传录音失败', e);
      this._fail(`上传录音失败：${(e && (e.message || e.errMsg)) || '未知原因'}`);
      return;
    }

    // 记录 jobId：只有任务**根本没启动**时才安全立刻删录音。
    // 若已进入轮询，云函数后台还在用这个文件，提前删会导致它下载失败。
    let startedJobId = null;

    try {
      // ⚠ 必须用「异步 + 轮询」，不能用同步 recognize。
      //   小程序调用云函数有3秒网关上限（-504003 TIME_LIMIT_EXCEEDED），
      //   而流式识别按 1:1 实时率发送音频，N秒录音就要 N 秒。
      //   同步等待必然超时——这是实测踩过的坑。
      const started = await callFunction('asr-svc', {
        action: 'startRecognize',
        payload: { fileID, cloudPath, durationMs }
      });

      if (!started || !started.jobId) {
        const e = new Error(`未能启动识别任务：${(started && started.message) || '云函数未返回 jobId'}`);
        e.errorCode = (started && started.error) || 'ASR_NO_JOB';
        e.raw = started;
        throw e;
      }

      startedJobId = started.jobId;

      // 轮询直到拿到结果。间隔 1.2 秒：太密会浪费调用次数，
      // 太疏会让用户多等——1.2 秒是体感与开销的平衡点。
      const text = await this._pollJob(started.jobId, started.estimateMs || 10000);

      this._succeed(text, ASR_CHANNEL.CLOUD, 0.8);
    } catch (e) {
      // 原始信息全打出来：真机日志是唯一可靠的观测手段，
      // 不打的话只能看到被翻译过的文案，等于什么都不知道
      console.error('[voice] 云端 ASR 失败', {
        message: e && e.message,
        errorCode: e && e.errorCode,
        raw: e && e.raw
      });
      this._fail(explainAsrError(e));

      // ⚠ 清理必须放在失败分支，**不能**用 finally。
      //   识别成功后录音由云函数自己删（识别完即删）；
      //   失败时任务可能还在跑，立刻删会让后台 downloadFile 报文件不存在。
      //   只有「连任务都没能启动」时才安全立即清理。
      if (!startedJobId) {
        callFunction('asr-svc', {
          action: 'cleanup',
          payload: { fileID, cloudPath }
        }).catch(() => { /* 清理失败不影响记账 */ });
      }
    }
  }

  /**
   * 轮询识别任务直到出结果
   *
   * @param {string} jobId
   * @param {number} estimateMs 云函数给的预估耗时
   * @returns {Promise<string>} 识别出的文本
   *
   * ## 为什么要轮询而不是等
   *
   * 小程序调用云函数有 3 秒网关上限（-504003），同步等流式识别必然超时。
   * 云函数立即返回 jobId 并在后台跑，前端只能靠轮询拿结果。
   *
   * ## 超时怎么定
   *
   * 用「预估时长 × 2.5 + 5 秒」而不是写死：
   *   · 录音 3 秒 → 等约 12 秒
   *   · 录音 30 秒 → 等约 80 秒（1:1 实时率确实要那么久）
   * 写死 60 秒会让长录音被误杀，写死 10 秒会让长录音白白失败。
   */
  async _pollJob(jobId, estimateMs) {
    const POLL_INTERVAL = 1200;
    const budget = Math.min(90000, estimateMs * 2.5 + 5000);
    const deadline = Date.now() + budget;

    let attempts = 0;
    console.log(`[voice] 开始轮询识别任务 ${jobId}（最长等待 ${Math.round(budget / 1000)}s）`);

    while (Date.now() < deadline) {
      // 先等再查：刚启动时肯定还没结果，立刻查只是浪费一次调用
      await new Promise((r) => setTimeout(r, POLL_INTERVAL));
      attempts++;

      let res;
      try {
        res = await callFunction('asr-svc', {
          action: 'pollResult',
          payload: { jobId }
        });
      } catch (e) {
        // 单次轮询失败（网络抖动等）不立即放弃，重试几次
        console.warn(`[voice] 第 ${attempts} 次轮询失败:`, e.message);
        if (attempts >= 5) {
          const err = new Error(`轮询识别结果失败：${e.message}`);
          err.errorCode = 'ASR_POLL_FAILED';
          throw err;
        }
        continue;
      }

      if (res && res.ok === false) {
        // 任务失效（云函数实例被回收）—— 这种必须明确失败，
        // 继续轮询只会永远拿不到结果
        const err = new Error((res && res.message) || '识别任务已失效');
        err.errorCode = (res && res.error) || 'ASR_JOB_LOST';
        throw err;
      }

      if (res && res.status === 'done' && res.text) {
        console.log(`[voice] 识别完成（第 ${attempts} 次轮询，共 ${res.text.length} 字）`);
        return res.text;
      }

      // running：继续等
    }

    const err = new Error(`等待识别结果超时（${Math.round(budget / 1000)}秒），请重试或手动输入`);
    err.errorCode = 'ASR_POLL_TIMEOUT';
    throw err;
  }

  /** 最终兜底：引导手动输入 */
  _toManual(reason) {
    this.channel = ASR_CHANNEL.MANUAL;
    this._setState(STATE.FAILED);
    if (this.handlers.onError) {
      this.handlers.onError({ reason, canManual: true });
    }
  }

  _fail(reason) {
    this._setState(STATE.FAILED);
    if (this.handlers.onError) {
      this.handlers.onError({ reason, canManual: true });
    }
  }

  _succeed(text, channel, confidence) {
    this._setState(STATE.DONE);
    if (this.handlers.onResult) {
      this.handlers.onResult({ text, channel, confidence: confidence || 0.8 });
    }
  }

  _setState(state) {
    this.state = state;
    if (this.handlers.onStateChange) {
      this.handlers.onStateChange({ state, channel: this.channel });
    }
  }

reset() {
    this.state = STATE.IDLE;
    this.lastFilePath = null;
    this.startedAt = 0;
    this.cancelRequested = false;
  }

destroy() {
    this.recorder = null;
    this.starting = false;
    this.cancelRequested = false;
  }
}

module.exports = { VoiceInput, ASR_CHANNEL, STATE, RECORDER_OPTIONS, explainAsrError };