/**
 * 类目云函数 —— 技术文档 §5.1
 *
 * action：
 *   tree        返回完整类目树（供前端手动选择界面，含该用户的自定义类目）
 *   search      按关键词搜索类目（低置信度引导时使用，含自定义类目）
 *   create      新增自定义类目（支持一级 / 二级 / 三级全层级）
 *
 * 为什么类目库不放前端：
 *   166 个类目约 15KB JSON，放前端会让首屏包体积变大，
 *   且用户自定义类目需要实时同步。真机调试时每次改类目都要重新发版，
 *   放云端改一次即生效，联调效率高得多。
 *
 * 自定义类目的存储模型（全层级版）：
 *   每条文档挂在 categories 集合，userId 隔离。
 *   - level=1：用户自建一级大类，parentId 为空，排预置 12 个一级之后
 *   - level=2：挂在某一级下（预置或自定义一级均可）
 *   - level=3：挂在某二级下；早期版本挂在一级下的存量末级
 *     继续展示在「自定义」虚拟分组里，不迁移用户数据
 *   path 形如「宠物/宠物医疗/狗狗美容」，首段是一级名——
 *   饼图按 path 首段聚合时自定义一级天然归为一类。
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

const preset = loadShared('util/category-preset');
const db = loadShared('db');

/** 自定义类目未选大类时的默认归属（其他）—— 仅早期「挂一级的末级」兼容模式使用 */
const DEFAULT_PARENT_ID = 'c12';
/** 类目名长度上限：类目树每行要并排显示多个名字，太长会撑破布局 */
const MAX_NAME_LEN = 12;
/** 自定义一级数量上限：类目树失控比建不了更伤体验 */
const MAX_CUSTOM_TOPS = 10;
/**
 * 自定义一级的扩展色板 —— 预置 12 色之外的低饱和色，按建号轮询分配。
 * 子级一律继承根一级的颜色，保证饼图与树内视觉一致。
 */
const EXTENDED_PALETTE = [
  '#94B4A4', '#C0A97E', '#B49BC4', '#C48E8E', '#8CB8B0',
  '#C4B27E', '#9B9BC0', '#C08EA8', '#A0B478', '#C49E7E'
];

exports.main = async (event, context) => {
  const { action, payload = {} } = event || {};

  try {
    switch (action) {
      case 'tree':   return { ok: true, data: await buildTree(context) };
      case 'search': return { ok: true, data: await search(payload.keyword, context) };
      case 'create': return await handleCreate(payload, context);
      default:
        return { ok: false, error: `未知操作: ${action}` };
    }
  } catch (e) {
    console.error('[category-svc]', action, e);
    return { ok: false, error: e.message };
  }
};

/** 统一取自定义类目 id（db 文档主键是 _id，早期写法带 id 字段，两种都认） */
function cid(c) {
  return c ? (c.id || c._id) : null;
}

/** db 文档 → 前端视图（补 color：建表时可能没存，取所属一级的配色） */
function toView(c) {
  return {
    id: cid(c),
    name: c.name,
    path: c.path || c.name,
    color: c.color || preset.colorOf(c.parentId) || preset.DEFAULT_COLOR,
    custom: true
  };
}

/**
 * 解析任意类目 id（预置或自定义）为节点信息，供父类校验与 path/color 构造
 * @returns {{id,name,path,level,color,custom}|null}
 */
function resolveNode(id, customs) {
  if (!id) return null;

  const p = preset.CATEGORY_MAP.get(id);
  if (p) {
    return {
      id: p.id,
      name: p.name,
      path: p.path,
      level: p.level,
      // 预置节点色取其一级配色（与树接口的取色口径一致）
      color: preset.colorOf(p.id),
      custom: false
    };
  }

  const c = (customs || []).find((x) => cid(x) === id);
  if (c) {
    return {
      id: cid(c),
      name: c.name,
      path: c.path || c.name,
      level: c.level || 3,
      color: c.color || preset.colorOf(c.parentId) || preset.DEFAULT_COLOR,
      custom: true
    };
  }
  return null;
}

/** 读取当前用户自定义类目；库不可用/集合未建时返回空（与 db 层降级一致） */
async function myCustomCategories(context) {
  const openid = db.currentOpenId(context);
  if (!openid || !db.isAvailable()) return { openid, list: [] };
  const list = await db.listCustomCategories(openid);
  return { openid, list };
}

/**
 * 构建三级树：一级 → 二级 → 末级
 *
 * 合并规则（设计原型 §2.2）：
 *   - 自定义一级排在预置 12 个之后
 *   - 自定义二级/三级直接融入对应层级，与预置并列
 *   - 早期「挂在一级下的末级」继续收进「自定义」虚拟分组（存量不迁移）
 */
async function buildTree(context) {
  const { list: customs } = await myCustomCategories(context);

  const top = preset.TOP_CATEGORIES.map((t) => {
    const level2 = preset.CATEGORIES
      .filter((c) => c.parentId === t.id && c.level === 2)
      .map((l2) => ({
        id: l2.id,
        name: l2.name,
        color: preset.colorOf(t.id),
        children: preset.LEAF_CATEGORIES
          .filter((c) => c.parentId === l2.id)
          .map((l3) => ({ id: l3.id, name: l3.name, path: l3.path }))
      }));
    mergeCustomUnderTop(level2, customs, t.id);
    return { id: t.id, name: t.name, color: preset.colorOf(t.id), children: level2 };
  });

  // 自定义一级及其整棵子树，追加在预置之后
  for (const c of customs.filter((x) => (x.level || 3) === 1)) {
    const level2 = [];
    mergeCustomUnderTop(level2, customs, cid(c));
    top.push({ ...toView(c), children: level2 });
  }

  return { tree: top, stats: preset.stats, customCount: customs.length };
}

/**
 * 把某一级下的自定义子节点合并进其 level2 列表
 *
 * 三种形态：
 *   1. level=2 且 parentId=topId      → 追加为二级，children 收它的三级
 *   2. level=3 且 parentId 是某二级    → 追加到那个二级的 children 末尾
 *   3. level=3 且 parentId=topId      → 「自定义」虚拟分组（早期数据兼容）
 */
function mergeCustomUnderTop(level2, customs, topId) {
  // 二级
  const myL2 = customs.filter((c) => (c.level || 3) === 2 && c.parentId === topId);
  for (const l2 of myL2) {
    level2.push({
      id: cid(l2),
      name: l2.name,
      color: l2.color || preset.colorOf(topId) || preset.DEFAULT_COLOR,
      custom: true,
      children: customs
        .filter((c) => (c.level || 3) === 3 && c.parentId === cid(l2))
        .map(toView)
    });
  }

  // 新模式三级：挂到本一级下的某个二级（预置或自定义）里
  const l2Ids = new Set([
    ...level2.map((x) => x.id),
    ...preset.CATEGORIES.filter((c) => c.parentId === topId && c.level === 2).map((c) => c.id)
  ]);
  for (const l3 of customs.filter((c) => (c.level || 3) === 3 && l2Ids.has(c.parentId))) {
    const host = level2.find((x) => x.id === l3.parentId);
    if (host) host.children.push(toView(l3));
  }

  // 存量兼容：挂在一级下的末级 → 虚拟分组
  const legacy = customs.filter((c) => (c.level || 3) === 3 && c.parentId === topId);
  if (legacy.length) {
    level2.push({
      id: `custom_${topId}`,
      name: '自定义',
      color: preset.colorOf(topId) || preset.DEFAULT_COLOR,
      customGroup: true,
      children: legacy.map(toView)
    });
  }
}

/**
 * 关键词搜索：命中名称、关键词、别名任一即算命中（自定义类目一并搜）
 */
async function search(keyword, context) {
  if (!keyword || !String(keyword).trim()) return { list: [], total: 0 };

  const kw = String(keyword).trim();
  const { list: customs } = await myCustomCategories(context);

  const list = [];

  for (const c of preset.LEAF_CATEGORIES) {
    let score = 0;
    if (c.name === kw) score = 100;
    else if (c.name.includes(kw)) score = 50;
    else if ((c.keywords || []).some((k) => k.includes(kw))) score = 30;
    else if ((c.aliases || []).some((a) => a.includes(kw))) score = 20;

    if (score > 0) {
      list.push({
        id: c.id,
        name: c.name,
        path: c.path,
        color: preset.colorOf(c.id),
        score
      });
    }
  }

  // 自定义类目：用户亲手建的，同分时应排在预置前面（更符合个人习惯）
  for (const c of customs) {
    let score = 0;
    if (c.name === kw) score = 100;
    else if (String(c.name).includes(kw)) score = 50;
    else if ((c.keywords || []).some((k) => String(k).includes(kw))) score = 30;

    if (score > 0) {
      list.push({ ...toView(c), score, custom: true });
    }
  }

  list.sort((a, b) => b.score - a.score || (b.custom ? 1 : 0) - (a.custom ? 1 : 0));
  return { list: list.slice(0, 20), total: list.length };
}

/**
 * 在预置类目里找同名节点（劝用现成的，避免树里出现两个「买菜」）
 * 二三级只查「同父之下」：跨父同名是正常现象（预置自己就有
 * 「门诊挂号」一级下同名二级、三级），不该拦。
 */
function findPresetSameName(name, level, parentId) {
  if (level === 1) {
    return preset.TOP_CATEGORIES.find((c) => c.name === name) || null;
  }
  if (level === 2) {
    return preset.CATEGORIES.find((c) => c.level === 2 && c.parentId === parentId && c.name === name) || null;
  }
  // level 3：父是二级 → 查该二级下；父是一级（存量兼容）→ 查全部末级
  const parent = preset.CATEGORY_MAP.get(parentId);
  if (parent && parent.level === 2) {
    return preset.LEAF_CATEGORIES.find((c) => c.parentId === parentId && c.name === name) || null;
  }
  return preset.LEAF_CATEGORIES.find((c) => c.name === name) || null;
}

/**
 * 新增自定义类目（全层级）
 *
 * 参数：
 *   name     类目名（1~12 字）
 *   level    1 | 2 | 3；**不传时进入兼容模式**：按早期版本行为，
 *            parentId 视为一级、建末级进「自定义」虚拟分组
 *   parentId 上级类目 id（level=1 时忽略；level=2 须为一级；level=3 须为二级）
 *
 * 校验顺序（从严到宽）：
 *   身份 → 环境 → 名称 → 层级/父类 → 预置同名劝用 → 已建同名（幂等返回）
 *
 * 幂等设计：重复创建同名同类目不报错，直接返回已有条目。
 * 前端在搜索无结果的瞬间可能连续点两次「新增」，报错反而制造焦虑。
 */
async function handleCreate({ name, level, parentId }, context) {
  const openid = db.currentOpenId(context);
  if (!openid) {
    return { ok: false, error: '无法获取用户身份（openid），已中止创建。请重新编译小程序后重试。' };
  }
  if (!db.isAvailable()) {
    return { ok: false, error: '本地环境未接入数据库，无法创建自定义类目。请部署 category-svc 后在真机使用。' };
  }

  const catName = String(name || '').trim();
  if (!catName) return { ok: false, error: '类目名不能为空' };
  if (catName.length > MAX_NAME_LEN) {
    return { ok: false, error: `类目名最多 ${MAX_NAME_LEN} 个字，请精简一下` };
  }

  const customs = await db.listCustomCategories(openid);
  const lv = Number(level);
  const explicitLevel = lv === 1 || lv === 2 || lv === 3 ? lv : null;

  let parent = null;
  let path;
  let color;

  if (!explicitLevel || explicitLevel === 1) {
    // ── 一级（或不带 level 的调用按旧语义建一级下的末级，见下方兼容分支） ──
    if (explicitLevel === 1) {
      const topCount = customs.filter((c) => (c.level || 3) === 1).length;
      if (topCount >= MAX_CUSTOM_TOPS) {
        return { ok: false, error: `自定义大类最多 ${MAX_CUSTOM_TOPS} 个，已达上限。可以把新类目建到现有大类的下一层。` };
      }
      const dupTop = findPresetSameName(catName, 1, null);
      if (dupTop) {
        return {
          ok: false,
          error: `已有预置大类「${catName}」，无需新建`,
          hint: 'use_preset',
          presetCategory: { id: dupTop.id, name: dupTop.name, path: dupTop.path }
        };
      }
      const existedTop = customs.find((c) => (c.level || 3) === 1 && c.name === catName);
      if (existedTop) {
        return { ok: true, existed: true, data: { category: toView(existedTop) } };
      }
      parent = null;
      path = catName;
      color = EXTENDED_PALETTE[topCount % EXTENDED_PALETTE.length];
    }
  }

  if (explicitLevel === 2) {
    // ── 二级：父必须是一级（预置或自定义） ──
    parent = resolveNode(parentId, customs);
    if (!parent || parent.level !== 1) {
      return { ok: false, error: '二级类目必须挂在某个大类（一级）之下，请先选上级' };
    }
  } else if (explicitLevel === 3) {
    // ── 三级：父必须是二级（预置或自定义） ──
    parent = resolveNode(parentId, customs);
    if (!parent || parent.level !== 2) {
      return { ok: false, error: '三级类目的上级必须是二级类目（支出分类最多三层）' };
    }
  } else if (!explicitLevel) {
    // ── 兼容模式：早期调用（不传 level），parentId 是一级 → 建末级进虚拟分组 ──
    parent = resolveNode(parentId, customs);
    if (!parent || parent.level !== 1) {
      const fallback = preset.CATEGORY_MAP.get(DEFAULT_PARENT_ID);
      parent = { id: fallback.id, name: fallback.name, path: fallback.path, level: 1, color: preset.colorOf(fallback.id) };
    }
  }

  if (parent) {
    const dupPreset = findPresetSameName(catName, explicitLevel || 3, parent.id);
    if (dupPreset) {
      return {
        ok: false,
        error: `「${parent.name}」下已有预置类目「${catName}」（${dupPreset.path}），无需新建`,
        hint: 'use_preset',
        presetCategory: { id: dupPreset.id, name: dupPreset.name, path: dupPreset.path }
      };
    }

    // 同父同级下不重名（跨父允许同名，与预置口径一致）
    const sameScope = customs.find(
      (c) => (c.level || 3) === (explicitLevel || 3) && c.parentId === parent.id && c.name === catName
    );
    if (sameScope) {
      return { ok: true, existed: true, data: { category: toView(sameScope) } };
    }

    // 挂在一级下的末级（兼容模式，或显式三级但父给成一级的容错），
    // 与早期版本路径格式保持一致，树里归入「自定义」虚拟分组
    const parentTopName = String(parent.path || '').split('/')[0];
    path = ((explicitLevel || 3) === 3 && parent.level === 1)
      ? `${parentTopName}/自定义/${catName}`
      : `${parent.path}/${catName}`;
    color = parent.color || preset.colorOf(parentTopName) || preset.DEFAULT_COLOR;
  }

  const id = 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  const doc = await db.insertCustomCategory({
    id,
    userId: openid,
    name: catName,
    parentId: parent ? parent.id : null,
    path,
    color,
    level: explicitLevel || 3,
    keywords: [catName]
  });

  return {
    ok: true,
    data: {
      category: toView(doc),
      parent: parent ? { id: parent.id, name: parent.name } : null
    }
  };
}
