function stripHtml(html) {
  if (!html) {
    return "";
  }
  return String(html)
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function joinList(values, sep = ", ") {
  if (!Array.isArray(values)) {
    return "";
  }
  return values.map((v) => String(v || "").trim()).filter(Boolean).join(sep);
}

function parseSizeDimensions(sizeText) {
  const text = String(sizeText || "");
  const match = text.match(/(\d+(?:\.\d+)?)\s*["']?\s*x\s*(\d+(?:\.\d+)?)/i);
  if (!match) {
    return { widthInch: null, heightInch: null };
  }
  return {
    widthInch: parseFloat(match[1]),
    heightInch: parseFloat(match[2]),
  };
}

function optionValue(selectedOptions, name) {
  if (!Array.isArray(selectedOptions)) {
    return "";
  }
  const target = String(name || "").toLowerCase();
  const hit = selectedOptions.find((opt) => String(opt?.name || "").toLowerCase() === target);
  return hit?.value || "";
}

function normalizeVariant(raw, defaults = {}) {
  const size = raw.size || optionValue(raw.selectedOptions, "Size") || "";
  const material = raw.material || optionValue(raw.selectedOptions, "Material") || "";
  const frame = raw.frame || raw.exportFrame || optionValue(raw.selectedOptions, "Frame") || "";
  const dims = parseSizeDimensions(size);

  return {
    sku: String(raw.sku || "").trim(),
    barcode: String(raw.barcode || "").trim(),
    price: raw.price != null && raw.price !== "" ? Number(raw.price) : null,
    compareAtPrice:
      raw.compareAtPrice != null && raw.compareAtPrice !== ""
        ? Number(raw.compareAtPrice)
        : null,
    inventoryQty:
      raw.inventoryQty != null && raw.inventoryQty !== ""
        ? Number(raw.inventoryQty)
        : raw.inventoryQuantity != null
          ? Number(raw.inventoryQuantity)
          : defaults.inventoryQty ?? 10,
    size,
    material,
    frame,
    exportFrame: raw.exportFrame || frame,
    widthInch: dims.widthInch,
    heightInch: dims.heightInch,
    weightUnit: raw.weightUnit || "",
    cost: raw.cost != null ? Number(raw.cost) : null,
  };
}

function normalizeShopifyProduct(product, ctx = {}) {
  const imageUrls = (product.media?.nodes || [])
    .map((node) => node?.image?.url || "")
    .filter(Boolean);

  const variants = (product.variants?.nodes || []).map((variant) =>
    normalizeVariant(variant, { inventoryQty: variant.inventoryQuantity ?? 10 })
  );

  if (!variants.length) {
    variants.push(
      normalizeVariant({
        sku: product.handle || product.id,
        price: null,
        inventoryQty: 10,
      })
    );
  }

  return {
    source: "shopify",
    productId: product.id,
    handle: product.handle || "",
    title: product.title || "",
    descriptionHtml: product.descriptionHtml || "",
    descriptionPlain: stripHtml(product.descriptionHtml || product.description || ""),
    vendor: product.vendor || ctx.shopName || "",
    productType: product.productType || "",
    tags: Array.isArray(product.tags) ? product.tags : [],
    imageUrls,
    variants,
    orientation: product.orientation || "",
    shape: product.shape || "",
    metafields: product.metafields || {},
    seoTitle: product.seo?.title || "",
    seoDescription: product.seo?.description || "",
    shopifyProductId: product.id,
  };
}

function normalizeCatalogProduct(product, ctx = {}) {
  const imageUrls = [];
  const variants = (product.variants || []).map((variant) => normalizeVariant(variant));

  if (!variants.length) {
    variants.push(
      normalizeVariant({
        sku: product.productId,
        price: null,
        inventoryQty: 10,
      })
    );
  }

  const colors = joinList(product.colors || product.metafields?.color || [], "; ");
  const themes = joinList(product.metafields?.theme || [], "; ");
  const frameMaterials = joinList(product.metafields?.artworkFrameMaterial || [], "; ");
  const frameStyles = joinList(product.metafields?.frameStyle || [], "; ");

  return {
    source: "catalog",
    productId: product.productId,
    handle: product.handle || product.productId,
    title: product.title || `Artwork ${product.productId}`,
    descriptionHtml: product.descriptionHtml || "",
    descriptionPlain:
      product.descriptionPlain || stripHtml(product.descriptionHtml || product.description160 || ""),
    vendor: product.vendor || ctx.shopName || "",
    productType: product.productType || "Painting",
    tags: Array.isArray(product.tags) ? product.tags : [],
    imageUrls,
    variants,
    orientation: product.orientation || "",
    shape: product.shape || "",
    metafields: {
      color: product.metafields?.color || product.colors || [],
      theme: product.metafields?.theme || [],
      artworkFrameMaterial: product.metafields?.artworkFrameMaterial || [],
      frameStyle: product.metafields?.frameStyle || [],
      colorsText: colors,
      themesText: themes,
      frameMaterialsText: frameMaterials,
      frameStylesText: frameStyles,
    },
    seoTitle: product.seoTitle || "",
    seoDescription: product.seoDescription || "",
    shopifyProductId: product.shopifyProductId || null,
    status: product.status || "imported",
  };
}

function normalizeProducts(rawProducts, source, ctx = {}) {
  if (source === "shopify") {
    return rawProducts.map((product) => normalizeShopifyProduct(product, ctx));
  }
  return rawProducts.map((product) => normalizeCatalogProduct(product, ctx));
}

function expandVariantRows(products) {
  const rows = [];
  for (const product of products) {
    for (const variant of product.variants || []) {
      rows.push({ product, variant });
    }
  }
  return rows;
}

module.exports = {
  stripHtml,
  joinList,
  parseSizeDimensions,
  normalizeShopifyProduct,
  normalizeCatalogProduct,
  normalizeProducts,
  expandVariantRows,
};
