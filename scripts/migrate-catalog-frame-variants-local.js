/**
 * Rebuild local catalog product variants for new frame matrix
 * (Wooden Finish, Dark Wood Finish, Stretched Canvas + M+ surcharge).
 *
 * Usage: node scripts/migrate-catalog-frame-variants-local.js
 */
const {
  loadCatalogStore,
  saveCatalogStore,
} = require("../lib/catalog-products-store");
const {
  applyProductDefaults,
  refreshProductVariants,
  DEFAULT_METAFIELDS,
} = require("../lib/catalog-variant-templates");

function main() {
  const store = loadCatalogStore();
  let products = 0;
  let variants = 0;

  for (const product of Object.values(store.products || {})) {
    applyProductDefaults(product);
    product.metafields = product.metafields || {};
    product.metafields.frameStyle = [...DEFAULT_METAFIELDS.frameStyle];
    refreshProductVariants(product, { rebuild: true });
    variants += product.variants?.length || 0;
    products += 1;
  }

  saveCatalogStore(store);
  console.log("Local catalog frame variant rebuild complete:", {
    products,
    variants,
    variantsPerProduct: products ? Math.round(variants / products) : 0,
  });
}

main();
