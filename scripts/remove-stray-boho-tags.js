#!/usr/bin/env node
/**
 * Remove Boho collection tag from products that are NOT in the Boho folder.
 *
 * Boho smart collection rule: TAG EQUALS "Boho"
 * Folder truth: Prints_Categories path segment "Boho"
 *
 * Usage:
 *   node scripts/remove-stray-boho-tags.js
 *   node scripts/remove-stray-boho-tags.js --no-rescan --no-refresh
 *   node scripts/remove-stray-boho-tags.js --apply
 *
 * Report: ~/.editpro/boho-tag-stray-remove-report.json
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { getShopifyCredentials } = require("../lib/config-store");
const { shopifyGraphql } = require("../lib/shopify-client");
const {
  scanCollectionRoot,
  normalizeRootPath,
} = require("../lib/collections-scanner");
const { saveScanResult, getCachedScan } = require("../lib/collections-store");
const { normalizeTags } = require("../lib/shopify-live-product-index");
const { productIdFromFilename } = require("../lib/collections-shopify-tags");

const CONFIG_DIR = path.join(os.homedir(), ".editpro");
const REPORT_PATH = path.join(CONFIG_DIR, "boho-tag-stray-remove-report.json");
const DEFAULT_ROOT = "C:\\Paintroad\\Files\\Prints_Categories";
const FOLDER_TAG = "boho";
const REMOVE_TAG_NORM = "boho";

function parseArgs(argv = process.argv.slice(2)) {
  let root = DEFAULT_ROOT;
  let rescan = true;
  let apply = false;
  for (const arg of argv) {
    if (arg === "--apply") apply = true;
    else if (arg === "--no-rescan") rescan = false;
    else if (arg === "--no-refresh") {
      /* kept for CLI compatibility; discovery uses live tag search */
    } else if (arg.startsWith("--root=")) {
      root = arg.slice("--root=".length).replace(/^["']|["']$/g, "");
    }
  }
  return { root, rescan, apply };
}

function productIdFromSku(sku) {
  const m = String(sku || "").match(/(\d{5})/);
  return m ? m[1] : null;
}

/** Discover products with Boho tag via live Shopify search (index can miss casing). */
async function fetchProductsWithBohoTag(storeDomain, accessToken) {
  const found = [];
  let cursor = null;
  for (;;) {
    const data = await shopifyGraphql(
      storeDomain,
      accessToken,
      `query($cursor: String) {
        products(first: 100, query: "tag:Boho OR tag:boho", after: $cursor) {
          pageInfo { hasNextPage endCursor }
          edges {
            node {
              id
              handle
              tags
              variants(first: 5) { edges { node { sku } } }
            }
          }
        }
      }`,
      { cursor }
    );
    for (const edge of data.products.edges) {
      const p = edge.node;
      const tags = normalizeTags(p.tags);
      if (!hasBohoTag(tags)) continue;
      let productId = null;
      for (const v of p.variants.edges) {
        productId = productIdFromSku(v.node.sku);
        if (productId) break;
      }
      found.push({
        productId,
        handle: p.handle || "",
        shopifyProductId: p.id,
        tags,
      });
    }
    if (!data.products.pageInfo.hasNextPage) break;
    cursor = data.products.pageInfo.endCursor;
  }
  return found;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function normTag(value) {
  return String(value || "").trim().toLowerCase();
}

function collectBohoFolderIds(scan) {
  const ids = new Set();
  const pathsById = new Map();
  for (const image of scan.images || []) {
    if (image.relevance !== "relevant") continue;
    const productId = productIdFromFilename(image.filename || image.id);
    if (!productId) continue;
    if (!(image.tags || []).some((t) => normTag(t) === FOLDER_TAG)) continue;
    ids.add(productId);
    if (!pathsById.has(productId)) pathsById.set(productId, []);
    if (image.relativePath) pathsById.get(productId).push(image.relativePath);
  }
  return { ids, pathsById };
}

function collectPathsById(scan) {
  const pathsById = new Map();
  for (const image of scan.images || []) {
    if (image.relevance !== "relevant") continue;
    const productId = productIdFromFilename(image.filename || image.id);
    if (!productId) continue;
    if (!pathsById.has(productId)) pathsById.set(productId, []);
    if (image.relativePath) pathsById.get(productId).push(image.relativePath);
  }
  return pathsById;
}

function hasBohoTag(tags) {
  return (tags || []).some((t) => normTag(t) === REMOVE_TAG_NORM);
}

function tagsWithoutBoho(tags) {
  return (tags || []).filter((t) => normTag(t) !== REMOVE_TAG_NORM);
}

function bohoTagsPresent(tags) {
  return (tags || []).filter((t) => normTag(t) === REMOVE_TAG_NORM);
}

async function fetchProductTags(storeDomain, accessToken, shopifyProductId) {
  const data = await shopifyGraphql(
    storeDomain,
    accessToken,
    `query ProductTags($id: ID!) {
      product(id: $id) {
        id
        handle
        tags
      }
    }`,
    { id: shopifyProductId }
  );
  if (!data.product) {
    throw new Error("Product not found on Shopify.");
  }
  return {
    shopifyProductId: data.product.id,
    handle: data.product.handle || "",
    tags: normalizeTags(data.product.tags),
  };
}

async function updateProductTags(storeDomain, accessToken, shopifyProductId, tags) {
  const data = await shopifyGraphql(
    storeDomain,
    accessToken,
    `mutation ProductUpdate($input: ProductInput!) {
      productUpdate(input: $input) {
        product { id handle tags }
        userErrors { field message }
      }
    }`,
    { input: { id: shopifyProductId, tags } }
  );
  const errors = data.productUpdate?.userErrors || [];
  if (errors.length) {
    throw new Error(errors.map((e) => e.message).join("; "));
  }
  return data.productUpdate.product;
}

async function main() {
  const { root, rescan, apply } = parseArgs();
  const rootPath = normalizeRootPath(root);
  const credentials = getShopifyCredentials();
  if (!credentials.storeDomain || !credentials.accessToken) {
    throw new Error("Shopify is not connected.");
  }

  console.log(`Root: ${rootPath}`);
  console.log(`Mode: ${apply ? "APPLY" : "DRY-RUN"}`);
  console.log("Remove tag: Boho (case-insensitive) from products NOT in Boho folder");

  let scan;
  if (rescan) {
    console.log("Scanning folder…");
    scan = scanCollectionRoot(rootPath);
    saveScanResult(scan);
    console.log(`Scanned ${scan.total} images`);
  } else {
    scan = getCachedScan(rootPath);
    if (!scan) {
      console.log("No cache; scanning folder…");
      scan = scanCollectionRoot(rootPath);
      saveScanResult(scan);
    } else {
      console.log(`Using cached scan from ${scan.scannedAt}`);
    }
  }

  const { ids: bohoFolderIds } = collectBohoFolderIds(scan);
  const allPaths = collectPathsById(scan);

  console.log(`Boho-folder products: ${bohoFolderIds.size}`);
  console.log("Searching Shopify for products tagged Boho…");
  const liveWithBoho = await fetchProductsWithBohoTag(
    credentials.storeDomain,
    credentials.accessToken
  );

  const targets = [];
  let withBohoTag = 0;
  let keptInBohoFolder = 0;
  let unknownId = 0;

  for (const entry of liveWithBoho) {
    withBohoTag += 1;
    const productId = entry.productId;
    if (productId && bohoFolderIds.has(productId)) {
      keptInBohoFolder += 1;
      continue;
    }
    if (!productId) unknownId += 1;
    targets.push({
      productId: productId || "",
      handle: entry.handle || "",
      shopifyProductId: entry.shopifyProductId,
      paths: productId ? allPaths.get(productId) || [] : [],
      tagsToRemove: bohoTagsPresent(entry.tags),
      currentTags: entry.tags,
    });
  }

  console.log(`Products with Boho tag (live): ${withBohoTag}`);
  console.log(`Kept (in Boho folder): ${keptInBohoFolder}`);
  console.log(`Targets (stray Boho tag): ${targets.length}`);
  if (unknownId) console.log(`Targets without resolvable product ID: ${unknownId}`);

  const results = [];
  let updated = 0;
  let skipped = 0;
  const errors = [];

  for (let i = 0; i < targets.length; i++) {
    const row = targets[i];
    process.stdout.write(`[${i + 1}/${targets.length}] ${row.productId} ${row.handle}… `);

    try {
      const live = await fetchProductTags(
        credentials.storeDomain,
        credentials.accessToken,
        row.shopifyProductId
      );
      const liveRemove = bohoTagsPresent(live.tags);
      if (!liveRemove.length) {
        console.log("skip (no Boho tag live)");
        skipped += 1;
        results.push({ ...row, status: "skip", liveTags: live.tags, tagsRemoved: [] });
        continue;
      }

      const nextTags = tagsWithoutBoho(live.tags);
      if (!apply) {
        console.log(`dry-run remove [${liveRemove.join(", ")}]`);
        results.push({
          ...row,
          status: "dry-run",
          liveTags: live.tags,
          tagsToRemove: liveRemove,
          tagsAfter: nextTags,
        });
        continue;
      }

      const product = await updateProductTags(
        credentials.storeDomain,
        credentials.accessToken,
        row.shopifyProductId,
        nextTags
      );
      updated += 1;
      console.log(`removed [${liveRemove.join(", ")}]`);
      results.push({
        productId: row.productId,
        handle: product.handle || row.handle,
        shopifyProductId: product.id,
        paths: row.paths,
        status: "updated",
        tagsRemoved: liveRemove,
        tagsAfter: normalizeTags(product.tags),
      });
      await sleep(150);
    } catch (error) {
      skipped += 1;
      console.log(`ERROR: ${error.message}`);
      errors.push({
        productId: row.productId,
        handle: row.handle,
        message: error.message || "Failed",
      });
      results.push({ ...row, status: "error", message: error.message });
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    mode: apply ? "apply" : "dry-run",
    rootPath,
    collectionRule: { column: "TAG", relation: "EQUALS", condition: "Boho" },
    summary: {
      bohoFolderProducts: bohoFolderIds.size,
      productsWithBohoTagLive: withBohoTag,
      keptInBohoFolder,
      targets: targets.length,
      updated,
      skipped,
      errors: errors.length,
    },
    results,
  };

  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), "utf8");
  console.log(`\nReport: ${REPORT_PATH}`);
  console.log(JSON.stringify(report.summary, null, 2));

  if (!apply) {
    console.log("\nDry-run only. Re-run with --apply to remove tags.");
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
