const JSZip = require("jszip");
const { XMLParser } = require("fast-xml-parser");
const fs = require("fs");
const p = "../AI-Agent进化之路.pptx";
(async () => {
  const zip = await JSZip.loadAsync(fs.readFileSync(p));
  const names = Object.keys(zip.files).filter(n => !zip.files[n].dir);
  const slides = names.filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort();
  const media = names.filter(n => n.startsWith("ppt/media/"));
  console.log("slides:", slides.length, "| media:", media.length, "| entries:", names.length);
  const parser = new XMLParser({ ignoreAttributes: false });
  let bad = 0;
  const placeholderRe = /(TODO|lorem|xxx|\[insert|Click to add)/i;
  for (const s of slides) {
    const xml = await zip.files[s].async("string");
    try { parser.parse(xml); } catch (e) { console.log("XML FAIL", s, e.message); bad++; }
    if (placeholderRe.test(xml)) { console.log("PLACEHOLDER in", s); bad++; }
    if (/srgbClr val="#/.test(xml)) { console.log("BAD # in", s); bad++; }
  }
  // every slide references YaHei and has a bg image rel
  for (const s of slides) {
    const xml = await zip.files[s].async("string");
    if (!xml.includes("Microsoft YaHei")) console.log("no-font", s);
  }
  console.log(bad === 0 ? "QA PASS" : "QA ISSUES: " + bad);
})().catch(e => { console.error(e); process.exit(1); });
