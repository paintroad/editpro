// Replace the base (framed) image on live products with a fresh black render and drop
// the parked White/Wooden base images. Usage:
//   node scripts/pipeline-prep/replace_base_frames.js <renderDir> <productId...>
// <renderDir> holds t<productId>_1_black.png renders.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { getShopifyCredentials } = require("../../lib/config-store");
const { shopifyGraphql } = require("../../lib/shopify-client");
const { stagedUploadFile } = require("../../lib/shopify-staged-upload");
const { loadCatalogStore, saveCatalogStore } = require("../../lib/catalog-products-store");

const BACKUP_ROOT = path.join(os.homedir(), ".editpro", "pipeline-prep", "backups", "base-frames");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fileOf = (url) => decodeURIComponent(url.split("?")[0].split("/").pop());
const stem = (name) => name.replace(/\.[^.]+$/, "");

async function media(c, productId) {
  const d = await shopifyGraphql(
    c.storeDomain,
    c.accessToken,
    `query($id: ID!) { product(id: $id) { media(first: 50) { nodes { id alt status ... on MediaImage { image { url } } } } } }`,
    { id: productId }
  );
  return d.product.media.nodes;
}

async function replace(c, store, id, renderDir) {
  const p = store.products[id];
  const render = path.join(renderDir, `t${id}_1_black.png`);
  if (!p?.shopifyProductId || !fs.existsSync(render)) throw new Error("missing product or render");
  const bases = (p.lifestyleImages || []).filter((i) => i.index === 1);
  const black = bases.find((i) => i.frameColour === "Black");
  const parked = bases.filter((i) => i.frameColour && i.frameColour !== "Black");
  if (!black) throw new Error("no black base in store");

  const backup = path.join(BACKUP_ROOT, id);
  fs.mkdirSync(backup, { recursive: true });
  for (const img of bases) if (fs.existsSync(img.path)) fs.copyFileSync(img.path, path.join(backup, img.filename));

  const live = await media(c, p.shopifyProductId);
  const names = new Set(bases.map((i) => stem(i.filename)));
  const old = live.filter((m) => m.image && names.has(stem(fileOf(m.image.url)).replace(/_[0-9a-f-]{36}$/i, "")));
  const blackLive = old.find((m) => stem(fileOf(m.image.url)).startsWith(stem(black.filename)));
  if (!blackLive) throw new Error("live black base not found");

  const del = await shopifyGraphql(
    c.storeDomain,
    c.accessToken,
    `mutation($productId: ID!, $mediaIds: [ID!]!) { productDeleteMedia(productId: $productId, mediaIds: $mediaIds) { deletedMediaIds mediaUserErrors { message } } }`,
    { productId: p.shopifyProductId, mediaIds: old.map((m) => m.id) }
  );
  const delErr = del.productDeleteMedia.mediaUserErrors;
  if (delErr.length) throw new Error(delErr.map((e) => e.message).join("; "));

  fs.copyFileSync(render, black.path);
  await sleep(3000);
  const upload = await stagedUploadFile(c.storeDomain, c.accessToken, black.path);
  const created = await shopifyGraphql(
    c.storeDomain,
    c.accessToken,
    `mutation($productId: ID!, $media: [CreateMediaInput!]!) { productCreateMedia(productId: $productId, media: $media) { media { id } mediaUserErrors { message } } }`,
    { productId: p.shopifyProductId, media: [{ originalSource: upload.resourceUrl, alt: blackLive.alt || "", mediaContentType: "IMAGE" }] }
  );
  const cErr = created.productCreateMedia.mediaUserErrors;
  if (cErr.length) throw new Error(cErr.map((e) => e.message).join("; "));
  const newId = created.productCreateMedia.media[0].id;

  let ready = null;
  for (let i = 0; i < 20 && !ready; i++) {
    await sleep(1500);
    ready = (await media(c, p.shopifyProductId)).find((m) => m.id === newId && m.status === "READY" && m.image);
  }
  if (!ready) throw new Error("new media not ready");
  await shopifyGraphql(
    c.storeDomain,
    c.accessToken,
    `mutation($id: ID!, $moves: [MoveInput!]!) { productReorderMedia(id: $id, moves: $moves) { userErrors { message } } }`,
    { id: p.shopifyProductId, moves: [{ id: newId, newPosition: "0" }] }
  );

  for (const img of parked) if (fs.existsSync(img.path)) fs.unlinkSync(img.path);
  p.lifestyleImages = p.lifestyleImages.filter((i) => !parked.includes(i));
  return { removed: old.length, file: fileOf(ready.image.url) };
}

(async () => {
  const [renderDir, ...ids] = process.argv.slice(2);
  const c = getShopifyCredentials();
  const store = loadCatalogStore();
  for (const id of ids) {
    try {
      const r = await replace(c, store, id, renderDir);
      saveCatalogStore(store);
      console.log(id, "ok", `removed ${r.removed}`, r.file);
    } catch (e) {
      console.log(id, "FAILED", e.message);
    }
  }
})();
