/**
 * cat-create 组件（新增自定义类目）的契约测试
 *
 * ## 为什么这个测试存在
 *
 * 真实故障：「类目管理 → 新增自定义分类 → 新增三级分类，无法选择正确的二级分类项目」。
 *
 * 这是**两个缺陷叠加**，而且**全程零报错**：
 *
 * ① **布局塌陷**（主因）
 *    `.cc-card` 只有 `max-height: 80vh`，容器高度**不确定**，
 *    flex 分配就没有基准。`.cc-l2-scroll` 写的是 `flex: 1; min-height: 0`，
 *    `min-height: 0` 允许它被压到 0 高度。
 *    一级 chips 越多（预置 12 个 + 自建一级），二级候选区被挤得越小：
 *      · 12 个一级 → 二级区 51px（内容 115px，要滚动才看全）
 *      · 17 个一级 → 二级区 **0px**（完全看不见，点不到）
 *    浏览器实测（375×667）：「12 预置 + 5 自建」时二级区高度 = 0。
 *
 * ② **虚拟分组混入候选**
 *    category-svc 的树里，早期「挂在一级下的末级」收在虚拟分组
 *    `custom_{topId}`（name=「自定义」，customGroup=true）里。
 *    它是展示容器，**不是二级类目**，选它提交必然被云端拒绝。
 *    而它没有 custom 标记，界面上也看不出它跟真二级有什么区别。
 *
 * 两个缺陷都不会抛异常：云函数返回正常、组件渲染正常，
 * 只是「二级选项要么看不见、要么是假的」。
 *
 * ## 这个测试守什么
 *
 * ① **数据契约**：从 cat-create.wxml 真解析出二级循环绑定了哪些字段，
 *    断言视图模型（utils/cat-tree.js）全部产出，且**值不是 undefined**
 *    ——「有 key 但值 undefined」正是原始 bug，只查 key 会漏。
 * ② **虚拟分组必须被过滤**：造一条带 customGroup 的树，断言它不进候选。
 * ③ **布局守卫**：断言 wxss 里二级候选区有 min-height 下限、
 *    且选父类时卡片有确定高度 —— 这两条正是防塌陷的锚点。
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { l2OptionsOf } = require('../../miniprogram/utils/cat-tree.js');

const ROOT = path.resolve(__dirname, '..', '..');
const WXML = path.join(ROOT, 'miniprogram', 'components', 'cat-create', 'cat-create.wxml');
const WXSS = path.join(ROOT, 'miniprogram', 'components', 'cat-create', 'cat-create.wxss');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
  }
}

const wxml = fs.readFileSync(WXML, 'utf8');
const wxss = fs.readFileSync(WXSS, 'utf8');

/** 抠出二级候选循环（wx:for="{{l2Options}}"）的正文 */
function l2LoopBody() {
  const start = wxml.indexOf('wx:for="{{l2Options}}"');
  assert.ok(start >= 0, 'cat-create.wxml 里找不到二级候选循环');
  // 循环体结束于下一个 wx:for 或该 block 结束
  const next = wxml.indexOf('wx:for=', start + 10);
  const end = next > 0 ? next : wxml.length;
  return wxml.slice(start, end);
}

console.log('\n【二级候选：数据契约】');

test('二级候选循环必须存在', () => {
  assert.ok(wxml.includes('wx:for="{{l2Options}}"'), 'cat-create.wxml 里没有二级候选循环');
});

test('视图模型产出二级循环绑定的每一个字段，且值不为 undefined', () => {
  const body = l2LoopBody();
  // 循环体里所有 {{item.xxx}} 形式的绑定
  const bound = [...body.matchAll(/\{\{\s*item\.([A-Za-z0-9_]+)\s*\}\}/g)].map((m) => m[1]);
  assert.ok(bound.length > 0, '二级循环里没解析出任何 item 绑定');

  const opts = l2OptionsOf([{ id: 'c1', name: '餐饮', color: '#E8836F', children: [
    { id: 'c1_1', name: '在家吃饭', color: '#E8836F', children: [] }
  ] }], 'c1');
  assert.ok(opts.length > 0, '二级候选为空，无法校验字段');

  for (const field of new Set(bound)) {
    for (const o of opts) {
      assert.ok(field in o, `视图模型缺字段 ${field}`);
      assert.notStrictEqual(o[field], undefined, `字段 ${field} 的值是 undefined`);
    }
  }
});

test('未知一级返回空数组而不是抛异常', () => {
  assert.deepStrictEqual(l2OptionsOf([], 'c1'), []);
  assert.deepStrictEqual(l2OptionsOf(undefined, 'c1'), []);
  assert.deepStrictEqual(l2OptionsOf([{ id: 'c1', children: [] }], 'c999'), []);
});

test('一级没有 children 时返回空数组', () => {
  assert.deepStrictEqual(l2OptionsOf([{ id: 'c1', name: '餐饮' }], 'c1'), []);
});

console.log('\n【虚拟分组必须过滤】');

test('customGroup 虚拟分组不进二级候选', () => {
  const tree = [{
    id: 'c1', name: '餐饮', color: '#E8836F',
    children: [
      { id: 'c1_1', name: '在家吃饭', color: '#E8836F', children: [] },
      { id: 'c1_2', name: '外出就餐', color: '#E8836F', children: [] },
      // 早期存量数据：挂在一级下的末级 → 云端收进虚拟分组
      { id: 'custom_c1', name: '自定义', color: '#E8836F', customGroup: true, children: [] }
    ]
  }];
  const opts = l2OptionsOf(tree, 'c1');
  const ids = opts.map((o) => o.id);
  assert.ok(ids.includes('c1_1') && ids.includes('c1_2'), '真二级被误删了');
  assert.ok(!ids.includes('custom_c1'), '虚拟分组 custom_c1 混进了二级候选');
});

test('自定义二级（custom=true）保留在候选里，且带 custom 标记', () => {
  const tree = [{
    id: 'c1', name: '餐饮', color: '#E8836F',
    children: [{ id: 'u001', name: '宠物医疗', color: '#E8836F', custom: true, children: [] }]
  }];
  const opts = l2OptionsOf(tree, 'c1');
  assert.strictEqual(opts.length, 1);
  assert.strictEqual(opts[0].custom, true, '自定义二级丢了 custom 标记');
});

test('二级缺 color 时继承所属一级的配色', () => {
  const tree = [{
    id: 'c1', name: '餐饮', color: '#E8836F',
    children: [{ id: 'c1_1', name: '在家吃饭', children: [] }]
  }];
  const opts = l2OptionsOf(tree, 'c1');
  assert.strictEqual(opts[0].color, '#E8836F');
});

console.log('\n【布局守卫：防二级区塌陷】');

test('二级候选区必须有 min-height 下限（且不能是 0）', () => {
  const m = wxss.match(/\.cc-l2-scroll\s*\{([^}]*)\}/);
  assert.ok(m, 'wxss 里找不到 .cc-l2-scroll 规则');
  const min = m[1].match(/min-height\s*:\s*(\d+)\s*(rpx|px|vh|%)?/);
  assert.ok(min, '.cc-l2-scroll 缺 min-height —— 一级 chips 一多，二级区会被压成 0 高度（原始 bug）');
  // ⚠️ 必须断言值 > 0：`min-height: 0` 同样匹配「有 min-height」，
  // 但它恰恰就是原始 bug（允许被压成 0 高度）。只查「有没有」会漏。
  assert.ok(Number(min[1]) > 0, '.cc-l2-scroll 的 min-height 是 0，等于没设下限');
});

test('选父类时卡片必须有确定高度（is-pick）', () => {
  assert.ok(/\.cc-card\.is-pick\s*\{[^}]*height\s*:/.test(wxss),
    '缺 .cc-card.is-pick 的确定高度 —— 容器高度不确定时 flex 分配没有基准');
  assert.ok(wxml.includes('is-pick'),
    'cat-create.wxml 里没给卡片加 is-pick 类，样式挂不上');
});

test('一级 chips 区限高，不许无限吃掉卡片', () => {
  const m = wxss.match(/\.cc-l1-scroll\s*\{([^}]*)\}/);
  assert.ok(m, 'wxss 里找不到 .cc-l1-scroll 规则');
  const max = m[1].match(/max-height\s*:\s*(\d+)/);
  assert.ok(max, '.cc-l1-scroll 缺 max-height —— 一级条目多时会把二级候选区挤没');
  assert.ok(Number(max[1]) > 0, '.cc-l1-scroll 的 max-height 是 0，等于没限高');
});

console.log(`\n${failed === 0 ? '全部通过' : '有失败项'}：${passed} 通过 / ${failed} 失败\n`);
if (failed > 0) process.exit(1);
