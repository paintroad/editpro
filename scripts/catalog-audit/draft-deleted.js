/**
 * Move every painting marked "delete" in the crop review to DRAFT on Shopify.
 *
 * Reads ~/.editpro/pipeline-prep/crop-review.json and live-products.json, re-checks each product's
 * current status on Shopify and only changes ACTIVE ones. Writes a log to
 * ~/.editpro/pipeline-prep/draft-deleted-log.json and updates the live-products.json snapshot.
 *
 * Run: node editpro/scripts/catalog-audit/draft-deleted.js [--dry]
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { shopifyGraphql } = require("../../lib/shopify-client");
const { getShopifyCredentials } = require("../../lib/config-store");

const PREP = path.join(os.homedir(), ".editpro", "pipeline-prep");
const DRY = process.argv.includes("--dry");
const CONCURRENCY = 3;

const STATUS_QUERY = `query Status($ids: [ID!]!) { nodes(ids: $ids) { ... on Product { id status title } } }`;
const DRAFT_MUTATION = `mutation Draft($product: ProductUpdateInput!) {
  productUpdate(product: $product) { product { id status } userErrors { field message } }
}`;

const read = (f) => JSON.parse(fs.readFileSync(path.join(PREP, f), "utf8"));

async function run() {
  const { storeDomain, accessToken } = getShopifyCredentials();
  if (!storeDomain || !accessToken) throw new Error("Shopify is not connected.");

  const crop = read("crop-review.json");
  const live = read("live-products.json");
  const stem = (k) => path.basename(k).replace(/\.[^.]+$/, "");
  const marked = new Set(Object.entries(crop).filter(([, v]) => v.status === "delete").map(([k]) => stem(k)));
  const targets = live.filter((p) => marked.has(String(p.number)));
  console.log(`Marked delete: ${marked.size}. On Shopify: ${targets.length}.`);

  const current = {};
  for (let i = 0; i < targets.length; i += 100) {
    const data = await shopifyGraphql(storeDomain, accessToken, STATUS_QUERY, { ids: targets.slice(i, i + 100).map((p) => p.id) });
    for (const n of data.nodes || []) if (n) current[n.id] = n.status;
  }
  const active = targets.filter((p) => current[p.id] === "ACTIVE");
  console.log(`Currently ACTIVE: ${active.length}. Already not active: ${targets.length - active.length}.`);
  if (DRY) return;

  const log = [];
  const queue = [...active];
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length) {
      const p = queue.shift();
      try {
        const data = await shopifyGraphql(storeDomain, accessToken, DRAFT_MUTATION, { product: { id: p.id, status: "DRAFT" } });
        const errs = data.productUpdate?.userErrors || [];
        if (errs.length) throw new Error(errs.map((e) => e.message).join("; "));
        p.status = data.productUpdate.product.status;
        log.push({ number: p.number, id: p.id, from: "ACTIVE", to: p.status });
      } catch (e) {
        log.push({ number: p.number, id: p.id, error: e.message });
        console.error(`FAIL ${p.number}: ${e.message}`);
      }
    }
  }));

  fs.writeFileSync(path.join(PREP, "draft-deleted-log.json"), JSON.stringify({ at: new Date().toISOString(), log }, null, 1));
  fs.writeFileSync(path.join(PREP, "live-products.json"), JSON.stringify(live, null, 1));
  const ok = log.filter((l) => !l.error).length;
  console.log(`Drafted ${ok}. Failed ${log.length - ok}.`);
}

run().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
