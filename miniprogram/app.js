/**
 * 小程序入口 —— 技术文档 §5
 *
 * 职责刻意保持极简：只做云环境初始化与全局数据预取。
 * 任何业务判断都不放在这里，因为 app.js 的报错在小程序里极难定位。
 */

const { initCloud, callFunction, login } = require('./utils/cloud.js');

App({
  globalData: {
    // 云环境 ID。留空则使用默认环境。
    // 多人协作时必须显式指定，否则各自的"默认环境"可能不同
    cloudEnvId: '',
    openid: null,
    // 当前账本：'personal' | 'family'（家庭模式双空间）。
    // 从本地缓存恢复上次选择，默认个人 —— 老用户行为零变化
    ledger: 'personal',
    // 登录自动注册后的用户档案（nickname/avatarUrl/familyId）；失败为 null
    profile: null,
    // 静默登录失败原因（家庭入口据此提示，而不是让用户看到英文报错）
    loginError: null,
    // 本月概览，首页展示
    monthSummary: null,
    // 明细页待查看的月份（YYYY-MM）。tab 页无法用 URL 带参，
    // 分析页「近半年趋势」跳转时经此中转，明细页消费一次即清空
    detailMonth: null
  },

  onLaunch() {
    // 云开发必须在 onLaunch 初始化，且要处理失败——
    // 未开通云开发是极常见的首次使用错误，必须给出明确提示而非静默失败
    try {
      initCloud(this.globalData.cloudEnvId);
    } catch (e) {
      console.error('[app] 云开发初始化失败', e);
      wx.showModal({
        title: '云开发未就绪',
        content: '请先在开发者工具中开通云开发环境，并确认环境 ID 正确。\n\n错误：' + e.message,
        showCancel: false
      });
      return;
    }

    // 恢复上次选择的账本（家庭模式切换记忆）
    const savedLedger = wx.getStorageSync('ledger');
    if (savedLedger === 'personal' || savedLedger === 'family') {
      this.globalData.ledger = savedLedger;
    }

    this.login();
    this.preloadMonthSummary();
  },

  /**
   * 静默登录 + 自动注册（幂等），失败自动重试
   *
   * 记账主链路不依赖登录成功 —— 但家庭账单依赖档案里的 familyId，
   * 所以首次失败弹 toast 告知家庭功能暂不可用，此后每 10s 静默重试
   * （重试失败不弹框），成功后自动恢复家庭入口并清除 loginError。
   * cloud.js 的 callFunction 已把 {ok:false} 统一抛成异常，这里只需捕异常。
   */
  async login() {
    if (this._loginBusy) return false; // 上一轮未返回，跳过本轮防并发堆积

    this._loginBusy = true;
    try {
      const res = await login();
      this.globalData.profile = res.data.profile || null;
      this.globalData.loginError = null;
      this.stopLoginRetry();
      return true;
    } catch (e) {
      this.globalData.loginError = e.message;
      if (!this._loginRetried) {
        // 首次失败弹一次提示；此后重试失败静默，只进 Console
        this._loginRetried = true;
        wx.showToast({ title: '登录异常，家庭账单暂时不可用', icon: 'none', duration: 2000 });
        console.warn('[app] 登录失败（已启动 10s 自动重试）', e);
      } else {
        console.warn('[app] 登录重试失败（10s 后再试）', e);
      }
      this.startLoginRetry();
      return false;
    } finally {
      this._loginBusy = false;
    }
  },

  /**
   * 启动 10s 定时重试（幂等：已有 timer 不重复建）。
   * 小程序切后台时平台会冻结 timer，回前台自动继续 —— 符合预期。
   */
  startLoginRetry() {
    if (this._loginTimer) return;
    this._loginTimer = setInterval(() => {
      this.login();
    }, 10000);
  },

  /** 登录成功后停止重试 */
  stopLoginRetry() {
    if (this._loginTimer) {
      clearInterval(this._loginTimer);
      this._loginTimer = null;
    }
  },

  /**
   * 预取本月概览
   * 用失败静默处理：概览拿不到不应阻塞用户记账（记账是主链路）
   */
  async preloadMonthSummary() {
    try {
      const res = await callFunction('analysis-svc', {
        action: 'monthSummary',
        payload: { ledger: this.globalData.ledger }
      });
      if (res && res.ok) {
        this.globalData.monthSummary = res.data;
      }
    } catch (e) {
      console.warn('[app] 本月概览预取失败（不影响记账）', e);
    }
  },

  onError(err) {
    // 全局错误兜底：至少要让问题在真机日志里可见
    console.error('[app] uncaught', err);
  }
});