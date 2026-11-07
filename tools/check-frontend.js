#!/usr/bin/env node
/**
 * 小程序端静态一致性校验
 *
 * 为什么需要它：小程序没有编译期类型检查，WXML 里绑了一个 JS 中不存在的方法，
 * 运行时才报「is not a function」；WXSS 少一个花括号则整页样式静默失效。
 * 这两类问题在开发者工具里表现为「点了没反应」，极难定位。
 *
 * 用法：node tools/check-frontend.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MINI = path.join(ROOT, 'miniprogram');

let issues = 0;
const ok = (m) => console.log(`  \u2713 ${m}`);
const bad = (m) => { console.log(`  \u2717 ${m}`); issues++; };
const info = (m) => console.log(`  \u00B7 ${m}`);

console.log('\n[1/7] app.json');
try {
  const appJson = JSON.parse(fs.readFileSync(path.join(MINI, 'app.json'), 'utf8'));
  ok(`pages ${appJson.pages.length} 个`);
  const LEGAL = [
    'chooseAddress', 'chooseLocation', 'choosePoi', 'getFuzzyLocation',
    'getLocation', 'onLocationChange', 'startLocationUpdate', 'startLocationUpdateBackground',
  ];
  const rp = appJson.requiredPrivateInfos || [];
  const illegal = rp.filter((x) => !LEGAL.includes(x));
  if (illegal.length) bad(`requiredPrivateInfos 含非法项：${illegal.join(', ')}`);
  else ok('requiredPrivateInfos 合规');
  const perm = Object.keys(appJson.permission || {});
  ok(`permission：${perm.join(', ') || '无'}`);
} catch (e) {
  bad(`app.json 解析失败：${e.message}`);
}

/**
 * [2/7] JS 语法检查
 *
 * ## 为什么必须加这一项
 *
 * 踩过的坑：`analysis.js` 的 data 对象里少了一个逗号，
 * 本地 `check:ui`、`npm test`、`preflight` **全部通过**，
 * 却在小程序真机上直接报语法错误，整个页面白屏。
 *
 * 根因：这些工具都只做**文本匹配**（找方法名、找事件绑定），
 * 从来不真正**解析** JS。少一个逗号在文本层面完全看不出来。
 *
 * 所以这里必须用 `new Function()` 真正让引擎解析一遍——
 * 这是最低成本的语法验证，不需要引入完整解析器。
 */
console.log('\n[2/7] JS 语法（真机白屏的元凶）');
{
  const { execFileSync } = require('child_process');
  const jsFiles = [];

  // 收集所有小程序端 JS
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) walk(full);
      else if (name.endsWith('.js')) jsFiles.push(full);
    }
  };
  walk(MINI);

  let syntaxErrors = 0;
  for (const f of jsFiles) {
    const rel = path.relative(ROOT, f).replace(/\\/g, '/');
    try {
      // --check 只做语法解析，不执行代码
      execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
    } catch (e) {
      syntaxErrors++;
      const msg = (e.stderr && e.stderr.toString()) || e.message;
      // 只取关键行，避免刷屏
      const key = msg.split('\n').filter((l) => /SyntaxError|^\s*\d+\s*\|/.test(l)).slice(0, 3).join(' | ');
      bad(`${rel} 语法错误：${key.replace(/\s+/g, ' ').trim()}`);
    }
  }
  if (!syntaxErrors) ok(`${jsFiles.length} 个 JS 文件语法正确`);
}

console.log('\n[3/7] WXSS 语法（花括号平衡）');
const pagesDir = path.join(MINI, 'pages');
const pageNames = fs.existsSync(pagesDir)
  ? fs.readdirSync(pagesDir).filter((d) => fs.statSync(path.join(pagesDir, d)).isDirectory())
  : [];

/**
 * 解析一个页面目录里的实际文件名
 *
 * ## 为什么不能用「一律 index.xxx」
 *
 * 原来这里硬编码 `index.${ext}`，于是只有 index 页被检查——
 * analysis / detail / profile 三个页面的 WXML 事件绑定、
 * JS 语法之外的关联检查**从来没跑过**。
 *
 * 后果是「近半年趋势图没画出来」这种 WXML↔数据契约断裂能溜过去：
 * analysis.wxml 绑了 `item.height`，而数据源根本没有这个字段，
 * 而检查器压根没读过 analysis.wxml。
 *
 * 现在按「目录里有哪个文件就用哪个」解析，
 * 页面文件改成什么名字都不会漏检。
 */
function resolvePageFiles(dirName) {
  const dir = path.join(pagesDir, dirName);
  const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];

  const pick = (ext) => {
    // 优先同名文件（analysis/analysis.wxml），其次 index.xxx
    const same = files.find((f) => f === `${dirName}.${ext}`);
    if (same) return path.join(dir, same);
    const idx = files.find((f) => f === `index.${ext}`);
    return idx ? path.join(dir, idx) : null;
  };

  return { js: pick('js'), wxml: pick('wxml'), wxss: pick('wxss') };
}

pageNames.forEach((p) => {
  const { wxss } = resolvePageFiles(p);
  if (!wxss) return;
  const s = fs.readFileSync(wxss, 'utf8');
  let depth = 0;
  let underflow = 0;
  for (const ch of s) {
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth < 0) underflow++; }
  }
  const rel = path.basename(wxss);
  if (depth === 0 && underflow === 0) ok(`${p}/${rel} 花括号平衡`);
  else bad(`${p}/${rel} 花括号不平衡：净 ${depth}，越界 ${underflow}`);
});

console.log('\n[4/7] WXML 事件绑定 → JS 方法');

/**
 * 全链路源码语料
 *
 * 数据绑定字段可能由三个地方产出，缺一不可：
 *   1. 页面 JS（如 trend 的 height/label 由 utils/trend.js 计算，页面只调用）
 *   2. 小程序端其它模块
 *   3. 云函数（savings 的 title/amount/action/trigger/reason 全是云端产的）
 *
 * 只搜其中一处会误报，所以把整条链路拼成语料再搜。
 */
const corpus = (() => {
  const parts = [];

  const walk = (dir, skip) => {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) {
        if (skip.has(name)) continue;
        walk(full, skip);
      } else if (name.endsWith('.js')) {
        try {
          parts.push(fs.readFileSync(full, 'utf8'));
        } catch (e) { /* 读不到就跳过，不影响其它文件 */ }
      }
    }
  };

  walk(MINI, new Set(['node_modules']));
  walk(path.join(ROOT, 'cloudfunctions'), new Set(['node_modules', '__tests__']));

  return parts.join('\n');
})();

pageNames.forEach((p) => {
  const { wxml: wxmlPath, js: jsPath } = resolvePageFiles(p);
  if (!wxmlPath || !jsPath) return;

  const wxml = fs.readFileSync(wxmlPath, 'utf8');
  const js = fs.readFileSync(jsPath, 'utf8');

  const handlers = [...new Set(
    [...wxml.matchAll(/(?:bindtap|bindtouchstart|bindtouchend|bindtouchcancel|bindchange|bindinput|bindconfirm|catchtap)="([a-zA-Z0-9_]+)"/g)]
      .map((m) => m[1])
  )];

  const missing = handlers.filter((h) => !new RegExp(`\\b${h}\\s*\\(`).test(js));
  if (missing.length) bad(`${p}：${missing.length} 个处理器在 JS 中未定义 → ${missing.join(', ')}`);
  else ok(`${p}：${handlers.length} 个事件处理器全部有对应方法`);

  // 恒为 true 的 focus 表达式：textarea/input 会因每次 setData 重建而吞掉输入。
  // 典型错误写法：focus="{{manualMode === 'text'}}"（恒真）
  // 正确写法：focus="{{someFlag}}"，该 flag 只在需要聚焦的那一刻被置 true。
  const focusAttrs = [...wxml.matchAll(/\bfocus="\{\{([^}]+)\}\}"/g)].map((m) => m[1].trim());
  focusAttrs.forEach((expr) => {
    // 排除掉本来就该是变量的写法（含 this.data 或 data 或含变量的成员访问）
    if (/[a-zA-Z_$][\w$]*\s*[?:.]/.test(expr) && !/===|==|!=|>=|<=|>|</.test(expr)) {
      ok(`focus 表达式合理：${expr}`);
      return;
    }
    if (/===|==|!=|>=|<=|>/.test(expr)) {
      bad(`focus 写成了比较表达式「${expr}」—— 若恒为 true 会导致输入被反复重建而丢失，应改用独立开关变量`);
    } else {
      ok(`focus 表达式：${expr}`);
    }
  });

  // 反向检查：JS 里定义但界面上没用到（可能是遗留代码）
  const defined = [...js.matchAll(/^\s{2}(?:async\s+)?([a-zA-Z0-9_]+)\s*\([^)]*\)\s*\{/gm)].map((m) => m[1]);
  const builtin = new Set(['onLoad', 'onShow', 'onHide', 'onUnload', 'onPullDownRefresh', 'onReachBottom', 'noop', 'readTextareaValue', 'readAmountValue']);
  const orphan = defined.filter((d) => !builtin.has(d) && !handlers.includes(d));
  if (orphan.length) info(`${p}：${orphan.length} 个方法未被界面引用（${orphan.slice(0, 5).join(', ')}${orphan.length > 5 ? '…' : ''}）`);

  /**
   * WXML 数据绑定 → 数据链路上是否真的产出这些字段
   *
   * ## 为什么必须查
   *
   * 真实故障：「近半年趋势图没有画出来」——**全程零报错**。
   * analysis.wxml 绑了 `style="height:{{item.height}}%"`，
   * 而数据源只有 { month, totalCent, totalYuan, count }，
   * 没有 height → `height:undefined%` 是非法 CSS 被丢弃 → 柱子不显示。
   *
   * 这类断裂完全逃过了现有检查：
   *   · 事件处理器检查只看 bindtap，不看数据绑定
   *   · require 导出检查只看模块接口，不看字段级契约
   *   · 云函数返回正常、字段看起来齐全（month/totalYuan 都在）
   *
   * ## 检查范围必须是「整条数据链路」，不能只看页面 JS
   *
   * 第一次写成只搜页面 JS，结果误报了 savings：
   * 那几个字段（title/amount/action/trigger/reason）
   * 是**云函数**产出的，页面只是透传 `d.savings`。
   *
   * 所以搜索范围 = 页面 JS + 小程序全部 JS + 云函数全部 JS。
   * 判据是「这个字段名在整个数据链路上有没有出现过」。
   *
   * ⚠️ 这是启发式检查（能拦住字段名写错/漏写这类断裂），
   *   不是完整的类型推导。
   *   精确的字段级对账由 tools/__tests__/trend-view.test.js 的契约测试负责。
   */
  const dataBindingIssues = [];
  // ⚠️ 列表名可能是带点的路径：{{result.candidates}}、{{groups}}……
  //    只匹配纯标识符会漏掉带点的那种，循环体内的字段就完全没被检查。
  const forLoops = [...wxml.matchAll(/wx:for="\{\{\s*([A-Za-z0-9_.]+)\s*\}\}"/g)];

  /**
   * 收集「循环变量名」
   *
   * wx:for 的默认变量是 item，也可用 wx:for-item 自定义（如 bill、group）。
   * 这些不是页面 data 里的字段，不能拿去查语料。
   */
  const loopVars = new Set(["item"]);
  for (const m of wxml.matchAll(/wx:for-item="([A-Za-z0-9_]+)"/g)) loopVars.add(m[1]);

  /**
   * 抽出一段绑定表达式里引用的数据字段
   *
   * ⚠️ 必须先剔除字符串字面量，否则 {{a === 'x' ? 'y' : ''}} 里的
   *    'x'/'y' 会被当成字段名。
   */
  function fieldsIn(expr) {
    // 去掉单/双引号包裹的内容
    const bare = expr.replace(/'[^']*'/g, "").replace(/"[^"]*"/g, "");
    const out = new Set();
    for (const m of bare.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) {
      const id = m[0];
      if (loopVars.has(id)) continue;
      // 布尔/null 等字面量不是字段
      if (["true", "false", "null", "undefined"].includes(id)) continue;
      out.add(id);
    }
    return out;
  }

  // ① 循环体内的绑定（item.xxx / 自定义变量.xxx）
  forLoops.forEach((m) => {
    const listName = m[1];
    // 循环体：从 wx:for 位置往后取一个窗口
    const after = wxml.slice(m.index);
    const scope = after.slice(0, 1200);

    // ⚠️ 循环变量名不一定是 item —— 可能是 bill、group 等（wx:for-item 可自定义）。
    // 这里把「紧跟 wx:for 之后、出现在 {{x.y}} 里的那个标识符」都当作候选。
    const fields = new Set();
    const fre = /\{\{\s*([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)\s*\}\}/g;
    let fm;
    while ((fm = fre.exec(scope)) !== null) fields.add(fm[2]);

    if (!fields.size) return;

    const missing = [...fields].filter((f) => !new RegExp(`\\b${f}\\b`).test(corpus));

    if (missing.length) {
      dataBindingIssues.push(
        `${p}/${path.basename(wxmlPath)}：wx:for 列表 ${listName} 绑定了 ${missing.join(', ')}，但整条数据链路上都找不到这些字段`);
    }
  });

  // ② 循环体**之外**的直接绑定（{{editAmount}} 这类）
  //
  // ⚠️ 只查循环体会漏掉大量字段：编辑面板里的金额/备注/日期都在循环外。
  //    实测：把 {{editNote}} 拼错成 {{editNoteTypo}}，循环体内的检查完全无感。
  {
    const all = new Set();
    const re = /\{\{([^}]*)\}\}/g;
    let m;
    while ((m = re.exec(wxml)) !== null) {
      fieldsIn(m[1]).forEach((f) => all.add(f));
    }

    // 排除循环变量自身
    const missing = [...all].filter((f) => !new RegExp(`\\b${f}\\b`).test(corpus));
    if (missing.length) {
      dataBindingIssues.push(
        `${p}/${path.basename(wxmlPath)}：绑定了 ${missing.join(', ')}，但整条数据链路上都找不到这些字段`);
    }
  }

  if (dataBindingIssues.length) {
    dataBindingIssues.forEach((msg) => bad(`WXML 数据绑定断裂：${msg}`));
  } else {
    ok(`${p}：${forLoops.length} 个列表循环 + 直接绑定的字段均有产出`);
  }
});

console.log('\n[5/7] require 的导出是否真实存在');
// 小程序没有模块系统检查：从 A.js import 了 B.js 不导出的名字，
// 会在运行时抛 "xxx is not a function"，而且可能直到某条分支才触发。
// app.js 就踩过这个坑（import 了不存在的 callSvc），静态工具完全看不出来。
function collectExports(file) {
  const src = fs.readFileSync(file, 'utf8');
  const names = new Set();

  // module.exports = { ... }
  // 不能用 /\{([\s\S]*?)\}/ 匹配——文件里还有大量普通花括号（如函数体），
  // 非贪婪会在第一个 } 处截断。这里做括号配平扫描，逻辑不依赖换行或缩进。
  const assignIdx = src.indexOf('module.exports');
  if (assignIdx >= 0) {
    const braceStart = src.indexOf('{', assignIdx);
    if (braceStart >= 0) {
      let depth = 0;
      let end = -1;
      for (let i = braceStart; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') {
          depth--;
          if (depth === 0) { end = i; break; }
        }
      }
      if (end > braceStart) {
        src.slice(braceStart + 1, end)
          .split(',')
          .forEach((part) => {
            const t = part.split(':')[0].trim();
            if (/^[a-zA-Z0-9_$]+$/.test(t)) names.add(t);
          });
      }
    }
  }

  // module.exports.x = / exports.x =
  for (const m of src.matchAll(/(?:module\.)?exports\.([a-zA-Z0-9_$]+)\s*=/g)) names.add(m[1]);
  return names;
}

const utilsDir = path.join(MINI, 'utils');
const jsFiles = [path.join(MINI, 'app.js')];
if (fs.existsSync(utilsDir)) {
  fs.readdirSync(utilsDir)
    .filter((f) => f.endsWith('.js'))
    .forEach((f) => jsFiles.push(path.join(utilsDir, f)));
}
if (fs.existsSync(pagesDir)) {
  fs.readdirSync(pagesDir).forEach((p) => {
    // ⚠️ 必须用页面实际文件名，不能硬编码 index.js
    // （否则 analysis/detail/profile 三个页面的 require 导出从不被校验）
    const { js } = resolvePageFiles(p);
    if (js) jsFiles.push(js);
  });
}

const exportCache = new Map();
function exportsOf(file) {
  if (!exportCache.has(file)) exportCache.set(file, collectExports(file));
  return exportCache.get(file);
}

let requireIssues = 0;
jsFiles.forEach((file) => {
  const src = fs.readFileSync(file, 'utf8');
  for (const m of src.matchAll(/(?:const|let|var)\s*\{([^}]+)\}\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    const names = m[1].split(',').map((s) => s.split(':')[0].trim()).filter(Boolean);
    const reqPath = m[2];
    // 只处理相对路径的本地模块
    if (!reqPath.startsWith('.')) continue;
    const target = reqPath.endsWith('.js')
      ? path.resolve(path.dirname(file), reqPath)
      : path.resolve(path.dirname(file), reqPath) + '.js';
    if (!fs.existsSync(target)) {
      bad(`${path.relative(ROOT, file)} 引用的模块不存在：${reqPath}`);
      requireIssues++;
      continue;
    }
    const avail = exportsOf(target);
    const missing = names.filter((n) => !avail.has(n));
    if (missing.length) {
      bad(`${path.relative(ROOT, file)} 从 ${reqPath} 引入了不存在的导出：${missing.join(', ')}`);
      requireIssues++;
    }
  }
});
if (requireIssues === 0) ok(`${jsFiles.length} 个文件的 require 导出全部对得上`);

console.log('\n[6/7] 手动输入功能链路');
const idxJs = fs.readFileSync(path.join(pagesDir, 'index', 'index.js'), 'utf8');
const idxWxml = fs.readFileSync(path.join(pagesDir, 'index', 'index.wxml'), 'utf8');
const cloudJs = fs.readFileSync(path.join(MINI, 'utils', 'cloud.js'), 'utf8');
const billSvc = fs.readFileSync(path.join(ROOT, 'cloudfunctions', 'bill-svc', 'index.js'), 'utf8');
// 类目选择器已抽为组件：实现不再在 index.js 里，
// 检查也要跟着指向组件，否则组件被改坏了也没人知道
const catPickerJs = fs.readFileSync(
  path.join(MINI, 'components', 'cat-picker', 'cat-picker.js'), 'utf8');

const chain = [
  ['前端：面板状态 manualPanel', /manualPanel/.test(idxJs) && /manualPanel/.test(idxWxml)],
  ['前端：文字模式', /manualMode/.test(idxJs) && /onManualSubmit/.test(idxJs)],
  ['前端：直填模式', /onManualDirectSubmit/.test(idxJs)],
  ['前端：金额输入（过滤非法字符）', /onManualAmountInput/.test(idxJs) && /replace\(\/\[\^\\d\.\]\/g/.test(idxJs)],
  ['组件：三级类目选择器', /onPickL1/.test(catPickerJs) && /onPickL2/.test(catPickerJs) && /onPickL3/.test(catPickerJs)],
  ['组件：类目搜索（带防抖）', /onCatSearch/.test(catPickerJs) && /setTimeout/.test(catPickerJs)],
  ['前端：底部常驻入口', /onToggleManual/.test(idxJs) && /alt-entry/.test(idxWxml)],
  ['封装：manualRecord', /manualRecord/.test(cloudJs)],
  ['封装：categoryTree / categorySearch', /categoryTree/.test(cloudJs) && /categorySearch/.test(cloudJs)],
  ['封装：parseText（复用 AI 链路）', /parseText/.test(cloudJs)],
  ['云函数：manual action', /case 'manual'/.test(billSvc) && /handleManual/.test(billSvc)],
  ['云函数：金额整数分校验', /Math\.round\(amountCent\) !== amountCent/.test(billSvc)],
  ['云函数：类目必填校验', /请选择类目/.test(billSvc)],
  ['云函数：source=manual 埋点', /BILL_SOURCE\.MANUAL/.test(billSvc)],
  // ── 备注总结链路 ──
  // 备注是「用户日后回看这笔账的唯一上下文线索」，
  // 落库时必须用 LLM 总结后的 note，不能用 scene（英文代码 + 丢上下文）。
  ['云函数：落库使用总结后的备注', /note:\s*finalData\.note/.test(billSvc)],
  ['云函数：备注回传前端', /note:\s*finalData\.note/.test(billSvc) && /prefill/.test(billSvc)],
  // 确认类目后落库走 recall 链路，note 从 candidates 取，
  // 前端必须传总结结果而不是原始口述全文（全文几十字会撑爆明细列表）
  ['前端：确认落库用总结备注', /note:\s*result\.note/.test(idxJs)],
  ['前端：直填模式预填总结备注', /manualNote:\s*result\.note/.test(idxJs)],
  ['前端：确认卡片展示备注', /result\.note/.test(idxWxml)],
];
chain.forEach(([name, pass]) => (pass ? ok(name) : bad(name)));

console.log('\n[7/7] 编辑账目链路');
const detailJs = fs.readFileSync(path.join(pagesDir, 'detail', 'detail.js'), 'utf8');
const detailWxml = fs.readFileSync(path.join(pagesDir, 'detail', 'detail.wxml'), 'utf8');
const detailJson = JSON.parse(fs.readFileSync(path.join(pagesDir, 'detail', 'detail.json'), 'utf8'));

const editChain = [
  ['明细：点账单打开编辑面板', /onBillTap/.test(detailJs) && /bindtap="onBillTap"/.test(detailWxml)],
  ['明细：编辑面板有金额输入', /onEditAmountInput/.test(detailJs) && /editAmount/.test(detailWxml)],
  ['明细：编辑面板有类目选择', /openCatPicker/.test(detailJs) && /editCategoryId/.test(detailWxml)],
  ['明细：编辑面板有日期选择', /onDateChange/.test(detailJs) && /mode="date"/.test(detailWxml)],
  ['明细：编辑面板有备注输入', /onEditNoteInput/.test(detailJs) && /editNote/.test(detailWxml)],
  // ⚠️ 金额回填必须用「原始整数分」，不能用列表展示用的格式化字符串：
  //    Number("¥120.00") = NaN → 兜底成 0 → 面板里金额显示 0。
  ['明细：金额回填用 amountCent 而非展示字符串',
    /yuanInput\(bill\.amountCent\)/.test(detailJs)],
  ['明细：金额转分用字符串解析（避浮点）', /yuanToCent\(/.test(detailJs)],
  // 用户明确不需要「支付方式」——面板里不该再有账户选择
  ['明细：编辑面板不含支付方式',
    !/editAccount|onPickAccount|支付方式/.test(detailJs + detailWxml)],
  ['明细：保存调用 amend', /cloud\.amend/.test(detailJs) && /saveEdit/.test(detailJs)],
  ['明细：删除走软删除', /delFlag:\s*true/.test(detailJs)],
  ['明细：明细页注册 cat-picker 组件', !!(detailJson.usingComponents || {})['cat-picker']],
  // ⚠️ categoryPath 必须与 categoryId 一起传：
  //    统计侧（bill-stats.js）完全靠 categoryPath 分组，
  //    只改 id 不改 path 会让占比/刚性判定按旧类目算。
  //    注意写法是 `payload.categoryId = ...`（赋值），不是 `categoryId: ...`。
  ['明细：类目 id 与 path 成对提交',
    /payload\.categoryId\s*=/.test(detailJs) && /payload\.categoryPath\s*=/.test(detailJs)],
  ['云函数：amend 同步 categoryPath', /updateData\.categoryPath/.test(billSvc)],
  ['云函数：amend 校验金额为正', /amountCent <= 0/.test(billSvc)],
  ['云函数：amend 拒绝未来日期', /不能记入未来的日期/.test(billSvc)],
  // 编辑只改 updateTime，分析结论若只看 createTime 就永远不过期
  ['云函数：分析过期判定含 updateTime', /updateTime/.test(
    fs.readFileSync(path.join(ROOT, 'cloudfunctions', 'shared', 'db', 'index.js'), 'utf8'))],
];
editChain.forEach(([name, pass]) => (pass ? ok(name) : bad(name)));

console.log('\n---------------------------------------------');
console.log(issues === 0 ? '校验通过，没有发现问题' : `发现 ${issues} 个问题`);
console.log('---------------------------------------------\n');
process.exit(issues > 0 ? 1 : 0);