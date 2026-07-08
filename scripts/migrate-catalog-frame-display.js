/**
 * Backfill Title Case exportFrame + frameStyle on all catalog products.
 * Usage: node scripts/migrate-catalog-frame-display.js
 */
const {
  loadCatalogStore,
  saveCatalogStore,
} = require("../lib/catalog-products-store");
const {
  applyProductDefaults,
  refreshProductVariants,
  frameDisplayLabel,
  normalizeFrame,
} = require("../lib/catalog-variant-templates");

function main() {
  const store = loadCatalogStore();
  let products = 0;
  let variants = 0;

  for (const product of Object.values(store.products || {})) {
    applyProductDefaults(product);
    if (Array.isArray(product.metafields?.frameStyle)) {
      product.metafields.frameStyle = product.metafields.frameStyle.map((value) =>
        frameDisplayLabel(value)
      );
    }
    if (product.variants?.length) {
      for (const variant of product.variants) {
        const key = normalizeFrame(variant.frame || variant.exportFrame);
        variant.frame = key;
        variant.exportFrame = frameDisplayLabel(key);
        variants += 1;
      }
      refreshProductVariants(product);
    }
    products += 1;
  }

  saveCatalogStore(store);
  console.log("Frame display migration complete:", { products, variants });
}

main();
