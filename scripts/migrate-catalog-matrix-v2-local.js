/**
 * Rebuild local catalog for Fine Art Paper matrix:
 * Canvas M/L/XL × 5 frames + Fine Art Paper XS/S × 4 framed = 23 variants.
 *
 * Usage: node scripts/migrate-catalog-matrix-v2-local.js
 */
const {
  loadCatalogStore,
  saveCatalogStore,
} = require("../lib/catalog-products-store");
const {
  applyProductDefaults,
  refreshProductVariants,
  DEFAULT_METAFIELDS,
  PRODUCT_MATERIAL,
} = require("../lib/catalog-variant-templates");

function main() {
  const store = loadCatalogStore();
  let products = 0;
  let variants = 0;

  for (const product of Object.values(store.products || {})) {
    applyProductDefaults(product);
    product.metafields = product.metafields || {};
    product.metafields.material = PRODUCT_MATERIAL;
    product.metafields.frameStyle = [...DEFAULT_METAFIELDS.frameStyle];
    product.material = PRODUCT_MATERIAL;
    refreshProductVariants(product, { rebuild: true });
    variants += product.variants?.length || 0;
    products += 1;
  }

  saveCatalogStore(store);
  console.log("Local Fine Art Paper matrix rebuild complete:", {
    products,
    variants,
    variantsPerProduct: products ? Math.round(variants / products) : 0,
    materialDefault: PRODUCT_MATERIAL,
  });
}

main();
