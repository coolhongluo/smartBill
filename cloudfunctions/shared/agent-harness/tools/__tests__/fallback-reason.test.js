/**
 * 降级原因翻译测试
 *
 * ## 为什么这个也要测
 *
 * 降级有 12 种触发原因，性质完全不同：
 *   · 没配 Key → 用户配置一下就好
 *   · 护栏拦下了错误建议 → 这是**保护机制正常工作**，不是故障
 *
 * 若都显示成「分析失败」，用户会以为系统坏了，
 * 也会把「护栏在正常工作」误当成「功能没做」。
 * 所以「区分故障与保护」是这个模块的核心职责，必须钉死。
 */

const assert = require('assert');

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

const fr = require('../../../util/fallback-reason');

console.log('\n【配置类原因】');

test('NO_API_KEY 指向明确的配置路径', () => {
  const e = fr.explainFallback('NO_API_KEY');
  assert.strictEqual(e.level, 'config');
  assert.ok(e.hint.includes('DEEPSEEK_API_KEY'), '必须指明要配哪个环境变量');
  assert.ok(e.hint.includes('analysis-svc'), '必须指明是哪个云函数');
});

test('GLOBAL_LLM_DISABLED 说明是被开关关掉的', () => {
  const e = fr.explainFallback('GLOBAL_LLM_DISABLED');
  assert.strictEqual(e.level, 'config');
  assert.ok(e.hint.includes('LLM_ENABLED'), '必须指明开关名');
});

console.log('\n【护栏类原因：不是故障】');

test('数值对账拦下的是保护机制，不是故障', () => {
  const e = fr.explainFallback('NUMERIC_CITATION_MISMATCH');
  assert.strictEqual(e.level, 'guard', '护栏正常工作不能标成故障');
  assert.ok(!/失败/.test(e.text), `文案不该说「失败」: ${e.text}`);
  assert.ok(/机制|校验/.test(e.hint), '应说明是机制在工作');
});

test('刚性拦截同样标为保护机制', () => {
  const e = fr.explainFallback('RIGID_CATEGORY_SUGGESTED');
  assert.strictEqual(e.level, 'guard');
  assert.ok(e.hint.includes('刚性'), '应说明刚性支出的含义');
});

console.log('\n【可重试类原因】');

test('网络类错误标为可重试', () => {
  for (const code of ['LLM_UNAVAILABLE', 'TOOL_LOOP_ERROR', 'VALIDATION_FAILED']) {
    const e = fr.explainFallback(code);
    assert.strictEqual(e.level, 'retry', `${code} 应为可重试`);
    assert.ok(e.hint.length > 0, `${code} 应给出处理建议`);
  }
});

console.log('\n【未知原因】');

test('未知原因码也要给人话，不能把原始码丢给用户', () => {
  const e = fr.explainFallback('SOME_FUTURE_CODE');
  assert.strictEqual(e.level, 'unknown');
  assert.ok(e.text.length > 0);
  // 原始码可以放在 hint 里供排查，但 text 必须是中文可读的
  assert.ok(!/^[A-Z_]+$/.test(e.text), `text 不应是纯代码: ${e.text}`);
});

test('空原因码也能处理', () => {
  const e = fr.explainFallback('');
  assert.ok(e.text.length > 0);
  assert.strictEqual(e.level, 'unknown');
});

test('所有已知原因码都有完整文案', () => {
  for (const [code, def] of Object.entries(fr.REASONS)) {
    assert.ok(def.text && def.text.length > 0, `${code} 缺 text`);
    assert.ok(def.hint && def.hint.length > 0, `${code} 缺 hint`);
    assert.ok(['config', 'retry', 'guard', 'unknown'].includes(def.level),
      `${code} 的 level 非法: ${def.level}`);
  }
});

console.log('\n【与 harness 的降级码对齐】');

test('harness 里所有 finalizeWithFallback 的原因码都有对应文案', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'index.js'), 'utf8'
  );
  // 抓出 finalizeWithFallback(..., 'XXX') 里的原因码
  const codes = [...src.matchAll(/finalizeWithFallback\([^)]*?'([A-Z_]+)'\s*\)/g)].map((m) => m[1]);
  assert.ok(codes.length >= 8, `应抓到多个降级码，实际 ${codes.length}`);
  for (const code of codes) {
    assert.ok(fr.REASONS[code], `降级码 ${code} 没有对应文案，会显示成未知`);
  }
});

console.log(`\n${failed === 0 ? '✓ 全部通过' : '✗ 有失败'}：${passed} 通过 / ${failed} 失败\n`);
process.exit(failed === 0 ? 0 : 1);
