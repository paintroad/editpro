// Re-render every framed image (black base + rooms) for live products and replace the
// Shopify files in place (same media id, file name, alt and position). Usage:
//   node scripts/pipeline-prep/refresh_lifestyle_images.js <productId...>
const fs = require("fs");
const os = require("os");
const path = require("path");
const { getShopifyCredentials } = require("../../lib/config-store");
const { shopifyGraphql } = require("../../lib/shopify-client");
const { stagedUploadFile } = require("../../lib/shopify-staged-upload");
const { loadCatalogStore, getPortraitImage } = require("../../lib/catalog-products-store");
const { listFramesForOrientation } = require("../../lib/frame-template-parser");
const { runCompositorManifest } = require("../../lib/python-setup");
const { loadSettings } = require("../../lib/catalog-pipeline");

const BACKUP_ROOT = path.join(os.homedir(), ".editpro", "pipeline-prep", "backups", "lifestyle-refresh");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stem = (name) => name.replace(/\.[^.]+$/, "");
const fileOf = (url) => decodeURIComponent(url.split("?")[0].split("/").pop());

function frameTemplatesPath() {
  return loadSettings().frameTemplatesPath;
}

async function render(product, dir) {
  const orientation = product.orientation;
  const frames = listFramesForOrientation(frameTemplatesPath(), orientation)
    .frames.filter((f) => !f.isBase || f.frameColour === "Black")
    .map((f) => ({ ...f, orientation }));
  const manifestPath = path.join(dir, "manifest.json");
  fs.writeFileSync(
    manifestPath,
    JSON.stringify({
      paintingPath: getPortraitImage(product).path,
      frames,
      outputDir: dir,
      outputBaseName: "r",
      size: 1080,
      jpegQuality: 88,
      blendMode: "scene",
      blendStrength: 1,
    })
  );
  const result = await runCompositorManifest(manifestPath).promise;
  return new Map(result.images.map((img) => [img.index, img.path]));
}

async function liveMedia(c, productId) {
  const d = await shopifyGraphql(
    c.storeDomain,
    c.accessToken,
    `query($id: ID!) { product(id: $id) { media(first: 50) { nodes { id ... on MediaImage { image { url } } } } } }`,
    { id: productId }
  );
  return d.product.media.nodes.filter((m) => m.image);
}

async function fileStatuses(c, ids) {
  const d = await shopifyGraphql(
    c.storeDomain,
    c.accessToken,
    `query($ids: [ID!]!) { nodes(ids: $ids) { ... on MediaImage { id fileStatus } } }`,
    { ids }
  );
  return d.nodes;
}

async function refresh(c, store, id) {
  const p = store.products[id];
  if (!p?.shopifyProductId) throw new Error("not live");
  const dir = path.join(os.tmpdir(), "editpro-refresh", id);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const renders = await render(p, dir);

  const live = await liveMedia(c, p.shopifyProductId);
  const byStem = new Map(live.map((m) => [stem(fileOf(m.image.url)).replace(/_[0-9a-f-]{36}$/i, ""), m]));
  const backup = path.join(BACKUP_ROOT, id);
  fs.mkdirSync(backup, { recursive: true });

  const updates = [];
  for (const img of p.lifestyleImages || []) {
    const src = renders.get(img.index);
    const media = byStem.get(stem(img.filename));
    if (!src || !media) throw new Error(`no render or live media for image ${img.index}`);
    if (path.extname(src).toLowerCase() !== path.extname(img.path).toLowerCase()) {
      throw new Error(`format changed for image ${img.index}`);
    }
    if (fs.existsSync(img.path)) fs.copyFileSync(img.path, path.join(backup, img.filename));
    fs.copyFileSync(src, img.path);
    const upload = await stagedUploadFile(c.storeDomain, c.accessToken, img.path);
    updates.push({ id: media.id, originalSource: upload.resourceUrl });
  }

  const d = await shopifyGraphql(
    c.storeDomain,
    c.accessToken,
    `mutation($files: [FileUpdateInput!]!) { fileUpdate(files: $files) { files { id } userErrors { field message } } }`,
    { files: updates }
  );
  const errors = d.fileUpdate.userErrors;
  if (errors.length) throw new Error(errors.map((e) => e.message).join("; "));

  const ids = updates.map((u) => u.id);
  for (let i = 0; i < 40; i++) {
    await sleep(2000);
    const statuses = await fileStatuses(c, ids);
    if (statuses.some((s) => s.fileStatus === "FAILED")) throw new Error("Shopify failed to process a file");
    if (statuses.every((s) => s.fileStatus === "READY")) return updates.length;
  }
  throw new Error("files not ready after 80s");
}

(async () => {
  const ids = process.argv.slice(2);
  const c = getShopifyCredentials();
  const store = loadCatalogStore();
  for (const id of ids) {
    try {
      console.log(id, "ok", `${await refresh(c, store, id)} images replaced`);
    } catch (e) {
      console.log(id, "FAILED", e.message);
    }
  }
})();
