/**
 * 用户档案 + 家庭模式数据层测试
 *
 * ## 为什么与 insight-store 分开但共用一份 mock 思路
 *
 * 档案（profile）与家庭（families / family_bills / 家庭 insight）全部落在
 * 云开发集合里，本地用内存版 Map 模拟。与 insight-store 的单文档 mock 不同，
 * 这里必须是**多文档** Map —— profile 与 insight 文档共存于 users 集合，
 * 键空间靠 `_id` 前缀区分（`${openid}_profile` / `${openid}_insight` / `family_*`）。
 *
 * ## 本文件的四条核心断言（按项目纪律）
 *
 * 1. profile 文档**不能有顶层 month 字段** —— 否则会被
 *    listPendingInsightUsers 的 where({month}) 捞进每日分析扫描（静默污染）。
 * 2. saveProfile 是**字段白名单** —— 白名单外的字段一律不落库。
 * 3. login 幂等 —— 自动注册不重建档案、不重写 createTime。
 * 4. 家庭 insight 文档**顶层不得有 userId/month**（month 进 payload）——
 *    同一份扫描隔离纪律 + 防止压制 owner 个人分析的生成时间。
 */

const assert = require('assert');

let passed = 0;
let failed = 0;

function test(name, fn) {
  return fn()
    .then(() => {
      passed++;
      console.log(`  ✓ ${name}`);
    })
    .catch((e) => {
      failed++;
      console.error(`  ✗ ${name}`);
      console.error(`    ${e.message}`);
    });
}

/* ── 内存版 SDK 注入 ── */

const sdk = require('../sdk');

// users 集合：多文档 Map（profile / insight / 家庭 insight 共存）
const usersStore = new Map();
const notFound = () => {
  const e = new Error('document not exist');
  e.errMsg = 'document.get:fail -502005 document not exist';
  throw e;
};

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
  }
};

// 账单类集合：满足 fetchAll 的 where/skip/limit/get 链
const BILL_COL = (rows) => ({
  where() { return this; },
  skip() { return this; },
  limit() { return this; },
  orderBy() { return this; },
  async get() { return { data: rows }; }
});

sdk.__injectSdk({
  database: () => ({
    collection: (name) => (name === 'users' ? usersCol : BILL_COL([])),
    command: { gte: () => ({ and: () => ({}) }), lte: () => ({ and: () => ({}) }) }
  }),
  getWXContext: () => ({ OPENID: 'u_test', ENV: 'test' })
});

const db = require('../index');
// 从 shared/db/__tests__/ 出发，../../../ 是 cloudfunctions/ 目录
const userSvc = require('../../../user-svc/index.js');
const CTX = { OPENID: 'u_test', ENV: 'test' };

async function main() {
  console.log('\n【档案：注册与读取】');

  await test('未注册用户 getProfile 返回 null（而不是抛错）', async () => {
    usersStore.clear();
    assert.strictEqual(await db.getProfile('u_test'), null,
      'null 是「从未注册」的正常初始态，由上层触发自动注册');
  });

  await test('login 自动注册：建档且 isNew=true', async () => {
    usersStore.clear();
    const r = await userSvc.main({ action: 'login' }, CTX);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.data.isNew, true);
    assert.ok(usersStore.has('u_test_profile'), '应建 ${openid}_profile 档案文档');
    const doc = usersStore.get('u_test_profile');
    assert.strictEqual(doc.userId, 'u_test');
    assert.ok(doc.createTime > 0, '必须有创建时间');
  });

  await test('档案文档没有顶层 month（不被每日分析扫描捞走）', async () => {
    const doc = usersStore.get('u_test_profile');
    assert.strictEqual(doc.month, undefined,
      '带 month 会被 listPendingInsightUsers 的 where({month}) 当成分析结果文档');
  });

  await test('login 幂等：再次登录不重建档案、不重写 createTime', async () => {
    const before = usersStore.get('u_test_profile').createTime;
    const r = await userSvc.main({ action: 'login' }, CTX);
    assert.strictEqual(r.data.isNew, false);
    assert.strictEqual(usersStore.get('u_test_profile').createTime, before);
  });

  console.log('\n【档案：资料更新】');

  await test('updateProfile 空 payload 明确报错（不静默成功）', async () => {
    const r = await userSvc.main({ action: 'updateProfile', payload: {} }, CTX);
    assert.strictEqual(r.ok, false);
  });

  await test('updateProfile 保存昵称与头像', async () => {
    const r = await userSvc.main({
      action: 'updateProfile',
      payload: { nickname: '小明', avatarUrl: 'cloud://x/av.png' }
    }, CTX);
    assert.strictEqual(r.ok, true);
    const doc = usersStore.get('u_test_profile');
    assert.strictEqual(doc.nickname, '小明');
    assert.strictEqual(doc.avatarUrl, 'cloud://x/av.png');
  });

  await test('updateProfile 忽略空白昵称与 null 值（null 不写）', async () => {
    const r = await userSvc.main({
      action: 'updateProfile',
      payload: { nickname: '   ', avatarUrl: null }
    }, CTX);
    assert.strictEqual(r.ok, false, '两个字段都无效 → 明确报错');
    const doc = usersStore.get('u_test_profile');
    assert.strictEqual(doc.nickname, '小明', '旧昵称不被清掉');
  });

  await test('saveProfile 字段白名单：白名单外字段不落库', async () => {
    await db.saveProfile('u_test', { nickname: '老王', hack: 'x', isAdmin: true });
    const doc = usersStore.get('u_test_profile');
    assert.strictEqual(doc.nickname, '老王');
    assert.strictEqual(doc.hack, undefined, '白名单外字段必须被丢弃');
    assert.strictEqual(doc.isAdmin, undefined);
  });

  await test('saveProfile 超长字段截断（昵称 30 / 头像 500）', async () => {
    await db.saveProfile('u_test', { nickname: 'x'.repeat(100), avatarUrl: 'y'.repeat(1000) });
    const doc = usersStore.get('u_test_profile');
    assert.strictEqual(doc.nickname.length, 30);
    assert.strictEqual(doc.avatarUrl.length, 500);
  });

  await test('familyId 显式传空串清空归属；不传则保留旧值', async () => {
    await db.saveProfile('u_test', { familyId: 'fam_1' });
    assert.strictEqual(usersStore.get('u_test_profile').familyId, 'fam_1');
    await db.saveProfile('u_test', { familyId: '' });
    assert.strictEqual(usersStore.get('u_test_profile').familyId, '', '空串 = 无家庭');
    await db.saveProfile('u_test', { familyId: 'fam_2' });
    await db.saveProfile('u_test', { nickname: '再改一次' });
    assert.strictEqual(usersStore.get('u_test_profile').familyId, 'fam_2',
      '不传 familyId 不应清掉旧值（防止更新昵称时误退家庭）');
  });

  console.log('\n【profile action】');

  await test('profile 返回脱敏 openid + 资料 + 已记笔数', async () => {
    await db.saveProfile('u_test', { nickname: '小明' });
    const r = await userSvc.main({ action: 'profile' }, CTX);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.data.openidMasked, 'u_test****');
    assert.strictEqual(r.data.nickname, '小明');
    assert.strictEqual(typeof r.data.billCount, 'number');
  });

  await test('未知 action 明确拒绝', async () => {
    const r = await userSvc.main({ action: 'hack' }, CTX);
    assert.strictEqual(r.ok, false);
  });

  console.log('\n【家庭 insight：存储隔离与拍平读取】');

  await test('saveFamilyInsight 固定 _id，顶层无 userId/month', async () => {
    usersStore.clear();
    await db.saveFamilyInsight('fam_1', {
      insights: ['全家餐饮占比偏高'],
      savings: [],
      pie: [],
      total: '10.00',
      billCount: 3,
      deltaText: '',
      deltaDirection: '',
      trend: [],
      meta: {},
      hack: '越权字段' // 白名单外 → 必须丢弃
    }, '2026-11');

    const doc = usersStore.get('family_fam_1_insight');
    assert.ok(doc, '应存 users/family_${familyId}_insight');
    assert.strictEqual(doc.familyId, 'fam_1');
    assert.strictEqual(doc.userId, undefined,
      '顶层不得有 userId（会压制 owner 个人分析的生成时间）');
    assert.strictEqual(doc.month, undefined,
      '顶层不得有 month（会被 listPendingInsightUsers 的 where({month}) 捞进每日扫描）');
    assert.strictEqual(doc.payload.month, '2026-11', 'month 应放在 payload 里');
    assert.deepStrictEqual(doc.payload.insights, ['全家餐饮占比偏高']);
    assert.strictEqual(doc.payload.hack, undefined, '白名单外字段不得落库');
    assert.strictEqual(doc.version, 'v2');
    assert.ok(doc.generateTime > 0, '应有生成时间');
  });

  await test('getFamilyInsight 无结果返回 null（不是抛错）', async () => {
    usersStore.clear();
    assert.strictEqual(await db.getFamilyInsight('fam_1', '2026-11'), null,
      '还没分析过是正常初始态，由上层引导用户点分析');
  });

  await test('getFamilyInsight 拍平返回：payload 内容提升到顶层', async () => {
    await db.saveFamilyInsight('fam_1', {
      insights: ['a'], savings: [], pie: [], total: '10.00', billCount: 1,
      deltaText: '', deltaDirection: '', trend: [], meta: {}
    }, '2026-11');

    const flat = await db.getFamilyInsight('fam_1', '2026-11');
    assert.strictEqual(flat.insights[0], 'a');
    assert.strictEqual(flat.month, '2026-11');
    assert.ok(flat.generateTime > 0);
    assert.strictEqual(flat._stale, undefined, '同月读取不应标 stale');
  });

  await test('getFamilyInsight 跨月返回 _stale（与 getInsight 同口径）', async () => {
    const stale = await db.getFamilyInsight('fam_1', '2026-10');
    assert.strictEqual(stale._stale, true, '存的是别的月份 → 应标 stale');
  });

  await test('getFamilyInsight familyId 不匹配视为无结果（越权双保险）', async () => {
    usersStore.set('family_fam_9_insight', {
      _id: 'family_fam_9_insight', familyId: 'fam_other', payload: { month: '2026-11' }
    });
    assert.strictEqual(await db.getFamilyInsight('fam_9', '2026-11'), null);
  });

  console.log(`\n${failed === 0 ? '✓ 全部通过' : '✗ 有失败'}：${passed} 通过 / ${failed} 失败\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('测试运行器异常：', e);
  process.exit(1);
});
