// Samples for the new lifestyle sets (Modern, Kitchen, Kids, Motivational, Statement; incl. wide/tall),
// which parseSetName and listFramesForOrientation do not know yet. Paintings come from the older live
// products of the matching group (collection) and shape, from the existing-catalog folders. Writes <set>\Samples\.
//   node scripts/frames/make_new_samples.js "<Set Name>" [paintings=3]
//   node scripts/frames/make_new_samples.js --all [paintings=3]
const fs = require("fs");
const os = require("os");
const path = require("path");
const sharp = require("sharp");
const { parseFrameTemplateFilename, frameOutputSuffix } = require("../../lib/frame-template-parser");
const { runCompositorManifest } = require("../../lib/python-setup");
const { isGodPainting } = require("../../lib/lifestyle-style");
const { newSetsDir } = require("./paths");

const HOME = os.homedir();
// Approved final crops, so a painting is shown in the shape it is sold in.
const PAINTINGS = [
  "C:\\Users\\divya\\Downloads\\_Catalog\\LIVE\\Optimised",
  "C:\\Users\\divya\\Downloads\\_Catalog\\LIVE & UPDATED\\Optimised",
  "C:\\Users\\divya\\Downloads\\_Catalog\\NOT LIVE\\Optimised",
];
// Samples must show the exact shapes we sell (3:4, 4:3, 1:1, 16:9, 9:16); the frame reshapes to the painting.
// Exact files are preferred; a file within NEAR of the shape is centre-cropped to it.
const EXACT = { portrait: 3 / 4, landscape: 4 / 3, square: 1, wide: 16 / 9, tall: 9 / 16 };
const EXACT_TOL = Math.log(1.015);
const NEAR = Math.log(1.08);
const NEW_FROM = "2026-10-01";
const SHAPE = { portrait: "portrait", landscape: "landscape", square: "square", wide: "landscape 16:9", tall: "portrait 9:16" };
const GROUP = { modern: "general", statement: "general", kitchen: "kitchen", kids: "kids", motivational: "motivational", bathroom: "bathroom", music: "music", balcony: "balcony", study: "study" };
const BATHROOM_POSTER = /\b(toilet\w*|potty|poop\w*|flush\w*|loo|bathroom (?:signs?|humou?r|quotes?|rules|art|posters?|puns?)|wash your hands|bath rules|funny bums|the best seat|toilet paper)\b/i;
const MUSIC_TITLE = /\b(music\w*|guitar\w*|piano|violin|cello|veena|sitar|tabla|flute|drums?|saxophone|jazz|vinyl|orchestra|singer|harmonium)\b/i;
const BALCONY_TITLE = /\b(botanical\w*|floral|flowers?|blossoms?|birds?|garden\w*|tropical|palms?|ferns?|monstera|leaf|leaves|plants?)\b/i;
const STUDY_TITLE = /\b(books?|reading|library|study|typewriter|maps?|globe|scholar)\b/i;
// Themes with few paintings in some shapes top up their samples from general art.
const TOP_UP = { music: ["general"], balcony: ["general"], study: ["motivational", "general"] };

function parseNewSetName(name) {
  const m = String(name).match(/^(portrait|landscape|square|wide|tall)\s+(modern|kitchen|kids|motivational|bathroom|statement|music|balcony|study)\s+(\d+)/i);
  return m && { orientation: m[1].toLowerCase(), group: GROUP[m[2].toLowerCase()] };
}

function groupOf(p) {
  // Baby/kids art stays in kids rooms even when its title names an instrument, a book or a bird.
  const c = new Set(p.collections);
  if (c.has("kids-nursery") || c.has("kids-room") || c.has("baby-room")) return "kids";
  if (BATHROOM_POSTER.test([p.title, ...(p.tags || [])].join(" | "))) return "bathroom";
  if (MUSIC_TITLE.test(p.title)) return "music";
  if (STUDY_TITLE.test(p.title)) return "study";
  if (c.has("motivational-quotes")) return "motivational";
  if (c.has("kitchen") || c.has("kitchen-prints")) return "kitchen";
  if (BALCONY_TITLE.test(p.title)) return "balcony";
  return "general";
}

function seeded(name) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return () => ((h = (h * 1103515245 + 12345) >>> 0) / 4294967296);
}

let catalog;
function candidates(group, shape) {
  if (!catalog) {
    const products = require(path.join(HOME, ".editpro", "lifestyle-sets", "products.json"));
    const shapes = require(path.join(HOME, ".editpro", "lifestyle-sets", "shapes.json"));
    const files = {};
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) {
          if (!["Cropped", "Comparison"].includes(e.name)) walk(path.join(dir, e.name));
          continue;
        }
        const m = e.name.match(/^(\d+)\.(jpe?g|png)$/i);
        if (m && !files[m[1]]) files[m[1]] = path.join(dir, e.name);
      }
    };
    for (const dir of PAINTINGS) walk(dir);
    catalog = products
      .filter((p) => p.productType === "Painting" && p.createdAt < NEW_FROM)
      .map((p) => {
        const n = (String(p.sku || "").match(/^(\d+)/) || [])[1];
        return { title: p.title, tags: p.tags, group: groupOf(p), shape: shapes[n], file: files[n] };
      })
      .filter((p) => p.file && !isGodPainting(p.tags));
  }
  return catalog.filter((p) => p.group === group && p.shape === shape);
}

async function samplesFor(setName, count) {
  const meta = parseNewSetName(setName);
  if (!meta) throw new Error(`"${setName}" is not a new-style set name`);
  const setDir = path.join(newSetsDir(), setName);
  const frames = fs
    .readdirSync(setDir)
    .map((filename) => ({ filename, parsed: parseFrameTemplateFilename(filename) }))
    .filter(({ filename, parsed }) => parsed && (!parsed.isBase || /^1\. Base .* Black\.png$/i.test(filename)))
    .map(({ filename, parsed }) => ({
      framePath: path.join(setDir, filename),
      outputIndex: parsed.index,
      room: parsed.room,
      roomLabel: parsed.roomLabel,
      frameTemplate: filename,
      frameSet: setName,
      frameColour: parsed.frameColour || null,
      isBase: Boolean(parsed.isBase),
      outputSuffix: frameOutputSuffix(parsed),
      orientation: meta.orientation,
    }))
    .sort((a, b) => a.outputIndex - b.outputIndex);

  const rand = seeded(setName);
  let pool = candidates(meta.group, SHAPE[meta.orientation]).sort(() => rand() - 0.5);
  for (const extra of TOP_UP[meta.group] || []) {
    if (pool.length >= count * 3) break;
    pool = [...pool, ...candidates(extra, SHAPE[meta.orientation]).sort(() => rand() - 0.5)];
  }
  if (!pool.length) throw new Error(`no ${meta.group} ${SHAPE[meta.orientation]} paintings for ${setName}`);
  // Correction-folder files may not be cropped to their final shape yet.
  const target = EXACT[meta.orientation];
  const exact = [], near = [];
  for (const p of pool) {
    const { width, height } = await sharp(p.file, { limitInputPixels: false }).metadata();
    const off = Math.abs(Math.log(width / height / target));
    if (off <= EXACT_TOL) exact.push(p);
    else if (off <= NEAR && near.length < count) near.push({ ...p, width, height });
    if (exact.length >= count) break;
  }
  const paintings = [...exact, ...near].slice(0, count);
  if (!paintings.length) throw new Error(`no in-shape ${meta.group} ${SHAPE[meta.orientation]} files for ${setName}`);

  const samplesDir = path.join(setDir, "Samples");
  fs.rmSync(samplesDir, { recursive: true, force: true });
  fs.mkdirSync(samplesDir, { recursive: true });
  const T = 360;
  const tiles = [];
  for (const [row, painting] of paintings.entries()) {
    const label = painting.title.replace(/[^\w ]+/g, "").slice(0, 40);
    const work = path.join(os.tmpdir(), "editpro-new-samples", setName, String(row));
    fs.rmSync(work, { recursive: true, force: true });
    fs.mkdirSync(work, { recursive: true });
    let paintingPath = painting.file;
    if (painting.width) {
      const { width: w, height: h } = painting;
      const cw = Math.min(w, Math.round(h * target)), ch = Math.min(h, Math.round(w / target));
      paintingPath = path.join(work, "painting.png");
      await sharp(painting.file, { limitInputPixels: false })
        .extract({ left: Math.floor((w - cw) / 2), top: Math.floor((h - ch) / 2), width: cw, height: ch })
        .png().toFile(paintingPath);
    }
    const manifest = path.join(work, "manifest.json");
    fs.writeFileSync(
      manifest,
      JSON.stringify({ paintingPath, frames, outputDir: work, outputBaseName: "s", size: 1080, jpegQuality: 90, blendMode: "scene", blendStrength: 1 })
    );
    const result = await runCompositorManifest(manifest).promise;
    for (const [col, img] of result.images.entries()) {
      const frame = frames.find((f) => f.outputIndex === img.index);
      const room = path.parse(frame.frameTemplate).name.replace(/^\d+\.\s*/, "");
      fs.copyFileSync(img.path, path.join(samplesDir, `Sample ${row + 1} - ${label} - ${img.index}. ${room}${path.extname(img.path)}`));
      tiles.push({ input: await sharp(img.path).flatten({ background: "#ffffff" }).resize(T, T).jpeg().toBuffer(), left: col * T, top: row * T });
    }
    fs.rmSync(work, { recursive: true, force: true });
  }
  await sharp({ create: { width: frames.length * T, height: paintings.length * T, channels: 3, background: "#ffffff" } })
    .composite(tiles)
    .jpeg({ quality: 88 })
    .toFile(path.join(samplesDir, "_Overview.jpg"));
  console.log(setName, `${paintings.length} paintings x ${frames.length} rooms`);
}

(async () => {
  const [target, countArg] = process.argv.slice(2);
  const count = Number(countArg) || 3;
  const names =
    target === "--all"
      ? fs.readdirSync(newSetsDir()).filter((n) => parseNewSetName(n) && fs.statSync(path.join(newSetsDir(), n)).isDirectory())
      : [target];
  for (const name of names) {
    try {
      await samplesFor(name, count);
    } catch (e) {
      console.error(name, "FAILED:", e.message);
    }
  }
})();
