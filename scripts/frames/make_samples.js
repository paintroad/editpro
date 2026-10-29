// Render sample paintings from the prep catalog into every room of a new lifestyle set, so the
// set can be reviewed with the kind of art it is built for. Writes <set>\Samples\.
//   node scripts/frames/make_samples.js <setFolderName> [paintings=3] [outputDir]
const fs = require("fs");
const os = require("os");
const path = require("path");
const sharp = require("sharp");
const { DatabaseSync } = require("node:sqlite");
const { listFramesForOrientation } = require("../../lib/frame-template-parser");
const { runCompositorManifest } = require("../../lib/python-setup");
const { setClassesForTags, isGodPainting, roomsForPainting, parseSetName } = require("../../lib/lifestyle-style");
const { newSetsDir } = require("./paths");

const DB = path.join(os.homedir(), ".editpro", "pipeline-prep", "catalog.db");
const QUADS = path.join(__dirname, "..", "frame-quads.json");

function shapeOf(w, h) {
  const a = w / h;
  if (Math.abs(a - 1) < 0.05) return "square";
  return a > 1 ? "landscape" : "portrait";
}

function seeded(name) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return () => ((h = (h * 1103515245 + 12345) >>> 0) / 4294967296);
}

// godSplit: how many of the picks must be god paintings (the rest are not), or null for any.
function pickPaintings(setName, setClass, orientation, count, godSplit = null) {
  const db = new DatabaseSync(DB);
  const rows = db
    .prepare("select name, file, width, height, collection_tags from images where collection_tags is not null")
    .all()
    .map((r) => ({ ...r, tags: JSON.parse(r.collection_tags || "[]") }))
    .filter((r) => r.file && fs.existsSync(r.file) && shapeOf(r.width, r.height) === orientation)
    .filter((r) => {
      const classes = setClassesForTags(r.tags);
      if (classes.includes(setClass)) return true;
      // Devotional art is nearly all god paintings, so the non-god pick may come from Traditional.
      return godSplit != null && classes.includes("Traditional") && !isGodPainting(r.tags);
    });
  const rand = seeded(setName);
  rows.sort(() => rand() - 0.5);
  // Spread the samples over different painting shapes so each set is tested beyond 3:4.
  const shapeBucket = (r) => Math.round(Math.log(r.width / r.height) / Math.log(1.08));
  const quota = (r) => {
    if (godSplit == null) return true;
    const gods = chosen.filter((c) => isGodPainting(c.tags)).length;
    return isGodPainting(r.tags) ? gods < godSplit : chosen.length - gods < count - godSplit;
  };
  const chosen = [];
  const seen = new Set();
  const shapes = new Set();
  for (const r of rows) {
    const lead = r.tags[0] || "Art";
    if (seen.has(lead) || shapes.has(shapeBucket(r)) || !quota(r)) continue;
    seen.add(lead);
    shapes.add(shapeBucket(r));
    chosen.push(r);
    if (chosen.length >= count) break;
  }
  for (const r of rows) {
    if (chosen.length >= count) break;
    if (!chosen.includes(r) && quota(r)) chosen.push(r);
  }
  for (const r of rows) {
    if (chosen.length >= count) break;
    if (!chosen.includes(r)) chosen.push(r);
  }
  return chosen;
}

(async () => {
  const [setName, countArg, outArg] = process.argv.slice(2);
  const meta = parseSetName(setName);
  if (!meta) throw new Error(`"${setName}" is not a "<Orientation> <Class> <n> - <Interior>" set name`);
  const root = newSetsDir();
  const setDir = path.join(root, setName);
  const samplesDir = outArg ? path.resolve(outArg) : path.join(setDir, "Samples");
  fs.rmSync(samplesDir, { recursive: true, force: true });
  fs.mkdirSync(samplesDir, { recursive: true });

  const allFrames = listFramesForOrientation(root, meta.orientation, setName)
    .frames.filter((f) => !f.isBase)
    .map((f) => ({ ...f, orientation: meta.orientation }));
  const quadMeta = (JSON.parse(fs.readFileSync(QUADS, "utf8")).quads[setName]) || {};
  const metaFor = (f) => (quadMeta[f.frameTemplate] || {}).meta;
  const hasGodRooms = allFrames.some((f) => (metaFor(f) || {}).godOnly);
  const count = Number(countArg) || 3;
  // Sets with god-only rooms show both kinds: god paintings first, then one that is not.
  const paintings = pickPaintings(setName, meta.setClass, meta.orientation, count, hasGodRooms ? count - 1 : null);
  const T = 360;
  const tiles = [];
  let columns = 0;

  for (const [row, painting] of paintings.entries()) {
    const frames = roomsForPainting(allFrames, metaFor, isGodPainting(painting.tags));
    columns = Math.max(columns, frames.length);
    const label = (painting.tags[0] || "Art").replace(/[^\w ]+/g, "");
    const work = path.join(os.tmpdir(), "editpro-samples", setName, String(row));
    fs.rmSync(work, { recursive: true, force: true });
    fs.mkdirSync(work, { recursive: true });
    const manifest = path.join(work, "manifest.json");
    fs.writeFileSync(
      manifest,
      JSON.stringify({ paintingPath: painting.file, frames, outputDir: work, outputBaseName: "s", size: 1080, jpegQuality: 90, blendMode: "scene", blendStrength: 1 })
    );
    const result = await runCompositorManifest(manifest).promise;
    for (const [col, img] of result.images.entries()) {
      const frame = frames.find((f) => f.outputIndex === img.index);
      const room = path.parse(frame.frameTemplate).name.replace(/^\d+\.\s*/, "");
      const out = path.join(samplesDir, `Sample ${row + 1} - ${label} - ${img.index}. ${room}.jpg`);
      fs.copyFileSync(img.path, out);
      tiles.push({ input: await sharp(img.path).resize(T, T).jpeg().toBuffer(), left: col * T, top: row * T });
    }
    fs.rmSync(work, { recursive: true, force: true });
  }
  await sharp({ create: { width: columns * T, height: paintings.length * T, channels: 3, background: "#ffffff" } })
    .composite(tiles)
    .jpeg({ quality: 88 })
    .toFile(path.join(samplesDir, "_Overview.jpg"));
  console.log(setName, `${paintings.length} paintings x ${columns} rooms ->`, samplesDir);
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
