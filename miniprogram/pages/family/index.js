/**
 * 家庭管理页 —— 创建 / 加入 / 成员列表 / 邀请码 / 退出与解散
 *
 * 家庭归属的唯一权威在云端（profile.familyId），前端不传 familyId；
 * 「我 / 创建者」由云端在成员列表里标好（openid 不暴露给前端）。
 */

const cloud = require('../../utils/cloud.js');

function pad(n) { return n < 10 ? '0' + n : '' + n; }

/** 时间戳 → 「MM-DD HH:mm」（邀请码有效期展示） */
function formatExpire(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

Page({
  data: {
    loading: true,
    inFamily: false,
    family: null,      // { id, name, isOwner, memberCount, inviteCode, inviteExpired }
    expireText: '',    // 邀请码有效期展示文案
    members: [],
    // 未加入家庭时的输入
    createName: '',
    joinCode: '',
    busy: false
  },

  onLoad() {
    this.refresh();
  },

  onShow() {
    // 从其它入口返回时刷新（如登录完成后首次进入）
    if (!this.data.loading) this.refresh();
  },

  /** 拉取家庭概要 + 成员列表 */
  async refresh() {
    this.setData({ loading: true });
    try {
      const r = await cloud.familyInfo();
      if (!r || !r.ok) throw new Error(r && r.error ? r.error : '加载失败');

      if (!r.data.inFamily) {
        this.setData({ inFamily: false, family: null, members: [], loading: false });
        return;
      }

      const fam = r.data.family;
      let members = [];
      try {
        const m = await cloud.familyMembers();
        if (m && m.ok) members = m.data.members || [];
      } catch (e) {
        // 成员列表拿不到不阻塞家庭概要展示
        console.warn('[family] 成员列表加载失败', e);
      }

      this.setData({
        inFamily: true,
        family: fam,
        expireText: fam.inviteExpired ? '已过期，请重新生成' : `有效至 ${formatExpire(fam.inviteExpiresAt)}`,
        members,
        loading: false
      });
    } catch (e) {
      console.warn('[family] 家庭信息加载失败', e);
      this.setData({ loading: false });
      wx.showToast({ title: e.message || '加载失败', icon: 'none' });
    }
  },

  /** 家庭状态变化后：刷新本页 + 重刷全局档案（profile.familyId 变了） */
  async afterChanged(title) {
    wx.showToast({ title });
    const app = getApp();
    if (app && app.login) await app.login();
    await this.refresh();
  },

  onCreateNameInput(e) {
    this.setData({ createName: e.detail.value });
  },

  onJoinCodeInput(e) {
    this.setData({ joinCode: e.detail.value });
  },

  async onCreateFamily() {
    if (this.data.busy) return;
    const name = (this.data.createName || '').trim();
    if (!name) {
      wx.showToast({ title: '请填写家庭名称', icon: 'none' });
      return;
    }
    this.setData({ busy: true });
    try {
      await cloud.familyCreate(name);
      this.setData({ createName: '' });
      await this.afterChanged('家庭已创建');
    } catch (e) {
      wx.showToast({ title: e.message || '创建失败', icon: 'none' });
    } finally {
      this.setData({ busy: false });
    }
  },

  async onJoinFamily() {
    if (this.data.busy) return;
    const code = (this.data.joinCode || '').trim();
    if (!code) {
      wx.showToast({ title: '请输入邀请码', icon: 'none' });
      return;
    }
    this.setData({ busy: true });
    try {
      await cloud.familyJoin(code);
      this.setData({ joinCode: '' });
      await this.afterChanged('已加入家庭');
    } catch (e) {
      wx.showToast({ title: e.message || '加入失败', icon: 'none' });
    } finally {
      this.setData({ busy: false });
    }
  },

  onCopyCode() {
    const code = this.data.family && this.data.family.inviteCode;
    if (!code) return;
    wx.setClipboardData({
      data: code,
      success: () => wx.showToast({ title: '邀请码已复制' })
    });
  },

  onRegenCode() {
    wx.showModal({
      title: '重新生成邀请码',
      content: '旧邀请码将立即失效，确定重新生成吗？',
      success: async (r) => {
        if (!r.confirm) return;
        try {
          await cloud.familyRegenCode();
          await this.refresh();
          wx.showToast({ title: '已生成新邀请码' });
        } catch (e) {
          wx.showToast({ title: e.message || '操作失败', icon: 'none' });
        }
      }
    });
  },

  onLeaveFamily() {
    wx.showModal({
      title: '退出家庭',
      content: '退出后将无法查看家庭账单，历史账单保留在家庭中。确定退出吗？',
      success: async (r) => {
        if (!r.confirm) return;
        try {
          await cloud.familyLeave();
          await this.afterChanged('已退出家庭');
        } catch (e) {
          wx.showToast({ title: e.message || '操作失败', icon: 'none' });
        }
      }
    });
  },

  onDissolveFamily() {
    wx.showModal({
      title: '解散家庭',
      content: '解散后所有成员退出，家庭账单保留但不可再查看。此操作不可恢复，确定解散吗？',
      confirmColor: '#B93636',
      success: async (r) => {
        if (!r.confirm) return;
        try {
          await cloud.familyDissolve();
          await this.afterChanged('家庭已解散');
        } catch (e) {
          wx.showToast({ title: e.message || '操作失败', icon: 'none' });
        }
      }
    });
  }
});
