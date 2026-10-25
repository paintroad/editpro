const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { DatabaseSync } = require("node:sqlite");
const sharp = require("sharp");
const { getThumbnail } = require("./collections-image-thumb");

const SCRIPT_PATH = path.join(__dirname, "..", "scripts", "artwork-extract.py");
const SETTINGS_PATH = path.join(os.homedir(), ".editpro", "artwork-extract.json");
const DB_NAME = "catalog.db";
const STAGE_DIRS = { raw: "Raw", extracted: "Extracted", oriented: "Oriented", cropped: "Cropped", upscaled: "Upscaled" };
/** Later stages win when the same name sits in more than one folder. */
const WORK_STAGES = ["extracted", "oriented", "cropped"];
const BRANDS = new Set(["auto", "atrang", "nakhrro", "generic"]);
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
CREATE TABLE IF NOT EXISTS raw_skips (
  path TEXT PRIMARY KEY,
  reason TEXT,
  updated_at TEXT
);
`;

let child = null;
let job = blankJob();
const sizeCache = new Map();

function blankJob() {
  return {
    state: "idle",
    input: "",
    brand: "auto",
    total: 0,
    processed: 0,
    counts: {},
    rows: [],
    error: "",
    startedAt: null,
    finishedAt: null,
  };
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
  for (const dir of Object.values(STAGE_DIRS)) fs.mkdirSync(path.join(root, dir), { recursive: true });
  return root;
}

function openDb(root) {
  const db = new DatabaseSync(path.join(root, DB_NAME));
  db.exec("PRAGMA busy_timeout = 10000; PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);
  return db;
}

function now() {
  return new Date().toISOString().slice(0, 19);
}

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

function start({ input, brand, overwrite }) {
  if (child) throw new Error("Extraction is already running.");
  const root = resolveRoot(input);
  const brandKey = BRANDS.has(String(brand || "").toLowerCase()) ? String(brand).toLowerCase() : "auto";
  writeSettings({ input: root, brand: brandKey });

  job = { ...blankJob(), state: "running", input: root, brand: brandKey, startedAt: new Date().toISOString() };
  const args = ["-3", SCRIPT_PATH, "--input", root, "--pipeline", "--brand", brandKey];
  if (overwrite) args.push("--overwrite");
  child = spawn("py", args, { windowsHide: true });
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
    if (job.state === "stopping") {
      job.state = "stopped";
    } else if (code === 0) {
      job.state = "done";
    } else {
      job.state = "error";
      job.error = stderr.trim().split(/\r?\n/).pop() || `Extractor exited with code ${code}.`;
    }
    job.finishedAt = new Date().toISOString();
    child = null;
  });
  return getStatus();
}

function stop() {
  if (!child) return getStatus();
  job.state = "stopping";
  child.kill();
  return getStatus();
}

// ------------------------------------------------------------------ list ----

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

function describeShape(width, height) {
  if (!width || !height) return {};
  const ratio = width / height;
  const long = Math.max(width, height) / Math.min(width, height);
  const orientation =
    Math.abs(ratio - 1) <= SQUARE_TOLERANCE ? "square" : ratio > 1 ? "landscape" : "portrait";
  const deviation = Math.round((long / TARGET_RATIO - 1) * 1000) / 10;
  const is43 = orientation !== "square" && Math.abs(deviation) <= TARGET_TOLERANCE;
  let named = NAMED_RATIOS[0];
  for (const candidate of NAMED_RATIOS) {
    if (Math.abs(Math.log(long / candidate[0])) < Math.abs(Math.log(long / named[0]))) named = candidate;
  }
  let label = is43 ? "4:3" : named[1];
  if (orientation === "square") {
    label = "1:1";
  } else if (orientation === "portrait") {
    label = label.replace(/^(\d+):(\d+)/, "$2:$1");
  }
  const rightRatio = is43 || orientation === "square";
  return {
    orientation,
    ratio: Math.round(ratio * 100) / 100,
    ratioLabel: label,
    rightRatio,
    deviation: rightRatio ? null : deviation,
  };
}

function parseCategories(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function brandFromName(name) {
  const match = String(name).match(/^(.*)_\d+$/);
  return match ? match[1] : "";
}

/** Bring catalog.db in line with the stage folders: the folder an image sits in is its stage. */
async function sync(root, db) {
  const onDisk = new Map();
  for (const stage of WORK_STAGES) {
    for (const file of flatImages(path.join(root, STAGE_DIRS[stage]))) {
      onDisk.set(path.parse(file).name, { stage, file: `${STAGE_DIRS[stage]}/${file}` });
    }
  }
  const upscaled = new Map();
  for (const file of flatImages(path.join(root, STAGE_DIRS.upscaled))) {
    upscaled.set(path.parse(file).name, `${STAGE_DIRS.upscaled}/${file}`);
  }

  const rows = new Map(db.prepare("SELECT * FROM images").all().map((row) => [row.name, row]));
  const rawRoot = path.join(root, STAGE_DIRS.raw);
  for (const file of walkImages(rawRoot)) {
    const name = path.parse(file).name;
    if (rows.has(name) && !onDisk.has(name)) {
      onDisk.set(name, { stage: "raw", file: `${STAGE_DIRS.raw}/${path.relative(rawRoot, file).replace(/\\/g, "/")}` });
    }
  }
  const names = new Set([...rows.keys(), ...onDisk.keys(), ...upscaled.keys()]);
  const insert = db.prepare(
    "INSERT INTO images (name, brand, categories, stage, file, width, height, updated_at) VALUES (?, ?, '[]', ?, ?, ?, ?, ?)"
  );
  const update = db.prepare(
    `UPDATE images SET stage = ?, file = ?, width = ?, height = ?, oriented_at = ?, cropped_at = ?,
       upscaled_file = ?, upscaled_width = ?, upscaled_height = ?, upscaled_at = ?, updated_at = ? WHERE name = ?`
  );
  const stamp = now();
  for (const name of names) {
    const disk = onDisk.get(name);
    const upFile = upscaled.get(name) || null;
    let row = rows.get(name);
    if (!row) {
      const size = disk ? await imageSize(path.join(root, disk.file)) : null;
      insert.run(name, brandFromName(name), disk ? disk.stage : "upscaled", disk ? disk.file : null,
        size?.[0] ?? null, size?.[1] ?? null, stamp);
      row = { name, file: disk?.file || null, width: size?.[0] ?? null, height: size?.[1] ?? null };
    }
    const file = disk ? disk.file : row.file;
    let width = row.width;
    let height = row.height;
    if (disk && (disk.file !== row.file || !width)) {
      const size = await imageSize(path.join(root, disk.file));
      width = size?.[0] ?? null;
      height = size?.[1] ?? null;
    }
    let upWidth = row.upscaled_width ?? null;
    let upHeight = row.upscaled_height ?? null;
    if (upFile && (upFile !== row.upscaled_file || !upWidth)) {
      const size = await imageSize(path.join(root, upFile));
      upWidth = size?.[0] ?? null;
      upHeight = size?.[1] ?? null;
    }
    if (!upFile) upWidth = upHeight = null;
    const stage = upFile ? "upscaled" : disk ? disk.stage : "missing";
    const next = {
      stage,
      file,
      width,
      height,
      oriented_at: row.oriented_at || (disk?.stage === "oriented" ? stamp : null),
      cropped_at: row.cropped_at || (disk?.stage === "cropped" ? stamp : null),
      upscaled_file: upFile,
      upscaled_width: upWidth,
      upscaled_height: upHeight,
      upscaled_at: upFile ? row.upscaled_at || stamp : null,
    };
    const changed = Object.keys(next).some((key) => (row[key] ?? null) !== (next[key] ?? null));
    if (changed) {
      update.run(next.stage, next.file, next.width, next.height, next.oriented_at, next.cropped_at,
        next.upscaled_file, next.upscaled_width, next.upscaled_height, next.upscaled_at, stamp, name);
    }
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

function mtime(file) {
  try {
    return Math.round(fs.statSync(file).mtimeMs);
  } catch {
    return 0;
  }
}

async function list({ input } = {}) {
  const root = resolveRoot(input || readSettings().input);
  writeSettings({ input: root });
  const db = openDb(root);
  try {
    if (!child) await sync(root, db);
    const rows = [];
    const skips = new Map(db.prepare("SELECT path, reason FROM raw_skips").all().map((row) => [row.path, row.reason]));
    const names = new Set();
    for (const row of db.prepare("SELECT * FROM images").all()) {
      names.add(row.name);
      const key = row.upscaled_file || row.file || "";
      const rawKey = row.stage === "raw" ? String(row.file).slice(STAGE_DIRS.raw.length + 1) : "";
      rows.push({
        key,
        name: row.name,
        brand: row.brand || "",
        categories: parseCategories(row.categories),
        file: row.file ? path.basename(row.file) : "",
        sourceFile: row.source_file || "",
        stage: rawKey && skips.has(rawKey) ? "skipped" : row.stage,
        reason: rawKey ? skips.get(rawKey) || "" : "",
        method: row.method || "",
        width: row.width,
        height: row.height,
        sourceWidth: row.source_width,
        sourceHeight: row.source_height,
        upscaledWidth: row.upscaled_width,
        upscaledHeight: row.upscaled_height,
        hasThumb: row.stage !== "missing" && Boolean(key),
        thumbVersion: key ? mtime(path.join(root, key)) : 0,
        ...describeShape(row.width, row.height),
      });
    }
    const rawRoot = path.join(root, STAGE_DIRS.raw);
    for (const file of walkImages(rawRoot)) {
      if (names.has(path.parse(file).name)) continue;
      const rel = path.relative(rawRoot, file).replace(/\\/g, "/");
      const parts = rel.split("/");
      const size = await imageSize(file);
      rows.push({
        key: `${STAGE_DIRS.raw}/${rel}`,
        name: "",
        brand: parts.length > 1 ? parts[0] : "",
        categories: parts.slice(1, -1),
        file: parts[parts.length - 1],
        sourceFile: parts[parts.length - 1],
        stage: skips.has(rel) ? "skipped" : "raw",
        reason: skips.get(rel) || "",
        method: "",
        width: size?.[0] ?? null,
        height: size?.[1] ?? null,
        hasThumb: true,
        thumbVersion: mtime(file),
        ...describeShape(size?.[0], size?.[1]),
      });
    }
    sortRows(rows);
    return { input: root, rows };
  } finally {
    db.close();
  }
}

async function thumbnail({ key, width }) {
  const root = readSettings().input;
  if (!root) throw new Error("No catalog folder loaded.");
  const file = path.resolve(root, key);
  if (!isInside(root, file) || !Object.values(STAGE_DIRS).some((dir) => isInside(path.join(root, dir), file))) {
    throw new Error("Invalid path.");
  }
  if (!IMAGE_EXTENSIONS.has(path.extname(file).toLowerCase()) || !fs.existsSync(file)) {
    throw new Error("Image not found.");
  }
  return getThumbnail(file, { width, namespace: "artwork" });
}

module.exports = {
  getStatus,
  list,
  start,
  stop,
  thumbnail,
};
