/**
 * 分类引擎验证 —— P0 核心验收项
 *
 * 用 PRD 附录的 22 条真实语音指令，检查：
 * 1. Top1 命中率（期望 ≥ 85%）
 * 2. Top3 命中率（期望 ≥ 95%，因为界面会展示 Top3 让用户选）
 *
 * 运行：node cloudfunctions/shared/rules/__tests__/category-match.test.js
 */

const assert = require('assert');
const matcher = require('../category-match');
const preset = require('../../util/category-preset');
const asrParse = require('../asr-parse');
const money = require('../../util/money');

/** PRD 附录：指令 / 期望结果 */
const CASES = [
  { text: '买菜一百',expect: '餐饮/在家吃饭/买菜' },
  { text: '菜市场 68块5',              expect: '餐饮/在家吃饭/买菜' },
  { text: '昨天跟朋友下馆子 380',        expect: '餐饮/外出就餐/下馆子点菜' },
  { text: '中午公司食堂 15',            expect: '餐饮/单位与集体/工作餐' },
  { text: '地铁 4.4',                   expect: '交通出行/日常交通/地铁公交' },
  { text: '打车 35',                    expect: '交通出行/日常交通/打车' },
  { text: '打车去火车站 68',            expect: null }, // 期望命中 Top3 即可（场景歧义）
  { text: '高铁票 480',                  expect: '交通出行/大交通/高铁飞机' },
  { text: '国庆带全家去黄山 包车 600',    expect: '交通出行/出游相关交通/旅游包车' },
  { text: '超市 268',                    expect: null }, // 二次确认场景
  { text: '买米 60',                    expect: '餐饮/在家吃饭/米面粮油' },
  { text: '孩子学费 3200',              expect: '育儿教育/教育支出/学费' },
  { text: '布洛芬 28.5',                expect: '医疗健康/门诊挂号/药品' },
  { text: '微信话费 100',                expect: '通讯网络/话费流量/话费流量' },
  { text: '视频会员 25',                 expect: '通讯网络/会员订阅/视频会员' },
  { text: '买洗衣液 39',                 expect: '居家生活/日用百货/纸巾清洁' },
  { text: '交水电费 260',                expect: '居住/水电气暖/水电燃气' },
  { text: '物业费 180',                  expect: '居住/物业费/物业费' },
  { text: '妈妈过生日买蛋糕 200',        expect: null }, // 二次确认场景（餐饮外出 or 人情往来）
  { text: '打车去医院 45',              expect: '医疗健康/门诊挂号/门诊挂号' },
  { text: '买菜 100',                    expect: '餐饮/在家吃饭/买菜' },
  { text: '买菜一百，还有洗衣液39',        expect: '餐饮/在家吃饭/买菜' }
];

console.log('\n【分类引擎验证】');
console.log(`类目库：${preset.stats.total} 个（${preset.stats.level1} 一级 / ${preset.stats.leaf} 末级）\n`);

let top1 = 0;
let top3 = 0;
let total = 0;
const failures = [];

for (const c of CASES) {
  total++;
  const amount = asrParse.extractAmount(c.text);
  const amountYuan = money.centToYuan(amount.amountCent) || 0;
  const r = matcher.classify(c.text, amountYuan);
  const top1Path = r.candidates[0]?.categoryPath || '(未命中)';
  const top3Paths = r.candidates.map((x) => x.categoryPath);

  let ok1 = false;
  let ok3 = false;
  if (c.expect) {
    ok1 = top1Path === c.expect;
    ok3 = top1Path === c.expect || top3Paths.includes(c.expect);
  } else {
    // 无唯一期望的场景：只要给出候选就算通过（对应「二次确认」设计）
    ok1 = r.candidates.length > 0;
    ok3 = ok1;
  }

  if (ok1) top1++;
  if (ok3) top3++;
  if (!ok3) failures.push({ ...c, got: top1Path, top3Paths });

  const mark = ok1 ? '✓' : ok3 ? '△' : '✗';
  console.log(
    `  ${mark} ${c.text.padEnd(22)} → ${top1Path}  [${money.formatCent(amount.amountCent)}${amount.certain ? '' : ' 模糊'}]`
  );
}

console.log(`\n结果统计：`);
console.log(`  Top1 命中：${top1}/${total} = ${((top1 / total) * 100).toFixed(1)}%${top1 / total >= 0.85 ? '  ✅ 达标(≥85%)' : '  ⚠️ 未达标'}`);
console.log(`  Top3 命中：${top3}/${total} = ${((top3 / total) * 100).toFixed(1)}%`);

if (failures.length) {
  console.log(`\n未命中：`);
  for (const f of failures) {
    console.log(`  「${f.text}」 期望 ${f.expect}，实际 ${f.got}`);
    console.log(`    Top3: ${f.top3Paths.join(' | ') || '(空)'}`);
  }
}

// ══════════════════════════════════════════════════
// 自定义类目注入验证 —— 「类目不匹配可自主新增」的下一环：
// 建过之后，同样的说法下次必须能直接命中
// ══════════════════════════════════════════════════
console.log('\n【自定义类目注入验证】');

const CUSTOMS = [
  { id: 'uabc123', name: '狗狗美容', parentId: 'c6', path: '服饰美容/自定义/狗狗美容', color: '#D0A8C0', keywords: ['狗狗美容'] },
  // 故意与强规则撞车：验证自定义类目不能压过「打车去医院→医疗」的领域判断
  { id: 'utaxi999', name: '打车去医院', parentId: 'c2', path: '交通出行/自定义/打车去医院', color: '#6B9AC4', keywords: ['打车去医院'] },
  // db 文档形态：主键是 _id 而非 id（add 落库后没有 id 字段），两种都要认
  { _id: 'u_fid_1', name: '给车充电', parentId: 'c2', path: '交通出行/自定义/给车充电', color: '#6B9AC4', keywords: ['给车充电'] },
  // 全层级：用户自建的一级大类也参与关键词通道，命中后落账到一级
  { _id: 'u_top_1', name: '宠物', level: 1, parentId: null, path: '宠物', color: '#94B4A4', keywords: ['宠物'] }
];

const customFailures = [];
function check(desc, cond, detail) {
  console.log(`  ${cond ? '✓' : '✗'} ${desc}${detail ? `（${detail}）` : ''}`);
  if (!cond) customFailures.push(desc);
}

// 1. 未注入时「狗狗美容」是全通道未命中（这正是用户想自主新增的场景）
const before = matcher.classify('狗狗美容 80', 80);
check('未注入时「狗狗美容」三通道全不命中', before.hitAllMiss === true);

// 2. 注入后同样的话命中自定义类目，且水合信息完整
const after = matcher.classify('狗狗美容 80', 80, [], CUSTOMS);
const top = after.candidates[0];
check('注入后「狗狗美容 80」Top1 命中自定义类目',
  top && top.categoryId === 'uabc123' && top.custom === true,
  `top=${top && top.categoryPath}`);
check('自定义候选的路径/配色取自类目文档而非预置库',
  top && top.categoryPath === '服饰美容/自定义/狗狗美容' && top.color === '#D0A8C0');

// 3. 强规则优先：自定义类目不得压过「打车去医院→医疗」的领域判断
const taxi = matcher.classify('打车去医院 45', 45, [], CUSTOMS);
check('自定义类目不压过强规则（打车去医院仍归医疗）',
  taxi.candidates[0] && taxi.candidates[0].categoryId === 'c5_1_1',
  `top=${taxi.candidates[0] && taxi.candidates[0].categoryPath}`);
check('强规则场景下自定义类目仍保留在候选里（用户可改选）',
  taxi.candidates.some((c) => c.categoryId === 'utaxi999'));

// 4. 注入自定义类目不干扰预置主链路
const withCustom = matcher.classify('买菜一百', 100, [], CUSTOMS);
check('注入后预置用例不受影响（买菜仍是买菜）',
  withCustom.candidates[0] && withCustom.candidates[0].categoryPath === '餐饮/在家吃饭/买菜');

// 5. db 文档形态（_id 无 id 字段）同样参与匹配
const fromDbDoc = matcher.classify('给车充电 30', 30, [], CUSTOMS);
check('db 文档形态（_id）的自定义类目同样命中',
  fromDbDoc.candidates[0] && fromDbDoc.candidates[0].categoryId === 'u_fid_1',
  `top=${fromDbDoc.candidates[0] && fromDbDoc.candidates[0].categoryPath}`);

// 6. 自建一级大类同样参与匹配（全层级支持）
const topHit = matcher.classify('给宠物买东西 50', 50, [], CUSTOMS);
check('自建一级大类「宠物」命中且 path 为一级名',
  topHit.candidates[0] && topHit.candidates[0].categoryId === 'u_top_1' &&
  topHit.candidates[0].categoryPath === '宠物' && topHit.candidates[0].custom === true,
  `top=${topHit.candidates[0] && topHit.candidates[0].categoryPath}`);

console.log('');
process.exit(failures.length > 0 || customFailures.length > 0 ? 1 : 0);