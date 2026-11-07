/**
 * wx-server-sdk 引导层 —— 全项目唯一的 cloud 实例来源
 *
 * ## 为什么必须有这个文件
 *
 * 微信云函数运行时**没有全局 `cloud` 对象**。
 * `wx.cloud` 只存在于小程序端；云函数端必须显式：
 *
 *   const cloud = require('wx-server-sdk');
 *   cloud.init({ env: 'xxx' });
 *
 * 之前 shared/db 里的写法是：
 *
 *   if (typeof cloud !== 'undefined' && cloud.database) return true;  // 云函数里永远 false
 *
 * 这在云函数里恒为 false，
 * 于是 getDb() 抛「云数据库不可用」、handleDiag 报「cloud 全局对象不可用」，
 * 而所有记账落库路径其实也全是坏的。
 *
 * 常见误解：以为云函数里 `cloud` 是注入的全局变量。不是，必须require。
 *
 * ## 为什么做成懒加载
 *
 * 本地 Node（单元测试 / tools/e2e-local.js / tools/test-persist.js）跑不了
 * 也不该跑 wx-server-sdk。懒加载 + 失败即降级，
 * 让本地测试继续走 mock 分支，而不是一 require 就崩。
 */

let sdk = null;      // require 到的模块
let initialized = false; // 是否已 init
let initError = null;    // 初始化失败原因，供诊断展示

/**
 * 尝试加载并初始化 wx-server-sdk
 *
 * @param {object} opts { env } env 缺省时由云函数运行时自动推断当前环境
 * @returns {object|null} 可用的 sdk 实例；不可用时返回 null
 */
function ensureSdk(opts = {}) {
  // 优先使用全局注入（本地测试）：shared 层被复制成多份副本，
  // 模块级变量互不相通，只有 globalThis 能让注入跨副本生效
  const injected = globalThis.__VOICE_BILL_SDK__;
  if (injected) {
    sdk = injected;
    initialized = true;
    initError = null;
    return sdk;
  }

  if (sdk && initialized) return sdk;
  if (initError) return null;

  try {
    // eslint-disable-next-line global-require, import/no-extraneous-dependencies
    sdk = require('wx-server-sdk');
  } catch (e) {
    initError =
      `未安装 wx-server-sdk（${e.message}）。` +
      `请在对应云函数的 package.json 中加入 "wx-server-sdk": "^3.0.1" 后重新「上传并部署：云端安装依赖」。`;
    return null;
  }

  try {
    const env = opts.env || process.env.CLOUDBASE_ENV || process.env.SCF_NAMESPACE || undefined;
    sdk.init(env ? { env } : {});
    initialized = true;
    initError = null;
    return sdk;
  } catch (e) {
    initError = `wx-server-sdk init 失败：${e.message}`;
    return null;
  }
}

/**
 * 初始化失败原因（给诊断用，正常情况下为 null）
 */
function getInitError() {
  return initError;
}

/**
 * 供诊断使用：sdk 是否真的可用
 */
function isSdkReady() {
  return !!(sdk && initialized);
}

/**
 * 外部注入点，仅供本地测试（tools/test-persist.js）使用
 *
 * 云函数运行时不可能存在这个变量，因此生产路径不受影响。
 * 这样本地测试可以注入假 SDK，而不必伪造 wx-server-sdk 模块。
 */
function __injectSdk(fake) {
  sdk = fake;
  initialized = !!fake;
  initError = null;
  //⚠ 写入 globalThis：shared 层是**复制**到各云函数目录的，
  // 因此同一个模块会存在多份副本（shared/db/sdk.js、bill-svc/shared/db/sdk.js …）。
  // 若只存模块级变量，测试注入的是 A 副本，而被测代码用的是 B 副本，注入就失效了
  // —— 表现为「明明注入了 mock，落库却仍被跳过」。
  // 挂到 globalThis 上可让所有副本共享同一份注入。
  globalThis.__VOICE_BILL_SDK__ = fake;
  return fake;
}

/**
 * 读取共享注入（各副本共用）
 */
function getInjectedSdk() {
  return globalThis.__VOICE_BILL_SDK__ || null;
}

module.exports = { ensureSdk, getInitError, isSdkReady, __injectSdk, getInjectedSdk };