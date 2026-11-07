/**
 * 新增自定义类目组件（全层级：一级 / 二级 / 三级）
 *
 * 从 index 页的记账选类目流程中抽出：类目创建不依附于记账场景，
 * 记账页与「类目管理」页共用这一份表单。
 *
 * 使用方式：
 *   <cat-create
 *     visible="{{visible}}"
 *     tree="{{catTree}}"
 *     init-name="{{initName}}" init-level="{{initLevel}}"
 *     init-parent1="{{initParent1}}" init-parent2="{{initParent2}}"
 *     bind:created="onCatCreated" bind:cancel="onCancelCreate"
 *   />
 *
 * 事件：
 *   created  detail = { category } —— 创建成功（含「预置同名劝用现成类目」的选用），
 *            页面据此刷新类目树并决定是否直接选用该类目
 *   cancel   用户关闭表单
 */

const cloud = require('../../utils/cloud.js');
const { l2OptionsOf } = require('../../utils/cat-tree.js');

Component({
  properties: {
    visible: { type: Boolean, value: false },
    /** 类目树（父类 chips 数据源，结构与 category-svc tree 一致） */
    tree: { type: Array, value: [] },
    /** 打开时的初始值：搜索无结果场景带入关键词、上下文感知预填层级与父类 */
    initName: { type: String, value: '' },
    initLevel: { type: Number, value: 1 },
    initParent1: { type: String, value: '' },
    initParent2: { type: String, value: '' }
  },

  data: {
    name: '',
    level: 1,
    parent1Id: '',
    parent2Id: '',
    l2Options: [],
    submitting: false
  },

  observers: {
    // 每次打开重置为初始值：上次会话残留的父类选择对新一次创建毫无意义
    visible(v) {
      if (!v) return;
      const { initName, initLevel, initParent1, initParent2 } = this.properties;
      const level = initLevel === 1 || initLevel === 2 || initLevel === 3 ? initLevel : 1;
      this.setData({
        name: initName || '',
        level,
        parent1Id: initParent1 || '',
        parent2Id: initParent2 || '',
        l2Options: level === 3 && initParent1 ? this.l2OptionsOf(initParent1) : []
      });
    }
  },

  methods: {
    /**
     * 某一级下的二级候选（预置 + 自定义），供 level=3 的父类第二步
     *
     * 真正的计算在 utils/cat-tree.js（纯函数，可单测）。
     * 这里只做转发——虚拟分组过滤等规则改了，改一处就够。
     */
    l2OptionsOf(topId) {
      return l2OptionsOf(this.properties.tree || [], topId);
    },

    onNameInput(e) {
      this.setData({ name: e.detail.value });
    },

    /** 切换层级：清空父类选择（不同层级的父类集合完全不同，残留会误导） */
    onSwitchLevel(e) {
      const level = Number(e.currentTarget.dataset.level);
      if (level === this.data.level) return;
      this.setData({ level, parent1Id: '', parent2Id: '', l2Options: [] });
    },

    /** 父类第一步：选一级（level=2 直接生效；level=3 触发加载其下二级） */
    onPickParent1(e) {
      const id = e.currentTarget.dataset.id;
      if (id === this.data.parent1Id) return;
      this.setData({
        parent1Id: id,
        parent2Id: '',
        l2Options: this.data.level === 3 ? this.l2OptionsOf(id) : []
      });
    },

    /** 父类第二步：选二级（仅 level=3） */
    onPickParent2(e) {
      this.setData({ parent2Id: e.currentTarget.dataset.id });
    },

    onCancel() {
      this.triggerEvent('cancel');
    },

    /** 阻止冒泡到遮罩关闭（表单卡片内部点击不关弹窗） */
    noop() {},

    /**
     * 提交创建
     *
     * 云端对同类目同名幂等（已建过直接返回现有），连点两次不会建出重复条目。
     * 预置同名时云端带回现成类目——同样以 created 事件上抛，
     * 「建好了」和「有现成的」对页面来说都是「拿到一个可用类目」。
     */
    async onSubmit() {
      if (this.data.submitting) return;
      const name = (this.data.name || '').trim();
      if (!name) {
        wx.showToast({ title: '请输入类目名', icon: 'none' });
        return;
      }

      const level = this.data.level;
      const parent1 = this.data.parent1Id;
      const parent2 = this.data.parent2Id;

      // 前端先挡一道空父类，云端提示文案是兜底
      if (level === 2 && !parent1) {
        wx.showToast({ title: '请选择上级大类', icon: 'none' });
        return;
      }
      if (level === 3 && (!parent1 || !parent2)) {
        wx.showToast({ title: '请先选大类，再选其下的二级', icon: 'none' });
        return;
      }

      this.setData({ submitting: true });
      wx.showLoading({ title: '创建中', mask: true });
      try {
        const res = await cloud.createCategory({
          name,
          level,
          parentId: level === 1 ? null : (level === 2 ? parent1 : parent2)
        });
        const cat = res && res.data && res.data.category;
        if (!cat) throw new Error('创建结果异常，请重试');
        wx.showToast({ title: '已创建', icon: 'success' });
        this.triggerEvent('created', { category: cat });
      } catch (e) {
        if (e.raw && e.raw.hint === 'use_preset' && e.raw.presetCategory) {
          wx.showToast({ title: '已为你选用现成类目', icon: 'none' });
          this.triggerEvent('created', { category: e.raw.presetCategory });
          return;
        }
        wx.showToast({ title: e.message || '创建失败', icon: 'none' });
      } finally {
        wx.hideLoading();
        this.setData({ submitting: false });
      }
    }
  }
});
