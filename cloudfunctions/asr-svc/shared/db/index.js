/**
 * 云数据库访问层 —— 技术文档 §4.1
 *
 * 设计要点（都是踩过才知道的约束）：
 *
 * 1. **金额一律整数分**。浮点数存钱必然出现 0.1+0.2 问题，
 *    数据库里出现19.999999会让用户失去信任。存储用分，展示时才除。
 *
 * 2. **collection 名在云开发控制台手工创建**，代码里用 createCollection
 *    会失败（无权限），因此这里只做存在性检查后给出明确提示。
 *
 * 3. **单次查询上限 100 条**、批量写 20 条/次。查询历史流水必须分页，
 *    否则用户记账三个月后明细页直接崩。
 *
 * 4. **openid 必须来自 getWXContext**，绝不能从 event 里取——
 *    event 是前端可构造的，从里面取 openid 等于把数据写权限交给客户端。
 */

const { COLLECTIONS, FAMILY } = require('../util/constants');
const crypto = require('crypto');
const dateUtil = require('../util/date');
const sdkBoot = require('./sdk');

/** 当前可用的 wx-server-sdk 实例（不可用为 null） */
function cloudSdk() {
  return sdkBoot.ensureSdk();
}

/**
 * 取当前用户 openid
 *
 * 优先级：getWXContext > context.OPENID
 * ⚠ 绝不能从 event 里取 openid——event 由前端构造，
 *   从里面取等于把「写任意用户数据」的权限交给客户端。
 *
 * @param {object} context 云函数上下文
 * @returns {string|null}
 */
function currentOpenId(context) {
  const sdk = cloudSdk();
  try {
    if (sdk && sdk.getWXContext) {
      const wxContext = sdk.getWXContext();
      if (wxContext && wxContext.OPENID) return wxContext.OPENID;
    }
  } catch (e) {
    console.warn('[db] getWXContext 失败', e.message);
  }
  // 本地调试 / 单元测试时走这里
  if (context && context.OPENID) return context.OPENID;
  return null;
}

/**
 * 取云函数上下文（openid / env）
 *
 * @returns {object} getWXContext 结果；SDK 不可用时返回 {}
 */
function getWxContext() {
  const sdk = cloudSdk();
  if (!sdk || !sdk.getWXContext) return {};
  try {
    return sdk.getWXContext() || {};
  } catch (e) {
    console.warn('[db] getWXContext 失败', e.message);
    return {};
  }
}

/**
 * 云数据库是否可用
 *
 * 判据是 wx-server-sdk 是否成功 require + init，
 * **不是** `typeof cloud !== 'undefined'`——
 * 云函数运行时根本没有全局 cloud，用它判断必然恒为 false。
 */
function isAvailable() {
  return !!cloudSdk();
}

/** 初始化失败原因（诊断用） */
function sdkInitError() {
  cloudSdk(); // 触发一次加载，把错误捕获下来
  return sdkBoot.getInitError();
}

/** 确保云数据库可用（不主动建集合） */
function getDb() {
  const sdk = cloudSdk();
  if (!sdk) {
    throw new Error(
      sdkBoot.getInitError() || '云数据库不可用：请确认在微信云函数环境中运行'
    );
  }
  return sdk.database();
}

/**
 * 写入一笔流水
 *
 * @param {object} bill 由 bill-svc 的 buildBill 构造
 * @param {object} context
 * @returns {Promise<object>} 含 _id 的完整记录
 */
async function insertBill(bill, context) {
  const openid = currentOpenId(context);
  if (!openid) throw new Error('无法获取用户身份');
  return insertBillFor(openid, bill);
}

/**
 * 以指定 userId 写入流水 —— 定时任务专用
 *
 * ## 为什么不能复用 insertBill
 *
 * insertBill 的 userId 强制来自 getWXContext（防前端伪造），
 * 但定时触发器**没有用户上下文**（OPENID 为空），照走会直接 throw。
 * 定时任务（dailyRecurring）的账单归属必须来自规则文档里的 rule.userId，
 * 由调度层自己保证「只为该用户自己的规则写账单」。
 *
 * ⚠ 这个函数不能暴露给任何前端 action 调用，否则等于把
 * 「写任意用户数据」的权限交给客户端。
 */
async function insertBillAsUser(bill, userId) {
  if (!userId) throw new Error('insertBillAsUser 缺少 userId');
  return insertBillFor(userId, bill);
}

/** insertBill / insertBillAsUser 共用的落库核心 */
async function insertBillFor(openid, bill) {
  const db = getDb();
  const now = Date.now();

  const record = {
    ...bill,
    userId: openid,
    amount: Math.round(bill.amount),  // 强制取整，杜绝浮点残留
    createTime: now,
    updateTime: now,
    delFlag: false
  };

  let res;
  try {
    res = await db.collection(COLLECTIONS.BILLS).add({ data: record });
  } catch (e) {
    const raw = e.errMsg || e.message || String(e);
    if (/not exist|does not exist|not found|集合/i.test(raw)) {
      // 集合不存在是 P0 阶段最高频的部署问题，
      // 且原始报错对非技术用户毫无意义，这里翻译成可执行的动作
      throw new Error(
        `集合 ${COLLECTIONS.BILLS} 不存在，无法保存。请在开发者工具点击「云开发」→「数据库」→ 新建集合，名称填 bills。`
      );
    }
    if (/permission|unauthorized|auth/i.test(raw)) {
      throw new Error(`无写入权限：${raw}。请在云开发控制台把 ${COLLECTIONS.BILLS} 的权限设为「所有用户可读，仅创建者可读写」。`);
    }
    throw e;
  }
  return { ...record, _id: res._id };
}

/**
 * 列出「需要重新分析」的用户
 *
 * ## 为什么定时任务必须自己找用户
 *
 * 官方文档明确：**定时触发器运行时没有用户上下文**，
 * getWXContext().OPENID 为空。所以定时任务不能问「给谁分析」，
 * 只能自己从数据库把用户捞出来。
 *
 * ## 判定标准：宁少不多
 *
 * 每天给所有用户重跑会持续烧 LLM 额度，而绝大多数用户当天没记新账，
 * 重算出来与昨天一模一样。所以只捞两类：
 *   1. 从没分析过的用户（users 集合里没有对应文档）
 *   2. 本月账单有新增、但分析结果早于最后一次记账的用户
 *
 * 「有新账单」用**账单的 createTime 上限**与**结果的 generateTime**比较，
 * 不需要额外字段，也不需要维护「最后分析到哪笔账」的游标。
 *
 * @param {string} month YYYY-MM
 * @param {object} opts { limit, cursor }
 */
async function listPendingInsightUsers(month, opts = {}) {
  const db = getDb();
  if (!db) return { users: [], totalCandidates: 0, exhausted: true };

  const limit = Math.min(Number(opts.limit) || 20, 100);
  const cursor = Math.max(Number(opts.cursor) || 0, 0);

  // 1) 本月有账单的用户（distinct 在云开发里不可靠，改用拉取后去重）
  const where = {
    delFlag: false,
    date: db.command.gte(`${month}-01`).and(db.command.lte(`${month}-31`))
  };
  const bills = await fetchAll(db.collection(COLLECTIONS.BILLS), where);

  // 统计每个用户本月：笔数、最后一次「变动」时间
  //
  // ⚠️ 必须取 max(createTime, updateTime)，不能只看 createTime
  //
  // 编辑账单（amend）只更新 updateTime，createTime 保持首次写入时间不变。
  // 若只看 createTime：用户把 100 元改成 500 元后，
  // 分析结果不会过期 → 分析页一直展示基于 100 元的结论（占比、节省建议全错）。
  // 而「结论基于旧数据」比「不显示结论」严重得多。
  const profile = new Map();
  for (const b of bills) {
    const uid = b.userId;
    if (!uid) continue;
    const cur = profile.get(uid);
    // 账单最后一次「发生变动」的时间：新增看 createTime，编辑看 updateTime
    const t = Math.max(Number(b.createTime) || 0, Number(b.updateTime) || 0);
    if (!cur) {
      profile.set(uid, { openid: uid, count: 1, lastWrite: t });
    } else {
      cur.count++;
      if (t > cur.lastWrite) cur.lastWrite = t;
    }
  }

  if (!profile.size) {
    return { users: [], totalCandidates: 0, exhausted: true };
  }

  // 2) 查已有分析结果，判断哪些过期
  let existing = [];
  try {
    const res = await db.collection(COLLECTIONS.USERS)
      .where({ month })
      .limit(100)
      .get();
    existing = res.data || [];
  } catch (e) {
    // 集合不存在 → 所有人都算「待分析」，这是正常初始状态
    existing = [];
  }

  const genTime = new Map();
  for (const doc of existing) {
    if (doc && doc.userId) genTime.set(doc.userId, Number(doc.generateTime) || 0);
  }

  // 3) 判定
  const pending = [];
  for (const [uid, p] of profile) {
    const gen = genTime.get(uid);
    // 没分析过，或分析完之后又有新账单
    if (gen === undefined || gen < p.lastWrite) pending.push(uid);
  }

  // 排序保证分页稳定：按 openid 字典序，否则 cursor 分页会漏掉/重复
  pending.sort();

  const page = pending.slice(cursor, cursor + limit);
  const nextCursor = cursor + page.length;
  const exhausted = nextCursor >= pending.length;

  return {
    users: page,
    totalCandidates: pending.length,
    nextCursor: exhausted ? 0 : nextCursor,
    exhausted
  };
}

/**
 * 保存消费分析结果
 *
 * ## 为什么存到 users 而不是每次现算
 *
 * 现算的代价：分析要跑 LLM + 最多 3 轮工具往返，10 秒起步。
 * 用户打开分析页却要等 10 秒——而这些结果**当天基本不变**，
 * 昨天算的结论今天早上看依然成立。
 * 所以改为「记账后算好存起来，页面直接读」，把 10 秒的等待移出用户路径。
 *
 * ## 文档结构
 *   _id:     `${openid}_insight` —— 固定 ID，天然一用户一份，天然隔离
 *   userId:  openid，查询时用它兜底校验（防止越权读到别人数据）
 *   month:   结果对应的统计月份。跨月后旧结果仍保留但会标记过期
 *   version: 结果格式版本。改数据结构时用它识别老数据而不是直接崩掉
 *   generateTime: 生成时间戳，前端据此提示「数据更新于 X」
 *
 * @param {string} openid
 * @param {object} insight 分析结果
 * @param {string} month
 * @param {string} version
 */
async function saveInsight(openid, insight, month, version = 'v2') {
  const db = getDb();
  if (!db) return { saved: false, savedError: '数据库未就绪' };

  const now = Date.now();
  const docId = `${openid}_insight`;

  const data = {
    userId: openid,
    month,
    version,
    insights: insight.insights || [],
    savings: insight.savings || [],
    pie: insight.pie || [],
    total: insight.total || '',
    billCount: insight.billCount || 0,
    deltaText: insight.deltaText || '',
    deltaDirection: insight.deltaDirection || '',
    trend: insight.trend || [],
    meta: insight.meta || {},
    generateTime: now,
    updateTime: now
  };

  try {
    // 先尝试更新（命中已有文档），失败再新增。
    // 用「固定 _id + upsert」而非 query-then-write：
    // 后者在并发下会插出两条重复记录。
    const res = await db.collection(COLLECTIONS.USERS)
      .doc(docId)
      .set({ data });
    return { saved: true, docId };
  } catch (e) {
    const raw = e.errMsg || e.message || String(e);
    if (/not exist|does not exist|not found|集合/i.test(raw)) {
      throw new Error(
        `集合 ${COLLECTIONS.USERS} 不存在。请在云开发控制台 → 数据库 → 新建集合，名称填 users。`
      );
    }
    if (/permission|unauthorized|auth/i.test(raw)) {
      throw new Error(
        `无写入权限：${raw}。请把 ${COLLECTIONS.USERS} 权限设为「仅创建者可读写」（分析结果含隐私，不应公开可读）。`
      );
    }
    throw e;
  }
}

/**
 * 读取消费分析结果
 *
 * @param {string} openid
 * @param {string} month 只读该月的结果；不传则读最新一份
 * @returns {Promise<object|null>} 无结果时返回 null（由上层决定如何呈现）
 */
async function getInsight(openid, month) {
  const db = getDb();
  if (!db) return null;

  const docId = `${openid}_insight`;

  try {
    const res = await db.collection(COLLECTIONS.USERS).doc(docId).get();
    const doc = (res && res.data) || null;
    if (!doc) return null;

    // 越权防护：即便 docId 猜对了，userId 不匹配也必须拒绝。
    // 这是唯一的安全边界——openid 不可预测不等于不可伪造。
    if (doc.userId && doc.userId !== openid) return null;

    // 指定月份但存的是别的月份 → 视为没有结果。
    // 不能把上个月的结论当成这个月的展示，那是**错误信息**而非「旧数据」。
    if (month && doc.month && doc.month !== month) {
      return { ...doc, _stale: true };
    }

    return doc;
  } catch (e) {
    // 文档不存在是正常情况（还没分析过），不是错误
    const raw = e.errMsg || e.message || String(e);
    if (/not exist|does not exist|-502005|DOCUMENT_NOT_FOUND/i.test(raw)) return null;
    return null;
  }
}

/**
 * 读取用户档案（登录 + 可选资料 + 家庭归属）
 *
 * ## 为什么与 insight 文档同集合不同键
 *
 * 文档 `_id = ${openid}_profile`，与 `${openid}_insight` 前缀区分键空间，
 * 共存于 users 集合。profile 文档**没有顶层 month 字段**，
 * 因此不会被 listPendingInsightUsers 的 where({month}) 捞进每日分析扫描。
 *
 * @param {string} openid
 * @returns {Promise<object|null>} 从未注册过返回 null（由上层触发自动注册）
 */
async function getProfile(openid) {
  const db = getDb();
  if (!db) return null;

  const docId = `${openid}_profile`;

  try {
    const res = await db.collection(COLLECTIONS.USERS).doc(docId).get();
    const doc = (res && res.data) || null;
    if (!doc) return null;

    // 越权双保险：固定 _id 已按 openid 隔离，这层防伪造（与 getInsight 同款）
    if (doc.userId && doc.userId !== openid) return null;

    return doc;
  } catch (e) {
    // 文档不存在 = 尚未注册，是正常初始态，不是错误
    const raw = e.errMsg || e.message || String(e);
    if (/not exist|does not exist|-502005|DOCUMENT_NOT_FOUND/i.test(raw)) return null;
    return null;
  }
}

/**
 * 保存/更新用户档案（登录自动注册 + 可选资料共用）
 *
 * ## 为什么「读旧档 + set() 合并」而不是 update()
 *
 * update 对不存在的文档是静默 no-op（stats.updated=0），无法区分
 * 「没更新」和「不存在」，自动注册需要「不存在就创建」。
 * 固定 _id + set() upsert 与 saveInsight 同款：并发下不会插出两条。
 * 代价是并发更新会丢一个字段（last write wins）—— 资料修改是低频操作，可接受。
 *
 * ## 字段白名单纪律（与 saveInsight 同款）
 *
 * 不在白名单里的字段一律不落库 —— 防调用方塞任意字段污染文档。
 * 无值字段不写 null（部分环境 null 会触发写入异常）。
 * familyId 显式传 '' 表示清空（退出家庭）。
 *
 * @param {string} openid
 * @param {object} fields { nickname?, avatarUrl?, familyId? }
 */
async function saveProfile(openid, fields = {}) {
  const db = getDb();
  if (!db) return { saved: false, savedError: '数据库未就绪' };

  const now = Date.now();
  const existing = await getProfile(openid);
  const docId = `${openid}_profile`;

  const data = {
    userId: openid,
    createTime: (existing && existing.createTime) || now,
    updateTime: now
  };
  if (typeof fields.nickname === 'string' && fields.nickname) data.nickname = fields.nickname.slice(0, 30);
  if (typeof fields.avatarUrl === 'string' && fields.avatarUrl) data.avatarUrl = fields.avatarUrl.slice(0, 500);
  // familyId：传 '' 清空（退出家庭）；不传则保留旧值
  if (fields.familyId !== undefined) {
    data.familyId = String(fields.familyId || '');
  } else if (existing && existing.familyId) {
    data.familyId = existing.familyId;
  }

  try {
    await db.collection(COLLECTIONS.USERS).doc(docId).set({ data });
    return { saved: true, docId };
  } catch (e) {
    const raw = e.errMsg || e.message || String(e);
    if (/not exist|does not exist|not found|集合/i.test(raw)) {
      throw new Error(
        `集合 ${COLLECTIONS.USERS} 不存在。请在云开发控制台 → 数据库 → 新建集合，名称填 users。`
      );
    }
    if (/permission|unauthorized|auth/i.test(raw)) {
      throw new Error(
        `无写入权限：${raw}。请把 ${COLLECTIONS.USERS} 权限设为「仅创建者可读写」。`
      );
    }
    throw e;
  }
}

/* ── 家庭模式（families 集合）── */

/**
 * 生成邀请码：8 位，字符集排除易混字符 0/O/1/I
 *
 * 碰撞概率 32^-8 量级，不查重 —— 即使碰撞，
 * familyJoin 的 where({inviteCode}) 也只会命中其中之一，不产生安全问题。
 */
function genInviteCode() {
  const a = FAMILY.INVITE_ALPHABET;
  const bytes = crypto.randomBytes(FAMILY.INVITE_CODE_LENGTH);
  let code = '';
  for (let i = 0; i < bytes.length; i++) code += a[bytes[i] % a.length];
  return code;
}

/**
 * 读家庭文档（不存在 / 已解散返回 null）
 *
 * 集合不存在必须明确报错带建表指引 —— 静默返回 null 会让用户
 * 以为「家庭被解散了」，实际是 families 集合没建。
 */
async function familyGet(familyId) {
  const db = getDb();
  if (!db || !familyId) return null;

  try {
    const res = await db.collection(COLLECTIONS.FAMILIES).doc(familyId).get();
    const doc = (res && res.data) || null;
    if (!doc || doc.delFlag) return null;
    return doc;
  } catch (e) {
    const raw = e.errMsg || e.message || String(e);
    if (/collection|集合/i.test(raw) && /not exist|does not exist|not found/i.test(raw)) {
      throw new Error(
        `集合 ${COLLECTIONS.FAMILIES} 不存在。请在云开发控制台 → 数据库 → 新建集合，名称填 families。`
      );
    }
    // 文档不存在是正常状态（家庭被解散）
    if (/not exist|does not exist|not found|-502005|DOCUMENT_NOT_FOUND/i.test(raw)) return null;
    throw e;
  }
}

/**
 * 创建家庭（创建者自动成为第一个成员）
 *
 * 家庭归属唯一权威：profile.familyId（云端反查，不信任前端）。
 * members 不单独存文档 —— 成员 = users 集合里 familyId 相等的 profile 文档，
 * 单一数据源，不会出现「成员表与档案表不一致」。
 */
async function familyCreate(openid, name) {
  const db = getDb();
  const profile = await getProfile(openid);
  if (profile && profile.familyId) throw new Error('您已加入其他家庭，请先退出当前家庭');

  const now = Date.now();
  const doc = {
    name: String(name || '').trim().slice(0, 20),
    ownerId: openid,
    inviteCode: genInviteCode(),
    inviteExpiresAt: now + FAMILY.INVITE_TTL_MS,
    delFlag: false,
    createTime: now,
    updateTime: now
  };
  if (!doc.name) throw new Error('家庭名称不能为空');

  const res = await db.collection(COLLECTIONS.FAMILIES).add({ data: doc });
  await saveProfile(openid, { familyId: res._id });
  return { ...doc, _id: res._id };
}

/**
 * 凭邀请码加入家庭
 *
 * 上限判断读的是 users 集合里 familyId 相等的**真实文档数**（应用侧过滤
 * 掉家庭 insight 文档），不维护 memberCount 字段 —— 读改写计数在并发下
 * 必然漂移，真实数没有这个问题。
 */
async function familyJoin(openid, inviteCode) {
  const db = getDb();
  const profile = await getProfile(openid);
  if (profile && profile.familyId) throw new Error('您已加入其他家庭，请先退出当前家庭');

  const code = String(inviteCode || '').trim().toUpperCase();
  if (!code) throw new Error('请输入邀请码');

  const res = await db.collection(COLLECTIONS.FAMILIES)
    .where({ inviteCode: code, delFlag: false })
    .limit(1)
    .get();
  const fam = (res.data && res.data[0]) || null;
  if (!fam) throw new Error('邀请码错误或已失效');
  if (fam.inviteExpiresAt && fam.inviteExpiresAt < Date.now()) {
    throw new Error('邀请码已过期，请联系家庭创建者重新生成');
  }

  const memberRes = await db.collection(COLLECTIONS.USERS)
    .where({ familyId: fam._id })
    .limit(FAMILY.MAX_MEMBERS + 10)
    .get();
  const memberCount = (memberRes.data || []).filter((u) => u.userId).length;
  if (memberCount >= FAMILY.MAX_MEMBERS) {
    throw new Error(`家庭已满员（上限 ${FAMILY.MAX_MEMBERS} 人）`);
  }

  await saveProfile(openid, { familyId: fam._id });
  return fam;
}

/**
 * 家庭成员列表（按加入时间排序）
 *
 * ⚠️ users 集合混存 profile / insight / 家庭 insight 三种文档，
 * where({familyId}) 会把家庭 insight 也捞出来 —— 应用侧过滤掉
 * 没有 userId 的文档（profile 必有 userId）。
 */
async function familyMembers(familyId) {
  const db = getDb();
  const res = await db.collection(COLLECTIONS.USERS)
    .where({ familyId })
    .limit(FAMILY.MAX_MEMBERS + 10)
    .get();
  return (res.data || [])
    .filter((u) => u.userId)
    .sort((a, b) => (a.createTime || 0) - (b.createTime || 0))
    .map((u) => ({
      userId: u.userId,
      nickname: u.nickname || '',
      avatarUrl: u.avatarUrl || ''
    }));
}

/**
 * 退出家庭（创建者不能退出，只能解散）
 *
 * 历史家庭账单保留在 family_bills（记录人 userId 不清除），
 * 退出后成员资格校验失效 → 自然不可再读。这正是「账单留在家庭」的语义。
 */
async function familyLeave(openid) {
  const profile = await getProfile(openid);
  if (!profile || !profile.familyId) throw new Error('您还没有加入任何家庭');

  const fam = await familyGet(profile.familyId);
  if (!fam) {
    // 家庭已解散但档案没清干净 —— 顺手清掉，避免卡在「幽灵归属」
    await saveProfile(openid, { familyId: '' });
    throw new Error('家庭不存在或已解散');
  }
  if (fam.ownerId === openid) throw new Error('创建者不能退出家庭，可解散家庭');

  await saveProfile(openid, { familyId: '' });
  // 退出后该成员的家庭规则全部自动暂停（口径：退出自动暂停，不写无主家庭账单）
  await pauseFamilyRecurringRules(openid, fam._id);
  return fam;
}

/**
 * 重新生成邀请码（仅创建者；旧码立即失效）
 */
async function familyRegenCode(openid) {
  const profile = await getProfile(openid);
  if (!profile || !profile.familyId) throw new Error('您还没有加入任何家庭');

  const fam = await familyGet(profile.familyId);
  if (!fam) throw new Error('家庭不存在或已解散');
  if (fam.ownerId !== openid) throw new Error('只有家庭创建者可以重新生成邀请码');

  const now = Date.now();
  const inviteCode = genInviteCode();
  const inviteExpiresAt = now + FAMILY.INVITE_TTL_MS;
  await getDb().collection(COLLECTIONS.FAMILIES).doc(fam._id)
    .update({ data: { inviteCode, inviteExpiresAt, updateTime: now } });
  return { inviteCode, inviteExpiresAt };
}

/**
 * 解散家庭（仅创建者）
 *
 * 语义 = 软删除：families 置 delFlag、邀请码清空、全员 profile.familyId 清空。
 * family_bills 里的历史账单**保留在库**（记录不删，与 bills 软删除同纪律），
 * 但家庭已不可达 —— 等价于「账单留在家庭」。
 */
async function familyDissolve(openid) {
  const profile = await getProfile(openid);
  if (!profile || !profile.familyId) throw new Error('您还没有加入任何家庭');

  const fam = await familyGet(profile.familyId);
  if (!fam) throw new Error('家庭不存在或已解散');
  if (fam.ownerId !== openid) throw new Error('只有家庭创建者可以解散家庭');

  const members = await familyMembers(fam._id);
  // 成员 ≤8 人，逐条清空归属（量小，且避免 where().update() 的 mock 兼容问题）；
  // 同步暂停每个成员的家庭规则（口径：解散自动暂停，与退出同款）
  for (const m of members) {
    await saveProfile(m.userId, { familyId: '' });
    await pauseFamilyRecurringRules(m.userId, fam._id);
  }
  await getDb().collection(COLLECTIONS.FAMILIES).doc(fam._id)
    .update({ data: { delFlag: true, inviteCode: '', updateTime: Date.now() } });
  return fam;
}

/* ── 家庭账单（family_bills 集合，与 bills 同构 + familyId） ──
 *
 * 文档结构与 bills 完全一致（明细页 groupByDate / 统计清洗零改动复用），
 * 只多一个 familyId 字段。userId 仍是**记录人**，不是归属——
 * 家庭账本全员可见可记，归属由 familyId 表达。
 */

/**
 * 写入家庭账本流水 —— 家庭成员全员可记
 *
 * 与 insertBill 同纪律：userId 强制来自 getWXContext（记录人，防伪造）。
 * familyId **必须由调用方通过 profile 云端反查后传入**（bill-svc 的
 * resolveLedger 完成），绝不由前端直接给 —— 前端只传 ledger:'family'。
 *
 * @param {string} familyId
 * @param {object} bill 由 bill-svc 的 buildBill 构造
 * @param {object} context
 */
async function insertFamilyBill(familyId, bill, context) {
  const openid = currentOpenId(context);
  if (!openid) throw new Error('无法获取用户身份');
  return insertFamilyBillFor(openid, familyId, bill);
}

/**
 * 以指定 userId 写入家庭账本 —— 定时任务专用
 *
 * 与 insertBillAsUser 同款理由：定时触发器没有用户上下文
 * （OPENID 为空），insertFamilyBill 照走会直接 throw。
 * dailyRecurring 的家庭账单归属来自规则文档里的 rule.userId
 * （= 规则创建者 = 记录人），由调度层自己保证「只为该用户
 * 自己的规则写账单」。
 *
 * ⚠ 这个函数不能暴露给任何前端 action 调用，否则等于把
 * 「写任意家庭账本」的权限交给客户端。
 */
async function insertFamilyBillAsUser(familyId, bill, userId) {
  if (!userId) throw new Error('insertFamilyBillAsUser 缺少 userId');
  return insertFamilyBillFor(userId, familyId, bill);
}

/** insertFamilyBill / insertFamilyBillAsUser 共用的落库核心 */
async function insertFamilyBillFor(openid, familyId, bill) {
  if (!familyId) throw new Error('insertFamilyBill 缺少 familyId');

  const db = getDb();
  const now = Date.now();

  const record = {
    ...bill,
    userId: openid,
    familyId,
    amount: Math.round(bill.amount),  // 强制取整，杜绝浮点残留（与 insertBill 同款）
    createTime: now,
    updateTime: now,
    delFlag: false
  };

  try {
    const res = await db.collection(COLLECTIONS.FAMILY_BILLS).add({ data: record });
    return { ...record, _id: res._id };
  } catch (e) {
    const raw = e.errMsg || e.message || String(e);
    if (/not exist|does not exist|not found|集合/i.test(raw)) {
      throw new Error(
        `集合 ${COLLECTIONS.FAMILY_BILLS} 不存在，无法保存家庭账单。` +
        `请在开发者工具点击「云开发」→「数据库」→ 新建集合，名称填 family_bills。`
      );
    }
    if (/permission|unauthorized|auth/i.test(raw)) {
      throw new Error(`无写入权限：${raw}。请在云开发控制台把 ${COLLECTIONS.FAMILY_BILLS} 的权限设为「所有用户可读，仅创建者可读写」。`);
    }
    throw e;
  }
}

/**
 * 家庭账单软删除（撤销）—— 只允许记录人撤自己的账单
 *
 * where 带 userId（与个人 bills 同纪律）：家庭成员可以看到彼此的账，
 * 但不能撤销/删除别人记的账。修改（amend）同口径，见 bill-svc。
 */
async function softDeleteFamilyBill(openid, familyId, billId) {
  const db = getDb();
  const res = await db.collection(COLLECTIONS.FAMILY_BILLS)
    .where({ _id: billId, familyId, userId: openid })
    .update({ data: { delFlag: true, updateTime: Date.now() } });
  return res.stats.updated;
}

/**
 * 查询家庭流水（分页）—— 全员可见，与 listBills 同构
 *
 * @param {string} familyId
 * @param {object} opts { date, month, limit, offset }
 */
async function listFamilyBills(familyId, opts = {}) {
  const db = getDb();
  const limit = Math.min(Number(opts.limit) || 20, 100); // 硬上限 100
  const offset = Number(opts.offset) || 0;

  const where = { familyId, delFlag: false };
  if (opts.month) where.date = db.command.gte(`${opts.month}-01`)
    .and(db.command.lte(`${opts.month}-31`));
  else if (opts.date) where.date = opts.date;

  const res = await db.collection(COLLECTIONS.FAMILY_BILLS)
    .where(where)
    .orderBy('ts', 'desc')
    .skip(offset)
    .limit(limit)
    .get();

  return res.data || [];
}

/* ── 家庭分析（v1：手动刷新；定时家庭聚合留 v2） ── */

/**
 * 家庭月度统计（首页概览）：全家聚合，与 monthStat 同口径
 */
async function familyMonthStat(familyId, month) {
  const db = getDb();
  const where = {
    familyId,
    delFlag: false,
    date: db.command.gte(`${month}-01`).and(db.command.lte(`${month}-31`))
  };

  const rows = await fetchAll(db.collection(COLLECTIONS.FAMILY_BILLS), where);

  let total = 0;
  for (const b of rows) total += b.amount || 0;
  return { total, count: rows.length };
}

/**
 * 一次性拉取家庭近 N 个月账单，按月份分组
 * 与 recentBillsByMonth 同构（家庭账本 = 全家聚合）
 */
async function familyRecentBillsByMonth(familyId, monthCount = 6, endMonth = null) {
  const end = endMonth || dateUtil.toMonthStr(new Date());

  const [ey, em] = String(end).split('-').map(Number);
  const months = [];
  for (let i = monthCount - 1; i >= 0; i--) {
    const d = new Date(ey, em - 1 - i, 1);
    months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }

  const empty = { months, byMonth: {}, totalFetched: 0, available: isAvailable() };

  const db = getDb();
  if (!db) return empty;

  const startMonth = months[0];
  const where = {
    familyId,
    delFlag: false,
    date: db.command.gte(`${startMonth}-01`).and(db.command.lte(`${end}-31`))
  };

  const rows = await fetchAll(db.collection(COLLECTIONS.FAMILY_BILLS), where);

  const byMonth = {};
  for (const r of rows) {
    const mo = String(r.date || '').slice(0, 7);
    if (!byMonth[mo]) byMonth[mo] = [];
    byMonth[mo].push(r);
  }

  return { months, byMonth, totalFetched: rows.length, available: true };
}

/**
 * 家庭账单某月的「最后变动时间」（结论过期判据，与个人同款）
 * 任一成员新增/编辑家庭账单都会让家庭结论过期。
 */
async function familyGetLatestBillChangeTime(familyId, month) {
  const db = getDb();
  if (!db) return 0;

  const where = {
    familyId,
    delFlag: false,
    date: db.command.gte(`${month}-01`).and(db.command.lte(`${month}-31`))
  };

  const rows = await fetchAll(db.collection(COLLECTIONS.FAMILY_BILLS), where);

  let latest = 0;
  for (const b of rows) {
    const t = Math.max(Number(b.createTime) || 0, Number(b.updateTime) || 0);
    if (t > latest) latest = t;
  }
  return latest;
}

/**
 * 保存家庭分析结果（users 集合，_id = family_${familyId}_insight）
 *
 * ## ⚠️ 顶层不得有 userId / month —— 这是两条真实踩过的坑
 *
 * 1. **顶层 month** 会被 listPendingInsightUsers 的 `where({month})`
 *    捞进每日个人分析扫描（family_ 文档没有 userId 也会被扫到）。
 * 2. **顶层 userId**（若写成 owner 的）会与 owner 个人 insight 的
 *    generateTime 混算，把 owner 个人分析的「是否过期」静默压制
 *    （家庭重算时 updateTime 变新 → 个人结论永不过期）。
 *
 * 所以 month 与全部结果数据都收进 payload，顶层只留 familyId /
 * version / payload / generateTime / updateTime。
 *
 * ## 字段白名单纪律：绝不复用 saveInsight
 *
 * saveInsight 的白名单硬编码了 userId + month 顶层，复用必然写坏。
 */
async function saveFamilyInsight(familyId, insight, month, version = 'v2') {
  const db = getDb();
  if (!db) return { saved: false, savedError: '数据库未就绪' };

  const now = Date.now();
  const docId = `family_${familyId}_insight`;

  const payload = {
    month,
    insights: insight.insights || [],
    savings: insight.savings || [],
    pie: insight.pie || [],
    total: insight.total || '',
    billCount: insight.billCount || 0,
    deltaText: insight.deltaText || '',
    deltaDirection: insight.deltaDirection || '',
    trend: insight.trend || [],
    meta: insight.meta || {}
  };

  const data = {
    familyId,
    version,
    payload,
    generateTime: now,
    updateTime: now
  };

  try {
    await db.collection(COLLECTIONS.USERS).doc(docId).set({ data });
    return { saved: true, docId };
  } catch (e) {
    const raw = e.errMsg || e.message || String(e);
    if (/not exist|does not exist|not found|集合/i.test(raw)) {
      throw new Error(
        `集合 ${COLLECTIONS.USERS} 不存在。请在云开发控制台 → 数据库 → 新建集合，名称填 users。`
      );
    }
    if (/permission|unauthorized|auth/i.test(raw)) {
      throw new Error(
        `无写入权限：${raw}。请把 ${COLLECTIONS.USERS} 权限设为「仅创建者可读写」。`
      );
    }
    throw e;
  }
}

/**
 * 读取家庭分析结果
 *
 * 返回**拍平后的结构**（payload 内容提升到顶层）——
 * 存储形态与读取形态分离：存储守「顶层无 month」的扫描隔离纪律，
 * 读取拍平后与 getInsight 返回结构同构，analysis-svc 可零分支复用。
 *
 * @returns {Promise<object|null>} 无结果返回 null；跨月返回带 _stale
 */
async function getFamilyInsight(familyId, month) {
  const db = getDb();
  if (!db) return null;

  const docId = `family_${familyId}_insight`;

  try {
    const res = await db.collection(COLLECTIONS.USERS).doc(docId).get();
    const doc = (res && res.data) || null;
    if (!doc) return null;

    // 越权双保险（与 getInsight 同款）：固定 _id 已按 familyId 隔离
    if (doc.familyId && doc.familyId !== familyId) return null;

    const flat = {
      ...(doc.payload || {}),
      generateTime: doc.generateTime,
      updateTime: doc.updateTime
    };

    // 指定月份但存的是别的月份 → 视为没有结果（与 getInsight 同口径）
    if (month && flat.month && flat.month !== month) {
      return { ...flat, _stale: true };
    }

    return flat;
  } catch (e) {
    // 文档不存在是正常情况（还没分析过），不是错误
    const raw = e.errMsg || e.message || String(e);
    if (/not exist|does not exist|-502005|DOCUMENT_NOT_FOUND/i.test(raw)) return null;
    return null;
  }
}

/**
 * 查询流水（分页）
 *
 * @param {string} openid
 * @param {object} opts { date, month, limit, offset }
 */
async function listBills(openid, opts = {}) {
  const db = getDb();
  const limit = Math.min(Number(opts.limit) || 20, 100); // 硬上限 100
  const offset = Number(opts.offset) || 0;

  const where = { userId: openid, delFlag: false };
  if (opts.month) where.date = db.command.gte(`${opts.month}-01`)
    .and(db.command.lte(`${opts.month}-31`));
  else if (opts.date) where.date = opts.date;

  // ⚠ orderBy + where 组合要求索引里同时包含 where 字段与排序字段，
  // 否则云开发会退化为全表扫描。建议在控制台为 bills 建复合索引：
  //   userId(升序) + date(升序) + ts(降序)
  const res = await db.collection(COLLECTIONS.BILLS)
    .where(where)
    .orderBy('ts', 'desc')
    .skip(offset)
    .limit(limit)
    .get();

  return res.data || [];
}

/**
 * 云开发单次查询默认 20 条、上限 100 条。
 * 不显式分页就会「明明记了 50 笔，概览只显示 20 笔」——
 * 这是最容易被误判成「没保存成功」的现象之一。
 */
const QUERY_PAGE_SIZE = 100;

/**
 * 拉取某个 where 条件下的全部记录（自动分页）
 *
 * @param {object} collection 已创建的集合对象
 * @param {object} where 查询条件
 * @param {number} hardCap 最多拉多少条，防止误查全表拖垮函数
 */
async function fetchAll(collection, where, hardCap = 2000) {
  const all = [];
  let offset = 0;

  while (all.length < hardCap) {
    // eslint-disable-next-line no-await-in-loop
    const page = await collection.where(where)
      .skip(offset)
      .limit(QUERY_PAGE_SIZE)
      .get();
    const data = page.data || [];
    all.push(...data);
    if (data.length < QUERY_PAGE_SIZE) break; // 最后一页
    offset += QUERY_PAGE_SIZE;
  }

  return all;
}

/**
 * 一次性拉取近 N 个月的账单，按月份分组
 *
 * 为什么需要它：消费分析要算环比（对比上月）和趋势（近 6 个月），
 * 如果每个月单独查一次就是 N 次数据库往返；且中途可能因并发写入
 * 导致各月数据不是同一时刻的快照，算出的环比对不上。
 * 一次查完再分组，既快又保证口径一致。
 *
 * @param {string} openid
 * @param {number} monthCount 往前推几个月（含当月）
 * @param {string} endMonth 结束月（YYYY-MM），默认当月
 * @returns {Promise<{months:string[], byMonth:object, totalFetched:number}>}
 */
async function recentBillsByMonth(openid, monthCount = 6, endMonth = null) {
  const end = endMonth || dateUtil.toMonthStr(new Date());

  // 先算月份列表：即使 db 不可用也要返回完整的月份骨架，
  // 否则调用方拿到的 undefined 会在 Object.keys 处炸掉，
  // 且「查不到数据」与「环境没就绪」被混为一谈
  const [ey, em] = String(end).split('-').map(Number);
  const months = [];
  for (let i = monthCount - 1; i >= 0; i--) {
    const d = new Date(ey, em - 1 - i, 1);
    months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }

  const empty = { months, byMonth: {}, totalFetched: 0, available: isAvailable() };

  const db = getDb();
  if (!db) return empty;

  const startMonth = months[0];
  const where = {
    userId: openid,
    delFlag: false,
    date: db.command.gte(`${startMonth}-01`).and(db.command.lte(`${end}-31`))
  };

  const rows = await fetchAll(db.collection(COLLECTIONS.BILLS), where);

  const byMonth = {};
  for (const r of rows) {
    const mo = String(r.date || '').slice(0, 7);
    if (!byMonth[mo]) byMonth[mo] = [];
    byMonth[mo].push(r);
  }

  return { months, byMonth, totalFetched: rows.length, available: true };
}

/** 统计月度总额与笔数（用于首页概览） */
async function monthStat(openid, month) {
  const db = getDb();
  const where = {
    userId: openid,
    delFlag: false,
    date: db.command.gte(`${month}-01`).and(db.command.lte(`${month}-31`))
  };

  const rows = await fetchAll(db.collection(COLLECTIONS.BILLS), where);

  let total = 0;
  for (const b of rows) total += b.amount || 0;
  return { total, count: rows.length };
}

/**
 * 查某用户某月账单的「最后变动时间」
 *
 * ## 为什么需要它
 *
 * 分析结果是**存下来的**（users 集合），读的时候直接返回。
 * 但账单可以被编辑（amend），编辑只改 updateTime、不改 createTime。
 * 于是会出现：结论是按 100 元算出来的，用户把它改成 500 元，
 * 分析页却依然把旧结论当最新结论展示 ——
 * **占比、节省建议全都基于旧金额，比不显示结论更糟。**
 *
 * 定时任务（dailyInsight）用同样的判据决定要不要重算，
 * 两边必须一致，否则会出现「定时任务认为过期、页面却显示为最新」的割裂。
 *
 * @returns {Promise<number>} 时间戳；无账单返回 0
 */
async function getLatestBillChangeTime(openid, month) {
  const db = getDb();
  if (!db) return 0;

  const where = {
    userId: openid,
    delFlag: false,
    date: db.command.gte(`${month}-01`).and(db.command.lte(`${month}-31`))
  };

  const rows = await fetchAll(db.collection(COLLECTIONS.BILLS), where);

  let latest = 0;
  for (const b of rows) {
    const t = Math.max(Number(b.createTime) || 0, Number(b.updateTime) || 0);
    if (t > latest) latest = t;
  }
  return latest;
}

/** 按一级类目聚合（用于饼图） */
async function categoryBreakdown(openid, month) {
  const db = getDb();
  const where = {
    userId: openid,
    delFlag: false,
    date: db.command.gte(`${month}-01`).and(db.command.lte(`${month}-31`))
  };

  const rows = await fetchAll(db.collection(COLLECTIONS.BILLS), where);

  // 注意：这里在应用侧聚合，hardCap 2000 笔以内准确。
  // 真正的生产实现应改用数据库 aggregate（服务端聚合，不受 100 条限制），
  // 已记入技术文档待办。家庭记账场景月均百笔量级，当前实现足够。
  const map = new Map();
  let total = 0;
  for (const b of rows) {
    const top = (b.categoryPath || '未分类').split('/')[0];
    map.set(top, (map.get(top) || 0) + (b.amount || 0));
    total += b.amount || 0;
  }

  return { items: [...map.entries()].map(([name, value]) => ({ name, value, total })), total };
}

/** 软删除（撤销） */
async function softDelete(openid, billId) {
  const db = getDb();
  const res = await db.collection(COLLECTIONS.BILLS)
    .where({ _id: billId, userId: openid })
    .update({ data: { delFlag: true, updateTime: Date.now() } });
  return res.stats.updated;
}

/* ══════════════════════════════════════════════════
 * 重复记账规则（recurring 集合）
 *
 * 规则与账单分离：规则是「配置」，到点由 dailyRecurring 生成账单。
 * 查询全部带 delFlag: false（与 bills 同纪律），userId 一律由调用方
 * 传入（openid 取法见 currentOpenId，绝不能从 event 里取）。
 * ══════════════════════════════════════════════════ */

/**
 * 新增重复记账规则
 * @param {object} rule { userId, amount, categoryId, categoryPath, note,
 *   account, repeat, status, nextDate } —— 校验在 bill-svc 完成
 * @returns {Promise<object>} 含 _id 的完整文档
 */
async function insertRecurringRule(rule) {
  const db = getDb();
  const now = Date.now();
  const doc = {
    ...rule,
    delFlag: false,
    createTime: now,
    updateTime: now
  };
  try {
    const res = await db.collection(COLLECTIONS.RECURRING).add({ data: doc });
    return { ...doc, _id: res._id };
  } catch (e) {
    const raw = e.errMsg || e.message || String(e);
    if (/not exist|does not exist|not found|集合/i.test(raw)) {
      throw new Error(
        `集合 ${COLLECTIONS.RECURRING} 不存在，无法保存重复记账规则。` +
        `请在开发者工具点击「云开发」→「数据库」→ 新建集合，名称填 recurring。`
      );
    }
    if (/permission|unauthorized|auth/i.test(raw)) {
      throw new Error(`无写入权限：${raw}。请把 ${COLLECTIONS.RECURRING} 权限设为「所有用户可读，仅创建者可读写」。`);
    }
    throw e;
  }
}

/**
 * 列出用户的重复记账规则
 * 单用户规则量级很小（十几条封顶），一次取完（limit 100）
 */
async function listRecurringRules(openid) {
  const db = getDb();
  const res = await db.collection(COLLECTIONS.RECURRING)
    .where({ userId: openid, delFlag: false })
    .limit(100)
    .get();
  const rows = res.data || [];
  // 按创建顺序展示，新建的在后面
  rows.sort((a, b) => (Number(a.createTime) || 0) - (Number(b.createTime) || 0));
  return rows;
}

/**
 * 更新规则字段（部分更新）
 * @returns {Promise<number>} 实际更新的文档数（0 = 未找到或无权修改）
 */
async function updateRecurringRule(openid, ruleId, data) {
  const db = getDb();
  const res = await db.collection(COLLECTIONS.RECURRING)
    .where({ _id: ruleId, userId: openid })
    .update({ data: { ...data, updateTime: Date.now() } });
  return res.stats.updated;
}

/** 软删除规则（历史账单保留） */
async function softDeleteRecurringRule(openid, ruleId) {
  const db = getDb();
  const res = await db.collection(COLLECTIONS.RECURRING)
    .where({ _id: ruleId, userId: openid })
    .update({ data: { delFlag: true, updateTime: Date.now() } });
  return res.stats.updated;
}

/**
 * 捞到期规则 —— 定时任务 dailyRecurring 专用
 *
 * 定时触发无用户上下文，必须扫全量用户；nextDate 是调度游标，
 * `<= dateCST` 同时覆盖「今天到期」与「昨天漏跑」两种情形
 * （漏跑的不补记，由调度层把游标前移）。
 */
async function listDueRecurringRules(dateCST) {
  const db = getDb();
  const where = {
    status: 'active',
    delFlag: false,
    nextDate: db.command.lte(dateCST)
  };
  return fetchAll(db.collection(COLLECTIONS.RECURRING), where);
}

/**
 * 查某规则在某天是否已生成过账单（幂等第二道防线）
 * @returns {Promise<object|null>}
 */
async function findBillByRuleAndDate(userId, ruleId, date) {
  const db = getDb();
  const res = await db.collection(COLLECTIONS.BILLS)
    .where({ userId, ruleId, date, delFlag: false })
    .limit(1)
    .get();
  return (res.data && res.data[0]) || null;
}

/**
 * 查某家庭规则在某天是否已在家庭账本生成过账单（幂等第二道防线·家庭版）
 *
 * 用 fetchAll 查 { familyId, date } 后 JS 过滤 ruleId：family_bills
 * 已有 familyId/date 索引，直接 where 拼 ruleId 可能要求新组合索引。
 * 单个家庭一天账单量级很小，全量拉回过滤没有性能负担。
 *
 * @returns {Promise<object|null>}
 */
async function findFamilyBillByRuleAndDate(familyId, ruleId, date) {
  const db = getDb();
  const rows = await fetchAll(
    db.collection(COLLECTIONS.FAMILY_BILLS),
    { familyId, date, delFlag: false }
  );
  return rows.find((b) => b.ruleId === ruleId) || null;
}

/**
 * 暂停某用户在某家庭的重复记账规则 —— 退出/解散家庭时调用
 *
 * 口径（与产品确认）：退出家庭/家庭解散时，自动把该成员的全部
 * 家庭规则置为 paused，规则保留在列表里（可删除或重建为个人规则）。
 * 定时生成还会再校验一次成员资格兜底（家庭解散、数据不一致时
 * 不写无主账单），这里暂停是主动防御。
 *
 * 查询复用 listRecurringRules（userId 索引）+ JS 过滤，
 * 不加任何新的 where 条件 —— 零新索引需求。
 *
 * @param {string} openid 规则创建者
 * @param {string} familyId 要暂停规则所属的家庭
 */
async function pauseFamilyRecurringRules(openid, familyId) {
  const rules = await listRecurringRules(openid);
  const targets = rules.filter(
    (r) => r.ledger === 'family' && r.familyId === familyId && r.status === 'active'
  );
  for (const r of targets) {
    await updateRecurringRule(openid, r._id, { status: 'paused' });
  }
  return targets.length;
}

/**
 * 列出用户自定义类目（「类目不匹配可自主新增」功能的数据源）
 *
 * 设计约束：**读失败一律返回空数组**。自定义类目是预置类目之上的
 * 增强能力，tree/search/record 主链路在它缺席时必须照常跑——
 * 集合没建、库没连上都不能拖垮记账。真正的错误（如权限问题）
 * 打日志即可，用户侧表现为「自定义类目暂不可见」，可接受。
 *
 * @param {string} openid
 * @returns {Promise<Array>} 自定义类目文档；无则空数组
 */
async function listCustomCategories(openid) {
  if (!openid) return [];
  try {
    const db = getDb();
    // 单用户自定义类目量级很小（几十个封顶），一次取完
    const res = await db.collection(COLLECTIONS.CATEGORIES)
      .where({ userId: openid, delFlag: false })
      .limit(100)
      .get();
    return res.data || [];
  } catch (e) {
    const raw = e.errMsg || e.message || String(e);
    if (/not exist|does not exist|not found|集合/i.test(raw)) {
      // categories 集合还没建 = 该用户从未创建过自定义类目，正常初始态
      return [];
    }
    console.warn('[db] 读取自定义类目失败', raw);
    return [];
  }
}

/**
 * 新增用户自定义类目（支持一级/二级/三级全层级）
 *
 * @param {object} cat { id, userId, name, parentId, path, color, level, keywords }
 *   level 1|2|3，默认 3（早期调用不传，等同挂末级）
 * @returns {Promise<object>} 含完整字段的文档
 */
async function insertCustomCategory(cat) {
  const db = getDb();
  const now = Date.now();
  const level = Number(cat.level) === 1 || Number(cat.level) === 2 || Number(cat.level) === 3
    ? Number(cat.level)
    : 3;
  const doc = {
    _id: cat.id,
    userId: cat.userId,
    name: cat.name,
    path: cat.path,
    color: cat.color || '#A8A8A8',
    keywords: cat.keywords && cat.keywords.length ? cat.keywords : [cat.name],
    level,
    custom: true,
    delFlag: false,
    createTime: now,
    updateTime: now
  };
  // 一级类目无父级。云开发对 null 值的写入行为不稳定（见 buildBill 同款约束），
  // 无值时不写该字段；读取侧用 level===1 判断，不依赖 parentId 存在与否
  if (cat.parentId) doc.parentId = cat.parentId;

  try {
    await db.collection(COLLECTIONS.CATEGORIES).add({ data: doc });
    return doc;
  } catch (e) {
    const raw = e.errMsg || e.message || String(e);
    if (/not exist|does not exist|not found|集合/i.test(raw)) {
      throw new Error(
        `集合 ${COLLECTIONS.CATEGORIES} 不存在，无法保存自定义类目。` +
        `请在云开发控制台 →「数据库」→ 新建集合，名称填 categories。`
      );
    }
    if (/permission|unauthorized|auth/i.test(raw)) {
      throw new Error(
        `无写入权限：${raw}。请把 ${COLLECTIONS.CATEGORIES} 权限设为「仅创建者可读写」。`
      );
    }
    throw e;
  }
}

/**
 * 写入前检查集合是否存在
 * 云开发不能从代码建集合，这里给出可操作的提示而非静默失败
 *
 * ⚠ 只校验 bills —— 这是当前唯一被真实读写的集合。
 * categories 的读写自带降级（listCustomCategories 失败返回空、
 * insertCustomCategory 报错带指引），不需要在这里强制。
 * templates 仍只在未来「自动记账模板」功能中使用。
 */
async function ensureCollections() {
  const db = getDb();
  try {
    const res = await db.collection(COLLECTIONS.BILLS).limit(1).get();
    return { ok: true, sample: res.data.length };
  } catch (e) {
    const raw = e.errMsg || e.message || String(e);
    // 云开发对不存在的集合有几种不同报错文案，逐一识别才能给出准确指引
    if (/not exist|does not exist|not found|集合/i.test(raw)) {
      throw new Error(
        `数据库集合 ${COLLECTIONS.BILLS} 不存在。` +
        `请在开发者工具中点击顶部「云开发」→ 左侧「数据库」→ 点「+」新建集合，名称填 bills，然后重新上传云函数。` +
        `（只需建这一个，categories / templates / users 是后续功能用的，现在不用建。）` +
        `原始错误：${raw}`
      );
    }
    // 集合存在但没权限，属于另一类问题，单独提示
    if (/permission|unauthorized|auth/i.test(raw)) {
      throw new Error(
        `无权访问集合 ${COLLECTIONS.BILLS}：${raw}。` +
        `请在云开发控制台 →「权限设置」中把当前用户设为「自定义安全规则」并允许读写，或设为「所有用户可读，仅创建者可读写」。`
      );
    }
    throw e;
  }
}

/**
 * 当前代码实际使用的集合
 * 新增集合调用时同步更新此处，避免文档与代码脱节
 *
 * users 现已成为必需：消费分析结果存在这里，
 * 缺了它分析页会一直拿不到数据（而不是报错，容易被误判成「没数据」）
 *
 * categories 是可选必需：自定义类目功能用到它。
 * 缺了它时记账主链路不受影响（自定义类目读失败降级为空），
 * 但「新增自定义类目」会保存失败，报错信息里自带建表指引，
 * 因此需要建表但不阻断主流程。
 *
 * recurring 与 bills 同级必需：重复记账功能读/写它，
 * 缺了它建规则会报错（带建表指引），定时生成也会失败。
 */
const REQUIRED_COLLECTIONS = [
  COLLECTIONS.BILLS,
  COLLECTIONS.USERS,
  COLLECTIONS.CATEGORIES,
  COLLECTIONS.RECURRING,
  COLLECTIONS.FAMILIES,
  COLLECTIONS.FAMILY_BILLS
];

module.exports = {
  currentOpenId,
  isAvailable,
  sdkInitError,
  getWxContext,
  getDb,
  insertBill,
  insertBillAsUser,
  listBills,
  monthStat,
  getLatestBillChangeTime,
  recentBillsByMonth,
  categoryBreakdown,
  listPendingInsightUsers,
  saveInsight,
  getInsight,
  getProfile,
  saveProfile,
  familyGet,
  familyCreate,
  familyJoin,
  familyMembers,
  familyLeave,
  familyRegenCode,
  familyDissolve,
  insertFamilyBill,
  insertFamilyBillAsUser,
  softDeleteFamilyBill,
  listFamilyBills,
  familyMonthStat,
  familyRecentBillsByMonth,
  familyGetLatestBillChangeTime,
  saveFamilyInsight,
  getFamilyInsight,
  softDelete,
  insertRecurringRule,
  listRecurringRules,
  updateRecurringRule,
  softDeleteRecurringRule,
  listDueRecurringRules,
  findBillByRuleAndDate,
  findFamilyBillByRuleAndDate,
  pauseFamilyRecurringRules,
  ensureCollections,
  fetchAll,
  listCustomCategories,
  insertCustomCategory,
  QUERY_PAGE_SIZE,
  REQUIRED_COLLECTIONS
};