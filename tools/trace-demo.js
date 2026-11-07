#!/usr/bin/env node
/**
 * 本地生成一份 agent 执行链路 trace
 *
 * ## 为什么需要这个
 *
 * 云函数日志要在控制台里复制粘贴，本地排查不方便。
 * 这个脚本用 mock 的模型响应在本地跑一遍完整链路，
 * 直接产出可读报告——改 Prompt 时用它做快速回归。
 *
 * ## 用法
 *
 *   node tools/trace-demo.js              # 输出人读报告
 *   node tools/trace-demo.js --log out.log # 同时输出原始日志
 *
 * ⚠️ 这里用 mock 的模型响应，不消耗 API、不需要 Key。
 * 它验证的是**链路与埋点是否正常**，不是模型效果。
 */

const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const SHARED = path.join(ROOT, 'cloudfunctions', 'analysis-svc', 'shared');

// 本地跑也要开详细模式
process.env.DEBUG_TRACE = 'true';

/**
 * ⚠️ 必须设一个假Key，否则 getApiKey() 返回空 → 直接进 mock 模式 → 永远走降级路径
 *
 * 这里不会真的请求 DeepSeek——下面的 global.fetch 已经被替换掉了，
 * 所以这个假Key 只是为了绕过「无Key不进请求」的判断。
 */
process.env.DEEPSEEK_API_KEY = 'local-dummy-key';

// ── mock 云数据库 ──
const BILLS = [
  { amount: 50450, date: '2026-10-01', categoryPath: '交通出行/日常交通/加油', categoryId: 'c2_1_5', note: '95号油' },
  { amount: 20000, date: '2026-10-01', categoryPath: '餐饮/外出就餐/火锅烧烤', categoryId: 'c1_2_2', note: '同事聚餐' },
  { amount: 20000, date: '2026-10-02', categoryPath: '育儿教育/教育支出/学费', categoryId: 'c4_2_1', note: '孩子学费' },
  { amount: 50000, date: '2026-10-02', categoryPath: '服饰美容/衣物鞋帽/衣物', categoryId: 'c6_1_1', note: '买外套' },
  { amount: 8000, date: '2026-10-03', categoryPath: '会员订阅/视频会员/视频会员', categoryId: 'c8_3_1', note: '追剧用' }
];

const sdk = require(path.join(SHARED, 'db', 'sdk.js'));

/**
 * 内存版 users 集合
 *
 * ⚠️ 必须实现 doc().set() —— 少了它 saveInsight 会报
 * 「doc is not a function」，落库失败会在日志里刷出一段无意义的堆栈，
 * 干扰阅读（demo 的重点是 trace，不是落库）。
 */
let insightStore = null;
const notFound = () => {
  const e = new Error('document not exist');
  e.errMsg = 'document.get:fail -502005 document not exist';
  throw e;
};
const userCol = {
  where() { return { limit() { return this; }, async get() { return { data: [] }; } }; },
  async get() { notFound(); },
  doc(id) {
    return {
      async get() { if (!insightStore) notFound(); return { data: insightStore }; },
      async set({ data }) { insightStore = { _id: id, ...data }; return {}; }
    };
  }
};

sdk.__injectSdk({
  database: () => ({
    collection: (name) => {
      if (name === 'users') return userCol;
      return {
        where() { return this; },
        skip() { return this; },
        limit() { return this; },
        orderBy() { return this; },
        async get() { return { data: BILLS }; }
      };
    },
    command: {
      gte: () => ({ and: () => ({}) }),
      lte: () => ({ and: () => ({}) })
    }
  }),
  getWXContext: () => ({ OPENID: 'local_demo', ENV: 'local' })
});

// ── mock 模型：第 1 轮调工具，第 2 轮给结论 ──
let round = 0;
/**
 * ⚠️ 注入 http-client 而不是 global.fetch
 * 云端走 https 模块，mock 必须走同一条路。
 *
 * ⚠️ 这个 require 必须在下面 __setImpl 调用**之前**：
 * `const` 有暂时性死区（TDZ），声明之前的引用会抛
 * ReferenceError: Cannot access 'httpClient' before initialization。
 */
const httpClient = require(path.join(SHARED, 'util', 'http-client.js'));

httpClient.__setImpl(async () => {
  round++;
  if (round === 1) {
    return {
      ok: true, status: 200,
      json: async () => ({
        choices: [{
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'c1', type: 'function', function: { name: 'get_compressibility', arguments: '{}' } },
              { id: 'c2', type: 'function', function: { name: 'get_noted_bills', arguments: '{"limit":10}' } },
              { id: 'c3', type: 'function', function: { name: 'get_recurring_patterns', arguments: '{}' } }
            ]
          }
        }],
        usage: { prompt_tokens: 1180, completion_tokens: 120, total_tokens: 1300 }
      })
    };
  }
  return {
    ok: true, status: 200,
    json: async () => ({
      choices: [{
        message: {
          role: 'assistant',
          content: JSON.stringify({
            insights: [
              '刚性支出 200.00 元，占 13.8%（孩子学费），属于生活必需，不建议压缩',
              '交通出行 554.50 元占 38.1%，其中 504.50 元是通勤加油，属固定支出',
              '服饰美容 500.00 元占 35.6%，备注是买外套，属可选支出'
            ],
            savings: [{
              category: '服饰美容',
              title: '外套可延后购买',
              amount: '500.00',
              action: '本月服饰 500 元，若非必需可等换季打折时再买',
              trigger: '非必需衣物可延后',
              reason: '备注为「买外套」，属可选支出而非生活必需',
              confidence: 'low'
            }]
          })
        }
      }],
      usage: { prompt_tokens: 320, completion_tokens: 180, total_tokens: 500 }
    })
  };
});

// ── 跑一遍 ──
const svc = require(path.join(ROOT, 'cloudfunctions', 'analysis-svc', 'index.js'));

// ⚠️ 必须显式传 month 与上方 mock 账单（BILLS 全是 2026-10）对齐：
// 不传则按「当前月」分析，跨月后 cur=[] 触发 buildInsights 空数据早退，
// 不调 LLM、无 TRACE 行，trace-view 测试直接红（2026-11-01 实测踩中）
svc.main({ action: 'refreshInsight', payload: { month: '2026-10' } }, { OPENID: 'local_demo', ENV: 'local' })
  .then((r) => {
    console.log('\n────────── 执行结果 ──────────');
    console.log('isFallback:', r.data.meta.isFallback, r.data.meta.reason || '');
    console.log('结论', (r.data.insights || []).length, '条, 建议', (r.data.savings || []).length, '条');
    (r.data.savings || []).forEach((s) => {
      console.log(`  * ${s.title} 省${s.amount}（模型填的是 500.00，被代码重算为 ${s.amount}）`);
    });

    // 输出原始日志供 trace-view 解析
    const logFile = process.argv.includes('--log')
      ? process.argv[process.argv.indexOf('--log') + 1]
      : null;
    if (logFile) {
      console.log('\n提示：原始日志已在上方输出，复制 [TRACE: 开头的行即可喂给 trace-view.js');
    }
  })
  .catch((e) => {
    console.error('执行失败：', e.message);
    process.exit(1);
  });
