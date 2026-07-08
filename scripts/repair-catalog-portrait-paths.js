/**
 * Repair stale portrait paths in catalog store (SEO-renamed paths that don't exist on disk).
 *
 * Usage: node scripts/repair-catalog-portrait-paths.js
 */
const fs = require("fs");
const path = require("path");
const {
  loadCatalogStore,
  saveCatalogStore,
  findCanonicalPortraitPath,
  syncSourceImage,
} = require("../lib/catalog-products-store");

function repairProduct(product) {
  const portrait = product.images?.find((img) => img.index === 0);
  const storedPath = portrait?.path || product.sourceImage?.path;
  if (storedPath && fs.existsSync(storedPath)) {
    return false;
  }

  const canonical = findCanonicalPortraitPath(product);
  if (!canonical) {
    return false;
  }

  const filename = path.basename(canonical);
  const hadLifestyleAlt =
    portrait?.alt &&
    (/\bfor\s+\w+/i.test(portrait.alt) || portrait.alt.includes("… for "));

  if (portrait) {
    portrait.path = canonical;
    portrait.filename = filename;
    if (hadLifestyleAlt) {
      portrait.alt = "";
    }
  } else {
    product.images = [{ index: 0, filename, path: canonical, alt: "" }];
  }

  syncSourceImage(product);
  return true;
}

function main() {
  const store = loadCatalogStore();
  let repaired = 0;
  let stillMissing = 0;

  for (const product of Object.values(store.products || {})) {
    const portrait = product.images?.find((img) => img.index === 0);
    const storedPath = portrait?.path || product.sourceImage?.path;
    if (storedPath && fs.existsSync(storedPath)) {
      continue;
    }
    if (repairProduct(product)) {
      repaired += 1;
    } else {
      stillMissing += 1;
    }
  }

  saveCatalogStore(store);
  console.log("Portrait path repair complete:", { repaired, stillMissing });
}

main();
