/**
 * One-product crack export for Flipkart + Amazon.
 * Run: node editpro/scripts/crack-one-product.js
 */
const path = require("path");
const os = require("os");
const { exportMarketplace } = require("../lib/marketplace/export-service");

const HANDLE = "soulful-serenity";
const OUTPUT_DIR = path.join(os.homedir(), "Downloads", "Marketplace", "Exports");

async function runOne(marketplaceId) {
  console.log(`\n=== Exporting ${marketplaceId} for ${HANDLE} ===`);
  const result = await exportMarketplace({
    marketplaceId,
    source: "shopify",
    shopifyProductFilter: "live",
    productHandles: [HANDLE],
    outputDir: OUTPUT_DIR,
  });
  console.log(`Products: ${result.productCount}, variants: ${result.variantCount}`);
  console.log(`Saved: ${result.savedDir}`);
  for (const part of result.parts || []) {
    console.log(`  - ${part.fileName} (${part.rowCount} data rows, ${part.sizeBytes} bytes)`);
  }
  if (result.warnings?.length) {
    console.log("Warnings:", result.warnings.join(" | "));
  }
  return result;
}

async function main() {
  const flipkart = await runOne("flipkart");
  const amazon = await runOne("amazon");
  console.log("\n--- Done ---");
  console.log("Flipkart:", flipkart.savedDir);
  console.log("Amazon:", amazon.savedDir);
}

main().catch((error) => {
  console.error("Crack export failed:", error.message);
  process.exitCode = 1;
});
