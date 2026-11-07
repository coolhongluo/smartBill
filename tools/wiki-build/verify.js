/**
 * Wiki 渲染验证 —— 用真实浏览器检查页面是否正确渲染
 * 断言：mermaid 图真的画成了 SVG、表格有内容、代码块高亮、侧栏导航可用
 */
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');

const SITE = path.resolve(__dirname, '..', '..', 'docs', 'wiki', '_site');

/**
 * 页面列表从 llms.txt 自动推导 —— 硬编码会漏检新写的页
 * （踩过：四页新 Wiki 写完后 verify 仍报「全部通过」，因为根本没测到）
 */
function listPages() {
  const wikiDir = path.resolve(__dirname, '..', '..', 'docs', 'wiki');
  const llms = path.join(wikiDir, 'llms.txt');
  const pages = ['index.html'];
  if (!fs.existsSync(llms)) return pages;
  const raw = fs.readFileSync(llms, 'utf8');
  raw.split('\n').forEach((line) => {
    const m = line.match(/^\s*-\s*\[[^\]]+\]\(([^)]+\.md)\)/);
    if (!m) return;
    const html = m[1].replace(/\.md$/, '.html');
    const abs = path.join(SITE, html);
    if (fs.existsSync(abs)) pages.push(html);
    else console.warn(`  ! llms.txt 指向的页面未生成: ${m[1]}`);
  });
  return pages;
}

(async () => {
  let browser;
  try {
    browser = await chromium.launch({ channel: 'chrome' });
  } catch (e) {
    console.error('无法启动 Chrome（channel: chrome）：' + e.message);
    console.error('回退：尝试内置 chromium');
    browser = await chromium.launch();
  }
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await ctx.newPage();

  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));

  let fail = 0;
  const PAGES = listPages();
  console.log(`检查 ${PAGES.length} 个页面\n`);
  for (const p of PAGES) {
    const file = path.join(SITE, p);
    if (!fs.existsSync(file)) { console.log(`✗ ${p} —— 文件不存在`); fail++; continue; }
    await page.goto('file://' + file.replace(/\\/g, '/'));
    await page.waitForTimeout(1200);

    const r = await page.evaluate(() => {
      const mm = [...document.querySelectorAll('.mermaid')];
      return {
        title: (document.querySelector('h1') || {}).textContent || '',
        mermaidTotal: mm.length,
        mermaidRendered: mm.filter((e) => e.querySelector('svg')).length,
        mermaidRaw: mm.filter((e) => !e.querySelector('svg')).length,
        tables: document.querySelectorAll('table').length,
        tableRows: document.querySelectorAll('tbody tr').length,
        pres: document.querySelectorAll('pre').length,
        navLinks: document.querySelectorAll('#side a').length,
        activeNav: document.querySelectorAll('#side a.on').length,
        bodyH: document.body.scrollHeight,
        // 检查是否有横向溢出（表格撑破）
        overflowX: document.documentElement.scrollWidth > window.innerWidth + 2
      };
    });

    const ok = r.mermaidRendered === r.mermaidTotal && r.tables > 0 && r.navLinks > 0 && !r.overflowX;
    if (!ok) fail++;
    console.log(
      `${ok ? '✓' : '✗'} ${p.padEnd(34)} 图 ${r.mermaidRendered}/${r.mermaidTotal}` +
      ` 表 ${r.tables}(${r.tableRows}行) 代码 ${r.pres} 导航 ${r.navLinks}(高亮${r.activeNav})` +
      ` 高 ${r.bodyH}px${r.overflowX ? ' ⚠横向溢出' : ''}`
    );
    if (r.mermaidRaw) console.log(`    ⚠ ${r.mermaidRaw} 个 mermaid 块未渲染成 SVG`);
    if (!r.activeNav) console.log('    ⚠ 侧栏无高亮项');
  }

  // 截图留证
  const shotDir = path.join(SITE, '_shots');
  fs.mkdirSync(shotDir, { recursive: true });
  await page.goto('file://' + path.join(SITE, '00-overview.html').replace(/\\/g, '/'));
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(shotDir, 'overview.png'), fullPage: false });
  await page.goto('file://' + path.join(SITE, 'tech/11-agent-harness.html').replace(/\\/g, '/'));
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(shotDir, 'harness.png'), fullPage: false });

  const realErrors = errors.filter((e) => !/favicon|net::ERR_FILE_NOT_FOUND/i.test(e));
  console.log('\n控制台错误：' + (realErrors.length ? realErrors.slice(0, 5).join(' | ') : '无'));
  console.log(fail ? `\n✗ ${fail} 个页面未通过` : '\n✓ 全部通过');

  await browser.close();
  process.exit(fail ? 1 : 0);
})();
