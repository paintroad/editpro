/**
 * Painting crop review, lifestyle set review and printable model trials inside EditPro.
 * Pages: <base>/review/crop/, <base>/review/sets/, <base>/review/printables/, <base>/review/catalog/ and <base>/review/watermarks/ (each page calls api/items, img, api/feedback
 * relative to itself). Feedback is read from disk on every request, so the notes scripts can update
 * it while EditPro runs.
 */
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const sharp = require("sharp");

const SCRIPTS = path.join(__dirname, "..", "scripts");
const PREP = path.join(os.homedir(), ".editpro", "pipeline-prep");
const TYPES = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };

const CROP = {
  page: path.join(SCRIPTS, "pipeline-prep", "crop-review.html"),
  items: path.join(PREP, "crop-review-items.json"),
  feedback: path.join(PREP, "crop-review.json"),
  final: path.join(PREP, "final-render.json"),
  newItems: path.join(PREP, "new-batch-items.json"),
  pendingItems: path.join(PREP, "pending-items.json"),
  groups: path.join(PREP, "review-groups.json"),
  live: path.join(PREP, "live-products.json"),
  index: path.join(PREP, "catalog-file-index.json"),
  topaz: path.join(PREP, "topaz-upscaled.json"),
  previews: path.join(PREP, "printable-previews"),
  root: "C:\\Users\\divya\\Downloads\\_Existing Catalog Correction",
};
const PREVIEW_LONG = 1600;

const SETS = {
  page: path.join(SCRIPTS, "frames", "set-review.html"),
  feedback: path.join(os.homedir(), ".editpro", "lifestyle-sets", "set-review.json"),
  root: "C:\\Users\\divya\\Downloads\\_Frames\\_New Lifestyle Sets",
  // Rooms as they were before a rework round (scripts/frames/keep_before.js).
  before: path.join(os.homedir(), ".editpro", "lifestyle-sets", "before"),
};
// Which set each painting goes in: proposals from scripts/frames/assign_sets.js, decisions in set-assign-review.json.
const ASSIGN = {
  page: path.join(SCRIPTS, "frames", "set-assign.html"),
  proposals: path.join(os.homedir(), ".editpro", "lifestyle-sets", "set-assignments.json"),
  feedback: path.join(os.homedir(), ".editpro", "lifestyle-sets", "set-assign-review.json"),
  thumbs: path.join(os.homedir(), ".editpro", "lifestyle-sets", "assign-thumbs"),
};
const THUMB_LONG = 360;
const TRIALS = {
  page: path.join(SCRIPTS, "pipeline-prep", "printable-review.html"),
  log: path.join(PREP, "printable-trials", "printable-trials.json"),
  feedback: path.join(PREP, "printable-trials", "printable-review.json"),
};
// Catalog audit (collections and best room per product); data comes from scripts/catalog-audit/regenerate.js.
const CATALOG = require("../scripts/catalog-audit/review/data");
const CATALOG_THUMBS = path.join(os.homedir(), ".editpro", "catalog-review-thumbs");
const LIVE_PRODUCTS = path.join(os.homedir(), ".editpro", "lifestyle-sets", "products.json");
// Watermark check: text boxes from scripts/watermarks/scan.py, scored in scripts/watermarks/data.js.
const WATERMARKS = require("../scripts/watermarks/data");
const WATERMARK_THUMBS = path.join(os.homedir(), ".editpro", "watermark-thumbs");

// The older devotional / traditional / contemporary / mixed sets come after the newer groups.
const NEW_SET = /^(portrait|landscape|square|wide|tall)\s+(modern|kitchen|kids|motivational|bathroom|music|balcony|study|statement|devotional|traditional|contemporary|mixed)\s+(\d+)/i;
const SLIDE = /^(\d+)\.\s*(.+)\.(jpe?g|png|webp)$/i;
const GROUP_ORDER = { modern: 0, statement: 1, kitchen: 2, kids: 3, motivational: 4, bathroom: 5, balcony: 6, music: 7, study: 8, devotional: 9, traditional: 10, contemporary: 11, mixed: 12 };
const SHAPE_ORDER = { portrait: 0, landscape: 1, square: 2, wide: 3, tall: 4 };

function readJson(file, fallback) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : fallback;
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
  fs.renameSync(tmp, file);
}

const NEW_FIRST = 13216, NEW_LAST = 14031;
function isNewBatch(file) { const n = parseInt(file, 10); return n >= NEW_FIRST && n <= NEW_LAST; }

// Groups come from build_review_groups.py (anything else is hidden); `live` is the product's status in the
// Shopify snapshot from fetch_live_products.js: ACTIVE, DRAFT, or null when there is no product.
let cropItems = { mtime: 0, list: [], byKey: new Map() };
function loadCropItems() {
  const files = [CROP.items, CROP.newItems, CROP.pendingItems, CROP.groups, CROP.live, CROP.topaz];
  const mtime = files.reduce((t, f) => t + (fs.existsSync(f) ? fs.statSync(f).mtimeMs : 0), 0);
  if (mtime !== cropItems.mtime) {
    const groupOf = new Map();
    for (const [group, keys] of Object.entries(readJson(CROP.groups, {}))) for (const k of keys) groupOf.set(k, group);
    const live = new Map();
    for (const p of readJson(CROP.live, [])) if (p.number && live.get(p.number) !== "ACTIVE") live.set(p.number, p.status);
    const topaz = new Set(readJson(CROP.topaz, []));
    const list = [...readJson(CROP.items, []), ...readJson(CROP.newItems, []), ...readJson(CROP.pendingItems, [])]
      .map((i) => {
        const n = i.file.replace(/\.[^.]+$/, "").toUpperCase();
        return { ...i, ...(isNewBatch(i.file) ? { batch: "new" } : {}), group: groupOf.get(i.key) || null,
          live: live.get(n) || null, topaz: topaz.has(n) };
      });
    cropItems = { mtime, list, byKey: new Map(list.map((i) => [i.key, i])) };
  }
  return cropItems;
}

function sourceOf(item) { return item.path || path.join(CROP.root, item.folder, item.file); }

let setItems = { at: 0, list: [], byKey: new Map() };
function loadSetItems() {
  if (Date.now() - setItems.at < 60_000) return setItems;
  const list = [];
  for (const set of fs.readdirSync(SETS.root)) {
    const m = set.match(NEW_SET);
    const dir = path.join(SETS.root, set);
    if (!m || !fs.statSync(dir).isDirectory()) continue;
    const sampleDir = path.join(dir, "Samples");
    const samples = fs.existsSync(sampleDir) ? fs.readdirSync(sampleDir).filter((f) => !f.startsWith("_")) : [];
    const beforeDir = path.join(SETS.before, set);
    const beforeSamples = fs.existsSync(path.join(beforeDir, "Samples")) ? fs.readdirSync(path.join(beforeDir, "Samples")) : [];
    for (const file of fs.readdirSync(dir)) {
      const s = file.match(SLIDE);
      // The index image is the black base frame (PNG); other base colours are not used here.
      if (!s || (/^base\b/i.test(s[2]) && !/^base .* black\.png$/i.test(`${s[2]}.${s[3]}`))) continue;
      const stem = file.replace(/\.[^.]+$/, "");
      const ofRoom = (f) => f.replace(/\.[^.]+$/, "").endsWith(` - ${stem}`);
      const before = fs.existsSync(path.join(beforeDir, file));
      list.push({
        key: `${set}/${file}`,
        set,
        file,
        slide: Number(s[1]),
        room: /^base\b/i.test(s[2]) ? "Index image (painting end to end, black frame)" : s[2],
        group: m[2].toLowerCase(),
        shape: m[1].toLowerCase(),
        number: Number(m[3]),
        samples: samples.filter(ofRoom).sort(),
        ...(before ? { before: true, beforeSamples: beforeSamples.filter(ofRoom).sort() } : {}),
      });
    }
  }
  list.sort((a, b) => GROUP_ORDER[a.group] - GROUP_ORDER[b.group] || SHAPE_ORDER[a.shape] - SHAPE_ORDER[b.shape] ||
    a.number - b.number || a.slide - b.slide);
  setItems = { at: Date.now(), list, byKey: new Map(list.map((i) => [i.key, i])) };
  return setItems;
}

let finalRows = { mtime: 0, map: {} };
function loadFinal() {
  if (!fs.existsSync(CROP.final)) return {};
  const mtime = fs.statSync(CROP.final).mtimeMs;
  if (mtime !== finalRows.mtime) finalRows = { mtime, map: readJson(CROP.final, {}) };
  return finalRows.map;
}

// A printable edited by a fix (text removed, border kept) is shown instead of the original printable,
// so the live preview matches the edited original on the left.
let printableIndex = { mtime: 0, map: {} };
function printableFor(item) {
  const mtime = fs.statSync(CROP.index).mtimeMs;
  if (mtime !== printableIndex.mtime) printableIndex = { mtime, map: readJson(CROP.index, {}).printable || {} };
  const own = readJson(CROP.feedback, {})[item.key]?.recipe?.clean_printable;
  if (own && fs.existsSync(own)) return own;
  return printableIndex.map[item.file.replace(/\.[^.]+$/, "")] || null;
}

async function greySample(input, rotate) {
  let s = sharp(input, { limitInputPixels: false }).autoOrient();
  if (rotate) s = s.rotate(rotate);
  return s.resize(48, 48, { fit: "fill" }).greyscale().raw().toBuffer();
}

// Printables saved sideways are turned whichever way best matches the optimised file.
async function bestRotation(printable, optimised) {
  const ref = await greySample(optimised, 0);
  let best = 90, bestDiff = Infinity;
  for (const angle of [90, 270]) {
    const buf = await greySample(printable, angle);
    let diff = 0;
    for (let i = 0; i < buf.length; i++) diff += Math.abs(buf[i] - ref[i]);
    if (diff < bestDiff) { bestDiff = diff; best = angle; }
  }
  return best;
}

const previewJobs = new Map();
function printablePreview(item) {
  const file = printableFor(item);
  if (!file || !fs.existsSync(file)) return Promise.resolve({ exists: false });
  const stem = item.file.replace(/\.[^.]+$/, "");
  const jpg = path.join(CROP.previews, `${stem}.jpg`);
  const info = path.join(CROP.previews, `${stem}.json`);
  const srcTime = fs.statSync(file).mtimeMs;
  if (fs.existsSync(info) && fs.existsSync(jpg)) {
    const cached = readJson(info, {});
    if (cached.file === file && cached.srcTime === srcTime) return Promise.resolve({ ...cached, jpg });
  }
  if (previewJobs.has(stem)) return previewJobs.get(stem);
  const job = (async () => {
    const meta = await sharp(file, { limitInputPixels: false }).metadata();
    let w = meta.width, h = meta.height;
    if (meta.orientation >= 5) [w, h] = [h, w];
    const ratio = item.w / item.h;
    let rotate = 0, framing = "same";
    if (Math.abs(w / h - ratio) > 0.01) {
      if (Math.abs(h / w - ratio) <= 0.01) {
        rotate = await bestRotation(file, sourceOf(item));
        [w, h] = [h, w];
        framing = "rotated";
      } else framing = "different";
    }
    fs.mkdirSync(CROP.previews, { recursive: true });
    let s = sharp(file, { limitInputPixels: false }).autoOrient();
    if (rotate) s = s.rotate(rotate);
    await s.resize(PREVIEW_LONG, PREVIEW_LONG, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 85 }).toFile(jpg);
    const result = { exists: true, file, srcTime, w, h, rotate, framing };
    writeJson(info, result);
    return { ...result, jpg };
  })().finally(() => previewJobs.delete(stem));
  previewJobs.set(stem, job);
  return job;
}

// Trials come from printable_trials.py: the cropped input, then one upscale per model.
let trialItems = { mtime: 0, list: [], byKey: new Map() };
function loadTrialItems() {
  const mtime = fs.existsSync(TRIALS.log) ? fs.statSync(TRIALS.log).mtimeMs : 0;
  if (mtime !== trialItems.mtime) {
    const list = Object.entries(readJson(TRIALS.log, {})).map(([n, row]) => ({
      key: n,
      cropKey: row.key,
      base: row.base,
      target: row.target,
      input: path.join(path.dirname(TRIALS.log), n, "input.jpg"),
      input_px: row.input_px,
      runs: Object.entries(row.runs || {}).filter(([, v]) => v.file && fs.existsSync(v.file)).map(([id, v]) => ({
        id, model: v.model, file: v.file, px: v.got, credits: v.credits, seconds: v.seconds, scale: v.scale,
      })),
    })).sort((a, b) => a.key.localeCompare(b.key));
    trialItems = { mtime, list, byKey: new Map(list.map((i) => [i.key, i])) };
  }
  return trialItems;
}

let assignData = { mtime: 0, paintings: {} };
function loadAssignments() {
  const mtime = fs.existsSync(ASSIGN.proposals) ? fs.statSync(ASSIGN.proposals).mtimeMs : 0;
  if (mtime !== assignData.mtime) assignData = { mtime, paintings: readJson(ASSIGN.proposals, {}).paintings || {} };
  return assignData.paintings;
}

function assignSets() {
  const quads = readJson(path.join(SCRIPTS, "frame-quads.json"), {}).quads || {};
  const sets = [];
  for (const name of fs.readdirSync(SETS.root)) {
    const m = name.match(NEW_SET);
    const dir = path.join(SETS.root, name);
    if (!m || !fs.statSync(dir).isDirectory()) continue;
    const rooms = fs.readdirSync(dir).filter((f) => SLIDE.test(f) && !/^\d+\.\s*base\b/i.test(f))
      .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
    sets.push({ name, shape: m[1].toLowerCase(), group: m[2].toLowerCase(), number: Number(m[3]), rooms,
      previewRoom: assignPreviews.previewRoom(name, quads) });
  }
  return sets.sort((a, b) => SHAPE_ORDER[a.shape] - SHAPE_ORDER[b.shape] || GROUP_ORDER[a.group] - GROUP_ORDER[b.group] || a.number - b.number);
}

// Room previews come from scripts/frames/assign_previews.js; a moved painting is rendered here on demand.
const assignPreviews = require("../scripts/frames/assign_previews");
const previewQueue = new Set();
let previewRunning = false;
function queuePreviews(stems) {
  for (const s of stems) previewQueue.add(s);
  if (previewRunning || !previewQueue.size) return;
  previewRunning = true;
  const batch = new Set(previewQueue);
  previewQueue.clear();
  assignPreviews.runWorkers(assignPreviews.buildJobs(batch), 2)
    .catch(() => {})
    .finally(() => { previewRunning = false; queuePreviews([]); });
}
function assignedSet(stem) {
  return readJson(ASSIGN.feedback, {})[stem]?.set || loadAssignments()[stem]?.set;
}

const thumbJobs = new Map();
function paintingThumb(stem) {
  const row = loadAssignments()[stem];
  if (!row) return Promise.resolve(null);
  const src = loadFinal()[row.key]?.optimised || sourceOf(loadCropItems().byKey.get(row.key) || {});
  if (!src || !fs.existsSync(src)) return Promise.resolve(null);
  const out = path.join(ASSIGN.thumbs, `${stem}.jpg`);
  if (fs.existsSync(out) && fs.statSync(out).mtimeMs >= fs.statSync(src).mtimeMs) return Promise.resolve(out);
  if (thumbJobs.has(stem)) return thumbJobs.get(stem);
  const job = (async () => {
    fs.mkdirSync(ASSIGN.thumbs, { recursive: true });
    await sharp(src, { limitInputPixels: false }).autoOrient().flatten({ background: "#ffffff" })
      .resize(THUMB_LONG, THUMB_LONG, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 80 }).toFile(out);
    return out;
  })().finally(() => thumbJobs.delete(stem));
  thumbJobs.set(stem, job);
  return job;
}

// Catalog review shows our optimised painting (approved crop) for each product; products without one keep the live image.
let catalogImageMap = { sig: "", map: new Map() };
function catalogImages() {
  const assignments = loadAssignments(), final = loadFinal(), items = loadCropItems().byKey;
  const sig = [assignData.mtime, finalRows.mtime, cropItems.mtime, fs.existsSync(LIVE_PRODUCTS) ? fs.statSync(LIVE_PRODUCTS).mtimeMs : 0].join("|");
  if (sig === catalogImageMap.sig) return catalogImageMap.map;
  const byNumber = new Map();
  for (const [stem, row] of Object.entries(assignments)) {
    const item = items.get(row.key);
    const file = final[row.key]?.optimised || (item ? sourceOf(item) : null);
    if (!file || !fs.existsSync(file)) continue;
    const number = stem.replace(/[A-Z]+$/i, "");
    if (!byNumber.has(number) || stem === number) byNumber.set(number, file);
  }
  const byId = new Map();
  for (const p of readJson(LIVE_PRODUCTS, [])) {
    const number = (String(p.sku || "").match(/^(\d+)/) || [])[1];
    const file = number && byNumber.get(number);
    if (file) byId.set(String(p.id).replace(/^gid:\/\/shopify\/Product\//, ""), file);
  }
  catalogImageMap = { sig, map: byId };
  return byId;
}

const catalogThumbJobs = new Map();
function catalogThumb(src, id, width, dir = CATALOG_THUMBS) {
  const out = path.join(dir, `${id}_${width}.jpg`);
  if (fs.existsSync(out) && fs.statSync(out).mtimeMs >= fs.statSync(src).mtimeMs) return Promise.resolve(out);
  if (catalogThumbJobs.has(out)) return catalogThumbJobs.get(out);
  const job = (async () => {
    fs.mkdirSync(dir, { recursive: true });
    await sharp(src, { limitInputPixels: false }).autoOrient().flatten({ background: "#ffffff" })
      .resize(width, width, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 82 }).toFile(out);
    return out;
  })().finally(() => catalogThumbJobs.delete(out));
  catalogThumbJobs.set(out, job);
  return job;
}

function currentPrintable(item, final) {
  const file = final[item.cropKey]?.printable || readJson(CROP.index, {}).printable?.[item.key];
  return file && fs.existsSync(file) ? file : null;
}

function sendImage(res, file) {
  if (!fs.existsSync(file)) return res.status(404).json({ error: "Image not found." });
  res.setHeader("Content-Type", TYPES[path.extname(file).toLowerCase()] || "application/octet-stream");
  res.setHeader("Cache-Control", "no-cache");
  fs.createReadStream(file).pipe(res);
}

// The fix scripts write recipe/history/revised while a page may be open with an older copy of the entry.
// Those fields always come from disk. If the page's copy predates the latest fix round, its status, crop
// and repeated old note are stale too; only a new note typed since then is kept.
const SCRIPT_FIELDS = ["recipe", "recipe_round", "history", "revised"];
function mergeEntry(disk, entry) {
  const merged = { ...entry };
  for (const f of SCRIPT_FIELDS) {
    if (f in disk) merged[f] = disk[f];
    else delete merged[f];
  }
  const rounds = (e) => (Array.isArray(e.history) ? e.history.length : 0);
  if (rounds(disk) > rounds(entry)) {
    const handled = new Set((disk.history || []).map((h) => (h.note || "").trim()));
    const note = (entry.note || "").trim();
    const fresh = { ...disk, edge: entry.edge };
    if (!entry.edge) delete fresh.edge;
    if (note && !handled.has(note)) Object.assign(fresh, { note, status: entry.status, checked: entry.checked });
    return fresh;
  }
  return merged;
}

function feedbackHandler(feedbackFile, loadItems) {
  return (req, res) => {
    try {
      const { key, entry } = req.body || {};
      if (!loadItems().byKey.has(key)) return res.status(400).json({ error: "Unknown item." });
      const feedback = readJson(feedbackFile, {});
      if (entry) feedback[key] = { ...mergeEntry(feedback[key] || {}, entry), at: new Date().toISOString() };
      else delete feedback[key];
      writeJson(feedbackFile, feedback);
      res.json({ ok: true, entry: feedback[key] || null });
    } catch (error) {
      res.status(400).json({ error: error.message || "Failed to save." });
    }
  };
}

// The pages use relative URLs, so they must be served with a trailing slash.
function page(file, slashed) {
  return (req, res) => {
    if (!req.originalUrl.split("?")[0].endsWith("/")) return res.redirect(slashed);
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(file);
  };
}

function createReviewRouter() {
  const r = express.Router();

  r.get("/review/crop", page(CROP.page, "crop/"));
  r.get("/review/crop/api/items", (_req, res) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      const final = {};
      for (const [key, row] of Object.entries(loadFinal())) {
        final[key] = row.error ? { error: row.error }
          : { frac: row.frac, v: (row.sig || "").slice(0, 10), printable: Boolean(row.printable), printable_px: row.printable_px, framing: row.framing,
            clean_printable: row.clean_printable, name: row.printable ? path.basename(row.printable) : null };
      }
      res.json({ items: loadCropItems().list, feedback: readJson(CROP.feedback, {}), final });
    } catch (error) {
      res.status(400).json({ error: error.message || "Failed to load paintings." });
    }
  });
  r.get("/review/crop/api/printable", async (req, res) => {
    const item = loadCropItems().byKey.get(String(req.query.key || ""));
    if (!item) return res.status(404).json({ error: "Unknown painting." });
    try {
      const { exists, file, w, h, framing } = await printablePreview(item);
      res.setHeader("Cache-Control", "no-store");
      res.json(exists ? { exists, name: path.basename(file), w, h, framing } : { exists: false });
    } catch (error) {
      res.status(400).json({ error: error.message || "Failed to read printable." });
    }
  });
  r.get("/review/crop/printable", async (req, res) => {
    const item = loadCropItems().byKey.get(String(req.query.key || ""));
    if (!item) return res.status(404).json({ error: "Unknown painting." });
    try {
      const p = await printablePreview(item);
      if (!p.exists) return res.status(404).json({ error: "No printable file." });
      // Full size is only served when no turn is needed; the browser applies the file's own orientation.
      sendImage(res, req.query.full && !p.rotate ? p.file : p.jpg);
    } catch (error) {
      res.status(400).json({ error: error.message || "Failed to read printable." });
    }
  });
  r.get("/review/crop/img", (req, res) => {
    const item = loadCropItems().byKey.get(String(req.query.key || ""));
    if (!item) return res.status(404).json({ error: "Unknown painting." });
    const clean = readJson(CROP.feedback, {})[item.key]?.recipe?.clean;
    const file = clean && !req.query.orig && fs.existsSync(clean) ? clean : sourceOf(item);
    sendImage(res, file);
  });
  r.get("/review/crop/final", (req, res) => {
    const key = String(req.query.key || "");
    if (!loadCropItems().byKey.has(key)) return res.status(404).json({ error: "Unknown painting." });
    const row = loadFinal()[key];
    const file = row && ({ print: row.preview, full: row.printable }[req.query.kind] || row.optimised);
    if (!file) return res.status(404).json({ error: "Not rendered yet." });
    sendImage(res, file);
  });
  r.post("/review/crop/api/feedback", feedbackHandler(CROP.feedback, loadCropItems));

  r.get("/review/sets", page(SETS.page, "sets/"));
  r.get("/review/sets/api/items", (_req, res) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      res.json({ items: loadSetItems().list, feedback: readJson(SETS.feedback, {}) });
    } catch (error) {
      res.status(400).json({ error: error.message || "Failed to load sets." });
    }
  });
  r.get("/review/sets/img", (req, res) => {
    const item = loadSetItems().byKey.get(String(req.query.key || ""));
    if (!item) return res.status(404).json({ error: "Unknown slide." });
    const sample = req.query.sample ? String(req.query.sample) : "";
    const before = req.query.before === "1";
    if (before && !item.before) return res.status(404).json({ error: "No before copy." });
    if (sample && !(before ? item.beforeSamples : item.samples).includes(sample)) return res.status(404).json({ error: "Unknown sample." });
    const dir = before ? path.join(SETS.before, item.set) : path.join(SETS.root, item.set);
    sendImage(res, sample ? path.join(dir, "Samples", sample) : path.join(dir, item.file));
  });
  r.post("/review/sets/api/feedback", feedbackHandler(SETS.feedback, loadSetItems));

  r.get("/review/assign", page(ASSIGN.page, "assign/"));
  r.get("/review/assign/api/items", (_req, res) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      res.json({ sets: assignSets(), paintings: loadAssignments(), feedback: readJson(ASSIGN.feedback, {}) });
    } catch (error) {
      res.status(400).json({ error: error.message || "Failed to load set assignments." });
    }
  });
  r.get("/review/assign/thumb", async (req, res) => {
    try {
      const file = await paintingThumb(String(req.query.stem || ""));
      if (!file) return res.status(404).json({ error: "No image." });
      res.setHeader("Content-Type", "image/jpeg");
      res.setHeader("Cache-Control", "max-age=3600");
      fs.createReadStream(file).pipe(res);
    } catch (error) {
      res.status(400).json({ error: error.message || "Failed to make thumbnail." });
    }
  });
  r.get("/review/assign/preview", (req, res) => {
    const stem = String(req.query.stem || "");
    if (!loadAssignments()[stem]) return res.status(404).json({ error: "Unknown painting." });
    const file = assignPreviews.previewPath(assignedSet(stem), stem);
    if (fs.existsSync(file)) return sendImage(res, file);
    if (req.query.render) queuePreviews([stem]);
    res.status(404).json({ error: "Preview not rendered yet.", pending: true });
  });
  r.get("/review/assign/painting", (req, res) => {
    const row = loadAssignments()[String(req.query.stem || "")];
    if (!row) return res.status(404).json({ error: "Unknown painting." });
    sendImage(res, loadFinal()[row.key]?.optimised || sourceOf(loadCropItems().byKey.get(row.key) || {}));
  });
  r.get("/review/assign/room", (req, res) => {
    const set = assignSets().find((s) => s.name === String(req.query.set || ""));
    const file = String(req.query.file || "");
    if (!set || !set.rooms.includes(file)) return res.status(404).json({ error: "Unknown room." });
    sendImage(res, path.join(SETS.root, set.name, file));
  });
  // Body: { stems: [...], entry: { set?, status?, note? } }; entry null clears the decision.
  r.post("/review/assign/api/feedback", (req, res) => {
    try {
      const { stems, entry } = req.body || {};
      const paintings = loadAssignments();
      if (!Array.isArray(stems) || !stems.length || stems.some((s) => !paintings[s])) return res.status(400).json({ error: "Unknown painting." });
      if (entry?.set) {
        const target = assignSets().find((s) => s.name === entry.set);
        if (!target || stems.some((s) => paintings[s].shape !== target.shape)) return res.status(400).json({ error: "That set does not fit this painting's shape." });
      }
      const feedback = readJson(ASSIGN.feedback, {});
      const at = new Date().toISOString();
      for (const stem of stems) {
        if (!entry) { delete feedback[stem]; continue; }
        const next = { ...(feedback[stem] || {}), ...entry, at };
        if (next.set === paintings[stem].set) delete next.set;
        feedback[stem] = next;
      }
      writeJson(ASSIGN.feedback, feedback);
      const needPreview = stems.filter((s) => !fs.existsSync(assignPreviews.previewPath(feedback[s]?.set || paintings[s].set, s)));
      if (needPreview.length) queuePreviews(needPreview);
      res.json({ ok: true, entries: Object.fromEntries(stems.map((s) => [s, feedback[s] || null])) });
    } catch (error) {
      res.status(400).json({ error: error.message || "Failed to save." });
    }
  });

  r.get("/review/printables", page(TRIALS.page, "printables/"));
  r.get("/review/printables/api/items", (_req, res) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      const final = loadFinal();
      const items = loadTrialItems().list.map((t) => ({ ...t, current: Boolean(currentPrintable(t, final)) }));
      res.json({ items, feedback: readJson(TRIALS.feedback, {}) });
    } catch (error) {
      res.status(400).json({ error: error.message || "Failed to load printable trials." });
    }
  });
  r.get("/review/printables/img", (req, res) => {
    const item = loadTrialItems().byKey.get(String(req.query.key || ""));
    if (!item) return res.status(404).json({ error: "Unknown painting." });
    const pane = String(req.query.pane || "");
    if (pane === "input") return sendImage(res, item.input);
    if (pane === "current") {
      const file = currentPrintable(item, loadFinal());
      return file ? sendImage(res, file) : res.status(404).json({ error: "No current printable." });
    }
    const run = item.runs.find((x) => x.id === pane);
    if (!run || !run.file) return res.status(404).json({ error: "Unknown model output." });
    sendImage(res, run.file);
  });
  r.post("/review/printables/api/feedback", feedbackHandler(TRIALS.feedback, loadTrialItems));

  r.get("/review/catalog", page(CATALOG.PAGE, "catalog/"));
  r.get("/review/catalog/app.js", (_req, res) => {
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(CATALOG.SCRIPT);
  });
  r.get("/review/catalog/api/data", (_req, res) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      const data = CATALOG.data();
      const local = catalogImages();
      for (const p of data.products) {
        p.liveImage = p.image;
        if (local.has(String(p.id))) p.image = `img?id=${encodeURIComponent(p.id)}`;
      }
      res.json(data);
    } catch (error) {
      res.status(400).json({ error: error.message || "Failed to load the catalog audit. Run scripts/catalog-audit/regenerate.js." });
    }
  });
  r.get("/review/catalog/img", async (req, res) => {
    const id = String(req.query.id || "");
    const src = catalogImages().get(id);
    if (!src || !fs.existsSync(src)) return res.status(404).json({ error: "No local image for this product." });
    const width = Number(req.query.width) > 300 ? 1000 : 200;
    try {
      const out = await catalogThumb(src, id.replace(/\D/g, ""), width);
      res.setHeader("Cache-Control", "private, max-age=3600");
      res.type("image/jpeg").sendFile(out);
    } catch (error) {
      res.status(500).json({ error: error.message || "Thumbnail failed." });
    }
  });
  r.get("/review/catalog/api/feedback", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.type("json").send(CATALOG.readFeedback());
  });
  r.post("/review/catalog/api/feedback", (req, res) => {
    try {
      CATALOG.saveFeedback(req.body);
      res.json({ ok: true });
    } catch (error) {
      res.status(400).json({ error: error.message || "Failed to save." });
    }
  });
  r.get("/review/catalog/export", (_req, res) => {
    res.setHeader("Content-Disposition", 'attachment; filename="catalog-feedback.json"');
    res.type("json").send(CATALOG.readFeedback());
  });

  r.get("/review/watermarks", page(WATERMARKS.PAGE, "watermarks/"));
  r.get("/review/watermarks/api/items", (_req, res) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      const { items, total, scanned } = WATERMARKS.items();
      res.json({ items, total, scanned, feedback: WATERMARKS.readFeedback() });
    } catch (error) {
      res.status(400).json({ error: error.message || "Failed to load the watermark scan." });
    }
  });
  r.get("/review/watermarks/img", async (req, res) => {
    const key = String(req.query.key || "");
    const src = WATERMARKS.optimisedOf(key);
    if (!src || !fs.existsSync(src)) return res.status(404).json({ error: "No optimised image." });
    if (req.query.full) return sendImage(res, src);
    try {
      const id = crypto.createHash("sha1").update(key).digest("hex").slice(0, 16);
      const out = await catalogThumb(src, id, 420, WATERMARK_THUMBS);
      res.setHeader("Cache-Control", "private, max-age=3600");
      res.type("image/jpeg").sendFile(out);
    } catch (error) {
      res.status(500).json({ error: error.message || "Thumbnail failed." });
    }
  });
  r.post("/review/watermarks/api/feedback", (req, res) => {
    try {
      const { key, entry } = req.body || {};
      res.json({ ok: true, entry: WATERMARKS.saveDecision(String(key || ""), entry) });
    } catch (error) {
      res.status(400).json({ error: error.message || "Failed to save." });
    }
  });
  r.get("/review/watermarks/export", (_req, res) => {
    const rows = WATERMARKS.toFix();
    res.setHeader("Content-Disposition", 'attachment; filename="watermarks-to-fix.json"');
    res.type("json").send(JSON.stringify(rows, null, 1));
  });

  return r;
}

module.exports = { createReviewRouter };
