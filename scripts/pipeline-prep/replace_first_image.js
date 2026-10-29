// Swap the picture behind the first product image (the black base) on live products, keeping the
// media id, position and alt text. Used after rerender_base_images.py. Usage:
//   node scripts/pipeline-prep/replace_first_image.js <firstId> [lastId]
const fs = require("fs");
const os = require("os");
const path = require("path");
const { getShopifyCredentials } = require("../../lib/config-store");
const { shopifyGraphql } = require("../../lib/shopify-client");
const { stagedUploadFile } = require("../../lib/shopify-staged-upload");
const { loadCatalogStore } = require("../../lib/catalog-products-store");

const BACKUP = path.join(os.homedir(), ".editpro", "pipeline-prep", "backups", "first-image-replace.jsonl");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stem = (name) => path.basename(String(name || "").split("?")[0]).replace(/\.[^.]+$/, "").replace(/_[0-9a-f-]{36}$/i, "");

async function firstMedia(c, productId) {
  const d = await shopifyGraphql(
    c.storeDomain,
    c.accessToken,
    `query($id: ID!) { product(id: $id) { media(first: 1) { nodes { id alt ... on MediaImage { image { url } } } } } }`,
    { id: productId }
  );
  return d.product?.media.nodes[0] || null;
}

async function waitReady(c, id) {
  for (let i = 0; i < 60; i++) {
    await sleep(2000);
    const d = await shopifyGraphql(
      c.storeDomain,
      c.accessToken,
      `query($id: ID!) { node(id: $id) { ... on MediaImage { fileStatus image { url } } } }`,
      { id }
    );
    if (d.node?.fileStatus === "FAILED") throw new Error("Shopify failed to process the new image");
    if (d.node?.fileStatus === "READY") return d.node.image?.url;
  }
  throw new Error("new image not ready after 120s");
}

async function replace(c, p) {
  const base = (p.lifestyleImages || []).find((img) => img.index === 1);
  if (!base || !fs.existsSync(base.path)) throw new Error("base image missing on disk");
  const media = await firstMedia(c, p.shopifyProductId);
  if (!media?.image?.url) throw new Error("no first image on Shopify");
  if (!stem(media.image.url).startsWith(stem(base.filename))) {
    throw new Error(`first image on Shopify is not the base (${path.basename(media.image.url.split("?")[0])})`);
  }
  fs.appendFileSync(BACKUP, JSON.stringify({ productId: p.productId, mediaId: media.id, url: media.image.url, at: new Date().toISOString() }) + "\n");
  const upload = await stagedUploadFile(c.storeDomain, c.accessToken, base.path);
  const d = await shopifyGraphql(
    c.storeDomain,
    c.accessToken,
    `mutation($files: [FileUpdateInput!]!) { fileUpdate(files: $files) { files { id } userErrors { message } } }`,
    { files: [{ id: media.id, originalSource: upload.resourceUrl }] }
  );
  const errors = d.fileUpdate.userErrors;
  if (errors.length) throw new Error(errors.map((e) => e.message).join("; "));
  await waitReady(c, media.id);
}

(async () => {
  const first = Number(process.argv[2]);
  const last = Number(process.argv[3] || process.argv[2]);
  if (!first) throw new Error("Pass a product id or an id range.");
  fs.mkdirSync(path.dirname(BACKUP), { recursive: true });
  const c = getShopifyCredentials();
  const store = loadCatalogStore();
  const products = Object.values(store.products)
    .filter((p) => Number(p.productId) >= first && Number(p.productId) <= last && p.shopifyProductId)
    .sort((a, b) => Number(a.productId) - Number(b.productId));
  let ok = 0;
  const failed = [];
  for (const p of products) {
    try {
      await replace(c, p);
      ok += 1;
    } catch (e) {
      failed.push(p.productId);
      console.log(p.productId, "FAILED", e.message);
    }
    if ((ok + failed.length) % 25 === 0) console.log(`${ok + failed.length}/${products.length} done, ${failed.length} failed`);
  }
  console.log(`Done: ${ok} replaced, ${failed.length} failed${failed.length ? ` (${failed.join(" ")})` : ""}`);
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
