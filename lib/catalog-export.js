function escapeCsv(value) {
  const text = value == null ? "" : String(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function joinList(values, sep = "; ") {
  if (!Array.isArray(values)) {
    return "";
  }
  return values.map((v) => String(v || "").trim()).filter(Boolean).join(sep);
}

function buildExportRows(products) {
  const rows = [];
  const headers = [
    "Handle",
    "Title",
    "Body (HTML)",
    "Vendor",
    "Product Category",
    "Type",
    "Tags",
    "Published",
    "Option1 Name",
    "Option1 Value",
    "Option2 Name",
    "Option2 Value",
    "Option3 Name",
    "Option3 Value",
    "Variant SKU",
    "Variant Inventory Qty",
    "Variant Inventory Policy",
    "Variant Fulfillment Service",
    "Variant Price",
    "Variant Compare At Price",
    "Variant Requires Shipping",
    "Variant Taxable",
    "Variant Weight Unit",
    "Cost per item",
    "SEO Title",
    "SEO Description",
    "Artwork frame material (product.metafields.shopify.artwork-frame-material)",
    "Color (product.metafields.shopify.color-pattern)",
    "Frame style (product.metafields.shopify.frame-style)",
    "Theme (product.metafields.shopify.theme)",
    "Search product boosts (product.metafields.shopify--discovery--product_search_boost.queries)",
    "Status",
  ];

  rows.push(headers);

  for (const product of products) {
    if (product.status !== "enriched" || !product.variants?.length) {
      continue;
    }

    const tags = joinList(product.tags, ", ");
    const colorMf = joinList(product.metafields?.color, "; ");
    const themeMf = joinList(product.metafields?.theme, "; ");
    const frameMaterialMf = joinList(product.metafields?.artworkFrameMaterial, "; ");
    const frameStyleMf = joinList(product.metafields?.frameStyle, "; ");
    const searchBoosts = product.metafields?.searchProductBoosts || "";

    product.variants.forEach((variant, variantIndex) => {
      const isFirst = variantIndex === 0;
      rows.push([
        product.handle,
        isFirst ? product.title : "",
        isFirst ? product.descriptionHtml : "",
        isFirst ? product.vendor : "",
        isFirst ? product.productCategory : "",
        isFirst ? product.productType : "",
        isFirst ? tags : "",
        isFirst ? "true" : "",
        isFirst ? "Size" : "",
        variant.size,
        variant.material ? "Material" : "",
        variant.material,
        variant.exportFrame ? "Frame" : "",
        variant.exportFrame,
        variant.sku,
        variant.inventoryQty,
        variant.inventoryPolicy,
        variant.fulfillmentService,
        variant.price,
        variant.compareAtPrice,
        variant.requiresShipping ? "true" : "false",
        variant.taxable ? "true" : "false",
        variant.weightUnit,
        variant.cost,
        isFirst ? product.seoTitle : "",
        isFirst ? product.seoDescription : "",
        isFirst ? frameMaterialMf : "",
        isFirst ? colorMf : "",
        isFirst ? frameStyleMf : "",
        isFirst ? themeMf : "",
        isFirst ? searchBoosts : "",
        isFirst ? "active" : "",
      ]);
    });
  }

  return rows;
}

function productsToCsv(products) {
  const rows = buildExportRows(products);
  return rows.map((row) => row.map(escapeCsv).join(",")).join("\r\n");
}

module.exports = {
  buildExportRows,
  productsToCsv,
};
