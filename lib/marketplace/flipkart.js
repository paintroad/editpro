const { joinList } = require("./product-normalizer");
const { buildColumnIndex, padRow, applyKeyedValues } = require("./excel-io");

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
        variant.exportFrame && variant.exportFrame !== "stretched-canvas" ? "Yes" : "No";
      const orientation = product.orientation
        ? product.orientation.charAt(0).toUpperCase() + product.orientation.slice(1)
        : "";

      return {
        "Seller SKU ID": variant.sku || `${product.handle}-${variant.size || "default"}`,
        "Group ID": product.handle || product.productId,
        "Listing Status": "Active",
        "MRP (INR)": variant.compareAtPrice || variant.price || "",
        "Your selling price (INR)": variant.price || "",
        "Fullfilment by": "Seller",
        "Procurement type": "express",
        Stock: variant.inventoryQty ?? 10,
        "Shipping provider": "FLIPKART",
        "Country Of Origin": "IN for India",
        Brand: product.vendor || ctx.shopName || "",
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
        "EAN/UPC": variant.barcode || "",
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
