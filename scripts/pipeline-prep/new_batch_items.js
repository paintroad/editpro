/**
 * Review entries for the recently uploaded batch (products 13216-14031) that needed no crop, so the final
 * check can show every painting of that batch. Paintings already in crop review are left there.
 *
 *   node new_batch_items.js     writes ~/.editpro/pipeline-prep/new-batch-items.json
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const sharp = require("sharp");

const PREP = path.join(os.homedir(), ".editpro", "pipeline-prep");
const NEW_FIRST = 13216, NEW_LAST = 14031;
const SHAPES = [3 / 4, 4 / 3, 1, 9 / 16, 16 / 9];

const isNew = (stem) => { const n = parseInt(stem, 10); return n >= NEW_FIRST && n <= NEW_LAST; };

async function main() {
  const items = JSON.parse(fs.readFileSync(path.join(PREP, "crop-review-items.json"), "utf8"));
  const index = JSON.parse(fs.readFileSync(path.join(PREP, "catalog-file-index.json"), "utf8"));
  const reviewed = new Set(items.map((i) => path.parse(i.file).name));
  const out = [];
  for (const [stem, file] of Object.entries(index.optimised)) {
    if (!isNew(stem) || reviewed.has(stem) || !fs.existsSync(file)) continue;
    const meta = await sharp(file).metadata();
    let { width: w, height: h } = meta;
    if (meta.orientation >= 5) [w, h] = [h, w];
    const target = SHAPES.reduce((a, b) => (Math.abs(b - w / h) < Math.abs(a - w / h) ? b : a));
    out.push({
      key: `Recently uploaded/${path.basename(file)}`,
      folder: "Recently uploaded (no crop needed)",
      file: path.basename(file),
      path: file,
      edge: "new",
      w, h, target,
      frac: [0, 0, 1, 1],
    });
  }
  out.sort((a, b) => a.file.localeCompare(b.file, undefined, { numeric: true }));
  fs.writeFileSync(path.join(PREP, "new-batch-items.json"), JSON.stringify(out, null, 1));
  console.log("new batch without crop:", out.length);
}

main().catch((e) => { console.error(e); process.exit(1); });
