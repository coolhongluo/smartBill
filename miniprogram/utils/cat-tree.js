/**
 * 类目树工具 —— 新增自定义类目时的「二级候选」计算
 *
 * ## 为什么要单独成文件
 *
 * 这个逻辑原来写在 cat-create.js 的组件方法里，改错了**没有任何报错**：
 * 界面照常渲染，只是二级列表不对，提交时才被云端拒绝。
 * 抽成纯函数后可以直接跑测试断言。
 *
 * ## 关键约束：虚拟分组不是真类目
 *
 * category-svc 的树里，早期「挂在一级下的末级」会被收进一个
 * **虚拟分组**（id = `custom_{topId}`，name = 「自定义」，customGroup = true）。
 * 它是展示用的容器，不是二级类目：
 *
 *   · 选它当二级 → 云端 resolveNode 找不到 → 报「上级必须是二级类目」
 *   · 它没有 custom 标记 → 界面上也看不出它跟真二级有什么区别
 *
 * 所以二级候选必须过滤掉 customGroup。
 */

/**
 * 取某个一级大类下的二级候选（新建三级类目时用）
 *
 * @param {Array} tree  类目树（一级 → children 为二级）
 * @param {string} topId 选中的一级类目 id
 * @returns {Array} 二级候选 [{ id, name, color, custom }]
 */
function l2OptionsOf(tree, topId) {
  const tops = Array.isArray(tree) ? tree : [];
  const top = tops.find((x) => x && x.id === topId);
  if (!top) return [];

  const children = Array.isArray(top.children) ? top.children : [];
  return children
    // 虚拟分组不是二级类目，过滤掉
    .filter((c) => c && !c.customGroup)
    .map((c) => ({
      id: c.id,
      name: c.name,
      // 子类目常无独立配色，继承所属一级的
      color: c.color || top.color,
      custom: !!c.custom
    }));
}

module.exports = { l2OptionsOf };
