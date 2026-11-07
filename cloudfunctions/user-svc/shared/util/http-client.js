/**
 * HTTP 客户端（基于 Node 内置 https 模块）
 *
 * ## 为什么不直接用 fetch
 *
 * 实测踩坑：云函数运行时 `Nodejs18.15` + CommonJS 上下文下，
 * **全局 `fetch` 不存在** → `ReferenceError: fetch is not defined`。
 *
 * 原因：Node 18 的 fetch 是实验特性，**只在 ESM 上下文注入 globalThis**。
 * 本项目全部用 `require` 写（CommonJS），所以拿不到。
 *
 * 更坑的是：**本地 Node 22 有全局 fetch**，
 * 所以本地测试全绿、云端却从未跑通过。
 * 这就是「本地全绿 ≠ 云端能跑」的又一例。
 *
 * ## 为什么不用 node-fetch / undici
 *
 * 云函数上传时不带本地 node_modules（除非选「云端安装依赖」，
 * 而那会增加部署复杂度与失败面）。用 Node 内置模块最稳——
 * 零依赖、零安装、行为确定。
 *
 * ## 行为对齐
 *
 * 刻意做成 fetch 风格的接口（ok / status / text() / json()），
 * 这样 llm-client 的调用处几乎不用改。
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');

/**
 * 可注入的请求实现
 *
 * ## 为什么需要这个注入点
 *
 * 测试要 mock 网络请求，但 `require('https')` 拿到的是模块对象，
 * 直接改它会影响全局。提供一个注入点，
 * 测试注入假实现，生产用真实现。
 *
 * 同时它也是**换 HTTP 库时的唯一改动点**——
 * 如果将来要换成别的库，只改这一处。
 */
let impl = null;

/**
 * 注入自定义实现（测试用）
 * @param {function|null} fn 签名同 postJson
 */
function __setImpl(fn) {
  impl = fn;
}

/**
 * 发起 HTTPS POST 请求
 *
 * @param {string} urlStr 目标 URL
 * @param {object} options
 * @param {object} options.headers 请求头
 * @param {string|Buffer} options.body 请求体
 * @param {number} options.timeoutMs 超时毫秒
 * @returns {Promise<{ok:boolean,status:number,text:()=>string,json:()=>object}>}
 */
function postJson(urlStr, options = {}) {
  // 注入了假实现就直接用（测试路径）
  if (impl) return impl(urlStr, options);

  const { headers = {}, body = '', timeoutMs = 10000 } = options;

  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(urlStr);
    } catch (e) {
      reject(new Error(`URL 解析失败: ${urlStr}`));
      return;
    }

    const isHttps = parsed.protocol === 'https:';
    const lib = isHttps ? https : http;

    const req = lib.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers: {
          ...headers,
          'Content-Length': Buffer.byteLength(body)
        }
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const status = res.statusCode || 0;

          resolve({
            ok: status >= 200 && status < 300,
            status,
            text: () => Promise.resolve(text),
            json: () => {
              try {
                return Promise.resolve(JSON.parse(text));
              } catch (e) {
                return Promise.reject(new Error(`响应不是合法 JSON: ${text.slice(0, 120)}`));
              }
            }
          });
        });
      }
    );

    /**
     * 超时处理
     *
     * ⚠️ 必须显式 destroy()，否则 socket 会一直挂着，
     * 云函数会等到超时才返回（浪费 40 秒的 timeout 预算）。
     */
    let timedOut = false;
    req.setTimeout(timeoutMs, () => {
      timedOut = true;
      req.destroy(new Error(`请求超时（${timeoutMs}ms）`));
    });

    req.on('error', (e) => {
      if (timedOut) {
        reject(new Error(`请求超时（${timeoutMs}ms）：${e.message}`));
      } else {
        reject(e);
      }
    });

    if (body) req.write(body);
    req.end();
  });
}

/**
 * 运行时能力检测
 *
 * 用于诊断：告诉用户「这个环境能不能发 HTTP 请求」。
 * 不只查 fetch——因为我们已经不依赖 fetch 了，
 * 但仍要确认 https 模块可用（理论上必然可用，但确认一下更稳）。
 */
function probeRuntime() {
  return {
    nodeVersion: process.version,
    hasFetch: typeof fetch === 'function',
    hasHttps: typeof https.request === 'function',
    hasAbortController: typeof AbortController === 'function',
    // CommonJS 上下文下 Node 18 不注入 fetch，这是本次踩坑的根因
    moduleType: typeof module !== 'undefined' && module.exports ? 'CommonJS' : 'ESM'
  };
}

module.exports = { postJson, probeRuntime, __setImpl };
