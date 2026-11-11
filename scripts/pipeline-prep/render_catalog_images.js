// Render the new catalog images for live products from catalog-image-plan.json. Local only: no Shopify
// calls and no change to the catalog store. Each image gets the file name the plan gives it (the kept
// URL's name or the new EditPro name); the index image is PNG, rooms are JPG.
//
//   node scripts/pipeline-prep/render_catalog_images.js --sample=20      a spread across sets and shapes
//   node scripts/pipeline-prep/render_catalog_images.js --numbers=10001,11522
//   node scripts/pipeline-prep/render_catalog_images.js --all [--workers=4]   skips products already rendered
//
// Output: Downloads\_Catalog\Catalog Images\<number>\<file name>, a review sheet per product in
// Downloads\_Catalog\Catalog Images\_Sheets, and ~/.editpro/pipeline-prep/catalog-renders.json.
const fs = require("fs");
const os = require("os");
const path = require("path");
const sharp = require("sharp");
const { parseFrameTemplateFilename, frameOutputSuffix } = require("../../lib/frame-template-parser");
const { runCompositorManifest } = require("../../lib/python-setup");
const { assertClean } = require("../../lib/brand-guard");

const HOME = path.join(os.homedir(), ".editpro");
const SETS_ROOT = "C:\\Users\\divya\\Downloads\\_Frames\\_New Lifestyle Sets";
const OUT_ROOT = "C:\\Users\\divya\\Downloads\\_Catalog\\Catalog Images";
const SHEETS = path.join(OUT_ROOT, "_Sheets");
const PLAN = path.join(HOME, "pipeline-prep", "catalog-image-plan.json");
const RENDERS = path.join(HOME, "pipeline-prep", "catalog-renders.json");
const ASSIGN = path.join(HOME, "lifestyle-sets", "set-assignments.json");
const SHAPE = /^(portrait|landscape|square|wide|tall)\b/i;
const readJson = (f, d) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : d);

function framesFor(set, wanted) {
  const orientation = set.match(SHAPE)[1].toLowerCase();
  return wanted.map((file) => {
    const parsed = parseFrameTemplateFilename(file);
    if (!parsed) throw new Error(`${set}: cannot parse room file ${file}`);
    return {
      framePath: path.join(SETS_ROOT, set, file),
      outputIndex: parsed.index,
      room: parsed.room,
      roomLabel: parsed.roomLabel,
      frameTemplate: file,
      frameSet: set,
      frameColour: parsed.frameColour || null,
      isBase: Boolean(parsed.isBase),
      outputSuffix: frameOutputSuffix(parsed),
      orientation,
    };
  });
}

async function sheet(entry, files) {
  const T = 300, GAP = 10, TOP = 44;
  const tiles = await Promise.all(files.map((f) => sharp(f.path).flatten({ background: "#ffffff" }).resize(T, T).jpeg().toBuffer()));
  const width = GAP + files.length * (T + GAP);
  const height = TOP + T + 40;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const text = [`<text x="${GAP}" y="28" font-family="Segoe UI, Arial" font-size="20" font-weight="600">${esc(`${entry.number} · ${entry.title} · ${entry.set}`)}</text>`];
  files.forEach((f, i) => {
    const x = GAP + i * (T + GAP);
    text.push(`<text x="${x}" y="${TOP + T + 16}" font-family="Segoe UI, Arial" font-size="12">${esc(`${f.position}. ${f.room || "Index"} · ${f.action}`)}</text>`);
    text.push(`<text x="${x}" y="${TOP + T + 32}" font-family="Segoe UI, Arial" font-size="10" fill="#666">${esc(f.filename.slice(0, 48))}</text>`);
  });
  fs.mkdirSync(SHEETS, { recursive: true });
  await sharp({ create: { width, height, channels: 3, background: "#ffffff" } })
    .composite([...tiles.map((input, i) => ({ input, left: GAP + i * (T + GAP), top: TOP })),
      { input: Buffer.from(`<svg width="${width}" height="${height}">${text.join("")}</svg>`), left: 0, top: 0 }])
    .jpeg({ quality: 86 })
    .toFile(path.join(SHEETS, `${entry.number}.jpg`));
}

async function renderOne(entry, painting) {
  for (const img of entry.images) assertClean(img.filename, `catalog image file name for ${entry.number}`);
  const work = path.join(os.tmpdir(), "editpro-catalog-render", entry.number);
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  const frames = framesFor(entry.set, entry.images.map((i) => i.frame));
  const manifest = path.join(work, "manifest.json");
  fs.writeFileSync(manifest, JSON.stringify({
    paintingPath: painting, frames, outputDir: work, outputBaseName: "r", size: 1080, jpegQuality: 88, blendMode: "scene", blendStrength: 1,
  }));
  const result = await runCompositorManifest(manifest).promise;
  if (result.errors?.length) throw new Error(result.errors.map((e) => `${e.frameTemplate}: ${e.message}`).join("; "));
  const byFrame = new Map(result.images.map((r) => [r.frameTemplate, r.path]));

  const dir = path.join(OUT_ROOT, entry.number);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const files = entry.images.map((img) => {
    const src = byFrame.get(img.frame);
    if (!src) throw new Error(`no render for ${img.frame}`);
    if (path.extname(src).toLowerCase() !== path.extname(img.filename).toLowerCase()) {
      throw new Error(`${img.frame} rendered as ${path.extname(src)} but the plan names ${img.filename}`);
    }
    const out = path.join(dir, img.filename);
    fs.copyFileSync(src, out);
    return { ...img, path: out, bytes: fs.statSync(out).size };
  });
  fs.rmSync(work, { recursive: true, force: true });
  await sheet(entry, files);
  return files;
}

function sample(plan, n) {
  // One product per set, sets taken round-robin across shapes, devotional and wide always included.
  const bySet = new Map();
  for (const e of plan) if (!bySet.has(e.set)) bySet.set(e.set, e);
  const byShape = new Map();
  for (const [set, e] of bySet) {
    const shape = set.match(SHAPE)[1].toLowerCase();
    if (!byShape.has(shape)) byShape.set(shape, []);
    byShape.get(shape).push(e);
  }
  const picks = [];
  const must = [...bySet.values()].filter((e) => /devotional/i.test(e.set) && e.images.some((i) => /temple/i.test(i.setRoom))).slice(0, 1);
  picks.push(...must);
  const lists = [...byShape.values()];
  for (let i = 0; picks.length < n && lists.some((l) => l.length); i++) {
    const l = lists[i % lists.length];
    const e = l.splice(Math.floor(l.length / 2), 1)[0];
    if (e && !picks.includes(e)) picks.push(e);
  }
  return picks.slice(0, n);
}

(async () => {
  const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
  const { plan } = readJson(PLAN, { plan: [] });
  const paintings = readJson(ASSIGN, { paintings: {} }).paintings;
  const renders = readJson(RENDERS, {});
  let list;
  if (arg("numbers")) {
    const want = new Set(arg("numbers").split(","));
    list = plan.filter((e) => want.has(e.number));
  } else if (arg("sample")) {
    list = sample(plan, Number(arg("sample")));
  } else if (process.argv.includes("--all")) {
    list = plan.filter((e) => !renders[e.number]);
  } else {
    console.log("Pass --sample=N, --numbers=a,b or --all");
    return;
  }
  const workers = Math.max(1, Number(arg("workers")) || 2);
  console.log(`${list.length} products, ${list.reduce((a, e) => a + e.images.length, 0)} images, ${workers} at a time`);

  let ok = 0, failed = 0, next = 0;
  const started = Date.now();
  const save = () => fs.writeFileSync(RENDERS, JSON.stringify(renders, null, 1));
  await Promise.all(Array.from({ length: workers }, async () => {
    while (next < list.length) {
      const entry = list[next++];
      const painting = paintings[entry.number]?.image;
      try {
        if (!painting || !fs.existsSync(painting)) throw new Error(`painting file missing: ${painting}`);
        const files = await renderOne(entry, painting);
        renders[entry.number] = { renderedAt: new Date().toISOString(), set: entry.set, painting,
          images: files.map(({ position, frame, room, action, filename, mediaId, path: p, bytes }) => ({ position, frame, room, action, filename, mediaId, path: p, bytes })) };
        ok++;
      } catch (e) {
        failed++;
        console.error(`${entry.number} FAILED: ${e.message}`);
      }
      if ((ok + failed) % 25 === 0) {
        save();
        const rate = (ok + failed) / ((Date.now() - started) / 1000);
        console.log(`${ok + failed}/${list.length} (${Math.round((list.length - ok - failed) / rate / 60)} min left)`);
      }
    }
  }));
  save();
  console.log(`done: ${ok} rendered, ${failed} failed -> ${OUT_ROOT}`);
})();
