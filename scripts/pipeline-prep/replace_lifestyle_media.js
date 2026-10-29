// Replace all images of live products with their current lifestyle images (after a new set or a
// change in room count). New media are added and processed before the old ones are removed, so a
// product is never left without images. A record of the old media is kept in
// ~/.editpro/pipeline-prep/backups/lifestyle-replace. Usage:
//   node scripts/pipeline-prep/replace_lifestyle_media.js <productId...>
const fs = require("fs");
const os = require("os");
const path = require("path");
const { getShopifyCredentials } = require("../../lib/config-store");
const { shopifyGraphql } = require("../../lib/shopify-client");
const { stagedUploadFile } = require("../../lib/shopify-staged-upload");
const { loadCatalogStore } = require("../../lib/catalog-products-store");
const { catalogProductImages } = require("../../lib/catalog-seo-fix");

const BACKUP_ROOT = path.join(os.homedir(), ".editpro", "pipeline-prep", "backups", "lifestyle-replace");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function liveMedia(c, productId) {
  const d = await shopifyGraphql(
    c.storeDomain,
    c.accessToken,
    `query($id: ID!) { product(id: $id) { media(first: 100) { nodes { id alt ... on MediaImage { image { url } } } } } }`,
    { id: productId }
  );
  return d.product.media.nodes;
}

async function waitReady(c, ids) {
  for (let i = 0; i < 60; i++) {
    await sleep(2000);
    const d = await shopifyGraphql(
      c.storeDomain,
      c.accessToken,
      `query($ids: [ID!]!) { nodes(ids: $ids) { ... on MediaImage { id status } } }`,
      { ids }
    );
    if (d.nodes.some((n) => n?.status === "FAILED")) throw new Error("Shopify failed to process a new image");
    if (d.nodes.every((n) => n?.status === "READY")) return;
  }
  throw new Error("new images not ready after 120s; old images left in place");
}

async function replace(c, store, id) {
  const p = store.products[id];
  if (!p?.shopifyProductId) throw new Error("not live");
  const images = catalogProductImages(p);
  if (!images.length || images.some((img) => !img.path || !fs.existsSync(img.path))) {
    throw new Error("lifestyle images missing on disk");
  }

  const old = await liveMedia(c, p.shopifyProductId);
  fs.mkdirSync(BACKUP_ROOT, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  fs.writeFileSync(path.join(BACKUP_ROOT, `${id}-${stamp}.json`), JSON.stringify(old, null, 2));

  const media = [];
  for (const img of images) {
    const upload = await stagedUploadFile(c.storeDomain, c.accessToken, img.path);
    media.push({ originalSource: upload.resourceUrl, alt: img.alt || "", mediaContentType: "IMAGE" });
  }
  const created = await shopifyGraphql(
    c.storeDomain,
    c.accessToken,
    `mutation($productId: ID!, $media: [CreateMediaInput!]!) {
      productCreateMedia(productId: $productId, media: $media) {
        media { id } mediaUserErrors { field message }
      }
    }`,
    { productId: p.shopifyProductId, media }
  );
  const createErr = created.productCreateMedia.mediaUserErrors;
  if (createErr.length) throw new Error(createErr.map((e) => e.message).join("; "));
  await waitReady(c, created.productCreateMedia.media.map((m) => m.id));

  if (old.length) {
    const del = await shopifyGraphql(
      c.storeDomain,
      c.accessToken,
      `mutation($productId: ID!, $mediaIds: [ID!]!) {
        productDeleteMedia(productId: $productId, mediaIds: $mediaIds) { deletedMediaIds mediaUserErrors { message } }
      }`,
      { productId: p.shopifyProductId, mediaIds: old.map((m) => m.id) }
    );
    const delErr = del.productDeleteMedia.mediaUserErrors;
    if (delErr.length) throw new Error(`new images added but old not removed: ${delErr.map((e) => e.message).join("; ")}`);
  }
  return { added: media.length, removed: old.length };
}

(async () => {
  const ids = process.argv.slice(2);
  if (!ids.length) throw new Error("Pass one or more product ids.");
  const c = getShopifyCredentials();
  const store = loadCatalogStore();
  for (const id of ids) {
    try {
      const r = await replace(c, store, id);
      console.log(id, "ok", `${r.added} added, ${r.removed} removed`);
    } catch (e) {
      console.log(id, "FAILED", e.message);
    }
  }
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
