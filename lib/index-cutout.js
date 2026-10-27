const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { loadCatalogStore } = require("./catalog-products-store");
const { shopifyGraphql } = require("./shopify-client");
const { loadLiveProductIndex } = require("./shopify-live-product-index");
const { isBasePaintingFilename } = require("./room-from-filename");

const SOURCE_DIR = "C:\\Users\\divya\\Downloads\\_Generated Catalog Images";
const OUTPUT_DIR = "C:\\Users\\divya\\Downloads\\Transparent Index Images";
const STATUS_PATH = path.join(os.homedir(), ".editpro", "index-cutout-status.json");
const SCRIPT_PATH = path.join(__dirname, "..", "scripts", "cutout-index-batch.py");
const SOURCE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp"];

function loadStatus() {
  if (!fs.existsSync(STATUS_PATH)) return { products: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(STATUS_PATH, "utf8"));
    return { products: raw.products || {} };
  } catch {
    return { products: {} };
  }
}

function saveStatus(status) {
  const dir = path.dirname(STATUS_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${STATUS_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(status, null, 2), "utf8");
  fs.renameSync(tmp, STATUS_PATH);
}

function sourcePathFor(productId) {
  const framed = path.join(SOURCE_DIR, productId, `${productId}_1_black.jpg`);
  if (fs.existsSync(framed)) return framed;
  for (const ext of SOURCE_EXTENSIONS) {
    const candidate = path.join(SOURCE_DIR, `${productId}${ext}`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function pngNameFromFilename(filename, productId) {
  const base = path.basename(String(filename || ""));
  const stem = base.replace(/\.[^.]+$/i, "").replace(/[<>:"/\\|?*]/g, "").trim();
  if (!stem) return `${productId}_0.png`;
  return `${stem}.png`;
}

function catalogIndexFilename(product) {
  const images = product?.lifestyleImages || [];
  const match = images.find((image) => isBasePaintingFilename(image.filename || ""));
  return match?.filename || "";
}

let shopifyIndexNames = null;

function loadShopifyIndexNames() {
  if (shopifyIndexNames) return shopifyIndexNames;
  shopifyIndexNames = new Map();
  const live = loadLiveProductIndex();
  const handleToId = new Map();
  for (const product of Object.values(live.products || {})) {
    if (product?.productId && product.handle) {
      handleToId.set(String(product.handle).toLowerCase(), String(product.productId));
    }
  }
  const mapPath = path.join(os.homedir(), ".editpro", "image-room-map.json");
  if (!fs.existsSync(mapPath)) return shopifyIndexNames;
  const raw = JSON.parse(fs.readFileSync(mapPath, "utf8"));
  for (const entry of Object.values(raw.mappings || {})) {
    if (entry?.resourceType !== "product" || Number(entry.imageIndex) !== 1) continue;
    const filename = filenameFromUrl(entry.url || "");
    if (!filename || !isBasePaintingFilename(filename)) continue;
    const productId = handleToId.get(String(entry.handle || "").toLowerCase());
    if (productId && !shopifyIndexNames.has(productId)) {
      shopifyIndexNames.set(productId, filename);
    }
  }
  return shopifyIndexNames;
}

function exportPngName(productId, store, allowShopifyLookup = false) {
  const fromCatalog = catalogIndexFilename(store?.products?.[productId]);
  if (fromCatalog) return pngNameFromFilename(fromCatalog, productId);
  if (allowShopifyLookup) {
    const fromShopify = loadShopifyIndexNames().get(String(productId));
    if (fromShopify) return pngNameFromFilename(fromShopify, productId);
  }
  return `${productId}_0.png`;
}

function outputPathFor(productId, store, saved) {
  const recorded = saved?.products?.[productId]?.outputFilename;
  const name = recorded || exportPngName(productId, store, false);
  return path.join(OUTPUT_DIR, name);
}

function deriveStatus(productId, saved, store) {
  const sourcePath = sourcePathFor(productId);
  const outputPath = outputPathFor(productId, store, saved);
  const outputExists = fs.existsSync(outputPath);
  const record = saved.products[productId] || {};
  let status = "pending";
  if (record.status === "uploaded") status = "uploaded";
  else if (record.status === "discontinued") status = "discontinued";
  else if (record.error) status = "error";
  else if (outputExists) status = "converted";
  else if (!sourcePath) status = "missing";
  return {
    productId,
    title: "",
    shopifyProductId: "",
    sourcePath,
    outputPath: outputExists ? outputPath : null,
    status,
    error: status === "error" ? record.error || "" : "",
    uploadedAt: record.uploadedAt || null,
  };
}

function listCutouts() {
  const store = loadCatalogStore();
  const saved = loadStatus();
  const rows = Object.values(store.products || {})
    .map((product) => {
      const row = deriveStatus(String(product.productId), saved, store);
      row.title = product.title || "";
      row.shopifyProductId = product.shopifyProductId || "";
      return row;
    })
    .filter((row) => row.status !== "discontinued")
    .sort((a, b) => a.productId.localeCompare(b.productId, undefined, { numeric: true }));
  const counts = { pending: 0, done: 0, missing: 0, error: 0 };
  for (const row of rows) {
    if (row.status === "uploaded") counts.done += 1;
    else if (row.status === "missing") counts.missing += 1;
    else counts.pending += 1;
  }
  return { sourceDir: SOURCE_DIR, outputDir: OUTPUT_DIR, counts, rows };
}

function runCutoutScript(jobs) {
  const jobsPath = path.join(os.tmpdir(), `index-cutout-jobs-${Date.now()}.json`);
  fs.writeFileSync(jobsPath, JSON.stringify(jobs), "utf8");
  return new Promise((resolve, reject) => {
    const child = spawn("py", ["-3", SCRIPT_PATH, SOURCE_DIR, OUTPUT_DIR, jobsPath], {
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      fs.rmSync(jobsPath, { force: true });
      resolve({ code, stdout, stderr });
    });
  });
}

async function convertCutouts(productIds) {
  const ids = [...new Set((productIds || []).map((id) => String(id).trim()).filter(Boolean))];
  if (!ids.length) throw new Error("Select at least one product.");
  const saved = loadStatus();
  const store = loadCatalogStore();
  const jobs = ids.map((productId) => ({
    productId,
    filename: exportPngName(productId, store, true),
  }));
  const { code, stdout, stderr } = await runCutoutScript(jobs);
  const results = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(/^(ok|missing|error)\s+(\S+)(?:\s+(.*))?$/);
    if (!match) continue;
    const [, kind, productId, message] = match;
    if (kind === "ok") {
      const fileMatch = String(message || "").match(/^(\S+\.png)\b/i);
      const outputFilename = fileMatch ? fileMatch[1] : `${productId}_0.png`;
      saved.products[productId] = {
        ...(saved.products[productId] || {}),
        status: saved.products[productId]?.status === "uploaded" ? "uploaded" : "converted",
        error: "",
        outputFilename,
        convertedAt: new Date().toISOString(),
      };
      results.push({ productId, status: "converted" });
    } else {
      saved.products[productId] = {
        ...(saved.products[productId] || {}),
        status: "error",
        error: kind === "missing" ? "Source image not found." : message || "Cutout failed.",
      };
      results.push({ productId, status: "error", error: saved.products[productId].error });
    }
  }
  saveStatus(saved);
  if (code !== 0 && !results.length) {
    throw new Error(stderr.trim() || `Cutout script failed (${code}).`);
  }
  return { results, stderr: stderr.trim() };
}

function filenameFromUrl(url) {
  try {
    return decodeURIComponent(path.basename(new URL(url).pathname));
  } catch {
    return "";
  }
}

function isIndexFilename(filename, productId) {
  const stem = filename.replace(/\.[^.]+$/i, "").toLowerCase();
  const id = String(productId).toLowerCase();
  if (stem === id || stem === `${id}_0`) return true;
  // Shopify appends _<uuid> when a filename is already taken.
  const canonical = stem.replace(
    /_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    ""
  );
  return isBasePaintingFilename(canonical);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchProductMedia(storeDomain, accessToken, productId) {
  const nodes = [];
  let cursor = null;
  let hasNext = true;
  while (hasNext) {
    const data = await shopifyGraphql(
      storeDomain,
      accessToken,
      `query($id: ID!, $cursor: String) {
        product(id: $id) {
          media(first: 50, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id
              alt
              ... on MediaImage { image { url altText } }
            }
          }
        }
      }`,
      { id: productId, cursor }
    );
    const page = data.product?.media;
    if (!data.product && cursor == null) {
      throw new Error("Product no longer exists on Shopify.");
    }
    nodes.push(...(page?.nodes || []));
    hasNext = Boolean(page?.pageInfo?.hasNextPage);
    cursor = page?.pageInfo?.endCursor || null;
  }
  return nodes;
}

async function stagedUpload(storeDomain, accessToken, localPath, filename) {
  const data = await shopifyGraphql(
    storeDomain,
    accessToken,
    `mutation StagedUploadsCreate($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets { url resourceUrl parameters { name value } }
        userErrors { field message }
      }
    }`,
    {
      input: [
        {
          filename,
          mimeType: "image/png",
          resource: "FILE",
          httpMethod: "POST",
        },
      ],
    }
  );
  const errors = data.stagedUploadsCreate?.userErrors || [];
  if (errors.length) throw new Error(errors.map((error) => error.message).join("; "));
  const target = data.stagedUploadsCreate?.stagedTargets?.[0];
  if (!target?.url || !target.resourceUrl) throw new Error("Staged upload target missing.");

  const fileBuffer = fs.readFileSync(localPath);
  const form = new FormData();
  for (const param of target.parameters || []) form.append(param.name, param.value);
  form.append("file", new Blob([fileBuffer], { type: "image/png" }), filename);
  const uploadResponse = await fetch(target.url, { method: "POST", body: form });
  if (!uploadResponse.ok) {
    const text = await uploadResponse.text().catch(() => "");
    throw new Error(`Staged upload failed (${uploadResponse.status}): ${text.slice(0, 200)}`);
  }
  return target.resourceUrl;
}

async function fileCreate(storeDomain, accessToken, resourceUrl, filename, alt) {
  const data = await shopifyGraphql(
    storeDomain,
    accessToken,
    `mutation FileCreate($files: [FileCreateInput!]!) {
      fileCreate(files: $files) {
        files { id fileStatus }
        userErrors { field message }
      }
    }`,
    {
      files: [
        {
          originalSource: resourceUrl,
          filename,
          contentType: "IMAGE",
          alt: alt || "",
        },
      ],
    }
  );
  const errors = data.fileCreate?.userErrors || [];
  if (errors.length) throw new Error(errors.map((error) => error.message).join("; "));
  const file = data.fileCreate?.files?.[0];
  if (!file?.id) throw new Error("Shopify did not return a new file id.");
  return file;
}

async function waitForFileReady(storeDomain, accessToken, fileId) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const data = await shopifyGraphql(
      storeDomain,
      accessToken,
      `query($id: ID!) { node(id: $id) { ... on File { fileStatus } } }`,
      { id: fileId }
    );
    const status = data.node?.fileStatus;
    if (status === "READY") return;
    if (status === "FAILED") throw new Error(`Shopify file processing failed for ${fileId}`);
    await sleep(1000);
  }
  throw new Error(`Timed out waiting for ${fileId} to become ready.`);
}

async function attachFile(storeDomain, accessToken, productGid, fileId) {
  const data = await shopifyGraphql(
    storeDomain,
    accessToken,
    `mutation FileUpdate($files: [FileUpdateInput!]!) {
      fileUpdate(files: $files) {
        files { id }
        userErrors { field message }
      }
    }`,
    { files: [{ id: fileId, referencesToAdd: [productGid] }] }
  );
  const errors = data.fileUpdate?.userErrors || [];
  if (errors.length) throw new Error(errors.map((error) => error.message).join("; "));
}

async function reorderFirst(storeDomain, accessToken, productGid, mediaId) {
  const data = await shopifyGraphql(
    storeDomain,
    accessToken,
    `mutation ProductReorderMedia($id: ID!, $moves: [MoveInput!]!) {
      productReorderMedia(id: $id, moves: $moves) {
        job { id done }
        mediaUserErrors { field message }
        userErrors { field message }
      }
    }`,
    { id: productGid, moves: [{ id: mediaId, newPosition: "0" }] }
  );
  const result = data.productReorderMedia;
  const errors = [...(result?.mediaUserErrors || []), ...(result?.userErrors || [])];
  if (errors.length) throw new Error(errors.map((error) => error.message).join("; "));
}

async function deleteFile(storeDomain, accessToken, fileId) {
  const data = await shopifyGraphql(
    storeDomain,
    accessToken,
    `mutation FileDelete($fileIds: [ID!]!) {
      fileDelete(fileIds: $fileIds) {
        deletedFileIds
        userErrors { field message }
      }
    }`,
    { fileIds: [fileId] }
  );
  const errors = data.fileDelete?.userErrors || [];
  if (errors.length) throw new Error(errors.map((error) => error.message).join("; "));
}

function productForUpload(productId, store) {
  const catalogProduct = store.products?.[productId] || null;
  if (catalogProduct?.shopifyProductId) return catalogProduct;
  const live = loadLiveProductIndex().products?.[productId];
  if (!live?.shopifyProductId) return catalogProduct;
  return {
    ...(catalogProduct || {}),
    productId,
    title: catalogProduct?.title || live.handle || "",
    shopifyProductId: live.shopifyProductId,
  };
}

async function waitForMediaAttached(storeDomain, accessToken, productGid, mediaId) {
  for (let attempt = 0; attempt < 15; attempt += 1) {
    const media = await fetchProductMedia(storeDomain, accessToken, productGid);
    if (media.some((node) => node.id === mediaId)) return media;
    await sleep(1000);
  }
  throw new Error("New image was not attached to the product.");
}

async function uploadOne(storeDomain, accessToken, product, store) {
  const productId = String(product.productId);
  const localPath = path.join(OUTPUT_DIR, exportPngName(productId, store, true));
  if (!fs.existsSync(localPath)) throw new Error("Converted PNG is missing.");
  if (!product.shopifyProductId) throw new Error("Product has no Shopify id.");

  const media = await fetchProductMedia(storeDomain, accessToken, product.shopifyProductId);
  const indexMedia = media.find((node) =>
    isIndexFilename(filenameFromUrl(node?.image?.url || ""), productId)
  );
  if (!indexMedia) throw new Error("No index image matched on Shopify.");

  const currentName = filenameFromUrl(indexMedia.image?.url || "");
  const stem = currentName.replace(/\.[^.]+$/i, "") || `${productId}_0`;
  const shopifyFilename = `${stem}.png`;
  const alt = indexMedia.alt || indexMedia.image?.altText || "";

  const resourceUrl = await stagedUpload(storeDomain, accessToken, localPath, shopifyFilename);
  const created = await fileCreate(storeDomain, accessToken, resourceUrl, shopifyFilename, alt);
  await waitForFileReady(storeDomain, accessToken, created.id);
  await attachFile(storeDomain, accessToken, product.shopifyProductId, created.id);
  await waitForMediaAttached(storeDomain, accessToken, product.shopifyProductId, created.id);
  await reorderFirst(storeDomain, accessToken, product.shopifyProductId, created.id);
  if (indexMedia.id !== created.id) {
    await deleteFile(storeDomain, accessToken, indexMedia.id);
  }
  return {
    shopifyFilename,
    alt,
    replacedFilename: currentName,
    localPath,
    deletedFileId: indexMedia.id,
    newFileId: created.id,
  };
}

async function uploadCutouts(storeDomain, accessToken, productIds) {
  const ids = [...new Set((productIds || []).map((id) => String(id).trim()).filter(Boolean))];
  if (!ids.length) throw new Error("Select at least one product.");
  const store = loadCatalogStore();
  const saved = loadStatus();
  const results = [];
  for (const productId of ids) {
    if (saved.products[productId]?.status === "uploaded") {
      results.push({ productId, status: "skipped" });
      console.log(`skip ${productId} already uploaded`);
      continue;
    }
    const product = productForUpload(productId, store);
    try {
      if (!product?.shopifyProductId) throw new Error("Product has no Shopify id.");
      const uploaded = await uploadOne(storeDomain, accessToken, product, store);
      saved.products[productId] = {
        ...(saved.products[productId] || {}),
        status: "uploaded",
        error: "",
        uploadedAt: new Date().toISOString(),
        shopifyFilename: uploaded.shopifyFilename,
        newFileId: uploaded.newFileId,
      };
      results.push({ productId, status: "uploaded", ...uploaded });
      console.log(`ok ${productId} ${uploaded.shopifyFilename}`);
    } catch (error) {
      const message = error.message || String(error);
      saved.products[productId] = {
        ...(saved.products[productId] || {}),
        status: "error",
        error: message,
      };
      results.push({ productId, status: "error", error: message });
      console.log(`error ${productId} ${message}`);
    }
    saveStatus(saved);
    await sleep(150);
  }
  return { results };
}

module.exports = {
  SOURCE_DIR,
  OUTPUT_DIR,
  exportPngName,
  listCutouts,
  convertCutouts,
  uploadCutouts,
};
