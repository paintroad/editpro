#!/usr/bin/env node
/** Frame strips for checking rendered videos: node scripts/video/contact_sheet.js "<folder>" [--frames=6] [--match=01,04] */
const fs = require("fs");
const path = require("path");
const E = require("./video-engine");

const dir = process.argv[2];
const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
const frames = Number(arg("frames") || 6);
const match = arg("match") ? arg("match").split(",") : null;
const outDir = path.join(dir, "_work", "sheets");
fs.mkdirSync(outDir, { recursive: true });
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".mp4"))) {
  if (match && !match.some((m) => f.startsWith(m))) continue;
  const dur = E.probeDuration(path.join(dir, f));
  const step = dur / frames;
  const sel = Array.from({ length: frames }, (_, i) => `lt(prev_pts*TB\\,${(i * step + step / 2).toFixed(2)})*gte(pts*TB\\,${(i * step + step / 2).toFixed(2)})`).join("+");
  const out = path.join(outDir, f.replace(/\.mp4$/, ".jpg"));
  E.ffmpeg(["-i", path.join(dir, f), "-vf", `select='${sel}',scale=-2:360,tile=${frames}x1`, "-frames:v", "1", "-vsync", "vfr", out], f);
  console.log(out);
}
