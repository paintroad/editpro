const { joinList } = require("./product-normalizer");
const { buildColumnIndices, padRow, applyKeyedValues } = require("./excel-io");

function simplifyAmazonField(field) {
  let value = String(field || "").trim();
  if (!value) {
    return "";
  }
  value = value.replace(/\[[^\]]*\]/g, "");
  value = value.replace(/#(\d+)\./g, "#.");
  value = value.replace(/\.value$/, "");
  return value;
}

function amazonAdapter() {
  return {
    id: "amazon",
    name: "Amazon",
    format: "xlsx",
    sheetName: "Template",
    defaultSampleName: "amazon-new-product-template-wall-art.xlsm",
    defaultCurrency: "CAD",
    notes:
      "Preserves template header rows. Macros and dropdown validation are not preserved in the exported file.",
    inspect(sampleRows) {
      const fieldRow = sampleRows[4] || [];
      const labelRow = sampleRows[3] || [];
      const headers = fieldRow.map((field, index) => simplifyAmazonField(field) || String(labelRow[index] || "").trim());
      return {
        sheetName: "Template",
        fieldRowIndex: 5,
        dataStartRow: 6,
        headers,
        rawFieldRow: fieldRow,
        columnCount: fieldRow.length,
      };
    },
    mapRow({ product, variant }, ctx) {
      const imageUrls = product.imageUrls || [];
      const tags = joinList(product.tags, ", ");
      const themes = joinList(product.metafields?.theme || [], ", ");
      const colors = joinList(product.metafields?.color || [], ", ");
      const materials = joinList(product.metafields?.artworkFrameMaterial || [], ", ") || variant.material;
      const frameStyle = variant.exportFrame || variant.frame || "";
      const bullets = [
        product.descriptionPlain ? product.descriptionPlain.slice(0, 200) : product.title,
        joinList(product.tags.slice(0, 3), ", "),
        `${product.productType || "Wall Art"} - ${variant.size || ""}`.trim(),
        `Orientation: ${product.orientation || "N/A"}`,
        `Handcrafted ${product.vendor || ctx.shopName || "art"} print`,
      ].filter(Boolean);

      return {
        "contribution_sku#": variant.sku || product.handle,
        "product_type#": "WALL_ART",
        "::record_action": "Update",
        "parentage_level#": "Child",
        "child_parent_sku_relationship#.parent_sku": product.handle,
        "variation_theme#.name": "SizeName",
        "item_name#": product.title,
        "brand#": product.vendor || ctx.shopName || "",
        "amzn1.volt.ca.product_id_type": variant.barcode ? "UPC" : "",
        "amzn1.volt.ca.product_id_value": variant.barcode || "",
        "main_product_image_locator#": imageUrls[0] || "",
        "other_product_image_locator_1#": imageUrls[1] || "",
        "other_product_image_locator_2#": imageUrls[2] || "",
        "other_product_image_locator_3#": imageUrls[3] || "",
        "other_product_image_locator_4#": imageUrls[4] || "",
        "other_product_image_locator_5#": imageUrls[5] || "",
        "other_product_image_locator_6#": imageUrls[6] || "",
        "other_product_image_locator_7#": imageUrls[7] || "",
        "other_product_image_locator_8#": imageUrls[8] || "",
        "product_description#": product.descriptionPlain || product.seoDescription || product.title,
        "bullet_point#": bullets,
        "generic_keyword#": [tags, themes, colors].filter(Boolean),
        "material#": [materials, variant.material].filter(Boolean),
        "color#": [colors, joinList(product.colors || [], ", ")].filter(Boolean),
        "size#": variant.size || "",
        "item_shape#": product.shape || "",
        "orientation#": product.orientation || "",
        "theme#": [themes, joinList(product.tags.slice(0, 2), ", ")].filter(Boolean),
        "frame#.color": frameStyle,
        "frame#.material": materials || variant.material,
        "frame#.type": frameStyle,
        "is_framed#": frameStyle && frameStyle !== "stretched-canvas" ? "Yes" : "No",
        "room_type#": product.tags.slice(0, 3),
      };
    },
    buildRows(sampleRows, variantRows, ctx) {
      const meta = this.inspect(sampleRows);
      const preserved = sampleRows.slice(0, meta.dataStartRow - 1);
      const fieldRow = sampleRows[4] || [];
      const columnMap = buildColumnIndices(fieldRow, simplifyAmazonField);
      const columnCount = fieldRow.length;
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
  amazonAdapter,
  simplifyAmazonField,
};
