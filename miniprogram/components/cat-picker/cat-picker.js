/**
 * 类目选择器组件（三级联动 + 搜索 + 自定义新增）
 *
 * ## 为什么要抽成组件
 *
 * 这套选择器原本写死在 index 页的记账面板里，约 150 行 JS + 120 行 WXML。
 * 明细页的「编辑账单」也需要选类目 —— 若再复制一份，
 * 就是**第二个真相源**：改三级联动逻辑要改两处、样式要维护两份、
 * 而且两边行为一旦不一致，用户会看到「记账时能选、编辑时选不了」。
 *
 * 抽成组件后记账页与编辑页共用同一份实现，行为必然一致。
 * （与 components/cat-create 同样的思路：类目相关交互不依附于具体业务场景。）
 *
 * ## 使用方式
 *   <cat-picker
 *     visible="{{catPickerVisible}}"
 *     bind:select="onCatPicked"
 *     bind:cancel="onCatPickerCancel"
 *   />
 *
 * ## 事件
 *   select  detail = { id, path, name } —— 用户选中的类目
 *   cancel  用户关闭面板（点遮罩或关闭按钮）
 *
 * ## 为什么选中结果用事件上抛，而不是让父组件读组件内部状态
 *
 * 父组件需要的是「最终选中的那个类目」这一份数据。
 * 组件内部有三条到达同一结果的路径（三级联动 / 搜索 / 新建后选用），
 * 若让父组件去反查组件状态，就得把 curL1/curL2/catLevel3 这些
 * 内部实现细节暴露出去 —— 那是耦合，不是复用。
 * 事件把「结果」直接交出去，组件怎么实现父组件不关心。
 */

const cloud = require('../../utils/cloud.js');

Component({
  properties: {
    /** 面板是否显示 */
    visible: { type: Boolean, value: false },
    /** 初始高亮的类目 id（编辑时用来定位到用户当前所在层级） */
    initialId: { type: String, value: '' }
  },

  data: {
    catTree: [],
    catSearchKw: '',
    catSearchResult: [],
    catLevel1: [],
    catLevel2: [],
    catLevel3: [],
    curL1: -1,
    curL2: -1,
    catLoading: false,
    // 切换上级时把对应列表滚回顶部，否则停留在上一级的滚动位置
    catL2ScrollTop: 0,
    catL3ScrollTop: 0,
    // 自定义类目创建（表单是 cat-create 组件）
    catCreateVisible: false,
    catCreateInit: { name: '', level: 1, parent1: '', parent2: '' }
  },

  observers: {
    /**
     * 面板打开时重置状态
     *
     * 必须重置：上次会话残留的搜索词与层级对新一次选择毫无意义，
     * 表现为「一打开就停在某个二级上，用户莫名其妙」。
     */
    visible(v) {
      if (!v) return;
      this.setData({
        catSearchKw: '',
        catSearchResult: [],
        curL1: -1,
        curL2: -1,
        catLevel2: [],
        catLevel3: [],
        catL2ScrollTop: 0,
        catL3ScrollTop: 0
      });
      if (!this.data.catTree.length) this.loadCatTree();
      this.locateInitial();
    }
  },

  methods: {
    /**
     * 预加载类目树
     *
     * 供宿主页提前调用：手动录入面板展开时就把树拉好，
     * 等用户点「选择类目」时面板能立刻显示，不必等一次云函数往返。
     */
    preload() {
      if (!this.data.catTree.length) this.loadCatTree();
    },

    /** 载入类目树 */
    async loadCatTree() {
      this.setData({ catLoading: true });
      try {
        const res = await cloud.categoryTree();
        const tree = (res && res.data && res.data.tree) || [];
        this.setData({
          catTree: tree,
          catLevel1: tree.map((t, i) => ({ ...t, _i: i })),
          catLevel2: [],
          catLevel3: [],
          curL1: -1,
          curL2: -1
        });
        // 树载入完成后再定位（第一次打开时树还是空的）
        this.locateInitial();
      } catch (e) {
        wx.showToast({ title: e.message || '类目加载失败', icon: 'none' });
      } finally {
        this.setData({ catLoading: false });
      }
    },

    /**
     * 定位到 initialId 所在的层级
     *
     * 编辑账单时用户当前就在某个三级类目下，
     * 打开面板直接看到那一栏，比让他从根列表重新翻要省事得多。
     */
    locateInitial() {
      const id = this.properties.initialId;
      if (!id || !this.data.catTree.length) return;

      const tree = this.data.catTree;
      for (let i = 0; i < tree.length; i++) {
        const t = tree[i];
        const kids = t.children || [];
        for (let j = 0; j < kids.length; j++) {
          const l2 = kids[j];
          const l3s = l2.children || [];
          for (let k = 0; k < l3s.length; k++) {
            if (l3s[k].id === id) {
              this.setData({
                curL1: i,
                curL2: j,
                catLevel2: kids.map((c, m) => ({ ...c, _i: m })),
                catLevel3: l3s.map((c, m) => ({ ...c, _i: m }))
              });
              return;
            }
          }
          if (l2.id === id) {
            this.setData({
              curL1: i,
              curL2: j,
              catLevel2: kids.map((c, m) => ({ ...c, _i: m })),
              catLevel3: []
            });
            return;
          }
        }
        if (t.id === id) {
          this.setData({
            curL1: i,
            curL2: -1,
            catLevel2: kids.map((c, m) => ({ ...c, _i: m })),
            catLevel3: []
          });
          return;
        }
      }
    },

    closePicker() {
      this.triggerEvent('cancel');
    },

    /** 阻止冒泡，避免点击面板内部误触关闭 */
    noop() {},

    /** 选择一级类目 */
    onPickL1(e) {
      const i = Number(e.currentTarget.dataset.i);
      const t = this.data.catTree[i];
      if (!t) return;
      // 空一级直接选中：用户新建的一级大类下还没有二级时，
      // 点它就该落账（path=一级名），否则会卡在「怎么都点不动」。
      // 预置一级都有 children，只有自定义空一级走这个分支
      if (!(t.children || []).length) {
        this.commit(t.id, t.path || t.name, t.name);
        return;
      }
      // catLevel3 必须一并清空：否则上一个一级下的末级会残留在右侧，
      // 表现为「二级是服饰美容、三级却是餐饮的买菜」这种串数据
      this.setData({
        curL1: i,
        curL2: -1,
        catLevel2: (t.children || []).map((c, j) => ({ ...c, _i: j })),
        catLevel3: [],
        catL2ScrollTop: 0,
        catL3ScrollTop: 0
      });
    },

    /** 选择二级类目 */
    onPickL2(e) {
      const j = Number(e.currentTarget.dataset.j);
      const l2 = this.data.catLevel2[j];
      if (!l2) return;
      const kids = l2.children || [];
      // 该二级没有末级时，直接把它当作可选结果提交，
      // 否则用户会卡在「怎么都点不动」
      if (!kids.length) {
        this.commit(l2.id, l2.path || l2.name, l2.name);
        return;
      }
      this.setData({
        curL2: j,
        catLevel3: kids.map((c, k) => ({ ...c, _i: k })),
        catL3ScrollTop: 0
      });
    },

    /** 选择末级类目 */
    onPickL3(e) {
      const k = Number(e.currentTarget.dataset.k);
      const l3 = this.data.catLevel3[k];
      if (!l3) return;
      this.commit(l3.id, l3.path, l3.name);
    },

    commit(id, path, name) {
      this.triggerEvent('select', { id, path: path || '', name: name || '' });
    },

    /** 从搜索结果中选中 */
    onPickSearchResult(e) {
      const i = Number(e.currentTarget.dataset.i);
      const item = this.data.catSearchResult[i];
      if (!item) return;
      this.commit(item.id, item.path, item.name);
    },

    /** 搜索类目（防抖 250ms，避免每敲一个字就打一次云函数） */
    onCatSearch(e) {
      const kw = e.detail.value;
      this.setData({ catSearchKw: kw });

      if (this.searchTimer) clearTimeout(this.searchTimer);
      if (!kw.trim()) {
        this.setData({ catSearchResult: [] });
        return;
      }
      this.searchTimer = setTimeout(() => this.doCatSearch(kw), 250);
    },

    async doCatSearch(kw) {
      try {
        const res = await cloud.categorySearch(kw);
        const list = (res && res.data && res.data.list) || [];
        this.setData({ catSearchResult: list });
        // 搜不到时不再弹 toast：空态里已有「新增」按钮，
        // toast + 按钮同时出现是双重提示，按钮本身就说清楚了「没有匹配」
      } catch (err) {
        wx.showToast({ title: err.message || '搜索失败', icon: 'none' });
      }
    },

    // ══════════════════════════════════════════════════
    //  自定义类目
    // ══════════════════════════════════════════════════

    /** 搜索无结果 → 以当前关键词直接开建（末级语义：还得挑父类两级） */
    onCreateFromSearch() {
      this.setData({
        catCreateVisible: true,
        catCreateInit: { name: this.data.catSearchKw || '', level: 3, parent1: '', parent2: '' }
      });
    },

    /**
     * 底部常驻入口「＋ 新增自定义类目」
     *
     * 上下文感知默认值：按当前浏览位置预填层级与父类，
     * 让「在哪儿点的新增」天然等于「想建在哪儿」——
     *   停在某二级下 → 默认建三级挂它；停在某一级下 → 默认建二级挂它；
     *   还在根列表   → 默认建一级
     */
    onOpenCreateCategory() {
      const { curL1, curL2, catTree, catLevel2 } = this.data;
      let level = 1;
      let parent1 = '';
      let parent2 = '';

      if (curL2 >= 0 && catLevel2[curL2]) {
        const l2 = catLevel2[curL2];
        level = 3;
        parent2 = l2.id;
        const t = curL1 >= 0 ? catTree[curL1] : null;
        parent1 = t && (t.children || []).some((c) => c.id === l2.id) ? t.id : '';
      } else if (curL1 >= 0 && catTree[curL1]) {
        level = 2;
        parent1 = catTree[curL1].id;
      }

      this.setData({
        catCreateVisible: true,
        catCreateInit: { name: '', level, parent1, parent2 }
      });
    },

    onCancelCreateCategory() {
      this.setData({ catCreateVisible: false });
    },

    /**
     * 组件创建成功（含「预置同名劝用现成类目」）→ 刷新树并自动选用
     *
     * 在选类目的流程里建类目就是为了选这一个，建完还要再去找一遍是多余的往返
     */
    async onCatCreated(e) {
      const cat = e.detail && e.detail.category;
      if (!cat) return;

      this.setData({ catCreateVisible: false });
      // 类目树缓存作废：新类目要出现在对应层级里
      await this.loadCatTree();
      this.commit(cat.id, cat.path, cat.name);
    }
  }
});
