// Generate dark-tech background PNGs + icon PNGs for the deck
const React = require("react");
const ReactDOMServer = require("react-dom/server");
const sharp = require("sharp");
const fs = require("fs");
const path = require("path");
const FA = require("react-icons/fa");

const W = 2000, H = 1125;
const OUT = path.join(__dirname, "assets");
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(path.join(OUT, "icons"), { recursive: true });

// seeded PRNG for deterministic "stars"
let seed = 42;
const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };

const grid = (op) => {
  let s = "";
  for (let y = 40; y < H; y += 52)
    for (let x = 40; x < W; x += 52)
      s += `<circle cx="${x}" cy="${y}" r="1.8" fill="#94A3B8" opacity="${op}"/>`;
  return s;
};

const stars = (n) => {
  let s = "";
  const cols = ["#22D3EE", "#A78BFA", "#34D399", "#E2E8F0"];
  for (let i = 0; i < n; i++) {
    const x = rand() * W, y = rand() * H, r = 1 + rand() * 1.6;
    s += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}" fill="${cols[i % 4]}" opacity="${(0.08 + rand() * 0.18).toFixed(2)}"/>`;
  }
  return s;
};

const baseDef = `<linearGradient id="base" x1="0" y1="0" x2="1" y2="1">
  <stop offset="0" stop-color="#0A101F"/><stop offset="0.55" stop-color="#0C1526"/><stop offset="1" stop-color="#101C36"/></linearGradient>`;
const glow = (id, c) => `<radialGradient id="${id}"><stop offset="0" stop-color="${c}" stop-opacity="1"/><stop offset="1" stop-color="${c}" stop-opacity="0"/></radialGradient>`;

const cover = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg"><defs>${baseDef}
${glow("g1", "#22D3EE")}${glow("g2", "#A78BFA")}${glow("g3", "#34D399")}</defs>
<rect width="${W}" height="${H}" fill="url(#base)"/>
<ellipse cx="240" cy="1000" rx="780" ry="540" fill="url(#g1)" opacity="0.14"/>
<ellipse cx="1000" cy="640" rx="720" ry="500" fill="url(#g2)" opacity="0.09"/>
<ellipse cx="1800" cy="220" rx="640" ry="460" fill="url(#g3)" opacity="0.12"/>
${grid(0.045)}${stars(46)}
<circle cx="1560" cy="360" r="330" fill="none" stroke="#22D3EE" stroke-opacity="0.10" stroke-width="2"/>
<circle cx="1560" cy="360" r="430" fill="none" stroke="#A78BFA" stroke-opacity="0.07" stroke-width="1.5"/></svg>`;

const section = (c) => `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg"><defs>${baseDef}${glow("g", "${c}" == "" ? "" : c)}</defs>
<rect width="${W}" height="${H}" fill="url(#base)"/>
<ellipse cx="1560" cy="480" rx="700" ry="560" fill="url(#g)" opacity="0.17"/>
<ellipse cx="120" cy="1060" rx="500" ry="360" fill="url(#g)" opacity="0.07"/>
${grid(0.04)}${stars(30)}
<circle cx="1560" cy="480" r="380" fill="none" stroke="${c}" stroke-opacity="0.12" stroke-width="2"/>
<circle cx="1560" cy="480" r="500" fill="none" stroke="${c}" stroke-opacity="0.06" stroke-width="1.5"/></svg>`;

const content = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg"><defs>
<linearGradient id="cb" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0C1322"/><stop offset="1" stop-color="#0A0F1C"/></linearGradient>
${glow("g", "#3B82F6")}</defs>
<rect width="${W}" height="${H}" fill="url(#cb)"/>
<ellipse cx="1880" cy="80" rx="500" ry="340" fill="url(#g)" opacity="0.05"/>
${grid(0.032)}${stars(18)}</svg>`;

// icons: name -> [component, color]
const C1 = "#22D3EE", C2 = "#A78BFA", C3 = "#34D399";
const icons = {
  c_commentDots: [FA.FaCommentDots, C1], c_clone: [FA.FaClone, C1], c_chain: [FA.FaProjectDiagram, C1],
  c_role: [FA.FaUserTie, C1], c_code: [FA.FaCode, C1], c_random: [FA.FaRandom, C1],
  c_unlink: [FA.FaUnlink, C1], c_snow: [FA.FaSnowflake, C1], c_compress: [FA.FaCompressArrowsAlt, C1],
  c_talk: [FA.FaRegCommentDots, C1],
  v_quote: [FA.FaQuoteLeft, C2], v_db: [FA.FaDatabase, C2], v_brain: [FA.FaBrain, C2],
  v_tools: [FA.FaTools, C2], v_layers: [FA.FaLayerGroup, C2], v_bulb: [FA.FaRegLightbulb, C2],
  e_loop: [FA.FaSyncAlt, C3], e_robot: [FA.FaRobot, C3], e_users: [FA.FaUsers, C3],
  e_term: [FA.FaTerminal, C3], e_rocket: [FA.FaRocket, C3], e_net: [FA.FaNetworkWired, C3],
  e_paw: [FA.FaPaw, C3], e_cogs: [FA.FaCogs, C3],
};

(async () => {
  await sharp(Buffer.from(cover)).png().toFile(path.join(OUT, "bg_cover.png"));
  for (const [name, hex] of [["s1", C1], ["s2", C2], ["s3", C3]])
    await sharp(Buffer.from(section(hex))).png().toFile(path.join(OUT, `bg_sec_${name}.png`));
  await sharp(Buffer.from(content)).png().toFile(path.join(OUT, "bg_content.png"));

  for (const [name, [Comp, color]] of Object.entries(icons)) {
    const svg = ReactDOMServer.renderToStaticMarkup(React.createElement(Comp, { color, size: "256" }));
    await sharp(Buffer.from(svg)).png().toFile(path.join(OUT, "icons", `${name}.png`));
  }
  console.log("assets done:", fs.readdirSync(OUT).length, "files");
})();
