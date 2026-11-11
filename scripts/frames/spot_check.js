#!/usr/bin/env node
/**
 * Spot check before full catalog generation: a few random paintings per set, each in a different room
 * of the set it is assigned to, laid out as one sheet per set.
 *
 *   node scripts/frames/spot_check.js                 3 per set
 *   node scripts/frames/spot_check.js --per=4 --seed=7 --sets="Wide Statement 8 - Coastal Sage"
 *
 * Renders: ~/.editpro/lifestyle-sets/spot-check/<set>/<stem> - <room>.jpg
 * Sheets:  Downloads\_Catalog\Spot Check\<set>.jpg
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const sharp = require("sharp");
const { parseFrameTemplateFilename } = require("../../lib/frame-template-parser");
const { runWorkers } = require("./assign_previews");

const LS = path.join(os.homedir(), ".editpro", "lifestyle-sets");
const PREP = path.join(os.homedir(), ".editpro", "pipeline-prep");
const SETS_ROOT = "C:\\Users\\divya\\Downloads\\_Frames\\_New Lifestyle Sets";
const RENDERS = path.join(LS, "spot-check");
const SHEETS = "C:\\Users\\divya\\Downloads\\_Catalog\\Spot Check";
const QUADS = path.join(__dirname, "..", "frame-quads.json");
const SHAPE = /^(portrait|landscape|square|wide|tall)\b/i;
const readJson = (f, d) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : d);

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

function shuffle(list, rand) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function rooms(setName, meta, deity) {
  const bathroomSet = /^\S+\s+bathroom\s/i.test(setName);
  return fs.readdirSync(path.join(SETS_ROOT, setName))
    .map((file) => ({ file, parsed: parseFrameTemplateFilename(file) }))
    .filter(({ file, parsed }) => parsed && !parsed.isBase && (bathroomSet || !/bathroom/i.test(file)) &&
      !(deity ? meta[file]?.meta?.nonGod : meta[file]?.meta?.godOnly))
    .map(({ file }) => file);
}

function buildJobs(per, seed, onlySets) {
  const proposals = readJson(path.join(LS, "set-assignments.json"), {}).paintings || {};
  const decisions = readJson(path.join(LS, "set-assign-review.json"), {});
  const final = readJson(path.join(PREP, "final-render.json"), {});
  const items = [...readJson(path.join(PREP, "crop-review-items.json"), []), ...readJson(path.join(PREP, "new-batch-items.json"), []),
    ...readJson(path.join(PREP, "pending-items.json"), [])];
  const itemByKey = new Map(items.map((i) => [i.key, i]));
  const quads = readJson(QUADS, { quads: {} }).quads;

  const bySet = new Map();
  for (const [stem, row] of Object.entries(proposals)) {
    const setName = decisions[stem]?.set || row.set;
    if (onlySets && !onlySets.has(setName)) continue;
    const item = itemByKey.get(row.key);
    const painting = final[row.key]?.optimised || item?.path ||
      (item && path.join("C:\\Users\\divya\\Downloads\\_Existing Catalog Correction", item.folder, item.file));
    if (!painting || !fs.existsSync(painting)) continue;
    if (!bySet.has(setName)) bySet.set(setName, []);
    bySet.get(setName).push({ stem, painting, title: row.title, deity: /deity/.test(row.reason || "") });
  }

  const jobs = [];
  const rand = rng(seed);
  for (const [setName, list] of [...bySet].sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))) {
    if (!fs.existsSync(path.join(SETS_ROOT, setName))) continue;
    const meta = quads[setName] || {};
    const used = new Set();
    for (const p of shuffle(list, rand).slice(0, per)) {
      const options = shuffle(rooms(setName, meta, p.deity), rand);
      const room = options.find((r) => !used.has(r)) || options[0];
      if (!room) continue;
      used.add(room);
      jobs.push({
        setName, stem: p.stem, title: p.title, room,
        painting: p.painting, frame: path.join(SETS_ROOT, setName, room), frameTemplate: room, frameSet: setName,
        orientation: setName.match(SHAPE)[1].toLowerCase(),
        out: path.join(RENDERS, setName, `${p.stem} - ${room.replace(/\.[^.]+$/, "")}.jpg`),
      });
    }
  }
  return jobs;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

async function sheet(setName, jobs) {
  const done = jobs.filter((j) => fs.existsSync(j.out));
  if (!done.length) return false;
  const H = 420, GAP = 16, LABEL = 46, TOP = 56;
  const tiles = await Promise.all(done.map(async (j) => {
    const buf = await sharp(j.out).resize({ height: H }).toBuffer({ resolveWithObject: true });
    return { j, buf: buf.data, w: buf.info.width };
  }));
  const width = GAP + tiles.reduce((a, t) => a + t.w + GAP, 0);
  const height = TOP + H + LABEL + GAP;
  const composites = [];
  const text = [`<text x="${GAP}" y="36" font-family="Segoe UI, Arial" font-size="24" font-weight="600">${esc(setName)}</text>`];
  let x = GAP;
  for (const t of tiles) {
    composites.push({ input: t.buf, left: x, top: TOP });
    text.push(`<text x="${x}" y="${TOP + H + 20}" font-family="Segoe UI, Arial" font-size="15">${esc(`${t.j.stem} · ${t.j.room.replace(/\.[^.]+$/, "")}`)}</text>`);
    text.push(`<text x="${x}" y="${TOP + H + 40}" font-family="Segoe UI, Arial" font-size="13" fill="#666">${esc((t.j.title || "").slice(0, Math.floor(t.w / 7)))}</text>`);
    x += t.w + GAP;
  }
  composites.push({ input: Buffer.from(`<svg width="${width}" height="${height}">${text.join("")}</svg>`), left: 0, top: 0 });
  fs.mkdirSync(SHEETS, { recursive: true });
  await sharp({ create: { width, height, channels: 3, background: "#ffffff" } })
    .composite(composites).jpeg({ quality: 88 }).toFile(path.join(SHEETS, `${setName}.jpg`));
  return true;
}

if (require.main === module) {
  const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
  const per = Number(arg("per")) || 3;
  const seed = Number(arg("seed")) || 1;
  const onlySets = arg("sets") ? new Set(arg("sets").split("|").map((s) => s.trim()).filter(Boolean)) : null;
  const workers = Number(arg("workers")) || Math.max(1, Math.min(6, os.cpus().length - 2));
  const jobs = buildJobs(per, seed, onlySets);
  console.log(`${jobs.length} spot-check renders across ${new Set(jobs.map((j) => j.setName)).size} sets, ${workers} workers`);
  runWorkers(jobs, workers).then(async ({ ok, failed }) => {
    console.log(`rendered ${ok}, failed ${failed}`);
    const bySet = new Map();
    for (const j of jobs) (bySet.get(j.setName) || bySet.set(j.setName, []).get(j.setName)).push(j);
    let sheets = 0;
    for (const [setName, list] of bySet) if (await sheet(setName, list)) sheets++;
    console.log(`${sheets} sheets -> ${SHEETS}`);
  });
}
