const { getMarketplace } = require("../lib/marketplace/registry");
const { normalizeCatalogProduct, expandVariantRows } = require("../lib/marketplace/product-normalizer");
const { readCsvRows, readWorkbook, sheetToRows } = require("../lib/marketplace/excel-io");
const { resolveMarketplaceGtin } = require("../lib/marketplace/gtin-utils");
const { AMAZON_BRAND, BRAND } = require("../lib/marketplace/marketplace-config");
const { simplifyAmazonField } = require("../lib/marketplace/amazon");

const sampleProduct = {
  productId: "10001",
  handle: "soulful-serenity",
  title: "Soulful Serenity",
  descriptionPlain: "Beautiful painting for your wall.",
  descriptionHtml: "<p>Beautiful painting</p>",
  vendor: "Paintroad",
  productType: "Painting",
  tags: ["serenity", "landscape", "modern"],
  orientation: "square",
  shape: "square",
  variants: [
    {
      sku: "10001-XS-1",
      size: 'XS - 10"x10"',
      material: "Fine Art Paper",
      exportFrame: "black",
      price: 699,
      compareAtPrice: 1299,
      inventoryQty: 10,
      barcode: "",
    },
  ],
  metafields: {
    theme: ["Modern Art"],
    color: ["Blue"],
    artworkFrameMaterial: ["plastic"],
    frameStyle: ["Black"],
  },
  status: "enriched",
};

const product = normalizeCatalogProduct(sampleProduct, {
  shopName: "Paintroad",
  currencyCode: "INR",
});
const variantRows = expandVariantRows([product]);
const ctx = {
  storeDomain: "example.myshopify.com",
  shopName: "Paintroad",
  currencyCode: "INR",
};

const paths = {
  pinterest: "C:/Users/divya/Downloads/Marketplace/Templates/pinterest_product_sample_csv_feed.csv",
  flipkart: "C:/Users/divya/Downloads/Marketplace/Templates/flipkart-new-product-template-paintings.xls",
  amazon: "C:/Users/divya/Downloads/Marketplace/Templates/amazon-new-product-template-wall-art.xlsm",
};

const expectedGtin = resolveMarketplaceGtin({
  barcode: sampleProduct.variants[0].barcode,
  sku: sampleProduct.variants[0].sku,
});

let failed = 0;

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    failed++;
    return;
  }
  console.log(`ok: ${message}`);
}

function amazonRowValue(row, fieldRow, key) {
  const columnMap = {};
  fieldRow.forEach((field, index) => {
    const simplified = simplifyAmazonField(field);
    if (simplified) {
      columnMap[simplified] = index;
    }
  });
  return row[columnMap[key]];
}

for (const id of ["pinterest", "flipkart", "amazon"]) {
  const adapter = getMarketplace(id);
  let sampleRows;
  if (id === "pinterest") {
    sampleRows = readCsvRows(paths[id]);
  } else {
    const workbook = readWorkbook(paths[id]);
    sampleRows = sheetToRows(workbook, adapter.sheetName).rows;
  }
  const built = adapter.buildRows(sampleRows, variantRows, ctx);
  const meta = adapter.inspect(sampleRows);
  const dataRow = built[meta.dataStartRow - 1];
  const nonEmpty = dataRow.filter((value) => value !== "" && value != null).length;
  console.log(`${id}: ${nonEmpty} populated cells in first data row`);

  if (id === "amazon") {
    const fieldRow = sampleRows[4] || [];
    const parentRow = built[meta.dataStartRow - 1];
    const childRow = built[meta.dataStartRow];

    assert(
      amazonRowValue(parentRow, fieldRow, "parentage_level#") === "Parent",
      "Amazon first data row is Parent"
    );
    assert(
      amazonRowValue(parentRow, fieldRow, "contribution_sku#") === sampleProduct.handle,
      "Amazon parent SKU is product handle"
    );
    assert(
      amazonRowValue(parentRow, fieldRow, "amzn1.volt.ca.product_id_type") === "GTIN Exempt",
      "Amazon parent product id type is GTIN Exempt"
    );
    assert(
      !amazonRowValue(parentRow, fieldRow, "amzn1.volt.ca.product_id_value"),
      "Amazon parent product id is blank"
    );

    const mappedChild = adapter.mapRow(variantRows[0], ctx);
    assert(mappedChild["brand#"] === AMAZON_BRAND, `Amazon brand is ${AMAZON_BRAND}`);
    assert(
      amazonRowValue(childRow, fieldRow, "parentage_level#") === "Child",
      "Amazon second data row is Child"
    );
    assert(mappedChild["amzn1.volt.ca.product_id_type"] === "GTIN Exempt", "Amazon child product id type is GTIN Exempt");
    assert(!mappedChild["amzn1.volt.ca.product_id_value"], "Amazon child product id is blank");
  }

  if (id === "flipkart") {
    const mapped = adapter.mapRow(variantRows[0], ctx);
    assert(mapped.Brand === BRAND, `Flipkart brand is ${BRAND}`);
    assert(/^\d{13}$/.test(String(mapped["EAN/UPC"] || "")), "Flipkart EAN/UPC is 13 digits");
    assert(mapped["EAN/UPC"] === expectedGtin.value13, "Flipkart EAN/UPC matches derived GTIN");
  }
}

if (failed > 0) {
  process.exit(1);
}

console.log("marketplace smoke test passed");
