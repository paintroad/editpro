#!/usr/bin/env node
/** One overview image of every rendered video: node scripts/video/overview_sheet.js "<folder>" */
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const E = require("./video-engine");

const dir = process.argv[2];
const work = path.join(dir, "_work");
const index = JSON.parse(fs.readFileSync(path.join(dir, "_videos.json"), "utf8")).filter((v) => !v.failed);
const COLS = 6, CW = 300, CH = 400, LABEL = 70, GAP = 16;
const rows = Math.ceil(index.length / COLS);
const W = COLS * CW + (COLS + 1) * GAP, H = rows * (CH + LABEL) + (rows + 1) * GAP;

(async () => {
  const comps = [];
  let svg = "";
  for (const [i, v] of index.entries()) {
    const x = GAP + (i % COLS) * (CW + GAP), y = GAP + Math.floor(i / COLS) * (CH + LABEL + GAP);
    const thumb = path.join(work, `thumb-${String(v.id).padStart(2, "0")}.jpg`);
    if (fs.existsSync(thumb)) comps.push({ input: await sharp(thumb).resize(CW, CH, { fit: "contain", background: "#EFE6D6" }).toBuffer(), left: x, top: y });
    const t = `${v.id}. ${v.title}`;
    svg += E.text(x + 8, y + CH + 30, t.length > 30 ? t.slice(0, 29) + "…" : t, { size: 22, font: "Segoe UI", weight: 700, color: "#1A1A1A", anchor: "start", shadow: false });
    svg += E.text(x + 8, y + CH + 58, `${v.ratio} · ${v.duration}s`, { size: 19, font: "Segoe UI", color: "#777", anchor: "start", shadow: false });
  }
  comps.push({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${svg}</svg>`), left: 0, top: 0 });
  const out = path.join(dir, "Overview.jpg");
  await sharp({ create: { width: W, height: H, channels: 3, background: "#F8F1E6" } }).composite(comps).jpeg({ quality: 88 }).toFile(out);
  console.log(out);
})();
