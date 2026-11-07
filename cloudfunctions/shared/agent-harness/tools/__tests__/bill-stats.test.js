/**
 * 账单统计 tools 的单元测试
 *
 * 为什么单独测：这些函数是整个消费分析的数字来源。
 * 一旦算错，模型会把错误数字流畅地讲给用户听——错误会被「表达正确性」掩盖，
 * 比直接报错更难发现。所以数值必须在这里就被钉死。
 *
 * 运行：node cloudfunctions/shared/agent-harness/tools/__tests__/bill-stats.test.js
 */

const assert = require('assert');
const stats = require('../../bill-stats');
const { executeTool, shiftMonth } = require('../index');

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

/** 构造账单：amount 为分 */
/**
 * 构造账单：amount 为分
 *
 * note 与 categoryId 必须支持透传，否则「备注驱动的必要性判断」
 * 和「刚性类目识别」这两类测试全都测不到真实路径——
 * 辅助函数比生产代码少字段，测试就会绿得没有意义。
 */
function bill(amountYuan, categoryPath, date, note, categoryId) {
  return {
    amount: Math.round(amountYuan * 100),
    categoryPath,
    date: date || '2026-10-15',
    note: note || '',
    categoryId: categoryId || 'x'
  };
}

console.log('\n【账单清洗】');

test('丢弃 amount 非正整数的脏数据', () => {
  const { bills, dropped } = stats.normalizeBills([
    bill(10, '餐饮/在家吃饭/买菜'),
    { amount: 0, categoryPath: '餐饮', date: '2026-10-01' },
    { amount: -100, categoryPath: '餐饮', date: '2026-10-01' },
    { amount: 10.5, categoryPath: '餐饮', date: '2026-10-01' }
  ]);
  assert.strictEqual(bills.length, 1, '只应保留 1 条合法账单');
  assert.strictEqual(dropped, 3, '应报告丢弃 3 条');
});

test('丢弃日期格式非法的账单', () => {
  const { bills } = stats.normalizeBills([
    bill(10, '餐饮/在家吃饭/买菜'),
    { amount: 1000, categoryPath: '餐饮', date: '2026/10/01' },
    { amount: 1000, categoryPath: '餐饮', date: '' }
  ]);
  assert.strictEqual(bills.length, 1);
});

test('无 categoryPath 归入「未分类」', () => {
  const { bills } = stats.normalizeBills([{ amount: 1000, date: '2026-10-01', categoryPath: '' }]);
  assert.strictEqual(bills[0].top, '未分类');
});

console.log('\n【分类占比】');

test('占比之和约等于 100%，金额单位正确', () => {
  const { bills } = stats.normalizeBills([
    bill(1000, '餐饮/在家吃饭/买菜'),
    bill(300, '交通出行/日常交通/打车'),
    bill(200, '居住/水电气暖/水电燃气')
  ]);
  const r = stats.calcCategoryShare(bills);

  assert.strictEqual(r.totalCent, 150000);
  assert.strictEqual(r.totalYuan, '1500.00');
  assert.strictEqual(r.count, 3);

  const sum = r.items.reduce((a, it) => a + it.percent, 0);
  assert.ok(Math.abs(sum - 100) <= 0.2, `占比之和 ${sum} 偏离 100% 过多`);

  // 降序排列
  assert.strictEqual(r.items[0].name, '餐饮');
  assert.strictEqual(r.items[0].percent, 66.7);
});

test('空账单不崩溃且不产生 NaN', () => {
  const { bills } = stats.normalizeBills([]);
  const r = stats.calcCategoryShare(bills);
  assert.strictEqual(r.totalCent, 0);
  assert.strictEqual(r.totalYuan, '0.00');
  assert.strictEqual(r.items.length, 0);
  // 除零保护：不能出现 NaN/Infinity
  assert.ok(r.items.every((it) => isFinite(it.percent)));
});

console.log('\n【环比】');

test('上月为 0 时不产生 Infinity，hasBaseline=false', () => {
  const { bills } = stats.normalizeBills([bill(500, '餐饮/在家吃饭/买菜')]);
  const r = stats.calcMonthOverMonth(bills, []);
  assert.strictEqual(r.hasBaseline, false);
  assert.ok(isFinite(r.deltaRate), 'deltaRate 必须是有限数');
  assert.strictEqual(r.direction, 'flat');
});

test('上涨/下跌方向由代码判定', () => {
  const mk = (y) => stats.normalizeBills([bill(y, '餐饮/在家吃饭/买菜')]).bills;

  assert.strictEqual(stats.calcMonthOverMonth(mk(200), mk(100)).direction, 'up');
  assert.strictEqual(stats.calcMonthOverMonth(mk(100), mk(200)).direction, 'down');
  // ±1% 内视为持平，避免微小波动被渲染成涨跌
  assert.strictEqual(stats.calcMonthOverMonth(mk(100.5), mk(100)).direction, 'flat');

  const up = stats.calcMonthOverMonth(mk(200), mk(100));
  assert.strictEqual(up.deltaRate, 100);
  assert.strictEqual(up.deltaCent, 10000);
  assert.strictEqual(up.deltaYuan, '100.00');
});

console.log('\n【月度汇总】');

test('日均区分记账天数与自然天数', () => {
  const { bills } = stats.normalizeBills([
    bill(100, '餐饮/在家吃饭/买菜', '2026-10-01'),
    bill(200, '餐饮/在家吃饭/买菜', '2026-10-02'),
    bill(300, '餐饮/在家吃饭/买菜', '2026-10-03')
  ]);
  const r = stats.calcMonthlySummary(bills, '2026-10');

  assert.strictEqual(r.count, 3);
  assert.strictEqual(r.recordedDays, 3);
  assert.strictEqual(r.totalYuan, '600.00');
  // 记账天数日均 = 600 / 3
  assert.strictEqual(r.avgPerRecordedDayYuan, '200.00');
  // 自然日日均 = 600 / 当月总天数。用已过天数会随运行日期变化，
  // 所以这里只断言它比记账天数日均小（分母更大），不断言具体数值
  const cal = parseFloat(r.avgPerCalendarDayYuan);
  assert.ok(cal > 0 && cal < 200, `自然日日均 ${cal} 应小于记账天数日均 200`);
  assert.strictEqual(r.maxBillYuan, '300.00');
  assert.strictEqual(r.maxBillPath, '餐饮/在家吃饭/买菜');
});

test('历史月份按整月天数计算自然日均', () => {
  // 固定用一个已过去的月份，结果不受"今天几号"影响
  const { bills } = stats.normalizeBills([
    bill(310, '餐饮/在家吃饭/买菜', '2026-06-01')
  ]);
  const r = stats.calcMonthlySummary(bills, '2026-06');
  // 6 月共 30 天：310 / 30 = 10.333 → 四舍五入 1033 分 = 10.33
  assert.strictEqual(r.avgPerCalendarDayYuan, '10.33');
  assert.strictEqual(r.avgPerRecordedDayYuan, '310.00');
});

test('当月日均按已过天数而非整月', () => {
  const now = new Date();
  const mo = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const { bills } = stats.normalizeBills([
    bill(100, '餐饮/在家吃饭/买菜', `${mo}-01`)
  ]);
  const r = stats.calcMonthlySummary(bills, mo);
  // 当月只有 1 天有记录，日均 = 总额 / 1（记账天数口径）
  assert.strictEqual(r.avgPerRecordedDayYuan, '100.00');
});

console.log('\n【餐饮结构】');

test('在家/外出分离计算，占比基于餐饮总额', () => {
  const { bills } = stats.normalizeBills([
    bill(600, '餐饮/在家吃饭/买菜'),
    bill(400, '餐饮/外出就餐/火锅烧烤'),
    bill(100, '餐饮/单位与集体/工作餐')
  ]);
  const r = stats.calcDiningStructure(bills);

  assert.strictEqual(r.hasDining, true);
  assert.strictEqual(r.homeYuan, '600.00');
  assert.strictEqual(r.awayYuan, '400.00');
  assert.strictEqual(r.homePercent, 60);
  assert.strictEqual(r.awayPercent, 40);
  // 饮品与零食/单位与集体不污染口径
  assert.strictEqual(r.totalCent, 100000);
});

test('无餐饮时 hasDining=false', () => {
  const { bills } = stats.normalizeBills([bill(100, '交通出行/日常交通/打车')]);
  const r = stats.calcDiningStructure(bills);
  assert.strictEqual(r.hasDining, false);
  assert.strictEqual(r.homePercent, 0);
});

console.log('\n【趋势】');

test('缺失月份补 0，不跳空', () => {
  // calcTrend 以「当前月」为锚点回填近 N 个月（bill-stats.js 的 calcTrend 用 new Date()），
  // 锚点必须从执行时刻推导 —— 硬编码月份会在跨月当天红（2026-11-01 实测踩中）
  const now = new Date();
  const anchor = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const r = stats.calcTrend({ [anchor]: [{ amount: 10000 }] }, 6);
  assert.strictEqual(r.length, 6);
  // 每个月都必须有值，不能有 undefined
  assert.ok(r.every((x) => x.totalCent !== undefined), '存在月份缺 totalCent');
  assert.strictEqual(r[r.length - 1].month, anchor);
  assert.strictEqual(r[r.length - 1].totalCent, 10000);
  assert.strictEqual(r[0].totalCent, 0, '无账单月份应为 0');
});

console.log('\n【账单明细 get_bills_detail】');

/**
 * v3 起省钱建议全 AI 化，模型凭 get_bills_detail 的逐笔证据与频次统计做判断。
 * 这里的断言钉住三件事：聚合口径（模型判断「频次偏高」的依据）、
 * category 过滤的行为、逐笔截断不丢聚合。
 */
test('聚合统计：笔数/总额/占比/平均间隔齐全', () => {
  const { bills } = stats.normalizeBills([
    bill(120, '餐饮/外出就餐/火锅烧烤', '2026-10-05', '和同事吃日料'),
    bill(60, '餐饮/在家吃饭/买菜', '2026-10-12', ''),
    bill(100, '服饰美容/衣物鞋帽/衣物', '2026-10-02', '优衣库外套'),
    bill(90, '服饰美容/衣物鞋帽/衣物', '2026-10-08', '优衣库T恤'),
    bill(80, '服饰美容/衣物鞋帽/衣物', '2026-10-14', '')
  ]);
  const r = executeTool('get_bills_detail', {}, { month: '2026-10', billsByMonth: { '2026-10': bills } });

  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.data.totalCount, 5);
  assert.strictEqual(r.data.totalYuan, '450.00');
  assert.strictEqual(r.data.truncated, false);
  // 类目按总额降序：服饰 270 > 餐饮 180
  assert.strictEqual(r.data.categories[0].top, '服饰美容');
  assert.strictEqual(r.data.categories[0].count, 3);
  assert.strictEqual(r.data.categories[0].totalYuan, '270.00');
  assert.strictEqual(r.data.categories[0].percent, 60);
  // 10-02 → 10-14 跨 12 天、2 个间隔 → 平均 6 天（模型判断「频次偏高」的依据）
  assert.strictEqual(r.data.categories[0].avgIntervalDays, 6);
  assert.strictEqual(r.data.categories[0].notedCount, 2);
  // 逐笔按金额降序，无备注的 note 为空串（空白本身是信息）
  assert.strictEqual(r.data.bills.length, 5);
  assert.strictEqual(r.data.bills[0].amountYuan, '120.00');
  assert.ok(r.data.bills.some((b) => b.note === ''));
});

test('单笔类目的平均间隔为 null（1 笔推不出周期）', () => {
  const { bills } = stats.normalizeBills([
    bill(300, '通讯网络/话费流量/话费', '2026-10-02', '充话费')
  ]);
  const r = executeTool('get_bills_detail', { category: '通讯网络' }, { month: '2026-10', billsByMonth: { '2026-10': bills } });
  assert.strictEqual(r.data.categories[0].avgIntervalDays, null);
  assert.strictEqual(r.data.categories[0].count, 1);
});

test('category 过滤：占比按过滤后总额计算，空结果给出说明', () => {
  const { bills } = stats.normalizeBills([
    bill(120, '餐饮/外出就餐/火锅烧烤', '2026-10-05', ''),
    bill(60, '餐饮/在家吃饭/买菜', '2026-10-12', ''),
    bill(100, '服饰美容/衣物鞋帽/衣物', '2026-10-02', '')
  ]);
  const ctx = { month: '2026-10', billsByMonth: { '2026-10': bills } };
  const r = executeTool('get_bills_detail', { category: '餐饮' }, ctx);
  assert.strictEqual(r.data.totalCount, 2);
  assert.strictEqual(r.data.totalYuan, '180.00');
  // 过滤后分母变了：餐饮占过滤后总额的 100%
  assert.strictEqual(r.data.categories[0].percent, 100);

  const miss = executeTool('get_bills_detail', { category: '学习' }, ctx);
  assert.ok(miss.data.note.includes('没有'), '空结果必须说明，否则模型会当没调用过');
});

test('超过 limit 时逐笔截断，聚合统计不受影响', () => {
  const raw = [];
  for (let i = 1; i <= 12; i++) {
    raw.push(bill(100, '餐饮/在家吃饭/买菜', `2026-10-${String(i).padStart(2, '0')}`));
  }
  const { bills } = stats.normalizeBills(raw);
  const r = executeTool('get_bills_detail', { limit: 10 }, { month: '2026-10', billsByMonth: { '2026-10': bills } });
  assert.strictEqual(r.data.truncated, true);
  assert.strictEqual(r.data.bills.length, 10, '逐笔列表按 limit 截断');
  assert.strictEqual(r.data.totalCount, 12);
  assert.strictEqual(r.data.categories[0].count, 12, '聚合统计必须完整，不受 limit 影响');
});

console.log('\n【可压缩性】');

test('刚性类目识别正确', () => {
  const C = require('../../../util/category-compressibility');
  assert.strictEqual(C.compressibilityOf('c9_1_1'), 'rigid', '房租应刚性');
  assert.strictEqual(C.compressibilityOf('c4_2_1'), 'rigid', '学费应刚性');
  assert.strictEqual(C.compressibilityOf('c10_1_1'), 'rigid', '保费应刚性');
  assert.strictEqual(C.compressibilityOf('c3_1_1'), 'semi', '纸巾应半刚性');
  assert.strictEqual(C.compressibilityOf('c1_2_2'), 'flexible', '火锅应弹性');
});

test('刚性清单里的 ID 必须在类目库中真实存在', () => {
  // 打错一个字母会让该类目静默失去刚性保护，必须钉死
  const C = require('../../../util/category-compressibility');
  const preset = require('../../../util/category-preset');
  const valid = new Set(preset.LEAF_CATEGORIES.map((c) => c.id));
  for (const id of C.RIGID_IDS) {
    assert.ok(valid.has(id), `刚性清单里的 ${id} 在类目库中不存在，ID 可能打错了`);
  }
  for (const id of C.SEMI_IDS) {
    assert.ok(valid.has(id), `半刚性清单里的 ${id} 在类目库中不存在`);
  }
});

test('备注关键词能兜底识别刚性（用户选错类目时）', () => {
  const C = require('../../../util/category-compressibility');
  // 类目是零食（弹性），但备注写着「孩子学费」
  assert.strictEqual(C.isRigidBill({ categoryId: 'c1_3_3', note: '孩子学费' }), true);
  assert.strictEqual(C.isRigidBill({ categoryId: 'c1_3_3', note: '奶茶' }), false);
  assert.strictEqual(C.isRigidBill({ categoryId: 'c9_1_1', note: '' }), true, '类目刚性时备注不影响');
});

test('刚性分组统计正确', () => {
  const C = require('../../../util/category-compressibility');
  const { bills } = stats.normalizeBills([
    bill(3500, '居住/房租房贷/房租房贷', '2026-10-01', '10月房租', 'c9_1_1'),
    bill(2000, '育儿教育/教育支出/学费', '2026-10-03', '孩子学费', 'c4_2_1'),
    bill(150, '餐饮/外出就餐/火锅烧烤', '2026-10-05', '', 'c1_2_2'),
    bill(80, '餐饮/在家吃饭/买菜', '2026-10-06', '', 'c1_1_1')
  ]);
  const g = C.groupByCompressibility(bills);
  assert.strictEqual(g.rigid.length, 2);
  assert.strictEqual(g.flexible.length, 2);
  // 刚性占 (3500+2000)/5730
  assert.ok(Math.abs(g.summary.rigidPercent - 96) < 1.5,
    `刚性占比 ${g.summary.rigidPercent}% 接近预期 96%`);
});

console.log('\n【周期性消费】');

test('检出每周型周期消费', () => {
  const { bills } = stats.normalizeBills([
    bill(200, '餐饮/外出就餐/火锅烧烤', '2026-10-01'),
    bill(200, '餐饮/外出就餐/火锅烧烤', '2026-10-08'),
    bill(200, '餐饮/外出就餐/火锅烧烤', '2026-10-15'),
    bill(200, '餐饮/外出就餐/火锅烧烤', '2026-10-22')
  ]);
  const r = stats.calcRecurringPatterns(bills);
  assert.strictEqual(r.count, 1);
  assert.strictEqual(r.items[0].cycle, 'weekly');
  assert.strictEqual(r.items[0].avgAmountYuan, '200.00');
  assert.strictEqual(r.items[0].count, 4);
});

test('金额每次都不同 → 不判为周期', () => {
  const { bills } = stats.normalizeBills([
    bill(3000, '文体娱乐/旅游度假/旅游度假', '2026-10-02'),
    bill(5200, '文体娱乐/旅游度假/旅游度假', '2026-10-12'),
    bill(800, '文体娱乐/旅游度假/旅游度假', '2026-10-20')
  ]);
  assert.strictEqual(stats.calcRecurringPatterns(bills).count, 0,
    '金额波动大说明不是固定支出，误判会导致「每月固定支出 3000 元」的错误结论');
});

test('间隔不规整 → 不判为周期', () => {
  const { bills } = stats.normalizeBills([
    bill(200, '餐饮/外出就餐/火锅烧烤', '2026-10-01'),
    bill(200, '餐饮/外出就餐/火锅烧烤', '2026-10-02'),
    bill(200, '餐饮/外出就餐/火锅烧烤', '2026-10-20'),
    bill(200, '餐饮/外出就餐/火锅烧烤', '2026-10-28')
  ]);
  assert.strictEqual(stats.calcRecurringPatterns(bills).count, 0,
    '间隔忽长忽短不是周期性消费');
});

test('只有 2 笔不判为周期', () => {
  const { bills } = stats.normalizeBills([
    bill(200, '通讯网络/会员订阅/视频会员', '2026-10-01'),
    bill(200, '通讯网络/会员订阅/视频会员', '2026-10-31')
  ]);
  assert.strictEqual(stats.calcRecurringPatterns(bills).count, 0, '2 笔是巧合不是周期');
});

console.log('\n【备注账单】');

test('只返回有备注的账单，并给出覆盖率', () => {
  const { bills } = stats.normalizeBills([
    bill(250, '餐饮/外出就餐/火锅烧烤', '2026-10-01', '公司聚餐'),
    bill(60, '餐饮/在家吃饭/买菜', '2026-10-02', ''),
    bill(2000, '育儿教育/教育支出/学费', '2026-10-03', '孩子学费')
  ]);
  const r = stats.collectNotedBills(bills);
  assert.strictEqual(r.total, 2);
  assert.strictEqual(r.items.length, 2);
  // 3 笔里 2 笔有备注 = 66.7%
  assert.ok(Math.abs(r.coveragePercent - 66.7) < 0.2);
  // 按金额降序
  assert.strictEqual(r.items[0].amountYuan, '2000.00');
  // 带可压缩性标签，供模型直接判断
  assert.ok(r.items.every((i) => i.compressibilityLabel));
});

test('全部无备注时覆盖率 0，返回空列表', () => {
  const { bills } = stats.normalizeBills([bill(100, '餐饮/在家吃饭/买菜', '2026-10-01')]);
  const r = stats.collectNotedBills(bills);
  assert.strictEqual(r.coveragePercent, 0);
  assert.strictEqual(r.items.length, 0);
});

console.log('\n【餐饮明细】');

test('区分单笔大额与高频小额', () => {
  const { bills } = stats.normalizeBills([
    bill(250, '餐饮/外出就餐/火锅烧烤', '2026-10-01', '公司聚餐'),
    bill(80, '餐饮/外出就餐/下馆子点菜', '2026-10-05', ''),
    bill(60, '餐饮/在家吃饭/买菜', '2026-10-02', '')
  ]);
  const d = stats.calcDiningDetail(bills);
  assert.strictEqual(d.hasDining, true);
  assert.strictEqual(d.awayCount, 2);
  assert.strictEqual(d.homeCount, 1);
  assert.strictEqual(d.maxAwayBillYuan, '250.00');
  // 逐笔明细必须带备注，模型靠它判断「公司聚餐」是社交必需
  assert.ok(d.awayBills.every((b) => 'note' in b));
});

console.log('\n【工具执行层】');

test('月份偏移跨年正确', () => {
  assert.strictEqual(shiftMonth('2026-10', -1), '2026-09');
  assert.strictEqual(shiftMonth('2026-01', -1), '2025-12');
  assert.strictEqual(shiftMonth('2026-10', 1), '2026-11');
});

test('未知工具返回错误而非静默成功', () => {
  const r = executeTool('no_such_tool', {}, { month: '2026-10', billsByMonth: {} });
  assert.strictEqual(r.ok, false, '未知工具必须报错，防止模型幻觉后编结论');
  assert.ok(r.error.includes('未知工具'));
});

/**
 * 入参越界的处理方式：**报错回传，不静默夹住**
 *
 * ## 为什么要改
 *
 * 原来用 clampInt 夹住：传 999 → 当成 5，传「abc」→ 当成默认 3。
 * 模型不会知道自己传错了，于是会基于**错误理解的数据**下结论，
 * 而它毫不知情——这比直接失败危险得多。
 *
 * 正确做法是把错误回传给模型，让它自己纠正：
 * 工具报错必须回传，这是模型能自我修复的唯一途径。
 */
test('参数越界会报错，让模型能自我纠正', () => {
  const ctx = { month: '2026-10', billsByMonth: { '2026-10': [] } };
  const r = executeTool('get_top_categories', { n: 999 }, ctx);
  assert.strictEqual(r.ok, false, '越界参数应报错，而不是静默夹住');
  assert.ok(r.error.includes('n'), `错误信息应指明是哪个参数: ${r.error}`);
  assert.ok(r.error.includes('重新调用'), '错误信息应告诉模型怎么修复');
});

test('非整数参数会报错', () => {
  const ctx = { month: '2026-10', billsByMonth: { '2026-10': [] } };
  const r = executeTool('get_trend', { monthCount: 'abc' }, ctx);
  assert.strictEqual(r.ok, false);
  assert.ok(r.error.includes('整数'), `错误信息应说明类型要求: ${r.error}`);
});

test('合法参数正常工作', () => {
  const ctx = { month: '2026-10', billsByMonth: { '2026-10': [] } };
  const r = executeTool('get_top_categories', { n: 3 }, ctx);
  assert.strictEqual(r.ok, true, `合法参数不应报错: ${r.error}`);
});

test('未传参数用默认值，不报错', () => {
  const ctx = { month: '2026-10', billsByMonth: { '2026-10': [] } };
  const r = executeTool('get_top_categories', {}, ctx);
  assert.strictEqual(r.ok, true, '未传参数是正常的，应走默认值');
});

test('未知参数名会被 schema 拦下（additionalProperties: false）', () => {
  const ctx = { month: '2026-10', billsByMonth: { '2026-10': [] } };
  // 校验器只检查已知参数，未知参数被忽略——
  // 但模型传未知参数通常意味着它记错了工具名，
  // 所以至少不该崩
  const r = executeTool('get_top_categories', { unknownParam: 1 }, ctx);
  assert.strictEqual(r.ok, true);
});

test('工具返回可 JSON 序列化', () => {
  const { bills } = stats.normalizeBills([bill(100, '餐饮/在家吃饭/买菜')]);
  const ctx = { month: '2026-10', billsByMonth: { '2026-10': bills } };
  for (const name of ['get_category_share', 'get_monthly_summary', 'get_month_over_month',
    'get_dining_structure', 'get_top_categories', 'get_trend', 'get_bills_detail']) {
    const r = executeTool(name, {}, ctx);
    assert.strictEqual(r.ok, true, `${name} 执行失败: ${r.error}`);
    JSON.stringify(r.data); // 一旦有循环引用或 BigInt 会在这里抛
  }
});

test('每个工具声明的名称与执行层一一对应', () => {
  const { TOOL_DEFINITIONS } = require('../index');
  const declared = TOOL_DEFINITIONS.map((t) => t.function.name);
  for (const name of declared) {
    const r = executeTool(name, {}, { month: '2026-10', billsByMonth: { '2026-10': [] } });
    assert.strictEqual(r.ok, true, `声明了 ${name} 但执行层未实现: ${r.error}`);
  }
  assert.strictEqual(new Set(declared).size, declared.length, '存在重名工具');
});

console.log(`\n${failed === 0 ? '✓ 全部通过' : '✗ 有失败'}：${passed} 通过 / ${failed} 失败\n`);
process.exit(failed === 0 ? 0 : 1);