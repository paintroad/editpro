#!/usr/bin/env node
/**
 * One-time sync: fetch live Shopify products and build local ID → handle mapping.
 *
 * Usage:
 *   node scripts/sync-shopify-product-index.js
 */

const { syncShopifyProductIndex } = require("../lib/shopify-live-product-index");

async function main() {
  console.log("Syncing Shopify product index from live store…");
  const result = await syncShopifyProductIndex();
  console.log("");
  console.log(`Store: ${result.storeDomain}`);
  console.log(`Synced at: ${result.syncedAt}`);
  console.log(`Shopify products scanned: ${result.shopifyProductsScanned}`);
  console.log(`Unique product IDs mapped: ${result.uniqueProductIds}`);
  console.log(`Catalog entries merged: ${result.catalogEntriesMerged}`);
  console.log(`Saved to: ${result.storePath}`);
}

main().catch((error) => {
  console.error(`Error: ${error.message || error}`);
  process.exit(1);
});
