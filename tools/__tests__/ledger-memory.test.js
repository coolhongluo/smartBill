/**
 * 账本切换记忆（ledger 持久化）全链路验证 —— 加载真实 app.js + 三个 tab 页
 *
 * 背景：用户反馈「切到家庭账本，杀掉重开却回到个人账本」。
 * 本测试不模拟业务逻辑，而是把**真实源码**加载进来，用
 * wx / App / Page / getApp mock 走一遍：
 *   写侧：首页 / 明细 / 分析三处 onSwitchLedger 双写
 *         globalData.ledger + wx.setStorageSync('ledger')
 *   读侧：app.onLaunch 从 storage 恢复，页面 onLoad 从 globalData 取
 *
 * 若本测试全绿但真机仍回个人，说明问题在环境（编译清缓存 / 存储被清），
 * 不在代码 —— 排查方向就完全不同了。
 *
 * 运行：node tools/__tests__/ledger-memory.test.js
 */

'use strict';

const path = require('path');
const ROOT = path.join(__dirname, '..', '..');

// ─────────────────────────────────────────────
// 微信环境 mock（storage 跨「重启」保留，其余即时响应）
// ─────────────────────────────────────────────

const storage = {};       // 模拟 wx 本地缓存；模拟冷启动时**不清空**
let currentApp = null;    // getApp() 返回当前 App 实例
let appConfig = null;     // App() 捕获的配置（每次「重启」重建实例）
let lastPageCfg = null;   // Page() 最近一次捕获的配置

const wx = {
  _toasts: [],

  // ── 存储（核心被测对象）──
  getStorageSync(key) {
    return Object.prototype.hasOwnProperty.call(storage, key) ? storage[key] : '';
  },
  setStorageSync(key, value) { storage[key] = value; },
  removeStorageSync(key) { delete storage[key]; },
  clearStorageSync() { Object.keys(storage).forEach((k) => delete storage[k]); },

  // ── UI 提示 ──
  showToast(opts) { wx._toasts.push(opts.title); },
  showLoading() {},
  hideLoading() {},
  hideToast() {},
  showModal(opts) {
    // 默认不确认；场景需要确认时先置 wx._modalAutoConfirm = true
    if (opts && opts.success) opts.success({ confirm: wx._modalAutoConfirm === true });
  },

  // ── 云开发 ──
  cloud: {
    init() {},
    callFunction({ name, data }) {
      const action = data && data.action;
      let result;
      if (name === 'user-svc' && action === 'login') {
        // 静默登录：返回已加入家庭的档案（家庭切换守卫需要 familyId）
        result = { ok: true, data: { profile: { openid: 'mock-openid', nickname: '测试', familyId: 'fam-mock-1' } } };
      } else if (name === 'analysis-svc' && action === 'monthSummary') {
        result = { ok: true, data: { total: 0, count: 0 } };
      } else if (name === 'analysis-svc' && action === 'monthBills') {
        result = { ok: true, data: { bills: [], totalCent: 0, deltaText: '', deltaRate: 0 } };
      } else if (name === 'analysis-svc' && action === 'categoryBreakdown') {
        result = { ok: true, data: { hasResult: false } };
      } else {
        result = { ok: true, data: {} };
      }
      // 不带 codeVersion 字段 → 版本对账直接放行
      return Promise.resolve({ result });
    }
  },

  // ── 录音 / 音频 / 权限（index 页 onLoad 初始化 VoiceInput 时会摸到）──
  getSetting() { return Promise.resolve({ authSetting: { 'scope.record': true } }); },
  authorize() { return Promise.resolve(); },
  openSetting() { return Promise.resolve({ authSetting: {} }); },
  getRecorderManager() {
    return { onStart() {}, onStop() {}, onError() {}, onFrameRecorded() {}, start() {}, stop() {} };
  },
  createInnerAudioContext() {
    return { play() {}, stop() {}, destroy() {}, onEnded() {}, onError() {}, onPlay() {}, onStop() {} };
  },
  getSystemInfoSync() { return { platform: 'devtools' }; },
  vibrateShort() {},
  env: { USER_DATA_PATH: 'mock' }
};

global.wx = wx;
global.App = (cfg) => { appConfig = cfg; };
global.Page = (cfg) => { lastPageCfg = cfg; };
global.getApp = () => currentApp;

// ─────────────────────────────────────────────
// 加载真实源码（require 副作用：App()/Page() 被捕获进 config）
// ─────────────────────────────────────────────

require(path.join(ROOT, 'miniprogram', 'app.js'));
const APP_CFG = appConfig;

function loadPage(rel) {
  lastPageCfg = null;
  require(path.join(ROOT, 'miniprogram', rel));
  const cfg = lastPageCfg;
  if (!cfg) throw new Error(`加载失败：${rel} 未调用 Page()`);
  return cfg;
}

const PAGE_CFG = {
  index: loadPage(path.join('pages', 'index', 'index.js')),
  detail: loadPage(path.join('pages', 'detail', 'detail.js')),
  analysis: loadPage(path.join('pages', 'analysis', 'analysis.js')),
  profile: loadPage(path.join('pages', 'profile', 'profile.js'))
};

// ─────────────────────────────────────────────
// 实例构造（每次「冷启动」从 config 重建，globalData/data 深拷贝）
// ─────────────────────────────────────────────

function launchApp() {
  const app = {
    ...APP_CFG,
    globalData: JSON.parse(JSON.stringify(APP_CFG.globalData))
  };
  app.onLaunch.call(app);
  currentApp = app;
  return app;
}

function makePage(cfg) {
  const inst = {
    ...cfg,
    data: JSON.parse(JSON.stringify(cfg.data))
  };
  inst.setData = function (patch, cb) {
    Object.assign(this.data, patch);
    if (cb) cb();
  };
  return inst;
}

/** 模拟点击账本切换 tab */
function tapSwitch(inst, ledger) {
  return inst.onSwitchLedger.call(inst, { currentTarget: { dataset: { ledger } } });
}

/** 放空微任务队列（等 login / 云调用完成） */
const tick = () => new Promise((r) => setImmediate(r));
async function flush(n = 10) {
  for (let i = 0; i < n; i++) await tick();
}

// ─────────────────────────────────────────────
// 断言
// ─────────────────────────────────────────────

let total = 0;
let failed = 0;
function assert(cond, label) {
  total++;
  console.log(`  ${cond ? '✓' : '✗ 失败:'} ${label}`);
  if (!cond) failed++;
}

// ─────────────────────────────────────────────
// 场景
// ─────────────────────────────────────────────

async function main() {
  console.log('==================================================================');
  console.log(' 账本切换记忆（ledger 持久化）—— 真实源码 + wx mock 全链路');
  console.log('==================================================================\n');

  // 【A】全新用户首次启动：storage 空 → 默认个人账本
  console.log('【A】首次启动（storage 空）→ 默认个人');
  Object.keys(storage).forEach((k) => delete storage[k]);
  let app = launchApp();
  let idx = makePage(PAGE_CFG.index);
  idx.onLoad.call(idx);
  assert(app.globalData.ledger === 'personal', 'globalData.ledger 默认 personal');
  assert(idx.data.ledger === 'personal', '首页页面副本默认 personal');
  await flush();
  assert(app.globalData.profile && app.globalData.profile.familyId === 'fam-mock-1', '静默登录完成，profile.familyId 就绪');

  // 【B】首页切家庭：双写 globalData + storage
  console.log('\n【B】首页点「家庭账本」→ 双写');
  await tapSwitch(idx, 'family');
  assert(app.globalData.ledger === 'family', 'globalData.ledger → family');
  assert(storage.ledger === 'family', "wx.setStorageSync('ledger') → family");
  assert(idx.data.ledger === 'family', '页面副本 → family');
  await flush(); // loadMonthSummary 是 fire-and-forget，等它收尾
  assert(idx.data.summaryLoading === false, '概览加载态最终清空');

  // 【C】用户反馈场景：杀掉重开（冷启动）→ 应恢复家庭
  console.log('\n【C】杀掉重开（冷启动）→ 恢复上次账本');
  app = launchApp();
  idx = makePage(PAGE_CFG.index);
  idx.onLoad.call(idx);
  assert(app.globalData.ledger === 'family', '重开后 globalData.ledger 恢复为 family');
  assert(idx.data.ledger === 'family', '重开后首页停在家庭账本');

  // 【D】明细页切个人 → 重启恢复个人
  console.log('\n【D】明细页切回个人 → 重启恢复个人');
  let detail = makePage(PAGE_CFG.detail);
  detail.onLoad.call(detail);
  await tapSwitch(detail, 'personal');
  assert(storage.ledger === 'personal', '明细页写入 storage → personal');
  await flush();
  assert(detail.data.loading === false, '明细页加载态清空');
  app = launchApp();
  assert(app.globalData.ledger === 'personal', '重启后 globalData.ledger 恢复为 personal');

  // 【E】分析页切家庭 → 双写 + 重启恢复家庭
  console.log('\n【E】分析页切家庭 → 重启恢复家庭');
  let ana = makePage(PAGE_CFG.analysis);
  ana.onShow.call(ana); // 分析页是 tab 页：没有 onLoad，只有 onShow
  await flush(); // 冷启动后等 login 完成再点，避开守卫窗口（真实用户也是这个节奏）
  await tapSwitch(ana, 'family');
  assert(app.globalData.ledger === 'family', '分析页 globalData.ledger → family');
  assert(storage.ledger === 'family', '分析页写入 storage → family');
  await flush();
  assert(ana.data.loading === false, '分析页加载态清空');
  app = launchApp();
  assert(app.globalData.ledger === 'family', '重启后 globalData.ledger 恢复为 family');

  // 【H】用户反馈场景：分析页切「个人」→ 切回记账页，切换条必须跟上
  console.log('\n【H】分析页切个人 → 记账页 onShow 同步切换条');
  let idx2 = makePage(PAGE_CFG.index);
  idx2.onLoad.call(idx2); // 记账页启动时加载，副本停在 family（tab 页不再回 onLoad）
  assert(idx2.data.ledger === 'family', '记账页启动副本停在 family（bug 前提）');
  let ana2 = makePage(PAGE_CFG.analysis);
  ana2.onShow.call(ana2);
  await tapSwitch(ana2, 'personal');
  assert(app.globalData.ledger === 'personal', '分析页切个人：globalData → personal');
  idx2.onShow.call(idx2); // 从分析页切回记账 tab
  assert(idx2.data.ledger === 'personal', '记账页 onShow 后切换条跟到个人账单');
  assert(idx2.ledger() === 'personal', '记账口径本来就是 personal（getter 读 globalData）');
  await flush();

  // 【F】守卫：登录未完成时点家庭 → toast 引导，**不写 storage**
  console.log('\n【F】守卫：profile 未就绪点家庭 → 拦截');
  Object.keys(storage).forEach((k) => delete storage[k]);
  wx._toasts.length = 0;
  app = launchApp();
  idx = makePage(PAGE_CFG.index);
  idx.onLoad.call(idx);
  await tapSwitch(idx, 'family'); // 不等 login 完成（模拟冷启动抢点）
  assert(app.globalData.ledger === 'personal', '守卫早退：globalData 不变');
  assert(!Object.prototype.hasOwnProperty.call(storage, 'ledger'), '守卫早退：storage 无 ledger 键');
  assert(idx.data.ledger === 'personal', '守卫早退：页面副本不变');
  assert(
    wx._toasts.some((t) => String(t).indexOf('还没有加入家庭') !== -1),
    '弹出引导 toast「还没有加入家庭…」'
  );
  await flush(); // 登录完成
  await tapSwitch(idx, 'family');
  assert(storage.ledger === 'family', '登录完成后同一操作放行并写入 storage');

  // 【G】「我的」页清缓存 → 账本记忆保留，其它键照清
  console.log('\n【G】清缓存保留账本记忆');
  wx._modalAutoConfirm = true; // 模拟弹窗点「确定」
  storage.ledger = 'family';
  storage.__draft = 'x'; // 模拟要被清掉的草稿键
  let prof = makePage(PAGE_CFG.profile);
  prof.onClearCache.call(prof);
  assert(storage.ledger === 'family', '清缓存后 ledger 键保留（family）');
  assert(!Object.prototype.hasOwnProperty.call(storage, '__draft'), '其它键照常清掉');
  assert(wx._toasts.indexOf('已清除') !== -1, '仍提示「已清除」');
  await flush(); // loadProfile 是 fire-and-forget，等它收尾
  delete storage.ledger; // 本来没记忆 → 清缓存不应凭空写出 ledger 键
  prof.onClearCache.call(prof);
  assert(!Object.prototype.hasOwnProperty.call(storage, 'ledger'), '无记忆时清缓存不写入 ledger 键');
  wx._modalAutoConfirm = false;

  // ── 汇总 ──
  console.log('\n==================================================================');
  console.log(failed === 0 ? ` 全部通过（${total} 项断言）` : ` 失败 ${failed} / ${total} 项`);
  console.log('==================================================================');
  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error('测试执行异常：', e);
  process.exitCode = 1;
});
