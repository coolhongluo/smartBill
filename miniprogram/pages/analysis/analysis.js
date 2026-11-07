const cloud = require('../../utils/cloud.js');
const { buildTrendView } = require('../../utils/trend.js');

Page({
  data: {
    // 账本（家庭模式双空间）：'personal' | 'family'，与首页同一个 globalData.ledger
    ledger: 'personal',
    // 读取中（读已存结果，毫秒级）
    loading: true,
    // 正在重新分析（跑 LLM，10 秒起）
    refreshing: false,
    errorMsg: '',

    // 饼图数据：[{ name, value, percent, color }]
    pie: [],
    // 趋势数据：[{ month, label, totalYuan, count, height }] —— 云函数已补零，折线不断裂
    // ⚠️ height / label 由 utils/trend.js 计算：云端只给原始统计，不给画柱子用的字段
    trend: [],
    // 消费习惯分析结论
    insights: [],
    // 可节省消费
    savings: [],

    month: '',
    total: '',
    billCount: 0,

    // 环比（云函数已补上，此前前端读了但云端没返回，环比栏一直空白）
    deltaText: '',
    deltaDirection: '',

    // 后端是否已有分析结果。
    // 区分「还没分析过」与「分析了但没发现什么」——两者的引导完全不同：
    // 前者应提示点分析，后者应告知确实没有优化空间。
    hasResult: false,
    // 结果对应的月份不是当月（跨月后旧数据仍在）
    isStale: false,
    // 账单在结论生成后被改动过（编辑金额/类目等）→ 结论已过期
    isOutdated: false,
    // 过期时的提示文案
    outdatedText: '',

    // 生成时间文本，如「10月21日 22:30」
    generatedAt: '',
    // 降级提示：LLM 不可用时结论由纯代码生成，数字依然准确，只是措辞更机械
    isFallback: false,
    fallbackNote: '',
    // 降级原因与处理建议。level='guard' 表示这是保护机制正常工作，
    // 不该让用户以为系统坏了——所以不展示成错误样式。
    fallbackHint: '',
    fallbackLevel: '',

    // 「可以这样省」为空时的说明文案
    savingsEmptyText: '',
    savingsEmptyHint: '',
    // AI 没跑成时显示重试按钮——与「AI 分析过但确实没建议」严格区分，
    // 前者该重试，后者重试无意义（数据就这么多）
    savingsRetry: false,

    // 诊断面板：一次性说清「为什么是规则版」
    diagRunning: false,
    diagResult: null
  },

  onShow() {
    // 首页/明细页切了账本后进来，这里同步（tab 页不回 onLoad）
    this.syncLedger();
    this.loadInsight(); // 内部按当前账本拉取，请求序号守卫防旧响应覆盖
  },

  /**
   * 当前账本（与首页同一个 globalData.ledger，保证各页口径一致）
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
    // 先回加载态再拉数据，避免旧账本的结论挂着，看着像没切换成功
    this.setData({ ledger: target, loading: true });
    this.loadInsight(); // 账本变了，分析数据口径全变
  },

  /**
   * 读取已保存的分析结果
   *
   * 不触发分析——分析由记账后异步生成，这里只读。
   * 所以打开页面是毫秒级的，不会像以前那样等十几秒。
   */
  async loadInsight() {
    // 请求序号：账本切换连点时，旧响应晚到不允许覆盖新账本的数据
    const seq = (this._seq = (this._seq || 0) + 1);

    try {
      const res = await cloud.readInsight(this.ledger());
      if (seq !== this._seq) return;
      if (!res || !res.ok) throw new Error((res && res.error) || '读取失败');

      const d = res.data || {};

      if (!d.hasResult) {
        // 从没分析过：给出明确引导，而不是空白页
        this.setData({
          loading: false,
          hasResult: false,
          pie: [],
          insights: [],
          savings: [],
          trend: []
        });
        return;
      }

      const meta = d.meta || {};

      this.setData({
        loading: false,
        hasResult: true,
        isStale: !!d.isStale,
        isOutdated: !!d.isOutdated,
        outdatedText: d.isOutdated
          ? '账目有改动，下面是改动前的结论，点「重新分析」更新'
          : '',
        pie: d.pie || [],
        trend: buildTrendView(d.trend),
        insights: d.insights || [],
        savings: d.savings || [],
        month: d.month || '',
        total: d.total || '',
        billCount: d.billCount || 0,
        deltaText: d.deltaText || '',
        deltaDirection: d.deltaDirection || '',
        generatedAt: formatTime(d.generateTime),
        isFallback: !!meta.isFallback,
        fallbackNote: buildNote(meta),
        fallbackHint: (meta.fallbackInfo && meta.fallbackInfo.hint) || '',
        fallbackLevel: (meta.fallbackInfo && meta.fallbackInfo.level) || '',
        ...buildSavingsEmpty(d.savings, meta, d.insights)
      });
    } catch (e) {
      if (seq !== this._seq) return;
      console.error('[analysis] 读取失败', e);
      this.setData({ loading: false, errorMsg: e.message || '读取失败，请稍后重试' });
    }
  },

  /**
   * 立即重新分析
   *
   * 这条会真的跑 LLM，所以要有明确的等待反馈——
   * 用户点了按钮却看不到变化，会以为没点上而连点多次。
   */
  async onRefresh() {
    if (this.data.refreshing) return;

    this.setData({ refreshing: true, errorMsg: '' });
    wx.showLoading({ title: '分析中约 25 秒', mask: true });

    try {
      const res = await cloud.refreshInsight(this.ledger());
      wx.hideLoading();

      if (!res || !res.ok) throw new Error((res && res.error) || '分析失败');

      const d = res.data || {};
      const meta = d.meta || {};

      this.setData({
        refreshing: false,
        hasResult: true,
        isStale: false,
        pie: d.pie || [],
        trend: buildTrendView(d.trend),
        insights: d.insights || [],
        savings: d.savings || [],
        month: d.month || '',
        total: d.total || '',
        billCount: d.billCount || 0,
        deltaText: d.deltaText || '',
        deltaDirection: d.deltaDirection || '',
        generatedAt: formatTime(Date.now()),
        isFallback: !!meta.isFallback,
        fallbackNote: buildNote(meta),
        fallbackHint: (meta.fallbackInfo && meta.fallbackInfo.hint) || '',
        fallbackLevel: (meta.fallbackInfo && meta.fallbackInfo.level) || '',
        ...buildSavingsEmpty(d.savings, meta, d.insights)
      });

      // 落库失败要如实告知：用户看到的结论本次有效，但下次打开可能还是旧的
      if (d.persisted === false) {
        wx.showToast({ title: '分析完成但未能保存', icon: 'none' });
      } else {
        wx.showToast({ title: '分析已更新', icon: 'success' });
      }
    } catch (e) {
      wx.hideLoading();
      this.setData({ refreshing: false });
      wx.showToast({ title: e.message || '分析失败', icon: 'none' });
    }
  },

  /**
   * 诊断分析链路
   *
   * ## 为什么放在分析页而不是 profile
   *
   * 「界面显示规则版分析」这个问题就发生在这里，
   * 用户不用跳转就能看到诊断结果。
   *
   * 诊断内容包含一次**真实的模型调用**，
   * 所以它回答的是「现在到底能不能用」，
   * 而不只是「环境变量配了没」。
   */
  async onDiag() {
    if (this.data.diagRunning) return;
    this.setData({ diagRunning: true });
    wx.showLoading({ title: '诊断中（含一次模型调用）', mask: true });

    try {
      const r = await cloud.analysisDiag();
      wx.hideLoading();

      const checks = (r && r.checks) || [];
      const failed = checks.filter((c) => !c.ok);
      const advice = (r && r.advice) || [];

      this.setData({
        diagRunning: false,
        diagResult: {
          ok: !!(r && r.allOk),
          codeVersion: (r && r.codeVersion) || '',
          // 版本不一致要单独提示——这是最容易被忽略的一种原因
          versionMismatch: !!(r && r.codeVersion !== cloud.EXPECTED_CODE_VERSION),
          expectedVersion: cloud.EXPECTED_CODE_VERSION,
          lines: checks.map((c) => `${c.ok ? '✓' : '✗'} ${c.name}：${c.detail}`),
          advice
        }
      });

      if (failed.length === 0) {
        wx.showToast({ title: '环境正常', icon: 'success' });
      } else {
        wx.showToast({ title: `${failed.length} 项异常`, icon: 'none' });
      }
    } catch (e) {
      wx.hideLoading();
      this.setData({
        diagRunning: false,
        diagResult: {
          ok: false,
          lines: [`✗ 诊断调用失败：${e.message || '未知错误'}`],
          advice: [
            '如果提示「未知操作: diag」，说明云端跑的还是旧代码',
            '请右键 cloudfunctions/analysis-svc →「上传并部署：云端安装依赖」'
          ]
        }
      });
      wx.showToast({ title: '诊断失败', icon: 'none' });
    }
  },

  /** 关闭诊断面板 */
  closeDiag() { this.setData({ diagResult: null }); },

  /** 去记一笔 */
  goRecord() { wx.switchTab({ url: '/pages/index/index' }); },

  /**
   * 点趋势柱：跳明细页回看该月。
   * 明细是 tabBar 页，switchTab 无法带参，月份经 app.globalData.detailMonth 中转，
   * 明细页 onShow 消费后清空。
   */
  onTrendTap(e) {
    const mo = e.currentTarget.dataset.month;
    getApp().globalData.detailMonth = mo;
    wx.switchTab({ url: '/pages/detail/detail' });
  }
});

/**
 * 「可以这样省」没有建议时的说明
 *
 * ## 为什么必须区分三种情况
 *
 * 1. **AI 没跑成**（savingsSource='unavailable'）：显示「AI 分析暂不可用」+ 重试。
 *    v3 起降级不再生成规则建议——用「暂无建议」冒充会掩盖故障。
 * 2. **AI 分析过但没建议**：这是 AI 的真实判断（如全部刚性），
 *    优先复用后端 insights 里的解释，措辞最准确。
 * 3. **有数据但信息少**：引导多记账、写备注，而不是让用户以为无药可救。
 */
function buildSavingsEmpty(savings, meta, insights) {
  const list = savings || [];
  if (list.length) {
    return { savingsEmptyText: '', savingsEmptyHint: '', savingsRetry: false };
  }

  // ① AI 没跑成：占位 + 重试入口
  if (meta && meta.savingsSource === 'unavailable') {
    return {
      savingsEmptyText: 'AI 分析暂不可用',
      savingsEmptyHint: '省钱建议由大模型生成，本次未能完成',
      savingsRetry: true
    };
  }

  const texts = insights || [];

  // ② 后端已说明原因时，直接复用它的说法
  const reasonHint = texts.find((t) =>
    /可优化空间有限|以刚性支出为主|没有明显的可优化空间|都是刚性|数据还太少/.test(t)
  );
  if (reasonHint) {
    return {
      savingsEmptyText: '暂时没有可优化空间',
      savingsEmptyHint: reasonHint,
      savingsRetry: false
    };
  }

  // ③ 本月有消费但没建议：多半是信息还不够
  if (meta && meta.billCount > 0) {
    return {
      savingsEmptyText: '暂时没有可优化空间',
      savingsEmptyHint: '多记几笔、备注写清楚消费用途，建议会更具体',
      savingsRetry: false
    };
  }

  return {
    savingsEmptyText: '暂时没有可优化空间',
    savingsEmptyHint: '',
    savingsRetry: false
  };
}

/**
 * 拼接数据说明
 *
 * 目的是让用户知道「这个结论基于多少数据、什么时候算的」——
 * 不告知的话，少算的记录会被当成应用算错，
 * 而过期的结论被当成最新结论更糟。
 */
function buildNote(meta) {
  const parts = [];
  if (meta.isFallback) {
    // 降级原因必须说清楚：用户看到「规则版分析」却不知道为什么，
    // 就只能猜或者放弃。护栏类原因还要说明「这是保护机制在工作」。
    const info = meta.fallbackInfo;
    if (info && info.text) {
      parts.push(`规则版分析 · ${info.text}`);
    } else {
      parts.push('当前为规则版分析');
    }
  }
  if (meta.droppedCount > 0) parts.push(`已跳过 ${meta.droppedCount} 笔格式异常的记录`);
  return parts.join(' · ');
}

/** 时间戳 → 「10月21日 22:30」 */
function formatTime(ts) {
  const n = Number(ts);
  if (!n) return '';
  const d = new Date(n);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`;
}