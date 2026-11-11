// Push rendered catalog images (render_catalog_images.js) to live products, following
// catalog-image-plan.json and the URL rules agreed on 11 Nov 2026:
//   keep / keep-room / keep-base  replace the file content in place (same media id, same URL)
//   new                           upload, then attach to the product
//   detach                        remove from the product gallery; the file stays in Shopify Files
// Room images get the EditPro alt "{{description100}} for {{room}}"; the index image keeps its alt.
// Shared images (features-*.jpg) are left as they are, after the catalog images.
//
//   node scripts/pipeline-prep/upload_catalog_images.js --numbers=10001,10002 [--dry-run]
//   node scripts/pipeline-prep/upload_catalog_images.js --limit=50 [--workers=2]   next rendered, not yet uploaded
//   node scripts/pipeline-prep/upload_catalog_images.js --all
//
// Before any write the product's current media is saved to backups/catalog-upload/<number>.json.
// Results: ~/.editpro/pipeline-prep/catalog-upload.json
const fs = require("fs");
const os = require("os");
const path = require("path");
const { getShopifyCredentials } = require("../../lib/config-store");
const { shopifyGraphql } = require("../../lib/shopify-client");
const { stagedUploadFile } = require("../../lib/shopify-staged-upload");
const { assertClean } = require("../../lib/brand-guard");
const { truncate } = require("../../lib/catalog-text-utils");

const PREP = path.join(os.homedir(), ".editpro", "pipeline-prep");
const PLAN = path.join(PREP, "catalog-image-plan.json");
const RENDERS = path.join(PREP, "catalog-renders.json");
const LOG = path.join(PREP, "catalog-upload.json");
const BACKUPS = path.join(PREP, "backups", "catalog-upload");
const readJson = (f, d) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : d);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fileOf = (url) => decodeURIComponent(String(url || "").split("?")[0].split("/").pop());

const PRODUCT_MEDIA = `query($id: ID!) {
  product(id: $id) {
    id title descriptionHtml
    media(first: 100) { nodes { id alt mediaContentType ... on MediaImage { fileStatus image { url } } } }
  }
}`;
const FILE_UPDATE = `mutation($files: [FileUpdateInput!]!) {
  fileUpdate(files: $files) { files { id fileStatus } userErrors { field message code } }
}`;
const FILE_CREATE = `mutation($files: [FileCreateInput!]!) {
  fileCreate(files: $files) { files { id fileStatus } userErrors { field message code } }
}`;
const FILE_STATUS = `query($ids: [ID!]!) { nodes(ids: $ids) { id ... on MediaImage { fileStatus } } }`;
const REORDER = `mutation($id: ID!, $moves: [MoveInput!]!) {
  productReorderMedia(id: $id, moves: $moves) { job { id } mediaUserErrors { field message code } }
}`;

function plainText(html) {
  return String(html || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}

function roomAlt(description, room) {
  const short = truncate(description, 100);
  return `${short}${short.length < description.length ? " …" : ""} for ${room.toLowerCase()}`;
}

async function gql(c, query, variables) {
  return shopifyGraphql(c.storeDomain, c.accessToken, query, variables);
}

function errorsOf(result, key = "userErrors") {
  const errors = result?.[key] || [];
  if (errors.length) throw new Error(errors.map((e) => `${e.code || ""} ${e.message}`.trim()).join("; "));
  return result;
}

async function waitReady(c, ids) {
  for (let i = 0; i < 60; i++) {
    const { nodes } = await gql(c, FILE_STATUS, { ids });
    if (nodes.some((n) => n?.fileStatus === "FAILED")) throw new Error("Shopify failed to process a file");
    if (nodes.every((n) => n?.fileStatus === "READY")) return;
    await sleep(2000);
  }
  throw new Error("files not ready after 120 s");
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

async function uploadProduct(c, entry, render, dryRun) {
  const { product } = await gql(c, PRODUCT_MEDIA, { id: entry.productId });
  if (!product) throw new Error("product not found");
  const media = product.media.nodes;
  const byId = new Map(media.map((m) => [m.id, m]));
  const keepIds = entry.images.filter((i) => i.mediaId).map((i) => i.mediaId);
  const missing = [...keepIds, ...entry.detach.map((d) => d.mediaId)].filter((id) => !byId.has(id));
  if (missing.length) throw new Error(`gallery changed since the plan: ${missing.length} planned media no longer on the product`);
  if (keepIds.some((id) => byId.get(id).fileStatus !== "READY")) throw new Error("a kept file is not READY");

  const description = plainText(product.descriptionHtml);
  if (!description) throw new Error("product has no description for alt text");
  const files = new Map(render.images.map((i) => [i.filename, i.path]));
  const jobs = entry.images.map((img) => {
    const local = files.get(img.filename);
    if (!local || !fs.existsSync(local)) throw new Error(`rendered file missing: ${img.filename}`);
    if (img.mediaId && fileOf(byId.get(img.mediaId).image?.url).replace(/_[0-9a-f-]{36}(?=\.)/i, "") !== img.filename) {
      throw new Error(`live file name of ${img.mediaId} is not ${img.filename}`);
    }
    const alt = img.room ? assertClean(roomAlt(description, img.room), "image alt") : null;
    assertClean(img.filename, "image file name");
    return { ...img, local, alt };
  });

  fs.mkdirSync(BACKUPS, { recursive: true });
  fs.writeFileSync(path.join(BACKUPS, `${entry.number}.json`), JSON.stringify({ savedAt: new Date().toISOString(), productId: entry.productId, media }, null, 1));
  if (dryRun) return { dryRun: true, replace: jobs.filter((j) => j.mediaId).length, add: jobs.filter((j) => !j.mediaId).length, detach: entry.detach.length, alts: jobs.map((j) => j.alt) };

  const staged = await pool(jobs, 4, (j) => stagedUploadFile(c.storeDomain, c.accessToken, j.local));
  jobs.forEach((j, i) => { j.source = staged[i].resourceUrl; });

  const replace = jobs.filter((j) => j.mediaId);
  if (replace.length) {
    const r = await gql(c, FILE_UPDATE, { files: replace.map((j) => ({ id: j.mediaId, originalSource: j.source, ...(j.alt ? { alt: j.alt } : {}) })) });
    errorsOf(r.fileUpdate);
  }
  const add = jobs.filter((j) => !j.mediaId);
  if (add.length) {
    const r = await gql(c, FILE_CREATE, { files: add.map((j) => ({ originalSource: j.source, contentType: "IMAGE", filename: j.filename, alt: j.alt || "" })) });
    errorsOf(r.fileCreate);
    r.fileCreate.files.forEach((f, i) => { add[i].mediaId = f.id; add[i].created = true; });
  }
  await waitReady(c, jobs.map((j) => j.mediaId));
  if (add.length) {
    const r = await gql(c, FILE_UPDATE, { files: add.map((j) => ({ id: j.mediaId, referencesToAdd: [entry.productId] })) });
    errorsOf(r.fileUpdate);
  }
  if (entry.detach.length) {
    const r = await gql(c, FILE_UPDATE, { files: entry.detach.map((d) => ({ id: d.mediaId, referencesToRemove: [entry.productId] })) });
    errorsOf(r.fileUpdate);
  }

  // Catalog images in plan order, then whatever else the product shows (shared feature images).
  const after = (await gql(c, PRODUCT_MEDIA, { id: entry.productId })).product.media.nodes;
  const ours = jobs.map((j) => j.mediaId);
  const missingNew = ours.filter((id) => !after.some((m) => m.id === id));
  if (missingNew.length) throw new Error(`${missingNew.length} images did not attach`);
  const order = [...ours, ...after.map((m) => m.id).filter((id) => !ours.includes(id))];
  const moves = order.map((id, i) => ({ id, newPosition: String(i) })).filter(({ id }, i) => after[i]?.id !== id);
  if (moves.length) errorsOf((await gql(c, REORDER, { id: entry.productId, moves })).productReorderMedia, "mediaUserErrors");

  return {
    replaced: replace.length, added: add.length, detached: entry.detach.length,
    images: jobs.map((j) => ({ position: j.position, filename: j.filename, mediaId: j.mediaId, action: j.action })),
    detachedIds: entry.detach.map((d) => d.mediaId),
  };
}

(async () => {
  const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
  const dryRun = process.argv.includes("--dry-run");
  const { plan } = readJson(PLAN, { plan: [] });
  const renders = readJson(RENDERS, {});
  const log = readJson(LOG, {});
  const done = (n) => log[n]?.status === "done";
  let list = plan.filter((e) => renders[e.number]);
  if (arg("numbers")) {
    const want = new Set(arg("numbers").split(","));
    list = list.filter((e) => want.has(e.number));
  } else if (arg("limit")) {
    list = list.filter((e) => !done(e.number)).slice(0, Number(arg("limit")));
  } else if (process.argv.includes("--all")) {
    list = list.filter((e) => !done(e.number));
  } else {
    console.log("Pass --numbers=a,b, --limit=N or --all");
    return;
  }
  const c = getShopifyCredentials();
  const workers = Math.max(1, Number(arg("workers")) || 2);
  console.log(`${dryRun ? "DRY RUN: " : ""}${list.length} products, ${workers} at a time`);
  let ok = 0, failed = 0;
  const started = Date.now();
  await pool(list, workers, async (entry) => {
    const render = renders[entry.number];
    try {
      const r = await uploadProduct(c, entry, render, dryRun);
      if (dryRun) { console.log(entry.number, JSON.stringify(r).slice(0, 400)); ok++; return; }
      log[entry.number] = { status: "done", at: new Date().toISOString(), productId: entry.productId, ...r };
      ok++;
    } catch (e) {
      failed++;
      if (!dryRun) log[entry.number] = { status: "failed", at: new Date().toISOString(), productId: entry.productId, error: e.message };
      console.error(`${entry.number} FAILED: ${e.message}`);
    }
    if (!dryRun) fs.writeFileSync(LOG, JSON.stringify(log, null, 1));
    if ((ok + failed) % 25 === 0) {
      const rate = (ok + failed) / ((Date.now() - started) / 1000);
      console.log(`${ok + failed}/${list.length} (${Math.round((list.length - ok - failed) / rate / 60)} min left)`);
    }
  });
  console.log(`done: ${ok} ok, ${failed} failed${dryRun ? " (dry run, nothing written)" : ""}`);
})();
