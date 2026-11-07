/**
 * 部署前同步 —— 把 cloudfunctions/shared 复制进每个云函数目录
 *
 * ## 为什么必须是「普通子目录」而不是 node_modules（重要历史教训）
 *
 * 最初的做法是把 shared 复制到 `cloudfunctions/<svc>/node_modules/shared`，
 * 本地跑得通、测试也全绿，但**云端必然报 module not found**：
 *
 *   Cannot find module '/var/shared/rules/asr-parse'
 *   Require stack: - /var/user/index.js
 *
 * 两个原因叠加：
 *   1. 选择「上传并部署：云端安装依赖」时，开发者工具**不上传本地 node_modules**，
 *      云端只按 package.json 装依赖。手工塞进去的 shared 直接丢失。
 *   2. fallback 路径 `__dirname/../shared` 指向仓库里的 cloudfunctions/shared，
 *      它是云函数的**平级兄弟目录**，不在单函数打包范围内，同样找不到。
 *
 * 也就是说：本地全绿 ≠ 云端能跑。凡是「本地手工放进 node_modules 的东西」，
 * 云端一律看不到。这条要记住。
 *
 * ## 现在的做法
 *
 * 复制到 `cloudfunctions/<svc>/shared/`。这是**函数目录内的普通子目录**，
 * 属于打包范围，nodejs 运行时必然带上。
 * 加载器 `loadShared()` 按候选路径依次尝试，两种布局都能跑。
 *
 * 用法：node tools/prepare-cloudfunctions.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CF_DIR = path.join(ROOT, 'cloudfunctions');
const SHARED = path.join(CF_DIR, 'shared');

/** 不需要进云端的目录/文件：测试代码云端用不到，也占体积 */
const EXCLUDE_NAMES = new Set(['node_modules', '__tests__', '.DS_Store']);

const SERVICES = fs
  .readdirSync(CF_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name !== 'shared')
  .map((d) => d.name);

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (EXCLUDE_NAMES.has(entry.name)) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

/** 统计文件数，用于验证复制是否真的成功 */
function countFiles(dir) {
  let n = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (EXCLUDE_NAMES.has(entry.name)) continue;
    n += entry.isDirectory() ? countFiles(path.join(dir, entry.name)) : 1;
  }
  return n;
}

function main() {
  if (!fs.existsSync(SHARED)) {
    console.error('✗ 找不到 shared 目录：', SHARED);
    process.exit(1);
  }

  const expected = countFiles(SHARED);
  console.log(`同步共享层到各云函数（共 ${expected} 个文件）...\n`);

  const failed = [];
  for (const svc of SERVICES) {
    const svcDir = path.join(CF_DIR, svc);
    if (!fs.existsSync(path.join(svcDir, 'index.js'))) {
      console.log(`  跳过 ${svc}（无 index.js）`);
      continue;
    }

    // ✅ 普通子目录：一定随云函数打包上传
    const target = path.join(svcDir, 'shared');
    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
    copyDir(SHARED, target);

    // 同时保留 node_modules 副本：兼容仍按 node_modules 查找的老路径，
    // 且本地 require 走这条更快。真正的可靠性由上面的 shared/ 目录保证。
    const nmTarget = path.join(svcDir, 'node_modules', 'shared');
    if (fs.existsSync(nmTarget)) fs.rmSync(nmTarget, { recursive: true, force: true });
    copyDir(SHARED, nmTarget);

    // 校验：文件数对不上就是复制出了问题，必须当场失败而不是等云端报错
    const got = countFiles(target);
    if (got !== expected) {
      failed.push(`${svc}(${got}/${expected})`);
      console.log(`  ✗ ${svc}/shared 文件数不符`);
      continue;
    }
    console.log(`  ✓ ${svc}/shared (${got} 个文件)`);
  }

  if (failed.length) {
    console.error(`\n✗ 同步不完整：${failed.join(', ')}`);
    process.exit(1);
  }

  console.log('\n完成。');
  console.log('shared/ 是各云函数内的普通子目录，会随函数打包上传（node_modules 不会）。');
  console.log('接下来在开发者工具右键云函数 →「上传并部署：云端安装依赖」。');
}

main();
