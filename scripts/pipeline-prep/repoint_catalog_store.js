// Point catalog-store image and printable paths at the merged catalog folders, using the index
// written by mirror_printables.py. Usage: node scripts/pipeline-prep/repoint_catalog_store.js
const fs = require("fs");
const os = require("os");
const path = require("path");
const { loadCatalogStore, saveCatalogStore } = require("../../lib/catalog-products-store");

const INDEX = path.join(os.homedir(), ".editpro", "pipeline-prep", "catalog-file-index.json");
const OLD = ["_New Catalog Optimised", "_New Catalog Printable Files", "_New Catalog\\Output"];
const isOld = (p) => OLD.some((o) => String(p || "").includes(o));

const index = JSON.parse(fs.readFileSync(INDEX, "utf8"));
const store = loadCatalogStore();
let products = 0;
const missing = [];
for (const [id, p] of Object.entries(store.products)) {
  const uses = isOld(p.folderPath) || isOld(p.printableFile) || (p.images || []).some((img) => isOld(img.path));
  if (!uses) continue;
  const opt = index.optimised[id];
  const prt = index.printable[id];
  if (!opt || !prt) {
    missing.push(id);
    continue;
  }
  for (const img of p.images || []) {
    if (isOld(img.path)) {
      img.path = opt;
      img.filename = path.basename(opt);
    }
  }
  if (p.sourceImage && isOld(p.sourceImage.path)) {
    p.sourceImage.path = opt;
    p.sourceImage.filename = path.basename(opt);
  }
  p.folderPath = path.dirname(opt);
  p.printableFile = prt;
  products += 1;
}
saveCatalogStore(store);
console.log("products repointed:", products, "| not found in index:", missing);
