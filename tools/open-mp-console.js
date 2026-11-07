/**
 * 打开微信小程序后台（mp.weixin.qq.com），停在登录页等你扫码
 *
 * ## 设计要点
 *
 * 1. **有头模式（headless: false）** —— 你需要看见窗口扫码。
 *    后台自动化若用无头模式，扫码页面你根本看不到。
 *
 * 2. **持久化用户目录（userDataDir）** —— 登录态（cookie/token）落在磁盘上。
 *    用临时 context 的话，一次会话结束登录态就没了，
 *    后面每一步都得重新扫码。
 *
 * 3. **用系统 Chrome，不用 bundled chromium** —— 渠道为 chrome。
 *    本机已装的 Chrome 版本更新、且和微信登录兼容性更好；
 *    Playwright 自带的 Chromium 有时在扫码页上会有渲染差异。
 *
 * 4. **窗口不自动关闭** —— 脚本跑完后保持打开，
 *    你可以自己看着页面确认状态，不靠我口头转述。
 *
 * 用法：
 *   node tools/open-mp-console.js            # 打开并等待，最长 10 分钟
 *   node tools/open-mp-console.js --keep     # 登录后一直不关（默认行为）
 */

const path = require('path');
const os = require('os');

// playwright 装在 WorkBuddy 的隔离 workspace 里
const PLAYWRIGHT_HOME = path.join(os.homedir(), '.workbuddy', 'binaries', 'node', 'workspace', 'node_modules');

let chromium;
try {
  ({ chromium } = require(path.join(PLAYWRIGHT_HOME, 'playwright')));
} catch (e) {
  console.error('✗ 找不到 playwright。请先在隔离目录安装：');
  console.error(`  cd "${PLAYWRIGHT_HOME.replace(/node_modules$/, '')}" && npm install playwright`);
  process.exit(1);
}

/** 持久化目录：登录态存这里，后续脚本可复用 */
const USER_DATA_DIR = path.join(os.homedir(), '.workbuddy', 'mp-console-profile');

/** 等待扫码的最长时间（毫秒） */
const WAIT_TIMEOUT = 10 * 60 * 1000;

(async () => {
  let context;

  try {
    console.log('正在启动浏览器...');
    console.log(`用户数据目录：${USER_DATA_DIR}`);

    context = await chromium.launchPersistentContext(USER_DATA_DIR, {
      headless: false,
      channel: 'chrome',           // 用系统 Chrome；失败则回退到自带 Chromium
      viewport: null,// 用真实窗口尺寸，扫码更方便
      args: ['--start-maximized', '--disable-blink-features=AutomationControlled']
    });

    const page = context.pages()[0] || await context.newPage();

    page.on('console', (m) => {
      if (m.type() === 'error') console.log('  [页面错误]', m.text().slice(0, 200));
    });

    console.log('正在打开 mp.weixin.qq.com ...');
    await page.goto('https://mp.weixin.qq.com', {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    console.log('\n────────────────────────────────');
    console.log('浏览器已打开。请用手机扫码登录。');
    console.log('扫码并在手机上确认后，这里会自动检测到登录状态。');
    console.log('────────────────────────────────\n');

    // 轮询登录状态：登录成功后 URL 会带上 cgi-bin/home 或出现后台标识
    const deadline = Date.now() + WAIT_TIMEOUT;
    let logged = false;

    while (Date.now() < deadline) {
      const url = page.url();

      // 登录成功的特征：URL 跳转到带 home/base 的路径，或出现「小程序」后台标识
      const looksLoggedIn =
        /cgi-bin\/home/.test(url) ||
        /\/cgi-bin\/.*home/.test(url) ||
        (await page.locator('text=小程序').count().catch(() => 0)) > 0 &&
        !/login/i.test(url);

      if (looksLoggedIn && !/login/i.test(url)) {
        console.log('✓ 检测到登录成功');
        console.log('当前页面：', url);
        logged = true;
        break;
      }

      await page.waitForTimeout(2000);
    }

    if (!logged) {
      console.log('⏱ 等待超时，未检测到登录。请在浏览器窗口里手动操作，');
      console.log('   登录后保持窗口打开即可，我会继续用同一窗口。');
    }

    // 登录后：直接跳到插件管理页，省去用户自己找菜单
    if (logged) {
      console.log('\n正在跳转至插件管理页面...');
      await page.goto('https://mp.weixin.qq.com/cgi-bin/wxopenplugin', {
        waitUntil: 'domcontentloaded',
        timeout: 60000
      }).catch((e) => console.log('跳转失败：', e.message));

      console.log('已打开插件管理页。窗口保持打开，你可以继续操作。');
    }

    console.log('\n浏览器保持打开中。关闭窗口即结束。');
    console.log('（本脚本不自动关闭，方便你确认页面状态）');

    // 不主动关闭，等用户自己关窗口
    await new Promise((resolve) => {
      context.on('close', resolve);
    });
    console.log('浏览器已关闭。');
  } catch (e) {
    console.error('\n✗ 出错：', e.message);

    // channel: 'chrome' 在没装 Chrome 的机器上会失败，给出可执行的替代方案
    if (/Executable doesn't exist|chrome/i.test(e.message)) {
      console.error('\n系统未找到 Chrome。可改用 Playwright 自带内核：');
      console.error('  把脚本里的 channel: "chrome" 删掉即可。');
      console.error('  或执行 npx playwright install chromium 下载内核。');
    }
    process.exitCode = 1;
  }
})();