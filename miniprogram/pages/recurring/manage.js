const cloud = require('../../utils/cloud.js');
const { formatCent, friendlyDate, yuanInput, yuanToCent } = require('../../utils/format.js');

/** 与云端 shared/util/recurring.js REPEAT_TYPES 一致的顺序（picker 下标即类型） */
const TYPE_VALUES = ['daily', 'weekday', 'weekly', 'monthly', 'quarterly', 'yearly'];
const TYPE_OPTIONS = ['每天', '每个工作日', '每周', '每月', '每季度', '每年'];
const WEEK_OPTIONS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
// picker 的 range 必须是字符串数组，1-31 日与 1-12 月在这里构造一次
const DAY_OPTIONS = Array.from({ length: 31 }, (_, i) => String(i + 1));
const MONTH_OPTIONS = Array.from({ length: 12 }, (_, i) => String(i + 1));
// 账本归属：个人/家庭（家庭归属权威在云端，前端只传开关；账本创建后不可改）
const LEDGER_VALUES = ['personal', 'family'];
const LEDGER_OPTIONS = ['个人账单', '家庭账单'];

Page({
  data: {
    rules: [],        // 已装饰的规则列表（金额/重复方式都是预计算好的展示文本）
    loading: true,
    typeOptions: TYPE_OPTIONS,
    weekOptions: WEEK_OPTIONS,
    dayOptions: DAY_OPTIONS,
    monthOptions: MONTH_OPTIONS,
    ledgerOptions: LEDGER_OPTIONS,

    // ── 新建/编辑面板 ──
    formOpen: false,
    formSaving: false,
    formEdit: null,          // 编辑中的规则文档；null = 新建
    formAmount: '',          // 金额（元，字符串）
    formCategoryId: '',
    formCategoryLabel: '',
    formType: 'daily',
    formTypeIndex: 0,
    formDayOfWeek: 1,        // weekly：0-6
    formDayOfMonth: 1,       // monthly/quarterly/yearly：1-31
    formMonth: 1,            // yearly：1-12
    formNote: '',
    typeHint: '',            // 口径提示，随重复方式变化（WXML 不能调函数，这里预计算）
    catPickerVisible: false,
    // ── 账本选择（仅新建可选；编辑面板只展示不可改）──
    formLedgerIndex: 0,      // 0=个人 1=家庭
    formLedger: 'personal',
    hasFamily: false         // 已加入家庭才可建家庭规则（展示开关，云端仍会校验）
  },

  onLoad() {
    this.loadRules();
  },

  onShow() {
    // 首次进入 onLoad 已加载；从别处返回时刷新（与明细页同一纪律）
    if (!this.data.loading) this.loadRules();
  },

  /**
   * 加载规则列表
   *
   * 展示字段全部在 decorateRule 里**预计算**（金额、重复方式文案）——
   * 同一屏的数字/文案只来自这一次计算，不在 WXML 里再做第二遍。
   * 「家庭已失效」按当前档案 familyId 与规则 familyId 比对（展示用，
   * 权威校验在云端）。
   */
  async loadRules() {
    this.setData({ loading: true });
    const profile = (getApp().globalData && getApp().globalData.profile) || null;
    const hasFamily = !!(profile && profile.familyId);
    try {
      const res = await cloud.ruleList();
      if (!res || !res.ok) throw new Error((res && res.error) || '读取失败');
      const rules = (res.rules || []).map((r) => {
        const d = decorateRule(r);
        // 退出家庭后规则被自动暂停：标「家庭已失效」，提示可删除后重建为个人规则
        d.familyInvalid = r.ledger === 'family' && r.familyId &&
          profile && profile.familyId !== r.familyId;
        return d;
      });
      this.setData({ loading: false, hasFamily, rules });
    } catch (e) {
      console.error('[recurring] 加载失败', e);
      this.setData({ loading: false, hasFamily, rules: [] });
      wx.showToast({ title: e.message || '加载失败', icon: 'none' });
    }
  },

  /** 打开新建面板（重置为默认值） */
  onCreate() {
    this.setData({
      formOpen: true,
      formEdit: null,
      formAmount: '',
      formCategoryId: '',
      formCategoryLabel: '',
      formType: 'daily',
      formTypeIndex: 0,
      formDayOfWeek: 1,
      formDayOfMonth: 1,
      formMonth: 1,
      formNote: '',
      typeHint: hintFor('daily'),
      formLedgerIndex: 0,
      formLedger: 'personal'
    });
  },

  /** 打开编辑面板（用规则文档回填） */
  onEdit(e) {
    const id = e.currentTarget.dataset.id;
    const rule = this.data.rules.find((r) => r._id === id);
    if (!rule) {
      wx.showToast({ title: '找不到这条规则', icon: 'none' });
      return;
    }
    const t = rule.repeat || {};
    const typeIndex = TYPE_VALUES.indexOf(t.type);
    const ledger = rule.ledger === 'family' ? 'family' : 'personal';
    this.setData({
      formOpen: true,
      formEdit: rule,
      // ⚠️ 回填必须用原始整数分，不能用 amountText（formatCent 出的展示字符串）
      formAmount: yuanInput(rule.amount),
      formCategoryId: rule.categoryId || '',
      formCategoryLabel: rule.categoryPath || '',
      formType: t.type || 'daily',
      formTypeIndex: typeIndex >= 0 ? typeIndex : 0,
      formDayOfWeek: typeof t.dayOfWeek === 'number' ? t.dayOfWeek : 1,
      formDayOfMonth: typeof t.dayOfMonth === 'number' ? t.dayOfMonth : 1,
      formMonth: typeof t.month === 'number' ? t.month : 1,
      formNote: rule.note || '',
      typeHint: hintFor(t.type || 'daily'),
      // 编辑面板账本只展示不可改（口径：账本归属创建后不可改，换账本需删除重建）
      formLedgerIndex: LEDGER_VALUES.indexOf(ledger),
      formLedger: ledger
    });
  },

  /** 关闭面板（不保存） */
  closeForm() {
    if (this.data.formSaving) return;
    this.setData({ formOpen: false, formEdit: null, catPickerVisible: false });
  },

  /** 阻止冒泡：点面板内部不该关掉面板 */
  noop() {},

  /** 金额输入（与明细页编辑同一过滤：只留数字与一个小数点） */
  onAmountInput(e) {
    const v = String(e.detail.value || '').replace(/[^\d.]/g, '').replace(/(\..*)\./g, '$1');
    this.setData({ formAmount: v });
  },

  /** 备注输入 */
  onNoteInput(e) {
    this.setData({ formNote: e.detail.value });
  },

  /** 重复方式切换 */
  onTypeChange(e) {
    const idx = Number(e.detail.value);
    const type = TYPE_VALUES[idx] || 'daily';
    this.setData({ formTypeIndex: idx, formType: type, typeHint: hintFor(type) });
  },

  onDayOfWeekChange(e) {
    this.setData({ formDayOfWeek: Number(e.detail.value) });
  },

  onDayOfMonthChange(e) {
    this.setData({ formDayOfMonth: Number(e.detail.value) + 1 });
  },

  onMonthChange(e) {
    this.setData({ formMonth: Number(e.detail.value) + 1 });
  },

  /** 账本切换（仅新建面板出现）：未加入家庭时选家庭 → 指路并回弹个人 */
  onLedgerChange(e) {
    const idx = Number(e.detail.value);
    if (idx === 1 && !this.data.hasFamily) {
      wx.showToast({ title: '请先到「我的」页创建或加入家庭', icon: 'none' });
      this.setData({ formLedgerIndex: 0, formLedger: 'personal' });
      return;
    }
    this.setData({ formLedgerIndex: idx, formLedger: LEDGER_VALUES[idx] || 'personal' });
  },

  /** 类目选择器（与明细页编辑共用 components/cat-picker） */
  openCatPicker() {
    this.setData({ catPickerVisible: true });
  },

  onCatPicked(e) {
    const cat = (e.detail && e.detail.category) || e.detail || {};
    if (!cat.id) return;
    this.setData({
      catPickerVisible: false,
      formCategoryId: cat.id,
      formCategoryLabel: cat.path || cat.name || ''
    });
  },

  onCatPickerCancel() {
    this.setData({ catPickerVisible: false });
  },

  /**
   * 保存规则（新建 / 编辑共用）
   *
   * 编辑时只提交**真正改动过的**字段（与明细页 saveEdit 同一纪律）：
   * 全量提交会把没改的字段也重写一遍，且自定义类目的历史规则
   * 可能因 path 反查失败而拒绝一笔只想改金额的编辑。
   */
  async saveForm() {
    if (this.data.formSaving) return;
    const d = this.data;

    const amountCent = yuanToCent(d.formAmount);
    if (amountCent === null || amountCent <= 0) {
      wx.showToast({ title: '请输入有效金额', icon: 'none' });
      return;
    }
    if (!d.formCategoryId) {
      wx.showToast({ title: '请选择类目', icon: 'none' });
      return;
    }

    // 只携带当前类型用得到的参数（与云端 normalizeRepeatParams 同口径）
    const repeat = { type: d.formType };
    if (d.formType === 'weekly') repeat.dayOfWeek = d.formDayOfWeek;
    if (d.formType === 'monthly' || d.formType === 'quarterly') repeat.dayOfMonth = d.formDayOfMonth;
    if (d.formType === 'yearly') {
      repeat.month = d.formMonth;
      repeat.dayOfMonth = d.formDayOfMonth;
    }

    const payload = d.formEdit ? { ruleId: d.formEdit._id } : null;
    if (d.formEdit) {
      if (amountCent !== d.formEdit.amount) payload.amountCent = amountCent;
      if (d.formCategoryId !== d.formEdit.categoryId) {
        payload.categoryId = d.formCategoryId;
        payload.categoryPath = d.formCategoryLabel;
      }
      if (d.formNote !== (d.formEdit.note || '')) payload.note = d.formNote;
      if (JSON.stringify(repeat) !== JSON.stringify(d.formEdit.repeat || {})) {
        payload.repeat = repeat;
      }
      if (Object.keys(payload).length === 1) {
        // 什么都没改：直接关掉面板，别白跑一次云函数
        this.setData({ formOpen: false, formEdit: null });
        wx.showToast({ title: '没有改动', icon: 'none' });
        return;
      }
    }

    // 置位防重：置位后按钮灰化禁用（WXML 已绑定 loading/disabled），连点不再触发云调用
    this.setData({ formSaving: true });
    wx.showLoading({ title: '保存中', mask: true });

    try {
      let res;
      if (d.formEdit) {
        res = await cloud.ruleUpdate(payload);
      } else {
        res = await cloud.ruleCreate({
          amountCent,
          categoryId: d.formCategoryId,
          categoryPath: d.formCategoryLabel,
          note: d.formNote,
          repeat,
          ledger: d.formLedger
        });
      }

      if (!res || !res.ok) throw new Error((res && res.error) || '保存失败');

      // 编辑会改金额/类目/重复方式/游标，就地改单行会让展示文案对不上，
      // 与明细页同一做法：重新拉一次列表保证整屏一致
      this.setData({ formOpen: false, formEdit: null, catPickerVisible: false });
      await this.loadRules();
      wx.showToast({ title: '已保存', icon: 'success' });
    } catch (e) {
      wx.showToast({ title: e.message || '保存失败', icon: 'none' });
    } finally {
      wx.hideLoading();
      this.setData({ formSaving: false });
    }
  },

  /** 暂停 / 恢复（恢复不补记，从明天起继续 —— 云端口径） */
  onTogglePause(e) {
    const id = e.currentTarget.dataset.id;
    const paused = e.currentTarget.dataset.paused === true;
    const next = !paused;

    wx.showModal({
      title: next ? '暂停这条规则？' : '恢复这条规则？',
      content: next
        ? '暂停后不再自动生成账单，已生成的账单保留。'
        : '恢复后从明天起继续生成，暂停期间的账单不补记。',
      success: async (r) => {
        if (!r.confirm) return;
        try {
          const res = await cloud.rulePause(id, next);
          if (!res || !res.ok) throw new Error((res && res.error) || '操作失败');
          await this.loadRules();
          wx.showToast({ title: next ? '已暂停' : '已恢复', icon: 'success' });
        } catch (err) {
          wx.showToast({ title: err.message || '操作失败', icon: 'none' });
        }
      }
    });
  },

  /** 删除规则（软删除；历史账单保留） */
  onDelete(e) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({
      title: '删除这条规则？',
      content: '删除后不再自动生成账单，已生成的账单保留，可在明细页单独处理。',
      confirmText: '删除',
      confirmColor: '#A32D2D',
      success: async (r) => {
        if (!r.confirm) return;
        try {
          const res = await cloud.ruleDelete(id);
          if (!res || !res.ok) throw new Error((res && res.error) || '删除失败');
          await this.loadRules();
          wx.showToast({ title: '已删除', icon: 'success' });
        } catch (err) {
          wx.showToast({ title: err.message || '删除失败', icon: 'none' });
        }
      }
    });
  }
});

/**
 * 规则文档 → 展示模型（预计算，WXML 只读字段）
 * 金额/重复文案在这里算一次，避免 WXML 里重复拼接导致两处口径漂移。
 */
function decorateRule(r) {
  return {
    ...r,
    amountText: formatCent(r.amount),
    categoryName: r.categoryPath ? r.categoryPath.split('/').pop() : '未分类',
    repeatText: repeatText(r.repeat),
    paused: r.status === 'paused',
    nextText: friendlyDate(r.nextDate || ''),
    ledgerText: r.ledger === 'family' ? '家庭' : '个人'
  };
}

/** 重复参数 → 一句话文案（与产品口径一致） */
function repeatText(t) {
  if (!t || !t.type) return '未知规则';
  switch (t.type) {
    case 'daily': return '每天';
    case 'weekday': return '每个工作日（周一至周五）';
    case 'weekly': return `每周${WEEK_OPTIONS[t.dayOfWeek] || ''}`;
    case 'monthly': return `每月 ${t.dayOfMonth} 日`;
    case 'quarterly': return `每季度（1/4/7/10 月）${t.dayOfMonth} 日`;
    case 'yearly': return `每年 ${t.month} 月 ${t.dayOfMonth} 日`;
    default: return t.type;
  }
}

/** 面板里的口径提示文案（与云端 shared/util/recurring.js 的决策一致） */
function hintFor(type) {
  switch (type) {
    case 'daily': return '每天都生成一笔';
    case 'weekday': return '周一至周五生成，节假日照常';
    case 'weekly': return '每周固定的一天';
    case 'monthly': return '当月没有这一天时跳过（如 2 月 30 日）';
    case 'quarterly': return '固定 1/4/7/10 月；当月没有这一天时跳过';
    case 'yearly': return '该月没有这一天时当年跳过（如平年 2 月 29 日）';
    default: return '';
  }
}
