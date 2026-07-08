const { joinList } = require("./product-normalizer");
const {
  BRAND,
  PINTEREST_GENDER,
  PINTEREST_AGE_GROUP,
  PINTEREST_SHIPPING,
  toStoreDomainImageUrl,
} = require("./marketplace-config");

function productLink(product, ctx) {
  const domain = String(ctx.primaryDomainHost || ctx.storeDomain || "")
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
  const handle = product.handle || product.productId;
  if (!domain || !handle) {
    return "";
  }
  return `https://${domain}/products/${handle}`;
}

function pinterestAdapter() {
  return {
    id: "pinterest",
    name: "Pinterest",
    format: "csv",
    defaultSampleName: "pinterest_product_sample_csv_feed.csv",
    defaultCurrency: "USD",
    notes: "Exports a Pinterest product CSV feed.",
    inspect(sampleRows) {
      const headers = (sampleRows[0] || []).map((h) => String(h || "").trim());
      return {
        sheetName: null,
        headers,
        dataStartRow: 2,
        columnCount: headers.length,
      };
    },
    mapRow({ product, variant }, ctx) {
      const currency = ctx.currencyCode || "USD";
      const sellingPrice = variant.price != null ? Number(variant.price) : null;
      const comparePrice = variant.compareAtPrice != null ? Number(variant.compareAtPrice) : null;

      let regularPrice = sellingPrice;
      let discountedPrice = null;
      if (comparePrice != null && sellingPrice != null && comparePrice > sellingPrice) {
        regularPrice = comparePrice;
        discountedPrice = sellingPrice;
      }

      const price = regularPrice != null ? regularPrice.toFixed(2) : "";
      const salePrice = discountedPrice != null ? discountedPrice.toFixed(2) : "";
      const link = productLink(product, ctx);
      const host = ctx.primaryDomainHost || ctx.storeDomain || "";
      const imageUrls = product.imageUrls || [];

      return {
        id: variant.sku || `${product.handle}-${variant.size || "default"}`,
        item_group_id: product.handle || product.productId,
        title: product.title,
        description: product.descriptionPlain || product.seoDescription || "",
        link,
        image_link: toStoreDomainImageUrl(imageUrls[0] || "", host),
        price: price ? `${price} ${currency}` : "",
        availability: "in stock",
        condition: "new",
        google_product_category: "Home & Garden > Decor > Artwork",
        product_type: product.productType || joinList(product.tags, " > ") || "Painting",
        additional_image_link: toStoreDomainImageUrl(imageUrls[1] || "", host),
        sale_price: salePrice ? `${salePrice} ${currency}` : "",
        brand: BRAND,
        gender: PINTEREST_GENDER,
        age_group: PINTEREST_AGE_GROUP,
        size: variant.size || "",
        size_type: "regular",
        shipping: PINTEREST_SHIPPING,
        custom_label_0: product.productType || "",
        adwords_redirect: link,
      };
    },
    buildRows(sampleRows, variantRows, ctx) {
      const meta = this.inspect(sampleRows);
      const headers = meta.headers;
      const output = [headers];
      const idCounts = new Map();
      for (const entry of variantRows) {
        const mapped = this.mapRow(entry, ctx);
        if (mapped.id) {
          const seen = idCounts.get(mapped.id) || 0;
          idCounts.set(mapped.id, seen + 1);
          if (seen > 0) {
            mapped.id = `${mapped.id}-${seen + 1}`;
          }
        }
        output.push(headers.map((header) => mapped[header] ?? ""));
      }
      return output;
    },
  };
}

module.exports = {
  pinterestAdapter,
};
