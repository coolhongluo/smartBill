#!/usr/bin/env node
/**
 * 家庭模式：创建 / 邀请码加入 / 成员 / 退出 / 解散 全链路 + 越权用例（内存数据库模拟云开发）
 *
 * 覆盖最容易「静默出错」的链路：
 *   1. 邀请码：错误码 / 过期 / 大小写归一 / 重新生成后旧码立即失效
 *   2. 边界：满员拒绝、重复加入拒绝、owner 不可退出、非 owner 不可解散/换码
 *   3. 安全：成员列表不暴露 userId；解散后全员清归属、家庭不可再读
 *
 * 运行：node tools/__tests__/family.test.js
 */

const path = require('path');

// 家庭分析用例会走 refreshInsight：测试环境无 API Key，
// 关掉 LLM 走纯代码 fallback（与 recurring-rule.test.js / e2e-local.js 同款）
process.env.LLM_ENABLED = process.env.LLM_ENABLED || 'false';

// ── 内存数据库（users 多文档 Map；families 支持 add/where/doc.update；
//     bills / family_bills 支持 add/where(update)/分页链） ──
const usersStore = new Map();      // _id → doc
const familiesStore = new Map();   // _id → doc
const billsStore = new Map();      // _id → doc（个人账本）
const familyBillsStore = new Map(); // _id → doc（家庭账本）
let famSeq = 0;
let billSeq = 0;
let famBillSeq = 0;

const notFound = () => {
  const e = new Error('document not exist');
  e.errMsg = 'document.get:fail -502005 document not exist';
  throw e;
};

function matches(row, cond) {
  for (const [k, v] of Object.entries(cond)) {
    if (v && typeof v === 'object' && v.__and) {
      // db.command.gte(x).and(lte(y)) 的链式范围：两个子条件都要命中
      if (!v.__and.every((sub) => matches(row, { [k]: sub }))) return false;
    } else if (v && typeof v === 'object' && v.__cmd) {
      const val = row[k];
      if (v.__cmd === 'gte' && !(val >= v.v)) return false;
      if (v.__cmd === 'lte' && !(val <= v.v)) return false;
      if (v.__cmd === 'gt' && !(val > v.v)) return false;
      if (v.__cmd === 'lt' && !(val < v.v)) return false;
    } else if (row[k] !== v) {
      return false;
    }
  }
  return true;
}

const usersCol = {
  doc(id) {
    return {
      async get() {
        if (!usersStore.has(id)) notFound();
        return { data: usersStore.get(id) };
      },
      async set({ data }) {
        usersStore.set(id, { _id: id, ...data });
        return {};
      }
    };
  },
  where(cond) {
    return {
      limit(n) { this._limit = n; return this; },
      async get() {
        let data = [...usersStore.values()].filter((r) => matches(r, cond));
        if (this._limit) data = data.slice(0, this._limit);
        return { data: data.map((r) => ({ ...r })) };
      }
    };
  }
};

const familiesCol = {
  async add({ data }) {
    const _id = 'fam_' + (++famSeq);
    familiesStore.set(_id, { _id, ...data });
    return { _id };
  },
  where(cond) {
    return {
      limit(n) { this._limit = n; return this; },
      async get() {
        let data = [...familiesStore.values()].filter((r) => matches(r, cond));
        if (this._limit) data = data.slice(0, this._limit);
        return { data: data.map((r) => ({ ...r })) };
      }
    };
  },
  doc(id) {
    return {
      async get() {
        if (!familiesStore.has(id)) notFound();
        return { data: familiesStore.get(id) };
      },
      async update({ data }) {
        if (!familiesStore.has(id)) notFound();
        familiesStore.set(id, { ...familiesStore.get(id), ...data });
        return { stats: { updated: 1 } };
      }
    };
  }
};

const billCol = {
  async add({ data }) {
    const _id = 'b_' + (++billSeq);
    billsStore.set(_id, { _id, ...data });
    return { _id };
  },
  where() { return this; },
  skip() { return this; },
  limit() { return this; },
  orderBy() { return this; },
  async get() { return { data: [] }; }
};

// family_bills：账单集合的完整行为（分页链 + where().update() 按命中数返回）
const familyBillsCol = {
  async add({ data }) {
    const _id = 'fb_' + (++famBillSeq);
    familyBillsStore.set(_id, { _id, ...data });
    return { _id };
  },
  where(cond) {
    return {
      skip(n) { this._skip = n; return this; },
      limit(n) { this._limit = n; return this; },
      orderBy() { return this; },
      async get() {
        let data = [...familyBillsStore.values()].filter((r) => matches(r, cond));
        if (this._skip) data = data.slice(this._skip);
        if (this._limit) data = data.slice(0, this._limit);
        return { data: data.map((r) => ({ ...r })) };
      },
      async update({ data }) {
        const hits = [...familyBillsStore.values()].filter((r) => matches(r, cond));
        for (const r of hits) familyBillsStore.set(r._id, { ...r, ...data });
        return { stats: { updated: hits.length } };
      }
    };
  }
};

// recurring：重复记账规则集合（退出/解散自动暂停 + 规则 CRUD 用例用）
const recurringStore = new Map();
let recurringSeq = 0;
const recurringCol = {
  async add({ data }) {
    const _id = 'rule_' + (++recurringSeq);
    recurringStore.set(_id, { _id, ...data });
    return { _id };
  },
  where(cond) {
    return {
      skip(n) { this._skip = n; return this; },
      limit(n) { this._limit = n; return this; },
      async get() {
        let data = [...recurringStore.values()].filter((r) => matches(r, cond));
        if (this._skip) data = data.slice(this._skip);
        if (this._limit) data = data.slice(0, this._limit);
        return { data: data.map((r) => ({ ...r })) };
      },
      async update({ data }) {
        const hits = [...recurringStore.values()].filter((r) => matches(r, cond));
        for (const r of hits) recurringStore.set(r._id, { ...r, ...data });
        return { stats: { updated: hits.length } };
      }
    };
  }
};

function makeCommand() {
  const cmd = (op) => (v) => {
    const node = { __cmd: op, v, and: (o) => ({ __and: [node, o] }) };
    return node;
  };
  return { gte: cmd('gte'), lte: cmd('lte'), lt: cmd('lt'), gt: cmd('gt') };
}

// ── 注入假 wx-server-sdk（globalThis 共享，跨 shared 副本生效） ──
let currentOpenid = 'u_owner';
const mockSdk = {
  database: () => ({
    collection: (name) => (
      name === 'users' ? usersCol :
      name === 'families' ? familiesCol :
      name === 'family_bills' ? familyBillsCol :
      name === 'recurring' ? recurringCol :
      billCol
    ),
    command: makeCommand()
  }),
  getWXContext: () => ({ OPENID: currentOpenid, ENV: 'mock-env' })
};
require(path.join(__dirname, '..', '..', 'cloudfunctions', 'shared', 'db', 'sdk.js'))
  .__injectSdk(mockSdk);

// ── 加载被测模块（必须在注入 sdk 之后） ──
const db = require(path.join(__dirname, '..', '..', 'cloudfunctions', 'shared', 'db', 'index.js'));
const userSvc = require(path.join(__dirname, '..', '..', 'cloudfunctions', 'user-svc', 'index.js'));
const billSvc = require(path.join(__dirname, '..', '..', 'cloudfunctions', 'bill-svc', 'index.js'));
const analysisSvc = require(path.join(__dirname, '..', '..', 'cloudfunctions', 'analysis-svc', 'index.js'));

let passed = 0;
let failed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }
function section(title) { tests.push([null, title]); }

async function run() {
  section('【1】创建家庭');

  let famId = null;
  let inviteCode = null;

  test('创建成功：返回家庭 ID 与 8 位邀请码', async () => {
    usersStore.clear();
    familiesStore.clear();
    currentOpenid = 'u_owner';
    const r = await userSvc.main({ action: 'familyCreate', payload: { name: '我们的家' } }, {});
    if (!r.ok) throw new Error(r.error);
    famId = r.data.familyId;
    inviteCode = r.data.inviteCode;
    if (!/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/.test(inviteCode)) {
      throw new Error(`邀请码格式不符：${inviteCode}`);
    }
    const prof = usersStore.get('u_owner_profile');
    if (prof.familyId !== famId) throw new Error('创建者应自动加入家庭');
    const fam = familiesStore.get(famId);
    if (fam.ownerId !== 'u_owner') throw new Error('ownerId 应为创建者');
    if (fam.delFlag !== false) throw new Error('delFlag 应为 false');
  });

  test('空名称被拒绝', async () => {
    currentOpenid = 'u_empty';
    const r = await userSvc.main({ action: 'familyCreate', payload: { name: '  ' } }, {});
    if (r.ok) throw new Error('空名称不应成功');
  });

  test('已加入家庭者再创建被拒绝', async () => {
    currentOpenid = 'u_owner';
    const r = await userSvc.main({ action: 'familyCreate', payload: { name: '第二个家' } }, {});
    if (r.ok) throw new Error('已有家庭者不应能再创建');
  });

  section('【2】邀请码加入');

  test('正确邀请码加入成功（含小写归一）', async () => {
    currentOpenid = 'u_member';
    const r = await userSvc.main({ action: 'familyJoin', payload: { inviteCode: inviteCode.toLowerCase() } }, {});
    if (!r.ok) throw new Error(r.error);
    if (usersStore.get('u_member_profile').familyId !== famId) throw new Error('加入后 familyId 未更新');
  });

  test('错误邀请码被拒绝', async () => {
    currentOpenid = 'u_wrong';
    const r = await userSvc.main({ action: 'familyJoin', payload: { inviteCode: 'ZZZZZZZZ' } }, {});
    if (r.ok) throw new Error('错误邀请码不应成功');
    if (!/邀请码/.test(r.error)) throw new Error(`错误文案应可读：${r.error}`);
  });

  test('过期邀请码被拒绝', async () => {
    familiesStore.get(famId).inviteExpiresAt = Date.now() - 1000;
    currentOpenid = 'u_expired';
    const r = await userSvc.main({ action: 'familyJoin', payload: { inviteCode } }, {});
    if (r.ok) throw new Error('过期邀请码不应成功');
    if (!/过期/.test(r.error)) throw new Error(`应提示过期：${r.error}`);
    // 恢复有效期，供后续用例使用
    familiesStore.get(famId).inviteExpiresAt = Date.now() + 72 * 3600 * 1000;
  });

  test('已加入家庭者再加入被拒绝', async () => {
    currentOpenid = 'u_member';
    const r = await userSvc.main({ action: 'familyJoin', payload: { inviteCode } }, {});
    if (r.ok) throw new Error('已有家庭者不应能再加入');
  });

  test('满员（8 人）拒绝第 9 人', async () => {
    // 预置 6 个成员（已有 owner + u_member = 2，共 8 人）
    for (let i = 1; i <= 6; i++) {
      await db.saveProfile(`u_full${i}`, { familyId: famId });
    }
    currentOpenid = 'u_join9';
    const r = await userSvc.main({ action: 'familyJoin', payload: { inviteCode } }, {});
    if (r.ok) throw new Error('满员后不应能加入');
    if (!/满员/.test(r.error)) throw new Error(`应提示满员：${r.error}`);
  });

  section('【3】家庭信息与成员');

  test('未加入者 familyInfo 返回 inFamily=false', async () => {
    currentOpenid = 'u_alone';
    const r = await userSvc.main({ action: 'familyInfo' }, {});
    if (!r.ok) throw new Error(r.error);
    if (r.data.inFamily !== false) throw new Error('未加入者 inFamily 应为 false');
  });

  test('owner 的 familyInfo：isOwner + 成员数 + 邀请码', async () => {
    currentOpenid = 'u_owner';
    const r = await userSvc.main({ action: 'familyInfo' }, {});
    if (!r.ok) throw new Error(r.error);
    if (r.data.family.isOwner !== true) throw new Error('owner 的 isOwner 应为 true');
    if (r.data.family.memberCount !== 8) throw new Error(`成员数应为 8，实际 ${r.data.family.memberCount}`);
    if (r.data.family.inviteCode !== familiesStore.get(famId).inviteCode) throw new Error('邀请码应与文档一致');
  });

  test('成员列表：不含 userId、isMe/isOwner 由云端标好', async () => {
    currentOpenid = 'u_member';
    const r = await userSvc.main({ action: 'familyMembers' }, {});
    if (!r.ok) throw new Error(r.error);
    const members = r.data.members;
    if (members.length !== 8) throw new Error(`成员数应为 8，实际 ${members.length}`);
    for (const m of members) {
      if (m.userId !== undefined) throw new Error('成员列表不得暴露 userId');
      if (typeof m.isMe !== 'boolean' || typeof m.isOwner !== 'boolean') {
        throw new Error('isMe/isOwner 必须由云端标好');
      }
    }
    const me = members.find((m) => m.isMe);
    if (!me) throw new Error('应有一个成员被标为「我」');
    const owner = members.find((m) => m.isOwner);
    if (!owner) throw new Error('应有一个成员被标为「创建者」');
  });

  test('非成员无法查成员列表', async () => {
    currentOpenid = 'u_alone';
    const r = await userSvc.main({ action: 'familyMembers' }, {});
    if (r.ok) throw new Error('非成员不应能读成员列表');
  });

  section('【4】重新生成邀请码');

  test('非 owner 换码被拒绝', async () => {
    currentOpenid = 'u_member';
    const r = await userSvc.main({ action: 'familyRegenCode' }, {});
    if (r.ok) throw new Error('非 owner 不应能换码');
  });

  test('owner 换码成功，旧码立即失效', async () => {
    // 上一用例为验证满员把家庭填到 8 人，这里先腾出名额——
    // 否则新码加入会被「满员」拦截，测不出码本身是否可用
    for (let i = 1; i <= 6; i++) {
      await db.saveProfile(`u_full${i}`, { familyId: '' });
    }
    currentOpenid = 'u_owner';
    const oldCode = familiesStore.get(famId).inviteCode;
    const r = await userSvc.main({ action: 'familyRegenCode' }, {});
    if (!r.ok) throw new Error(r.error);
    const newCode = familiesStore.get(famId).inviteCode;
    if (newCode === oldCode) throw new Error('新码不应与旧码相同');

    currentOpenid = 'u_oldcode';
    const joinOld = await userSvc.main({ action: 'familyJoin', payload: { inviteCode: oldCode } }, {});
    if (joinOld.ok) throw new Error('旧码应立即失效');

    const joinNew = await userSvc.main({ action: 'familyJoin', payload: { inviteCode: newCode } }, {});
    if (!joinNew.ok) throw new Error('新码应可用');
    await db.saveProfile('u_oldcode', { familyId: '' }); // 清场，避免影响解散用例
  });

  section('【5】退出与解散');

  test('owner 退出被拒绝', async () => {
    currentOpenid = 'u_owner';
    const r = await userSvc.main({ action: 'familyLeave' }, {});
    if (r.ok) throw new Error('创建者不应能退出');
  });

  test('成员退出成功：familyId 清空、不再可读', async () => {
    currentOpenid = 'u_member';
    const r = await userSvc.main({ action: 'familyLeave' }, {});
    if (!r.ok) throw new Error(r.error);
    if (usersStore.get('u_member_profile').familyId !== '') throw new Error('退出后 familyId 应为空串');
    const info = await userSvc.main({ action: 'familyInfo' }, {});
    if (info.data.inFamily !== false) throw new Error('退出后 familyInfo 应为未加入');
  });

  test('非 owner 解散被拒绝', async () => {
    // 重新加入一个成员
    currentOpenid = 'u_member';
    await userSvc.main({ action: 'familyJoin', payload: { inviteCode: familiesStore.get(famId).inviteCode } }, {});
    const r = await userSvc.main({ action: 'familyDissolve' }, {});
    if (r.ok) throw new Error('非 owner 不应能解散');
  });

  test('owner 解散：家庭置 delFlag、全员清归属', async () => {
    currentOpenid = 'u_owner';
    const r = await userSvc.main({ action: 'familyDissolve' }, {});
    if (!r.ok) throw new Error(r.error);
    if (familiesStore.get(famId).delFlag !== true) throw new Error('解散后 delFlag 应为 true');

    const memberProfiles = [...usersStore.values()].filter((d) => d.userId && d.familyId !== '');
    if (memberProfiles.length !== 0) {
      throw new Error(`解散后仍有人带 familyId：${memberProfiles.map((d) => d.userId).join(',')}`);
    }

    currentOpenid = 'u_member';
    const info = await userSvc.main({ action: 'familyInfo' }, {});
    if (info.data.inFamily !== false) throw new Error('解散后成员 familyInfo 应为未加入');
    const members = await userSvc.main({ action: 'familyMembers' }, {});
    if (members.ok) throw new Error('解散后不应能读成员列表');
  });

  section('【6】家庭记账（双空间）');

  let famId2 = null;

  test('新家庭：创建 + 成员加入（为记账用例做准备）', async () => {
    currentOpenid = 'u_famowner';
    const r = await userSvc.main({ action: 'familyCreate', payload: { name: '记账之家' } }, {});
    if (!r.ok) throw new Error(r.error);
    famId2 = r.data.familyId;
    currentOpenid = 'u_fammember';
    const j = await userSvc.main({ action: 'familyJoin', payload: { inviteCode: r.data.inviteCode } }, {});
    if (!j.ok) throw new Error(j.error);
  });

  test('成员记家庭账：落 family_bills，userId 为记录人', async () => {
    billsStore.clear();
    familyBillsStore.clear();
    currentOpenid = 'u_fammember';
    const r = await billSvc.main({
      action: 'manual',
      payload: { amountCent: 2345, categoryId: 'food_lunch', categoryPath: '餐饮/在外吃饭', ledger: 'family' }
    }, {});
    if (!r.ok) throw new Error(r.error);
    if (!r.saved) throw new Error('应真实落库');
    if (r.bill.familyId !== famId2) throw new Error('家庭账单应带 familyId');
    if (r.bill.userId !== 'u_fammember') throw new Error('userId 应为记录人');
    if (familyBillsStore.size !== 1) throw new Error('应落 1 条 family_bills');
    if (billsStore.size !== 0) throw new Error('家庭账单不应写进个人 bills');
  });

  test('非成员传 family：明确拒绝，不回退个人账本', async () => {
    currentOpenid = 'u_alone';
    const r = await billSvc.main({
      action: 'manual',
      payload: { amountCent: 100, categoryId: 'x', categoryPath: '测试/路径', ledger: 'family' }
    }, {});
    if (r.ok) throw new Error('非成员不应能记家庭账');
    if (!/还没有加入/.test(r.error)) throw new Error(`应提示未加入家庭：${r.error}`);
    if (billsStore.size !== 0 || familyBillsStore.size !== 1) {
      throw new Error('拒绝时不得写任何集合（禁止静默回退个人）');
    }
  });

  test('未知账本类型被拒绝', async () => {
    currentOpenid = 'u_fammember';
    const r = await billSvc.main({
      action: 'manual',
      payload: { amountCent: 100, categoryId: 'x', categoryPath: '测试/路径', ledger: 'clan' }
    }, {});
    if (r.ok) throw new Error('未知 ledger 不应成功');
    if (!/未知账本/.test(r.error)) throw new Error(`应报未知账本：${r.error}`);
  });

  test('不传 ledger：照旧写个人 bills（零混写、零回退）', async () => {
    currentOpenid = 'u_fammember';
    const r = await billSvc.main({
      action: 'manual',
      payload: { amountCent: 500, categoryId: 'x', categoryPath: '测试/路径' }
    }, {});
    if (!r.ok || !r.saved) throw new Error(r.error || '应落库');
    if (billsStore.size !== 1) throw new Error('个人账单应写进 bills');
    if (familyBillsStore.size !== 1) throw new Error('家庭集合不应新增');
  });

  test('家庭账单列表：familyId 过滤 + 全员可见', async () => {
    const bills = await db.listFamilyBills(famId2, {});
    if (bills.length !== 1) throw new Error(`应看到成员记的 1 笔，实际 ${bills.length}`);
    if (bills[0].userId !== 'u_fammember') throw new Error('列表应含记录人 userId');
  });

  test('撤销只允许记录人：他人删 → 0 条受影响', async () => {
    const bills = await db.listFamilyBills(famId2, {});
    const billId = bills[0]._id;

    const ownerTry = await db.softDeleteFamilyBill('u_famowner', famId2, billId);
    if (ownerTry !== 0) throw new Error('非记录人不应能撤销');
    if ((await db.listFamilyBills(famId2, {})).length !== 1) throw new Error('账单不应被他人撤销');

    const selfTry = await db.softDeleteFamilyBill('u_fammember', famId2, billId);
    if (selfTry !== 1) throw new Error('记录人应能撤销');
    if ((await db.listFamilyBills(famId2, {})).length !== 0) throw new Error('撤销后列表应为空');
  });

  test('家庭 amend：记录人改自己的账成功，改别人的账被拒', async () => {
    currentOpenid = 'u_fammember';
    const r1 = await billSvc.main({
      action: 'manual',
      payload: { amountCent: 800, categoryId: 'x', categoryPath: '测试/路径', ledger: 'family' }
    }, {});
    const id = r1.bill._id;

    // 别人（owner）改成员的账 → where 带 userId 不命中
    currentOpenid = 'u_famowner';
    const r2 = await billSvc.main({
      action: 'amend',
      payload: { billId: id, amountCent: 999, ledger: 'family' }
    }, {});
    if (r2.ok) throw new Error('非记录人不应能改');
    if (!/无权|未找到/.test(r2.error)) throw new Error(`应报无权修改：${r2.error}`);

    // 记录人自己改 → 成功，金额生效
    currentOpenid = 'u_fammember';
    const r3 = await billSvc.main({
      action: 'amend',
      payload: { billId: id, amountCent: 999, ledger: 'family' }
    }, {});
    if (!r3.ok || !r3.saved) throw new Error(r3.error || '记录人应能改');
    const bills = await db.listFamilyBills(famId2, {});
    if (bills.length !== 1 || bills[0].amount !== 999) {
      throw new Error('amend 后金额应生效');
    }
  });

  test('家庭撤销（action 层）：他人删 → 明确拒绝，不回 ok', async () => {
    currentOpenid = 'u_fammember';
    const r1 = await billSvc.main({
      action: 'manual',
      payload: { amountCent: 300, categoryId: 'x', categoryPath: '测试/路径', ledger: 'family' }
    }, {});
    if (!r1.ok || !r1.saved) throw new Error(r1.error || '应落库');
    const id = r1.bill._id;
    const before = (await db.listFamilyBills(famId2, {})).length;

    // 非记录人删 → 必须明确拒绝：回 ok 会让前端弹「已删除」但账单还在
    currentOpenid = 'u_famowner';
    const r2 = await billSvc.main({
      action: 'amend',
      payload: { billId: id, delFlag: true, ledger: 'family' }
    }, {});
    if (r2.ok) throw new Error('非记录人删除不应回 ok');
    if (!/只能删除自己/.test(r2.error || '')) throw new Error(`应报只能删除自己记的账：${r2.error}`);
    if ((await db.listFamilyBills(famId2, {})).length !== before) throw new Error('账单不应被他人删除');

    // 记录人自己删 → 成功
    currentOpenid = 'u_fammember';
    const r3 = await billSvc.main({
      action: 'amend',
      payload: { billId: id, delFlag: true, ledger: 'family' }
    }, {});
    if (!r3.ok) throw new Error(r3.error || '记录人应能删除');
    if ((await db.listFamilyBills(famId2, {})).length !== before - 1) throw new Error('删除后应少一笔');
  });

  section('【7】家庭分析（v1 手动刷新）');

  let famId3 = null;
  let curMonth = '';
  let prevMonth = '';

  test('准备：创建家庭 + 成员加入 + 当月两笔家庭账单 + 上月一笔', async () => {
    billsStore.clear();
    familyBillsStore.clear();
    currentOpenid = 'u_anaowner';
    const r = await userSvc.main({ action: 'familyCreate', payload: { name: '分析之家' } }, {});
    if (!r.ok) throw new Error(r.error);
    famId3 = r.data.familyId;
    currentOpenid = 'u_anamember';
    const j = await userSvc.main({ action: 'familyJoin', payload: { inviteCode: r.data.inviteCode } }, {});
    if (!j.ok) throw new Error(j.error);

    const d = new Date();
    curMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const pd = new Date(d.getFullYear(), d.getMonth() - 1, 1);
    prevMonth = `${pd.getFullYear()}-${String(pd.getMonth() + 1).padStart(2, '0')}`;

    // 当月两笔（全家聚合 = 5000 分）+ 上月一笔（应被月份范围排除）
    await db.insertFamilyBill(famId3, { date: `${curMonth}-05`, amount: 2000, categoryId: 'food_lunch', categoryPath: '餐饮/在外吃饭', ts: 1 }, {});
    await db.insertFamilyBill(famId3, { date: `${curMonth}-15`, amount: 3000, categoryId: 'transport', categoryPath: '交通/打车', ts: 2 }, {});
    await db.insertFamilyBill(famId3, { date: `${prevMonth}-10`, amount: 9999, categoryId: 'other', categoryPath: '其他', ts: 3 }, {});
  });

  test('monthSummary 家庭账本：全家聚合、只算当月', async () => {
    currentOpenid = 'u_anaowner';
    const r = await analysisSvc.main({ action: 'monthSummary', payload: { ledger: 'family' } }, {});
    if (!r.ok) throw new Error(r.error);
    if (r.data.count !== 2) throw new Error(`当月应 2 笔，实际 ${r.data.count}`);
    if (r.data.total !== '50.00') throw new Error(`全家当月应 50.00，实际 ${r.data.total}`);
  });

  test('monthSummary 不传 ledger：走个人口径，零混写', async () => {
    const r = await analysisSvc.main({ action: 'monthSummary' }, {});
    if (!r.ok) throw new Error(r.error);
    if (r.data.count !== 0 || r.data.total !== '0.00') {
      throw new Error('个人口径不应混入家庭账单');
    }
  });

  test('monthBills 家庭账本：返回家庭流水并附展示色', async () => {
    const r = await analysisSvc.main({ action: 'monthBills', payload: { ledger: 'family' } }, {});
    if (!r.ok) throw new Error(r.error);
    if (r.data.bills.length !== 2) throw new Error(`应 2 笔，实际 ${r.data.bills.length}`);
    if (r.data.totalCent !== 5000) throw new Error(`totalCent 应 5000，实际 ${r.data.totalCent}`);
    for (const b of r.data.bills) {
      if (b.familyId !== famId3) throw new Error('流水应带 familyId');
      if (!b.color) throw new Error('流水应附展示色');
    }
  });

  test('refreshInsight 家庭：全家聚合落库，顶层无 userId/month', async () => {
    currentOpenid = 'u_anaowner';
    const r = await analysisSvc.main({ action: 'refreshInsight', payload: { ledger: 'family' } }, {});
    if (!r.ok) throw new Error(r.error);
    if (r.data.persisted !== true) {
      throw new Error(`应真实落库：${(r.data && r.data.savedError) || '未知原因'}`);
    }
    if (r.data.billCount !== 2) throw new Error(`全家笔数应 2，实际 ${r.data.billCount}`);

    // 落库形态 = 扫描隔离纪律：顶层只有 familyId/version/payload/generateTime/updateTime
    const doc = usersStore.get(`family_${famId3}_insight`);
    if (!doc) throw new Error('应存 users/family_${familyId}_insight');
    if (doc.userId !== undefined) throw new Error('顶层不得有 userId（会污染每日扫描）');
    if (doc.month !== undefined) throw new Error('顶层不得有 month（会被 listPendingInsightUsers 捞走）');
    if (!doc.payload || doc.payload.month !== r.data.month) {
      throw new Error('month 应放在 payload 里');
    }
    if (doc.familyId !== famId3) throw new Error('familyId 应为家庭 id');
    if (!(doc.generateTime > 0)) throw new Error('应有 generateTime');
  });

  test('readInsight 家庭：成员也能读到全家结论', async () => {
    currentOpenid = 'u_anamember';
    const r = await analysisSvc.main({ action: 'categoryBreakdown', payload: { ledger: 'family' } }, {});
    if (!r.ok) throw new Error(r.error);
    if (r.data.hasResult !== true) throw new Error('应有分析结果');
    if (r.data.isStale !== false) throw new Error('同月不应标 stale');
    if (r.data.isOutdated !== false) throw new Error('账单未再变动，不应标 outdated');
    if (r.data.billCount !== 2) throw new Error(`应读到全家笔数 2，实际 ${r.data.billCount}`);
  });

  test('readInsight 家庭：跨月读返回 isStale', async () => {
    const r = await analysisSvc.main({
      action: 'categoryBreakdown', payload: { ledger: 'family', month: '2020-01' }
    }, {});
    if (!r.ok) throw new Error(r.error);
    if (r.data.isStale !== true) throw new Error('存的是别的月份 → 应标 isStale');
  });

  test('越权：非成员读/刷新家庭分析均被拒，不落库', async () => {
    currentOpenid = 'u_alone';
    const before = usersStore.size;

    const read = await analysisSvc.main({ action: 'monthSummary', payload: { ledger: 'family' } }, {});
    if (read.ok) throw new Error('非成员不应能读家庭分析');
    if (!/还没有加入|家庭/.test(read.error)) throw new Error(`应提示未加入家庭：${read.error}`);

    const refresh = await analysisSvc.main({ action: 'refreshInsight', payload: { ledger: 'family' } }, {});
    if (refresh.ok) throw new Error('非成员不应能刷新家庭分析');
    if (usersStore.size !== before) throw new Error('拒绝时不得写任何文档');
  });

  test('未知账本类型被拒绝', async () => {
    currentOpenid = 'u_anaowner';
    const r = await analysisSvc.main({ action: 'monthSummary', payload: { ledger: 'clan' } }, {});
    if (r.ok) throw new Error('未知 ledger 不应成功');
    if (!/未知账本/.test(r.error)) throw new Error(`应报未知账本：${r.error}`);
  });

  section('【8】家庭重复记账规则：退出/解散自动暂停');

  let r8famId = null;
  let r8memberRule = null;
  let r8ownerRule = null;

  test('准备：新家庭 + 成员加入 + 各自创建家庭规则', async () => {
    currentOpenid = 'u_r8_owner';
    const created = await userSvc.main({ action: 'familyCreate', payload: { name: '重复规则家庭' } }, {});
    if (!created.ok) throw new Error(created.error);
    r8famId = created.data.familyId;
    currentOpenid = 'u_r8_member';
    const joined = await userSvc.main({ action: 'familyJoin', payload: { inviteCode: created.data.inviteCode } }, {});
    if (!joined.ok) throw new Error(joined.error);

    const memberRes = await billSvc.main({
      action: 'ruleCreate',
      payload: { amountCent: 1000, categoryId: 'c1_1_1', categoryPath: '餐饮/在家吃饭/买菜', repeat: { type: 'daily' }, ledger: 'family' }
    }, {});
    if (!memberRes.ok || !memberRes.saved) throw new Error(`成员建家庭规则失败：${JSON.stringify(memberRes)}`);
    if (memberRes.rule.ledger !== 'family' || memberRes.rule.familyId !== r8famId) {
      throw new Error('规则应带 ledger=family 与云端反查的 familyId');
    }
    r8memberRule = memberRes.rule._id;

    currentOpenid = 'u_r8_owner';
    const ownerRes = await billSvc.main({
      action: 'ruleCreate',
      payload: { amountCent: 2000, categoryId: 'c1_1_1', categoryPath: '餐饮/在家吃饭/买菜', repeat: { type: 'daily' }, ledger: 'family' }
    }, {});
    if (!ownerRes.ok || !ownerRes.saved) throw new Error(`owner 建家庭规则失败：${JSON.stringify(ownerRes)}`);
    r8ownerRule = ownerRes.rule._id;
  });

  test('成员退出：自己的家庭规则自动暂停，owner 规则不动', async () => {
    currentOpenid = 'u_r8_member';
    const r = await userSvc.main({ action: 'familyLeave' }, {});
    if (!r.ok) throw new Error(r.error);
    const memberRule = recurringStore.get(r8memberRule);
    if (memberRule.status !== 'paused') throw new Error('退出后成员的家庭规则应自动 paused');
    const ownerRule = recurringStore.get(r8ownerRule);
    if (ownerRule.status !== 'active') throw new Error('他人退出不应影响 owner 的规则');
  });

  test('owner 解散：全员家庭规则自动暂停', async () => {
    currentOpenid = 'u_r8_owner';
    const r = await userSvc.main({ action: 'familyDissolve' }, {});
    if (!r.ok) throw new Error(r.error);
    const ownerRule = recurringStore.get(r8ownerRule);
    if (ownerRule.status !== 'paused') throw new Error('解散后 owner 的家庭规则应自动 paused');
    const memberRule = recurringStore.get(r8memberRule);
    if (memberRule.status !== 'paused') throw new Error('解散后成员的家庭规则应保持 paused');
    const fam = familiesStore.get(r8famId);
    if (fam.delFlag !== true) throw new Error('家庭应置 delFlag');
  });

  console.log('');
  for (const [name, fn] of tests) {
    if (!name) { console.log(`\n${fn}`); continue; }
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
  console.error('测试运行器异常：', e);
  process.exit(1);
});
