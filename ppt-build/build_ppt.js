// AI Agent 进化之路 — 13-slide dark-tech deck with a persistent timeline motif
const pptxgen = require("pptxgenjs");
const fs = require("fs");
const path = require("path");

const A = (p) => path.join(__dirname, "assets", p);
const I = (n) => "image/png;base64," + fs.readFileSync(A(path.join("icons", n + ".png"))).toString("base64");

// ---- design tokens ----
const C = {
  bg: "0B1120", card: "141E36", cardLine: "273455", cardLine2: "24324F",
  text: "F1F5F9", body: "C7D2E5", mute: "8B9BB8", dim: "5A6B8C",
  s1: "22D3EE", s2: "A78BFA", s3: "34D399",
  ghost1: "145568", ghost2: "423C6C", ghost3: "19554A",
  chipFill: "1A2542",
};
const F = "Microsoft YaHei";
const STAGE = { 1: C.s1, 2: C.s2, 3: C.s3 };
const sh = () => ({ type: "outer", color: "000000", blur: 7, offset: 3, angle: 90, opacity: 0.35 });

const pres = new pptxgen();
pres.layout = "LAYOUT_16x9";
pres.author = "ZCode";
pres.title = "AI Agent 进化之路";

// ---- helpers ----
const T = (sl, txt, o) => sl.addText(txt, Object.assign({ fontFace: F, margin: 0 }, o));
const card = (sl, x, y, w, h, o = {}) =>
  sl.addShape(pres.shapes.ROUNDED_RECTANGLE, Object.assign({
    x, y, w, h, rectRadius: 0.08, fill: { color: C.card }, line: { color: C.cardLine2, width: 1 }, shadow: sh(),
  }, o));

function iconCircle(sl, icon, x, y, d, colr) {
  sl.addShape(pres.shapes.OVAL, { x, y, w: d, h: d, fill: { color: colr, transparency: 85 }, line: { color: colr, width: 1 } });
  const pad = d * 0.28;
  sl.addImage({ data: I(icon), x: x + pad, y: y + pad, w: d - 2 * pad, h: d - 2 * pad });
}

function header(sl, stage, kicker, title, sub) {
  T(sl, kicker, { x: 0.5, y: 0.32, w: 9, h: 0.24, fontSize: 9.5, bold: true, color: STAGE[stage], charSpacing: 2.5 });
  T(sl, title, { x: 0.5, y: 0.58, w: 9, h: 0.55, fontSize: 25, bold: true, color: C.text });
  if (sub) T(sl, sub, { x: 0.5, y: 1.14, w: 9, h: 0.3, fontSize: 11.5, italic: true, color: C.mute });
}

// persistent mini timeline at the bottom — the motif running through the deck
function footer(sl, stage, pageNo) {
  const dots = [1.5, 5.0, 8.5], labels = ["01 PROMPT", "02 CONTEXT", "03 HARNESS"];
  sl.addShape(pres.shapes.LINE, { x: 0.5, y: 5.30, w: 9.0, h: 0, line: { color: "223050", width: 1 } });
  const active = dots[stage - 1];
  sl.addShape(pres.shapes.LINE, { x: 1.5, y: 5.30, w: active - 1.5, h: 0, line: { color: STAGE[stage], width: 1.5 } });
  dots.forEach((dx, i) => {
    const on = i + 1 === stage;
    if (on) sl.addShape(pres.shapes.OVAL, { x: dx - 0.11, y: 5.19, w: 0.22, h: 0.22, fill: { color: STAGE[stage], transparency: 72 }, line: { type: "none" } });
    sl.addShape(pres.shapes.OVAL, { x: dx - 0.05, y: 5.25, w: 0.10, h: 0.10, fill: { color: on ? STAGE[stage] : "3A4A6B" }, line: { type: "none" } });
    T(sl, labels[i], { x: dx - 0.7, y: 5.40, w: 1.4, h: 0.2, fontSize: 7.5, align: "center", bold: on, charSpacing: 1, color: on ? STAGE[stage] : "55648A" });
  });
  T(sl, String(pageNo).padStart(2, "0"), { x: 9.2, y: 5.40, w: 0.3, h: 0.2, fontSize: 8, align: "right", color: C.dim });
}

function timelineNode(sl, x, y, d, stage, label) {
  sl.addShape(pres.shapes.OVAL, { x: x - d * 0.32, y: y - d * 0.32, w: d * 1.64, h: d * 1.64, fill: { color: STAGE[stage], transparency: 76 }, line: { type: "none" } });
  sl.addShape(pres.shapes.OVAL, { x: x - d / 2, y: y - d / 2, w: d, h: d, fill: { color: C.bg }, line: { color: STAGE[stage], width: 1.5 } });
  T(sl, label, { x: x - d / 2, y: y - d / 2, w: d, h: d, fontSize: d > 0.32 ? 12 : 10.5, bold: true, align: "center", valign: "middle", color: STAGE[stage] });
}

const chip = (sl, x, y, w, h, txt, colr, o = {}) => {
  sl.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y, w, h, rectRadius: 0.06, fill: { color: colr, transparency: o.noFill ? 100 : 86 }, line: { color: colr, width: 1 } });
  T(sl, txt, { x, y, w, h, fontSize: o.fs || 9.5, bold: true, color: colr, align: "center", valign: "middle", charSpacing: o.cs || 0 });
};

// ============ S1 · COVER ============
{
  const sl = pres.addSlide();
  sl.background = { path: A("bg_cover.png") };
  T(sl, "AI AGENT EVOLUTION · 2020 → 2026", { x: 0.5, y: 0.62, w: 9, h: 0.3, fontSize: 11, bold: true, align: "center", color: C.s1, charSpacing: 3.5 });
  T(sl, "AI Agent 进化之路", { x: 0.5, y: 1.30, w: 9, h: 0.95, fontSize: 44, bold: true, align: "center", color: C.text });
  T(sl, [
    { text: "从 ", options: { color: C.mute } },
    { text: "Prompt Engineering", options: { color: C.s1, bold: true } },
    { text: " 到 ", options: { color: C.mute } },
    { text: "Context Engineering", options: { color: C.s2, bold: true } },
    { text: " 再到 ", options: { color: C.mute } },
    { text: "Harness Engineering", options: { color: C.s3, bold: true } },
  ], { x: 0.5, y: 2.38, w: 9, h: 0.35, fontSize: 15, align: "center" });
  T(sl, "智能体范式的三次跃迁 —— 一条时间线看懂 AI Agent 的进化逻辑", { x: 0.5, y: 2.78, w: 9, h: 0.3, fontSize: 12, italic: true, align: "center", color: C.mute });

  // hero timeline
  const Y = 4.05, xs = [2.1, 5.0, 7.9];
  sl.addShape(pres.shapes.LINE, { x: 1.0, y: Y, w: 8.0, h: 0, line: { color: "1E2C4C", width: 2.25 } });
  [[1.0, 3.53, C.s1], [3.53, 6.42, C.s2], [6.42, 8.85, C.s3]].forEach(([a, b, c], i) =>
    sl.addShape(pres.shapes.LINE, { x: a, y: Y, w: b - a, h: 0, line: { color: c, width: i === 2 ? 2.25 : 2, endArrowType: i === 2 ? "triangle" : "none" } }));
  const nodes = [
    ["2020", "Prompt Engineering", "提示词工程 · 把指令说明白"],
    ["2023", "Context Engineering", "上下文工程 · 把知识装进窗口"],
    ["2025", "Harness Engineering", "运行时工程 · 让智能体跑起来"],
  ];
  xs.forEach((x, i) => {
    const c = STAGE[i + 1];
    T(sl, nodes[i][0], { x: x - 0.8, y: 3.24, w: 1.6, h: 0.3, fontSize: 13, bold: true, align: "center", color: c });
    timelineNode(sl, x, Y, 0.36, i + 1, String(i + 1));
    T(sl, nodes[i][1], { x: x - 1.15, y: 4.30, w: 2.3, h: 0.28, fontSize: 12.5, bold: true, align: "center", color: C.text });
    T(sl, nodes[i][2], { x: x - 1.15, y: 4.60, w: 2.3, h: 0.26, fontSize: 9.5, align: "center", color: C.mute });
  });
  T(sl, "技术分享 · 2026.10", { x: 0.5, y: 5.12, w: 9, h: 0.25, fontSize: 9, align: "center", color: C.dim });
}

// ============ S2 · OVERVIEW TIMELINE ============
{
  const sl = pres.addSlide();
  sl.background = { path: A("bg_content.png") };
  header(sl, 1, "OVERVIEW · 进化全景", "三次范式跃迁，一条主线",
    "从「把话说清楚」，到「把上下文备齐」，再到「把运行时造好」——每一次跃迁，都源自上一代范式的天花板");
  const Y = 2.62, xs = [1.75, 5.0, 8.25];
  sl.addShape(pres.shapes.LINE, { x: 0.9, y: Y, w: 8.2, h: 0, line: { color: "24344F", width: 1.5, endArrowType: "triangle" } });
  [[1.75, 5.0], [5.0, 8.25]].forEach(([a, b]) =>
    sl.addShape(pres.shapes.LINE, { x: a + 0.3, y: Y, w: b - a - 0.62, h: 0, line: { color: "3A4A6B", width: 1.25, endArrowType: "triangle" } }));
  const data = [
    ["2020—2022", "Prompt Engineering", "提示词工程 —— 「会说」", "打磨指令与话术：示例、思维链、角色扮演，把单次问答质量推到极限", "核心命题：怎么问"],
    ["2023—2024", "Context Engineering", "上下文工程 —— 「会学」", "RAG、Memory、Tool Use：把知识、记忆与能力动态装进上下文窗口", "核心命题：喂什么"],
    ["2025 — 今", "Harness Engineering", "运行时工程 —— 「会做」", "Agent 循环、沙箱、权限与编排：为长程自主任务打造工程化运行时", "核心命题：怎么跑"],
  ];
  xs.forEach((x, i) => {
    const c = STAGE[i + 1];
    chip(sl, x - 0.62, 2.08, 1.24, 0.32, data[i][0], c, { fs: 9.5 });
    timelineNode(sl, x, Y, 0.34, i + 1, String(i + 1));
    card(sl, x - 1.35, 3.10, 2.7, 1.70);
    T(sl, data[i][1], { x: x - 1.2, y: 3.24, w: 2.4, h: 0.28, fontSize: 12.5, bold: true, color: c });
    T(sl, data[i][2], { x: x - 1.2, y: 3.55, w: 2.4, h: 0.28, fontSize: 11.5, bold: true, color: C.text });
    T(sl, data[i][3], { x: x - 1.2, y: 3.86, w: 2.42, h: 0.62, fontSize: 9.8, color: C.mute });
    T(sl, data[i][4], { x: x - 1.2, y: 4.50, w: 2.4, h: 0.24, fontSize: 9, bold: true, color: c });
  });
  footer(sl, 1, 2);
}

// ============ section divider factory ============
function divider(no, bgImg, chipTxt, cn, en, tagline, bullets, pageNo) {
  const sl = pres.addSlide();
  sl.background = { path: A(bgImg) };
  const c = STAGE[no], ghost = [C.ghost1, C.ghost2, C.ghost3][no - 1];
  chip(sl, 0.55, 0.60, 2.5, 0.42, chipTxt, c, { fs: 10.5, cs: 1 });
  T(sl, "0" + no, { x: 5.9, y: 1.15, w: 3.6, h: 3.1, fontSize: 175, bold: true, color: ghost, align: "center" });
  T(sl, cn, { x: 0.55, y: 1.55, w: 5.4, h: 0.7, fontSize: 34, bold: true, color: C.text });
  T(sl, en, { x: 0.55, y: 2.28, w: 5.4, h: 0.35, fontSize: 17, bold: true, color: c, charSpacing: 1 });
  T(sl, tagline, { x: 0.55, y: 2.72, w: 5.3, h: 0.55, fontSize: 13, italic: true, color: C.body });
  bullets.forEach((b, i) => {
    const y = 3.42 + i * 0.42;
    sl.addShape(pres.shapes.OVAL, { x: 0.58, y: y + 0.10, w: 0.09, h: 0.09, fill: { color: c }, line: { type: "none" } });
    T(sl, b, { x: 0.82, y, w: 5.2, h: 0.32, fontSize: 11.5, color: C.mute });
  });
  footer(sl, no, pageNo);
  return sl;
}
divider(1, "bg_sec_s1.png", "STAGE 01 · 2020—2022", "提示词工程", "Prompt Engineering",
  "一切始于一次对话：把「问法」变成生产力",
  ["起源 — GPT-3 与 ChatGPT 带火的一门「显学」", "核心技巧 — 从 Few-shot 到思维链的调教手册", "局限 — 提示词范式撞上的四块天花板"], 3);

// ============ S4 · PE ORIGIN ============
{
  const sl = pres.addSlide();
  sl.background = { path: A("bg_content.png") };
  header(sl, 1, "STAGE 01 · PROMPT ENGINEERING", "起源：Prompt 即编程");
  T(sl, "2020 年，GPT-3 带着 1750 亿参数登场：不微调任何权重，只靠提示中的几条示例，就能完成翻译、摘要与问答——「怎么问」第一次比「怎么训」更受关注。",
    { x: 0.5, y: 1.24, w: 4.55, h: 0.75, fontSize: 11.5, color: C.body });
  const rows = [
    ["2020", "GPT-3 惊艳业界", "In-context Learning：不训练、只提示，几条示例即可上手新任务"],
    ["2022", "ChatGPT 现象级出圈", "两个月用户破亿，史上最快；「提示词怎么写」成为全民话题"],
    ["2022", "提示工程师成新职业", "Prompt Engineer 走俏，提示词教程、市场与最佳实践生态涌现"],
  ];
  rows.forEach((r, i) => {
    const y = 2.22 + i * 0.95;
    chip(sl, 0.5, y + 0.02, 0.78, 0.3, r[0], C.s1, { fs: 10 });
    T(sl, r[1], { x: 1.44, y, w: 3.6, h: 0.3, fontSize: 12.5, bold: true, color: C.text });
    T(sl, r[2], { x: 1.44, y: y + 0.31, w: 3.6, h: 0.5, fontSize: 10, color: C.mute });
  });
  // mock prompt card
  card(sl, 5.35, 1.24, 4.15, 2.42);
  T(sl, "PROMPT · 一段会说话的「程序」", { x: 5.6, y: 1.40, w: 3.7, h: 0.24, fontSize: 9, bold: true, color: C.s1, charSpacing: 1.5 });
  sl.addText([
    { text: "你是邮件分类助手。", options: { breakLine: true } },
    { text: "# 示例 (Few-shot)", options: { breakLine: true, color: C.dim } },
    { text: "「限时优惠，点击领取」→ 垃圾", options: { breakLine: true } },
    { text: "「会议改到周四 3 点」→ 正常", options: { breakLine: true } },
    { text: "# 任务 (Instruction)", options: { breakLine: true, color: C.dim } },
    { text: "分类：「您的账单已出，请查收」" },
  ], { x: 5.6, y: 1.70, w: 3.7, h: 1.30, fontFace: "Courier New", fontSize: 9.5, color: C.body, margin: 0, lineSpacing: 15 });
  sl.addShape(pres.shapes.LINE, { x: 5.6, y: 3.10, w: 3.65, h: 0, line: { color: C.cardLine, width: 0.75 } });
  T(sl, "→  输出：正常邮件", { x: 5.6, y: 3.20, w: 3.7, h: 0.28, fontSize: 11, bold: true, color: C.s1 });
  const stats = [
    ["175B", "GPT-3 参数量级——不训练，仅靠提示驱动", 5.35],
    ["2 个月", "ChatGPT 用户破亿，Prompt 全民化", 7.55],
  ];
  stats.forEach(([num, lab, x]) => {
    T(sl, num, { x, y: 3.90, w: 2.0, h: 0.55, fontSize: 30, bold: true, color: C.s1 });
    T(sl, lab, { x, y: 4.48, w: 1.95, h: 0.5, fontSize: 9, color: C.mute });
  });
  footer(sl, 1, 4);
}

// ============ S5 · PE TECHNIQUES ============
{
  const sl = pres.addSlide();
  sl.background = { path: A("bg_content.png") };
  header(sl, 1, "STAGE 01 · PROMPT ENGINEERING", "核心技巧：一份「调教」手册",
    "目标只有一个——在单次问答里，把模型的既有能力激发到极致");
  const cards = [
    ["c_commentDots", "零样本 Zero-shot", "不给示例、直接下达指令，考验模型的「默认功力」，最简单也最常用"],
    ["c_clone", "少样本 Few-shot", "塞进两三个示例，模型立刻模仿格式、口径与风格，效果立竿见影"],
    ["c_chain", "思维链 CoT", "一句「Let's think step by step」，让模型写出推理过程，难题准确率大涨"],
    ["c_role", "角色扮演 Role", "「你是资深法务……」设定身份与场景，激活领域知识与专业语气"],
    ["c_code", "结构化输出", "预先约定 JSON / 表格模板，输出可解析、可校验、可接入程序"],
    ["c_random", "自洽 Self-Consistency", "同一问题多次采样、取多数答案，对冲大模型的随机波动"],
  ];
  cards.forEach((cd, i) => {
    const x = 0.5 + (i % 3) * 3.05, y = 1.62 + Math.floor(i / 3) * 1.80;
    card(sl, x, y, 2.9, 1.66);
    iconCircle(sl, cd[0], x + 0.18, y + 0.16, 0.44, C.s1);
    T(sl, cd[1], { x: x + 0.74, y: y + 0.22, w: 2.05, h: 0.32, fontSize: 12, bold: true, color: C.text });
    T(sl, cd[2], { x: x + 0.2, y: y + 0.74, w: 2.5, h: 0.8, fontSize: 9.8, color: C.mute });
  });
  footer(sl, 1, 5);
}

// ============ S6 · PE LIMITS ============
{
  const sl = pres.addSlide();
  sl.background = { path: A("bg_content.png") };
  header(sl, 1, "STAGE 01 · PROMPT ENGINEERING", "局限：撞上的四块天花板");
  const rows = [
    ["c_unlink", "玄学般脆弱", "同一意图换个措辞，结果天差地别；优化全靠「炼丹」，经验难以复用与沉淀"],
    ["c_snow", "知识被冻结", "模型只记得训练截止前的世界，新信息、私有知识一概不知，也无处补充"],
    ["c_compress", "窗口装不下", "数千 token 的上下文窗口，塞不下企业知识库、长对话与实时变化的信息"],
    ["c_talk", "只会说，不会做", "输出永远是文本：不能检索资料、不能调用 API、不能改变外部世界"],
  ];
  rows.forEach((r, i) => {
    const x = 0.5 + (i % 2) * 4.6, y = 1.32 + Math.floor(i / 2) * 1.68;
    card(sl, x, y, 4.4, 1.52);
    iconCircle(sl, r[0], x + 0.22, y + 0.22, 0.5, C.s1);
    T(sl, r[1], { x: x + 0.88, y: y + 0.24, w: 3.3, h: 0.32, fontSize: 13.5, bold: true, color: C.text });
    T(sl, r[2], { x: x + 0.88, y: y + 0.60, w: 3.32, h: 0.78, fontSize: 10, color: C.mute });
  });
  card(sl, 0.5, 4.68, 9.0, 0.46, { fill: { color: "1B2440" }, line: { color: C.s2, width: 1 } });
  T(sl, [
    { text: "当天花板出现，核心问题从「怎么问」变成「喂什么」——  ", options: { color: C.body } },
    { text: "Context Engineering 应运而生", options: { color: C.s2, bold: true } },
  ], { x: 0.7, y: 4.68, w: 8.6, h: 0.46, fontSize: 11, align: "center", valign: "middle" });
  footer(sl, 1, 6);
}

divider(2, "bg_sec_s2.png", "STAGE 02 · 2023—2024", "上下文工程", "Context Engineering",
  "模型不缺智能，缺的是恰好需要的上下文",
  ["为什么 — Prompt 只是上下文的一小块", "关键技术 — RAG · Memory · Tool Use", "价值 — 从「会说」进化到「会学、会做」"], 7);

// ============ S8 · CE WHY ============
{
  const sl = pres.addSlide();
  sl.background = { path: A("bg_content.png") };
  header(sl, 2, "STAGE 02 · CONTEXT ENGINEERING", "为什么 Context 比 Prompt 更重要？");
  // quote card
  card(sl, 0.5, 1.26, 4.55, 1.00);
  sl.addImage({ data: I("v_quote"), x: 0.70, y: 1.44, w: 0.22, h: 0.22 });
  T(sl, "「提示工程正在让位于上下文工程——真正决定输出的，是窗口里装了什么。」",
    { x: 1.04, y: 1.40, w: 3.85, h: 0.52, fontSize: 11, italic: true, color: C.body });
  T(sl, "— Andrej Karpathy · 2025", { x: 1.04, y: 1.94, w: 3.8, h: 0.24, fontSize: 9, bold: true, color: C.s2 });
  const pts = [
    ["模型是「固定的函数」", "同一模型，输出上限由输入决定——与其反复改话术，不如系统改造输入"],
    ["Prompt 只是上下文的一角", "系统指令、检索文档、对话记忆、工具结果，共同构成每一次调用的真正输入"],
    ["上下文是稀缺资源", "装什么、不装什么、按什么顺序装——这是工程决策，不是话术技巧"],
  ];
  pts.forEach((p, i) => {
    const y = 2.50 + i * 0.86;
    sl.addShape(pres.shapes.RECTANGLE, { x: 0.5, y: y + 0.05, w: 0.09, h: 0.09, fill: { color: C.s2 }, line: { type: "none" } });
    T(sl, p[0], { x: 0.74, y, w: 4.3, h: 0.28, fontSize: 12.5, bold: true, color: C.text });
    T(sl, p[1], { x: 0.74, y: y + 0.30, w: 4.3, h: 0.5, fontSize: 10, color: C.mute });
  });
  // right diagram
  const chips = [["System Prompt · 系统指令", 5.30, 1.28], ["RAG · 检索文档", 7.46, 1.28], ["Memory · 对话记忆", 5.30, 1.84], ["Tool · 工具结果", 7.46, 1.84]];
  chips.forEach(([t, x, y]) => {
    sl.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y, w: 2.0, h: 0.44, rectRadius: 0.06, fill: { color: C.chipFill }, line: { color: "3A3566", width: 1 } });
    T(sl, t, { x, y, w: 2.0, h: 0.44, fontSize: 9.5, color: C.body, align: "center", valign: "middle" });
  });
  [[6.30], [8.46]].forEach(([x]) =>
    sl.addShape(pres.shapes.LINE, { x, y: 2.28, w: 0, h: 0.24, line: { color: "4A4470", width: 1.5, endArrowType: "triangle" } }));
  sl.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: 5.55, y: 2.56, w: 3.66, h: 0.52, rectRadius: 0.08, fill: { color: C.s2, transparency: 82 }, line: { color: C.s2, width: 1.5 } });
  T(sl, "上下文窗口 Context Window", { x: 5.55, y: 2.56, w: 3.66, h: 0.52, fontSize: 12, bold: true, color: C.s2, align: "center", valign: "middle" });
  sl.addShape(pres.shapes.LINE, { x: 7.38, y: 3.08, w: 0, h: 0.26, line: { color: "4A4470", width: 1.5, endArrowType: "triangle" } });
  card(sl, 5.55, 3.36, 3.66, 0.56, { line: { color: C.s2, width: 1.25 } });
  T(sl, "LLM（模型本身不变）", { x: 5.55, y: 3.36, w: 3.66, h: 0.56, fontSize: 12.5, bold: true, color: C.text, align: "center", valign: "middle" });
  sl.addShape(pres.shapes.LINE, { x: 7.38, y: 3.92, w: 0, h: 0.26, line: { color: "4A4470", width: 1.5, endArrowType: "triangle" } });
  sl.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: 5.55, y: 4.20, w: 3.66, h: 0.5, rectRadius: 0.08, fill: { color: C.s2 }, line: { type: "none" }, shadow: sh() });
  T(sl, "更可靠、可落地的输出", { x: 5.55, y: 4.20, w: 3.66, h: 0.5, fontSize: 12.5, bold: true, color: "0B1120", align: "center", valign: "middle" });
  T(sl, "被工程化的，是进入窗口的一切", { x: 5.55, y: 4.80, w: 3.66, h: 0.26, fontSize: 9.5, italic: true, align: "center", color: C.mute });
  footer(sl, 2, 8);
}

// ============ S9 · CE KEY TECH ============
{
  const sl = pres.addSlide();
  sl.background = { path: A("bg_content.png") };
  header(sl, 2, "STAGE 02 · CONTEXT ENGINEERING", "关键技术：给模型装上「外挂」");
  const cols = [
    ["v_db", "RAG · 检索增强", "Retrieval-Augmented Generation",
      "把私有知识切块、向量化、按需检索后注入提示——回答有据可查，幻觉显著减少",
      "文档 → 向量化 → Top-K → 注入", "价值：答案可溯源"],
    ["v_brain", "Memory · 记忆", "Short-term & Long-term Memory",
      "短期记忆维持会话连贯；长期记忆跨会话沉淀偏好与事实，越用越懂你",
      "写入 → 召回 → 遗忘", "价值：个性化与连续性"],
    ["v_tools", "Tool Use · 工具调用", "Function Calling",
      "让模型学会「动手」：搜索、计算、执行代码、调用 API，把意图变成行动",
      "请求 → 执行 → 结果回填", "价值：从「会说」到「会做」"],
  ];
  cols.forEach((c, i) => {
    const x = 0.5 + i * 3.05;
    card(sl, x, 1.30, 2.9, 3.50);
    iconCircle(sl, c[0], x + 1.17, 1.52, 0.56, C.s2);
    T(sl, c[1], { x: x + 0.15, y: 2.22, w: 2.6, h: 0.3, fontSize: 13, bold: true, align: "center", color: C.text });
    T(sl, c[2], { x: x + 0.15, y: 2.53, w: 2.6, h: 0.24, fontSize: 8.5, align: "center", color: C.s2 });
    T(sl, c[3], { x: x + 0.24, y: 2.88, w: 2.44, h: 0.92, fontSize: 10, color: C.mute });
    sl.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: x + 0.18, y: 3.86, w: 2.54, h: 0.36, rectRadius: 0.06, fill: { color: C.chipFill }, line: { color: "3A3566", width: 1 } });
    T(sl, c[4], { x: x + 0.18, y: 3.86, w: 2.54, h: 0.36, fontSize: 9, color: C.body, align: "center", valign: "middle" });
    T(sl, c[5], { x: x + 0.15, y: 4.34, w: 2.6, h: 0.28, fontSize: 10.5, bold: true, align: "center", color: C.s2 });
  });
  T(sl, "三把钥匙，一个本质：为每一次调用，动态构造最恰当的上下文",
    { x: 0.5, y: 4.94, w: 9, h: 0.26, fontSize: 10.5, italic: true, align: "center", color: C.mute });
  footer(sl, 2, 9);
}

divider(3, "bg_sec_s3.png", "STAGE 03 · 2025 — 今", "运行时工程", "Harness Engineering",
  "让智能体真正跑起来：循环、沙箱、权限与编排",
  ["框架演进 — ReAct → 多智能体 → Harness 运行时", "代表产品 — AutoGPT · ACPAgent · OpenClaw", "基础设施 — MCP 协议与开放的工具生态"], 10);

// ============ S11 · HE FRAMEWORK EVOLUTION ============
{
  const sl = pres.addSlide();
  sl.background = { path: A("bg_content.png") };
  header(sl, 3, "STAGE 03 · HARNESS ENGINEERING", "框架演进：从「单循环」到「运行时」");
  sl.addShape(pres.shapes.LINE, { x: 0.80, y: 1.50, w: 0, h: 3.35, line: { color: "24344F", width: 1.5, endArrowType: "triangle" } });
  const rows = [
    ["2022", "ReAct 范式 — Agent 的原型骨架", "「思考 → 行动 → 观察」循环往复，这一论文范式至今仍是绝大多数智能体的底层逻辑"],
    ["2023", "自主智能体元年", "AutoGPT 把「目标 → 拆解 → 执行」全自动循环开源化；LangChain / LlamaIndex 把提示、记忆、工具串成链"],
    ["2024", "多智能体协作", "AutoGen · CrewAI · MetaGPT：给 Agent 分配角色与流程，让它们像团队一样分工协作"],
    ["2025 →", "Harness 运行时", "Claude Code · Codex CLI 把沙箱、权限、上下文管理工程化；MCP 打通工具生态，Agent 走进生产环境"],
  ];
  rows.forEach((r, i) => {
    const y = 1.34 + i * 0.97, last = i === 3;
    timelineNode(sl, 0.80, y + 0.30, 0.26, 3, "");
    T(sl, r[0], { x: 1.10, y: y + 0.10, w: 0.92, h: 0.3, fontSize: 11.5, bold: true, color: C.s3 });
    card(sl, 2.12, y, 7.38, 0.84, last ? { fill: { color: "12291F" }, line: { color: C.s3, width: 1.25 } } : {});
    T(sl, r[1], { x: 2.36, y: y + 0.11, w: 6.9, h: 0.3, fontSize: 12.5, bold: true, color: last ? C.s3 : C.text });
    T(sl, r[2], { x: 2.36, y: y + 0.44, w: 6.9, h: 0.32, fontSize: 9.8, color: C.mute });
  });
  footer(sl, 3, 11);
}

// ============ S12 · HE PRODUCTS ============
{
  const sl = pres.addSlide();
  sl.background = { path: A("bg_content.png") };
  header(sl, 3, "STAGE 03 · HARNESS ENGINEERING", "代表产品：三条进化路线");
  const cols = [
    ["e_rocket", "AutoGPT", "2023", "先驱 · 自主循环",
      "最早出圈的开源自主智能体：给定目标后自动拆解任务、联网检索、自我迭代。它验证了「全自动循环」的可行性，也把长任务失控、成本失控的问题摆上台面——为后来的工程化指明方向。",
      "启示：范式的验证者"],
    ["e_net", "ACPAgent", "协议派", "协议 · 互联协作",
      "基于 ACP 智能体互联协议构建：让不同框架、不同厂商的 Agent 以标准化方式互相发现、通信与协作，把一座座「单体智能」孤岛连成网络，面向多智能体协作时代。",
      "启示：连接大于单体"],
    ["e_paw", "OpenClaw", "2026", "现象级 · 个人运行时",
      "开源个人 AI 助手运行时：本地部署、自托管，接入聊天、邮件等多通道后自主处理日常任务。2026 年初在开源社区现象级爆发，「人人自托管 Agent」成为新浪潮。",
      "启示：运行时即产品"],
  ];
  cols.forEach((c, i) => {
    const x = 0.5 + i * 3.05;
    card(sl, x, 1.30, 2.9, 3.50);
    iconCircle(sl, c[0], x + 0.20, 1.50, 0.52, C.s3);
    T(sl, c[1], { x: x + 0.84, y: 1.54, w: 1.5, h: 0.32, fontSize: 14.5, bold: true, color: C.text });
    T(sl, c[3], { x: x + 0.84, y: 1.87, w: 1.9, h: 0.24, fontSize: 9, bold: true, color: C.s3 });
    chip(sl, x + 2.06, 1.50, 0.66, 0.28, c[2], C.s3, { fs: 8.5 });
    T(sl, c[4], { x: x + 0.22, y: 2.32, w: 2.48, h: 1.72, fontSize: 9.8, color: C.mute });
    sl.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: x + 0.18, y: 4.16, w: 2.54, h: 0.42, rectRadius: 0.06, fill: { color: "10281F" }, line: { color: "2A5A48", width: 1 } });
    T(sl, c[5], { x: x + 0.18, y: 4.16, w: 2.54, h: 0.42, fontSize: 9.5, bold: true, color: C.body, align: "center", valign: "middle" });
  });
  T(sl, "从「单体自律」，到「协议互联」，再到「个人运行时」—— Harness 的三条路线正在合流",
    { x: 0.5, y: 4.94, w: 9, h: 0.26, fontSize: 10.5, italic: true, align: "center", color: C.mute });
  footer(sl, 3, 12);
}

// ============ S13 · SUMMARY ============
{
  const sl = pres.addSlide();
  sl.background = { path: A("bg_cover.png") };
  T(sl, "SUMMARY · 总结与展望", { x: 0.5, y: 0.42, w: 9, h: 0.24, fontSize: 9.5, bold: true, color: C.s1, charSpacing: 2.5 });
  T(sl, "一条主线，三次跃迁", { x: 0.5, y: 0.68, w: 9, h: 0.55, fontSize: 26, bold: true, color: C.text });
  const Y = 2.02, xs = [1.75, 5.0, 8.25];
  sl.addShape(pres.shapes.LINE, { x: 0.9, y: Y, w: 8.2, h: 0, line: { color: "24344F", width: 1.5, endArrowType: "triangle" } });
  const data = [
    ["2020", "Prompt Engineering", "把指令说明白", "释放单次调用的能力"],
    ["2023", "Context Engineering", "把上下文备齐", "接入知识、记忆与行动"],
    ["2025", "Harness Engineering", "把运行时造好", "支撑长程自主任务"],
  ];
  xs.forEach((x, i) => {
    const c = STAGE[i + 1];
    T(sl, data[i][0], { x: x - 0.6, y: 1.58, w: 1.2, h: 0.26, fontSize: 10.5, bold: true, align: "center", color: c });
    timelineNode(sl, x, Y, 0.32, i + 1, String(i + 1));
    card(sl, x - 1.35, 2.42, 2.7, 1.10);
    T(sl, data[i][1], { x: x - 1.2, y: 2.54, w: 2.4, h: 0.26, fontSize: 11.5, bold: true, color: c });
    T(sl, data[i][2], { x: x - 1.2, y: 2.84, w: 2.4, h: 0.28, fontSize: 12.5, bold: true, color: C.text });
    T(sl, data[i][3], { x: x - 1.2, y: 3.16, w: 2.4, h: 0.24, fontSize: 9.5, color: C.mute });
  });
  card(sl, 0.5, 3.86, 9.0, 0.72, { line: { color: C.cardLine, width: 1 } });
  T(sl, [
    { text: "模型能力每几个月就翻一番；", options: { color: C.body } },
    { text: "决定产品上限的，是我们围绕模型构建的工程。", options: { color: C.s3, bold: true } },
  ], { x: 0.7, y: 3.86, w: 8.6, h: 0.72, fontSize: 14, align: "center", valign: "middle" });
  ["Agent OS", "多智能体网络", "人人可自托管"].forEach((t, i) => {
    const x = 2.62 + i * 1.72;
    sl.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y: 4.74, w: 1.52, h: 0.34, rectRadius: 0.06, fill: { color: "1B2440" }, line: { color: "2A5A48", width: 1 } });
    T(sl, t, { x, y: 4.74, w: 1.52, h: 0.34, fontSize: 9.5, color: C.body, align: "center", valign: "middle" });
  });
  T(sl, "Q&A · 谢谢", { x: 7.9, y: 4.78, w: 1.6, h: 0.28, fontSize: 10, bold: true, align: "right", color: C.dim });
  footer(sl, 3, 13);
}

// ---- write + recompress (pptxgenjs writes an uncompressed zip) ----
(async () => {
  const out = path.join(__dirname, "..", "AI-Agent进化之路.pptx");
  await pres.writeFile({ fileName: out });
  const JSZip = require("jszip");
  const buf = fs.readFileSync(out);
  const zip = await JSZip.loadAsync(buf);
  const rebuilt = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 9 } });
  fs.writeFileSync(out, rebuilt);
  console.log("written:", out, (rebuilt.length / 1024).toFixed(0) + " KB");
})();
