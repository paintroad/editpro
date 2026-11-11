// Read-only snapshot of every product's media (id, file name, alt, position) through a Shopify
// bulk query, for planning image replacement. Writes ~/.editpro/pipeline-prep/live-media.json.
//   node scripts/pipeline-prep/snapshot_live_media.js
const fs = require("fs");
const os = require("os");
const path = require("path");
const { getShopifyCredentials } = require("../../lib/config-store");
const { shopifyGraphql } = require("../../lib/shopify-client");

const OUT = path.join(os.homedir(), ".editpro", "pipeline-prep", "live-media.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fileOf = (url) => decodeURIComponent(url.split("?")[0].split("/").pop());

const QUERY = `{
  products {
    edges { node { id handle title status
      media { edges { node { id alt mediaContentType ... on MediaImage { image { url } } } } }
    } }
  }
}`;

(async () => {
  const c = getShopifyCredentials();
  const start = await shopifyGraphql(c.storeDomain, c.accessToken,
    `mutation($q: String!) { bulkOperationRunQuery(query: $q) { bulkOperation { id status } userErrors { message } } }`,
    { q: QUERY });
  const errs = start.bulkOperationRunQuery.userErrors;
  if (errs.length) throw new Error(errs.map((e) => e.message).join("; "));
  let op;
  for (;;) {
    await sleep(5000);
    op = (await shopifyGraphql(c.storeDomain, c.accessToken,
      `{ currentBulkOperation { id status objectCount url errorCode } }`)).currentBulkOperation;
    process.stdout.write(`\r${op.status} ${op.objectCount}   `);
    if (["COMPLETED", "FAILED", "CANCELED", "EXPIRED"].includes(op.status)) break;
  }
  console.log();
  if (op.status !== "COMPLETED") throw new Error(`bulk query ${op.status} ${op.errorCode || ""}`);
  const text = op.url ? await (await fetch(op.url)).text() : "";
  const products = {};
  const order = {};
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    if (!row.__parentId) {
      products[row.id] = { id: row.id, handle: row.handle, title: row.title, status: row.status, media: [] };
      order[row.id] = 0;
    } else if (products[row.__parentId]) {
      const p = products[row.__parentId];
      p.media.push({
        id: row.id,
        position: ++order[row.__parentId],
        type: row.mediaContentType,
        alt: row.alt || "",
        filename: row.image ? fileOf(row.image.url) : null,
        url: row.image ? row.image.url.split("?")[0] : null,
      });
    }
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ takenAt: new Date().toISOString(), products }, null, 1));
  const n = Object.values(products);
  console.log(`${n.length} products, ${n.reduce((a, p) => a + p.media.length, 0)} media -> ${OUT}`);
})().catch((e) => { console.error(e.message); process.exit(1); });
