const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { DatabaseSync } = require("node:sqlite");
const sharp = require("sharp");
const { getThumbnail } = require("./collections-image-thumb");

const SCRIPT_PATH = path.join(__dirname, "..", "scripts", "artwork_ai.py");
const SETTINGS_PATH = path.join(os.homedir(), ".editpro", "artwork-extract.json");
const DB_PATH = path.join(os.homedir(), ".editpro", "pipeline-prep", "catalog.db");
const DIRS = { raw: "Raw", ai: "AI", compare: "AI Compare", oriented: "Oriented", upscaled: "Upscaled" };
const WORK = "_ai_work";
const BACKUP = { originals: `${WORK}/originals`, prevFinal: `${WORK}/prev_final`, rejected: `${WORK}/rejected` };
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".heic", ".tif", ".tiff"]);
const MAX_ROWS = 5000;
const SQUARE_TOLERANCE = 0.05;
const TARGET_RATIO = 4 / 3;
const TARGET_TOLERANCE = 10;
const NAMED_RATIOS = [
  [1, "1:1"],
  [5 / 4, "5:4"],
  [4 / 3, "4:3"],
  [3 / 2, "3:2"],
  [16 / 9, "16:9"],
  [2, "2:1"],
  [3, "3:1"],
];
const SCHEMA = `
CREATE TABLE IF NOT EXISTS images (
  name TEXT PRIMARY KEY,
  brand TEXT,
  categories TEXT,
  source_file TEXT,
  source_path TEXT,
  stage TEXT,
  file TEXT,
  method TEXT,
  source_width INTEGER,
  source_height INTEGER,
  width INTEGER,
  height INTEGER,
  upscaled_file TEXT,
  upscaled_width INTEGER,
  upscaled_height INTEGER,
  extracted_at TEXT,
  oriented_at TEXT,
  cropped_at TEXT,
  upscaled_at TEXT,
  updated_at TEXT
);
`;
const EXTRA_COLUMNS = [
  "crop_technique",
  "crop_applied",
  "review_status",
  "review_note",
  "last_feedback",
  "reviewed_at",
  "ai_at",
  "compare_at",
];

let child = null;
let job = blankJob();
const sizeCache = new Map();

function blankJob() {
  return { state: "idle", mode: "register", input: "", total: 0, processed: 0, counts: {}, rows: [], error: "", startedAt: null, finishedAt: null };
}

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));
  } catch {
    return {};
  }
}

function writeSettings(patch) {
  const next = { ...readSettings(), ...patch };
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(next, null, 2));
  return next;
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function resolveRoot(input) {
  const root = path.resolve(String(input || "").trim());
  if (!String(input || "").trim() || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error("Enter a catalog folder that exists.");
  }
  for (const dir of Object.values(DIRS)) fs.mkdirSync(path.join(root, dir), { recursive: true });
  return root;
}

function currentRoot() {
  const root = readSettings().input;
  if (!root) throw new Error("No catalog folder loaded.");
  return root;
}

function openDb() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA busy_timeout = 10000; PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);
  const columns = new Set(db.prepare("PRAGMA table_info(images)").all().map((column) => column.name));
  for (const column of EXTRA_COLUMNS) {
    if (!columns.has(column)) db.exec(`ALTER TABLE images ADD COLUMN ${column} TEXT`);
  }
  return db;
}

function now() {
  return new Date().toISOString().slice(0, 19);
}

// ------------------------------------------------------------- register job ----

function getStatus() {
  return { ...job, rows: job.rows.slice(-MAX_ROWS), settings: readSettings() };
}

function handleLine(line) {
  let row;
  try {
    row = JSON.parse(line);
  } catch {
    return;
  }
  if (row.type === "start") {
    job.total = row.total || 0;
  } else if (row.type === "file") {
    job.processed += 1;
    job.counts[row.status] = (job.counts[row.status] || 0) + 1;
    job.rows.push({ path: row.path, status: row.status, name: row.name || "", reason: row.reason || "" });
    if (job.rows.length > MAX_ROWS) job.rows.shift();
  } else if (row.type === "done") {
    job.counts = row.counts || job.counts;
  }
}

/** Name new Raw images (<brand>_<n>) so they're ready for AI. */
function start({ input }) {
  if (child) throw new Error("A job is already running.");
  const root = resolveRoot(input);
  writeSettings({ input: root });
  job = { ...blankJob(), state: "running", input: root, startedAt: new Date().toISOString() };
  child = spawn("py", ["-3", SCRIPT_PATH, "register", "--root", root], { windowsHide: true });
  let buffer = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop();
    for (const line of lines) if (line.trim()) handleLine(line);
  });
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-4000);
  });
  child.on("error", (error) => {
    job.state = "error";
    job.error = error.message || String(error);
    job.finishedAt = new Date().toISOString();
    child = null;
  });
  child.on("close", (code) => {
    if (buffer.trim()) handleLine(buffer);
    job.state = code === 0 ? "done" : "error";
    if (code !== 0) job.error = stderr.trim().split(/\r?\n/).pop() || `Register exited with code ${code}.`;
    job.finishedAt = new Date().toISOString();
    child = null;
  });
  return getStatus();
}

// ------------------------------------------------------------------- files ----

function flatImages(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function walkImages(root) {
  const files = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) files.push(full);
    }
  }
  return files;
}

function byStem(root, dir) {
  const map = new Map();
  for (const file of flatImages(path.join(root, dir))) map.set(path.parse(file).name, `${dir}/${file}`);
  return map;
}

async function imageSize(filePath) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return null;
  }
  const cached = sizeCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.size;
  let size = null;
  try {
    const meta = await sharp(fs.readFileSync(filePath)).metadata();
    size = meta.orientation >= 5 ? [meta.height, meta.width] : [meta.width, meta.height];
  } catch {
    size = null;
  }
  sizeCache.set(filePath, { mtimeMs: stat.mtimeMs, size });
  return size;
}

function mtime(file) {
  try {
    return Math.round(fs.statSync(file).mtimeMs);
  } catch {
    return 0;
  }
}

/** Move a file into a backup folder without overwriting an earlier backup. */
function moveAside(root, rel, backupDir, stem) {
  const from = path.join(root, rel);
  if (!fs.existsSync(from)) return null;
  const dir = path.join(root, backupDir);
  fs.mkdirSync(dir, { recursive: true });
  const ext = path.extname(from);
  let target = path.join(dir, `${stem}${ext}`);
  for (let i = 2; fs.existsSync(target); i += 1) target = path.join(dir, `${stem}_${i}${ext}`);
  fs.renameSync(from, target);
  return target;
}

/** Upscaled files may carry a suffix (atrang_100_203208.png); match them to a known name. */
function upscaledName(stem, names) {
  let candidate = stem;
  while (candidate) {
    if (names.has(candidate)) return candidate;
    const next = candidate.replace(/_\d+$/, "");
    if (next === candidate) return null;
    candidate = next;
  }
  return null;
}

function describeShape(width, height) {
  if (!width || !height) return {};
  const ratio = width / height;
  const long = Math.max(width, height) / Math.min(width, height);
  const orientation = Math.abs(ratio - 1) <= SQUARE_TOLERANCE ? "square" : ratio > 1 ? "landscape" : "portrait";
  const deviation = Math.round((long / TARGET_RATIO - 1) * 1000) / 10;
  const is43 = orientation !== "square" && Math.abs(deviation) <= TARGET_TOLERANCE;
  let named = NAMED_RATIOS[0];
  for (const candidate of NAMED_RATIOS) {
    if (Math.abs(Math.log(long / candidate[0])) < Math.abs(Math.log(long / named[0]))) named = candidate;
  }
  let label = is43 ? "4:3" : named[1];
  if (orientation === "square") label = "1:1";
  else if (orientation === "portrait") label = label.replace(/^(\d+):(\d+)/, "$2:$1");
  const rightRatio = is43 || orientation === "square";
  return { orientation, ratio: Math.round(ratio * 100) / 100, ratioLabel: label, rightRatio, deviation: rightRatio ? null : deviation };
}

function parseCategories(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function sortRows(rows) {
  const parts = (name) => {
    const match = (name || "").match(/^(.*)_(\d+)$/);
    return match ? [match[1], Number(match[2])] : ["\uffff", Infinity];
  };
  rows.sort((a, b) => {
    const [pa, na] = parts(a.name);
    const [pb, nb] = parts(b.name);
    return pa.localeCompare(pb) || na - nb || a.key.localeCompare(b.key);
  });
}

// ------------------------------------------------------------------ review ----

function approveOne(root, db, row, files) {
  const aiRel = files.ai.get(row.name);
  if (!aiRel) throw new Error(`${row.name}: no AI image to approve.`);
  const oldFinal = files.oriented.get(row.name);
  if (oldFinal) moveAside(root, oldFinal, BACKUP.prevFinal, row.name);
  const finalRel = `${DIRS.oriented}/${path.basename(aiRel)}`;
  fs.renameSync(path.join(root, aiRel), path.join(root, finalRel));
  if (row.source_path) moveAside(root, `${DIRS.raw}/${row.source_path}`, BACKUP.originals, row.name);
  const compareRel = files.compare.get(row.name);
  if (compareRel) fs.rmSync(path.join(root, compareRel), { force: true });
  const stamp = now();
  db.prepare(
    `UPDATE images SET stage = 'oriented', file = ?, crop_technique = 'ai', crop_applied = 'ai', review_status = 'approved',
       review_note = NULL, reviewed_at = ?, oriented_at = ?, updated_at = ? WHERE name = ?`
  ).run(finalRel, stamp, stamp, stamp, row.name);
}

function rejectOne(root, db, row, files, note) {
  const aiRel = files.ai.get(row.name);
  if (aiRel) moveAside(root, aiRel, BACKUP.rejected, row.name);
  if (row.source_path) moveAside(root, `${DIRS.raw}/${row.source_path}`, `${BACKUP.rejected}/originals`, row.name);
  const compareRel = files.compare.get(row.name);
  if (compareRel) fs.rmSync(path.join(root, compareRel), { force: true });
  const stamp = now();
  const finalRel = files.oriented.get(row.name);
  if (finalRel) {
    db.prepare(
      `UPDATE images SET stage = 'oriented', file = ?, review_status = 'rejected', review_note = ?, reviewed_at = ?,
         updated_at = ? WHERE name = ?`
    ).run(finalRel, note || null, stamp, stamp, row.name);
    return;
  }
  db.prepare(
    `UPDATE images SET stage = 'rejected', file = NULL, review_status = 'rejected', review_note = ?, reviewed_at = ?,
       updated_at = ? WHERE name = ?`
  ).run(note || null, stamp, stamp, row.name);
}

function stageFiles(root) {
  return {
    ai: byStem(root, DIRS.ai),
    compare: byStem(root, DIRS.compare),
    oriented: byStem(root, DIRS.oriented),
  };
}

/** Approve, reject or leave feedback for images in review. */
function review({ names, action, note }) {
  const list = (Array.isArray(names) ? names : [names]).map(String).filter(Boolean);
  if (!list.length) throw new Error("No images chosen.");
  if (!["approve", "reject", "feedback"].includes(action)) throw new Error("Unknown review action.");
  const text = String(note || "").trim();
  if (action === "feedback" && !text) throw new Error("Write the feedback first.");
  const root = currentRoot();
  const db = openDb();
  try {
    const files = stageFiles(root);
    const done = [];
    for (const name of list) {
      const row = db.prepare("SELECT * FROM images WHERE name = ?").get(name);
      if (!row) throw new Error(`${name} is not in the catalog.`);
      if (action === "approve") approveOne(root, db, row, files);
      else if (action === "reject") rejectOne(root, db, row, files, text);
      else {
        db.prepare("UPDATE images SET review_status = 'feedback', review_note = ?, reviewed_at = ?, updated_at = ? WHERE name = ?").run(
          text,
          now(),
          now(),
          name
        );
      }
      done.push(name);
    }
    return { done };
  } finally {
    db.close();
  }
}

// -------------------------------------------------------------------- list ----

/** The folder an image sits in is its stage. A comparison deleted from AI Compare counts as a reject. */
async function sync(root, db) {
  const files = stageFiles(root);
  const upscaledFiles = byStem(root, DIRS.upscaled);
  const rows = db.prepare("SELECT * FROM images").all();
  const names = new Set(rows.map((row) => row.name));
  const upscaled = new Map();
  for (const [stem, rel] of upscaledFiles) {
    const name = upscaledName(stem, names);
    if (name) upscaled.set(name, rel);
  }
  const update = db.prepare(
    `UPDATE images SET stage = ?, file = ?, width = ?, height = ?, upscaled_file = ?, upscaled_width = ?, upscaled_height = ?,
       upscaled_at = ?, updated_at = ? WHERE name = ?`
  );
  const stamp = now();
  for (const row of rows) {
    if (row.stage === "shipped") continue;
    if (files.ai.has(row.name) && row.compare_at && !files.compare.has(row.name) && row.review_status !== "approved") {
      rejectOne(root, db, row, files, "comparison deleted from AI Compare");
      continue;
    }
    let stage = row.stage;
    let file = row.file;
    const inReview = files.ai.has(row.name) && ["pending", "feedback"].includes(row.review_status);
    if (files.oriented.has(row.name) && !inReview) {
      stage = "oriented";
      file = files.oriented.get(row.name);
    } else if (files.ai.has(row.name)) {
      stage = "ai";
      file = files.ai.get(row.name);
    } else if (row.source_path && fs.existsSync(path.join(root, DIRS.raw, row.source_path))) {
      stage = "raw";
      file = `${DIRS.raw}/${row.source_path}`;
    } else if (row.stage !== "rejected") {
      stage = "missing";
    }
    const upFile = upscaled.get(row.name) || null;
    let { width, height, upscaled_width: upWidth, upscaled_height: upHeight } = row;
    if (file && stage !== "missing" && stage !== "rejected" && (file !== row.file || !width)) {
      const size = await imageSize(path.join(root, file));
      width = size?.[0] ?? null;
      height = size?.[1] ?? null;
    }
    if (upFile && (upFile !== row.upscaled_file || !upWidth)) {
      const size = await imageSize(path.join(root, upFile));
      upWidth = size?.[0] ?? null;
      upHeight = size?.[1] ?? null;
    }
    if (!upFile) upWidth = upHeight = null;
    const next = { stage, file, width, height, upscaled_file: upFile, upscaled_width: upWidth, upscaled_height: upHeight };
    if (Object.keys(next).some((key) => (row[key] ?? null) !== (next[key] ?? null))) {
      update.run(stage, file, width, height, upFile, upWidth, upHeight, upFile ? row.upscaled_at || stamp : null, stamp, row.name);
    }
  }
  return { unlinkedUpscaled: upscaledFiles.size - upscaled.size };
}

async function list({ input } = {}) {
  const root = resolveRoot(input || readSettings().input);
  writeSettings({ input: root });
  const db = openDb();
  try {
    const { unlinkedUpscaled } = child ? { unlinkedUpscaled: 0 } : await sync(root, db);
    const compare = byStem(root, DIRS.compare);
    const finals = byStem(root, DIRS.oriented);
    const originals = new Map(flatImages(path.join(root, BACKUP.originals)).map((f) => [path.parse(f).name, `${BACKUP.originals}/${f}`]));
    const rows = [];
    const known = new Set();
    for (const row of db.prepare("SELECT * FROM images").all()) {
      if (row.source_path) known.add(row.source_path);
      if (row.stage === "shipped") continue; // finished in an earlier cycle; the row stays so names keep counting up
      let stage = row.stage;
      if (stage === "ai") stage = row.review_status === "feedback" ? "feedback" : "review";
      if (stage === "oriented" && row.upscaled_file) stage = "upscaled";
      const original =
        row.stage === "ai" && finals.has(row.name)
          ? finals.get(row.name)
          : row.source_path && fs.existsSync(path.join(root, DIRS.raw, row.source_path))
            ? `${DIRS.raw}/${row.source_path}`
            : originals.get(row.name) || "";
      const key = row.stage === "raw" ? "" : row.file || "";
      rows.push({
        key,
        name: row.name,
        brand: row.brand || "",
        categories: parseCategories(row.categories),
        sourceFile: row.source_file || "",
        stage,
        note: row.review_note || "",
        lastFeedback: row.last_feedback || "",
        original,
        originalVersion: original ? mtime(path.join(root, original)) : 0,
        compare: compare.get(row.name) || "",
        width: row.width,
        height: row.height,
        sourceWidth: row.source_width,
        sourceHeight: row.source_height,
        upscaledWidth: row.upscaled_width,
        upscaledHeight: row.upscaled_height,
        thumbVersion: key ? mtime(path.join(root, key)) : 0,
        ...describeShape(row.width, row.height),
      });
    }
    const rawRoot = path.join(root, DIRS.raw);
    for (const file of walkImages(rawRoot)) {
      const rel = path.relative(rawRoot, file).replace(/\\/g, "/");
      if (known.has(rel)) continue;
      const parts = rel.split("/");
      const size = await imageSize(file);
      rows.push({
        key: "",
        name: "",
        brand: parts.length > 1 ? parts[0] : "",
        categories: parts.slice(1, -1),
        sourceFile: parts[parts.length - 1],
        stage: "new",
        note: "",
        lastFeedback: "",
        original: `${DIRS.raw}/${rel}`,
        originalVersion: mtime(file),
        compare: "",
        width: size?.[0] ?? null,
        height: size?.[1] ?? null,
        thumbVersion: 0,
        ...describeShape(size?.[0], size?.[1]),
      });
    }
    sortRows(rows);
    return { input: root, rows, unlinkedUpscaled };
  } finally {
    db.close();
  }
}

function resolveKey(key) {
  const root = currentRoot();
  const file = path.resolve(root, String(key || ""));
  const allowed = [...Object.values(DIRS), BACKUP.originals].map((dir) => path.join(root, dir));
  if (!allowed.some((dir) => isInside(dir, file))) throw new Error("Invalid path.");
  if (!IMAGE_EXTENSIONS.has(path.extname(file).toLowerCase()) || !fs.existsSync(file)) throw new Error("Image not found.");
  return file;
}

async function thumbnail({ key, width }) {
  return getThumbnail(resolveKey(key), { width, namespace: "artwork" });
}

function filePath({ key }) {
  return resolveKey(key);
}

module.exports = { getStatus, list, review, start, thumbnail, filePath };
