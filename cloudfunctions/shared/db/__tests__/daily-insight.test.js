/**
 * 定时批量分析的测试
 *
 * ## 为什么要单独测
 *
 * 定时触发器和用户点击是**两条完全不同的调用路径**，而定时那条更难测：
 *   · 运行时**没有用户上下文**（getWXContext().OPENID 为空）
 *   · 只有 40 秒，却要处理「所有待更新用户」
 *   · 单个用户失败不能影响其他人
 *
 * 这些约束一旦破，表现都是「定时任务安静地什么都没做」——
 * 没有报错、没有日志，用户只会觉得功能坏了。
 */

const assert = require('assert');

let passed = 0;
let failed = 0;

/**
 * 捕获未处理的 Promise 拒绝
 *
 * ## 为什么必须加这道防线
 *
 * `test()` 忘记 `await` 时，断言失败会变成**未捕获的 Promise 拒绝**。
 * 而 **Node 默认对 unhandledRejection 只打印警告、不退出** → `exit 0`。
 *
 * 也就是说：**一个「所有断言都没跑」的测试文件，可以安安静静地全绿通过。**
 * 这不是理论风险 —— 2026-10-31 实测：
 * 加了 5 个 async 断言，其中 3 个真的失败，日志里有红字，
 * 但结尾仍打印「7 通过 / 0 失败」并 `exit 0`。
 * 「定时触发器进不了 dailyInsight」这个 bug 就这样长期藏着。
 *
 * 有了这行，任何漏网的拒绝都会让进程 `exit 1` → CI 立刻红。
 */
process.on('unhandledRejection', (reason) => {
  failed++;
  // ⚠️ 必须**直接**设 exitCode —— 不能只 `failed++`。
  // 因为 `main()` 末尾已经设过 `process.exitCode = 0`，
  // 之后再改 failed 计数不会影响已定的退出码 → 缺陷被吞。
  process.exitCode = 1;
  console.error('  ✗ 未处理的 Promise 拒绝（很可能是某个 async 测试漏了 await）');
  console.error(`    ${reason && reason.message ? reason.message : reason}`);
});

/**
 * 测试包装器
 *
 * ⚠️ 这里**必须 await**。
 *
 * 原来的实现是同步的 `try { fn(); } catch {}` ——
 * 对 `async` 函数来说，`fn()` 返回的是 Promise，**不会同步抛错**，
 * 于是断言失败变成一个**未捕获的 Promise 拒绝**，
 * `try/catch` 根本抓不到 → **测试全部「通过」，实际一条都没断言**。
 *
 * → **「所有检查都通过」不等于「检查是对的」。**
 * 守卫本身也要能被验证（见 tools/__tests__/_probe-guard.js 的注入验证）。
 */
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${e && e.message ? e.message : e}`);
  }
}

/* ── 可注入的 mock 环境 ── */

// SRC 控制 getWXContext 返回什么，用来模拟「定时触发无上下文」
let SRC = 'wx_trigger';
const BILL_ROWS = [];
const USER_DOCS = [];

const notFound = () => {
  const e = new Error('document not exist');
  e.errMsg = 'document.get:fail -502005 document not exist';
  throw e;
};

/**
 * mock 集合
 *
 * ## ⚠️ 这里必须真的执行过滤条件
 *
 * 原来的 mock 是 `where() { return { limit(){...}, async get(){ return {data: USER_DOCS.slice()} } } }`
 * —— **完全无视 where 条件**，无条件返回全部文档。
 *
 * 后果：「跨月结果不算本月已分析」这条断言**永远不成立**
 * （9 月的结果也被当成 10 月的），但因为 `test()` 当时没 await，
 * 失败被吞掉 → 报「全部通过」。
 *
 * 真实云开发里 `where({month})` 只会返回该月文档。
 * mock 必须忠实还原这个语义，否则测的是 mock 而不是代码。
 */
const userCol = {
  async get() { notFound(); },
  where(cond) {
    const matched = USER_DOCS.filter((x) =>
      Object.keys(cond || {}).every((k) => x[k] === cond[k])
    );
    return {
      limit() { return this; },
      async get() { return { data: matched.slice() }; }
    };
  },
  doc(id) {
    return {
      async get() {
        const d = USER_DOCS.find((x) => x._id === id);
        if (!d) notFound();
        return { data: d };
      },
      async set({ data }) {
        const i = USER_DOCS.findIndex((x) => x._id === id);
        const doc = { _id: id, ...data };
        if (i >= 0) USER_DOCS[i] = doc; else USER_DOCS.push(doc);
        return {};
      }
    };
  }
};

/**
 * 账单集合 mock
 *
 * ⚠️ 同上：`where({date: gte(..).and(lte(..))})` 的日期区间条件必须真的生效，
 * 否则「某月没账单」这类断言全部失真。
 *
 * 生产的 date 条件是 `db.command.gte(x).and(db.command.lte(y))` ——
 * 这里还原成 {min,max} 便于比较。
 */
const billCol = {
  _cond: null,
  where(cond) { this._cond = cond; return this; },
  skip() { return this; },
  limit() { return this; },
  orderBy() { return this; },
  async get() {
    const cond = this._cond;
    let rows = BILL_ROWS.slice();
    if (cond) {
      // delFlag 是软删除标记（撤销时置 true）。
      // 字段缺失视为未删除 —— 真实账单写入时都会带上 delFlag:false。
      if (cond.delFlag === false) rows = rows.filter((b) => !b.delFlag);
      if (cond.date) {
        const { min, max } = cond.date;
        rows = rows.filter((b) => b.date >= min && b.date <= max);
      }
    }
    return { data: rows };
  }
};

const sdk = require('../sdk');
sdk.__injectSdk({
  database: () => ({
    collection: (name) => (name === 'users' ? userCol : billCol),
    // 日期区间：生产代码用 `gte(x).and(lte(y))` 链式表达，
    // 这里还原成 {min,max} 便于 mock 比较。
    // ⚠️ 之前这里返回 `{}`（空对象），导致 mock 完全无法过滤日期 ——
    // 「某月没账单」这类断言根本不可能成立。
    command: {
      gte: (v) => ({
        __op: 'gte', value: v,
        and(other) { return { min: v, max: other && other.value }; }
      }),
      lte: (v) => ({ __op: 'lte', value: v })
    }
  }),
  // SOURCE === 'wx_trigger' 是官方给出的定时触发标识
  getWXContext: () => ({ SOURCE: SRC, ENV: 'test', OPENID: SRC === 'wx_trigger' ? '' : 'u_me' })
});

const db = require('../index');
const svc = require('../../../analysis-svc/index.js');

delete process.env.DEEPSEEK_API_KEY;

/**
 * 是否放开 targetOpenid 校验
 *
 * ## 为什么改成「按场景开关」而不是全程 true
 *
 * 原来这里是 `process.env.INSIGHT_ALLOW_TARGET_OPENID = 'true'`（全程开着）。
 * 那个开关会让 `isTriggerSource()` **恒返回 true** → 绕过防越权校验 →
 * 「外部调用不允许指定 targetOpenid」这条断言**永远不成立**。
 *
 * 但因为 `test()` 当时是同步的、没 await，async 断言的失败被当成
 * 未捕获的 Promise 拒绝 → **catch 抓不到 → 报「全部通过」**。
 * 也就是说这条防越权测试**从来没真正跑过**，坏了一年也没人发现。
 *
 * 现在 `test()` 会 await（见上方注释），失败能被抓到了，
 * 于是必须把这个开关改成按场景精确控制：
 *   · 测「定时触发内部调度」→ 开
 *   · 测「外部越权」→ 关（这样才能验证 SOURCE 校验真的生效）
 */
let allowTargetOpenid = true;

/** 设置 targetOpenid 开关，并在测试结束后恢复 */
function withAllowTarget(flag, fn) {
  const prev = allowTargetOpenid;
  allowTargetOpenid = flag;
  if (flag) process.env.INSIGHT_ALLOW_TARGET_OPENID = 'true';
  else delete process.env.INSIGHT_ALLOW_TARGET_OPENID;
  try {
    return fn();
  } finally {
    allowTargetOpenid = prev;
    if (prev) process.env.INSIGHT_ALLOW_TARGET_OPENID = 'true';
    else delete process.env.INSIGHT_ALLOW_TARGET_OPENID;
  }
}

/**
 * 造一个用户当月的账单
 *
 * @param {string} openid
 * @param {number} count 笔数
 * @param {number} lastWrite 最后一次写入时间
 * @param {string} date 账单日期（默认 2026-10-05）
 *   ⚠️ 定时任务按**触发时刻的东八区月份**查账单，
 *   测跨月场景时必须能指定日期，否则造的数据月份对不上 → 查不到人。
 */
function seedUser(openid, count, lastWrite, date = '2026-10-05') {
  for (let i = 0; i < count; i++) {
    BILL_ROWS.push({
      userId: openid,
      amount: 10000 + i,
      date,
      categoryPath: '餐饮/在家吃饭/买菜',
      categoryId: 'c1_1_1',
      createTime: lastWrite || 1000
    });
  }
}

function reset() {
  BILL_ROWS.length = 0;
  USER_DOCS.length = 0;
  SRC = 'wx_trigger';
}

/**
 * 构造一个定时触发器 event
 *
 * ⚠️ 为什么要固定 `Time`：
 * `dailyInsight` 的月份来自**触发时刻**（东八区）。
 * 若用 `new Date()`（函数执行时刻），月份会随「什么时候跑测试」漂移 ——
 * 今天跑是 11 月、明天跑是 12 月 → 造的账单月份对不上 → 断言时好时坏。
 * 固定 `Time` 让月份恒定，测试才可复现。
 *
 * @param {string} isoTime 触发时刻（ISO 字符串，UTC）
 * @param {object} extra 额外字段（如 payload，用于测防注入）
 */
function timerEvent(isoTime, extra = {}) {
  return { Type: 'Timer', TriggerName: 'dailyInsight', Time: isoTime, Message: '', ...extra };
}

/** 固定在 2026-10 内的触发时刻（东八区仍是 10 月） */
const TIMER_OCT = '2026-10-15T04:00:00Z';   // → 东八区 10-15 12:00
/** 固定在月初边界的触发时刻（东八区是 11 月，UTC 是 10 月） */
const TIMER_NOV_BOUNDARY = '2026-10-31T16:00:00Z'; // → 东八区 11-01 00:00

async function main() {
  console.log('\n【定时触发的身份校验】');

  await test('定时触发无 openid 时，refreshInsight 明确报错而非静默', async () => {
    reset();
    seedUser('u1', 2);
    const r = await svc.main({ action: 'refreshInsight' }, {});
    assert.strictEqual(r.ok, false);
    assert.ok(/定时触发/.test(r.error), `错误信息应点明定时触发: ${r.error}`);
  });

  await test('外部调用不允许指定 targetOpenid（防越权）', async () => {
    reset();
    seedUser('u1', 2);
    SRC = 'wx_client';// 模拟用户主动调用
    // ⚠️ 必须**关掉** INSIGHT_ALLOW_TARGET_OPENID，
    // 否则 isTriggerSource() 恒为 true，这条断言永远不成立。
    await withAllowTarget(false, async () => {
      const r = await svc.main(
        { action: 'refreshInsight', payload: { targetOpenid: 'someone_else' } }, {}
      );
      assert.strictEqual(r.ok, false, '外部指定 openid 必须被拒绝');
      assert.ok(/不允许指定/.test(r.error), `错误信息应说明不允许指定，实际：${r.error}`);
    });
  });

  console.log('\n【待分析用户筛选】');

  await test('从未分析过的用户会被捞出', async () => {
    reset();
    seedUser('u1', 3, 1000);
    seedUser('u2', 2, 1000);
    const r = await db.listPendingInsightUsers('2026-10', {});
    assert.strictEqual(r.users.length, 2, '两个都没分析过，都该被捞出');
    assert.strictEqual(r.totalCandidates, 2);
  });

  await test('分析后且无新账单的用户不再重复捞出', async () => {
    reset();
    seedUser('u1', 3, 1000);
    // generateTime 晚于最后一次记账 → 结果已是最新
    USER_DOCS.push({ _id: 'u1_insight', userId: 'u1', month: '2026-10', generateTime: 99999 });
    const r = await db.listPendingInsightUsers('2026-10', {});
    assert.strictEqual(r.users.length, 0, '没有新账单就不该重复烧额度');
  });

  await test('分析后又记了新账的用户会被重新捞出', async () => {
    reset();
    seedUser('u1', 3, 1000);
    USER_DOCS.push({ _id: 'u1_insight', userId: 'u1', month: '2026-10', generateTime: 2000 });
    // 最后一次写入在 5000，远晚于 generateTime
    seedUser('u1', 1, 5000);
    const r = await db.listPendingInsightUsers('2026-10', {});
    assert.strictEqual(r.users.length, 1, '有新账单就该重算');
  });

  await test('跨月结果不算本月已分析', async () => {
    reset();
    seedUser('u1', 3, 1000);
    // 上个月的分析结果，与本月无关
    USER_DOCS.push({ _id: 'u1_insight', userId: 'u1', month: '2026-09', generateTime: 99999 });
    const r = await db.listPendingInsightUsers('2026-10', {});
    assert.strictEqual(r.users.length, 1, '上个月的结果不能顶替本月');
  });

  await test('无账单用户不参与分析', async () => {
    reset();
    seedUser('u1', 2, 1000);
    const r = await db.listPendingInsightUsers('2026-11', {});
    assert.strictEqual(r.users.length, 0, '该月没账单就不该分析');
  });

  console.log('\n【分页稳定性】');

  await test('分页不会漏用户也不重复', async () => {
    reset();
    for (let i = 0; i < 7; i++) seedUser(`u${i}`, 1, 1000);
    const p1 = await db.listPendingInsightUsers('2026-10', { limit: 3, cursor: 0 });
    const p2 = await db.listPendingInsightUsers('2026-10', { limit: 3, cursor: p1.nextCursor });
    const p3 = await db.listPendingInsightUsers('2026-10', { limit: 3, cursor: p2.nextCursor });
    const all = [...p1.users, ...p2.users, ...p3.users];
    assert.strictEqual(new Set(all).size, 7, `分页应覆盖全部 7 人且不重复，实得 ${all.length}`);
  });

  console.log('\n【批量执行】');

  await test('批量分析为每个用户落库', async () => {
    reset();
    seedUser('u1', 3, 1000, '2026-10-05');
    seedUser('u2', 3, 1000, '2026-10-05');
    const r = await svc.main(timerEvent(TIMER_OCT), {});
    assert.strictEqual(r.ok, true);
    assert.ok(r.data.processed >= 1, '至少应处理一个用户');
    assert.ok(USER_DOCS.length >= 1, '应产生分析结果文档');
    // 日志里的 openid 必须脱敏
    for (const d of r.data.details || []) {
      assert.ok(!d.openid.includes('u1') || d.openid.includes('***'),
        `日志中的 openid 未脱敏: ${d.openid}`);
    }
  });

  await test('没有待分析用户时安静跳过，不报错', async () => {
    reset();
    // ⚠️ 用 Timer event 并显式指定触发时刻 → 月份确定（2026-10），
    // 否则走 `Date.now()` 会随运行时刻漂移（今天已是 11 月，
    // 造的 10 月账单就查不到了 → 变成「查不到人」而不是「不需要分析」，
    // 测的就不是同一件事了）。
    seedUser('u1', 2, 1000, '2026-10-05');
    USER_DOCS.push({ _id: 'u1_insight', userId: 'u1', month: '2026-10', generateTime: 99999 });
    const r = await svc.main(timerEvent(TIMER_OCT), {});
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.data.month, '2026-10', '月份应来自触发时刻');
    assert.strictEqual(r.data.processed, 0, '结果已是最新，不该重复分析');
  });

  await test('LLM 关闭时整批跳过', async () => {
    reset();
    seedUser('u1', 3, 1000, '2026-10-05');
    process.env.LLM_ENABLED = 'false';
    const r = await svc.main(timerEvent(TIMER_OCT), {});
    delete process.env.LLM_ENABLED;
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.data.skipped, true, '必须明确标记跳过而非静默');
  });

  await test('单个用户失败不影响其他人', async () => {
    reset();
    seedUser('u1', 3, 1000, '2026-10-05');
    seedUser('u2', 3, 1000, '2026-10-05');
    // 让 u1 的用户文档写入抛错，验证 u2 仍被处理
    const origSet = userCol.doc.bind(userCol);
    userCol.doc = (id) => {
      const d = origSet(id);
      if (!String(id).startsWith('u1')) return d;
      return { ...d, set: async () => { throw new Error('模拟写入失败'); } };
    };
    const r = await svc.main(timerEvent(TIMER_OCT), {});
    userCol.doc = origSet;

    assert.strictEqual(r.ok, true, '整体不应因单个用户失败而失败');
    assert.ok(r.data.skipped + r.data.processed >= 1);
  });

  console.log('\n【官方定时触发器事件结构】');

  // ⚠️ 这一段是 2026-10-31 补的 —— 之前**所有**测试都手工构造
  // `{action:'dailyInsight'}`，完全绕过了「平台怎么下发 event」这一层，
  // 于是「定时触发器进不了 dailyInsight」这个 bug 全绿通过。
  //
  // 官方 event 结构（腾讯云 SCF / 微信云开发 定时触发器）：
  //   { Type:'Timer', TriggerName:'dailyInsight', Time:'...', Message:'' }
  // **没有 action 字段。**

  await test('官方 Timer event 能进 dailyInsight 并落库', async () => {
    reset();
    // 触发时刻 2026-10-31T16:00:00Z → 东八区 2026-11-01 00:00
    // → 分析的是 11 月 → 账单也必须是 11 月的
    seedUser('u_timer', 3, 1000, '2026-11-03');
    const r = await svc.main(
      timerEvent(TIMER_NOV_BOUNDARY),
      {}
    );
    assert.strictEqual(r.ok, true, `定时触发应成功，实际：${r.error}`);
    assert.ok(r.data && typeof r.data.processed === 'number', '应返回批量执行结果');
    assert.ok(r.data.processed >= 1, `至少应处理一个用户，实际 processed=${r.data.processed}`);
    assert.ok(USER_DOCS.length >= 1, '应产生分析结果文档');
  });

  await test('Timer event 的月份按东八区算（月初不落到上月）', async () => {
    reset();
    // 2026-11-01 00:00 (UTC+8) == 2026-10-31 16:00 (UTC)
    // 云端运行时是 UTC+0 → 那一刻 UTC 日期是 10-31
    // 若用本地时区 toMonthStr，会得到 '2026-10'（错），必须得到 '2026-11'
    seedUser('u_tz', 3, 1000, '2026-11-03');
    const r = await svc.main(
      timerEvent(TIMER_NOV_BOUNDARY),
      {}
    );
    assert.strictEqual(r.ok, true, `定时触发应成功，实际：${r.error}`);
    assert.strictEqual(r.data.month, '2026-11',
      `定时任务应按东八区算月份，实际 ${r.data.month}（云端 UTC+0 会退到上月）`);
    assert.ok(r.data.processed >= 1,
      `11 月的账单应被捞出，实际 processed=${r.data.processed}`);
  });

  await test('东八区口径在月初边界与 UTC 口径不同（证明修复真的生效）', async () => {
    reset();
    // 这个用例是**反向对照**：证明上两条不是碰巧过的。
    //
    // ⚠️ 关键盲区：本地开发机时区就是 Asia/Shanghai（UTC+8），
    // 所以「退回本地时区」在本地**恰好等价于正确的东八区** → 测不出来！
    //
    // 正确的做法：**直接验证东八区口径函数本身**，
    // 用一个「UTC 与东八区必然不同」的边界时刻做对照。
    // 2026-10-31T16:00:00Z：UTC 是 10-31，东八区是 11-01。
    const dateUtil = require('../../util/date');
    const triggeredAt = Date.parse('2026-10-31T16:00:00Z');

    // ① 东八区口径：必须是 11 月（这正是修复的目标）
    assert.strictEqual(dateUtil.toMonthStrCST(triggeredAt), '2026-11',
      '东八区口径应得到 11 月');

    // ② 同一时刻用「固定 UTC 偏移」算，必须是 10 月 —— 证明两者确实不同
    //    （不依赖进程本地时区，因此在任何机器上结论一致）
    const utcMonth = new Date(triggeredAt).toISOString().slice(0, 7);
    assert.strictEqual(utcMonth, '2026-10', 'UTC 口径应是 10 月');
    assert.notStrictEqual(dateUtil.toMonthStrCST(triggeredAt), utcMonth,
      '两个时区口径在月初边界必须不同 —— 若相同说明东八区偏移没生效');

    // ③ 顺带验证日期口径也一致
    assert.strictEqual(dateUtil.toDateStrCST(triggeredAt), '2026-11-01',
      '东八区日期应为 11-01');
  });

  await test('dailyInsight 真的用了东八区口径（测调用点，不只是测函数）', async () => {
    reset();
    // ⚠️ 上一条只测了 `toMonthStrCST` **函数本身**，
    // 注入 bug「调用点改成 toMonthStr」时它照样通过 —— 漏网。
    // 这条直接测**调用点**：跑真实的 dailyInsight，看它算出的月份。
    //
    // 关键：触发时刻选在「UTC 与东八区必然分属不同月」的边界，
    // 且账单也放在东八区那个月 —— 于是
    //   · 用东八区口径 → 捞得到人，month='2026-11'
    //   · 用本地(UTC)口径 → month='2026-10'，捞不到 11 月账单 → processed=0
    // 两种口径的**可观测结果完全不同**，不会像纯函数断言那样漏网。
    seedUser('u_call', 3, 1000, '2026-11-03');
    const r = await svc.main(timerEvent(TIMER_NOV_BOUNDARY), {});
    assert.strictEqual(r.ok, true, `定时触发应成功，实际：${r.error}`);
    assert.strictEqual(r.data.month, '2026-11',
      `dailyInsight 应用东八区口径，实际 ${r.data.month}`);
    assert.ok(r.data.processed >= 1,
      `11 月账单应被捞出（若用 UTC 口径就查不到），实际 processed=${r.data.processed}`);
  });

  await test('未知的 Timer 触发器名不被当成 dailyInsight', async () => {
    reset();
    seedUser('u_x', 3, 1000);
    const r = await svc.main(
      { Type: 'Timer', TriggerName: 'someOtherTrigger', Time: '2026-10-31T16:00:00Z', Message: '' },
      {}
    );
    assert.strictEqual(r.ok, false, '未知触发器名必须拒绝，不能误跑批量任务');
    assert.ok(/未知操作/.test(r.error), `错误信息应说明未知操作，实际：${r.error}`);
    assert.strictEqual(USER_DOCS.length, 0, '未知触发器不应写入任何数据');
  });

  await test('普通调用不受 Timer 归一影响', async () => {
    reset();
    seedUser('u_normal', 2, 1000);
    // SRC 必须是 wx_client —— wx_trigger 下 OPENID 为空（定时触发无用户上下文），
    // monthSummary 取不到身份会直接报错，那测的就不是「归一没影响」了。
    SRC = 'wx_client';
    const r = await svc.main({ action: 'monthSummary' }, {});
    assert.strictEqual(r.ok, true, `普通 action 应正常，实际：${r.error}`);
  });

  await test('Timer event 的 payload 不被透传（防外部注入 cursor/month）', async () => {
    reset();
    seedUser('u_inject', 3, 1000, '2026-11-03');
    const r = await svc.main(
      {
        ...timerEvent(TIMER_NOV_BOUNDARY),
        payload: { month: '1999-01', cursor: 999 }
      },
      {}
    );
    assert.strictEqual(r.ok, true, `定时触发应成功，实际：${r.error}`);
    assert.notStrictEqual(r.data.month, '1999-01', '外部构造的 month 不应生效');
    assert.strictEqual(r.data.month, '2026-11', '月份应来自触发时刻，而非外部 payload');
  });

  console.log(`\n${failed === 0 ? '✓ 全部通过' : '✗ 有失败'}：${passed} 通过 / ${failed} 失败\n`);

  // ⚠️ 用 `process.exitCode` 而不是 `process.exit()`。
  //
  // `process.exit()` 是**立即**终止进程 —— 尚未处理的 Promise 拒绝
  // （比如某个 async 测试漏了 await）根本没机会触发 → 缺陷被吞掉。
  //
  // `process.exitCode` 只是设置退出码，让事件循环自然跑完 ——
  // 这样 unhandledRejection 监听器才有机会把它记成失败。
  //
  // 实测（2026-10-31）：改成 exitCode 后，
  // 「test() 忘记 await」这个缺陷会让退出码变成 1 → CI 立刻红。
  process.exitCode = failed === 0 ? 0 : 1;
}

/**
 * ⚠️ **必须在 TZ=UTC 下也跑一遍**
 *
 * 云函数运行时时区是 **UTC+0**，而本地开发机是 **Asia/Shanghai（UTC+8）**。
 * 这 8 小时差会**掩盖时区相关的 bug**：
 * 「退回本地时区」这种错误在本地恰好等价于正确的东八区 → 测试全绿 → 上云就错。
 *
 * 所以本文件在 UTC 下也必须全绿 ——
 * `npm test` 里加一条 `TZ=UTC` 的运行（见 package.json）。
 */
main();