/**
 * 探索小程序后台：打开首页 → 打印真实菜单结构
 *
 * ## 为什么必须这么做
 *
 * 菜单路径在这项目上已经错了三次：
 *   · 我凭记忆写 `/cgi-bin/wxopenplugin` → 404
 *   · 我说「开发 → 开发管理 → 开发设置」→ 那是老版路径
 *   · 搜到的文档说「设置 → 第三方设置」→ 但用户实际找不到
 *
 * 继续猜只会浪费用户的时间。**让脚本把页面结构读出来**，
 * 由实际 DOM 决定下一步点哪里。
 *
 * 用法：
 *   node tools/explore-mp-menu.js
 *   node tools/explore-mp-menu.js --goto=设置      # 尝试点击某个菜单
 */

const path = require('path');
const os = require('os');

const PLAYWRIGHT_HOME = path.join(os.homedir(), '.workbuddy', 'binaries', 'node', 'workspace', 'node_modules');
const USER_DATA_DIR = path.join(os.homedir(), '.workbuddy', 'mp-console-profile');

let chromium;
try {
  ({ chromium } = require(path.join(PLAYWRIGHT_HOME, 'playwright')));
} catch (e) {
  console.error('✗ 找不到 playwright');
  process.exit(1);
}

const HOME_URL = 'https://mp.weixin.qq.com/cgi-bin/home?t=home/index&lang=zh_CN';

/** 把页面结构抓出来：菜单、tab、按钮、以及所有可能的入口 */
async function probe(page) {
  return page.evaluate(() => {
    const out = { menus: [], tabs: [], buttons: [], links: [], headings: [] };

    const push = (arr, txt, extra) => {
      const t = (txt || '').replace(/\s+/g, ' ').trim();
      if (t && t.length < 40) arr.push(extra ? `${t}  (${extra})` : t);
    };

    // 左侧菜单（各种命名都试）
    document.querySelectorAll(
      '.weui-desktop-menu__item a, .weui-desktop-menu__list a, ' +
      '[class*="desktop-menu"] a, [class*="side"] a, aside a, nav a'
    ).forEach((n) => {
      const href = n.getAttribute('href') || '';
      push(out.menus, n.innerText, href ? href.replace(/^.*cgi-bin/, 'cgi-bin') : '');
    });

    // tab 页签
    document.querySelectorAll('[role="tab"], .weui-tab, [class*="tab"] li, [class*="tab"] a').forEach((n) => {
      push(out.tabs, n.innerText);
    });

    // 所有可点击的短文本元素（覆盖各种命名）
    document.querySelectorAll('a, button, [role="button"], [class*="btn"]').forEach((n) => {
      const t = (n.innerText || '').trim();
      if (t && t.length < 24) push(out.buttons, t);
    });

    // 页面里提到「插件」或「设置」的字样
    document.querySelectorAll('a, span, div, li').forEach((n) => {
      const t = (n.innerText || '').trim();
      if (/插件|第三方|设置/.test(t) && t.length < 40) push(out.links, t);
    });

    // 标题类
    document.querySelectorAll('h1, h2, .weui-desktop-title, [class*="title"]').forEach((n) => {
      push(out.headings, n.innerText);
    });

    // 去重
    const uniq = (a) => [...new Set(a)];
    out.menus = uniq(out.menus);
    out.tabs = uniq(out.tabs);
    out.buttons = uniq(out.buttons);
    out.links = uniq(out.links);
    out.headings = uniq(out.headings).slice(0, 8);

    out.url = location.href;
    out.title = document.title;
    out.bodyHead = (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 800);

    return out;
  });
}

function show(label, arr, limit = 30) {
  console.log(`\n【${label}】${arr.length ? `(${arr.length})` : ' — 无'}`);
  arr.slice(0, limit).forEach((x, i) => console.log(`  ${i + 1}. ${x}`));
  if (arr.length > limit) console.log(`  ... 另有 ${arr.length - limit} 项`);
}

(async () => {
  let context;
  try {
    context = await chromium.launchPersistentContext(USER_DATA_DIR, {
      headless: false,
      channel: 'chrome',
      viewport: null,
      args: ['--start-maximized']
    });

    const page = context.pages()[0] || await context.newPage();

    const gotoArg = process.argv.find((a) => a.startsWith('--goto='));
    const target = gotoArg ? gotoArg.split('=')[1] : null;

    console.log('打开后台首页...');
    await page.goto(target || HOME_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    }).catch((e) => console.log('导航提示：', e.message));

    await page.waitForTimeout(4000); // 等前端渲染

    const info = await probe(page);

    console.log('\n════════════════════════════════════');
    console.log('标题：', info.title);
    console.log('网址：', info.url);
    console.log('════════════════════════════════════');

    show('左侧菜单', info.menus);
    show('页签', info.tabs);
    show('页面标题', info.headings, 10);
    show('含「插件/第三方/设置」的元素', info.links, 25);
    show('可点击项（前 40）', info.buttons, 40);

    console.log('\n页面文字（前 800 字）：');
    console.log(info.bodyHead);

    // 登录态判断：URL 里没token 且页面出现登录二维码 → 已掉登录
    const loggedOut = /login|qrcode/i.test(info.bodyHead) || info.bodyHead.includes('扫码');
    console.log(`\n登录状态推测：${loggedOut ? '✗ 已掉登录' : '✓ 看起来仍登录'}`);

    console.log('\n浏览器保持打开。关闭窗口即结束。');
    await new Promise((resolve) => context.on('close', resolve));
  } catch (e) {
    console.error('✗ 出错：', e.message);
    process.exitCode = 1;
  }
})();