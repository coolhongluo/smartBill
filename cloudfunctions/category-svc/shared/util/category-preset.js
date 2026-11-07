/**
 * 系统预置类目库 —— PRD §7.2 分类树
 *
 * 设计原则（PRD §7.1）：
 * - 按「钱花在哪」而非「东西是什么」划分
 * - 餐饮必须区分「在家吃饭」与「外出就餐」
 * - 交通必须区分「日常交通」「大交通」「出游相关交通」
 *
 * 结构：id / name / level / parentId / path / keywords（规则通道用）/ aliases（用户口语）/ color
 * 注意：keywords 是规则层的第一通道命中率关键，要尽量覆盖真实口语。
 * color 遵循莫兰迪低饱和色系（设计文档 §6.3）。
 *
 * P0 阶段先落地主干与高频末级，末级目标 200~300（P0 验证命中率 ≥85% 即可）
 */

const CATEGORIES = [
  // ============ 1. 餐饮 ============
  {
    id: 'c1', name: '餐饮', level: 1, parentId: null, path: '餐饮',
    color: '#D9A08C', keywords: ['吃', '餐', '饭', 'food']
  },
  // 1.1 在家吃饭 —— 用户核心诉求：与外出就餐严格区分
  {
    id: 'c1_1', name: '在家吃饭', level: 2, parentId: 'c1', path: '餐饮/在家吃饭',
    keywords: ['买菜', '菜场', '菜市场', '生鲜', '超市买菜', '食材'],
    color: '#D9A08C'
  },
  { id: 'c1_1_1', name: '买菜', level: 3, parentId: 'c1_1', path: '餐饮/在家吃饭/买菜', keywords: ['买菜', '蔬菜', '青菜', '菜场', '菜市场', '生鲜', '果蔬'], aliases: ['菜场', '蔬菜', '生鲜', '果蔬'] },
  { id: 'c1_1_2', name: '肉蛋', level: 3, parentId: 'c1_1', path: '餐饮/在家吃饭/肉蛋', keywords: ['肉', '猪肉', '牛肉', '鸡蛋', '鸭肉', '排骨', '五花肉'], aliases: ['肉', '蛋'] },
  { id: 'c1_1_3', name: '水产', level: 3, parentId: 'c1_1', path: '餐饮/在家吃饭/水产', keywords: ['鱼', '虾', '蟹', '贝', '水产', '海鲜'], aliases: ['海鲜'] },
  { id: 'c1_1_4', name: '水果', level: 3, parentId: 'c1_1', path: '餐饮/在家吃饭/水果', keywords: ['水果', '苹果', '香蕉', '橙', '西瓜', '葡萄'], aliases: ['果'] },
  { id: 'c1_1_5', name: '米面粮油', level: 3, parentId: 'c1_1', path: '餐饮/在家吃饭/米面粮油', keywords: ['米', '面', '油', '米面', '粮油', '大米', '面粉', '食用油'], aliases: ['米面粮油', '米油'] },
  { id: 'c1_1_6', name: '干货调料', level: 3, parentId: 'c1_1', path: '餐饮/在家吃饭/干货调料', keywords: ['干货', '调料', '酱', '醋', '味精', '香菇', '木耳'], aliases: ['调料', '干货'] },
  { id: 'c1_1_7', name: '熟食卤味', level: 3, parentId: 'c1_1', path: '餐饮/在家吃饭/熟食卤味', keywords: ['熟食', '卤味', '卤', '烧鸡', '酱鸭'], aliases: ['卤味'] },
  { id: 'c1_1_8', name: '早餐早点', level: 3, parentId: 'c1_1', path: '餐饮/在家吃饭/早餐早点', keywords: ['豆浆', '包子', '馒头', '油条', '早点', '粥'], aliases: ['早点', '早餐'] },
  { id: 'c1_1_9', name: '烘焙原料', level: 3, parentId: 'c1_1', path: '餐饮/在家吃饭/烘焙原料', keywords: ['面粉', '黄油', '奶油', '烘焙', '蛋糕材料'], aliases: ['烘焙'] },

  // 1.2 外出就餐 —— 与在家吃饭严格区分，直接决定节省建议是否可执行
  {
    id: 'c1_2', name: '外出就餐', level: 2, parentId: 'c1', path: '餐饮/外出就餐',
    keywords: ['下馆子', '外食', '餐厅', '饭店', '聚餐', '请客', '外卖', '火锅', '烧烤'],
    color: '#E8B8A8'
  },
  { id: 'c1_2_1', name: '下馆子点菜', level: 3, parentId: 'c1_2', path: '餐饮/外出就餐/下馆子点菜', keywords: ['下馆子', '点菜', '饭店', '餐厅', '馆子'], aliases: ['下馆子', '外食', '聚餐', '请客'] },
  { id: 'c1_2_2', name: '火锅烧烤', level: 3, parentId: 'c1_2', path: '餐饮/外出就餐/火锅烧烤', keywords: ['火锅', '烧烤', '串串', '麻辣烫'], aliases: ['火锅', '烧烤'] },
  { id: 'c1_2_3', name: '日料韩餐', level: 3, parentId: 'c1_2', path: '餐饮/外出就餐/日料韩餐', keywords: ['日料', '韩餐', '寿司', '韩式', '日式'], aliases: ['日料', '韩餐'] },
  { id: 'c1_2_4', name: '西餐快餐', level: 3, parentId: 'c1_2', path: '餐饮/外出就餐/西餐快餐', keywords: ['西餐', '快餐', '汉堡', '披萨', '简餐'], aliases: ['西餐', '快餐'] },
  { id: 'c1_2_5', name: '早餐外食', level: 3, parentId: 'c1_2', path: '餐饮/外出就餐/早餐外食', keywords: ['豆浆', '包子', '早午餐', '肠粉'], aliases: ['外带早餐'] },
  { id: 'c1_2_6', name: '咖啡茶饮', level: 3, parentId: 'c1_2', path: '餐饮/外出就餐/咖啡茶饮', keywords: ['咖啡', '茶', '奶茶', '拿铁', '美式'], aliases: ['奶茶', '咖啡'] },
  { id: 'c1_2_7', name: '外卖', level: 3, parentId: 'c1_2', path: '餐饮/外出就餐/外卖', keywords: ['外卖', '美团', '饿了么', '点外卖'], aliases: ['外卖', '外卖餐'] },
  { id: 'c1_2_8', name: '聚餐宴请', level: 3, parentId: 'c1_2', path: '餐饮/外出就餐/聚餐宴请', keywords: ['宴请', '聚餐', '请客', '结婚酒', '满月酒'], aliases: ['宴请', '请客'] },

  // 1.3 饮品与零食
  {
    id: 'c1_3', name: '饮品与零食', level: 2, parentId: 'c1', path: '餐饮/饮品与零食',
    keywords: ['零食', '饮料', '瓶装水', '坚果'], color: '#C9B79C'
  },
  { id: 'c1_3_1', name: '瓶装水', level: 3, parentId: 'c1_3', path: '餐饮/饮品与零食/瓶装水', keywords: ['瓶装水', '矿泉水', '水'], aliases: ['水'] },
  { id: 'c1_3_2', name: '饮料', level: 3, parentId: 'c1_3', path: '餐饮/饮品与零食/饮料', keywords: ['饮料', '可乐', '果汁', '汽水'], aliases: ['饮料'] },
  { id: 'c1_3_3', name: '零食坚果', level: 3, parentId: 'c1_3', path: '餐饮/饮品与零食/零食坚果', keywords: ['零食', '坚果', '薯片', '巧克力', '糖果'], aliases: ['零食'] },
  { id: 'c1_3_4', name: '乳品', level: 3, parentId: 'c1_3', path: '餐饮/饮品与零食/乳品', keywords: ['牛奶', '酸奶', '乳品', '奶粉'], aliases: ['牛奶', '酸奶'] },

  // 1.4 单位与集体
  {
    id: 'c1_4', name: '单位与集体', level: 2, parentId: 'c1', path: '餐饮/单位与集体',
    keywords: ['食堂', '工作餐', '单位聚餐', '学校食堂'], color: '#C9B79C'
  },
  { id: 'c1_4_1', name: '工作餐', level: 3, parentId: 'c1_4', path: '餐饮/单位与集体/工作餐', keywords: ['工作餐', '食堂', '单位餐'], aliases: ['食堂', '工作餐'] },
  { id: 'c1_4_2', name: '单位聚餐', level: 3, parentId: 'c1_4', path: '餐饮/单位与集体/单位聚餐', keywords: ['单位聚餐', '团建', '部门聚餐'], aliases: ['团建'] },
  { id: 'c1_4_3', name: '学校食堂', level: 3, parentId: 'c1_4', path: '餐饮/单位与集体/学校食堂', keywords: ['学校食堂', '幼儿园', '学校餐'], aliases: ['学校食堂'] },

  // ============ 2. 交通出行 ============
  {
    id: 'c2', name: '交通出行', level: 1, parentId: null, path: '交通出行',
    color: '#8FA9C4', keywords: ['交通', '出行', '车']
  },
  // 2.1 日常交通（高频小额）
  {
    id: 'c2_1', name: '日常交通', level: 2, parentId: 'c2', path: '交通出行/日常交通',
    keywords: ['地铁', '公交', '打车', '滴滴', '单车', '停车', '加油', '通勤'], color: '#8FA9C4'
  },
  { id: 'c2_1_1', name: '地铁公交', level: 3, parentId: 'c2_1', path: '交通出行/日常交通/地铁公交', keywords: ['地铁', '公交', '地铁卡', '公交卡', '乘车码'], aliases: ['地铁', '公交', '通勤'] },
  { id: 'c2_1_2', name: '打车', level: 3, parentId: 'c2_1', path: '交通出行/日常交通/打车', keywords: ['打车', '滴滴', '出租车', '网约车', '打车费'], aliases: ['打车', '滴滴', '出租车'] },
  { id: 'c2_1_3', name: '共享单车', level: 3, parentId: 'c2_1', path: '交通出行/日常交通/共享单车', keywords: ['单车', '共享单车', '摩拜', '哈啰'], aliases: ['单车'] },
  { id: 'c2_1_4', name: '停车费', level: 3, parentId: 'c2_1', path: '交通出行/日常交通/停车费', keywords: ['停车', '停车费', '车位'], aliases: ['停车'] },
  { id: 'c2_1_5', name: '加油', level: 3, parentId: 'c2_1', path: '交通出行/日常交通/加油', keywords: ['加油', '汽油', '柴油', '油费'], aliases: ['加油'] },
  { id: 'c2_1_6', name: '车辆保养', level: 3, parentId: 'c2_1', path: '交通出行/日常交通/车辆保养', keywords: ['保养', '维修', '修车', '4S店', '换机油'], aliases: ['保养', '修车'] },
  { id: 'c2_1_7', name: '过路费', level: 3, parentId: 'c2_1', path: '交通出行/日常交通/过路费', keywords: ['过路费', '高速', 'ETC'], aliases: ['过路费', '高速费'] },

  // 2.2 大交通（跨城长途，归入出行性质）
  {
    id: 'c2_2', name: '大交通', level: 2, parentId: 'c2', path: '交通出行/大交通',
    keywords: ['高铁', '飞机', '长途', '火车', '机票', '跨城'], color: '#A8B8D0'
  },
  { id: 'c2_2_1', name: '高铁飞机', level: 3, parentId: 'c2_2', path: '交通出行/大交通/高铁飞机', keywords: ['高铁', '飞机', '机票', '航班', '动车'], aliases: ['高铁', '飞机', '机票', '动车'] },
  { id: 'c2_2_2', name: '长途汽车', level: 3, parentId: 'c2_2', path: '交通出行/大交通/长途汽车', keywords: ['长途', '大巴', '客车'], aliases: ['大巴'] },
  { id: 'c2_2_3', name: '火车卧铺', level: 3, parentId: 'c2_2', path: '交通出行/大交通/火车卧铺', keywords: ['卧铺', '火车', '绿皮车'], aliases: ['卧铺'] },

  // 2.3 出游相关交通（单列）
  {
    id: 'c2_3', name: '出游相关交通', level: 2, parentId: 'c2', path: '交通出行/出游相关交通',
    keywords: ['旅游', '出游', '包车', '景区', '门票', '导游', '旅行'], color: '#A8B8D0'
  },
  { id: 'c2_3_1', name: '旅游包车', level: 3, parentId: 'c2_3', path: '交通出行/出游相关交通/旅游包车', keywords: ['包车', '旅游车', '租车', '自驾游'], aliases: ['包车', '租车'] },
  { id: 'c2_3_2', name: '景区门票', level: 3, parentId: 'c2_3', path: '交通出行/出游相关交通/景区门票', keywords: ['门票', '景区', '景点', '门票钱'], aliases: ['门票'] },
  { id: 'c2_3_3', name: '导游', level: 3, parentId: 'c2_3', path: '交通出行/出游相关交通/导游', keywords: ['导游', '导服'], aliases: ['导游'] },
  { id: 'c2_3_4', name: '旅行交通补贴', level: 3, parentId: 'c2_3', path: '交通出行/出游相关交通/旅行交通补贴', keywords: ['交通补贴', '出行补贴'], aliases: ['交通补贴'] },

  // ============ 3. 居家生活 ============
  {
    id: 'c3', name: '居家生活', level: 1, parentId: null, path: '居家生活',
    color: '#A8BFA0', keywords: ['居家', '家里', '日用', '清洁']
  },
  { id: 'c3_1', name: '日用百货', level: 2, parentId: 'c3', path: '居家生活/日用百货', keywords: ['纸巾', '清洁', '超市', '日用', '厨房用品'], color: '#A8BFA0' },
  { id: 'c3_1_1', name: '纸巾清洁', level: 3, parentId: 'c3_1', path: '居家生活/日用百货/纸巾清洁', keywords: ['纸巾', '抽纸', '卷纸', '洗衣液', '清洁剂', '洗洁精'], aliases: ['纸巾', '洗衣液', '洗洁精'] },
  { id: 'c3_1_2', name: '厨房用品', level: 3, parentId: 'c3_1', path: '居家生活/日用百货/厨房用品', keywords: ['锅', '碗', '厨房', '保鲜膜', '砧板'], aliases: ['厨房用品'] },
  { id: 'c3_1_3', name: '收纳', level: 3, parentId: 'c3_1', path: '居家生活/日用百货/收纳', keywords: ['收纳', '整理箱', '箱子'], aliases: ['收纳'] },
  { id: 'c3_1_4', name: '卫浴用品', level: 3, parentId: 'c3_1', path: '居家生活/日用百货/卫浴用品', keywords: ['牙膏', '牙刷', '沐浴', '洗发', '卫生巾'], aliases: ['卫浴'] },
  { id: 'c3_2', name: '家政服务', level: 2, parentId: 'c3', path: '居家生活/家政服务', keywords: ['保洁', '钟点工', '家政', '清洗'], color: '#A8BFA0' },
  { id: 'c3_2_1', name: '保洁', level: 3, parentId: 'c3_2', path: '居家生活/家政服务/保洁', keywords: ['保洁', '打扫', '清洁服务'], aliases: ['保洁'] },
  { id: 'c3_2_2', name: '钟点工', level: 3, parentId: 'c3_2', path: '居家生活/家政服务/钟点工', keywords: ['钟点工', '小时工'], aliases: ['钟点工'] },
  { id: 'c3_2_3', name: '家电清洗', level: 3, parentId: 'c3_2', path: '居家生活/家政服务/家电清洗', keywords: ['空调清洗', '家电清洗'], aliases: ['家电清洗'] },
  { id: 'c3_3', name: '家居用品', level: 2, parentId: 'c3', path: '居家生活/家居用品', keywords: ['家具', '床上用品', '厨具', '装饰'], color: '#A8BFA0' },
  { id: 'c3_3_1', name: '家具', level: 3, parentId: 'c3_3', path: '居家生活/家居用品/家具', keywords: ['家具', '沙发', '桌子', '椅子'], aliases: ['家具'] },
  { id: 'c3_3_2', name: '床上用品', level: 3, parentId: 'c3_3', path: '居家生活/家居用品/床上用品', keywords: ['被子', '床单', '枕头', '床垫'], aliases: ['床上用品'] },
  { id: 'c3_3_3', name: '厨具', level: 3, parentId: 'c3_3', path: '居家生活/家居用品/厨具', keywords: ['厨具', '锅具', '刀具'], aliases: ['厨具'] },
  { id: 'c3_3_4', name: '装饰', level: 3, parentId: 'c3_3', path: '居家生活/家居用品/装饰', keywords: ['装饰', '摆件', '绿植'], aliases: ['装饰'] },

  // ============ 4. 育儿教育 ============
  {
    id: 'c4', name: '育儿教育', level: 1, parentId: null, path: '育儿教育',
    color: '#D9B98C', keywords: ['孩子', '教育', '上学', '育儿']
  },
  { id: 'c4_1', name: '日常上学', level: 2, parentId: 'c4', path: '育儿教育/日常上学', keywords: ['校车', '接送', '校服', '校园用品'], color: '#D9B98C' },
  { id: 'c4_1_1', name: '校车', level: 3, parentId: 'c4_1', path: '育儿教育/日常上学/校车', keywords: ['校车', '校车费'], aliases: ['校车'] },
  { id: 'c4_1_2', name: '接送', level: 3, parentId: 'c4_1', path: '育儿教育/日常上学/接送', keywords: ['接送', '上下学'], aliases: ['接送'] },
  { id: 'c4_1_3', name: '校服', level: 3, parentId: 'c4_1', path: '育儿教育/日常上学/校服', keywords: ['校服', '园服'], aliases: ['校服'] },
  { id: 'c4_1_4', name: '校园用品', level: 3, parentId: 'c4_1', path: '育儿教育/日常上学/校园用品', keywords: ['校园用品', '文具', '本子'], aliases: ['文具'] },
  { id: 'c4_2', name: '教育支出', level: 2, parentId: 'c4', path: '育儿教育/教育支出', keywords: ['学费', '补习', '书本', '教育'], color: '#D9B98C' },
  { id: 'c4_2_1', name: '学费', level: 3, parentId: 'c4_2', path: '育儿教育/教育支出/学费', keywords: ['学费', '学费钱', '保育费'], aliases: ['学费'] },
  { id: 'c4_2_2', name: '补习班', level: 3, parentId: 'c4_2', path: '育儿教育/教育支出/补习班', keywords: ['补习', '补课', '辅导班'], aliases: ['补习', '补课'] },
  { id: 'c4_2_3', name: '兴趣班', level: 3, parentId: 'c4_2', path: '育儿教育/教育支出/兴趣班', keywords: ['兴趣班', '书法班', '美术班', '舞蹈班'], aliases: ['兴趣班'] },
  { id: 'c4_2_4', name: '绘本教辅', level: 3, parentId: 'c4_2', path: '育儿教育/教育支出/绘本教辅', keywords: ['绘本', '教辅', '练习册'], aliases: ['绘本'] },
  { id: 'c4_2_5', name: '学习设备', level: 3, parentId: 'c4_2', path: '育儿教育/教育支出/学习设备', keywords: ['学习机', '平板', '电脑', '打印机'], aliases: ['学习机'] },
  { id: 'c4_3', name: '孩子吃喝', level: 2, parentId: 'c4', path: '育儿教育/孩子吃喝', keywords: ['奶粉', '辅食', '儿童餐'], color: '#D9B98C' },
  { id: 'c4_3_1', name: '奶粉', level: 3, parentId: 'c4_3', path: '育儿教育/孩子吃喝/奶粉', keywords: ['奶粉', '奶瓶'], aliases: ['奶粉'] },
  { id: 'c4_3_2', name: '零食辅食', level: 3, parentId: 'c4_3', path: '育儿教育/孩子吃喝/零食辅食', keywords: ['辅食', '米粉', '孩子零食'], aliases: ['辅食'] },
  { id: 'c4_3_3', name: '儿童餐', level: 3, parentId: 'c4_3', path: '育儿教育/孩子吃喝/儿童餐', keywords: ['儿童餐', '孩子吃饭'], aliases: ['儿童餐'] },
  { id: 'c4_4', name: '休闲娱乐', level: 2, parentId: 'c4', path: '育儿教育/休闲娱乐', keywords: ['游乐场', '亲子', '玩具'], color: '#D9B98C' },
  { id: 'c4_4_1', name: '游乐场', level: 3, parentId: 'c4_4', path: '育儿教育/休闲娱乐/游乐场', keywords: ['游乐场', '游乐园', '蹦床'], aliases: ['游乐场'] },
  { id: 'c4_4_2', name: '亲子活动', level: 3, parentId: 'c4_4', path: '育儿教育/休闲娱乐/亲子活动', keywords: ['亲子', '亲子活动'], aliases: ['亲子'] },
  { id: 'c4_4_3', name: '玩具', level: 3, parentId: 'c4_4', path: '育儿教育/休闲娱乐/玩具', keywords: ['玩具', '积木', '玩偶'], aliases: ['玩具'] },

  // ============ 5. 医疗健康 ============
  {
    id: 'c5', name: '医疗健康', level: 1, parentId: null, path: '医疗健康',
    color: '#C4A8B8', keywords: ['医疗', '健康', '医院', '药']
  },
  { id: 'c5_1', name: '门诊挂号', level: 2, parentId: 'c5', path: '医疗健康/门诊挂号', keywords: ['挂号', '门诊', '看病', '医院'], color: '#C4A8B8' },
  { id: 'c5_1_1', name: '门诊挂号', level: 3, parentId: 'c5_1', path: '医疗健康/门诊挂号/门诊挂号', keywords: ['挂号', '门诊'], aliases: ['挂号'] },
  { id: 'c5_1_2', name: '药品', level: 3, parentId: 'c5_1', path: '医疗健康/门诊挂号/药品', keywords: ['药', '买药', '布洛芬', '感冒药', '药店'], aliases: ['药', '买药'] },
  { id: 'c5_1_3', name: '体检', level: 3, parentId: 'c5_1', path: '医疗健康/门诊挂号/体检', keywords: ['体检', '体检费'], aliases: ['体检'] },
  { id: 'c5_1_4', name: '疫苗', level: 3, parentId: 'c5_1', path: '医疗健康/门诊挂号/疫苗', keywords: ['疫苗', '打针'], aliases: ['疫苗'] },
  { id: 'c5_1_5', name: '牙科', level: 3, parentId: 'c5_1', path: '医疗健康/门诊挂号/牙科', keywords: ['牙科', '看牙', '洗牙', '补牙'], aliases: ['看牙'] },
  { id: 'c5_1_6', name: '眼科配镜', level: 3, parentId: 'c5_1', path: '医疗健康/门诊挂号/眼科配镜', keywords: ['眼科', '配眼镜', '眼镜'], aliases: ['配镜'] },
  { id: 'c5_1_7', name: '保健品', level: 3, parentId: 'c5_1', path: '医疗健康/门诊挂号/保健品', keywords: ['保健品', '维生素'], aliases: ['保健品'] },
  { id: 'c5_1_8', name: '心理咨询', level: 3, parentId: 'c5_1', path: '医疗健康/门诊挂号/心理咨询', keywords: ['心理咨询', '心理'], aliases: ['心理咨询'] },

  // ============ 6. 服饰美容 ============
  {
    id: 'c6', name: '服饰美容', level: 1, parentId: null, path: '服饰美容',
    color: '#D0A8C0', keywords: ['服饰', '美容', '穿', '美']
  },
  { id: 'c6_1', name: '衣物鞋帽', level: 2, parentId: 'c6', path: '服饰美容/衣物鞋帽', keywords: ['衣服', '鞋', '帽', '服饰'], color: '#D0A8C0' },
  { id: 'c6_1_1', name: '衣物', level: 3, parentId: 'c6_1', path: '服饰美容/衣物鞋帽/衣物', keywords: ['衣服', '外套', '裤子', '裙子', 'T恤'], aliases: ['衣服'] },
  { id: 'c6_1_2', name: '鞋帽', level: 3, parentId: 'c6_1', path: '服饰美容/衣物鞋帽/鞋帽', keywords: ['鞋', '靴', '帽子'], aliases: ['鞋'] },
  { id: 'c6_2', name: '母婴用品', level: 2, parentId: 'c6', path: '服饰美容/母婴用品', keywords: ['母婴', '尿布', '纸尿裤'], color: '#D0A8C0' },
  { id: 'c6_2_1', name: '尿布', level: 3, parentId: 'c6_2', path: '服饰美容/母婴用品/尿布', keywords: ['尿布', '纸尿裤'], aliases: ['纸尿裤'] },
  { id: 'c6_3', name: '化妆品', level: 2, parentId: 'c6', path: '服饰美容/化妆品', keywords: ['化妆品', '护肤', '口红', '面膜'], color: '#D0A8C0' },
  { id: 'c6_3_1', name: '化妆品', level: 3, parentId: 'c6_3', path: '服饰美容/化妆品/化妆品', keywords: ['化妆品', '口红', '粉底'], aliases: ['化妆品'] },
  { id: 'c6_3_2', name: '护肤', level: 3, parentId: 'c6_3', path: '服饰美容/化妆品/护肤', keywords: ['护肤', '面膜', '精华', '面霜'], aliases: ['护肤'] },
  { id: 'c6_4', name: '洗护用品', level: 2, parentId: 'c6', path: '服饰美容/洗护用品', keywords: ['洗发', '洗护', '沐浴露'], color: '#D0A8C0' },
  { id: 'c6_4_1', name: '洗护用品', level: 3, parentId: 'c6_4', path: '服饰美容/洗护用品/洗护用品', keywords: ['洗发水', '沐浴露'], aliases: ['洗护'] },
  { id: 'c6_5', name: '理发美甲', level: 2, parentId: 'c6', path: '服饰美容/理发美甲', keywords: ['理发', '美甲', '美容'], color: '#D0A8C0' },
  { id: 'c6_5_1', name: '理发', level: 3, parentId: 'c6_5', path: '服饰美容/理发美甲/理发', keywords: ['理发', '剪头发', '烫发'], aliases: ['理发'] },
  { id: 'c6_5_2', name: '美甲', level: 3, parentId: 'c6_5', path: '服饰美容/理发美甲/美甲', keywords: ['美甲', '做指甲'], aliases: ['美甲'] },
  { id: 'c6_6', name: '珠宝饰品', level: 2, parentId: 'c6', path: '服饰美容/珠宝饰品', keywords: ['珠宝', '饰品', '项链'], color: '#D0A8C0' },
  { id: 'c6_6_1', name: '珠宝饰品', level: 3, parentId: 'c6_6', path: '服饰美容/珠宝饰品/珠宝饰品', keywords: ['珠宝', '项链', '戒指'], aliases: ['首饰'] },

  // ============ 7. 人情往来 ============
  {
    id: 'c7', name: '人情往来', level: 1, parentId: null, path: '人情往来',
    color: '#C9B79C', keywords: ['人情', '红包', '送礼']
  },
  { id: 'c7_1', name: '红包礼金', level: 2, parentId: 'c7', path: '人情往来/红包礼金', keywords: ['红包', '礼金'], color: '#C9B79C' },
  { id: 'c7_1_1', name: '红包礼金', level: 3, parentId: 'c7_1', path: '人情往来/红包礼金/红包礼金', keywords: ['红包', '礼金', '压岁钱'], aliases: ['红包'] },
  { id: 'c7_2', name: '送礼', level: 2, parentId: 'c7', path: '人情往来/送礼', keywords: ['送礼', '礼物', '礼品'], color: '#C9B79C' },
  { id: 'c7_2_1', name: '送礼', level: 3, parentId: 'c7_2', path: '人情往来/送礼/送礼', keywords: ['送礼', '礼物', '伴手礼'], aliases: ['礼物'] },
  { id: 'c7_3', name: '请客随份子', level: 2, parentId: 'c7', path: '人情往来/请客随份子', keywords: ['份子', '随份子'], color: '#C9B79C' },
  { id: 'c7_3_1', name: '请客随份子', level: 3, parentId: 'c7_3', path: '人情往来/请客随份子/请客随份子', keywords: ['份子钱', '随份子'], aliases: ['份子'] },
  { id: 'c7_4', name: '孝敬老人', level: 2, parentId: 'c7', path: '人情往来/孝敬老人', keywords: ['孝敬', '爸妈', '老人'], color: '#C9B79C' },
  { id: 'c7_4_1', name: '孝敬老人', level: 3, parentId: 'c7_4', path: '人情往来/孝敬老人/孝敬老人', keywords: ['孝敬老人', '给爸妈'], aliases: ['孝敬'] },

  // ============ 8. 通讯网络 ============
  {
    id: 'c8', name: '通讯网络', level: 1, parentId: null, path: '通讯网络',
    color: '#9CB8C4', keywords: ['通讯', '网络', '话费', '会员']
  },
  { id: 'c8_1', name: '话费流量', level: 2, parentId: 'c8', path: '通讯网络/话费流量', keywords: ['话费', '流量', '手机费'], color: '#9CB8C4' },
  { id: 'c8_1_1', name: '话费流量', level: 3, parentId: 'c8_1', path: '通讯网络/话费流量/话费流量', keywords: ['话费', '流量', '手机费', '充值'], aliases: ['话费', '充话费'] },
  { id: 'c8_2', name: '宽带', level: 2, parentId: 'c8', path: '通讯网络/宽带', keywords: ['宽带', '网费'], color: '#9CB8C4' },
  { id: 'c8_2_1', name: '宽带', level: 3, parentId: 'c8_2', path: '通讯网络/宽带/宽带', keywords: ['宽带', '网费'], aliases: ['宽带'] },
  { id: 'c8_3', name: '会员订阅', level: 2, parentId: 'c8', path: '通讯网络/会员订阅', keywords: ['会员', '订阅', '视频会员'], color: '#9CB8C4' },
  { id: 'c8_3_1', name: '视频会员', level: 3, parentId: 'c8_3', path: '通讯网络/会员订阅/视频会员', keywords: ['视频会员', '爱奇艺', '腾讯视频', '优酷', '芒果'], aliases: ['视频会员'] },
  { id: 'c8_3_2', name: '音乐会员', level: 3, parentId: 'c8_3', path: '通讯网络/会员订阅/音乐会员', keywords: ['音乐会员', '网易云', 'QQ音乐'], aliases: ['音乐会员'] },
  { id: 'c8_3_3', name: '云盘会员', level: 3, parentId: 'c8_3', path: '通讯网络/会员订阅/云盘会员', keywords: ['云盘', '网盘会员'], aliases: ['网盘'] },
  { id: 'c8_3_4', name: '会员购', level: 3, parentId: 'c8_3', path: '通讯网络/会员订阅/会员购', keywords: ['会员购'], aliases: ['会员购'] },

  // ============ 9. 居住 ============
  {
    id: 'c9', name: '居住', level: 1, parentId: null, path: '居住',
    color: '#AFA8C4', keywords: ['居住', '房租', '水电', '物业']
  },
  { id: 'c9_1', name: '房租房贷', level: 2, parentId: 'c9', path: '居住/房租房贷', keywords: ['房租', '房贷', '租金'], color: '#AFA8C4' },
  { id: 'c9_1_1', name: '房租房贷', level: 3, parentId: 'c9_1', path: '居住/房租房贷/房租房贷', keywords: ['房租', '房贷', '租金'], aliases: ['房租'] },
  { id: 'c9_2', name: '物业费', level: 2, parentId: 'c9', path: '居住/物业费', keywords: ['物业费', '物业'], color: '#AFA8C4' },
  { id: 'c9_2_1', name: '物业费', level: 3, parentId: 'c9_2', path: '居住/物业费/物业费', keywords: ['物业费', '物业'], aliases: ['物业费'] },
  { id: 'c9_3', name: '水电气暖', level: 2, parentId: 'c9', path: '居住/水电气暖', keywords: ['水电', '电费', '水费', '燃气', '供暖'], color: '#AFA8C4' },
  { id: 'c9_3_1', name: '水电燃气', level: 3, parentId: 'c9_3', path: '居住/水电气暖/水电燃气', keywords: ['水电', '电费', '水费', '燃气', '天然气'], aliases: ['水电', '交水电费'] },
  { id: 'c9_3_2', name: '供暖', level: 3, parentId: 'c9_3', path: '居住/水电气暖/供暖', keywords: ['供暖', '暖气'], aliases: ['暖气'] },
  { id: 'c9_4', name: '房屋维修', level: 2, parentId: 'c9', path: '居住/房屋维修', keywords: ['维修', '装修', '修房'], color: '#AFA8C4' },
  { id: 'c9_4_1', name: '房屋维修', level: 3, parentId: 'c9_4', path: '居住/房屋维修/房屋维修', keywords: ['维修', '装修'], aliases: ['装修'] },

  // ============ 10. 金融保险 ============
  {
    id: 'c10', name: '金融保险', level: 1, parentId: null, path: '金融保险',
    color: '#B8B89C', keywords: ['金融', '保险', '贷款', '投资']
  },
  { id: 'c10_1', name: '保险保费', level: 2, parentId: 'c10', path: '金融保险/保险保费', keywords: ['保险', '保费'], color: '#B8B89C' },
  { id: 'c10_1_1', name: '保险保费', level: 3, parentId: 'c10_1', path: '金融保险/保险保费/保险保费', keywords: ['保险', '保费', '寿险', '车险'], aliases: ['保险'] },
  { id: 'c10_2', name: '贷款利息', level: 2, parentId: 'c10', path: '金融保险/贷款利息', keywords: ['利息', '贷款'], color: '#B8B89C' },
  { id: 'c10_2_1', name: '贷款利息', level: 3, parentId: 'c10_2', path: '金融保险/贷款利息/贷款利息', keywords: ['利息', '贷款'], aliases: ['利息'] },
  { id: 'c10_3', name: '投资支出', level: 2, parentId: 'c10', path: '金融保险/投资支出', keywords: ['投资', '基金', '股票'], color: '#B8B89C' },
  { id: 'c10_3_1', name: '投资支出', level: 3, parentId: 'c10_3', path: '金融保险/投资支出/投资支出', keywords: ['投资', '基金', '股票'], aliases: ['理财'] },
  { id: 'c10_4', name: '手续费', level: 2, parentId: 'c10', path: '金融保险/手续费', keywords: ['手续费', '年费'], color: '#B8B89C' },
  { id: 'c10_4_1', name: '手续费', level: 3, parentId: 'c10_4', path: '金融保险/手续费/手续费', keywords: ['手续费', '年费', '跨行转'], aliases: ['手续费'] },

  // ============ 11. 文体娱乐 ============
  {
    id: 'c11', name: '文体娱乐', level: 1, parentId: null, path: '文体娱乐',
    color: '#C4A898', keywords: ['娱乐', '文体', '玩', '学习用品']
  },
  { id: 'c11_1', name: '书籍', level: 2, parentId: 'c11', path: '文体娱乐/书籍', keywords: ['书', '书籍', '图书'], color: '#C4A898' },
  { id: 'c11_1_1', name: '书籍', level: 3, parentId: 'c11_1', path: '文体娱乐/书籍/书籍', keywords: ['书', '买书', '图书'], aliases: ['书'] },
  { id: 'c11_2', name: '课程', level: 2, parentId: 'c11', path: '文体娱乐/课程', keywords: ['课程', '网课'], color: '#C4A898' },
  { id: 'c11_2_1', name: '课程', level: 3, parentId: 'c11_2', path: '文体娱乐/课程/课程', keywords: ['课程', '网课', '培训'], aliases: ['课'] },
  { id: 'c11_3', name: '观影演出', level: 2, parentId: 'c11', path: '文体娱乐/观影演出', keywords: ['电影', '演出', '演唱会', '话剧'], color: '#C4A898' },
  { id: 'c11_3_1', name: '观影演出', level: 3, parentId: 'c11_3', path: '文体娱乐/观影演出/观影演出', keywords: ['电影', '演出', '演唱会', '话剧'], aliases: ['电影'] },
  { id: 'c11_4', name: '旅游度假', level: 2, parentId: 'c11', path: '文体娱乐/旅游度假', keywords: ['旅游', '度假', '旅行', '酒店'], color: '#C4A898' },
  { id: 'c11_4_1', name: '旅游度假', level: 3, parentId: 'c11_4', path: '文体娱乐/旅游度假/旅游度假', keywords: ['旅游', '度假', '旅行', '酒店', '民宿'], aliases: ['旅游', '旅行'] },
  { id: 'c11_5', name: '运动健身', level: 2, parentId: 'c11', path: '文体娱乐/运动健身', keywords: ['健身', '运动', '游泳', '瑜伽'], color: '#C4A898' },
  { id: 'c11_5_1', name: '运动健身', level: 3, parentId: 'c11_5', path: '文体娱乐/运动健身/运动健身', keywords: ['健身', '运动', '游泳', '瑜伽', '健身房'], aliases: ['健身'] },
  { id: 'c11_6', name: '手作', level: 2, parentId: 'c11', path: '文体娱乐/手作', keywords: ['手工', '手作', '陶艺'], color: '#C4A898' },
  { id: 'c11_6_1', name: '手作', level: 3, parentId: 'c11_6', path: '文体娱乐/手作/手作', keywords: ['手工', '手作', '陶艺'], aliases: ['手工'] },

  // ============ 12. 其他 ============
  {
    id: 'c12', name: '其他', level: 1, parentId: null, path: '其他',
    color: '#C0C0C0', keywords: ['其他', '杂']
  },
  { id: 'c12_1', name: '未分类', level: 2, parentId: 'c12', path: '其他/未分类', keywords: [], color: '#C0C0C0' },
  { id: 'c12_1_1', name: '未分类', level: 3, parentId: 'c12_1', path: '其他/未分类/未分类', keywords: [], color: '#C0C0C0' },
  { id: 'c12_2', name: '丢失', level: 2, parentId: 'c12', path: '其他/丢失', keywords: ['丢', '丢失', '遗失'], color: '#C0C0C0' },
  { id: 'c12_2_1', name: '丢失', level: 3, parentId: 'c12_2', path: '其他/丢失/丢失', keywords: ['丢', '丢失', '遗失'], aliases: ['丢了'] },
  { id: 'c12_3', name: '捐赠', level: 2, parentId: 'c12', path: '其他/捐赠', keywords: ['捐', '捐赠', '公益'], color: '#C0C0C0' },
  { id: 'c12_3_1', name: '捐赠', level: 3, parentId: 'c12_3', path: '其他/捐赠/捐赠', keywords: ['捐', '捐赠', '公益'], aliases: ['捐款'] }
];

/** 索引：id → category */
const CATEGORY_MAP = new Map(CATEGORIES.map((c) => [c.id, c]));

/**
 * 一级类目配色 —— 设计文档 §6「莫兰迪 12 色板」
 *
 * 颜色挂在**一级类目**而非末级：饼图按一级聚合才用得上，
 * 且 166 个类目各配一色既不可读也无法稳定记忆。
 * 低饱和度是刻意选择——记账界面要长时间盯视，高饱和度刺眼且易引发
 * 「红色=超支」的误读（注意：这里的红不代表涨跌，涨跌另有语义）。
 */
const TOP_COLORS = {
  c1:  '#E8836F', // 餐饮
  c2:  '#6B9AC4', // 交通出行
  c3:  '#7FB685', // 居家生活
  c4:  '#C99BC0', // 育儿教育
  c5:  '#E0A96D', // 医疗健康
  c6:  '#9A8FC4', // 服饰美容
  c7:  '#D98C9E', // 人情往来
  c8:  '#6FB3B8', // 通讯网络
  c9:  '#A98F6D', // 居住
  c10: '#8C9AA6', // 金融保险
  c11: '#C4A484', // 文体娱乐
  c12: '#A8A8A8'  // 其他
};

const DEFAULT_COLOR = '#A8A8A8';

/** 取类目展示色：向上找所属一级类目的配色 */
function colorOf(categoryId) {
  if (!categoryId) return DEFAULT_COLOR;
  // id 形如 c1_1_1，首段即一级
  const topKey = String(categoryId).split('_')[0];
  return TOP_COLORS[topKey] || DEFAULT_COLOR;
}

/**
 * 按 id 取预置类目的 path
 *
 * ## 为什么需要它
 *
 * 编辑账单时 categoryId 与 categoryPath 必须成对写入——
 * 统计侧（bill-stats.js）完全依赖 categoryPath 做分组：
 *   top    = split('/')[0]   占比、刚性判定
 *   leaf   = split('/').pop() 末级类目分组
 *   second = split('/')[1]   餐饮的「在家吃饭 / 外出就餐」
 *
 * 只写 id 不写 path，界面显示的还是旧类目、统计也按旧类目算，
 * 但用户明明已经改了类目 —— 数据自相矛盾。
 *
 * 前端已经能拿到完整 path，但**云端不能完全信任前端传的 path**：
 * 传错了就会写入与 id 不匹配的 path。因此以 id 为准反查，
 * 查不到才说明这个类目真的不存在。
 *
 * @param {string} categoryId
 * @returns {string} path，找不到返回空串
 */
function pathOf(categoryId) {
  if (!categoryId) return '';
  const hit = CATEGORIES.find((c) => c.id === categoryId);
  return hit ? (hit.path || hit.name || '') : '';
}

/** 该 id 是否为已知预置类目 */
function hasCategory(categoryId) {
  if (!categoryId) return false;
  return CATEGORIES.some((c) => c.id === categoryId);
}

/** 所有末级类目（level 3），分类引擎默认在这些里选 */
const LEAF_CATEGORIES = CATEGORIES.filter((c) => c.level === 3);

/** 一级大类 */
const TOP_CATEGORIES = CATEGORIES.filter((c) => c.level === 1);

/** 末级类目数量统计（P0 验证用） */
const stats = {
  total: CATEGORIES.length,
  level1: TOP_CATEGORIES.length,
  leaf: LEAF_CATEGORIES.length
};

/**
 * 供Prompt 注入的压缩类目树（技术文档 §3.5.1 P1 优先级）
 *
 * 关键修正（实测踩坑）：**必须带 ID**。
 * 只给「买菜/肉蛋/水产」这样的名称列表时，模型会按ID 命名规律
 * 自行推导出 c5_4_1 / c8_5_1 这类不存在的 ID —— 实测幻觉率一度达 14%，
 * 且幻觉后被护栏直接 break 不重试，导致整体成功率掉到 85%。
 * 模型不会算 c11_4_1 对应哪个类目，它只能抄。
 *
 * @param {string[]} leafIds 需要完整展开的末级类目 id 列表
 */
function buildPromptCategoryTree(leafIds = []) {
  const lines = [];
  for (const top of TOP_CATEGORIES) {
    lines.push(`${top.name}`);
    for (const lv2 of CATEGORIES.filter((c) => c.parentId === top.id)) {
      const children = CATEGORIES.filter((c) => c.parentId === lv2.id);
      const wanted = children.filter((c) => leafIds.includes(c.id));
      const shown = wanted.length ? wanted : children;
      // 每项都写成「ID 名称」，让模型只能从清单里挑，不能推导
      lines.push(`  ${lv2.name}: ${shown.map((c) => `${c.id} ${c.name}`).join(' / ')}`);
    }
  }
  return lines.join('\n');
}

module.exports = {
  CATEGORIES,
  CATEGORY_MAP,
  LEAF_CATEGORIES,
  TOP_CATEGORIES,
  TOP_COLORS,
  DEFAULT_COLOR,
  colorOf,
  pathOf,
  hasCategory,
  stats,
  buildPromptCategoryTree
};