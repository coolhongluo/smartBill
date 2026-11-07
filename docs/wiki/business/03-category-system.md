# 03 类目体系

> 覆盖：166 个预置类目树 · id 命名规则 · 自定义类目 · 可压缩性三档 · 必需性消费清单。
>
> 权威实现：`cloudfunctions/shared/util/category-preset.js`（353 行）、`category-compressibility.js`（183 行）、`essential-spend.js`（85 行）、`note-keywords.js`。

## 1. 预置类目树

```js
const CATEGORIES = [ ... ];   // category-preset.js:16
```

| 层级 | 数量 | id 形态 | 例子 |
|---|---|---|---|
| 一级 | **12** | `c1` | `c1` 餐饮 |
| 二级 | **45** | `c1_1` | `c1_1` 在家吃饭 |
| 末级 | **109** | `c1_1_1` | `c1_1_1` 买菜 |
| **合计** | **166** | | |

### 1.1 id 命名规则

```
c{一级}_{二级}_{末级}     如 c1_1_1
c{一级}_{二级}             如 c1_1
c{一级}                   如 c1
```

**首段即一级** —— `category-preset.js:310` 注释：「id 形如 c1_1_1，首段即一级」。

### 1.2 12 个一级类目与二级清单

| id | 一级 | 二级类目 |
|---|---|---|
| `c1` | 餐饮 | 在家吃饭、外出就餐、饮品与零食、单位与集体 |
| `c2` | 交通出行 | 日常交通、大交通、出游相关交通 |
| `c3` | 居家生活 | 日用百货、家政服务、家居用品 |
| `c4` | 育儿教育 | 日常上学、教育支出、孩子吃喝、休闲娱乐 |
| `c5` | 医疗健康 | **门诊挂号**（⚠️ 见 §1.4） |
| `c6` | 服饰美容 | 衣物鞋帽、母婴用品、化妆品、洗护用品、理发美甲、珠宝饰品 |
| `c7` | 人情往来 | 红包礼金、送礼、请客随份子、孝敬老人 |
| `c8` | 通讯网络 | 话费流量、宽带、会员订阅 |
| `c9` | 居住 | 房租房贷、物业费、水电气暖、房屋维修 |
| `c10` | 金融保险 | 保险保费、贷款利息、投资支出、手续费 |
| `c11` | 文体娱乐 | 书籍、课程、观影演出、旅游度假、运动健身、手作 |
| `c12` | 其他 | 未分类、丢失、捐赠 |

### 1.3 末级类目字段

```js
{
  id: 'c1_1_1',
  name: '买菜',
  level: 3,
  parentId: 'c1_1',
  path: '餐饮/在家吃饭/买菜',
  keywords: ['买菜', '蔬菜', '青菜', '菜场', '菜市场', '生鲜', '果蔬'],
  aliases: ['菜场', '蔬菜', '生鲜', '果蔬']
}
```

| 字段 | 作用 |
|---|---|
| `id` | 全局唯一 |
| `name` | 显示名 |
| `level` | 1/2/3 |
| `parentId` | 父节点 id |
| `path` | `'一级/二级/末级'` —— **统计侧完全靠它分组** |
| `keywords` | 关键词通道用 |
| `aliases` | 同义词 |

### 1.4 ⚠️ `c5 医疗健康` 的层级命名问题

`c5_1` 的名字是「**门诊挂号**」，但它下面挂着 8 个末级：

| id | 末级名 |
|---|---|
| `c5_1_1` | 门诊挂号 |
| `c5_1_2` | 药品 |
| `c5_1_3` | 体检 |
| `c5_1_4` | 疫苗 |
| `c5_1_5` | 牙科 |
| `c5_1_6` | 眼科配镜 |
| `c5_1_7` | 保健品 |
| `c5_1_8` | 心理咨询 |

**二级类目名与末级语义不符** —— 二级叫「门诊挂号」却包含药品/体检/牙科。

> 后果：`path` 会变成 `医疗健康/门诊挂号/药品`。统计时按 `second` 分组会把药品和挂号混在一起。
> 这不是 bug（`path` 机制正常工作），但**读数据时不要被二级类目名误导**。

### 1.5 ⚠️ 保健品与心理咨询不在刚性清单

刚性清单里的医疗类目是 `c5_1_1`~`c5_1_6`（6 个），**`c5_1_7 保健品` 和 `c5_1_8 心理咨询` 不在刚性档**。

> 「保健品」是可选项（可以省），「心理咨询」在支出分类里通常也是可选消费。
> 但如果用户备注写了「保健品」这类词，注意**刚性判定同时看类目和备注**。

### 1.6 导出清单

```js
module.exports = {
  CATEGORIES,          // 全部 166 个
  CATEGORY_MAP,        // id → 类目对象
  LEAF_CATEGORIES,     // level === 3 的 109 个
  TOP_CATEGORIES,      // level === 1 的 12 个
  TOP_COLORS,          // 一级类目配色
  DEFAULT_COLOR,
  colorOf,             // (id) → 颜色
  pathOf,              // (id) → path  ← 预置类目反查的唯一入口
  hasCategory,         // (id) → boolean
  stats,               // 统计信息
  buildPromptCategoryTree  // ← 给 LLM 看的压缩树
};
```

### 1.7 ⚠️ `buildPromptCategoryTree` 必须带 ID

`util/category-preset.js` 的注释记录了一个实测教训：

> 「只给『买菜/肉蛋/水产』这样的**名称列表**时，模型会按 ID 命名规律自行推导出 `c5_4_1` / `c8_5_1` 这类不存在的 ID —— **实测幻觉率一度达 14%**」

所以输出的每个节点都**必须携带真实 ID**。

> 这也是 `bill-parse` agent 的 business 校验（类目 ID 是否在合法清单里）存在的原因。

### 1.8 预置类目不在数据库里

166 个预置类目**硬编码在代码里**，`categories` 集合**只存用户自建的**。

`category-svc` 的 `tree` action = 预置树 + 用户自定义合并。

## 2. 自定义类目

### 2.1 存储结构

`shared/db/index.js` 的 `insertCustomCategory`：

```js
{
  userId, name, path, color,        // color 默认 '#A8A8A8'
  keywords,                          // 默认 [name]
  custom: true,                      // ← 标记
  delFlag: false, createTime, updateTime
}
```

> ⚠️ **自定义类目没有 `categoryId` 字段** —— 只有 `name` + `path` + `keywords`。
> 这是「自定义类目 id 不在预置库里 → 云端反查不到 path」的根源，
> 也是前端 `amend` **不能全量提交**的原因之一。

### 2.2 参与分类的权重

`shared/rules/category-match.js`：

| 通道 | 权重 | 得分区间 |
|---|---|---|
| 关键词 | **0.5** | 0.5 ~ 0.95（`0.5 + specificity * 0.45`） |
| 语义 | **0.3** | 模型给分 |
| 金额 | **0.2** | 14 条金额规则 |

**自定义类目与预置末级同权参与关键词通道** —— 用户建的「狗狗美容」和预置的「买菜」一样被搜。

### 2.3 强规则下自定义类目不排第一

规则层 Top1 命中 `priority > 0` 的强规则时，自定义类目**仍保留在候选里**（用户可以改选），但**不排第一**。

> 典型：用户自建「宠物」类目，**不会**让「打车去医院 45」变成宠物医疗。

### 2.4 强规则会覆盖模型判断

若规则层 Top1 是强规则、而模型 Top1 不同：

```
→ 强制 tier='mid'、action='ASK_CONFIRM'
→ UI 文案「已按场景规则归类，请确认」
→ tracer 记录 strong_rule_override
→ 置信度封顶 0.74（绝不自动入账）
```

**用户自建类目被规则层 Top1 命中时同理** → 文案「已按你的自定义类目归类，请确认」。

## 3. 可压缩性三档

`shared/util/category-compressibility.js`（183 行，**单独成文件**）

> 为什么单独成文件？**刚性是分析口径，不是类目属性** —— 写进 `category-preset` 会让「类目定义」和「建议口径」耦合。

```js
const LEVEL = { RIGID: 'rigid', SEMI: 'semi', FLEXIBLE: 'flexible' };
```

| 档位 | 语义 | 在建议中的待遇 |
|---|---|---|
| `rigid` | 刚性 | **禁止出现在任何节省建议里** |
| `semi` | 半刚性 | 可提，但克制，不建议「砍零」 |
| `flexible` | 弹性 | 真正的优化对象 |

### 3.1 判定逻辑

```js
function compressibilityOf(id) {
  if (RIGID_IDS.has(id)) return LEVEL.RIGID;
  if (SEMI_IDS.has(id)) return LEVEL.SEMI;
  return LEVEL.FLEXIBLE;
}
```

> ⚠️ **RIGID_IDS 先查** —— 这解释了 §3.4 的 `c4_3_2` 争议。

### 3.2 刚性清单（17 个）

| 一级 | 类目 ID 与名称 |
|---|---|
| 居住 | `c9_1_1` 房租房贷 · `c9_2_1` 物业费 · `c9_3_1` 水电燃气 |
| 育儿教育 | `c4_2_1` 学费 · `c4_2_2` 补习班 · `c4_3_1` 奶粉 · `c4_3_2` 零食辅食 |
| 医疗健康 | `c5_1_1` 门诊挂号 · `c5_1_2` 药品 · `c5_1_3` 体检 · `c5_1_4` 疫苗 · `c5_1_5` 牙科 · `c5_1_6` 眼科配镜 |
| 金融保险 | `c10_1_1` 保险保费 · `c10_2_1` 贷款利息 |
| 通讯网络 | `c8_1_1` 话费流量 · `c8_2_1` 宽带 |

### 3.3 半刚性清单（14 个）

| 一级 | 类目 ID 与名称 |
|---|---|
| 居家生活 | `c3_1_1` 纸巾清洁 · `c3_1_2` 厨房用品 · `c3_1_3` 收纳 · `c3_1_4` 卫浴用品 · `c3_3_1` 家具 · `c3_3_2` 床上用品 · `c3_3_3` 厨具 |
| 育儿教育 | `c4_1_4` 校园用品 |
| 服饰美容 | `c6_1_1` 衣物 · `c6_1_2` 鞋帽 |
| 通讯网络 | `c8_3_1` 视频会员 · `c8_3_2` 音乐会员 · `c8_3_3` 云盘会员 · `c8_3_4` 会员购 |

**半刚性的原始理由**（源码注释）：「典型：日用品（纸巾会消耗）、宠物（饲料必须买）、通讯套餐里的超额流量（有上限）、衣物（要买但不急）。」

### 3.4 ⚠️ `c4_3_2 零食辅食` 的注释与实现不一致

`RIGID_IDS` 里有 `c4_3_2`，但旁边的注释写「（半刚性，见下方说明）」。

**实际实现按刚性处理** —— `compressibilityOf` 先查 `RIGID_IDS.has(id)`，命中即返回 `RIGID`。

> 源码里没有「见下方说明」的内容 —— 注释是历史遗留。**以代码为准。**

### 3.5 备注关键词兜底

```js
function isRigidBill(bill) {
  const level = compressibilityOf(bill && bill.categoryId);
  if (level === LEVEL.RIGID) return true;
  const note = String((bill && bill.note) || '');
  if (!note) return false;
  return RIGID_NOTE_KEYWORDS.some((k) => note.includes(k));
}
```

> 理由：**用户的手动记账经常选错类目，类目不该是唯一依据。**

`RIGID_NOTE_KEYWORDS`（14 个，`note-keywords.js`）：学费、房租、房贷、保费、利息、物业费、奶粉、尿布、药、看病、住院、保险、宽带、税

### 3.6 导出清单

```js
module.exports = { RIGID_IDS, SEMI_IDS, LEVEL, compressibilityOf, isRigidBill, LEVEL_LABEL, ... };
```

## 4. 必需性消费

`shared/util/essential-spend.js`（85 行）

```js
function isEssentialSpend(bill)  // true = 不该建议省
```

### 4.1 判定顺序（`isEssentialSpend` 实现原文）

```js
function isEssentialSpend(bill) {
  if (!bill) return false;
  const path = String(bill.categoryPath || '');
  const leaf = path.split('/').pop() || '';   // ⚠️ 取 path 末级，不是 categoryId
  if (ESSENTIAL_LEAF_NAMES.has(leaf)) return true;
  const note = String(bill.note || '');
  if (!note) return false;
  if (ESSENTIAL_NOTE_WORDS.some((w) => note.includes(w))) return true;
  return SOCIAL_NOTE_WORDS.some((w) => note.includes(w));
}
```

| 顺序 | 判据 | 命中结果 |
|---|---|---|
| 1 | **`categoryPath` 末级**在 `ESSENTIAL_LEAF_NAMES`（42 个） | 必需 |
| 2 | 备注含 `ESSENTIAL_NOTE_WORDS`（11 个） | 必需 |
| 3 | 备注含 `SOCIAL_NOTE_WORDS`（12 个） | 必需 |

> ⚠️ **取的是 `categoryPath` 的末级，不是 `categoryId`。**
> 后果：账单**没写 `categoryPath`**（老数据或异常写入）→ 末级为空 → 第 1 条永不命中 →
> **只能靠备注兜底**。改数据写入逻辑时必须保证 `categoryPath` 与 `categoryId` 成对。

### 4.2 必须精确到末级

> 「必须精确到末级（加油 vs 旅游度假），因为同一一级类目下既有必需的也有可选的。用一级判定会误伤。」

### 4.3 42 个必需末级类目名

> ⚠️ **重要：这 42 个名字里只有 17 个是真实的末级类目名**，另外 25 个是口语/别称
> （如「地铁」「高铁」「纸尿裤」在树里叫别的名字）。**匹配时必须按类目名精确比对**，
> 不要假设它们都能在类目树里找到 —— 实测核对结果如下。

**能直接命中末级类目名的 17 个**：

| 域 | 类目名 |
|---|---|
| 交通 | 加油、打车、公共交通 |
| 食品 | 买菜、肉蛋、水产、水果 |
| 居住 | 水电燃气、物业费、房租房贷 |
| 通讯 | 话费流量、宽带 |
| 医疗 | 药品、门诊挂号 |
| 育儿 | 奶粉、尿布 |
| 金融 | 保险保费、贷款利息 |

**其余 25 个是口语/别称**（用于备注兜底，不靠类目名匹配）：

油费、出租车、地铁、公交、高铁、火车票、飞机票、车票、加油费、蔬菜、粮油、生鲜、米面、食品、电费、水费、燃气费、取暖费、药费、看病、门诊、住院、纸尿裤、保费

> **含义**：像「打车」这类词**既是类目名也是口语**，所以「打车去医院」能靠类目名命中必需性；
> 而「坐地铁上班」这种只有备注里写了「通勤」才靠 `ESSENTIAL_NOTE_WORDS` 命中。
> **两条路径缺一不可。**

### 4.4 备注词表

| 词表 | 数量 | 内容 |
|---|---|---|
| `ESSENTIAL_NOTE_WORDS` | 11 | 通勤、上班、必需、必须、刚需、孩子学费、水电、油费、加油 |
| `SOCIAL_NOTE_WORDS` | 12 | 聚餐、请客、随礼、份子钱、红包、聚会、生日、满月、婚礼、乔迁、看望、人情 |
| `SCENE_LABELS` | 10 | unit 单位聚餐、friends 朋友聚会、child 孩子相关… |

### 4.5 社交支出也算必需

> 「『同事聚餐』『请客』『随礼』这类开销，金额确实可以少花，但建议用户少请客、少随礼是不合适的 —— **它伤的是关系，不是理财**。这类支出的正确说法是『这笔是一次性事件，不用每月都花』，而不是『省 X 元』。」

**测试验证**（`saving-rules.test.js`）：通勤加油是必需 / 买菜是必需 / **社交聚餐是必需** / 随礼红包同理 / 买外套可选 / 旅游可压缩 / 备注含「通勤」也算必需。

## 5. ⚠️ 关键词表是单一数据源

`shared/util/note-keywords.js` 被**三处共用**：

```
note-keywords.js
   ├── category-compressibility.js   （刚性判定）
   ├── essential-spend.js            （必需性判定）
   └── note-summary.js               （备注总结丢词检测）
```

**改关键词表会同时影响三个模块** —— 这是设计意图（避免三处口径漂移），但也意味着**改动影响面比看起来大**。

## 6. 类目相关故障速查

| 症状 | 根因 | 修法 |
|---|---|---|
| 界面显示旧类目、统计按旧类目算 | 只改了 `categoryId` 没改 `categoryPath` | **成对写入** |
| 云端拒绝了一次编辑 | 前端全量提交了自定义类目 id（不在预置库） | 前端只提交真正改动的字段 |
| 用户建的类目分类不准 | 关键词表太弱 | 补 `keywords`（自定义类目的 `keywords` 默认只有 `[name]`） |
| 模型编出不存在的类目 id | Prompt 里只给了名称没给 ID | `buildPromptCategoryTree` 必须带 ID |
| 候选列表里出现「虚拟分组」 | `custom_{topId}` 是展示容器不是类目 | 过滤 `customGroup` |
| 学费被建议「省 30%」 | 备注关键词丢了「学费」→ 刚性判定失效 | 检查 `note-keywords.js` 与备注总结的丢词检测 |
| 统计里药品和挂号混在一起 | `c5_1` 二级名是「门诊挂号」但含多个末级 | 按末级（`path` 最后一段）分组 |

详见 `engineering/23-change-impact.md` §6。
