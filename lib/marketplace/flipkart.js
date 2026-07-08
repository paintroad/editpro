const { joinList } = require("./product-normalizer");
const { buildColumnIndex, padRow, applyKeyedValues } = require("./excel-io");
const { resolveMarketplaceGtin } = require("./gtin-utils");
const {
  BRAND,
  HSN_ARTWORK,
  FLIPKART_TAX_CODE,
  DEFAULT_STOCK,
  DEFAULT_WEIGHT_KG,
  PARTY_DETAILS_LINE,
  FLIPKART_SHIPPING_PROVIDER,
  FLIPKART_PROCUREMENT_TYPE,
  FLIPKART_PROCUREMENT_SLA,
  FLIPKART_HANDLING_FEES,
} = require("./marketplace-config");
const { normalizeFrame } = require("../catalog-variant-templates");

function flipkartAdapter() {
  return {
    id: "flipkart",
    name: "Flipkart",
    format: "xls",
    sheetName: "painting",
    defaultSampleName: "flipkart-new-product-template-paintings.xls",
    defaultCurrency: "INR",
    notes:
      "Preserves Flipkart header rows. Dropdown validation sheets are not preserved in the exported file.",
    inspect(sampleRows) {
      const headers = (sampleRows[0] || []).map((h) => String(h || "").trim());
      return {
        sheetName: "painting",
        dataStartRow: 3,
        headers,
        columnCount: headers.length,
      };
    },
    mapRow({ product, variant }, ctx) {
      const imageUrls = product.imageUrls || [];
      const width = variant.widthInch;
      const height = variant.heightInch;
      const frameIncluded =
        variant.exportFrame &&
        normalizeFrame(variant.exportFrame || variant.frame) !== "stretched-canvas"
          ? "Yes"
          : "No";
      const orientation = product.orientation
        ? product.orientation.charAt(0).toUpperCase() + product.orientation.slice(1)
        : "";
      const dims = variant.packageDims;
      const weightKg = variant.weightKg != null ? variant.weightKg : DEFAULT_WEIGHT_KG;
      const gtin = resolveMarketplaceGtin({ barcode: variant.barcode, sku: variant.sku });

      return {
        "Seller SKU ID": variant.sku || `${product.handle}-${variant.size || "default"}`,
        "Group ID": product.handle || product.productId,
        "Listing Status": "Active",
        "MRP (INR)": variant.compareAtPrice || variant.price || "",
        "Your selling price (INR)": variant.price || "",
        "Fullfilment by": "Seller",
        "Procurement type": FLIPKART_PROCUREMENT_TYPE,
        "Procurement SLA (DAY)": FLIPKART_PROCUREMENT_SLA,
        Stock: DEFAULT_STOCK,
        "Shipping provider": FLIPKART_SHIPPING_PROVIDER,
        "Local handling fee (INR)": FLIPKART_HANDLING_FEES.local,
        "Zonal handling fee (INR)": FLIPKART_HANDLING_FEES.zonal,
        "National handling fee (INR)": FLIPKART_HANDLING_FEES.national,
        "Length (CM)": dims ? dims.length : "",
        "Breadth (CM)": dims ? dims.breadth : "",
        "Height (CM)": dims ? dims.height : "",
        "Weight (KG)": weightKg,
        "Weight (kg)": weightKg,
        HSN: HSN_ARTWORK,
        "Tax Code": FLIPKART_TAX_CODE,
        "Minimum Order Quantity (MinOQ)": 1,
        "Manufacturer Details": PARTY_DETAILS_LINE,
        "Packer Details": PARTY_DETAILS_LINE,
        "Importer Details": PARTY_DETAILS_LINE,
        "Country Of Origin": "IN for India",
        Brand: BRAND,
        "Painting Type": product.productType || "Oil Painting",
        "Painting Theme": joinList(product.metafields?.theme || product.tags.slice(0, 2), ", ") || "Modern Art",
        "Pack of": 1,
        "Panel View": "Single",
        "Model Number": product.productId,
        "Width (inch)": width != null ? width : "",
        "Height (inch)": height != null ? height : "",
        "Frame Color": variant.exportFrame || variant.frame || "",
        "Frame Included": frameIncluded,
        "Art Form Type": product.productType || "Painting",
        "Ideal Location": joinList(product.tags.slice(0, 3), ", "),
        "Orientation Type": orientation,
        "Multi Pieces": "No",
        "Main Image URL": imageUrls[0] || "",
        "Other Image URL 1": imageUrls[1] || "",
        "Other Image URL 2": imageUrls[2] || "",
        "Other Image URL 3": imageUrls[3] || "",
        "Model Name": product.title,
        Description: product.descriptionPlain || product.seoDescription || product.title,
        "Key Features": joinList(
          [product.seoTitle, joinList(product.tags.slice(0, 5), ", "), variant.material, variant.size].filter(
            Boolean
          ),
          " | "
        ),
        "Search Keywords": joinList(product.tags, ", "),
        "Frame Material": joinList(product.metafields?.artworkFrameMaterial || [], ", ") || variant.material,
        Shape: product.shape || "",
        Size: variant.size || "",
        "EAN/UPC": gtin.value13,
        "Is Fragile": "Yes",
      };
    },
    buildRows(sampleRows, variantRows, ctx) {
      const meta = this.inspect(sampleRows);
      const headers = meta.headers;
      const preserved = sampleRows.slice(0, meta.dataStartRow - 1);
      const columnMap = buildColumnIndex(headers);
      const columnCount = headers.length;
      const output = preserved.map((row) => padRow(row, columnCount));

      for (const entry of variantRows) {
        const mapped = this.mapRow(entry, ctx);
        const row = new Array(columnCount);
        applyKeyedValues(row, columnMap, mapped);
        output.push(row);
      }

      return output;
    },
  };
}

module.exports = {
  flipkartAdapter,
};
