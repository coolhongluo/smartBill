#!/usr/bin/env node
/**
 * Wiki 构建器 —— 把 docs/wiki/*.md 渲染成可点击的静态站点
 *
 * 用法：
 *   node tools/wiki-build/build.js            # 构建到 docs/wiki/_site
 *   node tools/wiki-build/build.js --out X    # 指定输出目录
 *
 * 设计要点：
 *   · 纯静态、无框架、无外部依赖（marked 本地打包，mermaid 用 CDN 兜底）
 *   · 左侧目录树从 llms.txt 的链接自动推导，llms.txt 改了目录就跟着改
 *   · 每页顶部显示「源码路径」+「行数」，方便回溯到 .md 原文件
 */
const fs = require('fs');
const path = require('path');
const { marked } = require('./node_modules/marked');

const WIKI_DIR = path.resolve(__dirname, '..', '..', 'docs', 'wiki');
const outArg = process.argv.indexOf('--out');
const OUT_DIR = outArg > -1 ? path.resolve(process.argv[outArg + 1]) : path.join(WIKI_DIR, '_site');

// ── 主题：跟随系统浅色/深色 ──────────────────────────────────────────────
const CSS = `
:root{
  --bg:#fbfaf8; --panel:#ffffff; --ink:#1f1d1a; --ink-2:#4a4642; --ink-3:#837c74;
  --line:#e6e1da; --line-2:#d4cdc3; --accent:#7c6f64; --accent-soft:#f0ebe4;
  --code-bg:#f6f3ef; --red:#c0392b; --green:#2e7d5b; --blue:#3d6b9e;
  --mono:"SF Mono",Menlo,Consolas,"Cascadia Code","Roboto Mono",monospace;
}
@media (prefers-color-scheme:dark){
  :root{
    --bg:#171614; --panel:#1f1e1c; --ink:#ece9e4; --ink-2:#c3bdb5; --ink-3:#8f8880;
    --line:#33302c; --line-2:#45413c; --accent:#b9a894; --accent-soft:#2a2724;
    --code-bg:#22201d; --red:#e0736a; --green:#63b98d; --blue:#7aa6d6;
  }
}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{
  background:var(--bg); color:var(--ink);
  font:15px/1.75 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
  -webkit-font-smoothing:antialiased;
}
.wrap{display:flex;min-height:100vh;align-items:flex-start}
/* ── 侧栏 ── */
.side{
  width:290px;flex:0 0 290px;position:sticky;top:0;height:100vh;overflow-y:auto;
  background:var(--panel);border-right:1px solid var(--line);padding:22px 0 40px;
}
.brand{padding:0 20px 16px;border-bottom:1px solid var(--line);margin-bottom:14px}
.brand b{display:block;font-size:15px;letter-spacing:.2px}
.brand span{display:block;font-size:11.5px;color:var(--ink-3);margin-top:3px;font-family:var(--mono)}
.side h4{
  margin:16px 20px 6px;font-size:10.5px;font-weight:700;letter-spacing:1.1px;
  text-transform:uppercase;color:var(--ink-3);
}
.side a{
  display:block;padding:6px 20px;color:var(--ink-2);text-decoration:none;font-size:13.5px;
  border-left:2.5px solid transparent;transition:.12s;
}
.side a:hover{background:var(--accent-soft);color:var(--ink)}
.side a.on{color:var(--ink);border-left-color:var(--accent);background:var(--accent-soft);font-weight:600}
.side a .num{color:var(--ink-3);font-family:var(--mono);font-size:11px;margin-right:6px}
/* ── 主区 ── */
.main{flex:1;min-width:0;padding:36px 44px 90px;max-width:1080px}
.page-hd{
  border-bottom:1px solid var(--line);padding-bottom:16px;margin-bottom:28px;
  display:flex;justify-content:space-between;align-items:flex-end;gap:20px;flex-wrap:wrap;
}
.page-hd .t{font-size:12px;font-family:var(--mono);color:var(--ink-3)}
.page-hd .t b{color:var(--accent)}
h1{font-size:29px;line-height:1.3;margin:0 0 12px;letter-spacing:-.3px}
h2{
  font-size:20px;margin:44px 0 14px;padding-bottom:7px;
  border-bottom:1px solid var(--line);letter-spacing:-.2px;
}
h3{font-size:16.5px;margin:30px 0 10px;color:var(--ink)}
h4{font-size:14.5px;margin:22px 0 8px;color:var(--ink-2)}
p{margin:12px 0}
ul,ol{padding-left:24px;margin:12px 0}
li{margin:5px 0}
strong{font-weight:650}
code{
  font-family:var(--mono);font-size:.875em;background:var(--code-bg);
  padding:1.5px 5px;border-radius:4px;border:1px solid var(--line);
}
pre{
  background:var(--code-bg);border:1px solid var(--line);border-radius:9px;
  padding:14px 16px;overflow-x:auto;margin:16px 0;
}
pre code{background:none;border:none;padding:0;font-size:12.6px;line-height:1.65}
table{border-collapse:collapse;width:100%;margin:16px 0;font-size:13.4px}
th,td{border:1px solid var(--line);padding:8px 11px;text-align:left;vertical-align:top}
th{background:var(--accent-soft);font-weight:650}
tbody tr:nth-child(even){background:rgba(128,128,128,.035)}
blockquote{
  margin:16px 0;padding:12px 18px;border-left:3.5px solid var(--accent);
  background:var(--accent-soft);border-radius:0 7px 7px 0;color:var(--ink-2);
}
blockquote p{margin:5px 0}
blockquote strong{color:var(--ink)}
hr{border:none;border-top:1px solid var(--line);margin:32px 0}
a{color:var(--blue)}
.mermaid{margin:20px 0;text-align:center;padding:16px;background:var(--panel);border:1px solid var(--line);border-radius:9px;overflow-x:auto}
.mermaid svg{max-width:100%;height:auto}
.mermaid-note{font-size:11.5px;color:var(--ink-3);text-align:center;margin-top:-8px;font-family:var(--mono)}
/* 代码块语言角标 */
.codeblock{position:relative}
.codeblock .lang{
  position:absolute;top:0;right:0;font-size:10px;font-family:var(--mono);
  color:var(--ink-3);background:var(--panel);padding:2px 8px;border-radius:0 0 0 6px;
  border-left:1px solid var(--line);border-bottom:1px solid var(--line);
}
/* 表格里的长内容不撑破 */
td code{word-break:break-all}
.footer{margin-top:56px;padding-top:18px;border-top:1px solid var(--line);font-size:12px;color:var(--ink-3);font-family:var(--mono)}
@media(max-width:880px){
  .wrap{flex-direction:column}
  .side{width:100%;flex:none;height:auto;position:static;border-right:none;border-bottom:1px solid var(--line)}
  .main{padding:26px 20px 60px}
}
`;

// ── 读取 llms.txt，推导目录树 ────────────────────────────────────────────
function parseLlms() {
  const p = path.join(WIKI_DIR, 'llms.txt');
  if (!fs.existsSync(p)) return { title: 'Wiki', desc: '', groups: [] };
  const raw = fs.readFileSync(p, 'utf8');
  const lines = raw.split('\n');
  const title = (lines.find((l) => l.startsWith('# ')) || '# Wiki').slice(2).trim();
  const desc = (lines.find((l) => l.startsWith('> ')) || '').replace(/^>\s*/, '').trim();
  const groups = [];
  let cur = null;
  for (const line of lines) {
    if (line.startsWith('## ')) {
      cur = { name: line.slice(3).trim(), items: [] };
      groups.push(cur);
    } else if (cur && /^\s*-\s*\[/.test(line)) {
      const m = line.match(/\[([^\]]+)\]\(([^)]+)\)\s*:?\s*(.*)$/);
      if (m) cur.items.push({ title: m[1], href: m[2], desc: (m[3] || '').trim() });
    }
  }
  return { title, desc, groups };
}

// ── 渲染单页 ─────────────────────────────────────────────────────────────
function renderMarkdown(md) {
  // 抽出 mermaid 代码块单独处理
  const mermaidBlocks = [];
  let body = md.replace(/```mermaid\n([\s\S]*?)```/g, (_, code) => {
    mermaidBlocks.push(code.trim());
    return `\n@@MERMAID${mermaidBlocks.length - 1}@@\n`;
  });

  let html = marked.parse(body, { gfm: true, breaks: false });

  // 给代码块加语言角标
  html = html.replace(/<pre><code class="language-(\w+)">/g,
    (_, lang) => `<div class="codeblock"><span class="lang">${lang}</span><pre><code class="language-${lang}">`);

  // mermaid 占位替换
  html = html.replace(/<p>@@MERMAID(\d+)@@<\/p>/g, (_, i) =>
    `<div class="mermaid" id="mm${i}">${escapeHtml(mermaidBlocks[Number(i)])}</div>`);

  return { html, mermaidCount: mermaidBlocks.length };
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function pageShell({ title, desc, group, bodyHtml, srcPath, lines, prev, next, total, base }) {
  // base 是到 _site 根的相对路径（根目录页为 ''，子目录页为 '../'）
  // ⚠️ 资源路径必须按页面深度算 —— 写死 'assets/' 会让子目录页 404
  const A = base + 'assets/';
  const nav = [
    prev ? `<a class="pn" href="${base}${prev.href.replace(/\.md$/, '.html')}">← ${prev.title}</a>` : '<span class="pn dis"></span>',
    next ? `<a class="pn" href="${base}${next.href.replace(/\.md$/, '.html')}">${next.title} →</a>` : '<span class="pn dis"></span>'
  ].join('');
  return `<!DOCTYPE html>
<html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} · ${escapeHtml(total.title)}</title>
<style>${CSS}</style>
</head><body>
<div class="wrap">
<aside class="side" id="side"></aside>
<main class="main">
  <div class="page-hd">
    <div class="t"><b>${escapeHtml(group)}</b> · ${escapeHtml(srcPath)} · ${lines} 行</div>
    <div class="t">${nav.replace(/<a class="pn"/g, '<a class="pn" style="margin-left:12px"')}</div>
  </div>
  ${bodyHtml}
  <div class="footer">${escapeHtml(total.title)} · 本页 ${lines} 行 · 由 tools/wiki-build/build.js 生成</div>
</main>
</div>
<script>window.__WIKI__ = ${JSON.stringify(total)}; window.__BASE__ = ${JSON.stringify(base)};</script>
<script src="${A}app.js"></script>
<script src="${A}mermaid.min.js"></script>
<script>
if (window.mermaid) {
  mermaid.initialize({startOnLoad:true,theme:'default',securityLevel:'loose'});
}
</script>
</body></html>`;
}

// ── 主流程 ───────────────────────────────────────────────────────────────
function build() {
  const llms = parseLlms();
  const items = [];
  llms.groups.forEach((g) => g.items.forEach((it) => items.push({ ...it, group: g.name })));

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(path.join(OUT_DIR, 'assets'), { recursive: true });

  // 侧栏 + 客户端路由数据
  const appJs = `const W = window.__WIKI__;
const BASE = window.__BASE__ || '';
function nav(){
  let h = '<div class="brand"><b>'+W.title+'</b><span>'+W.desc.slice(0,64)+'</span></div>';
  W.groups.forEach(g=>{
    h += '<h4>'+g.name+'</h4>';
    g.items.forEach(it=>{
      const html = it.href.replace(/\\.md$/,'.html');
      h += '<a href="'+BASE+html+'" data-page="'+html+'">'+it.title+'</a>';
    });
  });
  document.getElementById('side').innerHTML = h;
  // 当前页高亮：比对「相对 _site 根的完整路径」
  // ⚠️ 不能只比文件名 —— 不同目录下同名文件会同时高亮
  let p = decodeURIComponent(location.pathname);
  const i = p.indexOf('_site/');
  // '_site/' 是 6 个字符 —— slice(i+5) 会残留一个前导斜杠
  if (i >= 0) p = p.slice(i + 6);
  else p = p.replace(/^\\//, '');
  p = p.replace(/^\\//, '');
  // 首页 index.html 不在 llms.txt 列表里 —— 高亮「总览」那一项
  if (p === 'index.html') p = '00-overview.html';
  document.querySelectorAll('#side a').forEach(a=>{
    if(a.dataset.page === p) a.classList.add('on');
  });
}
nav();
`;
  fs.writeFileSync(path.join(OUT_DIR, 'assets', 'app.js'), appJs, 'utf8');

  // 本地打包 mermaid —— 不依赖 CDN，离线也能渲染图
  const mermaidSrc = path.join(__dirname, 'node_modules', 'mermaid', 'dist', 'mermaid.min.js');
  if (fs.existsSync(mermaidSrc)) {
    fs.copyFileSync(mermaidSrc, path.join(OUT_DIR, 'assets', 'mermaid.min.js'));
  } else {
    console.warn('  ! 未找到 mermaid.min.js，图将以源码块显示（请 npm i --prefix tools/wiki-build mermaid@10）');
  }

  let totalMermaid = 0;
  items.forEach((it, idx) => {
    const src = path.join(WIKI_DIR, it.href);
    if (!fs.existsSync(src)) {
      console.warn('  ! 跳过（文件不存在）:', it.href);
      return;
    }
    const md = fs.readFileSync(src, 'utf8');
    const lines = md.split('\n').length;
    const { html, mermaidCount } = renderMarkdown(md);
    totalMermaid += mermaidCount;

    // 从 markdown 首个 H1 取标题（llms.txt 里的标题可能更短）
    const h1 = (md.match(/^#\s+(.+)$/m) || [])[1] || it.title;

    const outFile = it.href.replace(/\.md$/, '.html');
    const outAbs = path.join(OUT_DIR, outFile);
    fs.mkdirSync(path.dirname(outAbs), { recursive: true });
    // base：到 _site 根的相对前缀（business/xx.html → '../'）
    const depth = outFile.split('/').length - 1;
    const base = '../'.repeat(depth);
    const htmlOut = pageShell({
      title: it.title, desc: it.desc, group: it.group,
      bodyHtml: html, srcPath: it.href, lines,
      prev: items[idx - 1], next: items[idx + 1], total: llms, base,
    });
    fs.writeFileSync(outAbs, htmlOut, 'utf8');
    console.log(`  ✓ ${outFile.padEnd(28)} ${String(lines).padStart(4)} 行  ${mermaidCount} 图`);
  });

  // 首页
  const idxHtml = pageShell({
    title: llms.title, desc: llms.desc, group: 'index',
    bodyHtml: `<h1>${escapeHtml(llms.title)}</h1>
<blockquote><p>${escapeHtml(llms.desc)}</p></blockquote>
<p>本 Wiki 面向 LLM 与新成员，覆盖<strong>业务知识</strong>与<strong>技术实现</strong>。所有结论均来自源码，标注 <code>文件:行号</code> 可回溯。</p>
<h2>目录</h2>
${llms.groups.map((g) => `<h3>${g.name}</h3><table><thead><tr><th style="width:34%">页面</th><th>说明</th></tr></thead><tbody>
${g.items.map((it) => `<tr><td><a href="${it.href.replace(/\.md$/, '.html')}">${it.title}</a></td><td>${it.desc}</td></tr>`).join('\n')}
</tbody></table>`).join('\n')}`,
    srcPath: 'llms.txt', lines: fs.readFileSync(path.join(WIKI_DIR, 'llms.txt'), 'utf8').split('\n').length,
    prev: null, next: items[0], total: llms, base: '',
  });
  fs.writeFileSync(path.join(OUT_DIR, 'index.html'), idxHtml, 'utf8');
  console.log(`  ✓ index.html                (目录页)`);
  console.log(`\n构建完成 → ${OUT_DIR}`);
  console.log(`共 ${items.length} 页，${totalMermaid} 个 mermaid 图`);
}

build();
