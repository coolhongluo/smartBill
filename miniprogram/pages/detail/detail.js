const cloud = require('../../utils/cloud.js');
const {
  formatCent, friendlyDate, trendColor, currentMonth, shiftMonth, today,
  yuanInput, yuanToCent
} = require('../../utils/format.js');

Page({
  data: {
    month: '',
    // 账本（家庭模式双空间）：'personal' | 'family'，onShow 时从 globalData 同步
    ledger: 'personal',
    total: '¥0',
    deltaText: '',
    deltaColor: '#A8A29E',
    groups: [],      // 按日期分组的流水
    loading: true,
    empty: false,
    // 空态文案随月份变化：看历史月份时说「本月」就不对了
    emptyText: '本月还没有记账',
    emptySub: '回到首页长按说话，一句话记一笔',
    // 已到当前月时「下月」按钮置灰（未来月份没有数据）
    atCurrentMonth: false,
    // 日期选择器的上界：不能选未来（家庭记账不会记还没发生的消费）
    currentDate: today(),

    // ── 编辑面板 ──
    editOpen: false,
    editSaving: false,
    // 被编辑的账单（原始值，用于「有没有改动」的判断与回填）
    editBill: null,
    editAmount: '',        // 金额（元，字符串）
    editCategoryId: '',
    editCategoryLabel: '',
    editDate: '',
    editNote: '',
    // 类目选择器（组件实现，与记账页共用）
    catPickerVisible: false,
    // 日期选择器（picker mode=date）
    datePickerVisible: false
  },

  onLoad() {
    // 账本选择：从 globalData 恢复（app.onLaunch 已从本地缓存读回）
    this.syncLedger();
    // 首次进入就带着分析页的跳转请求时，直接切到目标月，
    // 避免先闪现当前月、再被 onShow 二次加载
    const req = getApp().globalData.detailMonth;
    if (req) {
      getApp().globalData.detailMonth = null;
      this.loadBills(req);
      return;
    }
    this.loadBills();
  },

  onShow() {
    // 首页切了账本后进来，这里同步（tab 页不回 onLoad）
    const ledgerChanged = this.syncLedger();

    // 分析页点趋势柱跳转过来：消费待查看月份，切到该月。
    // 一次性消费——不清空的话，下次进明细页仍会跳回旧月份
    const app = getApp();
    const req = app.globalData.detailMonth;
    if (req) {
      app.globalData.detailMonth = null;
      if (req !== this.data.month) {
        this.loadBills(req);
        return;
      }
    }
    // 账本变了 → 数据口径全变，必须重拉；否则同一屏上月份标题没变、
    // 数字却悄悄换了来源（这是本项目最忌讳的静默失效）
    if (ledgerChanged) {
      this.loadBills(this.data.month);
      return;
    }
    // 从首页记账后返回需要刷新
    if (!this.data.loading) this.loadBills(this.data.month);
  },

  /**
   * 当前账本（与首页同一个 globalData.ledger，保证两页口径一致）
   */
  ledger() {
    const app = getApp();
    return (app && app.globalData.ledger) || 'personal';
  },

  /** 把 globalData 的账本同步到页面副本；返回「是否发生了变化」 */
  syncLedger() {
    const next = this.ledger();
    if (next !== this.data.ledger) {
      this.setData({ ledger: next });
      return true;
    }
    return false;
  },

  /**
   * 切换个人 / 家庭账本（与首页同款守卫与持久化）
   */
  onSwitchLedger(e) {
    const target = e.currentTarget.dataset.ledger;
    if (target === this.data.ledger) return;

    if (target === 'family') {
      const app = getApp();
      const profile = (app && app.globalData.profile) || null;
      if (!profile || !profile.familyId) {
        wx.showToast({ title: '还没有加入家庭，请到「我的」创建或加入', icon: 'none' });
        return;
      }
    }

    const app = getApp();
    app.globalData.ledger = target;
    wx.setStorageSync('ledger', target);
    // 先回加载态再拉数据，避免旧账本的流水挂着，看着像没切换成功
    this.setData({ ledger: target, loading: true });
    this.loadBills(this.data.month); // 账本变了，列表数据口径全变
  },

  async loadBills(month) {
    const target = month || currentMonth();

    // 切月时先把标题切过去、列表回到加载态，
    // 否则响应回来前旧月份的数据挂着，看着像点错了
    if (target !== this.data.month) {
      this.setData({ loading: true, month: target, groups: [], empty: false });
    }

    // 请求序号：快速连点切月时，先发出的旧响应晚到不允许覆盖新月份的数据
    const seq = (this._seq = (this._seq || 0) + 1);

    try {
      // ⚠️ month 必须放在 payload 里：analysis-svc 只读 payload.month，
      // 顶层字段会被 normalizeEvent 丢掉 —— 曾导致翻月/趋势跳转
      // 显示的是当月数据（标题却是目标月）的静默错误
      const res = await cloud.callFunction('analysis-svc', {
        action: 'monthBills',
        payload: { month: target, ledger: this.ledger() }
      });
      if (seq !== this._seq) return;

      if (!res || !res.ok) throw new Error('查询失败');

      const bills = res.data.bills || [];
      const isEmpty = bills.length === 0;
      this.setData({
        loading: false,
        month: target,
        total: formatCent(res.data.totalCent),
        deltaText: res.data.deltaText || '',
        deltaColor: trendColor(res.data.deltaRate || 0),
        groups: this.groupByDate(bills),
        empty: isEmpty,
        ...buildEmptyText(target, isEmpty),
        atCurrentMonth: target >= currentMonth()
      });
    } catch (e) {
      if (seq !== this._seq) return;
      console.error('[detail] 加载失败', e);
      this.setData({
        loading: false,
        empty: true,
        ...buildEmptyText(target, true)
      });
      wx.showToast({ title: e.message || '加载失败', icon: 'none' });
    }
  },

  /**
   * 按日期分组
   * 用对象累积而非多次 setData —— 循环内 setData 是小程序性能重灾区
   *
   * ⚠️ 每项必须带上**编辑所需的全部原始字段**（amount 分、categoryId、
   * date、note）。只留展示用的字段的话，点开编辑时就没有回填的原料。
   *
   * ⚠️ `amount` 是展示用字符串（"¥120.00"），`amountCent` 是原始整数分。
   *    两者长得像，用途完全不同：回填/比较一律用 amountCent。
   */
  groupByDate(bills) {
    const map = {};
    for (const b of bills) {
      const d = b.date;
      if (!map[d]) map[d] = { date: d, label: friendlyDate(d), items: [], dayTotal: 0 };
      map[d].items.push({
        _id: b._id,
        categoryName: b.categoryPath ? b.categoryPath.split('/').pop() : '未分类',
        categoryPath: b.categoryPath,
        amount: formatCent(b.amount),
        source: b.source,
        isRecall: b.isRecall,
        // source='auto' 的账单由重复记账规则定时生成（也含历史模板账单），
        // 列表标「自动」badge，与人工/语音入账区分
        isAuto: b.source === 'auto',
        color: b.color,
        // ── 编辑用：原始值 ──
        amountCent: b.amount,
        categoryId: b.categoryId,
        date: b.date,
        note: b.note || ''
      });
      map[d].dayTotal += b.amount || 0;
    }

    return Object.keys(map)
      .sort((a, b) => (a < b ? 1 : -1))
      .map((d) => ({
        ...map[d],
        dayTotalText: formatCent(map[d].dayTotal)
      }));
  },

  /**
   * 点账单行 → 打开编辑面板
   *
   * 可编辑的是**账目本身的属性**：金额、类目、日期、备注、账户。
   * 不可编辑的是系统元数据（来源、置信度、创建时间）——
   * 那些记录的是「这笔账怎么来的」，改了会让统计口径与埋点指标失真。
   */
  onBillTap(e) {
    const id = e.currentTarget.dataset.id;
    const bill = this.findBill(id);
    if (!bill) {
      wx.showToast({ title: '找不到这笔记录', icon: 'none' });
      return;
    }

    this.setData({
      editOpen: true,
      editBill: bill,
      // ⚠️ 必须用 amountCent（原始整数分），不能用 bill.amount
      //    —— bill.amount 是 formatCent() 出来的展示字符串 "¥120.00"，
      //    Number("¥120.00") 是 NaN，金额会兜成 0。
      editAmount: yuanInput(bill.amountCent),
      editCategoryId: bill.categoryId || '',
      editCategoryLabel: bill.categoryPath || bill.categoryName || '',
      editDate: bill.date || '',
      editNote: bill.note || ''
    });
  },

  /** 从分组结构里找出原始账单对象 */
  findBill(id) {
    for (const g of this.data.groups) {
      const hit = g.items.find((b) => b._id === id);
      if (hit) return hit;
    }
    return null;
  },

  /** 关闭编辑面板（不保存） */
  closeEdit() {
    if (this.data.editSaving) return;
    this.setData({ editOpen: false, editBill: null, catPickerVisible: false });
  },

  /** 阻止冒泡：点面板内部不该关掉面板 */
  noop() {},

  /** 金额输入 */
  onEditAmountInput(e) {
    // 只允许数字与一个小数点：粘贴进来的字母、多个小数点都要挡掉
    const v = String(e.detail.value || '').replace(/[^\d.]/g, '').replace(/(\..*)\./g, '$1');
    this.setData({ editAmount: v });
  },

  /** 备注输入 */
  onEditNoteInput(e) {
    this.setData({ editNote: e.detail.value });
  },

  /** 打开日期选择器 */
  openDatePicker() {
    this.setData({ datePickerVisible: true });
  },

  /** 日期选定 */
  onDateChange(e) {
    this.setData({ editDate: e.detail.value, datePickerVisible: false });
  },

  /** 打开类目选择器 */
  openCatPicker() {
    this.setData({ catPickerVisible: true });
  },

  /** 类目选定 */
  onCatPicked(e) {
    const cat = (e.detail && e.detail.category) || e.detail || {};
    if (!cat.id) return;
    this.setData({
      catPickerVisible: false,
      editCategoryId: cat.id,
      editCategoryLabel: cat.path || cat.name || ''
    });
  },

  /** 关闭类目选择器 */
  onCatPickerCancel() {
    this.setData({ catPickerVisible: false });
  },

  /**
   * 保存修改
   *
   * ## 为什么保存后要重新加载而不是就地改数据
   *
   * 就地改只更新这一行的字段，但**当日合计、月合计、环比**都变了。
   * 只改一行会导致「这一行是 120，但当天总额还是旧的 200」——
   * 同一屏上两个数字对不上，比不做编辑更糟。
   * 重新拉一次列表是唯一保证「整屏一致」的做法。
   */
  async saveEdit() {
    if (this.data.editSaving) return;

    const bill = this.data.editBill;
    if (!bill) return;

    const amountCent = yuanToCent(this.data.editAmount);
    if (amountCent === null || amountCent <= 0) {
      wx.showToast({ title: '请输入有效金额', icon: 'none' });
      return;
    }
    if (!this.data.editCategoryId) {
      wx.showToast({ title: '请选择类目', icon: 'none' });
      return;
    }
    if (!this.data.editDate) {
      wx.showToast({ title: '请选择日期', icon: 'none' });
      return;
    }

    // ⚠️ 只提交**真正改动过的**字段
    //
    // 全部字段都提交会有两个问题：
    //   1. 自定义类目/历史数据的 categoryId 不在预置类目库里，
    //      云端反查不到 path 就可能拒绝这次编辑 —— 而用户只是想改个金额。
    //   2. 提交没改的字段，云端会白写一次，且可能覆盖掉并发改动。
    const payload = { billId: bill._id, ledger: this.ledger() };
    if (amountCent !== bill.amountCent) payload.amountCent = amountCent;
    if (this.data.editCategoryId !== bill.categoryId) {
      payload.categoryId = this.data.editCategoryId;
      payload.categoryPath = this.data.editCategoryLabel;
    }
    if (this.data.editDate !== bill.date) payload.date = this.data.editDate;
    if (this.data.editNote !== (bill.note || '')) payload.note = this.data.editNote;

    if (Object.keys(payload).length === 1) {
      // 什么都没改：直接关掉面板，别白跑一次云函数
      this.setData({ editOpen: false, editBill: null });
      wx.showToast({ title: '没有改动', icon: 'none' });
      return;
    }

    this.setData({ editSaving: true });
    wx.showLoading({ title: '保存中', mask: true });

    try {
      const res = await cloud.amend(payload);

      if (!res || !res.ok) {
        throw new Error((res && res.error) || '保存失败');
      }

      // 日期改了可能跨月：这笔账会从当前月移走，列表要按新月份重新拉
      const newMonth = String(this.data.editDate).slice(0, 7);
      const movedMonth = newMonth !== this.data.month;

      this.setData({ editOpen: false, editBill: null, catPickerVisible: false });

      if (movedMonth) {
        // 跳到这笔账现在所在的月份：用户能看到自己改的结果，
        // 而不是发现「这笔记账凭空消失了」
        await this.loadBills(newMonth);
        wx.showToast({ title: `已移到 ${newMonth}`, icon: 'none' });
      } else {
        await this.loadBills(this.data.month);
        wx.showToast({ title: '已保存', icon: 'success' });
      }
    } catch (e) {
      wx.showToast({ title: e.message || '保存失败', icon: 'none' });
    } finally {
      wx.hideLoading();
      this.setData({ editSaving: false });
    }
  },

  /**
   * 删除这笔账
   *
   * 走软删除（delFlag），不是物理删：
   * 用户可能误触，且保留记录便于排查账目争议。
   */
  onDeleteEdit() {
    const bill = this.data.editBill;
    if (!bill) return;

    wx.showModal({
      title: '删除这笔账？',
      content: '删除后可以在「首页 → 5 秒内撤销」找回，但历史记录里不会再显示。',
      confirmText: '删除',
      confirmColor: '#A32D2D',
      success: async (r) => {
        if (!r.confirm) return;
        wx.showLoading({ title: '删除中', mask: true });
        try {
          const res = await cloud.amend({ billId: bill._id, delFlag: true, ledger: this.ledger() });
          if (!res || !res.ok) throw new Error((res && res.error) || '删除失败');
          // 兜底：旧版云端对「没删掉」（非记录人 / 记录不存在）回 ok:true + updated:0，
          // 前端必须再查一次，否则弹「已删除」但账单还在。
          if (res.updated === 0) {
            throw new Error(this.ledger() === 'family' ? '只能删除自己记的账' : '未找到该记录或已删除');
          }
          this.setData({ editOpen: false, editBill: null });
          await this.loadBills(this.data.month);
          wx.showToast({ title: '已删除', icon: 'success' });
        } catch (e) {
          wx.showToast({ title: e.message || '删除失败', icon: 'none' });
        } finally {
          wx.hideLoading();
        }
      }
    });
  },

  onPrevMonth() {
    this.loadBills(shiftMonth(this.data.month || currentMonth(), -1));
  },

  onNextMonth() {
    // 未来月份没有数据，翻到当前月为止（按钮已置灰，这里再兜一层）
    if (!this.data.month || this.data.month >= currentMonth()) return;
    this.loadBills(shiftMonth(this.data.month, 1));
  }
});

/**
 * 空态文案
 * 看历史月份时「本月还没有记账、去记一笔」的引导是错的——
 * 那个月过都过完了，再引导记账只会让人困惑
 */
function buildEmptyText(month, isEmpty) {
  if (!isEmpty) return { emptyText: '', emptySub: '' };
  if (month === currentMonth()) {
    return {
      emptyText: '本月还没有记账',
      emptySub: '回到首页长按说话，一句话记一笔'
    };
  }
  return { emptyText: `${month} 没有记账`, emptySub: '' };
}
