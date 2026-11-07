/**
 * 腾讯云实时语音识别（流式）—— WebSocket 客户端
 *
 * ## 为什么不用 SDK
 *
 * 官方文档直接给出了 WebSocket 协议与签名算法，
 * 手写反而比装 SDK 更轻：tencentcloud-sdk-nodejs 是全产品 SDK，很大，
 * 而流式识别这一项只需要 HMAC-SHA1 签名 + WebSocket。
 * Node 18+ 自带crypto 与 ws 可用的底层能力，零新增依赖即可实现。
 *
 * ## 协议要点（全部核对自官方文档，逐条照做）
 *
 *   连接： wss://asr.cloud.tencent.com/asr/v2/{appid}?{查询参数}&signature={签名}
 *   签名原文： asr.cloud.tencent.com/asr/v2/{appid}?{按字典序排序的查询参数}
 *签名算法： Base64(HMAC-SHA1(签名原文, secretKey))
 *   signature 必须 urlencode（文档特别强调：必须支持 + = 的编码，否则会偶发鉴权失败）
 *
 *   音频：binary message 持续上传，**1:1 实时率**（1 秒内不超过 1 秒音频）
 *   结束： 发送 text message {"type":"end"}
 *
 *   结果： slice_type 0=一段话开始 1=识别中(非稳态) 2=识别结束(稳态)
 *         final=1 表示音频流全部识别结束
 *
 * ## 关键陷阱（踩过才知道）
 *
 * 1. **发送速度不能快**。文档：音频发送速率过快超过 1:1 实时率会引擎出错并断开。
 *    16k 采样率下每200ms 发 6400 字节正好是 1:1。这是最容易踩的一个坑——
 *    一次性把音频全塞进去必然失败。
 *
 * 2. **不能空超过 15 秒**，否则报 4008。需要心跳保活。
 *
 * 3. **signature 要 urlencode**，不做会偶发鉴权失败，难以定位。
 */

const crypto = require('crypto');

/** 官方推荐：每 200ms 发一包，16k 单声道 16bit → 6400 字节正好 1:1 实时率 */
const SEND_INTERVAL_MS = 200;
const CHUNK_SIZE = 6400;

/** 15 秒无数据会报 4008，这里留出余量定期发空包保活 */
const KEEPALIVE_MS = 8000;

/** 默认引擎：中文通用。记账场景是短句日常用语，通用引擎最合适也最省 */
const DEFAULT_ENGINE = '16k_zh';

/** mp3 对应的 voice_format 编码（文档：1=pcm 4=speex 6=silk 8=mp3 12=wav 14=m4a 16=aac） */
const FORMAT_MP3 = 8;
const FORMAT_PCM = 1;

/**
 * 生成签名
 *
 * @param {object} args
 * @param {number} args.appId
 * @param {string} args.secretId
 * @param {string} args.secretKey
 * @param {object} args.query  查询参数（不含 signature）
 * @returns {string} urlencoded 的 signature
 */
function buildSignature({ appId, secretId, secretKey, query }) {
  // 官方要求：对除 signature 外的所有参数按字典序排序，拼接请求 URL（不含协议部分）
  const keys = Object.keys(query).sort();
  const qs = keys.map((k) => `${k}=${query[k]}`).join('&');

  const host = 'asr.cloud.tencent.com';
  const pathAndQuery = `/asr/v2/${appId}?${qs}`;

  // Base64(HMAC-SHA1(原文, secretKey))
  const signature = crypto
    .createHmac('sha1', secretKey)
    .update(host + pathAndQuery)
    .digest('base64');

  // ⚠ 必须 urlencode。encodeURIComponent 会把= / + 编码掉，正好符合要求
  return encodeURIComponent(signature);
}

/**
 * 建立流式识别会话
 *
 * @param {object} config
 * @param {string} config.fileID 完整 fileID（cloud://...），必需
 * @param {string} config.cloudPath 相对路径，仅日志/兜底
 * @param {object} config.env { TENCENT_ASR_APP_ID, TENCENT_ASR_SECRET_ID, TENCENT_ASR_SECRET_KEY }
 * @param {function} config.onPartial 非稳态中间结果 (text) => void
 * @param {function} config.onFinal稳态最终结果 (text) => void
 * @param {function} config.onError  (err) => void
 * @returns {Promise<string>} 识别出的完整文本
 */
async function recognizeStream({ fileID, cloudPath, env, onPartial, onFinal, onError }) {
  const appId = env.TENCENT_ASR_APP_ID;
  const secretId = env.TENCENT_ASR_SECRET_ID;
  const secretKey = env.TENCENT_ASR_SECRET_KEY;

  // ── 取音频内容 ────────────────────────────────────────
  // 云函数里没有全局 cloud，必须走 wx-server-sdk
  const path = require('path');
  const sdkBoot = require(path.join(__dirname, 'shared', 'db', 'sdk.js'));
  const sdk = sdkBoot.ensureSdk();
  if (!sdk) {
    throw new Error(`wx-server-sdk 不可用：${sdkBoot.getInitError() || '未知原因'}`);
  }

  // ⚠ downloadFile 只认**完整 fileID**（cloud://xxx/asr/xxx.mp3），
  //   传相对路径（asr/xxx.mp3）必然报 -503003 文件不存在。
  //   这个坑很隐蔽：上传是成功的，是下载侧找不到文件。
  const target = fileID || cloudPath;
  if (!/^cloud:\/\//.test(target)) {
    throw new Error(
      `下载录音需要一个完整 fileID（cloud:// 开头），收到的是："${target}"。` +
      `请确认前端调用 uploadFile 后把返回的 fileID 传过来。`
    );
  }

  console.log(`[asr] 下载录音: ${target}`);
  let audioBuffer;
  try {
    const fileRes = await sdk.downloadFile({ fileID: target });
    // downloadFile 返回 { fileContent: Buffer }
    audioBuffer = fileRes.fileContent || fileRes.buffer || fileRes;
  } catch (e) {
    const code = e.errCode !== undefined ? e.errCode : (e.code || '');
    if (String(code) === '503003' || /file does not exist|文件不存在/i.test(e.message || '')) {
      throw new Error(
        `云存储中找不到录音文件（-503003）：${target}。` +
        `可能原因：① 前端传的 fileID 格式不对；② 录音已被清理；③ 云函数与小程序不在同一云环境。` +
        `请在小程序端检查 wx.cloud.init 的 envId 与云函数所在环境是否一致。`
      );
    }
    throw new Error(`下载录音失败（${code || '未知错误'}）：${e.message || e.errMsg || ''}`);
  }

  if (!audioBuffer || !audioBuffer.length) {
    throw new Error('录音文件内容为空（可能是录音时长过短或上传中断）');
  }
  console.log(`[asr] 音频大小 ${audioBuffer.length} 字节`);

  // ── 组装握手参数 ──────────────────────────────────────
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = Math.floor(Math.random() * 9000000000) + 1000;

  const query = {
    engine_model_type: env.TENCENT_ASR_ENGINE || DEFAULT_ENGINE,
    secretid: secretId,
    timestamp,
    expired: timestamp + 24 * 3600,// 24 小时有效
    nonce,
    voice_id: crypto.randomUUID(),// 每个连接必须是新voice_id
    voice_format: String(FORMAT_MP3), // 前端录的是 mp3
    needvad: '1',
    filter_dirty: '0',
    filter_punc: '0',
    filter_modal: '0',
    word_info: '0'
  };

  const signature = buildSignature({ appId, secretId, secretKey, query });
  const qs = Object.keys(query)
    .sort()
    .map((k) => `${k}=${encodeURIComponent(query[k])}`)
    .join('&');

  const url = `wss://asr.cloud.tencent.com/asr/v2/${appId}?${qs}&signature=${signature}`;

  // ── 建连并按实时率发送 ────────────────────────────────
  // WebSocket 实现由 openSocket 内部解析（ws 包优先，全局兜底），
  // 两套 API 的差异在这一层统一，上层无需关心
  console.log(`[asr] 运行时 ${process.version}，开始连接腾讯云 ASR...`);

  return new Promise((resolve, reject) => {
    let settled = false;
    let finalText = '';

    let sendTimer = null;
    let keepaliveTimer = null;

    const cleanup = () => {
      if (sendTimer) clearInterval(sendTimer);
      if (keepaliveTimer) clearInterval(keepaliveTimer);
      sendTimer = null;
      keepaliveTimer = null;
      if (socket) socket.close();
    };

    const fail = (msg) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (onError) onError(new Error(msg));
      reject(new Error(msg));
    };

    let socket;
    try {
      socket = openSocket(url, {
        onOpen: () => {
          // ⚠ 核心：必须按 1:1 实时率分片发送，不能一次性全发。
          // 16k/16bit/单声道下每 200ms 发 6400 字节 = 200ms 音频。
          let offset = 0;
          sendTimer = setInterval(() => {
            if (offset >= audioBuffer.length) {
              // 发完通知服务端结束识别
              try { socket.send(JSON.stringify({ type: 'end' })); } catch (e) { /* ignore */ }
              if (sendTimer) clearInterval(sendTimer);
              sendTimer = null;
              return;
            }
            const chunk = audioBuffer.subarray(offset, offset + CHUNK_SIZE);
            try {
              socket.send(chunk);
            } catch (e) {
              fail(`音频发送失败：${e.message}`);
              return;
            }
            offset += CHUNK_SIZE;
          }, SEND_INTERVAL_MS);

          // 保活：超过 15 秒无数据服务端会报 4008
          keepaliveTimer = setInterval(() => {
            if (settled) return;
            try { socket.send(Buffer.alloc(0)); } catch (e) { /* ignore */ }
          }, KEEPALIVE_MS);
        },

        onMessage: (text) => {
          let msg;
          try {
            msg = JSON.parse(text);
          } catch (e) {
            return; // 非 JSON 消息忽略
          }

          // 非 0 即错误。4003=未开通服务 4004=资源包耗尽 4002=鉴权失败
          if (msg.code !== undefined && msg.code !== 0) {
            fail(`腾讯云 ASR 错误 ${msg.code}：${msg.message || '未知错误'}`);
            return;
          }

          // 识别结果
          const r = msg.result;
          if (r && r.voice_text_str !== undefined) {
            // slice_type 1=识别中(可上屏，会变化) 2=稳态(确定)
            if (r.slice_type === 1) {
              if (onPartial) onPartial(r.voice_text_str);
            } else if (r.slice_type === 2) {
              finalText = r.voice_text_str;
              if (onFinal) onFinal(r.voice_text_str);
            }
          }

          // final=1 表示音频流全部识别完毕
          if (msg.final === 1) {
            if (!settled) {
              settled = true;
              cleanup();
              resolve(finalText);
            }
          }
        },

        onError: (e) => {
          fail(`WebSocket 连接失败：${(e && e.message) || '请检查 AppID / 密钥 / 服务是否开通'}`);
        },

        onClose: (code) => {
          // 服务端主动断开但没给 final，属异常结束
          if (!settled) {
            if (finalText) {
              // 有结果就算成功
              settled = true;
              cleanup();
              resolve(finalText);
            } else {
              fail(`连接被关闭（code=${code || '未知'}），未收到识别结果`);
            }
          }
        }
      });
    } catch (e) {
      // openSocket 自身失败（如ws 包没装）
      fail(e.message);
    }
  });
}

/**
 * 获取 WebSocket 构造器（优先用 ws 包）
 *
 * ## 背景：云函数没有全局 WebSocket（踩过的坑）
 *
 * 我曾在本地 Node 22 测到 `globalThis.WebSocket` 存在，就以为云函数也一样——
 * 结果真机跑出「当前云函数运行时没有 WebSocket 实现」。
 *
 * 原因：
 *   · Node 22 内置 undici，globalThis.WebSocket 默认可用
 *   · Node 18/20 的 WebSocket 是实验特性，需要 `--experimental-websocket`
 *   · 微信云函数的运行时是精简构建，指望不上内置实现
 *
 * 所以唯一的可靠方案是**显式依赖 ws 包**（已写入 package.json，
 * 部署时选「云端安装依赖」即可装上）。
 *
 * ## 注意 ws 与浏览器 API 的差异
 *
 * ws 用 EventEmitter 风格（`on`）而非 `onmessage` 属性，
 * 且 send() 接收 Buffer/ArrayBuffer。下方做了适配，
 * 让上层代码统一用浏览器风格，不必关心底层是哪个实现。
 */
function resolveWebSocket() {
  // 优先全局（万一运行时提供了，省一次 require）
  if (typeof globalThis.WebSocket === 'function') {
    return globalThis.WebSocket;
  }

  try {
    // eslint-disable-next-line global-require, import/no-extraneous-dependencies
    const WS = require('ws');
    return WS && WS.WebSocket ? WS.WebSocket : WS;
  } catch (e) {
    return null;
  }
}

/**
 * 统一的 WebSocket 封装
 *
 * 屏蔽「浏览器 WebSocket」与「ws 包」两套 API 的差异：
 *   · 统一事件回调写法（onOpen / onMessage / onError / onClose）
 *   · send 统一接受 Buffer
 *   · 返回统一的 close() 方法
 *
 * 为什么要封装而不是直接用 ws：
 *   上层逻辑（识别主流程）不该关心底层实现，将来换实现只改这一处。
 *
 * @param {string} url
 * @param {object} handlers { onOpen, onMessage(text), onError, onClose(code) }
 * @returns {{send: Function, close: Function}}
 */
function openSocket(url, handlers) {
  const WS = resolveWebSocket();
  if (typeof WS !== 'function') {
    throw new Error(
      '当前云函数运行时没有 WebSocket 实现。' +
      '请确认 asr-svc/package.json 中已声明 "ws" 依赖，' +
      '并在开发者工具中右键 asr-svc →「上传并部署：云端安装依赖」重新部署。'
    );
  }

  const ws = new WS(url);

  const isEventEmitter = typeof ws.on === 'function';

  if (isEventEmitter) {
    // ws 包：EventEmitter 风格
    ws.on('open', () => handlers.onOpen && handlers.onOpen());
    ws.on('message', (data) => {
      // ws 收到 Buffer 或字符串，统一转字符串
      const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
      handlers.onMessage && handlers.onMessage(text);
    });
    ws.on('error', (err) => handlers.onError && handlers.onError(err));
    ws.on('close', (code) => handlers.onClose && handlers.onClose(code));
  } else {
    // 浏览器原生风格
    ws.onopen = () => handlers.onOpen && handlers.onOpen();
    ws.onmessage = (evt) => handlers.onMessage && handlers.onMessage(
      typeof evt.data === 'string' ? evt.data : String(evt.data)
    );
    ws.onerror = (err) => handlers.onError && handlers.onError(err);
    ws.onclose = (evt) => handlers.onClose && handlers.onClose(evt && evt.code);
  }

  return {
    send(data) {
      // ws 的 send 接受 Buffer/ArrayBuffer/string；
      // 空 Buffer 在某些版本会被拒，改用 1 字节空包保活
      ws.send(data);
    },
    close() {
      try {
        ws.close();
      } catch (e) { /* 已关闭 */ }
    }
  };
}

module.exports = {
  recognizeStream,
  buildSignature,
  resolveWebSocket,
  openSocket,
  DEFAULT_ENGINE,
  FORMAT_MP3,
  FORMAT_PCM,
  CHUNK_SIZE,
  SEND_INTERVAL_MS
};