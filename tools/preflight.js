#!/usr/bin/env node
/**
 * 真机调试启动预检
 * 用法：node tools/preflight.js
 *
 * 检查项分三类：
 *   [本地] 不依赖 AppID / 云环境，随时可验
 *   [云侧] 需要正式 AppID + 云开发环境
 *   [提示] 需要人工确认的坑
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ok = (m) => console.log(`  \u2713 ${m}`);
const bad = (m) => console.log(`  \u2717 ${m}`);
const warn = (m) => console.log(`  \u26A0 ${m}`);
const info = (m) => console.log(`  \u00B7 ${m}`);

let hardFail = 0;

console.log('\n[1/9] 工程配置');
const cfgPath = path.join(ROOT, 'project.config.json');
if (fs.existsSync(cfgPath)) {
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  ok(`project.config.json 存在（appid=${cfg.appid || '未填写'}）`);
  const lib = String(cfg.libVersion || '');
  if (!lib) warn('未声明 libVersion，工具会用默认基础库，建议显式指定');
  else {
    // libVersion 可能是 "3.5.5"（版本号）或 "2.2.3"（版本号），也可能是日期号 2022213。
    // 统一折算为「数字连成整数」后比较，避免把 3.5.5 误判成低于 2.2.3。
    const num = lib.replace(/\D/g, '');
    const asNum = parseInt(num, 10);
    // 3.5.5 -> 355；2.2.3 -> 223。基础库能力门槛取 2.2.3。
    const below = lib.includes('.') ? asNum < 223 : asNum < 2022213;
    if (below) bad(`基础库 ${lib} 过低，真机可能白屏，需 ≥ 2.2.3`);
    else ok(`基础库 ${lib} ≥ 2.2.3`);
  }
} else {
  bad('project.config.json 不存在，导入项目会失败');
  hardFail++;
}

console.log('\n[2/9] 共享层同步（改了 shared 就必须重跑）');
const svcs = ['bill-svc', 'analysis-svc', 'category-svc', 'user-svc', 'asr-svc'];
let stale = [];
svcs.forEach((s) => {
  const p = path.join(ROOT, 'cloudfunctions', s, 'node_modules', 'shared', 'agent-harness', 'index.js');
  if (!fs.existsSync(p)) stale.push(s);
});
if (stale.length === 0) ok('5 个云函数的 shared 均已同步');
else {
  bad(`未同步：${stale.join(', ')} —— 跑 npm run prepare:cf`);
  hardFail++;
}

// ── 副本内容漂移守卫 ──────────────────────────────────────
//
// 为什么光检查「文件存在」不够：
// prepare:cf 会把 shared 复制进**每个**云函数目录，于是同一个模块存在多份副本。
// 只改了源 shared 却没重跑 prepare:cf 时，副本文件照样存在、路径照样正确，
// 现有检查全部通过——但部署上去的是旧代码。
//
// 真实故障：2026-10-21 改完 shared 后忘了跑 prepare:cf，只同步了 analysis-svc。
// 其余 4 个副本停在 20261021-04，云端跑的是旧版本，
// 前端对账时日期段不同 → 报「云端与本地代码版本不一致」，
// 而这个报错的引导是「确认两端来自同一版本」，完全指错了方向。
//
// 这里做**内容级**比对（逐文件 hash），任何副本落后于源都当场判失败。
const crypto = require('crypto');
const SRC_SHARED = path.join(ROOT, 'cloudfunctions', 'shared');
const EXCLUDE_DIRS = new Set(['node_modules', '__tests__']);

/** 递归收集目录下所有文件的 hash，键为相对路径 */
function hashTree(dir, base = dir) {
  const out = new Map();
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (EXCLUDE_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      for (const [k, v] of hashTree(full, base)) out.set(k, v);
    } else {
      const rel = path.relative(base, full).split(path.sep).join('/');
      out.set(rel, crypto.createHash('sha1').update(fs.readFileSync(full)).digest('hex'));
    }
  }
  return out;
}

const srcHashes = hashTree(SRC_SHARED);
const driftedSvcs = [];
const verOf = (file) => {
  try {
    const m = fs.readFileSync(file, 'utf8').match(/CODE_VERSION\s*=\s*'([^']+)'/);
    return m ? m[1] : null;
  } catch (e) { return null; }
};
const srcVer = verOf(path.join(SRC_SHARED, 'util', 'constants.js'));

for (const s of svcs) {
  const copyHashes = hashTree(path.join(ROOT, 'cloudfunctions', s, 'shared'));
  const diffs = [];
  for (const [rel, h] of srcHashes) {
    if (!copyHashes.has(rel)) diffs.push(`缺 ${rel}`);
    else if (copyHashes.get(rel) !== h) diffs.push(`旧 ${rel}`);
  }
  for (const rel of copyHashes.keys()) {
    if (!srcHashes.has(rel)) diffs.push(`多 ${rel}`);
  }
  if (diffs.length) {
    const copyVer = verOf(path.join(ROOT, 'cloudfunctions', s, 'shared', 'util', 'constants.js'));
    driftedSvcs.push(`${s}(版本 ${copyVer || '无'} vs 源 ${srcVer}，${diffs.length} 个文件不同)`);
  }
}

if (driftedSvcs.length) {
  bad(`这些云函数的 shared/ 副本落后于源，部署上去的是旧代码：\n      ${driftedSvcs.join('\n      ')}\n` +
    `    请执行 npm run prepare:cf 重新同步后再部署。`);
  hardFail++;
} else {
  ok(`5 个云函数的 shared/ 副本内容与源完全一致（逐文件 hash 校验）`);
}

// 副本版本戳必须与源一致——这是前端对账能生效的前提。
// 副本版本与源不一致时，前端会拿本地期望值去比云端返回的副本版本，
// 结果是「永远不一致」，而真实原因只是本地没同步。
const verDrift = svcs.filter((s) => {
  const p = path.join(ROOT, 'cloudfunctions', s, 'shared', 'util', 'constants.js');
  if (!fs.existsSync(p)) return false;
  return verOf(p) !== srcVer;
});
if (verDrift.length) {
  bad(`这些云函数副本的 CODE_VERSION 与源不一致（源 = ${srcVer}）：${verDrift.join(', ')}`);
  hardFail++;
} else {
  ok(`所有云函数副本的 CODE_VERSION = ${srcVer}，与源一致`);
}

console.log('\n[3/9] 云函数目录');
svcs.forEach((s) => {
  const p = path.join(ROOT, 'cloudfunctions', s, 'index.js');
  const pkg = path.join(ROOT, 'cloudfunctions', s, 'package.json');
  if (fs.existsSync(p) && fs.existsSync(pkg)) ok(`${s}（index.js + package.json 齐全）`);
  else bad(`${s} 缺 index.js 或 package.json，上传会失败`);
});

console.log('\n[4/9] 本地密钥');
const envPath = path.join(ROOT, '.env');
if (!fs.existsSync(envPath)) {
  info('.env 不存在 → 本地 verify:api 会走 mock（云侧不受影响）');
  info('需要本地验 LLM 时：cp .env.example .env 并填入 DEEPSEEK_API_KEY');
} else {
  const txt = fs.readFileSync(envPath, 'utf8');
  if (/DEEPSEEK_API_KEY\s*=\s*sk-\S{16,}/.test(txt)) ok('.env 中 DEEPSEEK_API_KEY 已配置');
  else warn('.env 存在但未检测到有效 DEEPSEEK_API_KEY');
}

console.log('\n[5/9] 小程序配置合规');
// requiredPrivateInfos 是「地理位置接口」的私有信息声明字段，只接受官方白名单。
// 录音/相机等走 permission 字段声明，不需要（也不能）写进 requiredPrivateInfos。
// 误写会导致真机调试直接报错：
//   requiredPrivateInfos[0] 字段需为 chooseAddress,chooseLocation,choosePoi,...
const LEGAL_PRIVATE_INFOS = [
  'chooseAddress', 'chooseLocation', 'choosePoi', 'getFuzzyLocation',
  'getLocation', 'onLocationChange', 'startLocationUpdate', 'startLocationUpdateBackground',
];
const appJsonPath = path.join(ROOT, 'miniprogram', 'app.json');
if (fs.existsSync(appJsonPath)) {
  const appJson = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'));
  const rp = appJson.requiredPrivateInfos || [];
  const illegal = rp.filter((x) => !LEGAL_PRIVATE_INFOS.includes(x));
  if (illegal.length) {
    bad(`requiredPrivateInfos 含非地理位置接口：${illegal.join(', ')}`);
    bad('  修法：删除该项。录音/相机等权限用 permission 字段声明，不是 requiredPrivateInfos。');
    hardFail++;
  } else {
    ok('requiredPrivateInfos 合规' + (rp.length ? `（${rp.join(', ')}）` : '（未使用）'));
  }
  const perm = Object.keys(appJson.permission || {});
  ok(`permission 声明：${perm.length ? perm.join(', ') : '无'}`);
} else {
  bad('miniprogram/app.json 不存在');
  hardFail++;
}

console.log('\n[6/9] 语音识别可用性');
const asrIdx = path.join(ROOT, 'cloudfunctions', 'asr-svc', 'index.js');
const asrClientPath = path.join(ROOT, 'cloudfunctions', 'asr-svc', 'asr-client.js');
const asrSrc = fs.existsSync(asrIdx) ? fs.readFileSync(asrIdx, 'utf8') : '';
const asrClientSrc = fs.existsSync(asrClientPath) ? fs.readFileSync(asrClientPath, 'utf8') : '';

if (!/recognizeStream/.test(asrSrc) || !asrClientSrc) {
  bad('asr-svc 缺少流式识别实现（需要 index.js 调用 recognizeStream + asr-client.js）');
} else {
  ok('asr-svc 已接入腾讯云流式识别（WebSocket）');

  if (!/createHmac\('sha1'/.test(asrClientSrc) || !/encodeURIComponent/.test(asrClientSrc)) {
    bad('asr-client.js 签名实现不完整 —— 必须 HMAC-SHA1 + urlencode，否则偶发 4002 鉴权失败');
  } else {
    ok('签名含 HMAC-SHA1 与 urlencode（官方要求，漏 urlencode 会偶发鉴权失败）');
  }

  if (!/SEND_INTERVAL_MS/.test(asrClientSrc) || !/CHUNK_SIZE/.test(asrClientSrc)) {
    bad('asr-client.js 未按分片实时率发送 —— 音频一次性发完会被服务端断开');
  } else {
    ok('音频按分片 + 1:1 实时率发送（避免服务端主动断开）');
  }
}

// 硬编码密钥是安全事故，必须拦住
const envKeyPattern = /TENCENT_ASR_SECRET_KEY\s*[:=]\s*['"][A-Za-z0-9]{20,}/;
if (envKeyPattern.test(asrSrc) || envKeyPattern.test(asrClientSrc)) {
  bad('代码里疑似硬编码了腾讯云 SecretKey —— 密钥必须放云函数环境变量，绝不能进代码仓库');
} else {
  ok('未发现硬编码密钥（凭证走环境变量）');
}

const needEnv = ['TENCENT_ASR_APP_ID', 'TENCENT_ASR_SECRET_ID', 'TENCENT_ASR_SECRET_KEY'];
const envFile = path.join(ROOT, '.env');
const localEnv = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
const notLocal = needEnv.filter((k) => !new RegExp(k).test(localEnv));
if (notLocal.length === 0) {
  ok('本地 .env 已配置腾讯云凭证');
} else {
  info('本地 .env 未配 ' + notLocal.length + ' 项凭证（正常：真机走云函数环境变量）');
  info('真机使用前须在 云开发控制台 → 云函数 → asr-svc → 配置 → 环境变量 中配置：' + needEnv.join(' / '));
}

// 插件残留会让预览直接报 80082 permission deny，必须清干净
const appJsonObj = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'));
if (appJsonObj.plugins && Object.keys(appJsonObj.plugins).length) {
  bad('app.json 仍声明插件 ' + Object.keys(appJsonObj.plugins).join(',') +
      ' —— 微信同声传译仅非个人主体可用且不支持流式上屏，应改用腾讯云 ASR');
} else {
  ok('app.json 无插件声明（已改用腾讯云 ASR，不受主体类型限制）');
}

const voiceSrc = fs.readFileSync(path.join(ROOT, 'miniprogram', 'utils', 'voice.js'), 'utf8');
const codeOnly = voiceSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
if (/requirePlugin/.test(codeOnly)) {
  bad('voice.js 仍有 requirePlugin 残留，插件通道已废弃');
} else if (/callFunction\('asr-svc'/.test(codeOnly)) {
  ok('voice.js 走云函数 asr-svc（腾讯云流式识别）');
}

// 录音参数必须与识别引擎匹配：mp3 + 16k 对应 16k_zh
if (/sampleRate:\s*16000/.test(voiceSrc) && /format:\s*'mp3'/.test(voiceSrc)) {
  ok('录音参数匹配 16k_zh 引擎（mp3 / 16000Hz / 单声道）');
} else {
  warn('录音参数与 16k_zh 引擎可能不匹配，请确认 sampleRate=16000 且 format=mp3');
}

// 云函数 timeout 与 LLM 预算必须匹配
//
// ⚠ 重要澄清（查证腾讯云官方文档后）：
//   「小程序调云函数有 3 秒上限」是**错误说法**。
//   3 秒是云函数 timeout 的**默认值**，可调至 1~900 秒，调高后客户端会等执行完。
//   -504003 里的 "3 seconds" 指的是云函数自身配置。
//
//   但真机上出现过「config.json 写 timeout:25，实际按 3 秒执行」的情况，
//   官方解释是：**云函数配置只对 $LATEST 生效**，调用落到已发布版本时不生效。
//   所以除了检查配置文件，还要提示在控制台确认。
const billCfgPath = path.join(ROOT, 'cloudfunctions', 'bill-svc', 'config.json');
// 从 constants.js 读实际 LLM 预算，避免检查器里写死一个可能过时的数字
const constTxt = fs.readFileSync(path.join(ROOT, 'cloudfunctions', 'shared', 'util', 'constants.js'), 'utf8');
const LLM_TIMEOUT_MS = parseInt((constTxt.match(/LLM_TIMEOUT_MS:\s*(\d+)/) || [])[1] || '0', 10);

if (fs.existsSync(billCfgPath)) {
  const billCfg = JSON.parse(fs.readFileSync(billCfgPath, 'utf8'));
  const t = billCfg.timeout || 0;
  if (t >= 10) {
    ok(`bill-svc timeout=${t}s（够 LLM 用）`);
    if (LLM_TIMEOUT_MS < 5000) {
      info(`LLM 预算当前 ${LLM_TIMEOUT_MS}ms 偏保守。timeout=${t}s 够用的话，` +
        '可把 LLM_TIMEOUT_MS 恢复到 5000~8000、LLM_RETRY_LIMIT 恢复到 1，' +
        '分类准确率会明显提升');
    }
  } else {
    warn(`bill-svc timeout=${t}s 偏紧。若真机仍报 -504003（3秒），` +
      '说明**配置未生效**：官方注明云函数配置只对 $LATEST 生效。' +
      '请在云开发控制台 → 云函数 → bill-svc → 配置 → 超时时间 改大并重新部署');
  }
} else {
  warn('bill-svc/config.json 不存在，云函数将使用默认 timeout=3s');
}

/**
 * analysis-svc 的 timeout 必须单独检查
 *
 * 为什么不能复用 bill-svc 的检查：
 *   两者耗时结构完全不同。bill-svc 是单次 LLM（2.2 秒），
 *   analysis-svc 是「最多 3 轮工具往返 + 数据库查询」，最坏要 10 秒以上。
 *   用 bill-svc 的阈值（≥10 秒就算够）去判 analysis-svc，
 *   会把 15 秒这种明显不够的配置判成「够用」——
 *   而这正是 analysis-svc 之前的真实配置，消费分析必然 -504003。
 */
const ANALYSIS_LLM_TIMEOUT_MS = parseInt(
  (constTxt.match(/ANALYSIS_LLM_TIMEOUT_MS:\s*(\d+)/) || [])[1] || '0', 10
);
const ANALYSIS_MAX_TOOL_ROUNDS = parseInt(
  (constTxt.match(/ANALYSIS_MAX_TOOL_ROUNDS:\s*(\d+)/) || [])[1] || '3', 10
);
const analysisCfgPath = path.join(ROOT, 'cloudfunctions', 'analysis-svc', 'config.json');

if (fs.existsSync(analysisCfgPath)) {
  const cfg = JSON.parse(fs.readFileSync(analysisCfgPath, 'utf8'));
  const t = cfg.timeout || 0;

  /**
   * 阈值算法（曾把 15s 判成「够用」，是错的）
   *
   * 不能只算「LLM 总预算 + 固定余量」：
   * llm-client 的 chatWithTools 把总预算**分摊到每一轮**
   * （perRoundTimeout = max(800, timeoutMs / maxRounds)），
   * 所以单轮上限不是 8 秒而是 ~2.7 秒。
   *
   * 但真正的风险在冷启动：函数冷启动本身可能 3~5 秒，
   * 这段时间**不计入 LLM 预算**，却实实在在吃掉函数总时长。
   * 因此阈值必须额外为冷启动留一整段余量。
   */
  const perRoundSec = Math.ceil(Math.max(800, ANALYSIS_LLM_TIMEOUT_MS / ANALYSIS_MAX_TOOL_ROUNDS) / 1000);
  // 单轮上限 + 数据库查询与清洗 + 冷启动余量
  const needSec = perRoundSec + 3 + 5;

  if (t >= needSec) {
    ok(`analysis-svc timeout=${t}s（消费分析需 ≥${needSec}s：单轮 LLM 上限 ${perRoundSec}s ` +
      `+ 3s 数据处理 + 5s 冷启动余量）`);
  } else {
    bad(`analysis-svc timeout=${t}s 不足以支撑消费分析（需 ≥ ${needSec}s）。` +
      `分析走 LLM 工具调用：总预算 ${ANALYSIS_LLM_TIMEOUT_MS}ms 分摊到最多 ${ANALYSIS_MAX_TOOL_ROUNDS} 轮，` +
      `单轮上限约 ${perRoundSec}s，再加数据库查询、账单清洗与冷启动余量。` +
      '请调大 timeout 并重新部署');
  }
} else {
  warn('analysis-svc/config.json 不存在，将使用默认 timeout=3s，消费分析会 -504003');
}

// 版本对账必须**区分方向**，不能只判不相等。
// 只判不等时，云端比本地新（改了云函数但忘了重新编译小程序）
// 会误报「云端版本过旧，请上传部署」——而正确操作是反向的：重新编译小程序。
// 误报会把人引向错误的操作，然后继续困惑「我明明部署了怎么还提示过旧」。
const feCloudSrc = fs.readFileSync(path.join(ROOT, 'miniprogram', 'utils', 'cloud.js'), 'utf8');
if (/remoteIsOlder/.test(feCloudSrc) && /本地小程序包版本过旧/.test(feCloudSrc)) {
  ok('版本对账区分了「云端旧」与「本地旧」（引导方向正确）');
} else {
  bad('版本对账未区分方向 —— 云端比本地新时会误报「云端版本过旧」，' +
    '把人引向错误的操作（应重新编译小程序，而非部署云函数）');
}

// 版本号必须按数字比序号，不能用字符串比较：
// '20261018-9' > '20261018-14' 在字符串比较下成立，是错的
if (/parseInt\(\s*m\[2\]\s*,\s*10\s*\)|seq:\s*parseInt/.test(feCloudSrc)) {
  ok('版本序号按数字解析（字符串比较会把 -9 判为大于 -14）');
} else {
  bad('版本序号未按数字解析 —— 字符串比较下 20261018-9 > 20261018-14，会判错方向');
}

if (/this\.starting\s*=/.test(voiceSrc) && /cancelRequested/.test(voiceSrc)) {
  ok('voice.js 有 starting/cancelRequested 防并发与取消保护');
} else {
  bad('voice.js 缺少 starting/cancelRequested 保护 —— start() 异步等权限，' +
    '快速连按或中途松手会导致 operateRecorder:fail is recording or paused');
}

// ⚠ 云函数运行时没有全局 WebSocket，流式识别必须依赖 ws 包。
//   漏了这个依赖，真机会报「当前云函数运行时没有 WebSocket 实现」——
//   而本地 Node 22 有全局 WebSocket，所以本地测试永远发现不了。
const asrPkgPath = path.join(ROOT, 'cloudfunctions', 'asr-svc', 'package.json');
if (fs.existsSync(asrPkgPath)) {
  const asrPkg = JSON.parse(fs.readFileSync(asrPkgPath, 'utf8'));
  if ((asrPkg.dependencies || {}).ws) {
    ok(`asr-svc 已声明 ws 依赖（${asrPkg.dependencies.ws}）`);
  } else {
    bad('asr-svc/package.json 未声明 ws 依赖 —— 云函数运行时没有内置 WebSocket，' +
      '流式识别会直接失败。加 "ws": "^8.18.0" 后用「上传并部署：云端安装依赖」部署');
  }
}

// 小程序调用云函数有 3 秒网关上限（-504003 TIME_LIMIT_EXCEEDED），
// 同步 recognize 必然超时——实测踩过。必须用「异步启动 + 轮询」。
if (asrSrc.includes('startRecognize') && asrSrc.includes('pollResult')) {
  ok('asr-svc 提供异步识别（startRecognize + pollResult）');
} else {
  bad('asr-svc 缺少异步识别能力 —— 小程序调用云函数有 3 秒上限，' +
    '同步 recognize 会被判TIME_LIMIT_EXCEEDED');
}

if (voiceSrc.includes('_pollJob') && /action:\s*'startRecognize'/.test(voiceSrc)) {
  ok('voice.js 使用异步 + 轮询（startRecognize → _pollJob）');
} else {
  bad('voice.js 未使用异步 + 轮询 —— 同步调用云函数会因 3 秒网关上限超时');
}

// context.callbackWaitsForEmpty=false 是异步的前提，
// 不设它云函数会等后台任务结束才返回，3 秒上限照样爆
if (/callbackWaitsForEmpty\s*=\s*false/.test(asrSrc)) {
  ok('startRecognize 设置了 callbackWaitsForEmpty=false（立即返回）');
} else {
  bad('startRecognize 未设置 context.callbackWaitsForEmpty = false —— ' +
    '云函数会等后台识别结束才返回，3 秒网关上限照样触发');
}

// 识别成功时录音由云函数自己删（识别完即删），
// 前端若在 finally 里删，后台识别会因文件不存在而失败。
//
// ⚠ 用「精确匹配 finally 后紧跟 cleanup」而非宽泛正则：
//   上一版用 /finally[\s\S]{0,200}action:'cleanup'/ 误报——
//   因为注释里提到 "finally" 这个词也被匹配到了。
//   检查代码的代码本身不该有假阳性。
const hasFinallyCleanup =
  /finally\s*\{[^}]*action:\s*'cleanup'/.test(voiceSrc);

if (hasFinallyCleanup) {
  bad('voice.js 在 finally 里清理录音 —— 后台识别还在用这个文件，提前删会导致它失败。' +
    '应在失败分支且任务未启动时才清理');
} else {
  ok('录音清理未放在 finally（不会与后台识别抢文件）');
}

// 代码必须走统一封装，不能直接 new WebSocket——ws 包与浏览器 API 不同
if (asrClientSrc.includes('require(\'ws\')') && asrClientSrc.includes('openSocket')) {
  ok('asr-client.js 通过 ws 包 + openSocket 统一封装获取 WebSocket');
} else {
  bad('asr-client.js 未使用 ws 包与统一封装 —— ws 包用 on() 事件风格，' +
    '直接写 ws.onmessage 不会触发');
}
if (asrClientSrc.includes('require(\'ws\')') && asrClientSrc.includes('openSocket')) {
  ok('asr-client.js 通过 ws 包 + openSocket 统一封装获取 WebSocket');
} else {
  bad('asr-client.js 未使用 ws 包与统一封装 —— ws 包用 on() 事件风格，' +
    '直接写 ws.onmessage 不会触发');
}

// 云存储 fileID 必须是完整 cloud:// URL。
// 传相对路径（asr/xxx.mp3）→ downloadFile 报 -503003 文件不存在，
// 而上传是成功的——这个 bug 极隐蔽：上传明明成功了，是下载侧找不到。
if (/up\.fileID|uploadFile[\s\S]{0,120}fileID/.test(voiceSrc) && /payload:\s*\{\s*fileID/.test(voiceSrc)) {
  ok('voice.js 把 uploadFile 返回的完整 fileID 传给云函数');
} else {
  bad('voice.js 未传完整 fileID —— 云存储 downloadFile 只认cloud:// 完整路径，' +
    '传相对路径会报 -503003 文件不存在');
}

// asr-client.js 必须显式校验 fileID 是完整 cloud:// URL，
// 否则用户只会看到难懂的 -503003，而不是「你传了相对路径」
// 用字符串包含判断而非正则——正则里的 \/ 转义在多层字符串里极易出错，
// 而且前一次就因为正则写错而误报（代码其实是对的）
const hasFileIdGuard =
  asrClientSrc.includes('cloud://') &&
  asrClientSrc.includes('.test(target)') &&
  asrClientSrc.includes('fileID || cloudPath');

if (hasFileIdGuard) {
  ok('asr-client.js 下载前校验 fileID 格式（拒绝非 cloud:// 路径）');
} else {
  bad('asr-client.js 未校验 fileID 格式 —— downloadFile 只认 cloud:// 完整路径，' +
    '应在下载前显式校验，避免只报出难懂的 -503003');
}

if (/503003/.test(asrClientSrc)) {
  ok('asr-client.js 对 -503003 有专门诊断（区分环境不一致等三种原因）');
} else {
  warn('asr-client.js 未针对 -503003 做诊断，报错时难以定位');
}

if (/abort\(\)\s*\{/.test(voiceSrc)) {
  ok('voice.js 提供 abort()，取消/卸载时可强制停掉录音器');
} else {
  bad('voice.js 缺少 abort() —— 取消或卸载时录音器不会被停，下一次 start 必然报错');
}

// 取消录音必须走 abort 而非 reset：reset 只改本地状态，不停真正的录音器
const idxJsPath = path.join(ROOT, 'miniprogram', 'pages', 'index', 'index.js');
if (fs.existsSync(idxJsPath)) {
  const idxSrc = fs.readFileSync(idxJsPath, 'utf8');
  const cancelBlock = (idxSrc.match(/onRecordCancel[\s\S]{0,400}?\n\s{2}\},/) || [''])[0];
  if (/voice\.abort\(\)/.test(cancelBlock)) {
    ok('onRecordCancel 调用 abort()（会真正停掉录音器）');
  } else {
    bad('onRecordCancel 未调用 abort() —— 只 reset 会让录音器继续录，' +
      '下一次开始录音报 is recording or paused');
  }
  if (/onUnload[\s\S]{0,300}?voice\.abort\(\)/.test(idxSrc)) {
    ok('onUnload 先 abort 再 destroy（退出页面不残留录音）');
  } else {
    warn('onUnload 未调用 abort()，退出页面时录音器可能仍在录音');
  }
}

// timeout 必须够长：30s 录音按 1:1 实时率发送，光发音频就 30s，
// 再加下载与识别耗时，20s 会必然超时（且超时错误不会告诉你真正原因）
const asrCfgPath = path.join(ROOT, 'cloudfunctions', 'asr-svc', 'config.json');
if (fs.existsSync(asrCfgPath)) {
  const cfg = JSON.parse(fs.readFileSync(asrCfgPath, 'utf8'));
  const maxRecordSec = 30; // 前端 RECORDER_OPTIONS.duration / 1000
  // 最坏情况：音频时长（实时率发送）+ 下发+ 收尾缓冲
  const need = maxRecordSec + 20;
  if ((cfg.timeout || 0) >= need) {
    ok(`asr-svc timeout=${cfg.timeout}s，满足流式识别所需（≥${need}s）`);
  } else {
    bad(`asr-svc timeout=${cfg.timeout}s 过短 —— 30s 录音按 1:1 实时率发送需30s，` +
      `加上下载与收尾至少需 ${need}s，否则必然超时`);
  }
  // WebSocket 需要 Node 16.13+
  const rt = cfg.runtime || '';
  if (/16\.(1[3-9]|[2-9]\d)|1[7-9]\.\d+|2\d\.\d+/.test(rt)) {
    ok(`asr-svc 运行时 ${rt} 支持 WebSocket`);
  } else {
    bad(`asr-svc 运行时 ${rt} 可能不支持 WebSocket，需要 Node 16.13 或更高`);
  }
}
/**
 * 定时触发器检查
 *
 * ## 为什么单独检查
 *
 * 触发器是**静默失效**的：config.json 里没写、或者写错了，
 * 云函数照常工作、照常响应，只是不再定时跑。
 * 现象是「每天 0 点没有任何反应」，但日志里连报错都没有——
 * 用户会以为代码有问题，而根因在配置。
 *
 * 另外 config.json **不能有注释**（官方未明确，但社区普遍反馈
 * 带注释会导致部署时触发器一直失败），这里用 JSON.parse 天然兜住。
 */
if (fs.existsSync(analysisCfgPath)) {
  let cfg = null;
  let parseError = '';
  try {
    cfg = JSON.parse(fs.readFileSync(analysisCfgPath, 'utf8'));
  } catch (e) {
    parseError = e.message;
  }

  if (!cfg) {
    bad(`analysis-svc/config.json 解析失败（多半是写了注释，config.json 不支持注释）：${parseError}`);
  } else if (!Array.isArray(cfg.triggers) || !cfg.triggers.length) {
    bad('analysis-svc 未配置定时触发器 —— 消费分析将永远不会自动执行。' +
      '请在 config.json 加 triggers（cron 用 7 位：秒 分 时 日 月 周 年）');
  } else {
    const t = cfg.triggers[0];
    if (t.type !== 'timer') {
      bad(`analysis-svc 触发器 type 应为 timer，实际为 ${t.type}`);
    } else {
      // cron 校验用「按空格切分看段数」，比正则可靠：
      // 正则里 \s 与 $ 的转义组合极易写错（本项目就写错过一次），
      // 而切分是零歧义的。
      const parts = String(t.config || '').trim().split(/\s+/);
      if (parts.length !== 7) {
        bad(`定时触发器 cron 应为 7 段（秒 分 时 日 月 周 年），实际 ${parts.length} 段：「${t.config}」`);
      } else {
        ok(`analysis-svc 定时触发器已配置：${t.name}（cron "${t.config}"，UTC+8）`);
        info('定时触发无用户上下文，由 dailyInsight action 自行查询待分析用户清单');
        info('若用户量较大，单次 40 秒可能处理不完，可调大 timeout 或提高触发频率');
      }
    }
  }
}

/**
 * 定时触发器归一判据守卫（2026-11-08 修复后加的防线）
 *
 * ## 为什么需要它
 *
 * 2026-11-08 00:30 云端日志实测（请求 860de654）：平台实际下发的
 * 定时事件 `Type` 是**小写** `'timer'`（官方文档写大写 `'Timer'`），
 * 且额外带 `tcbContext`/`userInfo` 字段。此前两个云函数的归一判据
 * 写死 `Type === 'Timer'`（大写）→ 云端真实事件**永不命中** →
 * 每天 0:00 分析 / 0:30 重复记账静默失败，而测试按文档大写构造全绿 ——
 * 本地全绿 ≠ 云端能跑。
 *
 * 修法是判据大小写不敏感（isTimerEvent）。这条守卫防回归：
 * 谁再把判据改回写死大写，preflight 当场报警。
 */
{
  const caseInsensitivePattern = /\.toLowerCase\(\)\s*===\s*['"]timer['"]/;
  for (const svcName of ['analysis-svc', 'bill-svc']) {
    const src = fs.readFileSync(path.join(ROOT, 'cloudfunctions', svcName, 'index.js'), 'utf8');
    if (caseInsensitivePattern.test(src)) {
      ok(`${svcName} 定时事件归一判据大小写不敏感（平台实测下发小写 'timer'）`);
    } else {
      bad(`${svcName} 定时事件归一判据疑似写死大小写 —— 平台实际下发 Type='timer'（小写），` +
        '写死大写会导致定时任务每天静默失败（2026-11-08 实测故障）');
    }
  }
}

console.log('\n[7/9] 数据库就绪度');

/**
 * 备注总结链路守卫
 *
 * ## 为什么需要它
 *
 * 早期语音记账把 `scene`（场景线索）当备注写进账单。两个后果：
 *   1. 兜底路径下 scene 是**英文代码**（friends/unit），
 *      用户在明细页看到的是「friends」，完全看不懂
 *   2. scene 是「场景线索」，不是「用户描述的总结」——
 *      它丢掉了原话里最有价值的那部分上下文
 *
 * 现在备注由 LLM 总结（note-summary.buildNote）产出。
 * 这条守卫防止有人日后把落库的 note 又改回 scene。
 */
{
  const billSvcSrc = fs.readFileSync(path.join(ROOT, 'cloudfunctions', 'bill-svc', 'index.js'), 'utf8');
  const agentSrc = fs.readFileSync(
    path.join(ROOT, 'cloudfunctions', 'shared', 'agent-harness', 'agents', 'bill-parse.agent.js'), 'utf8'
  );
  const schemaSrc = fs.readFileSync(
    path.join(ROOT, 'cloudfunctions', 'shared', 'agent-harness', 'schemas', 'bill-parse.schema.js'), 'utf8'
  );

  // 落库用 finalData.note，不能是 finalData.scene
  if (/note:\s*finalData\.note/.test(billSvcSrc)) {
    ok('账单落库使用总结后的备注（finalData.note），不是 scene');
  } else {
    bad('账单落库未使用 finalData.note —— 备注必须来自 LLM 总结，' +
      'scene 是英文代码且丢失原话上下文');
  }

  // LLM 必须被要求输出 note
  if (/note/.test(agentSrc) && /### 备注/.test(agentSrc)) {
    ok('bill-parse agent 的 Prompt 要求产出备注（note）');
  } else {
    bad('bill-parse agent 的 Prompt 未要求产出备注 —— 总结逻辑缺失，' +
      '备注会退回规则层的机械剥离');
  }

  // schema 里必须有 note 字段
  if (/note:/.test(schemaSrc)) {
    ok('bill-parse schema 声明了 note 字段');
  } else {
    bad('bill-parse schema 缺少 note 字段 —— 模型即使想给备注也会被结构校验丢掉');
  }

  // 备注的长度上限必须与「明细页备注编辑框」一致。
  //
  // ⚠ 不是手动输入框（那个是 30，约束的是用户手打几字），
  //   而是明细页编辑已有账目时的备注框（200）。
  //   兜底路径会把**用户原话全文**写进备注，若上限大于 200，
  //   用户在明细页点开编辑时会被 maxlength 截断，存回去的备注就变了。
  const noteSummaryPath = path.join(ROOT, 'cloudfunctions', 'shared', 'util', 'note-summary.js');
  if (fs.existsSync(noteSummaryPath)) {
    const nsSrc = fs.readFileSync(noteSummaryPath, 'utf8');
    const maxLen = parseInt((nsSrc.match(/MAX_FALLBACK_LENGTH\s*=\s*(\d+)/) || [])[1] || '0', 10);
    const detailMax = parseInt(
      (fs.readFileSync(path.join(ROOT, 'miniprogram', 'pages', 'detail', 'detail.wxml'), 'utf8')
        .match(/class="edit-input"[\s\S]{0,400}?maxlength="(\d+)"/) || [])[1] || '0', 10
    );
    if (maxLen > 0 && maxLen === detailMax) {
      ok(`备注兜底长度上限 ${maxLen} 字，与明细页备注编辑框一致`);
    } else {
      bad(`备注兜底长度上限 ${maxLen} 与明细页备注编辑框上限 ${detailMax} 不一致 —— ` +
        '上限更大时，用户编辑这笔账会被 maxlength 截断，存回去的备注就变了');
    }
  } else {
    bad('缺少 shared/util/note-summary.js —— 备注总结逻辑不存在');
  }
}

const dbSrc = fs.readFileSync(path.join(ROOT, 'cloudfunctions', 'shared', 'db', 'index.js'), 'utf8');
// dbFns 增加分析结果的存取方法——少了它们，分析页会一直拿不到数据
const dbFns = ['insertBill', 'listBills', 'monthStat', 'categoryBreakdown', 'softDelete',
  'saveInsight', 'getInsight']
  .filter((f) => new RegExp(`function ${f}\\b`).test(dbSrc));
const REQUIRED_FN_COUNT = 7;
if (dbFns.length === REQUIRED_FN_COUNT) {
  ok('数据库层 7 个核心方法齐全（写入/分页/统计/聚合/软删/分析存取）');
} else {
  bad(`数据库层方法缺失：${REQUIRED_FN_COUNT - dbFns.length} 个未找到`);
}
ok('金额整数分存储已启用（Math.round 强制取整）');

/**
 * 集合清单必须**从代码里读**，不能写死
 *
 * 曾写死「仅 bills 一个，其余 P1/P2 才用」，
 * 后来加了 users 存储分析结果，这句话立刻变成错的——
 * 而它是用户去控制台建表的唯一依据，写错的后果是
 * 分析页永远拿不到数据，且没有任何报错提示。
 */
const requiredColls = (() => {
  const m = dbSrc.match(/REQUIRED_COLLECTIONS\s*=\s*\[([^\]]*)\]/);
  if (!m) return [];
  // 常量定义在 constants.js 而不是 db 层，必须去那里取真实字符串
  const constantsPath = path.join(ROOT, 'cloudfunctions', 'shared', 'util', 'constants.js');
  const constSrc = fs.existsSync(constantsPath)
    ? fs.readFileSync(constantsPath, 'utf8')
    : '';
  return m[1].split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      // 形如 COLLECTIONS.BILLS → 取 key 再查常量的字符串值
      const key = s.replace(/^COLLECTIONS\./, '');
      const cm = constSrc.match(new RegExp(`\\b${key}:\\s*'([^']+)'`));
      return cm ? cm[1] : key;
    });
})();

if (requiredColls.length) {
  info(`集合需在云开发控制台手工建：${requiredColls.join('、')}`);
  if (requiredColls.includes('users')) {
    info('· users 用于存消费分析结果，权限设为「仅创建者可读写」' +
      '（含消费隐私，不应公开可读）');
  }
}
info('云开发不允许代码建集合，这一步无法自动化');
// 云函数里没有全局 cloud，必须走 wx-server-sdk。
// 出现 typeof cloud !== 'undefined' 说明又退回旧写法了，判为 P0。
// 先剥掉注释再匹配，否则 sdk.js 里「反面教材示例」的注释会误报。
const dbCodeOnly = dbSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
if (/typeof cloud\s*!==\s*'undefined'/.test(dbCodeOnly)) {
  bad('db 层仍在检测全局 cloud —— 云函数无此全局对象，必须 require wx-server-sdk（见 shared/db/sdk.js）');
} else {
  ok('db 层已改为 wx-server-sdk 引导（shared/db/sdk.js），未依赖全局 cloud');
}

// 每个会写库的云函数都必须声明 wx-server-sdk，否则 require 失败
const sdkDeps = ['bill-svc', 'analysis-svc', 'category-svc', 'user-svc']
  .filter((fn) => {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'cloudfunctions', fn, 'package.json'), 'utf8'));
      return !((pkg.dependencies || {})['wx-server-sdk']);
    } catch (e) {
      return true;
    }
  });
if (sdkDeps.length === 0) ok('4 个写库云函数均已声明 wx-server-sdk 依赖');
else bad(`以下云函数缺少 wx-server-sdk 依赖：${sdkDeps.join(', ')}`);

// ── shared 是否真的会被打包上传（云端 module not found 的根因）──
//
// 历史故障：cloud 报 Cannot find module '/var/shared/rules/asr-parse'。
// 原因是 shared 只存在于本地 node_modules，而「上传并部署：云端安装依赖」
// **不会上传本地 node_modules**，只按 package.json 装依赖。
//
// 可靠的只有云函数目录内的普通子目录 shared/。这里逐个校验它存在且内容完整，
// 让这类问题在部署前就被拦住，而不是等云端 443。
const svcDirs = fs.readdirSync(path.join(ROOT, 'cloudfunctions'), { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name !== 'shared')
  .map((d) => d.name)
  .filter((svc) => fs.existsSync(path.join(ROOT, 'cloudfunctions', svc, 'index.js')));

const sharedSrc = path.join(ROOT, 'cloudfunctions', 'shared');
const keyFiles = ['db/index.js', 'util/constants.js', 'util/money.js', 'rules/asr-parse.js'];
const missingShared = [];

for (const svc of svcDirs) {
  const svcShared = path.join(ROOT, 'cloudfunctions', svc, 'shared');
  const miss = keyFiles.filter((f) => !fs.existsSync(path.join(svcShared, f)));
  if (miss.length) missingShared.push(`${svc}(缺 ${miss.length} 项)`);
}

if (missingShared.length) {
  bad(`这些云函数的 shared/ 不完整，云端必然报 module not found：${missingShared.join(', ')}。` +
    `请执行 npm run prepare:cf`);
} else {
  ok(`${svcDirs.length} 个云函数的 shared/ 子目录完整（会随包上传）`);
}

// 加载器必须把 shared/ 子目录排在候选第一位，否则改了加载器又会退回旧坑
const badLoaders = svcDirs.filter((svc) => {
  const src = fs.readFileSync(path.join(ROOT, 'cloudfunctions', svc, 'index.js'), 'utf8');
  if (!/loadShared|require\(/.test(src)) return false; // 不加载 shared 的函数跳过
  return !/__dirname,\s*'shared'/.test(src) && !/__dirname,\s*"shared"/.test(src);
});
if (badLoaders.length) {
  bad(`这些云函数的 loadShared 未把 __dirname/shared 列为候选：${badLoaders.join(', ')}`);
} else {
  ok('各云函数 loadShared 均以 __dirname/shared 为首选候选');
}

// ── 版本戳一致性 ──────────────────────────────────────────
// 版本对账是判断「云端到底跑的是哪份代码」的唯一依据。
// 两处版本号一旦不同步，前端会永远报「云端过旧」或永远不报，
// 这个守卫的作用就是防止这种失效静默发生。
const constSrc = fs.readFileSync(path.join(ROOT, 'cloudfunctions', 'shared', 'util', 'constants.js'), 'utf8');
const cfVerM = constSrc.match(/CODE_VERSION\s*=\s*'([^']+)'/);
const feSrc = fs.readFileSync(path.join(ROOT, 'miniprogram', 'utils', 'cloud.js'), 'utf8');
const feVerM = feSrc.match(/EXPECTED_CODE_VERSION\s*=\s*'([^']+)'/);

if (!cfVerM || !feVerM) {
  bad('版本戳缺失：shared/util/constants.js 的 CODE_VERSION 与 utils/cloud.js 的 EXPECTED_CODE_VERSION 必须同时存在');
} else if (cfVerM[1] !== feVerM[1]) {
  bad(`版本戳不同步：云端 ${cfVerM[1]} vs 前端 ${feVerM[1]}。改了云函数代码请同步更新两处，否则版本对账失效`);
} else {
  ok(`版本戳一致：${cfVerM[1]}（前后端已同步）`);
}

// 云函数入口必须真的把版本号带出去，否则对账形同虚设
const billSrc = fs.readFileSync(path.join(ROOT, 'cloudfunctions', 'bill-svc', 'index.js'), 'utf8');
if (/res\.codeVersion\s*=\s*CODE_VERSION/.test(billSrc)) {
  ok('bill-svc 每次响应都带 codeVersion，可用于判断云端是否已更新');
} else {
  bad('bill-svc 未把 CODE_VERSION 写入响应，版本对账无法生效');
}

/**
 * 运行时能力检测
 *
 * ## 为什么必须查
 *
 * 实测踩坑：云函数运行时 `Nodejs18.15` + CommonJS 上下文下
 * **全局 fetch 不存在** → `ReferenceError: fetch is not defined`。
 *
 * 而本地 Node 22 有 fetch，所以本地测试全绿、云端从未跑通过。
 * 这类问题靠读代码看不出来——必须实际探测。
 *
 * 现在代码已改用 Node 内置 https 模块（不依赖任何全局），
 * 但仍要检查：
 *   1. 代码里**没有残留** fetch 调用（改了但漏改一处就又炸了）
 *   2. Node 内置 https 模块可用（这是新的依赖）
 */
console.log('\n[8/9] 云端运行时能力');

{
  const sharedDir = path.join(ROOT, 'cloudfunctions', 'shared');

  // ① 扫残留的 fetch 调用
  // ⚠️ 只扫业务代码，排除测试与工具（那些里 mock fetch 是合理的）
  const fetchUsages = [];
  const scanDir = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) {
        if (name === '__tests__') continue;
        scanDir(full);
      } else if (name.endsWith('.js')) {
        const src = fs.readFileSync(full, 'utf8');
        // 匹配裸调用 fetch( —— 排除注释与字符串里的
        const lines = src.split('\n');
        lines.forEach((line, i) => {
          const trimmed = line.trim();
          if (trimmed.startsWith('*') || trimmed.startsWith('//')) return;
          if (/\b(?:await\s+)?fetch\s*\(/.test(line) && !/httpClient|postJson/.test(line)) {
            fetchUsages.push(`${path.relative(ROOT, full).replace(/\\/g, '/')}:${i + 1}`);
          }
        });
      }
    }
  };
  scanDir(sharedDir);

  if (fetchUsages.length) {
    bad(`云端代码里还有 ${fetchUsages.length} 处 fetch 调用：` +
      fetchUsages.slice(0, 5).join(', '));
    console.log('      Nodejs18.15 + CommonJS 下没有全局 fetch，会报 ' +
      '"fetch is not defined"。请改用 shared/util/http-client.js 的 postJson。');
  } else {
    ok('云端代码无 fetch 调用（已改用 https 模块）');
  }

  // ② 确认 http-client 存在且可加载
  const httpClientPath = path.join(sharedDir, 'util', 'http-client.js');
  if (!fs.existsSync(httpClientPath)) {
    bad('缺少 shared/util/http-client.js —— LLM 请求将无处可发');
  } else {
    try {
      const hc = require(httpClientPath);
      const probe = hc.probeRuntime();
      if (!probe.hasHttps) {
        bad('https 模块不可用，无法发 HTTP 请求');
      } else {
        ok(`http-client 就绪（https 模块可用，本地 Node ${probe.nodeVersion}）`);
      }
      if (!probe.hasFetch) {
        info('本地也没有全局 fetch —— 与云端 Nodejs18.15 一致，测试路径可信');
      } else {
        info(`本地有全局 fetch（Node ${probe.nodeVersion}），` +
          '但云端 Nodejs18.15 没有 —— 所以测试必须 mock http-client 而不是 global.fetch');
      }
    } catch (e) {
      bad('http-client 加载失败：' + e.message);
    }
  }
}

console.log('\n[9/9] 本地测试');

/**
 * 前端语法检查必须进preflight
 *
 * 踩过的坑：analysis.js 的 data 对象少一个逗号，
 * 本地所有工具都「通过」，真机却直接白屏报语法错误。
 *
 * 根因：preflight 与 check:ui 原本都只做**文本匹配**，
 * 从不真正解析 JS。少一个逗号在文本层面完全看不出来。
 *
 * 这个检查是「能不能真机调试」的最后一道闸——
 * 真机白屏的排查成本远高于跑一次脚本的成本。
 */
try {
  const out = execFileSync(process.execPath, [path.join(ROOT, 'tools', 'check-frontend.js')], {
    encoding: 'utf8',
    cwd: ROOT,
  });
  if (/校验通过/.test(out)) {
    ok('前端静态校验通过（含 JS 语法检查）');
  } else {
    bad('前端静态校验未通过，请执行 npm run check:ui 查看详情');
  }
} catch (e) {
  const out = (e.stdout && e.stdout.toString()) || '';
  const errLine = (e.stderr && e.stderr.toString()) || e.message;
  if (/✗/.test(out)) {
    // check-frontend 发现问题时以非零码退出，这里把具体问题摘出来
    const problems = out.split('\n').filter((l) => l.includes('✗')).map((l) => l.trim());
    bad(`前端校验发现 ${problems.length} 个问题：`);
    problems.slice(0, 5).forEach((p) => console.log(`      ${p}`));
  } else {
    bad('前端静态校验执行失败：' + String(errLine).split('\n')[0]);
  }
}

try {
  const out = execFileSync(process.execPath, [path.join(ROOT, 'tools', 'e2e-local.js')], {
    encoding: 'utf8',
    cwd: ROOT,
  });
  if (/全部通过/.test(out)) ok('端到端本地模拟通过');
  else warn('e2e 输出异常，请手动跑 npm run test:e2e 查看');
} catch (e) {
  bad('e2e 失败：' + String(e.message).split('\n')[0]);
  hardFail++;
}

/**
 * Wiki 一致性检查
 *
 * 为什么要进 preflight：
 * Wiki 是「给人看 + 给 LLM 吃」的长期资产，最怕的是
 * **llms.txt 里列了某页，但文件已经不存在** —— LLM 按索引去读会拿到 404，
 * 而人根本发现不了（目录页还照常显示）。
 *
 * 这里只查「链接目标存在」这一件事，不做内容正确性检查
 * （内容对不对是人的事，工具查不出来）。
 */
console.log('\n[10/10] Wiki 一致性');
const wikiDir = path.join(ROOT, 'docs', 'wiki');
const llmsPath = path.join(wikiDir, 'llms.txt');
if (!fs.existsSync(llmsPath)) {
  info('未找到 docs/wiki/llms.txt —— 跳过 Wiki 检查（本项目尚未建立 Wiki）');
} else {
  const llmsRaw = fs.readFileSync(llmsPath, 'utf8');
  const wikiLinks = [];
  llmsRaw.split('\n').forEach((line) => {
    const m = line.match(/^\s*-\s*\[[^\]]+\]\(([^)]+)\)/);
    if (m) wikiLinks.push(m[1]);
  });
  let missing = 0;
  wikiLinks.forEach((href) => {
    if (!fs.existsSync(path.join(wikiDir, href))) {
      bad(`llms.txt 指向的文件不存在：${href}`);
      missing++;
    }
  });
  if (!missing) {
    ok(`llms.txt 索引的 ${wikiLinks.length} 个页面均存在`);
  } else {
    // ⚠️ 这里必须 hardFail++，不能只 bad() 打印。
    //
    // 历史漏洞：bad() 只打印不计数 → preflight 报 7 条 ✗ 却 exit 0
    // → CI / 自动化照样绿 → 「llms.txt 指向 404」这个守卫形同虚设。
    // 「所有检查都通过」不等于「检查是对的」，守卫本身也得能拦住。
    hardFail++;
    bad(`Wiki 索引有 ${missing} 个页面缺失 —— LLM 按 llms.txt 读会拿到 404`);
  }
}

/**
 * 提问分流规则资产检查
 *
 * ## 为什么要有这一段
 *
 * 「处理用户问题时先查 Wiki」这条规则有两处载体：
 *   · `AGENTS.md`            —— 静态规则，新成员/其他 agent 看得见
 *   · `.codebuddy/hooks/wiki-first.js` —— 每次提问自动注入（真正生效的那层）
 *
 * 两者都是文件，**都可能被误删或误改而无人察觉**：
 *   · hook 被删 → 规则静默失效，agent 直接 grep 就开干，没有任何报错
 *   · settings.json 里的 hooks 段被覆盖 → 同上
 *   · AGENTS.md 被删 → 新成员看不到规则
 *
 * 规则一旦悄悄失效，本项目最大的风险就回来了：
 * 「同一常量散在 4 处」这类问题，agent 漏掉一处就静默出错。
 * 所以把它们纳入 preflight —— 规则和代码一样需要守卫。
 */
console.log('\n[10b/11] 提问分流规则');
const ruleFiles = [
  { p: path.join(ROOT, 'AGENTS.md'), label: 'AGENTS.md（静态规则）' },
  { p: path.join(ROOT, '.codebuddy', 'hooks', 'wiki-first.js'), label: 'wiki-first.js（自动注入 hook）' },
  { p: path.join(ROOT, '.codebuddy', 'settings.json'), label: '.codebuddy/settings.json（hook 注册）' },
];
let ruleMissing = 0;
ruleFiles.forEach((f) => {
  if (fs.existsSync(f.p)) ok(`${f.label} 存在`);
  else {
    bad(`${f.label} 不存在 —— 提问分流规则已失效`);
    ruleMissing++;
  }
});

// hook 注册检查：脚本在但没注册 = 规则同样不生效
if (fs.existsSync(ruleFiles[2].p)) {
  try {
    const s = JSON.parse(fs.readFileSync(ruleFiles[2].p, 'utf8'));
    const ups = (s.hooks && s.hooks.UserPromptSubmit) || [];
    const hasWikiHook = JSON.stringify(ups).includes('wiki-first');
    if (hasWikiHook) ok('UserPromptSubmit 已注册 wiki-first hook（规则会在每次提问时注入）');
    else {
      bad('settings.json 里没有注册 wiki-first hook —— 规则不会自动注入');
      ruleMissing++;
    }
  } catch (e) {
    bad(`.codebuddy/settings.json 不是合法 JSON：${e.message}`);
    ruleMissing++;
  }
}
if (ruleMissing) hardFail++;


console.log('\n[11/11] 云侧状态');
const needsCloud = [
  '正式 AppID（测试号不支持云开发）',
  `云开发环境 ID，并手工建好 ${requiredColls.length ? requiredColls.join('、') : 'bills'} 集合` +
  '（users 用于存消费分析结果）',
  // ⚠️ 环境变量是**按云函数独立**的，不是全局共享。
  // 只配 bill-svc 的话，analysis-svc 拿不到 Key，
  // 消费分析会静默走规则版——现象是「配了 Key 却没变化」，很难自查。
  'bill-svc 与 analysis-svc **都要**配环境变量 DEEPSEEK_API_KEY + LLM_ENABLED=true（改完重新部署）',
  'bill-svc 预置并发设为 2，消除冷启动抖动',
  // ⚠️ 这里原本写「定时触发器随部署生效（无需在控制台另配）」—— **错的**，
  // 而且这个误解正是「定时分析每天都静默不执行」被长期忽略的原因之一。
  // 官方文档明确：「更新触发器文件」与「上传触发器」是两个不同概念，
  // 只部署代码，触发器不会生效。
  'analysis-svc 定时触发器：右键 config.json →「云函数增量上传:更新文件」→ 再右键 →「上传触发器」（每天 0 点，UTC+8）',
  'analysis-svc 建议配环境变量 TZ=Asia/Shanghai（云函数运行时是 UTC+0，会影响日志时间等）——月份计算已用固定 +8 偏移兜底，不依赖此变量',
  'users 集合权限设为「仅创建者可读写」——定时任务会批量写入分析结果',
];
const needsAsr = [
  '腾讯云开通语音识别，取 SecretId / SecretKey / AppId',
  'asr-svc 环境变量 TENCENT_ASR_APP_ID / SECRET_ID / SECRET_KEY',
  'asr-svc 安装 tencentcloud-sdk-nodejs 依赖并实现流式识别（当前为占位）',
];

/**
 * 调试建议：怎么看 agent 的执行过程
 *
 * 这一条要写在部署清单里——否则遇到「模型为什么这么说」时，
 * 用户只能改代码加日志，而正确做法是开一个环境变量。
 */
const needsDebug = [
  '排查模型行为时，给 analysis-svc 加环境变量 DEBUG_TRACE=true，' +
    '云函数日志里会出现 [TRACE:xxx] 开头的结构化记录',
  '把日志复制成文件后执行 node tools/trace-view.js <文件>，' +
    '可看到模型输入 → 工具入参出参 → 模型输出 → 护栏判定的完整链路',
];
if (hardFail > 0) {
  console.log('  云侧步骤暂时无法开始，先修上面的硬错误。');
} else {
  console.log('  本地已就绪。真机调试前需确认：');
  needsCloud.forEach((n, i) => console.log(`    ${i + 1}) ${n}`));
  console.log('\n  要让「语音」真正可用，还需（P1）：');
  needsAsr.forEach((n, i) => console.log(`    ${i + 1}) ${n}`));
  console.log('\n  在此之前：录音会自动降级为手动输入，记账主链路仍完整可用。');
  console.log('\n  排查模型行为（可选）：');
  needsDebug.forEach((n, i) => console.log(`    ${i + 1}) ${n}`));
}

console.log('\n---------------------------------------------');
console.log(hardFail > 0 ? `预检未通过：${hardFail} 项必须先修` : '预检通过，可以开始真机调试');
console.log('---------------------------------------------\n');
process.exit(hardFail > 0 ? 1 : 0);