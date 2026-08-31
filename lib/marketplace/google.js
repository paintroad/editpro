const { joinList } = require("./product-normalizer");
const {
  BRAND,
  PINTEREST_GENDER,
  PINTEREST_AGE_GROUP,
  PINTEREST_SHIPPING,
  toStoreDomainImageUrl,
} = require("./marketplace-config");

const GOOGLE_PRODUCT_CATEGORY = "Home & Garden > Decor > Artwork";

const GOOGLE_HEADERS = [
  "id",
  "title",
  "description",
  "link",
  "image_link",
  "additional_image_link",
  "availability",
  "price",
  "sale_price",
  "brand",
  "condition",
  "item_group_id",
  "google_product_category",
  "product_type",
  "identifier_exists",
  "gtin",
  "mpn",
  "size",
  "color",
  "material",
  "shipping",
  "gender",
  "age_group",
];

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

function formatMoney(amount, currency) {
  if (amount == null || Number.isNaN(Number(amount))) {
    return "";
  }
  return `${Number(amount).toFixed(2)} ${currency}`;
}

function googleColor(product, variant) {
  const metafieldColors = joinList(product.metafields?.color || product.colors || [], ", ");
  if (metafieldColors) {
    return metafieldColors.split(/[,;]/)[0].trim().slice(0, 100);
  }
  const frame = String(variant.exportFrame || variant.frame || "").trim();
  return frame.slice(0, 100);
}

function googleAdapter() {
  return {
    id: "google",
    name: "Google Shopping",
    format: "csv",
    defaultSampleName: null,
    defaultHeaders: GOOGLE_HEADERS,
    defaultCurrency: "INR",
    notes:
      "Exports a Google Merchant Center product CSV (fixed columns). No sample template required.",
    inspect(sampleRows) {
      const headers =
        sampleRows && sampleRows[0] && sampleRows[0].length
          ? sampleRows[0].map((h) => String(h || "").trim()).filter(Boolean)
          : [...GOOGLE_HEADERS];
      return {
        sheetName: null,
        headers,
        dataStartRow: 2,
        columnCount: headers.length,
      };
    },
    mapRow({ product, variant }, ctx) {
      const currency = ctx.currencyCode || "INR";
      const sellingPrice = variant.price != null ? Number(variant.price) : null;
      const comparePrice = variant.compareAtPrice != null ? Number(variant.compareAtPrice) : null;

      let regularPrice = sellingPrice;
      let discountedPrice = null;
      if (comparePrice != null && sellingPrice != null && comparePrice > sellingPrice) {
        regularPrice = comparePrice;
        discountedPrice = sellingPrice;
      }

      const link = productLink(product, ctx);
      const host = ctx.primaryDomainHost || ctx.storeDomain || "";
      const imageUrls = product.imageUrls || [];
      const barcode = String(variant.barcode || "").replace(/\D/g, "");
      const hasGtin = barcode.length >= 8;
      const qty = variant.inventoryQty != null ? Number(variant.inventoryQty) : null;
      const availability = qty != null && qty <= 0 ? "out_of_stock" : "in_stock";

      return {
        id: variant.sku || `${product.handle}-${variant.size || "default"}`,
        title: product.title,
        description: product.descriptionPlain || product.seoDescription || product.title || "",
        link,
        image_link: toStoreDomainImageUrl(imageUrls[0] || "", host),
        additional_image_link: imageUrls
          .slice(1)
          .map((url) => toStoreDomainImageUrl(url, host))
          .filter(Boolean)
          .join(","),
        availability,
        price: formatMoney(regularPrice, currency),
        sale_price: formatMoney(discountedPrice, currency),
        brand: BRAND,
        condition: "new",
        item_group_id: product.handle || product.productId,
        google_product_category: GOOGLE_PRODUCT_CATEGORY,
        product_type: product.productType || "Painting",
        identifier_exists: hasGtin ? "yes" : "no",
        gtin: hasGtin ? barcode : "",
        mpn: hasGtin ? "" : variant.sku || product.handle || "",
        size: variant.size || "",
        color: googleColor(product, variant),
        material: variant.material || "",
        shipping: PINTEREST_SHIPPING,
        gender: PINTEREST_GENDER,
        age_group: PINTEREST_AGE_GROUP,
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
  googleAdapter,
  GOOGLE_HEADERS,
};
