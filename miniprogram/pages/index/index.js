const { VoiceInput, STATE } = require('../../utils/voice.js');
const cloud = require('../../utils/cloud.js');
const { formatMoney, today } = require('../../utils/format.js');

/** 手动模式两种子模式 */
const MANUAL_MODE = {
  TEXT: 'text',      // 文字模式：输入「买菜 100」，走完整 AI 链路
  DIRECT: 'direct'   // 直填模式：金额 + 类目 + 备注，跳过 LLM
};

Page({
  data: {
    // ── 录音状态机 ──
    recordState: STATE.IDLE,
    // 实时上屏文本（流式 ASR 接入后由 onPartial 驱动）
    partialText: '',
    // 本次识别完成的文本
    finalText: '',
    // 结果区（确认卡片 / 成功提示）
    result: null,
    errorMsg: '',
    canManual: false,
    // 降级提示
    fallbackTip: '',

    // ── 本月概览 ──
    monthTotal: null,
    monthCount: 0,
    // 切换账本时概览回加载态
    summaryLoading: false,

    // ── 账本（家庭模式双空间）──
    // 'personal' | 'family'；权威状态在 app.globalData.ledger（含本地持久化），
    // 这里是页面的展示副本，切换时同步写回
    ledger: 'personal',

    // ── 手动输入 ──
    manualPanel: false,
    manualMode: MANUAL_MODE.TEXT,
    manualText: '',
    // textarea 聚焦开关：只在面板展开那一刻为 true，之后置 false。
    // 绝不能写成 manualMode === 'text' 这类恒为 true 的表达式——
    // 那样每次输入触发 setData 都会重建组件，输入被打断。
    mpFocus: false,
    // 直填模式
    manualAmount: '',
    manualCategoryIndex: -1,
    manualCategoryLabel: '',
    manualNote: '',
    manualDate: '',
    // 类目选择器：实现已抽为 components/cat-picker 组件，
    // 记账页与明细页的编辑面板共用同一份，避免两处行为不一致
    catPickerVisible: false,

    // 撤销窗口
    undoBill: null,
    undoCountdown: 0
  },

  onLoad() {
    // 账本选择：从 globalData 恢复（app.onLaunch 已从本地缓存读回）
    const app = getApp();
    this.setData({ ledger: (app && app.globalData.ledger) || 'personal' });

    this.voice = new VoiceInput({
      onStateChange: (e) => {
        // 只在状态真正变化时 setData —— 循环内连续 setData 是小程序性能重灾区
        if (this.data.recordState !== e.state) {
          this.setData({ recordState: e.state });
        }
      },
      onPartial: (text) => {
        // 流式上屏：这是「实时显示识别中的文字」需求的落点
        this.setData({ partialText: text });
      },
      onResult: (r) => this.handleRecognized(r),
      onError: (e) => {
        // 语音不可用时直接展开手动面板——此时手动输入不是「兜底」，
        // 而是唯一可用路径，让用户自己找入口是设计失职
        if (e.canManual) {
          this.setData({
            errorMsg: e.reason,
            manualPanel: true,
            manualMode: MANUAL_MODE.TEXT
          });
        } else {
          this.setData({ errorMsg: e.reason, canManual: e.canManual });
        }
      }
    });
    this.voice.init();

    this.loadMonthSummary();
    this.startUndoTimer = null;
    this.searchTimer = null;
  },

  onShow() {
    // 分析/明细页切了账本后进来，这里同步（tab 页不回 onLoad）
    const ledgerChanged = this.syncLedger();
    // 从明细页返回时刷新概览
    if (ledgerChanged || this.data.monthTotal !== null) this.loadMonthSummary();
  },

  onUnload() {
    // 必须先 abort 再 destroy：退出页面时录音器可能还开着，
    // 只置空引用会让它一直录，退出后还在占用麦克风
    if (this.voice) {
      this.voice.abort();
      this.voice.destroy();
    }
    if (this.startUndoTimer) clearInterval(this.startUndoTimer);
    if (this.searchTimer) clearTimeout(this.searchTimer);
  },

  // ══════════════════════════════════════════════════
  //  账本切换（家庭模式双空间）
  // ══════════════════════════════════════════════════

  /**
   * 当前账本。所有记账/查询调用统一从这里取，保证单屏数据口径一致
   * （概览、记账、撤销必须落在同一个账本里）。
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
   * 切换个人 / 家庭账本
   *
   * 切到家庭前先查档案：profile.familyId 为空时明确拦住并指路，
   * 而不是让云端记账时报「您还没有加入任何家庭」这种事后才发现。
   */
  async onSwitchLedger(e) {
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
    wx.setStorageSync('ledger', target); // 下次启动恢复同一账本
    // 先回加载态再拉数据，避免旧账本的数字挂着，看着像没切换成功
    this.setData({ ledger: target, summaryLoading: true });
    this.loadMonthSummary();
  },

  // ══════════════════════════════════════════════════
  //  语音记账
  // ══════════════════════════════════════════════════

  /** 长按录音 */
  async onRecordStart() {
    if (this.data.recordState === STATE.RECORDING) return;
    this.setData({
      errorMsg: '', result: null, partialText: '', finalText: '',
      canManual: false, fallbackTip: '', manualPanel: false
    });
    await this.voice.start();
  },

  /** 松手 */
  onRecordEnd() {
    this.voice.stop();
  },

  /** 取消录音 */
  onRecordCancel() {
    // 必须用 abort() 而不是 reset()：reset 只改本地状态，
    // 录音器仍在录音，下一次按下会报
    // "operateRecorder:fail is recording or paused"
    this.voice.abort();
    this.setData({ recordState: STATE.IDLE, partialText: '' });
  },

  /**
   * 拿到识别文本 → 调记账主链路
   * 语音与手动文字模式共用此方法，保证两条路径行为完全一致
   */
  async handleRecognized(r) {
    const text = (r.text || '').trim();
    if (!text) {
      this.setData({ errorMsg: '没有识别到内容', manualPanel: true });
      return;
    }

    this.setData({ finalText: text, partialText: text });

    try {
      const res = await cloud.record(text, r.confidence, this.ledger());
      this.applyResult(res, text);
    } catch (e) {
      console.error('[index] 记账失败', e);
      this.setData({ errorMsg: e.message || '记账失败', manualPanel: true });
      this.voice.reset();
    }
  },

  /**
   * 应用服务端返回的分档决策
   * 三档界面行为直接对应 confidence.js 的 decide()，前端不重复判断阈值
   */
  applyResult(res, text) {
    const status = res.status;

    // 备注摘要（服务端用 LLM 总结 + 规则层兜底合成）。
    // 确认类目后落库要用它，而不是原始口述全文——
    // 全文可能几十字，含金额与日期，落进备注会让明细列表没法看。
    const note = (res.prefill && res.prefill.note) || '';

    // 手动面板的关闭时机交给 applyResult 统一决定：
    // 成功 → 关面板展示结果；失败 → 留原地让用户改。
    if (status === 'saved') {
      // 高置信：已入账 + 5 秒撤销
      const bill = res.bill || {};
      // 落库失败时服务端会把 status 降级为 needConfirm，不会走到这里；
      // 但前端仍校验 saved，避免出现「界面说记好了、库里没有」
      if (res.saved === false) {
        // 落库失败但已算出候选：仍展示 Top3 让用户改类目重试，
        // 同时用错误条说明「这笔还没存进去」，不能让人以为记好了
        this.setData({
          errorMsg: this.explainError(new Error(res.savedError || '记账未保存，请检查网络后重试')),
          result: {
            kind: 'confirm',
            amount: res.prefill.amountYuan,
            amountCertain: res.prefill.amountCertain,
            ui: '这笔还没保存成功，请重试或换个类目',
            confidence: res.confidence,
            note,
            candidates: (res.candidates || []).map((c) => ({
              categoryId: c.categoryId,
              categoryName: c.categoryName,
              categoryPath: c.categoryPath,
              color: c.color
            }))
          },
          manualPanel: false
        });
        return;
      }
      // 从手动面板提交的（文字模式 / 引导流程切到文字模式），面板收起后
      // 结果卡在页面顶部，用户停在原滚动位置会看不到入账确认和撤销窗口
      const panelWasOpen = this.data.manualPanel;
      this.setData({
        result: {
          kind: 'saved',
          amount: formatMoney(res.prefill.amountYuan),
          categoryName: ((res.candidates || [])[0] || {}).categoryName || '',
          confidence: res.confidence,
          note,
          reasoning: res.reasoning || ''
        },
        undoBill: bill,
        undoCountdown: 5,
        recordState: STATE.IDLE,
        manualPanel: false,
        manualText: ''
      }, () => {
        if (panelWasOpen) this.scrollToSavedCard();
      });
      this.beginUndoCountdown();
      this.loadMonthSummary();
      wx.vibrateShort({ type: 'light' });
      return;
    }

    if (status === 'needConfirm') {
      // 中置信 / 强制确认（模糊金额、强规则冲突、自定义类目命中）：展示候选供一键选择
      this.setData({
        manualPanel: false,
        result: {
          kind: 'confirm',
          amount: res.prefill.amountYuan,
          amountCertain: res.prefill.amountCertain,
          ui: res.ui,
          confidence: res.confidence,
          strongRule: res.strongRuleApplied,
          customRule: res.customRuleApplied,
          note,
          candidates: (res.candidates || []).map((c) => ({
            categoryId: c.categoryId,
            categoryName: c.categoryName,
            categoryPath: c.categoryPath,
            color: c.color,
            score: c.score,
            custom: c.custom
          }))
        },
        recordState: STATE.IDLE
      });
      return;
    }

    // 低置信：引导手动选类目
    this.setData({
      manualPanel: false,
      result: {
        kind: 'guide',
        amount: res.prefill.amountYuan,
        ui: res.ui,
        confidence: res.confidence,
        note,
        candidates: (res.candidates || []).map((c) => ({
          categoryId: c.categoryId,
          categoryName: c.categoryName,
          categoryPath: c.categoryPath,
          color: c.color,
          custom: c.custom
        }))
      },
      recordState: STATE.IDLE
    });
  },

  /** 确认候选 → 落库 */
  async onConfirmCategory(e) {
    const { categoryId, index } = e.currentTarget.dataset;
    const result = this.data.result;
    if (!result) return;

    // 从卡片里回查真实类目路径，避免使用 dataset 里可能过期的数据
    const cand = result.candidates[Number(index)];
    if (!cand) return;

    wx.showLoading({ title: '保存中', mask: true });
    try {
      const candidates = [{
        amountCent: Math.round(result.amount * 100),
        categoryId: cand.categoryId,
        categoryPath: cand.categoryPath,
        account: 'unknown',
        // ⚠ 用服务端总结的备注，不是原始口述全文（finalText）。
        //   全文可能几十字、还带着金额，落进备注后明细列表会被撑爆，
        //   且金额在两个字段里各存一份，改金额后备注里的旧金额就变成错的。
        note: result.note || '',
        confidence: result.confidence
      }];

      const res = await cloud.recall(today(), candidates, 0, this.ledger());

      // ⚠ 必须检查 saved，不能只看有没有抛异常。
      // 云函数在「本地环境 / 集合异常」等情况下会返回 { ok:true, saved:false }，
      // 此时既不抛错也不写库。此前直接展示「✓ 记好了」，
      // 用户看到成功反馈但刷新后数据消失——比直接报错更糟，因为用户不会去排查。
      if (res.saved === false) {
        this.setData({
          errorMsg: this.explainError(new Error(res.savedError || '保存失败，请重试')),
          result: null
        });
        return;
      }

      this.setData({
        result: {
          kind: 'saved',
          amount: formatMoney(result.amount),
          categoryName: cand.categoryName,
          confidence: result.confidence
        },
        undoBill: res.bill,
        undoCountdown: 5
      });
      this.beginUndoCountdown();
      this.loadMonthSummary();
      wx.vibrateShort({ type: 'light' });
    } catch (err) {
      wx.showToast({ title: err.message || '保存失败', icon: 'none' });
    } finally {
      wx.hideLoading();
    }
  },

  /** 低置信 → 直接打开类目选择器做直填（跳过 LLM，最快路径） */
  onOpenCategoryPicker() {
    const result = this.data.result || {};
    this.setData({
      manualPanel: true,
      manualMode: MANUAL_MODE.DIRECT,
      manualAmount: result.amount ? String(result.amount) : '',
      manualCategoryLabel: '',
      // 备注预填总结结果，用户可直接改；没有总结时才退回原始口述
      manualNote: result.note || this.data.finalText,
      manualDate: today()
    }, () => {
      // 面板排在结果卡下方，保存按钮在首屏之外。趁类目选择器遮屏时
      // 先把页面滚到面板位置——用户关掉选择器后直接看到表单和「保存」，
      // 不用自己再往下找。
      this.scrollManualPanelIntoView();
    });
    this.openCatPicker();
  },

  /** 把手动面板滚进首屏（引导手工设置类目时保存按钮在首屏外） */
  scrollManualPanelIntoView() {
    wx.pageScrollTo({
      selector: '.manual-panel',
      duration: 200,
      fail: (err) => {
        // 只影响滚动定位，不影响记账功能；留日志便于排查
        console.warn('[index] 手动面板滚动定位失败', err);
      }
    });
  },

  /** 保存成功后滚到入账结果卡：面板已收起，停在原地会错过确认和撤销窗口 */
  scrollToSavedCard() {
    wx.pageScrollTo({
      selector: '.card-saved',
      duration: 200,
      fail: (err) => {
        console.warn('[index] 结果卡滚动定位失败', err);
      }
    });
  },

  /** 撤销刚入账的一笔 */
  async onUndo() {
    const bill = this.data.undoBill;
    if (!bill) return;
    if (this.startUndoTimer) clearInterval(this.startUndoTimer);

    try {
      const res = await cloud.amend({ billId: bill._id || bill.id, delFlag: true, ledger: this.ledger() });
      // 落库失败必须检查 ok（不能只看有没有抛异常），
      // updated:0 = 没删掉（记录不存在/已删除）—— 与明细页删除同款兜底
      if (!res || !res.ok) throw new Error((res && res.error) || '撤销失败');
      if (res.updated === 0) {
        throw new Error(this.ledger() === 'family' ? '只能删除自己记的账' : '未找到该记录或已删除');
      }
      this.setData({ result: null, undoBill: null, undoCountdown: 0 });
      wx.showToast({ title: '已撤销', icon: 'success' });
      this.loadMonthSummary();
    } catch (e) {
      wx.showToast({ title: '撤销失败', icon: 'none' });
    }
  },

  beginUndoCountdown() {
    if (this.startUndoTimer) clearInterval(this.startUndoTimer);
    let left = 5;
    this.startUndoTimer = setInterval(() => {
      left--;
      if (left <= 0) {
        clearInterval(this.startUndoTimer);
        this.startUndoTimer = null;
        // 窗口结束后仅清除撤销入口，保留已入账的结果展示
        this.setData({ undoCountdown: 0 });
        return;
      }
      this.setData({ undoCountdown: left });
    }, 1000);
  },

  // ══════════════════════════════════════════════════
  //  手动输入
  // ══════════════════════════════════════════════════

  /** 展开/收起手动面板 */
  onToggleManual() {
    const open = !this.data.manualPanel;
    this.setData({
      manualPanel: open,
      errorMsg: '',
      result: null,
      // 展开时才聚焦一次；收起时必须置 false，
      // 否则下次展开前组件已处于聚焦态，微信会跳过聚焦动画
      mpFocus: open,
      manualDate: open && !this.data.manualDate ? today() : this.data.manualDate
    });
    // 直填模式展开时预加载类目树，省一次点击
    if (open && this.data.manualMode === MANUAL_MODE.DIRECT) {
      this.preloadCatTree();
    }
  },

  /** 错误条上的「改用手动输入」——必须真的打开面板 */
  onSwitchToManual() {
    this.setData({
      manualPanel: true,
      manualMode: MANUAL_MODE.TEXT,
      errorMsg: '',
      mpFocus: true,
      manualText: this.data.partialText || this.data.finalText || ''
    });
  },

  /** 切换子模式 */
  onSwitchManualMode(e) {
    const mode = e.currentTarget.dataset.mode;
    this.setData({
      manualMode: mode,
      errorMsg: '',
      mpFocus: mode === MANUAL_MODE.TEXT,
      manualDate: this.data.manualDate || today()
    });
    if (mode === MANUAL_MODE.DIRECT) {
      this.preloadCatTree();
    }
  },

  /**
   * 预加载类目树
   *
   * 树已由 cat-picker 组件持有，页面不重复存一份。
   * 通过 selectComponent 调组件的公开方法预热，
   * 这样用户点开选择器时面板能立刻显示内容。
   */
  preloadCatTree() {
    const picker = this.selectComponent('#cat-picker');
    if (picker && typeof picker.preload === 'function') picker.preload();
  },

  /**
   * 文字输入
   *
   * 注意：这里只 setData 一个字段。如果每次输入都连带 setData 其他状态，
   * 整个 Page 会重渲染，textarea 作为受控组件会被重建，光标与已输入内容都可能丢失。
   */
  onManualInput(e) {
    this.setData({ manualText: e.detail.value });
  },

  /** 失焦后关闭聚焦开关，避免下次 setData 触发重新聚焦打断输入 */
  onManualBlur() {
    if (this.data.mpFocus) this.setData({ mpFocus: false });
  },

  /**
   * 兜底读取金额输入框真实值（同 readTextareaValue 的理由）
   * 金额更关键：data 为空但界面有数字时，静默当成「未填金额」会让人以为系统坏了
   */
  readAmountValue() {
    if (this.data.manualAmount) return this.data.manualAmount;
    return new Promise((resolve) => {
      wx.createSelectorQuery()
        .in(this)
        .select('#manual-amount-input')
        .fields({ node: true, dataset: true })
        .exec((res) => {
          const node = res && res[0] && res[0].node;
          resolve(node && typeof node.value === 'string' ? node.value.trim() : '');
        });
    });
  },

  onManualAmountInput(e) {
    // 只保留数字和一个小数点，杜绝「abc」「1-2」这类输入
    const v = String(e.detail.value).replace(/[^\d.]/g, '').replace(/^(\d*\.?\d{0,2}).*$/, '$1');
    this.setData({ manualAmount: v });
  },

  onManualNoteInput(e) {
    this.setData({ manualNote: e.detail.value });
  },

  onManualDateChange(e) {
    this.setData({ manualDate: e.detail.value });
  },

  /** 文字模式提交 → 走与语音完全相同的 AI 链路 */
  async onManualSubmit() {
    const text = await this.readTextareaValue();
    if (!text) {
      wx.showToast({ title: '请先输入内容', icon: 'none' });
      return;
    }

    wx.showLoading({ title: '识别中', mask: true });
    try {
      const res = await cloud.parseText(text, this.ledger());
      wx.hideLoading();
      // 面板留到 applyResult 决定：成功才关，失败要留在原地让用户改
      this.applyResult(res, text);
    } catch (e) {
      wx.hideLoading();
      console.error('[index] 手动解析失败', e);
      // 错误文案必须自带「下一步怎么办」——
      // 只说「云函数未部署」用户不知道怎么修，说清动作才有意义
      this.setData({ errorMsg: this.explainError(e) });
    }
  },

  /**
   * 兜底：直接从 DOM 读 textarea 的真实值
   *
   * 背景：曾经出现过「界面显示有文字，但 this.data.manualText 是空」的情况，
   * 导致用户点了「记下来」却被告知「请先输入内容」——
   * 界面明明有字，被告知没输入，这是最糟糕的一类 bug（用户会怀疑自己操作错了）。
   *
   * 所以这里不信任 data，直接向组件问一次真实值。
   * 只在 data 为空时才查，避免每次提交都多一次异步。
   */
  async readTextareaValue() {
    if (this.data.manualText.trim()) return this.data.manualText.trim();
    return new Promise((resolve) => {
      wx.createSelectorQuery()
        .in(this)
        .select('#manual-input')
        .fields({ node: true, dataset: true })
        .exec((res) => {
          const node = res && res[0] && res[0].node;
          if (node && typeof node.value === 'string') {
            resolve(node.value.trim());
          } else {
            resolve('');
          }
        });
    });
  },

  /**
   * 把原始异常翻译成可执行的提示
   *
   * 为什么要单独一层：云侧错误通常是英文或内部错误码
   * （FUNCTION_NOT_FOUND / collection not found / timeout），
   * 直接展示给家庭用户毫无意义。这里补上「该做什么」。
   */
  explainError(e) {
    const raw = String((e && e.message) || '解析失败');
    if (/未部署/.test(raw)) {
      return `${raw}。请在开发者工具左侧右键 cloudfunctions/bill-svc，选择「上传并部署：云端安装依赖」。`;
    }
    if (/缺少文件|-504002/.test(raw)) {
      return `${raw} 先在项目根目录执行 npm run prepare:cf，再重新上传该云函数。`;
    }
    if (/集合|bills/.test(raw) && /不存在/.test(raw)) {
      return '数据库集合 bills 不存在。请在云开发控制台 → 数据库 → 新建集合，名称填 bills。';
    }
    if (/权限|permission/i.test(raw)) {
      return `${raw}。请在云开发控制台把 bills 的权限设为「所有用户可读，仅创建者可读写」。`;
    }
    if (/超时/.test(raw)) {
      return `${raw}。可在 bill-svc 环境变量里设 LLM_ENABLED=false 先跑通流程，或升级云开发套餐。`;
    }
    if (/云开发未初始化/.test(raw)) {
      return '云开发未初始化。请确认导入项目时「后端服务」选择了「微信云开发」，然后重新编译。';
    }
    return raw;
  },

  /** 关闭错误条 */
  onClearError() {
    this.setData({ errorMsg: '' });
  },

  /** 直填模式提交 → 跳过 LLM，直接落库 */
  async onManualDirectSubmit() {
    const rawAmount = await this.readAmountValue();
    const yuan = parseFloat(rawAmount);
    if (!isFinite(yuan) || yuan <= 0) {
      wx.showToast({ title: '请输入有效金额', icon: 'none' });
      return;
    }
    if (this.data.manualCategoryIndex < 0) {
      wx.showToast({ title: '请选择类目', icon: 'none' });
      return;
    }

    const cat = this.resolveSelectedCategory();
    if (!cat) {
      wx.showToast({ title: '类目已失效，请重新选择', icon: 'none' });
      return;
    }

    wx.showLoading({ title: '保存中', mask: true });
    try {
      const res = await cloud.manualRecord({
        amountCent: Math.round(yuan * 100),
        categoryId: cat.id,
        categoryPath: cat.path,
        date: this.data.manualDate || today(),
        note: this.data.manualNote,
        account: 'unknown',
        ledger: this.ledger()
      });

      if (!res.saved) {
        wx.showToast({ title: res.savedError || '保存失败', icon: 'none' });
        return;
      }

      this.setData({
        result: {
          kind: 'saved',
          amount: formatMoney(yuan),
          categoryName: cat.name,
          confidence: 1
        },
        undoBill: res.bill,
        undoCountdown: 5,
        manualPanel: false,
        manualAmount: '',
        manualCategoryIndex: -1,
        manualCategoryLabel: '',
        manualNote: ''
      }, () => {
        // 面板已收起，滚到入账结果卡，让确认和 5 秒撤销窗口可见
        this.scrollToSavedCard();
      });
      this.beginUndoCountdown();
      this.loadMonthSummary();
      wx.vibrateShort({ type: 'light' });
    } catch (e) {
      wx.showToast({ title: e.message || '保存失败', icon: 'none' });
    } finally {
      wx.hideLoading();
    }
  },

  // ══════════════════════════════════════════════════
  //  类目选择器（实现已抽为 components/cat-picker 组件）
  // ══════════════════════════════════════════════════

  /** 打开类目选择面板 */
  openCatPicker() {
    this.setData({ catPickerVisible: true });
  },

  /**
   * 用户选中了类目（组件上抛）
   *
   * 组件内部有三条到达同一结果的路径（三级联动 / 搜索 / 新建后选用），
   * 组件统一收敛成一个 select 事件，页面只关心最终结果。
   */
  onCatPicked(e) {
    const cat = (e.detail && e.detail.category) || e.detail || {};
    if (!cat.id) return;
    this.setData({
      catPickerVisible: false,
      manualCategoryIndex: 0,
      manualCategoryLabel: cat.path || cat.name || ''
    });
    // 保存选中项的引用，供提交时回查（避免只存 path 字符串后无法反查 id）
    this.selectedCategory = { id: cat.id, path: cat.path || '', name: cat.name || '' };
  },

  /** 用户关闭了类目选择面板 */
  onCatPickerCancel() {
    this.setData({ catPickerVisible: false });
  },

  /**
   * 解析当前选中的末级类目
   *
   * 现在选中结果由组件通过 select 事件直接给出，
   * 这里只做一次兜底反查（历史数据兼容），拿不到就返回 null。
   */
  resolveSelectedCategory() {
    if (this.selectedCategory) return this.selectedCategory;
    return null;
  },


  onDismissResult() {
    this.setData({ result: null });
    this.voice.reset();
  },

  // ══════════════════════════════════════════════════
  //  数据加载
  // ══════════════════════════════════════════════════

  async loadMonthSummary() {
    // 请求序号：快速连点切换账本时，旧账本的响应晚到不允许覆盖新账本数字
    const seq = (this._seq = (this._seq || 0) + 1);

    try {
      const res = await cloud.monthSummary(this.ledger());
      if (seq !== this._seq) return; // 旧响应，丢弃
      if (res && res.ok) {
        this.setData({
          monthTotal: res.data.total,
          monthCount: res.data.count
        });
      }
    } catch (e) {
      // 概览失败不打扰用户，记账是主链路
    } finally {
      // 只有最新一次请求负责收尾，旧请求不能把新账本的加载态提前关掉
      if (seq === this._seq) this.setData({ summaryLoading: false });
    }
  },

  goDetail() {
    wx.switchTab({ url: '/pages/detail/detail' });
  }
});