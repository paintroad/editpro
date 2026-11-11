/**
 * Read-only snapshot of every Shopify product (status + painting number from the SKU) for the final check groups.
 * Writes ~/.editpro/pipeline-prep/live-products.json. Then run build_review_groups.py.
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { shopifyGraphql } = require("../../lib/shopify-client");
const { getShopifyCredentials } = require("../../lib/config-store");

const OUT = path.join(os.homedir(), ".editpro", "pipeline-prep", "live-products.json");
const query = `query ($cursor: String) {
  products(first: 100, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes { id handle title status productType variants(first: 5) { nodes { sku } } }
  }
}`;

(async () => {
  const { storeDomain, accessToken } = getShopifyCredentials();
  const out = [];
  let cursor = null;
  for (;;) {
    const data = await shopifyGraphql(storeDomain, accessToken, query, { cursor });
    for (const p of data.products.nodes) {
      const skus = p.variants.nodes.map((v) => v.sku || "");
      const m = skus.map((s) => String(s).match(/^(\d{5}[A-Za-z]?)(?=[_-]|$)/)).find(Boolean);
      out.push({ id: p.id, handle: p.handle, title: p.title, status: p.status, type: p.productType, number: m ? m[1].toUpperCase() : null });
    }
    if (!data.products.pageInfo.hasNextPage) break;
    cursor = data.products.pageInfo.endCursor;
  }
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
  console.log(`${out.length} products -> ${OUT}`);
})().catch((e) => { console.error(e.message); process.exit(1); });
