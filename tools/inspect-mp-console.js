/**
 * 连接已打开的后台窗口，报告当前页面状态与左侧菜单结构
 *
 * ## 为什么需要这个脚本
 *
 * 登录态存在持久化用户目录里，但 Playwright 的 CDP 连接会随进程结束而断开。
 * 这个脚本重新连上同一个 profile，把当前页面、菜单项如实读出来——
 * **由实际页面决定下一步点哪里，而不是靠猜菜单路径**。
 *
 * 之前踩过的坑：凭记忆写死 `/cgi-bin/wxopenplugin` 结果 404。
 * 菜单路径会随后台版本变，只能现场读。
 */

const path = require('path');
const os = require('os');

const PLAYWRIGHT_HOME = path.join(os.homedir(), '.workbuddy', 'binaries', 'node', 'workspace', 'node_modules');
const USER_DATA_DIR = path.join(os.homedir(), '.workbuddy', 'mp-console-profile');

let chromium;
try {
  ({ chromium } = require(path.join(PLAYWRIGHT_HOME, 'playwright')));
} catch (e) {
  console.error('✗ 找不到 playwright：', e.message);
  process.exit(1);
}

/** 读取当前页面所有可见链接/菜单项文本 —— 这是「不猜」的关键 */
async function readMenu(page) {
  return page.evaluate(() => {
    const texts = [];
    const seen = new Set();

    // 常见的导航容器选择器，尽量都试一遍
    const sels = [
      '.weui-desktop-menu__list a',
      '.weui-desktop-menu a',
      '.menu a',
      'nav a',
      '.sidebar a',
      'aside a',
      '[class*="menu"] a',
      '[class*="nav"] a'
    ];

    for (const sel of sels) {
      let nodes;
      try {
        nodes = document.querySelectorAll(sel);
      } catch (e) {
        continue;
      }
      for (const n of nodes) {
        const t = (n.innerText || n.textContent || '').trim();
        if (t && t.length < 30 && !seen.has(t)) {
          seen.add(t);
          texts.push(t);
        }
      }
      if (texts.length) break; // 找到就用它，不叠加
    }

    // 补充：抓页面上所有短文本按钮/链接，覆盖菜单之外的入口
    if (texts.length < 3) {
      document.querySelectorAll('a, button, [role="button"]').forEach((n) => {
        const t = (n.innerText || n.textContent || '').trim();
        if (t && t.length < 20 && !seen.has(t)) {
          seen.add(t);
          texts.push(t);
        }
      });
    }

    return {
      title: document.title,
      url: location.href,
      menu: texts.slice(0, 40),
      bodySnippet: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 600)
    };
  });
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
    // 复用已打开的页面，不重新导航（重新导航会丢失当前状态）

    const info = await readMenu(page);

    console.log('════════════════════════════════════');
    console.log('页面标题：', info.title);
    console.log('当前网址：', info.url);
    console.log('════════════════════════════════════');

    console.log('\n可见菜单/入口项：');
    if (info.menu.length) {
      info.menu.forEach((t, i) => console.log(`  ${i + 1}. ${t}`));
    } else {
      console.log('  （未捕获到，可能是空白页或登录已过期）');
    }

    console.log('\n页面文字片段：');
    console.log(' ', info.bodySnippet);

    // 保持窗口打开
    await new Promise((resolve) => context.on('close', resolve));
  } catch (e) {
    console.error('✗ 出错：', e.message);
    process.exitCode = 1;
  }
})();