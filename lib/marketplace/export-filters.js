const EXCLUDED_HANDLES = new Set([
  "gift-card",
  "personalised-custom-print-of-photos-online-at-paintroad",
]);

function productHandle(product, source) {
  if (source === "shopify") {
    return String(product.handle || "").trim().toLowerCase();
  }
  return String(product.handle || product.productId || "").trim().toLowerCase();
}

function filterProductsForExport(products, source) {
  const excluded = [];
  const kept = [];
  for (const product of products) {
    const handle = productHandle(product, source);
    if (EXCLUDED_HANDLES.has(handle)) {
      excluded.push({ handle, title: product.title || handle });
    } else {
      kept.push(product);
    }
  }
  return { products: kept, excluded };
}

function exclusionWarning(excludedProducts) {
  if (!excludedProducts.length) {
    return null;
  }
  const handles = excludedProducts.map((p) => p.handle).join(", ");
  const count = excludedProducts.length;
  const label = count === 1 ? "product" : "products";
  return `${count} ${label} excluded from export: ${handles}`;
}

module.exports = {
  EXCLUDED_HANDLES,
  filterProductsForExport,
  exclusionWarning,
};
