/**
 * 类目管理页 —— 自定义类目的独立入口
 *
 * 为什么需要独立于记账流程：
 *   类目创建原来只能发生在「记账 → 选类目」弹窗里，
 *   想提前把家里常用的类目体系建好，就得先记一笔账——不合理。
 *
 * 数据与持久化：
 *   自定义类目存在云开发数据库 categories 集合（按 openid 隔离），
 *   不在本地缓存——换设备、重装小程序、多人共用都不会丢，也不会串。
 *   页面每次进入都从云端实时拉取，这里看到的就是库里的。
 */

const cloud = require('../../utils/cloud.js');

Page({
  data: {
    loading: true,
    // 类目树（父类 chips 数据源 + 自定义列表的提取来源）
    tree: [],
    // 从 tree 提取的自定义类目分组：[{ title, color, items:[{name,path,color,lv}] }]
    groups: [],
    customCount: 0,
    customTopCount: 0,
    // 创建组件
    createVisible: false,
    createInit: { name: '', level: 1, parent1: '', parent2: '' }
  },

  onShow() {
    this.loadTree();
  },

  async loadTree() {
    this.setData({ loading: true });
    try {
      const res = await cloud.categoryTree();
      const tree = (res && res.data && res.data.tree) || [];
      const customCount = (res && res.data && res.data.customCount) || 0;

      const groups = this.extractCustom(tree);
      this.setData({
        tree,
        groups,
        customCount,
        customTopCount: tree.filter((t) => t.custom).length
      });
    } catch (e) {
      // 云函数未部署/网络问题：给出可操作的提示而非空白页
      wx.showModal({
        title: '类目加载失败',
        content: e.message || '请检查网络后重试',
        showCancel: false
      });
    } finally {
      this.setData({ loading: false });
    }
  },

  /**
   * 从树里提取自定义类目，按归属分组展示
   *
   * 直接遍历 category-svc 的 tree 结果（自定义节点已带 custom 标记），
   * 不单独加云函数接口——同一份数据口径，不会出现「列表有、树里没有」。
   * 三种形态都要收到：
   *   1. 自定义一级及其整棵子树 → 单独一组
   *   2. 挂在预置一级/二级下的自定义二三级 → 归入所属预置一级的组
   *   3. 早期「X/自定义/名称」虚拟分组里的存量末级 → 同样归入所属一级的组
   */
  extractCustom(tree) {
    const LV_NAME = { 1: '一级', 2: '二级', 3: '三级' };
    const groups = [];

    for (const top of tree || []) {
      if (top.custom) {
        const items = [{ name: top.name, path: top.path || top.name, color: top.color, lv: LV_NAME[1] }];
        for (const l2 of top.children || []) {
          items.push({ name: l2.name, path: l2.path || `${top.name}/${l2.name}`, color: l2.color || top.color, lv: LV_NAME[2] });
          for (const l3 of l2.children || []) {
            items.push({ name: l3.name, path: l3.path, color: l3.color || top.color, lv: LV_NAME[3] });
          }
        }
        groups.push({ title: top.name, color: top.color, items });
        continue;
      }

      const items = [];
      for (const l2 of top.children || []) {
        if (l2.customGroup) {
          // 存量虚拟分组：children 全是自定义末级
          for (const l3 of l2.children || []) {
            items.push({ name: l3.name, path: l3.path, color: l3.color || top.color, lv: LV_NAME[3] });
          }
        } else if (l2.custom) {
          items.push({ name: l2.name, path: l2.path, color: l2.color || top.color, lv: LV_NAME[2] });
          for (const l3 of l2.children || []) {
            items.push({ name: l3.name, path: l3.path, color: l3.color || top.color, lv: LV_NAME[3] });
          }
        } else {
          for (const l3 of l2.children || []) {
            if (l3.custom) {
              items.push({ name: l3.name, path: l3.path, color: l3.color || top.color, lv: LV_NAME[3] });
            }
          }
        }
      }
      if (items.length) groups.push({ title: top.name, color: top.color, items });
    }

    return groups;
  },

  onOpenCreate() {
    this.setData({
      createVisible: true,
      createInit: { name: '', level: 1, parent1: '', parent2: '' }
    });
  },

  onCancelCreate() {
    this.setData({ createVisible: false });
  },

  /** 创建成功 → 重拉树（持久化的结果立即反映到列表） */
  async onCatCreated() {
    this.setData({ createVisible: false });
    await this.loadTree();
  }
});
