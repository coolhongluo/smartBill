#!/usr/bin/env node
/**
 * 重复记账规则：CRUD 校验 + dailyRecurring 生成流程（内存数据库模拟云开发）
 *
 * 覆盖三条最容易「静默出错」的链路：
 *   1. 规则校验与 manual/amend 同口径（金额上限/类目成对/备注长度）
 *   2. 调度生成：到期生成 / 暂停跳过 / 漏跑不补记 / 同日幂等
 *   3. 安全边界：非触发器来源调用 dailyRecurring 一律拒绝；
 *      触发器下账单 userId 来自规则文档，不是（空的）openid
 *
 * 运行：node tools/__tests__/recurring-rule.test.js
 */

const path = require('path');

// ── 内存数据库（模拟云开发，含 update） ─────────────────────
const DB = { collections: {}, DEFAULT_PAGE: 20, MAX_PAGE: 100 };

function matches(row, cond) {
  for (const [k, v] of Object.entries(cond)) {
    if (v && typeof v === 'object' && v.__and) {
      const sub = v.__and.every((c) => {
        const val = row[k];
        if (c.__cmd === 'gte') return val >= c.v;
        if (c.__cmd === 'lte') return val <= c.v;
        if (c.__cmd === 'gt') return val > c.v;
        if (c.__cmd === 'lt') return val < c.v;
        return true;
      });
      if (!sub) return false;
    } else if (v && typeof v === 'object' && v.__cmd) {
      const val = row[k];
      if (v.__cmd === 'gte' && !(val >= v.v)) return false;
      if (v.__cmd === 'lte' && !(val <= v.v)) return false;
    } else if (row[k] !== v) {
      return false;
    }
  }
  return true;
}

function makeCollection(name) {
  if (!DB.collections[name]) DB.collections[name] = [];
  const rows = DB.collections[name];

  return {
    _rows: rows,
    async add({ data }) {
      const _id = 'mock_' + (rows.length + 1) + '_' + Date.now();
      rows.push({ ...data, _id });
      return { _id };
    },
    where(cond) {
      return {
        orderBy() { return this; },
        skip(n) { this._skip = n; return this; },
        limit(n) { this._limit = Math.min(n || DB.DEFAULT_PAGE, DB.MAX_PAGE); return this; },
        async get() {
          let data = rows.filter((r) => matches(r, cond));
          const skip = this._skip || 0;
          const limit = this._limit || DB.DEFAULT_PAGE;
          data = data.slice(skip, skip + limit);
          return { data: data.map((r) => ({ ...r })) };
        },
        async update({ data }) {
          let updated = 0;
          rows.forEach((r, i) => {
            if (matches(r, cond)) {
              rows[i] = { ...r, ...data };
              updated++;
            }
          });
          return { stats: { updated } };
        }
      };
    },
    limit(n) {
      return {
        async get() { return { data: rows.slice(0, n || DB.DEFAULT_PAGE) }; }
      };
    },
    doc(id) {
      return {
        async get() {
          const row = rows.find((r) => r._id === id);
          if (!row) {
            const e = new Error('document not exist');
            e.errMsg = 'document.get:fail -502005 document not exist';
            throw e;
          }
          return { data: { ...row } };
        },
        async set({ data }) {
          const idx = rows.findIndex((r) => r._id === id);
          if (idx >= 0) rows[idx] = { ...rows[idx], ...data, _id: id };
          else rows.push({ _id: id, ...data });
          return {};
        },
        async update({ data }) {
          const idx = rows.findIndex((r) => r._id === id);
          if (idx < 0) throw new Error('document not exist');
          rows[idx] = { ...rows[idx], ...data, _id: id };
          return { stats: { updated: 1 } };
        }
      };
    }
  };
}

function makeCommand() {
  const cmd = (op) => (v) => {
    const node = {
      __cmd: op,
      v,
      and(other) {
        return { __and: [node, other] };
      }
    };
    return node;
  };
  return { gte: cmd('gte'), lte: cmd('lte'), lt: cmd('lt'), gt: cmd('gt') };
}

// ── 注入假 wx-server-sdk（globalThis 共享，跨 shared 副本生效） ──
const MOCK_OPENID = 'o_mock_user_001';
let mockSource = undefined; // 模拟 getWXContext().SOURCE（默认无）
const mockSdk = {
  database: () => ({
    collection: (name) => makeCollection(name),
    command: makeCommand()
  }),
  getWXContext: () => ({ OPENID: MOCK_OPENID, ENV: 'mock-env', SOURCE: mockSource })
};
require(path.join(__dirname, '..', '..', 'cloudfunctions', 'shared', 'db', 'sdk.js'))
  .__injectSdk(mockSdk);

// ── 加载被测模块（必须在注入 sdk 之后） ─────────────────────
const db = require(path.join(__dirname, '..', '..', 'cloudfunctions', 'shared', 'db', 'index.js'));
const billSvc = require(path.join(__dirname, '..', '..', 'cloudfunctions', 'bill-svc', 'index.js'));

process.env.LLM_ENABLED = process.env.LLM_ENABLED || 'false';

let passed = 0;
let failed = 0;
const tests = [];
function test(name, fn) {
  tests.push([name, fn]);
}
function section(title) {
  tests.push([null, title]);
}

async function run() {
  section('【1】ruleCreate 校验（与 manual/amend 同口径）');

  test('非法金额被拒绝', async () => {
    const cases = [
      { amountCent: 0 }, { amountCent: -5 }, { amountCent: 1.5 },
      { amountCent: '100' }, { amountCent: 50001 * 100 }
    ];
    for (const extra of cases) {
      const res = await billSvc.main({
        action: 'ruleCreate',
        payload: { amountCent: extra.amountCent, categoryId: 'c1_1_1', categoryPath: '餐饮/在家吃饭/买菜', repeat: { type: 'daily' } }
      }, {});
      if (res.ok) throw new Error(`金额 ${extra.amountCent} 应被拒绝`);
    }
  });

  test('缺类目 / path 无法确定被拒绝', async () => {
    const r1 = await billSvc.main({
      action: 'ruleCreate',
      payload: { amountCent: 400, repeat: { type: 'daily' } }
    }, {});
    if (r1.ok) throw new Error('缺类目应被拒绝');

    // 预置库查不到 + 前端 path 为空 → 完全无法确定 path → 拒绝
    const r2 = await billSvc.main({
      action: 'ruleCreate',
      payload: { amountCent: 400, categoryId: 'no_such_cat', categoryPath: '', repeat: { type: 'daily' } }
    }, {});
    if (r2.ok) throw new Error('path 无法确定应被拒绝');
  });

  test('非法 repeat 参数被拒绝', async () => {
    const bad = [
      { type: 'hourly' },
      { type: 'weekly' },            // 缺 dayOfWeek
      { type: 'weekly', dayOfWeek: 8 },
      { type: 'monthly' },           // 缺 dayOfMonth
      { type: 'monthly', dayOfMonth: 0 }
    ];
    for (const repeat of bad) {
      const res = await billSvc.main({
        action: 'ruleCreate',
        payload: { amountCent: 400, categoryId: 'c1_1_1', categoryPath: '餐饮/在家吃饭/买菜', repeat }
      }, {});
      if (res.ok) throw new Error(`repeat=${JSON.stringify(repeat)} 应被拒绝`);
    }
    // 「该月永远不存在这一天」的组合直接拒绝：2/30 在任何年份都无法触发
    const never = await billSvc.main({
      action: 'ruleCreate',
      payload: { amountCent: 400, categoryId: 'c1_1_1', categoryPath: '餐饮/在家吃饭/买菜', repeat: { type: 'yearly', month: 2, dayOfMonth: 30 } }
    }, {});
    if (never.ok) throw new Error('yearly 2/30 永远无法触发，应被拒绝');
    // 2/29 合法：平年跳过、闰年命中
    const ok = await billSvc.main({
      action: 'ruleCreate',
      payload: { amountCent: 400, categoryId: 'c1_1_1', categoryPath: '餐饮/在家吃饭/买菜', repeat: { type: 'yearly', month: 2, dayOfMonth: 29 } }
    }, {});
    if (!ok.ok) throw new Error('yearly 2/29 应合法');
  });

  test('合法规则落库，nextDate 是明天起的第一个匹配日', async () => {
    const res = await billSvc.main({
      action: 'ruleCreate',
      payload: { amountCent: 400, categoryId: 'c1_1_1', categoryPath: '餐饮/在家吃饭/买菜', note: '通勤地铁', repeat: { type: 'weekday' } }
    }, {});
    if (!res.ok || !res.saved) throw new Error(`创建失败：${JSON.stringify(res)}`);
    const now = Date.now();
    const { toDateStrCST } = require(path.join(__dirname, '..', '..', 'cloudfunctions', 'shared', 'util', 'date.js'));
    const { nextOccurrence } = require(path.join(__dirname, '..', '..', 'cloudfunctions', 'shared', 'util', 'recurring.js'));
    const expected = nextOccurrence('weekday', {}, toDateStrCST(now));
    if (res.rule.nextDate !== expected) throw new Error(`nextDate=${res.rule.nextDate} 应为 ${expected}`);
    if (res.rule.userId !== MOCK_OPENID) throw new Error('userId 应来自 getWXContext');
    if (res.rule.repeat.type !== 'weekday') throw new Error('repeat 未落库');
  });

  section('【2】ruleList / ruleUpdate / rulePause / ruleDelete');

  let ruleId = null;
  test('ruleList 能读回刚创建的规则', async () => {
    const res = await billSvc.main({ action: 'ruleList', payload: {} }, {});
    if (!res.ok || !Array.isArray(res.rules)) throw new Error('ruleList 失败');
    if (res.rules.length < 1) throw new Error('应至少有 1 条规则');
    ruleId = res.rules[res.rules.length - 1]._id;
  });

  test('ruleUpdate 改金额仅更新金额字段', async () => {
    const res = await billSvc.main({
      action: 'ruleUpdate',
      payload: { ruleId, amountCent: 500 }
    }, {});
    if (!res.ok || !res.saved) throw new Error(`更新失败：${JSON.stringify(res)}`);
    if (res.updates.amount !== 500) throw new Error('amount 应更新为 500');
    if (res.updates.nextDate !== undefined) throw new Error('未改 repeat 不应动 nextDate');
  });

  test('ruleUpdate 改 repeat 会重算 nextDate', async () => {
    const res = await billSvc.main({
      action: 'ruleUpdate',
      payload: { ruleId, repeat: { type: 'weekly', dayOfWeek: 1 } }
    }, {});
    if (!res.ok) throw new Error(`更新失败：${JSON.stringify(res)}`);
    if (res.updates.nextDate === undefined) throw new Error('改 repeat 应重算 nextDate');
    if (res.updates.repeat.type !== 'weekly') throw new Error('repeat 应更新');
  });

  test('rulePause 暂停 / 恢复', async () => {
    const p1 = await billSvc.main({ action: 'rulePause', payload: { ruleId, paused: true } }, {});
    if (!p1.ok || p1.updates.status !== 'paused') throw new Error('暂停失败');
    const p2 = await billSvc.main({ action: 'rulePause', payload: { ruleId, paused: false } }, {});
    if (!p2.ok || p2.updates.status !== 'active') throw new Error('恢复失败');
  });

  test('ruleDelete 软删除后列表不可见', async () => {
    const del = await billSvc.main({ action: 'ruleDelete', payload: { ruleId } }, {});
    if (!del.ok || !del.deleted) throw new Error('删除失败');
    const list = await billSvc.main({ action: 'ruleList', payload: {} }, {});
    if (list.rules.some((r) => r._id === ruleId)) throw new Error('已删除的规则不应出现在列表');
  });

  section('【3】dailyRecurring 生成流程（固定触发时刻 2026-11-02 00:30 CST）');

  // 清空历史数据，准备调度场景（直接落库规则，绕过「明天起」游标）
  const TODAY = '2026-11-02'; // 周一（CST）
  const TRIGGER_TS = Date.parse('2026-11-02T00:30:00+08:00');
  const OTHER_USER = 'o_other_user_888';

  DB.collections = {}; // 重置内存库

  // A：今天到期 → 应生成
  const ruleA = await db.insertRecurringRule({
    userId: OTHER_USER, amount: 400, categoryId: 'c1_1_1', categoryPath: '餐饮/在家吃饭/买菜',
    note: '通勤地铁', account: 'unknown', repeat: { type: 'daily' }, status: 'active', nextDate: TODAY
  });
  // B：昨天到期（漏跑）→ 不补记，游标前移
  const ruleB = await db.insertRecurringRule({
    userId: OTHER_USER, amount: 500, categoryId: 'c1_1_1', categoryPath: '餐饮/在家吃饭/买菜',
    note: '', account: 'unknown', repeat: { type: 'daily' }, status: 'active', nextDate: '2026-11-01'
  });
  // C：暂停 → 不生成
  const ruleC = await db.insertRecurringRule({
    userId: OTHER_USER, amount: 600, categoryId: 'c1_1_1', categoryPath: '餐饮/在家吃饭/买菜',
    note: '', account: 'unknown', repeat: { type: 'daily' }, status: 'paused', nextDate: TODAY
  });
  // D：今天到期但同规则同天已有账单 → 跳过（幂等）
  const ruleD = await db.insertRecurringRule({
    userId: OTHER_USER, amount: 700, categoryId: 'c1_1_1', categoryPath: '餐饮/在家吃饭/买菜',
    note: '', account: 'unknown', repeat: { type: 'daily' }, status: 'active', nextDate: TODAY
  });
  await db.insertBillAsUser({
    amount: 700, categoryId: 'c1_1_1', categoryPath: '餐饮/在家吃饭/买菜',
    date: TODAY, ts: Date.now(), account: 'unknown', note: '', source: 'auto',
    isRecall: false, recallDaysLater: 0, aiMeta: { agent: 'recurring', isFallback: false },
    delFlag: false, ruleId: ruleD._id
  }, OTHER_USER);

  test('非触发器来源一律拒绝（SOURCE 缺失 + 环境变量未放行）', async () => {
    mockSource = undefined;
    delete process.env.RECURRING_ALLOW_MANUAL;
    const billsBefore = (DB.collections.bills || []).length;
    const res = await billSvc.main({ action: 'dailyRecurring', payload: { triggeredAt: TRIGGER_TS } }, {});
    if (res.ok !== false || res.errorCode !== 'TRIGGER_ONLY') {
      throw new Error(`应拒绝：${JSON.stringify(res)}`);
    }
    const billsAfter = (DB.collections.bills || []).length;
    if (billsAfter !== billsBefore) throw new Error('拒绝调用时不应写任何账单');
  });

  test('SOURCE=wx_trigger 放行（无需环境变量）', async () => {
    mockSource = 'wx_trigger';
    const res = await billSvc.main({ action: 'dailyRecurring', payload: { triggeredAt: TRIGGER_TS } }, {});
    mockSource = undefined;
    if (!res.ok) throw new Error(`触发器来源应放行：${JSON.stringify(res)}`);
    if (res.generated !== 1) throw new Error(`应生成 1 笔（实际 ${res.generated}）`);
    if (res.skipped !== 2) throw new Error(`应跳过 2 条（B 漏跑 + D 已存在，实际 ${res.skipped}）`);
    if (res.date !== TODAY) throw new Error(`date 应为 ${TODAY}（实际 ${res.date}）`);
  });

  test('生成的账单：userId 来自规则文档而非 openid，字段齐全', async () => {
    const bills = (DB.collections.bills || []).filter((b) => b.ruleId === ruleA._id);
    if (bills.length !== 1) throw new Error(`规则 A 应生成 1 笔（实际 ${bills.length}）`);
    const b = bills[0];
    // ⚠ 关键安全断言：触发器无 openid，归属必须来自规则文档
    if (b.userId !== OTHER_USER) throw new Error(`userId=${b.userId} 应为规则所属 ${OTHER_USER}`);
    if (b.userId === MOCK_OPENID) throw new Error('userId 绝不能取 getWXContext 的空/他人 openid');
    if (b.date !== TODAY) throw new Error(`date=${b.date} 应为 ${TODAY}`);
    if (b.amount !== 400) throw new Error('金额应取规则的 400 分');
    if (b.source !== 'auto') throw new Error('source 应为 auto');
    if (b.note !== '通勤地铁') throw new Error('备注应取规则的 note');
    if (b.delFlag !== false) throw new Error('delFlag 应为 false');
  });

  test('漏跑的规则 B 不补记，游标前移', async () => {
    const billsB = (DB.collections.bills || []).filter((b) => b.ruleId === ruleB._id);
    if (billsB.length !== 0) throw new Error('漏跑不应补记账单');
    const b = DB.collections.recurring.find((r) => r._id === ruleB._id);
    if (b.nextDate <= TODAY) throw new Error(`游标应前移到今天之后（实际 ${b.nextDate}）`);
  });

  test('已有账单的规则 D 不重复生成，游标前移', async () => {
    const billsD = (DB.collections.bills || []).filter((b) => b.ruleId === ruleD._id);
    if (billsD.length !== 1) throw new Error(`D 应仍只有预置的 1 笔（实际 ${billsD.length}）`);
    const d = DB.collections.recurring.find((r) => r._id === ruleD._id);
    if (d.nextDate <= TODAY) throw new Error(`游标应前移到今天之后（实际 ${d.nextDate}）`);
  });

  test('再次触发同一天：游标已前移，不重复生成', async () => {
    mockSource = 'wx_trigger';
    const res = await billSvc.main({ action: 'dailyRecurring', payload: { triggeredAt: TRIGGER_TS } }, {});
    mockSource = undefined;
    if (!res.ok) throw new Error(`第二次触发失败：${JSON.stringify(res)}`);
    if (res.generated !== 0) throw new Error(`第二次触发不应再生成（实际 ${res.generated}）`);
    const billsA = (DB.collections.bills || []).filter((b) => b.ruleId === ruleA._id);
    if (billsA.length !== 1) throw new Error('规则 A 应只有 1 笔');
  });

  test('定时触发器 event 归一：{Type,TriggerName} 能进 dailyRecurring', async () => {
    // 先造一条明天到期的规则，验证「到期才有生成」
    await db.insertRecurringRule({
      userId: OTHER_USER, amount: 800, categoryId: 'c1_1_1', categoryPath: '餐饮/在家吃饭/买菜',
      note: '', account: 'unknown', repeat: { type: 'daily' }, status: 'active', nextDate: '2026-11-03'
    });
    mockSource = 'wx_trigger';
    const res = await billSvc.main({
      Type: 'Timer', TriggerName: 'dailyRecurring', Time: '2026-11-02T00:30:00+08:00'
    }, {});
    mockSource = undefined;
    if (!res.ok) throw new Error(`触发器归一失败：${JSON.stringify(res)}`);
    if (res.date !== TODAY) throw new Error('归一后应解析出触发日 2026-11-02');
  });

  section('【4】家庭账本规则（创建校验 + 生成分流 + 失效防线）');

  const FAMILY_ID = 'fam_recurring_1';

  /** 造家庭档案：users 集合 `{openid}_profile` + families 集合家庭文档 */
  function seedFamilyMember(openid, familyId) {
    DB.collections.users = DB.collections.users || [];
    DB.collections.users.push({
      _id: `${openid}_profile`, userId: openid, familyId,
      nickname: '', avatarUrl: '', createTime: 1
    });
    DB.collections.families = DB.collections.families || [];
    if (!DB.collections.families.some((f) => f._id === familyId)) {
      DB.collections.families.push({
        _id: familyId, name: '测试家庭', ownerId: openid, delFlag: false,
        inviteCode: 'AAAAAAAA', inviteExpiresAt: Date.now() + 72 * 3600e3,
        createTime: 1, updateTime: 1
      });
    }
  }

  /** 直接落一条到期家庭规则（绕过「明天起」游标，模拟已存在的老规则） */
  function makeFamilyRule(userId, familyId, extra = {}) {
    return db.insertRecurringRule({
      userId, amount: 900, categoryId: 'c1_1_1', categoryPath: '餐饮/在家吃饭/买菜',
      note: '家庭规则', account: 'unknown', repeat: { type: 'daily' },
      status: 'active', nextDate: TODAY, ledger: 'family', familyId, ...extra
    });
  }

  test('无家庭档案时创建家庭规则：明确拒绝、零落库', async () => {
    // ⚠ 重置必须放在用例内：顶层语句会在测试循环开始前执行，把第 3 段数据提前清掉
    DB.collections = {};
    const before = (DB.collections.recurring || []).length;
    const res = await billSvc.main({
      action: 'ruleCreate',
      payload: { amountCent: 400, categoryId: 'c1_1_1', categoryPath: '餐饮/在家吃饭/买菜', repeat: { type: 'daily' }, ledger: 'family' }
    }, {});
    if (res.ok) throw new Error('未加入家庭应被拒绝');
    if (!/还没有加入/.test(res.error || '')) throw new Error(`应提示未加入家庭：${res.error}`);
    if ((DB.collections.recurring || []).length !== before) throw new Error('拒绝时应零落库');
  });

  test('未知账本类型被拒绝', async () => {
    const res = await billSvc.main({
      action: 'ruleCreate',
      payload: { amountCent: 400, categoryId: 'c1_1_1', categoryPath: '餐饮/在家吃饭/买菜', repeat: { type: 'daily' }, ledger: 'clan' }
    }, {});
    if (res.ok) throw new Error('未知账本应被拒绝');
    if (!/未知账本/.test(res.error || '')) throw new Error(`应报未知账本：${res.error}`);
  });

  let familyRuleId = null;
  test('成员创建家庭规则成功：落库带 ledger + familyId（云端反查）', async () => {
    seedFamilyMember(MOCK_OPENID, FAMILY_ID);
    const res = await billSvc.main({
      action: 'ruleCreate',
      payload: { amountCent: 400, categoryId: 'c1_1_1', categoryPath: '餐饮/在家吃饭/买菜', note: '房租', repeat: { type: 'daily' }, ledger: 'family' }
    }, {});
    if (!res.ok || !res.saved) throw new Error(`创建失败：${JSON.stringify(res)}`);
    if (res.rule.ledger !== 'family') throw new Error('ledger 应为 family');
    if (res.rule.familyId !== FAMILY_ID) throw new Error('familyId 应来自云端 profile 反查');
    familyRuleId = res.rule._id;
  });

  test('缺省创建仍是个人规则（老行为零变化）', async () => {
    const res = await billSvc.main({
      action: 'ruleCreate',
      payload: { amountCent: 400, categoryId: 'c1_1_1', categoryPath: '餐饮/在家吃饭/买菜', repeat: { type: 'daily' } }
    }, {});
    if (!res.ok) throw new Error(`创建失败：${JSON.stringify(res)}`);
    if (res.rule.ledger !== 'personal') throw new Error('缺省应落 personal');
    if (res.rule.familyId !== undefined) throw new Error('个人规则不应带 familyId 字段');
  });

  test('ruleUpdate 带 ledger：明确拒绝（账本归属不可改）', async () => {
    const res = await billSvc.main({
      action: 'ruleUpdate',
      payload: { ruleId: familyRuleId, ledger: 'personal' }
    }, {});
    if (res.ok) throw new Error('改账本应被拒绝');
    if (!/不可修改/.test(res.error || '')) throw new Error(`应提示不可修改：${res.error}`);
  });

  test('退出家庭后恢复家庭规则：明确拒绝（防恢复成功但永远不生成的静默失效）', async () => {
    // 模拟退出：清掉档案归属
    const prof = DB.collections.users.find((u) => u._id === `${MOCK_OPENID}_profile`);
    prof.familyId = '';
    const res = await billSvc.main({
      action: 'rulePause',
      payload: { ruleId: familyRuleId, paused: false }
    }, {});
    if (res.ok) throw new Error('已退出家庭不应能恢复家庭规则');
    if (!/已退出该家庭/.test(res.error || '')) throw new Error(`应提示已退出：${res.error}`);
    // 恢复成员身份，供后续生成用例使用
    prof.familyId = FAMILY_ID;
  });

  test('定时生成家庭规则：账单进 family_bills，userId=规则创建者=记录人', async () => {
    seedFamilyMember(OTHER_USER, FAMILY_ID);
    const rule = await makeFamilyRule(OTHER_USER, FAMILY_ID);
    mockSource = 'wx_trigger';
    const res = await billSvc.main({ action: 'dailyRecurring', payload: { triggeredAt: TRIGGER_TS } }, {});
    mockSource = undefined;
    if (!res.ok) throw new Error(`触发失败：${JSON.stringify(res)}`);
    const fb = (DB.collections.family_bills || []).filter((b) => b.ruleId === rule._id);
    if (fb.length !== 1) throw new Error(`应生成 1 笔家庭账单（实际 ${fb.length}）`);
    if (fb[0].userId !== OTHER_USER) throw new Error('家庭账单 userId 应为规则创建者');
    if (fb[0].familyId !== FAMILY_ID) throw new Error('家庭账单应带 familyId');
    if (fb[0].date !== TODAY) throw new Error(`date=${fb[0].date} 应为 ${TODAY}`);
    const personal = (DB.collections.bills || []).filter((b) => b.ruleId === rule._id);
    if (personal.length !== 0) throw new Error('家庭规则绝不能写个人 bills');
  });

  test('家庭规则同日已生成 → 家庭版幂等跳过，游标前移', async () => {
    const rule = await makeFamilyRule(OTHER_USER, FAMILY_ID);
    // 预置同日已生成的家庭账单
    await db.insertFamilyBillAsUser(FAMILY_ID, {
      amount: 900, categoryId: 'c1_1_1', categoryPath: '餐饮/在家吃饭/买菜',
      date: TODAY, ts: Date.now(), account: 'unknown', note: '', source: 'auto',
      isRecall: false, recallDaysLater: 0, aiMeta: { agent: 'recurring', isFallback: false },
      delFlag: false, ruleId: rule._id
    }, OTHER_USER);
    mockSource = 'wx_trigger';
    const res = await billSvc.main({ action: 'dailyRecurring', payload: { triggeredAt: TRIGGER_TS } }, {});
    mockSource = undefined;
    if (!res.ok) throw new Error(`触发失败：${JSON.stringify(res)}`);
    const fb = (DB.collections.family_bills || []).filter((b) => b.ruleId === rule._id);
    if (fb.length !== 1) throw new Error(`幂等失败：应仍只有 1 笔（实际 ${fb.length}）`);
    const cur = DB.collections.recurring.find((r) => r._id === rule._id);
    if (cur.nextDate <= TODAY) throw new Error(`游标应前移（实际 ${cur.nextDate}）`);
  });

  test('创建者已退出家庭 → 跳过 + 游标前移、零写家庭账单', async () => {
    const rule = await makeFamilyRule(OTHER_USER, FAMILY_ID);
    // 模拟退出：档案归属清空（规则保持 active，验证生成时兜底防线）
    const prof = DB.collections.users.find((u) => u._id === `${OTHER_USER}_profile`);
    prof.familyId = '';
    mockSource = 'wx_trigger';
    const res = await billSvc.main({ action: 'dailyRecurring', payload: { triggeredAt: TRIGGER_TS } }, {});
    mockSource = undefined;
    if (!res.ok) throw new Error(`触发失败：${JSON.stringify(res)}`);
    const fb = (DB.collections.family_bills || []).filter((b) => b.ruleId === rule._id);
    if (fb.length !== 0) throw new Error('非成员的家庭规则绝不能生成家庭账单');
    const cur = DB.collections.recurring.find((r) => r._id === rule._id);
    if (cur.nextDate <= TODAY) throw new Error(`失效规则游标也应前移（实际 ${cur.nextDate}）`);
    prof.familyId = FAMILY_ID; // 还原
  });

  test('家庭已解散 → 跳过 + 游标前移、零写家庭账单', async () => {
    const rule = await makeFamilyRule(MOCK_OPENID, FAMILY_ID);
    const fam = DB.collections.families.find((f) => f._id === FAMILY_ID);
    fam.delFlag = true;
    mockSource = 'wx_trigger';
    const res = await billSvc.main({ action: 'dailyRecurring', payload: { triggeredAt: TRIGGER_TS } }, {});
    mockSource = undefined;
    if (!res.ok) throw new Error(`触发失败：${JSON.stringify(res)}`);
    const fb = (DB.collections.family_bills || []).filter((b) => b.ruleId === rule._id);
    if (fb.length !== 0) throw new Error('已解散家庭绝不能生成家庭账单');
    const cur = DB.collections.recurring.find((r) => r._id === rule._id);
    if (cur.nextDate <= TODAY) throw new Error(`失效规则游标也应前移（实际 ${cur.nextDate}）`);
    fam.delFlag = false; // 还原
  });

  test('老规则无 ledger 字段 → 个人路径零变化（兼容）', async () => {
    const rule = await db.insertRecurringRule({
      userId: OTHER_USER, amount: 300, categoryId: 'c1_1_1', categoryPath: '餐饮/在家吃饭/买菜',
      note: '', account: 'unknown', repeat: { type: 'daily' }, status: 'active', nextDate: TODAY
    });
    mockSource = 'wx_trigger';
    const res = await billSvc.main({ action: 'dailyRecurring', payload: { triggeredAt: TRIGGER_TS } }, {});
    mockSource = undefined;
    if (!res.ok) throw new Error(`触发失败：${JSON.stringify(res)}`);
    const personal = (DB.collections.bills || []).filter((b) => b.ruleId === rule._id);
    if (personal.length !== 1) throw new Error(`老规则应写个人 bills 1 笔（实际 ${personal.length}）`);
    const fb = (DB.collections.family_bills || []).filter((b) => b.ruleId === rule._id);
    if (fb.length !== 0) throw new Error('无 ledger 字段的规则绝不能写家庭账本');
  });

  // 顺序执行：后续用例依赖前面的库状态（创建→列表→更新→删除），不能并发
  for (const [name, fn] of tests) {
    if (name === null) {
      console.log(`\n${fn}`);
      continue;
    }
    try {
      await fn();
      passed++;
      console.log(`  ✓ ${name}`);
    } catch (e) {
      failed++;
      console.error(`  ✗ ${name}`);
      console.error(`    ${e.message}`);
    }
  }

  console.log(`\n${failed === 0 ? '✓ 全部通过' : '✗ 有失败'}：${passed} 通过 / ${failed} 失败\n`);
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((e) => {
  console.error('运行异常：', e);
  process.exit(1);
});
