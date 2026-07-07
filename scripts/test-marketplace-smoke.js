const { getMarketplace } = require("../lib/marketplace/registry");
const { normalizeCatalogProduct, expandVariantRows } = require("../lib/marketplace/product-normalizer");
const { readCsvRows, readWorkbook, sheetToRows } = require("../lib/marketplace/excel-io");

const sampleProduct = {
  productId: "1001",
  handle: "sunset-art",
  title: "Sunset Art Print",
  descriptionPlain: "Beautiful sunset painting for your wall.",
  descriptionHtml: "<p>Beautiful sunset painting</p>",
  vendor: "Paintroad",
  productType: "Painting",
  tags: ["sunset", "landscape", "modern"],
  orientation: "landscape",
  shape: "rectangle",
  variants: [
    {
      sku: "1001-M-canvas",
      size: 'M - 16"x20"',
      material: "Canvas",
      exportFrame: "black-frame",
      price: 2499,
      compareAtPrice: 2999,
      inventoryQty: 10,
      barcode: "",
    },
  ],
  metafields: {
    theme: ["Modern Art"],
    color: ["Orange"],
    artworkFrameMaterial: ["wood"],
    frameStyle: ["black-frame"],
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
  const dataRow = built[adapter.inspect(sampleRows).dataStartRow - 1];
  const nonEmpty = dataRow.filter((value) => value !== "" && value != null).length;
  console.log(`${id}: ${nonEmpty} populated cells in export row`);
}
