const cloud = require('../../utils/cloud.js');

Page({
  data: {
    openid: null,
    billCount: 0,
    nickname: '',
    avatarUrl: '',
    familyId: '',
    loading: true,
    diagResult: null,
    diagRunning: false
  },

  onLoad() {
    this.loadProfile();
  },

  /**
   * 选择头像（微信「头像昵称填写能力」，getUserProfile 已废弃）
   *
   * chooseAvatar 返回的是临时文件路径，重启后失效 —— 直接存它会
   * 「当时显示正常、下次打开头像没了」的静默坏数据。
   * 必须上传云存储拿 fileID 再存档案（云文件 ID 永久可读）。
   */
  onChooseAvatar(e) {
    const filePath = e.detail && e.detail.avatarUrl;
    if (!filePath) return;

    wx.showLoading({ title: '上传头像', mask: true });
    wx.cloud.uploadFile({
      cloudPath: `avatars/${Date.now()}-${Math.floor(Math.random() * 1e6)}.png`,
      filePath
    }).then((res) => {
      wx.hideLoading();
      return cloud.updateProfile({ avatarUrl: res.fileID });
    }).then(() => {
      this.loadProfile(); // 回读档案，界面展示云文件 ID 而非临时路径
      wx.showToast({ title: '头像已更新' });
    }).catch((err) => {
      wx.hideLoading();
      console.warn('[profile] 头像上传失败', err);
      wx.showToast({ title: '头像上传失败', icon: 'none' });
    });
  },

  /** 昵称输入跟踪（type=nickname 可自动填入微信昵称） */
  onNicknameInput(e) {
    this.setData({ nickname: e.detail.value });
  },

  /** 昵称失焦保存 */
  onNicknameBlur() {
    const nickname = (this.data.nickname || '').trim();
    if (!nickname) return;
    cloud.updateProfile({ nickname })
      .then(() => wx.showToast({ title: '昵称已保存' }))
      .catch((e) => {
        console.warn('[profile] 昵称保存失败', e);
        wx.showToast({ title: '昵称保存失败', icon: 'none' });
      });
  },

  /** 类目管理页：自定义类目的独立创建与查看入口 */
  onGoCategoryManage() {
    wx.navigateTo({ url: '/pages/category/manage' });
  },

  /** 家庭管理页：创建/加入家庭、成员列表、邀请码 */
  onGoFamily() {
    const app = getApp();
    if (app && app.globalData && app.globalData.loginError) {
      wx.showToast({ title: '登录未完成，请稍后重试', icon: 'none' });
      return;
    }
    wx.navigateTo({ url: '/pages/family/index' });
  },

  /** 重复记账规则页：设置自动入账规则 */
  onGoRecurringManage() {
    wx.navigateTo({ url: '/pages/recurring/manage' });
  },

  /**
   * 加载用户信息
   *
   * 注意这里不直接用 wx.cloud.callFunction，而是走统一的 cloud.js 封装——
   * 否则「云函数未部署」这类部署问题会以英文 errMsg 呈现，用户无从判断。
   */
  async loadProfile() {
    try {
      const r = await cloud.callFunction('user-svc', { action: 'profile' });
      if (r && r.ok) {
        // ⚠️ 云端返回的字段是 openidMasked（user-svc 脱敏口径），
        // 历史 bug：这里读 r.data.openid 永远拿不到值，用户标识一直不显示
        this.setData({
          openid: r.data.openidMasked || '',
          billCount: r.data.billCount || 0,
          nickname: r.data.nickname || '',
          avatarUrl: r.data.avatarUrl || '',
          familyId: r.data.familyId || ''
        });
      }
    } catch (e) {
      // 用户信息拿不到不阻塞其他功能，也不弹窗打扰
      console.warn('[profile] 加载失败', e.message);
    } finally {
      this.setData({ loading: false });
    }
  },

  /**
   * 数据库诊断
   *
   * 「数据没写入」有五种完全不同的原因（集合没建/权限不对/环境 ID 不匹配/
   * 云函数连错环境/字段有问题），靠猜要来回试五轮。
   * 这里一次性全验一遍，直接给出「哪一环断了 + 下一步做什么」。
   */
  async onDiag() {
    if (this.data.diagRunning) return;
    this.setData({ diagRunning: true });

    wx.showLoading({ title: '诊断中', mask: true });
    try {
      const r = await cloud.diag();
      wx.hideLoading();

      const checks = (r && r.checks) || [];
      const lines = checks.map((c) => `${c.ok ? '✓' : '✗'} ${c.step}\n   ${c.detail}`).join('\n\n');

      // 版本不符时明确指出「是云端没更新」而不是让用户去查数据库，
      // 这两者排查方向完全不同，混在一起会白白浪费好几轮
      const versionMismatch = r.codeVersion && r.codeVersion !== cloud.EXPECTED_CODE_VERSION;

      this.setData({
        diagResult: {
          ok: r.ok,
          env: r.env,
          openid: r.openid,
          verdict: versionMismatch
            ? `云端代码版本 ${r.codeVersion}，本地 ${cloud.EXPECTED_CODE_VERSION}——本次结果不代表最新代码。\n请右键 cloudfunctions/bill-svc →「上传并部署：云端安装依赖」后重新诊断。\n\n${r.verdict}`
            : r.verdict,
          checks
        }
      });

      wx.showModal({
        title: r.ok ? '✓ 数据库正常' : '✗ 发现问题',
        content: `${lines}\n\n${r.verdict}`,
        showCancel: false,
        confirmText: '知道了'
      });
    } catch (e) {
      wx.hideLoading();
      this.setData({
        diagResult: {
          ok: false,
          verdict: e.message || '诊断调用失败',
          checks: []
        }
      });
    } finally {
      this.setData({ diagRunning: false });
    }
  },

  onClearCache() {
    wx.showModal({
      title: '清除本地缓存',
      content: '将清空本地草稿与类目缓存，不影响已记账数据，账本选择会保留。',
      success: (r) => {
        if (!r.confirm) return;
        // 账本切换记忆（三处切换条双写的 'ledger' 键）不能随清缓存丢掉：
        // 用户上次停在家庭账本，清完缓存重开却回到个人账本，看着像「记忆失效」。
        const savedLedger = wx.getStorageSync('ledger');
        wx.clearStorageSync();
        if (savedLedger === 'personal' || savedLedger === 'family') {
          wx.setStorageSync('ledger', savedLedger);
        }
        wx.showToast({ title: '已清除' });
        // 清缓存后立刻重载，确保界面反映真实状态
        this.loadProfile();
      }
    });
  }
});