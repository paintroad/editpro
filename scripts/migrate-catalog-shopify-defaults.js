/**
 * Backfill catalog products with Shopify-ready defaults (vendor, exportFrame, weight, cost, etc.)
 *
 * Usage: node scripts/migrate-catalog-shopify-defaults.js
 */
const {
  loadCatalogStore,
  saveCatalogStore,
} = require("../lib/catalog-products-store");
const {
  applyProductDefaults,
  refreshProductVariants,
  normalizeFrame,
} = require("../lib/catalog-variant-templates");

function migrateStore(store) {
  let productsUpdated = 0;
  let variantsFixed = 0;
  let exportFrameFixed = 0;

  for (const product of Object.values(store.products || {})) {
    const beforeVendor = product.vendor;
    applyProductDefaults(product);

    if (product.shape && product.variants?.length) {
      for (const variant of product.variants) {
        const prevFrame = variant.exportFrame;
        variant.exportFrame = normalizeFrame(variant.exportFrame || variant.frame);
        variant.frame = normalizeFrame(variant.frame);
        if (prevFrame === "black-frame") {
          exportFrameFixed += 1;
        }
      }
      refreshProductVariants(product);
      variantsFixed += product.variants.length;
    }

    if (beforeVendor !== product.vendor || product.productCategoryId) {
      productsUpdated += 1;
    }
  }

  return { productsUpdated, variantsFixed, exportFrameFixed, total: Object.keys(store.products).length };
}

function main() {
  const store = loadCatalogStore();
  const stats = migrateStore(store);
  saveCatalogStore(store);
  console.log("Migration complete:", stats);
}

main();
