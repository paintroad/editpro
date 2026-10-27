/**
 * Refresh local catalog variant price / compareAt / cost from templates.
 * Usage: node scripts/migrate-catalog-pricing.js
 */
const {
  loadCatalogStore,
  saveCatalogStore,
} = require("../lib/catalog-products-store");
const {
  applyProductDefaults,
  refreshProductVariants,
} = require("../lib/catalog-variant-templates");

function main() {
  const store = loadCatalogStore();
  let products = 0;
  let variants = 0;
  let priceChanges = 0;

  for (const product of Object.values(store.products || {})) {
    applyProductDefaults(product);
    if (!product.variants?.length) {
      products += 1;
      continue;
    }
    const before = product.variants.map((v) => ({
      price: v.price,
      compareAtPrice: v.compareAtPrice,
      cost: v.cost,
    }));
    refreshProductVariants(product);
    for (let i = 0; i < product.variants.length; i += 1) {
      variants += 1;
      const a = before[i];
      const b = product.variants[i];
      if (
        Number(a?.price) !== Number(b.price) ||
        Number(a?.compareAtPrice) !== Number(b.compareAtPrice) ||
        Number(a?.cost) !== Number(b.cost)
      ) {
        priceChanges += 1;
      }
    }
    products += 1;
  }

  saveCatalogStore(store);
  console.log("Catalog pricing refresh complete:", {
    products,
    variants,
    priceChanges,
  });
}

main();
