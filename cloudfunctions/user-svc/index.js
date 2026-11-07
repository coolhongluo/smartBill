/**
 * 用户信息云函数 —— 技术文档 §5.1
 * action：
 *   profile         返回 openid（脱敏）与已记笔数、可选资料、家庭归属
 *   login           静默登录 + 自动注册（幂等：已有档案直接返回）
 *   updateProfile   更新可选资料（昵称/头像，无值字段不写）
 *   familyCreate    创建家庭（创建者自动加入）
 *   familyJoin      凭邀请码加入家庭
 *   familyInfo      当前家庭概要（含邀请码，仅创建者可重新生成）
 *   familyMembers   家庭成员列表
 *   familyLeave     退出家庭（创建者不可退）
 *   familyRegenCode 重新生成邀请码（仅创建者，旧码立即失效）
 *   familyDissolve  解散家庭（仅创建者，软删除 + 全员清归属）
 */

const path = require('path');

/**
 * 加载 shared 共享层
 *
 * 候选路径按「云端可达性」排序，不按本地方便程度排序：
 *   1. `<云函数目录>/shared/`             ← 云端唯一可靠来源，随函数打包上传
 *   2. `process.cwd()/node_modules/shared` ← 本地快路径；选「云端安装依赖」时云端不存在
 *   3. `<云函数目录>/../shared/`           ← 平级兄弟目录，不在打包范围内，云端找不到
 *
 * 历史踩坑：只靠 2+3 两条，本地测试全绿、云端却报
 * Cannot find module '/var/shared/...' —— 因为「云端安装依赖」不上传本地 node_modules。
 * 记住：本地全绿 ≠ 云端能跑。
 */
function loadShared(modulePath) {
  const candidates = [
    path.join(__dirname, 'shared', modulePath),
    path.join(process.cwd(), 'node_modules', 'shared', modulePath),
    path.join(__dirname, '..', 'shared', modulePath)
  ];

  for (const p of candidates) {
    try {
      return require(p);
    } catch (e) {
      // 只吞「模块找不到」，其他错误（语法错误等）必须暴露
      if (e.code !== 'MODULE_NOT_FOUND') throw e;
    }
  }

  throw new Error(
    `找不到共享模块 shared/${modulePath}。已尝试：\n` +
    candidates.map((p) => `  - ${p}`).join('\n') +
    `\n请执行 npm run prepare:cf，然后重新「上传并部署：云端安装依赖」。`
  );
}

const db = loadShared('db');
const dateUtil = loadShared('util/date');

exports.main = async (event, context) => {
  const { action, payload } = event || {};

  try {
    const openid = db.currentOpenId(context);
    if (!openid) return { ok: false, error: '无法获取用户身份' };

    // ⚠️ 每个 case 必须 `return await`：async 函数里 `return promise` 的
    // rejection 发生在 try 块结束之后的隐式 await，catch 捕不到 ——
    // 会直接以未处理 rejection 崩溃云函数（实测踩过，node -e 可复现）。
    switch (action) {
      case 'profile': return await handleProfile(openid);
      case 'login': return await handleLogin(openid);
      case 'updateProfile': return await handleUpdateProfile(openid, payload || {});
      case 'familyCreate': return await handleFamilyCreate(openid, payload || {});
      case 'familyJoin': return await handleFamilyJoin(openid, payload || {});
      case 'familyInfo': return await handleFamilyInfo(openid);
      case 'familyMembers': return await handleFamilyMembers(openid);
      case 'familyLeave': return await handleFamilyLeave(openid);
      case 'familyRegenCode': return await handleFamilyRegenCode(openid);
      case 'familyDissolve': return await handleFamilyDissolve(openid);
      default: return { ok: false, error: `未知操作: ${action}` };
    }
  } catch (e) {
    console.error('[user-svc]', e);
    return { ok: false, error: e.message };
  }
};

/**
 * 用户信息：openid（脱敏）+ 已记笔数 + 可选资料 + 家庭归属
 *
 * profile 文档可能不存在（老用户从未触发过 login），
 * 资料字段一律按空值返回 —— 前端据此显示「未设置」，不报错。
 */
async function handleProfile(openid) {
  const month = dateUtil.toMonthStr(new Date());
  const stat = await db.monthStat(openid, month);
  const profile = (await db.getProfile(openid)) || {};

  return {
    ok: true,
    data: {
      // openid 仅返回前 8 位做展示，全量暴露没有必要也有隐私风险
      openidMasked: openid.slice(0, 8) + '****',
      month,
      billCount: stat.count,
      nickname: profile.nickname || '',
      avatarUrl: profile.avatarUrl || '',
      familyId: profile.familyId || ''
    }
  };
}

/**
 * 静默登录 + 自动注册（幂等）
 *
 * ## 为什么注册动作放在这里
 *
 * 小程序没有显式「登录页」，openid 由云函数 getWXContext 静默提供，
 * 首调 login 即完成注册（建 `${openid}_profile` 档案文档）。
 * 重复调用不产生副作用 —— 已有档案直接返回，不重写。
 */
async function handleLogin(openid) {
  let profile = await db.getProfile(openid);
  const isNew = !profile;

  if (!profile) {
    await db.saveProfile(openid, {});
    profile = await db.getProfile(openid);
  }

  return {
    ok: true,
    data: {
      isNew,
      profile: {
        nickname: (profile && profile.nickname) || '',
        avatarUrl: (profile && profile.avatarUrl) || '',
        familyId: (profile && profile.familyId) || ''
      }
    }
  };
}

/**
 * 更新可选资料（昵称/头像）
 *
 * 只接受非空字符串；两者都缺 → 明确报错而非静默成功。
 * 空值不写（null 在部分环境触发写入异常）。
 */
async function handleUpdateProfile(openid, payload = {}) {
  const fields = {};
  if (typeof payload.nickname === 'string' && payload.nickname.trim()) {
    fields.nickname = payload.nickname.trim();
  }
  if (typeof payload.avatarUrl === 'string' && payload.avatarUrl) {
    fields.avatarUrl = payload.avatarUrl;
  }

  if (!fields.nickname && !fields.avatarUrl) {
    return { ok: false, error: '没有可更新的资料' };
  }

  await db.saveProfile(openid, fields);
  return { ok: true };
}

/* ── 家庭模式 ── */

/**
 * 取「当前用户的家庭」上下文
 *
 * 家庭归属的唯一权威是 profile.familyId（云端反查，不信任前端），
 * 拿到后还要再读一次 families 文档 —— profile 里的 familyId 可能指向
 * 已解散的家庭（解散时逐成员清空，但清空前有窗口）。
 */
async function requireFamily(openid) {
  const profile = await db.getProfile(openid);
  if (!profile || !profile.familyId) {
    throw new Error('您还没有加入任何家庭');
  }
  const family = await db.familyGet(profile.familyId);
  if (!family) {
    throw new Error('家庭不存在或已解散');
  }
  return { profile, family };
}

async function handleFamilyCreate(openid, payload = {}) {
  const family = await db.familyCreate(openid, payload.name);
  return {
    ok: true,
    data: {
      familyId: family._id,
      name: family.name,
      inviteCode: family.inviteCode,
      inviteExpiresAt: family.inviteExpiresAt
    }
  };
}

async function handleFamilyJoin(openid, payload = {}) {
  const family = await db.familyJoin(openid, payload.inviteCode);
  return {
    ok: true,
    data: { familyId: family._id, name: family.name }
  };
}

/**
 * 当前家庭概要
 *
 * 邀请码对所有成员可见（方便家人拉人进群），
 * 但「重新生成」仅创建者可用（familyRegenCode 云端校验）。
 */
async function handleFamilyInfo(openid) {
  const profile = await db.getProfile(openid);
  if (!profile || !profile.familyId) {
    return { ok: true, data: { inFamily: false } };
  }
  const { family } = await requireFamily(openid);
  const members = await db.familyMembers(family._id);

  return {
    ok: true,
    data: {
      inFamily: true,
      family: {
        id: family._id,
        name: family.name,
        isOwner: family.ownerId === openid,
        memberCount: members.length,
        inviteCode: family.inviteCode,
        inviteExpiresAt: family.inviteExpiresAt,
        inviteExpired: !!(family.inviteExpiresAt && family.inviteExpiresAt < Date.now())
      }
    }
  };
}

/**
 * 家庭成员列表
 *
 * 不返回 userId —— openid 全量暴露有隐私风险（项目口径只出前 8 位），
 * 而脱敏串的前 8 位在不同用户间可能重复，不能用来标「我」。
 * 所以「我 / 创建者」由云端直接标好，前端只展示。
 */
async function handleFamilyMembers(openid) {
  const { family } = await requireFamily(openid);
  const members = await db.familyMembers(family._id);
  return {
    ok: true,
    data: {
      members: members.map((m) => ({
        nickname: m.nickname,
        avatarUrl: m.avatarUrl,
        isMe: m.userId === openid,
        isOwner: m.userId === family.ownerId
      }))
    }
  };
}

async function handleFamilyLeave(openid) {
  await db.familyLeave(openid);
  return { ok: true };
}

async function handleFamilyRegenCode(openid) {
  const { inviteCode, inviteExpiresAt } = await db.familyRegenCode(openid);
  return { ok: true, data: { inviteCode, inviteExpiresAt } };
}

async function handleFamilyDissolve(openid) {
  await db.familyDissolve(openid);
  return { ok: true };
}
