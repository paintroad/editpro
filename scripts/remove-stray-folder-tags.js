#!/usr/bin/env node
/**
 * Remove a collection tag from products that are NOT in the matching folder.
 *
 * Uses live Shopify tag search (more reliable than the local product index for casing)
 * and Prints_Categories folder segments as source of truth.
 *
 * Usage:
 *   node scripts/remove-stray-folder-tags.js --folder=Bauhaus --tag=bauhaus
 *   node scripts/remove-stray-folder-tags.js --folder=Bauhaus --tag=bauhaus --apply
 *   node scripts/remove-stray-folder-tags.js --folder=Boho --tag=Boho --no-rescan --apply
 *
 * Report: ~/.editpro/<folder>-tag-stray-remove-report.json
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
const DEFAULT_ROOT = "C:\\Paintroad\\Files\\Prints_Categories";

function parseArgs(argv = process.argv.slice(2)) {
  let root = DEFAULT_ROOT;
  let rescan = true;
  let apply = false;
  let folder = "";
  let tag = "";
  for (const arg of argv) {
    if (arg === "--apply") apply = true;
    else if (arg === "--no-rescan") rescan = false;
    else if (arg.startsWith("--root=")) {
      root = arg.slice("--root=".length).replace(/^["']|["']$/g, "");
    } else if (arg.startsWith("--folder=")) {
      folder = arg.slice("--folder=".length).replace(/^["']|["']$/g, "");
    } else if (arg.startsWith("--tag=")) {
      tag = arg.slice("--tag=".length).replace(/^["']|["']$/g, "");
    }
  }
  if (!folder) throw new Error("Required: --folder=Name");
  if (!tag) tag = folder;
  return { root, rescan, apply, folder, tag };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function normTag(value) {
  return String(value || "").trim().toLowerCase();
}

function productIdFromSku(sku) {
  const m = String(sku || "").match(/(\d{5})/);
  return m ? m[1] : null;
}

function hasTargetTag(tags, tagNorm) {
  return (tags || []).some((t) => normTag(t) === tagNorm);
}

function tagsWithoutTarget(tags, tagNorm) {
  return (tags || []).filter((t) => normTag(t) !== tagNorm);
}

function targetTagsPresent(tags, tagNorm) {
  return (tags || []).filter((t) => normTag(t) === tagNorm);
}

function collectFolderIds(scan, folderNorm) {
  const ids = new Set();
  for (const image of scan.images || []) {
    if (image.relevance !== "relevant") continue;
    const productId = productIdFromFilename(image.filename || image.id);
    if (!productId) continue;
    if (!(image.tags || []).some((t) => normTag(t) === folderNorm)) continue;
    ids.add(productId);
  }
  return ids;
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

async function fetchProductsWithTag(storeDomain, accessToken, tag, tagNorm) {
  // Shopify search: use both original and lowercased forms
  const search = `tag:${tag} OR tag:${tagNorm}`;
  const found = [];
  let cursor = null;
  for (;;) {
    const data = await shopifyGraphql(
      storeDomain,
      accessToken,
      `query($cursor: String, $q: String!) {
        products(first: 100, query: $q, after: $cursor) {
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
      { cursor, q: search }
    );
    for (const edge of data.products.edges) {
      const p = edge.node;
      const tags = normalizeTags(p.tags);
      if (!hasTargetTag(tags, tagNorm)) continue;
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

async function fetchProductTags(storeDomain, accessToken, shopifyProductId) {
  const data = await shopifyGraphql(
    storeDomain,
    accessToken,
    `query ProductTags($id: ID!) {
      product(id: $id) { id handle tags }
    }`,
    { id: shopifyProductId }
  );
  if (!data.product) throw new Error("Product not found on Shopify.");
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
  if (errors.length) throw new Error(errors.map((e) => e.message).join("; "));
  return data.productUpdate.product;
}

async function main() {
  const { root, rescan, apply, folder, tag } = parseArgs();
  const folderNorm = normTag(folder);
  const tagNorm = normTag(tag);
  const rootPath = normalizeRootPath(root);
  const slug = folderNorm.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const reportPath = path.join(CONFIG_DIR, `${slug}-tag-stray-remove-report.json`);

  const credentials = getShopifyCredentials();
  if (!credentials.storeDomain || !credentials.accessToken) {
    throw new Error("Shopify is not connected.");
  }

  console.log(`Root: ${rootPath}`);
  console.log(`Mode: ${apply ? "APPLY" : "DRY-RUN"}`);
  console.log(`Folder truth: ${folder}`);
  console.log(`Remove tag: ${tag} (case-insensitive) from products NOT in that folder`);

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

  const folderIds = collectFolderIds(scan, folderNorm);
  const allPaths = collectPathsById(scan);

  console.log(`${folder}-folder products: ${folderIds.size}`);
  console.log(`Searching Shopify for products tagged ${tag}…`);
  const liveTagged = await fetchProductsWithTag(
    credentials.storeDomain,
    credentials.accessToken,
    tag,
    tagNorm
  );

  const targets = [];
  let withTag = 0;
  let keptInFolder = 0;
  let unknownId = 0;

  for (const entry of liveTagged) {
    withTag += 1;
    const productId = entry.productId;
    if (productId && folderIds.has(productId)) {
      keptInFolder += 1;
      continue;
    }
    if (!productId) unknownId += 1;
    targets.push({
      productId: productId || "",
      handle: entry.handle || "",
      shopifyProductId: entry.shopifyProductId,
      paths: productId ? allPaths.get(productId) || [] : [],
      tagsToRemove: targetTagsPresent(entry.tags, tagNorm),
      currentTags: entry.tags,
    });
  }

  console.log(`Products with ${tag} tag (live): ${withTag}`);
  console.log(`Kept (in ${folder} folder): ${keptInFolder}`);
  console.log(`Targets (stray ${tag} tag): ${targets.length}`);
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
      const liveRemove = targetTagsPresent(live.tags, tagNorm);
      if (!liveRemove.length) {
        console.log(`skip (no ${tag} tag live)`);
        skipped += 1;
        results.push({ ...row, status: "skip", tagsRemoved: [] });
        continue;
      }

      const nextTags = tagsWithoutTarget(live.tags, tagNorm);
      if (!apply) {
        console.log(`dry-run remove [${liveRemove.join(", ")}]`);
        results.push({
          ...row,
          status: "dry-run",
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
    folder,
    tag,
    collectionRule: { column: "TAG", relation: "EQUALS", condition: tag },
    summary: {
      folderProducts: folderIds.size,
      productsWithTagLive: withTag,
      keptInFolder,
      targets: targets.length,
      updated,
      skipped,
      errors: errors.length,
    },
    results,
  };

  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");
  console.log(`\nReport: ${reportPath}`);
  console.log(JSON.stringify(report.summary, null, 2));

  if (!apply) {
    console.log("\nDry-run only. Re-run with --apply to remove tags.");
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
