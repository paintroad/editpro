// Read-only: list a live product's gallery (file name, status, end of alt).
//   node scripts/pipeline-prep/check_product_media.js <number|productGid>...
const os = require("os");
const path = require("path");
const fs = require("fs");
const { getShopifyCredentials } = require("../../lib/config-store");
const { shopifyGraphql } = require("../../lib/shopify-client");

const LOG = path.join(os.homedir(), ".editpro", "pipeline-prep", "catalog-upload.json");
const PLAN = path.join(os.homedir(), ".editpro", "pipeline-prep", "catalog-image-plan.json");

(async () => {
  const c = getShopifyCredentials();
  const log = fs.existsSync(LOG) ? JSON.parse(fs.readFileSync(LOG, "utf8")) : {};
  const plan = new Map(JSON.parse(fs.readFileSync(PLAN, "utf8")).plan.map((e) => [e.number, e]));
  for (const arg of process.argv.slice(2)) {
    const id = arg.startsWith("gid://") ? arg : log[arg]?.productId || plan.get(arg)?.productId;
    const d = await shopifyGraphql(c.storeDomain, c.accessToken,
      `query($id: ID!) { product(id: $id) { title onlineStoreUrl media(first: 50) { nodes { id alt ... on MediaImage { fileStatus image { url } } } } } }`, { id });
    console.log(`\n${arg} ${d.product.title} ${d.product.onlineStoreUrl || ""}`);
    d.product.media.nodes.forEach((m, i) => console.log(String(i + 1).padStart(2), m.fileStatus, decodeURIComponent(m.image?.url.split("?")[0].split("/").pop() || ""), "|", (m.alt || "").slice(-28)));
  }
})();
