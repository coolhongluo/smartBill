/**
 * LLM vs 纯规则 对照验收 —— P0 真正的风险验证
 *
 * 为什么单独写这个脚本：
 *   verify-p0.js 只验证「链路能跑通」，不能回答关键问题——
 *   **加了 LLM 之后，分类到底变好还是变差？**
 *
 * 如果 LLM 让准确率下降，那这套 Harness 就是纯成本无收益，必须砍掉。
 * 所以这里做 A/B 对照：同一批指令，规则 vs LLM，逐条比。
 *
 * 运行：
 *   DEEPSEEK_API_KEY=xxx node tools/verify-llm-ab.js
 *   DEEPSEEK_API_KEY=xxx node tools/verify-llm-ab.js --repeat 3   # 测稳定性
 */

const path = require('path');
const S = (p) => require(path.join(__dirname, '..', 'cloudfunctions', 'shared', p));

const asrRules = S('rules/asr-parse');
const matcher = S('rules/category-match');
const money = S('util/money');
const harness = S('agent-harness');
const tracer = S('agent-harness/tracer');
const validator = S('agent-harness/schema-validator');
const llm = S('agent-harness/llm-client');
const billParseAgent = S('agent-harness/agents/bill-parse.agent');

harness.registerAgent(billParseAgent.name, billParseAgent);

const REPEAT = (() => {
  const i = process.argv.indexOf('--repeat');
  return i > -1 ? parseInt(process.argv[i + 1], 10) : 1;
})();

/**
 * PRD 22 条 + 追加的困难样本
 * tier标注：
 *   rule-obj  规则层本就应当判对（基线，不应被 LLM 弄坏）
 *   llm-obj   规则层判不对、必须靠 LLM 语义理解才能对的（LLM 的增量价值）
 */
const CASES = [
  // ── 规则层本就应判对的基线样本 ──
  { text: '买菜一百', expect: '餐饮/在家吃饭/买菜', tier: 'rule-obj' },
  { text: '菜市场 68块5', expect: '餐饮/在家吃饭/买菜', tier: 'rule-obj' },
  { text: '昨天跟朋友下馆子 380', expect: '餐饮/外出就餐/下馆子点菜', tier: 'rule-obj' },
  { text: '中午公司食堂 15', expect: '餐饮/单位与集体/工作餐', tier: 'rule-obj' },
  { text: '地铁 4.4', expect: '交通出行/日常交通/地铁公交', tier: 'rule-obj' },
  { text: '打车 35', expect: '交通出行/日常交通/打车', tier: 'rule-obj' },
  { text: '高铁票 480', expect: '交通出行/大交通/高铁飞机', tier: 'rule-obj' },
  { text: '国庆带全家去黄山 包车 600', expect: '交通出行/出游相关交通/旅游包车', tier: 'rule-obj' },
  { text: '买米 60', expect: '餐饮/在家吃饭/米面粮油', tier: 'rule-obj' },
  { text: '孩子学费 3200', expect: '育儿教育/教育支出/学费', tier: 'rule-obj' },
  { text: '布洛芬 28.5', expect: '医疗健康/门诊挂号/药品', tier: 'rule-obj' },
  { text: '微信话费 100', expect: '通讯网络/话费流量/话费流量', tier: 'rule-obj' },
  { text: '视频会员 25', expect: '通讯网络/会员订阅/视频会员', tier: 'rule-obj' },
  { text: '买洗衣液 39', expect: '居家生活/日用百货/纸巾清洁', tier: 'rule-obj' },
  { text: '交水电费 260', expect: '居住/水电气暖/水电燃气', tier: 'rule-obj' },
  { text: '物业费 180', expect: '居住/物业费/物业费', tier: 'rule-obj' },
  { text: '打车去医院 45', expect: '医疗健康/门诊挂号/门诊挂号', tier: 'rule-obj' },

  // ── 规则层判不准、必须靠语义理解的（LLM 的增量价值所在）──
  // 注意：期望路径必须与 category-preset.js 真实类目库一致，
  // 否则会把「测试写错」误判成「模型判错」，污染 A/B 结论。
  { text: '打车去火车站 68', expect: '交通出行/日常交通/打车', tier: 'llm-obj' },
  { text: '超市 268', expect: '居家生活/日用百货/纸巾清洁', tier: 'llm-obj', loose: true },
  { text: '妈妈过生日买蛋糕 200', expect: '餐饮/外出就餐/下馆子点菜', tier: 'llm-obj', loose: true },
  { text: '昨天跟同事吃饭 AA 我出65', expect: '餐饮/外出就餐/下馆子点菜', tier: 'llm-obj', loose: true },
  { text: '给宝宝买奶粉 328', expect: '育儿教育/孩子吃喝/奶粉', tier: 'llm-obj' },
  { text: '给妈妈买生日礼物 500', expect: '人情往来/送礼/送礼', tier: 'llm-obj' },
  { text: '冬天买了件羽绒服 899', expect: '服饰美容/衣物鞋帽/衣物', tier: 'llm-obj' },
  { text: '体检花了 580', expect: '医疗健康/门诊挂号/体检', tier: 'llm-obj' },
  { text: '晚上跟朋友看电影 200', expect: '文体娱乐/观影演出/观影演出', tier: 'llm-obj' },
  { text: '给孩子报游泳班 1200', expect: '文体娱乐/运动健身/运动健身', tier: 'llm-obj', loose: true },
  { text: '给车加油 400', expect: '交通出行/日常交通/加油', tier: 'llm-obj' },
  { text: '买了副眼镜 680', expect: '医疗健康/门诊挂号/眼科配镜', tier: 'llm-obj' },
  { text: '在小区门口理发 38', expect: '服饰美容/理发美甲/理发', tier: 'llm-obj' }
];

/**
 * 判定命中
 *
 * strict：必须完全相等
 * loose：末级类目名相同即算命中（允许一级/二级归类不同）
 *   例：期望「餐饮/外出就餐/下馆子点菜」，实际「餐饮/外出就餐/火锅烧烤」
 *   —— 这类场景本就该由用户确认，不算模型错，但也不能算完全正确。
 */
function isHit(gotPath, gotPaths, expect, loose) {
  if (!expect) return gotPaths.length > 0;
  if (gotPath === expect) return true;
  if (!loose) return gotPaths.includes(expect);

  const expectLeaf = expect.split('/').pop();
  return gotPaths.some((p) => p && p.split('/').pop() === expectLeaf);
}

async function main() {
  // 前置检查：无 API Key 时必须立刻退出。
  //
  // 否则会发生非常误导的事：无 Key → 每次调用都走兜底 → LLM 侧Top1 全 0%
  // → 脚本输出「LLM 拉低了准确率，当前 Harness 属于纯成本无收益」。
  // 这个结论是**假的**——它衡量的是「模型缺席」而非「模型有害」，
  // 而按它去改 Prompt 只会浪费时间。必须在此拦下。
  if (llm.isMockMode()) {
    console.log('\n' + '='.repeat(78));
    console.log(' 未配置 DEEPSEEK_API_KEY，无法进行 A/B 对照');
    console.log('='.repeat(78));
    console.log('\n本脚本需要真实调用 DeepSeek 才能得出结论。');
    console.log('若未配置 Key，所有调用都会走规则兜底，LLM 侧准确率恒为 0%，');
    console.log('届时会输出「LLM 拉低了准确率」这种**错误结论**。\n');
    console.log('请这样运行：\n');
    console.log('  Windows CMD   : set DEEPSEEK_API_KEY=sk-xxx && npm run verify:api');
    console.log('  Windows PowerShell : $env:DEEPSEEK_API_KEY="sk-xxx"; npm run verify:api');
    console.log('  Git Bash      : DEEPSEEK_API_KEY=sk-xxx npm run verify:api\n');
    console.log('Key 申请：https://platform.deepseek.com/api_keys');
    console.log('不要把 Key 写进代码或提交到 Git。\n');
    process.exit(2);  // 2 = 环境未就绪，与「验证不通过」区分开
  }

  console.log('\n' + '='.repeat(78));
  console.log(' LLM vs 纯规则 · A/B 对照验收');
  console.log('='.repeat(78));
  console.log(` 指令数 ${CASES.length} × 重复 ${REPEAT} 轮 = ${CASES.length * REPEAT} 次真实调用`);
  console.log('='.repeat(78) + '\n');

  // ── 阶段一：纯规则基线 ──
  const ruleStats = { top1: 0, top3: 0, total: 0 };
  const ruleByCase = new Map();
  console.log('【阶段一】纯规则基线（无 LLM）');
  console.log('-'.repeat(78));
  for (const c of CASES) {
    const amt = asrRules.extractAmount(c.text);
    const y = money.centToYuan(amt.amountCent) || 0;
    const r = matcher.classify(c.text, y);
    const p1 = r.candidates[0]?.categoryPath || '(未命中)';
    const ps = r.candidates.map((x) => x.categoryPath);
    const hit1 = isHit(p1, ps, c.expect, c.loose);
    const hit3 = hit1 || ps.some((p) => p === c.expect);
    ruleByCase.set(c.text, { p1, hit1 });
    if (c.tier !== 'probe') { ruleStats.total++; if (hit1) ruleStats.top1++; if (hit3) ruleStats.top3++; }
    const mark = c.tier === 'probe' ? '·' : hit1 ? '✓' : hit3 ? '△' : '✗';
    console.log(`  ${mark} [${(c.tier || '').padEnd(8)}] ${c.text.padEnd(20)} → ${p1}`);
  }
  console.log(`\n  规则 Top1 ${ruleStats.top1}/${ruleStats.total} = ${(ruleStats.top1 / ruleStats.total * 100).toFixed(1)}%`);

  // ── 阶段二：LLM 全链路 ──
  console.log('\n' + '-'.repeat(78));
  console.log('【阶段二】LLM 全链路（真实 API 调用）');
  console.log('-'.repeat(78));

  const llmStats = { top1: 0, top3: 0, total: 0, fallback: 0, repairTotal: 0, calls: 0 };
  const llmByCase = new Map();
  const regressions = [];
  const improvements = [];
  const stillWrong = [];

  for (const c of CASES) {
    for (let round = 0; round < REPEAT; round++) {
      const ruleParsed = asrRules.parse(c.text);
      const ruleCat = matcher.classify(c.text, ruleParsed.amount || 0);

      const res = await harness.invoke({
        agent: 'bill-parse',
        input: c.text,
        options: {
          ruleParsed,
          ruleCategoryId: ruleCat.topCategoryId,
          userId: 'ab-test-user',
          llmEnabled: true,
          costContext: { usedTokens: 0, dailyBudget: 20000000 }
        }
      });

      llmStats.calls++;
      if (res.isFallback) llmStats.fallback++;
      if (res.repairCount) llmStats.repairTotal += res.repairCount;

      const cand = (res.decision && res.decision.candidates) || [];
      const p1 = cand[0]?.categoryPath || '(未命中)';
      const ps = cand.map((x) => x.categoryPath);
      const hit1 = isHit(p1, ps, c.expect, c.loose);
      const hit3 = hit1 || ps.includes(c.expect);

      if (c.tier !== 'probe') {
        llmStats.total++;
        if (hit1) llmStats.top1++;
        if (hit3) llmStats.top3++;
      }

      const key = c.text;
      if (!llmByCase.has(key)) llmByCase.set(key, []);
      llmByCase.get(key).push({ p1, hit1, hit3, conf: res.confidence, tier: res.decision && res.decision.tier, fallback: res.isFallback, reason: res.fallbackReason, amount: res.data && res.data.amount, amountCertain: res.data && res.data.amountCertain });

      if (round === 0) {
        const rBase = ruleByCase.get(key);
        const mark = c.tier === 'probe' ? '·' : hit1 ? '✓' : hit3 ? '△' : '✗';
        const confTxt = res.confidence !== null && res.confidence !== undefined ? res.confidence.toFixed(2) : '兜底';
        console.log(`  ${mark} [${(c.tier || '').padEnd(8)}] ${c.text.padEnd(20)} → ${p1}  置信 ${confTxt} ${res.isFallback ? '(' + res.fallbackReason + ')' : ''}`);
      }

      // A/B 差异分析（只在第一轮做判定，避免重复轮次放大结论）
      if (round === 0 && c.tier !== 'probe') {
        const rBase = ruleByCase.get(key);
        if (rBase.hit1 && !hit1) regressions.push({ text: c.text, expect: c.expect, rule: rBase.p1, llm: p1 });
        else if (!rBase.hit1 && hit1) improvements.push({ text: c.text, expect: c.expect, rule: rBase.p1, llm: p1 });
        else if (!rBase.hit1 && !hit1) stillWrong.push({ text: c.text, expect: c.expect, rule: rBase.p1, llm: p1 });
      }
    }
  }

  const m = tracer.getMetrics();
  const avgRepair = llmStats.repairTotal / Math.max(1, llmStats.calls);

  // ── 阶段三：金额权威性（LLM 绝不允许改金额）──
  console.log('\n' + '-'.repeat(78));
  console.log('【阶段三】金额权威性核对（LLM 不得改写规则层金额）');
  console.log('-'.repeat(78));
  let amountMismatch = 0;
  for (const [text, runs] of llmByCase) {
    const ruleAmt = asrRules.parse(text).amount;
    for (const r of runs) {
      if (r.amount === null || r.amount === undefined || ruleAmt === null || ruleAmt === undefined) continue;
      if (Math.abs(r.amount - ruleAmt) > 0.001) {
        amountMismatch++;
        console.log(`  ✗ 「${text}」 规则 ${ruleAmt} → LLM ${r.amount}`);
      }
    }
  }
  console.log(amountMismatch === 0
    ? '  ✓ 全部一致，LLM 未改写任何金额（金额由规则层权威裁定）'
    : `  ✗ ${amountMismatch} 处金额被改写`);

  // ── 汇总 ──
  console.log('\n' + '='.repeat(78));
  console.log(' A/B 对照结论');
  console.log('='.repeat(78));
  console.log(`\n  【分类准确率】`);
  console.log(`    纯规则 Top1   ${String(ruleStats.top1).padStart(2)}/${ruleStats.total} = ${(ruleStats.top1 / ruleStats.total * 100).toFixed(1)}%`);
  console.log(`    LLM   Top1    ${String(llmStats.top1).padStart(2)}/${llmStats.total} = ${(llmStats.top1 / llmStats.total * 100).toFixed(1)}%`);
  console.log(`    纯规则 Top3   ${String(ruleStats.top3).padStart(2)}/${ruleStats.total} = ${(ruleStats.top3 / ruleStats.total * 100).toFixed(1)}%`);
  console.log(`    LLM   Top3    ${String(llmStats.top3).padStart(2)}/${llmStats.total} = ${(llmStats.top3 / llmStats.total * 100).toFixed(1)}%`);

  console.log(`\n  【LLM 工程指标】`);
  console.log(`    JSON 输出成功率${(m.successCalls / m.totalCalls * 100).toFixed(1)}%  (${m.successCalls}/${m.totalCalls})`);
  console.log(`    幻觉类目率      ${(m.hallucinationRate * 100).toFixed(1)}%  (拦截 ${m.hallucinationBlocked} 次)`);
  console.log(`    兜底率          ${(m.fallbackRate * 100).toFixed(1)}%`);
  console.log(`    平均修复次数    ${avgRepair.toFixed(2)}`);
  console.log(`    Token 消耗      ${m.tokenUsage}  (均 ${Math.round(m.tokenUsage / Math.max(1, llmStats.calls))}/次)`);
  console.log(`    延迟 P50/P95    ${m.latencyP50}ms / ${m.latencyP95}ms`);

  if (improvements.length) {
    console.log(`\n  【LLM 带来的提升】(${improvements.length} 条)`);
    for (const x of improvements) console.log(`    ↑ 「${x.text}」 期望 ${x.expect}\n        规则 ✗ ${x.rule}\n        LLM  ✓ ${x.llm}`);
  }
  if (regressions.length) {
    console.log(`\n  【LLM 造成的退步】(${regressions.length} 条) ← 必须重点关注`);
    for (const x of regressions) console.log(`    ↓ 「${x.text}」 期望 ${x.expect}\n        规则 ✓ ${x.rule}\n        LLM  ✗ ${x.llm}`);
  }
  if (stillWrong.length) {
    console.log(`\n  【两者都错】(${stillWrong.length} 条)`);
    for (const x of stillWrong) console.log(`    ✗ 「${x.text}」 期望 ${x.expect} → 规则 ${x.rule} / LLM ${x.llm}`);
  }

  // 稳定性：检查同一指令多轮结果是否一致
  console.log(`\n  【稳定性】(${REPEAT} 轮一致性)`);
  let unstable = 0;
  for (const [text, runs] of llmByCase) {
    const uniq = new Set(runs.map((r) => r.p1));
    if (uniq.size > 1) {
      unstable++;
      if (REPEAT > 1) console.log(`    ⚠ 「${text}」 ${uniq.size} 种结果: ${[...uniq].join(' | ')}`);
    }
  }
  console.log(unstable === 0 ? `    ✓ 全部指令输出稳定（单轮）` : `    ⚠ ${unstable}/${llmByCase.size} 条指令输出不稳定`);

  // 验收判定
  const netGain = llmStats.top1 - ruleStats.top1;
  const checks = [
    { name: 'JSON 输出成功率 ≥ 98%', pass: m.successCalls / m.totalCalls >= 0.98, actual: `${(m.successCalls / m.totalCalls * 100).toFixed(1)}%` },
    { name: '幻觉类目率 ≤ 1%', pass: m.hallucinationRate <= 0.01, actual: `${(m.hallucinationRate * 100).toFixed(1)}%` },
    { name: '兜底率 ≤ 20%', pass: m.fallbackRate <= 0.2, actual: `${(m.fallbackRate * 100).toFixed(1)}%` },
    { name: 'LLM 不降低分类准确率', pass: netGain >= 0, actual: `${netGain >= 0 ? '+' : ''}${netGain} 条 (规则 ${ruleStats.top1} → LLM ${llmStats.top1})` },
    { name: 'LLM 不改写金额', pass: amountMismatch === 0, actual: amountMismatch === 0 ? '0 处改写' : `${amountMismatch} 处` },
    { name: '延迟 P95 ≤ 2500ms', pass: !m.latencyP95 || m.latencyP95 <= 2500, actual: `${m.latencyP95 || 'N/A'}ms` },
    { name: '输出稳定（无抖动）', pass: unstable === 0, actual: unstable === 0 ? '稳定' : `${unstable} 条抖动` }
  ];

  console.log('\n' + '-'.repeat(78));
  let allPass = true;
  for (const c of checks) {
    console.log(`  ${c.pass ? '✅' : '❌'} ${c.name.padEnd(30)} ${c.actual}`);
    if (!c.pass) allPass = false;
  }

  console.log('\n' + '='.repeat(78));
  if (allPass) {
    console.log(' 结论：✅ LLM 层验证通过。规则层作地基、LLM 做语义增量的设计成立。');
  } else if (netGain < 0) {
    console.log(' 结论：❌ LLM 拉低了准确率。当前 Harness 属于纯成本无收益，应重新设计 Prompt');
    console.log('       或把 LLM 限定在「仅规则层 low 档时才调用」，而非全量调用。');
  } else {
    console.log(' 结论：⚠️ 部分指标未达标，需针对失败项修复后复验。');
  }
  console.log('='.repeat(78) + '\n');

  process.exit(allPass ? 0 : 1);
}

main().catch((e) => { console.error('异常：', e); process.exit(1); });