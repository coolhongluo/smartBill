#!/usr/bin/env node
/**
 * 持久化链路测试（用内存数据库模拟云开发）
 *
 * 为什么必须模拟：本地没有 cloud 全局对象，db.isAvailable() 恒为 false，
 * 所有落库路径都被跳过——**真实落库逻辑从未被本地测试覆盖过**。
 * 而「记了账刷新就没了」这类问题恰恰只在落库路径上出现。
 *
 * 这里 mock 一个最小可用的 cloud 全局，验证：
 *   1. insertBill 真的写进去了
 *   2. 分页拉取能拿全（模拟云开发默认只返回 20 条的行为）
 *   3. saved 字段在各分支都正确
 *   4. 金额整数分、openid 来自上下文而非 event
 *
 * 运行：node tools/test-persist.js
 */

const path = require('path');

// ── 内存数据库（模拟云开发） ──────────────────────────────
// 关键：故意实现「单次 .get() 默认只返回 20 条」的云开发真实行为，
// 否则测不出分页缺失的问题。
const DB = {
  collections: {},
  // 云开发真实限制：单次查询默认 20 条，最多 100 条
  DEFAULT_PAGE: 20,
  MAX_PAGE: 100
};

/** 判断一条记录是否命中 where 条件 */
function matches(row, cond) {
  for (const [k, v] of Object.entries(cond)) {
    if (v && typeof v === 'object' && v.__and) {
      // 区间条件：db.command.gte(a).and(db.command.lte(b))
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
    // 真实云开发：db.collection(name).where(cond).orderBy().skip().limit().get()
    where(cond) {
      return {
        orderBy() { return this; },
        skip(n) { this._skip = n; return this; },
        limit(n) {
          this._limit = Math.min(n || DB.DEFAULT_PAGE, DB.MAX_PAGE);
          return this;
        },
        async get() {
          let data = rows.filter((r) => matches(r, cond));
          const skip = this._skip || 0;
          const limit = this._limit || DB.DEFAULT_PAGE;
          data = data.slice(skip, skip + limit);
          return { data: data.map((r) => ({ ...r })) };
        },
        async count() {
          const data = rows.filter((r) => matches(r, cond));
          return { total: data.length };
        }
      };
    },
    limit(n) {
      return {
        async get() { return { data: rows.slice(0, n || DB.DEFAULT_PAGE) }; }
      };
    }
  };
}

// command 构造器
// 需支持 .and() 链式：db.command.gte(a).and(db.command.lte(b))
function makeCommand() {
  const cmd = (op) => (v) => {
    const node = {
      __cmd: op,
      v,
      and(other) {
        // 组合成一个区间条件
        return { __and: [node, other] };
      }
    };
    return node;
  };
  return { gte: cmd('gte'), lte: cmd('lte'), lt: cmd('lt'), gt: cmd('gt') };
}

// ── 注入假 wx-server-sdk ──────────────────────────────────
// 云函数里没有全局 cloud，db 层统一走 sdk.js 的 ensureSdk()，
// 本地测试通过 __injectSdk 注入等价能力。
const OPENID = 'o_mock_user_001';
const mockSdk = {
  database: () => ({
    collection: (name) => makeCollection(name),
    command: makeCommand()
  }),
  getWXContext: () => ({ OPENID, ENV: 'mock-env' })
};
require(path.join(__dirname, '..', 'cloudfunctions', 'shared', 'db', 'sdk.js'))
  .__injectSdk(mockSdk);

// ── 加载被测模块（必须在注入 sdk 之后） ──────────────────
const db = require(path.join(__dirname, '..', 'cloudfunctions', 'shared', 'db', 'index.js'));
const billSvc = require(path.join(__dirname, '..', 'cloudfunctions', 'bill-svc', 'index.js'));

process.env.LLM_ENABLED = process.env.LLM_ENABLED || 'false';

let failed = 0;
function assert(cond, label) {
  console.log(`  ${cond ? '\u2713' : '\u2717 失败:'} ${label}`);
  if (!cond) failed++;
}

async function main() {
  console.log('\n【1】db.isAvailable 应为 true（已注入 mock wx-server-sdk）');
  assert(db.isAvailable() === true, 'isAvailable() 返回 true');

  console.log('\n【2】monthStat 分页：写入 45 笔，应全部统计到');
  // 月份从执行时刻推导：manual 落库不带 date，云端默认取「今天」，
  // 硬编码月份会在跨月后查不到新写入的账单（2026-11-01 实测踩中）
  const now = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  for (let i = 1; i <= 45; i++) {
    await db.insertBill({
      amount: 1000,                 // 10 元
      categoryId: 'c1_1_1',
      categoryPath: '餐饮/在家吃饭/买菜',
      date: `${month}-${String((i % 28) + 1).padStart(2, '0')}`,
      ts: Date.now() - i * 1000,
      source: 'voice',
      delFlag: false
    }, {});
  }
  const stat = await db.monthStat(OPENID, month);
  console.log(`     count=${stat.count}, total=${stat.total} 分`);
  assert(stat.count === 45, `count=45（实际 ${stat.count}）—— 若为 20 说明分页缺失`);
  assert(stat.total === 45000, `total=45000分（实际 ${stat.total}）`);

  console.log('\n【3】categoryBreakdown 分页：45 笔应聚合成一类');
  const bd = await db.categoryBreakdown(OPENID, month);
  console.log(`     items=${JSON.stringify(bd.items.map((i) => i.name + ':' + i.value))}`);
  assert(bd.items.length === 1, '只有 1 个类目');
  assert(bd.items[0].value === 45000, `聚合金额=45000（实际 ${bd.items[0].value}）`);

  console.log('\n【4】record 落库：低置信走 needConfirm ��不落库');
  const r1 = await billSvc.main({ action: 'record', payload: { asrText: '买菜100', asrConfidence: 0.9 } }, {});
  console.log(`     status=${r1.status} saved=${r1.saved}`);
  assert(r1.status === 'needConfirm', '中置信不自动入账');
  assert(r1.saved === undefined, 'needConfirm 分支不返回 saved（前端不会误判为成功）');

  console.log('\n【5】recall 落库：用户选候选后应真正写入');
  const before = DB.collections.bills.length;
  const r2 = await billSvc.main({
    action: 'recall',
    payload: {
      date: `${month}-17`,
      candidates: [{ amountCent: 6800, categoryId: 'c1_1_1', categoryPath: '餐饮/在家吃饭/买菜', note: '菜市场' }],
      chosenIndex: 0
    }
  }, {});
  console.log(`     ok=${r2.ok} saved=${r2.saved} 集合长度 ${before} → ${DB.collections.bills.length}`);
  assert(r2.saved === true, 'recall 返回 saved=true');
  assert(DB.collections.bills.length === before + 1, '集合长度 +1，数据真的写进去了');
  const last = DB.collections.bills[DB.collections.bills.length - 1];
  assert(last.amount === 6800, '金额为整数分 6800');
  assert(last.userId === OPENID, 'userId 来自 getWXContext，不是传入值');
  assert(last.source === 'recall' && last.isRecall === true, '补记标记正确');

  console.log('\n【6】manual 落库：直填模式应真正写入');
  const before2 = DB.collections.bills.length;
  const r3 = await billSvc.main({
    action: 'manual',
    payload: { amountCent: 10000, categoryId: 'c1_1_1', categoryPath: '餐饮/在家吃饭/买菜', note: '菜市场' }
  }, {});
  console.log(`     ok=${r3.ok} saved=${r3.saved} 集合长度 ${before2} → ${DB.collections.bills.length}`);
  assert(r3.saved === true, 'manual 返回 saved=true');
  assert(DB.collections.bills.length === before2 + 1, '数据真的写进去了');
  const last2 = DB.collections.bills[DB.collections.bills.length - 1];
  assert(last2.source === 'manual', 'source=manual');
  assert(last2.isRecall === false, '不标记为补记');
  assert(last2.confidence === 1, '人工录入置信度为 1');

  console.log('\n【7】写入后能立即查回（验证 read-after-write）');
  const stat2 = await db.monthStat(OPENID, month);
  assert(stat2.count === 47, `count=47（实际 ${stat2.count}）—— 新写入的 2 笔应被查到`);
  assert(stat2.total === 45000 + 6800 + 10000, `total=61800（实际 ${stat2.total}）`);

  console.log('\n【8】分页函数 fetchAll 直接验证');
  const all = await db.fetchAll(
    makeCollection('bills'),
    { userId: OPENID, delFlag: false }
  );
  console.log(`     fetchAll 拿到 ${all.length} 条`);
  assert(all.length === 47, `fetchAll 拿全 47 条（实际 ${all.length}）`);

  console.log('\n==================================================================');
  console.log(failed ? `  结论：${failed} 项失败` : ' 结论：持久化链路全部通过 ✅');
  console.log('==================================================================');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('运行异常：', e);
  process.exit(1);
});