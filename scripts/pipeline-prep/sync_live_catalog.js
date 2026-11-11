/**
 * Saves which painting numbers are live (active) or draft on Shopify, for the final check page's
 * Missing section. Read-only. Run: node scripts/pipeline-prep/sync_live_catalog.js
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { shopifyGraphql } = require("../../lib/shopify-client");
const { getShopifyCredentials } = require("../../lib/config-store");

const OUT = path.join(os.homedir(), ".editpro", "pipeline-prep", "live-catalog.json");
const QUERY = `query ($cursor: String) {
  products(first: 100, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes { status variants(first: 5) { nodes { sku } } }
  }
}`;

(async () => {
  const { storeDomain, accessToken } = getShopifyCredentials();
  const active = new Set(), draft = new Set();
  let cursor = null;
  for (;;) {
    const data = await shopifyGraphql(storeDomain, accessToken, QUERY, { cursor });
    for (const p of data.products.nodes) {
      const m = p.variants.nodes.map((v) => String(v.sku || "").match(/^(\d{5}[A-Za-z]?)(?=[_-]|$)/)).find(Boolean);
      if (m) (p.status === "ACTIVE" ? active : draft).add(m[1].toUpperCase());
    }
    if (!data.products.pageInfo.hasNextPage) break;
    cursor = data.products.pageInfo.endCursor;
  }
  for (const n of active) draft.delete(n);
  fs.writeFileSync(OUT, JSON.stringify({ syncedAt: new Date().toISOString(), active: [...active].sort(), draft: [...draft].sort() }));
  console.log(`active ${active.size}, draft ${draft.size} -> ${OUT}`);
})().catch((e) => { console.error(e.message); process.exit(1); });
