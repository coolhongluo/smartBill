/**
 * 类目可压缩性 —— 消费建议的判断基础
 *
 * ## 为什么必须区分「可压缩」与「刚性」
 *
 * 实测数据（固定 30% 比例套用到所有类目时）：
 *   孩子学费 2000 元 → 建议省 600 元
 *   房租 3500 元     → 建议省 1050 元
 *   生病买药 80 元   → 建议省 24 元
 *
 * 数学全对，结论全错——学费、房租、药费是刚性支出，省不动。
 * 给出这类建议不是「不够好」，是**不负责任**。
 *
 * 三档划分：
 *   rigid   刚性 — 不该出现任何建议。违反合约 / 影响生活必需
 *   semi    半刚性 — 可小幅优化，但不能砍零（如日用品）
 *   flexible 弹性 — 真正的优化空间
 *
 * ## 为什么单独成文件而不写进 category-preset.js
 *
 * preset 是「类目是什么」，这里是「类目能不能省」——
 * 两者会独立演化（新增类目时不必重新考虑压缩性，
 * 调整压缩策略时不必动类目数据），耦合在一起反而难维护。
 */

const { RIGID_NOTE_KEYWORDS } = require('./note-keywords');

/**
 * 刚性类目 ID 清单
 *
 * ⚠️ 这些 ID 必须与 category-preset.js 保持一致。
 * 打错一个字母会导致该类目静默失去刚性保护（回归测试会兜住）。
 */
const RIGID_IDS = new Set([
  // 居住：合约类 + 生活必需
  'c9_1_1', // 房租房贷
  'c9_2_1', // 物业费
  'c9_3_1', // 水电燃气（基础生活）

  // 育儿教育：不可牺牲
  'c4_2_1', // 学费
  'c4_2_2', // 补习班（强制）
  'c4_3_1', // 奶粉
  'c4_3_2', // 零食辅食（半刚性，见下方说明）

  // 医疗健康：疾病相关
  'c5_1_1', // 门诊挂号
  'c5_1_2', // 药品
  'c5_1_3', // 体检
  'c5_1_4', // 疫苗
  'c5_1_5', // 牙科
  'c5_1_6', // 眼科配镜

  // 金融保险：合约 + 债务
  'c10_1_1', // 保险保费
  'c10_2_1', // 贷款利息

  // 通讯网络：基础合约
  'c8_1_1', // 话费流量
  'c8_2_1', // 宽带
]);

/**
 * 半刚性 ID：可优化但不能砍零
 *
 * 典型：日用百货（纸巾会消耗）、宠物（饲料必须买）、
 * 通讯套餐里的超额流量（有上限）、衣物（要买但不急）。
 */
const SEMI_IDS = new Set([
  'c3_1_1', // 日用百货/纸巾清洁
  'c3_1_2', // 日用百货/厨房用品
  'c3_1_3', // 日用百货/收纳
  'c3_1_4', // 日用百货/卫浴用品
  'c3_3_1', // 家居用品/家具
  'c3_3_2', // 家居用品/床上用品
  'c3_3_3', // 家居用品/厨具
  'c4_1_4', // 日常上学/校园用品
  'c6_1_1', // 衣物鞋帽/衣物
  'c6_1_2', // 衣物鞋帽/鞋帽
  'c8_3_1', // 会员订阅/视频会员
  'c8_3_2', // 会员订阅/音乐会员
  'c8_3_3', // 会员订阅/云盘会员
  'c8_3_4', // 会员订阅/会员购
]);

/** 三档等级 */
const LEVEL = {
  RIGID: 'rigid',
  SEMI: 'semi',
  FLEXIBLE: 'flexible'
};

/**
 * 判断单个类目的可压缩性
 * @param {string} categoryId 末级类目 ID
 * @returns {'rigid'|'semi'|'flexible'}
 */
function compressibilityOf(categoryId) {
  const id = String(categoryId || '');
  if (RIGID_IDS.has(id)) return LEVEL.RIGID;
  if (SEMI_IDS.has(id)) return LEVEL.SEMI;
  return LEVEL.FLEXIBLE;
}

/**
 * 判断一条账单是否刚性
 *
 * ⚠️ 这里刻意做了**备注兜底**：即便类目是弹性的，
 * 备注写着「孩子的学费」也应当视为刚性。
 * 用户的手动记账经常选错类目，类目不该是唯一依据。
 */
function isRigidBill(bill) {
  const level = compressibilityOf(bill && bill.categoryId);
  if (level === LEVEL.RIGID) return true;

  const note = String((bill && bill.note) || '');
  if (!note) return false;

  // 备注关键词兜底：命中即视为刚性
  // 关键词表来自 note-keywords.js（单一数据源，与备注总结共用同一份）
  return RIGID_NOTE_KEYWORDS.some((k) => note.includes(k));
}

/**
 * 把账单按可压缩性分档统计
 *
 * @param {Array} bills 已清洗的账单
 * @returns {{rigid:Array, semi:Array, flexible:Array, summary:object}}
 */
function groupByCompressibility(bills) {
  const rigid = [];
  const semi = [];
  const flexible = [];

  for (const b of bills || []) {
    if (isRigidBill(b)) rigid.push(b);
    else if (compressibilityOf(b.categoryId) === LEVEL.SEMI) semi.push(b);
    else flexible.push(b);
  }

  const sum = (list) => list.reduce((s, b) => s + (b.amount || 0), 0);
  const rigidCent = sum(rigid);
  const totalCent = sum(bills || []);

  return {
    rigid,
    semi,
    flexible,
    summary: {
      totalCent,
      rigidCent,
      rigidPercent: totalCent > 0 ? Math.round((rigidCent / totalCent) * 1000) / 10 : 0,
      rigidCount: rigid.length,
      semiCount: semi.length,
      flexibleCount: flexible.length,
      /**
       * 刚性占比高是**正常的**（房租+学费就占一半很常见），
       * 不是「不该花钱」。这个字段供上层如实告知用户，
       * 而不是被模型解读成「你花太多钱了」
       */
      note: '刚性支出属于生活必需，不构成优化空间'
    }
  };
}

/**
 * 各等级的中文标签，供 Prompt 与前端直接引用
 * 集中在一处，避免模型和前端对同一个词有不同理解
 */
const LEVEL_LABEL = {
  [LEVEL.RIGID]: '刚性',
  [LEVEL.SEMI]: '半刚性',
  [LEVEL.FLEXIBLE]: '弹性'
};

module.exports = {
  RIGID_IDS,
  SEMI_IDS,
  LEVEL,
  LEVEL_LABEL,
  compressibilityOf,
  isRigidBill,
  groupByCompressibility
};