#!/usr/bin/env node
/**
 * One-time sync: fetch live Shopify collections and cache tag-based rules.
 *
 * Usage:
 *   node scripts/sync-shopify-collections-index.js
 */

const { syncShopifyCollectionsIndex } = require("../lib/shopify-live-collections-index");

async function main() {
  console.log("Syncing Shopify collections index from live store…");
  const result = await syncShopifyCollectionsIndex();
  console.log("");
  console.log(`Store: ${result.storeDomain}`);
  console.log(`Synced at: ${result.syncedAt}`);
  console.log(`Collections cached: ${result.collectionCount}`);
  console.log(`Saved to: ${result.storePath}`);
}

main().catch((error) => {
  console.error(`Error: ${error.message || error}`);
  process.exit(1);
});
