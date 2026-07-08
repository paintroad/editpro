const { joinList } = require("./product-normalizer");
const { buildColumnIndices, padRow, applyKeyedValues } = require("./excel-io");
const { resolveAmazonProductId } = require("./gtin-utils");
const {
  AMAZON_BRAND,
  MANUFACTURER,
  HSN_ARTWORK,
  DEFAULT_STOCK,
  COUNTRY_OF_ORIGIN,
  DEFAULT_ROOM,
  DEFAULT_WEIGHT_KG,
  PARTY_DETAILS_LINE,
  AMAZON_BROWSE_NODE,
  AMAZON_RECORD_ACTION,
  AMAZON_HANDLING_DAYS,
  AMAZON_PACKAGE_DIM_UNIT,
  AMAZON_PACKAGE_WEIGHT_UNIT,
  AMAZON_ITEM_TYPE_NAME,
  AMAZON_SHIPPING_TEMPLATE,
  AMAZON_UNIT_COUNT,
  AMAZON_UNIT_COUNT_TYPE,
  AMAZON_EXTERNAL_PRODUCT_ENTITY,
  AMAZON_VARIATION_THEME,
  AMAZON_PRODUCT_TAX_CODE,
} = require("./marketplace-config");

function amazonPrintMedia(variant) {
  const material = String(variant.material || "").trim();
  if (/canvas/i.test(material)) {
    return "Fabric";
  }
  if (/fine art paper/i.test(material)) {
    return "High-resolution paper";
  }
  return "High-resolution paper";
}

function amazonBaseMaterial(variant) {
  const frame = String(variant.exportFrame || variant.frame || "").toLowerCase().trim();
  if (frame.includes("stretched") || frame.includes("canvas")) {
    return "Wood";
  }
  return "Plastic";
}

function itemWeightGramsDecimal(variant) {
  const kg = variant.weightKg != null ? Number(variant.weightKg) : DEFAULT_WEIGHT_KG;
  const safeKg = !kg || Number.isNaN(kg) ? DEFAULT_WEIGHT_KG : kg;
  const grams = safeKg * 1000;
  return Math.round(grams * 100) / 100;
}

function itemWeightPounds(variant) {
  const grams = itemWeightGramsDecimal(variant);
  return Math.round((grams / 453.592) * 10000) / 10000;
}

function amazonFrameColor(frameStyle) {
  const frame = String(frameStyle || "").toLowerCase().trim();
  if (frame.includes("black")) {
    return "Black";
  }
  if (frame === "white") {
    return "White";
  }
  if (frame === "wooden") {
    return "Brown";
  }
  if (frame.includes("stretched") || frame.includes("canvas")) {
    return "Multicolor";
  }
  return "Multicolor";
}

function amazonProductColor(product, variant) {
  const metafieldColors = joinList(product.metafields?.color || product.colors || [], ", ");
  if (metafieldColors) {
    const first = metafieldColors.split(/[,;]/)[0].trim();
    const allowed = new Set([
      "Beige",
      "Black",
      "Blue",
      "Brown",
      "Gold",
      "Green",
      "Grey",
      "Multicolor",
      "Orange",
      "Pink",
      "Purple",
      "Red",
      "Silver",
      "White",
      "Yellow",
    ]);
    const titled = first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
    if (allowed.has(titled)) {
      return titled;
    }
  }
  return amazonFrameColor(variant.exportFrame || variant.frame);
}

function inchToCm(value) {
  const n = Number(value);
  if (!n || Number.isNaN(n)) {
    return "";
  }
  return Math.round(n * 2.54 * 100) / 100;
}

function packageWeightGrams(variant) {
  const kg = variant.weightKg != null ? Number(variant.weightKg) : DEFAULT_WEIGHT_KG;
  if (!kg || Number.isNaN(kg)) {
    return Math.round(DEFAULT_WEIGHT_KG * 1000);
  }
  return Math.round(kg * 1000);
}

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
        dataStartRow: 7,
        headers,
        rawFieldRow: fieldRow,
        columnCount: fieldRow.length,
      };
    },
    mapParentRow({ product }, ctx) {
      const productId = resolveAmazonProductId({ barcode: "" });

      return {
        "contribution_sku#": product.handle || product.productId,
        "product_type#": "WALL_ART",
        "::record_action": AMAZON_RECORD_ACTION,
        "parentage_level#": "Parent",
        "variation_theme#.name": AMAZON_VARIATION_THEME,
        "item_name#": product.title,
        "brand#": AMAZON_BRAND,
        "manufacturer#": MANUFACTURER,
        "country_of_origin#": COUNTRY_OF_ORIGIN,
        "condition_type#": "New",
        "recommended_browse_nodes#": AMAZON_BROWSE_NODE,
        "rtip_manufacturer_contact_information#": PARTY_DETAILS_LINE,
        "unit_count#": AMAZON_UNIT_COUNT,
        "unit_count#.type": AMAZON_UNIT_COUNT_TYPE,
        "external_product_information#.entity": AMAZON_EXTERNAL_PRODUCT_ENTITY,
        "external_product_information#": HSN_ARTWORK,
        "product_tax_code#": AMAZON_PRODUCT_TAX_CODE,
        "merchant_shipping_group#": AMAZON_SHIPPING_TEMPLATE,
        "packer_contact_information#": PARTY_DETAILS_LINE,
        "importer_contact_information#": PARTY_DETAILS_LINE,
        "amzn1.volt.ca.product_id_type": productId.type,
        "amzn1.volt.ca.product_id_value": productId.value,
        "product_description#": product.descriptionPlain || product.seoDescription || product.title,
      };
    },
    mapRow({ product, variant }, ctx) {
      const imageUrls = product.imageUrls || [];
      const tags = joinList(product.tags, ", ");
      const themes = joinList(product.metafields?.theme || [], ", ");
      const colors = joinList(product.metafields?.color || [], ", ");
      const materials = joinList(product.metafields?.artworkFrameMaterial || [], ", ") || variant.material;
      const frameStyle = variant.exportFrame || variant.frame || "";
      const frameColor = amazonFrameColor(frameStyle);
      const productColor = amazonProductColor(product, variant);
      const roomTypes =
        (ctx.roomsByHandle && ctx.roomsByHandle.get
          ? ctx.roomsByHandle.get(product.handle)
          : null) ||
        (ctx.roomByHandle && ctx.roomByHandle.get
          ? [ctx.roomByHandle.get(product.handle)]
          : null) || [DEFAULT_ROOM];
      const bullets = [
        product.descriptionPlain ? product.descriptionPlain.slice(0, 200) : product.title,
        joinList(product.tags.slice(0, 3), ", "),
        `${product.productType || "Wall Art"} - ${variant.size || ""}`.trim(),
        `Orientation: ${product.orientation || "N/A"}`,
        `Handcrafted ${product.vendor || ctx.shopName || "art"} print`,
      ].filter(Boolean);

      const dims = variant.packageDims;
      const longerEdge = Math.max(Number(variant.widthInch) || 0, Number(variant.heightInch) || 0) || null;
      const shorterEdge = Math.min(Number(variant.widthInch) || 0, Number(variant.heightInch) || 0) || null;
      const weightGramsDecimal = itemWeightGramsDecimal(variant);
      const weightPounds = itemWeightPounds(variant);
      const printMedia = amazonPrintMedia(variant);
      const baseMaterial = amazonBaseMaterial(variant);
      const productId = resolveAmazonProductId({ barcode: variant.barcode });

      return {
        "contribution_sku#": variant.sku || product.handle,
        "product_type#": "WALL_ART",
        "::record_action": AMAZON_RECORD_ACTION,
        "parentage_level#": "Child",
        "child_parent_sku_relationship#.parent_sku": product.handle,
        "variation_theme#.name": AMAZON_VARIATION_THEME,
        "item_name#": product.title,
        "brand#": AMAZON_BRAND,
        "manufacturer#": MANUFACTURER,
        "number_of_items#": AMAZON_UNIT_COUNT,
        "item_type_name#": AMAZON_ITEM_TYPE_NAME,
        "country_of_origin#": COUNTRY_OF_ORIGIN,
        "condition_type#": "New",
        "recommended_browse_nodes#": AMAZON_BROWSE_NODE,
        "rtip_manufacturer_contact_information#": PARTY_DETAILS_LINE,
        "unit_count#": AMAZON_UNIT_COUNT,
        "unit_count#.type": AMAZON_UNIT_COUNT_TYPE,
        "external_product_information#.entity": AMAZON_EXTERNAL_PRODUCT_ENTITY,
        "external_product_information#": HSN_ARTWORK,
        "product_tax_code#": AMAZON_PRODUCT_TAX_CODE,
        "merchant_shipping_group#": AMAZON_SHIPPING_TEMPLATE,
        "purchasable_offer#.our_price#.schedule#.value_with_tax":
          variant.price != null ? variant.price : "",
        "purchasable_offer#.maximum_retail_price#.schedule#.value_with_tax":
          variant.compareAtPrice != null ? variant.compareAtPrice : "",
        "fulfillment_availability#.fulfillment_channel_code": "Fulfillment by Merchant (Default)",
        "fulfillment_availability#.quantity": DEFAULT_STOCK,
        "fulfillment_availability#.lead_time_to_ship_max_days": AMAZON_HANDLING_DAYS,
        "item_package_dimensions#.length": dims ? dims.length : "",
        "item_package_dimensions#.length.unit": dims ? AMAZON_PACKAGE_DIM_UNIT : "",
        "item_package_dimensions#.width": dims ? dims.breadth : "",
        "item_package_dimensions#.width.unit": dims ? AMAZON_PACKAGE_DIM_UNIT : "",
        "item_package_dimensions#.height": dims ? dims.height : "",
        "item_package_dimensions#.height.unit": dims ? AMAZON_PACKAGE_DIM_UNIT : "",
        "item_package_weight#": weightGramsDecimal,
        "item_package_weight#.unit": AMAZON_PACKAGE_WEIGHT_UNIT,
        "item_length_width#.length": longerEdge != null ? inchToCm(longerEdge) : "",
        "item_length_width#.length.unit": longerEdge != null ? "Centimeters" : "",
        "item_length_width#.width": shorterEdge != null ? inchToCm(shorterEdge) : "",
        "item_length_width#.width.unit": shorterEdge != null ? "Centimeters" : "",
        "item_weight#": weightGramsDecimal,
        "item_weight#.unit": "Grams",
        "item_weight#.normalized_value": weightPounds,
        "item_weight#.normalized_value.unit": "pounds",
        "print_media_type#": printMedia,
        "base#.material#": baseMaterial,
        "base_material#": baseMaterial,
        "packer_contact_information#": PARTY_DETAILS_LINE,
        "importer_contact_information#": PARTY_DETAILS_LINE,
        "amzn1.volt.ca.product_id_type": productId.type,
        "amzn1.volt.ca.product_id_value": productId.value,
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
        "color#": productColor,
        "size#": variant.size || "",
        "item_shape#": product.shape || "",
        "orientation#": product.orientation || "",
        "theme#": [themes, joinList(product.tags.slice(0, 2), ", ")].filter(Boolean),
        "frame#.color#": frameColor,
        "frame#.material#": materials || variant.material,
        "frame#.type#": frameStyle,
        "is_framed#": "Yes",
        "room_type#": roomTypes,
      };
    },
    buildRows(sampleRows, variantRows, ctx) {
      const meta = this.inspect(sampleRows);
      const preserved = sampleRows.slice(0, meta.dataStartRow - 1);
      const fieldRow = sampleRows[4] || [];
      const columnMap = buildColumnIndices(fieldRow, simplifyAmazonField);
      const columnCount = fieldRow.length;
      const output = preserved.map((row) => padRow(row, columnCount));

      const groups = new Map();
      for (const entry of variantRows) {
        const key = entry.product.handle || entry.product.productId || entry.product.id;
        if (!groups.has(key)) {
          groups.set(key, { product: entry.product, entries: [] });
        }
        groups.get(key).entries.push(entry);
      }

      for (const { product, entries } of groups.values()) {
        const parentRow = new Array(columnCount);
        applyKeyedValues(parentRow, columnMap, this.mapParentRow({ product }, ctx));
        output.push(parentRow);

        for (const entry of entries) {
          const mapped = this.mapRow(entry, ctx);
          const row = new Array(columnCount);
          applyKeyedValues(row, columnMap, mapped);
          output.push(row);
        }
      }

      return output;
    },
  };
}

module.exports = {
  amazonAdapter,
  simplifyAmazonField,
};
