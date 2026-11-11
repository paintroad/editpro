#!/usr/bin/env node
/**
 * Previews for the set assignment review: each painting in one room of the set it is assigned to
 * (your choice in set-assign-review.json, else the proposal). Output:
 *   ~/.editpro/lifestyle-sets/assign-previews/<set>/<painting>.jpg
 *
 *   node scripts/frames/assign_previews.js                 every painting, skipping up-to-date previews
 *   node scripts/frames/assign_previews.js --stems=11121,10052
 *   node scripts/frames/assign_previews.js --workers=6
 *
 * The room is the set's first slide that suits every painting: not the index image, not a bathroom
 * (except in Bathroom sets), and not a god-only / non-god room.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { parseFrameTemplateFilename } = require("../../lib/frame-template-parser");

const LS = path.join(os.homedir(), ".editpro", "lifestyle-sets");
const PREP = path.join(os.homedir(), ".editpro", "pipeline-prep");
const SETS_ROOT = "C:\\Users\\divya\\Downloads\\_Frames\\_New Lifestyle Sets";
const PREVIEWS = path.join(LS, "assign-previews");
const QUADS = path.join(__dirname, "..", "frame-quads.json");
const readJson = (f, d) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : d);
const SHAPE = /^(portrait|landscape|square|wide|tall)\b/i;

function previewRoom(setName, quads) {
  const dir = path.join(SETS_ROOT, setName);
  if (!fs.existsSync(dir)) return null;
  const meta = quads[setName] || {};
  const bathroomSet = /^\S+\s+bathroom\s/i.test(setName);
  const rooms = fs.readdirSync(dir)
    .map((file) => ({ file, parsed: parseFrameTemplateFilename(file) }))
    .filter(({ file, parsed }) => parsed && !parsed.isBase && (bathroomSet || !/bathroom/i.test(file)) &&
      !meta[file]?.meta?.godOnly && !meta[file]?.meta?.nonGod)
    .sort((a, b) => a.parsed.index - b.parsed.index);
  return rooms[0]?.file || null;
}

function previewPath(setName, stem) {
  return path.join(PREVIEWS, setName, `${stem}.jpg`);
}

function buildJobs(onlyStems) {
  const proposals = readJson(path.join(LS, "set-assignments.json"), {}).paintings || {};
  const decisions = readJson(path.join(LS, "set-assign-review.json"), {});
  const final = readJson(path.join(PREP, "final-render.json"), {});
  const items = [...readJson(path.join(PREP, "crop-review-items.json"), []), ...readJson(path.join(PREP, "new-batch-items.json"), []),
    ...readJson(path.join(PREP, "pending-items.json"), [])];
  const itemByKey = new Map(items.map((i) => [i.key, i]));
  const quadsFile = readJson(QUADS, { quads: {} });
  const quadsTime = fs.statSync(QUADS).mtimeMs;
  const roomOf = new Map();
  const jobs = [];
  for (const [stem, row] of Object.entries(proposals)) {
    if (onlyStems && !onlyStems.has(stem)) continue;
    const setName = decisions[stem]?.set || row.set;
    if (!roomOf.has(setName)) roomOf.set(setName, previewRoom(setName, quadsFile.quads));
    const room = roomOf.get(setName);
    if (!room) continue;
    const item = itemByKey.get(row.key);
    const painting = final[row.key]?.optimised || item?.path ||
      (item && path.join("C:\\Users\\divya\\Downloads\\_Existing Catalog Correction", item.folder, item.file));
    if (!painting || !fs.existsSync(painting)) continue;
    const frame = path.join(SETS_ROOT, setName, room);
    const out = previewPath(setName, stem);
    if (!onlyStems && fs.existsSync(out)) {
      const t = fs.statSync(out).mtimeMs;
      if (t > fs.statSync(painting).mtimeMs && t > fs.statSync(frame).mtimeMs && t > quadsTime) continue;
    }
    jobs.push({ stem, painting, frame, frameTemplate: room, frameSet: setName, orientation: setName.match(SHAPE)[1].toLowerCase(), out });
  }
  return jobs;
}

function runWorkers(jobs, workers) {
  if (!jobs.length) return Promise.resolve({ ok: 0, failed: 0 });
  const env = readJson(path.join(os.homedir(), ".editpro", "python-env.json"), {});
  const cmd = env.pythonPath || "py";
  const prefix = env.argsPrefix || (cmd === "py" ? ["-3"] : []);
  const jobsFile = path.join(os.tmpdir(), `assign-preview-jobs-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(jobsFile, JSON.stringify(jobs));
  const n = Math.max(1, Math.min(workers, jobs.length));
  let ok = 0, failed = 0;
  const started = Date.now();
  const runs = Array.from({ length: n }, (_, w) => new Promise((resolve) => {
    const child = spawn(cmd, [...prefix, path.join(__dirname, "assign_previews.py"), jobsFile, String(w), String(n)], { windowsHide: true });
    let buf = "";
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const r = JSON.parse(line);
          if (r.ok) ok++;
          else { failed++; console.error(`failed ${r.out}: ${r.error}`); }
        } catch { /* compositor log line */ }
        const done = ok + failed;
        if (done % 100 === 0) {
          const rate = done / ((Date.now() - started) / 1000);
          console.log(`${done}/${jobs.length} (${Math.round((jobs.length - done) / rate / 60)} min left)`);
        }
      }
    });
    child.stderr.on("data", () => {});
    child.on("close", resolve);
  }));
  return Promise.all(runs).then(() => {
    fs.rmSync(jobsFile, { force: true });
    return { ok, failed };
  });
}

if (require.main === module) {
  const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
  const stems = arg("stems") ? new Set(arg("stems").split(",").filter(Boolean)) : null;
  const workers = Number(arg("workers")) || Math.max(1, Math.min(6, os.cpus().length - 2));
  const jobs = buildJobs(stems);
  console.log(`${jobs.length} previews to render with ${workers} workers`);
  runWorkers(jobs, workers).then(({ ok, failed }) => console.log(`done: ${ok} rendered, ${failed} failed`));
}

module.exports = { PREVIEWS, previewPath, previewRoom, buildJobs, runWorkers };
