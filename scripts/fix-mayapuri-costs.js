#!/usr/bin/env node
/**
 * Mayapuri (Stretched Canvas) unit cost is ₹260 per sq ft, rounded to the rupee, for every size.
 * Finds live Stretched Canvas variants whose unit cost differs and sets it.
 *
 *   node scripts/fix-mayapuri-costs.js            show mismatches by size
 *   node scripts/fix-mayapuri-costs.js --apply    set them
 */
const { getShopifyCredentials } = require("../lib/config-store");
const { shopifyGraphql } = require("../lib/shopify-client");

const RATE_PER_SQFT = 260;

const LIST = `query($cursor: String) {
  products(first: 9, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      variants(first: 100) { nodes { id sku selectedOptions { name value } inventoryItem { unitCost { amount } } } }
    }
  }
}`;
const BULK_UPDATE = `mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
  productVariantsBulkUpdate(productId: $productId, variants: $variants) {
    userErrors { field message }
  }
}`;

function stretchedCost(sizeValue) {
  const m = String(sizeValue || "").replace(/["″]/g, "").match(/(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)/i);
  if (!m) return null;
  return Math.round((RATE_PER_SQFT * Number(m[1]) * Number(m[2])) / 144);
}

(async () => {
  const apply = process.argv.includes("--apply");
  const c = getShopifyCredentials();
  const gql = (query, variables) => shopifyGraphql(c.storeDomain, c.accessToken, query, variables);

  const bySize = {};
  let products = 0, updated = 0, failed = 0;
  for (let cursor = null; ;) {
    const page = (await gql(LIST, { cursor })).products;
    for (const p of page.nodes) {
      products++;
      const changes = [];
      for (const v of p.variants.nodes) {
        const opt = (name) => v.selectedOptions.find((o) => o.name.toLowerCase() === name)?.value || "";
        if (!/stretch/i.test(opt("frame"))) continue;
        const cost = stretchedCost(opt("size"));
        if (cost == null) continue;
        const now = v.inventoryItem?.unitCost ? Number(v.inventoryItem.unitCost.amount) : null;
        if (now === cost) continue;
        const key = `${opt("size")}: ${now} -> ${cost}`;
        bySize[key] = (bySize[key] || 0) + 1;
        changes.push({ id: v.id, inventoryItem: { cost } });
      }
      if (!apply || !changes.length) continue;
      try {
        const r = (await gql(BULK_UPDATE, { productId: p.id, variants: changes })).productVariantsBulkUpdate;
        if (r.userErrors.length) throw new Error(r.userErrors.map((e) => e.message).join("; "));
        updated += changes.length;
      } catch (e) {
        failed++;
        console.error(`${p.id} FAILED: ${e.message}`);
      }
    }
    if (products % 900 < 9) console.log(`${products} products scanned`);
    if (!page.pageInfo.hasNextPage) break;
    cursor = page.pageInfo.endCursor;
  }
  console.log(`${apply ? "APPLY" : "DRY RUN"}: ${products} products scanned`);
  for (const [k, n] of Object.entries(bySize).sort()) console.log(`  ${k}  (${n} variants)`);
  if (apply) console.log(`done: ${updated} variants updated, ${failed} products failed`);
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
