#!/usr/bin/env node
/**
 * Remove Botanical Prints rule tags from products in selected folder(s).
 *
 * Tags removed (case-insensitive): botanical, flower, Botanical Prints
 * All other tags (including the folder tag) are kept. Other folders untouched.
 *
 * Usage:
 *   node scripts/remove-botanical-tags-from-boho.js
 *   node scripts/remove-botanical-tags-from-boho.js --folders=Boho
 *   node scripts/remove-botanical-tags-from-boho.js --folders=Bauhaus,"Picasso Inspired" --apply
 *   node scripts/remove-botanical-tags-from-boho.js --no-rescan --no-refresh --apply
 *
 * Report: ~/.editpro/<report-name>.json (default boho-botanical-tag-remove-report.json)
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
const {
  syncShopifyProductIndex,
  loadLiveProductIndex,
  normalizeTags,
} = require("../lib/shopify-live-product-index");
const { productIdFromFilename } = require("../lib/collections-shopify-tags");

const CONFIG_DIR = path.join(os.homedir(), ".editpro");
const DEFAULT_ROOT = "C:\\Paintroad\\Files\\Prints_Categories";
const RULE_TAGS_NORM = new Set(["botanical", "flower", "botanical prints"]);

function parseFoldersArg(raw) {
  // Split on commas that are not inside quotes
  const parts = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '"' || ch === "'") {
      inQuotes = !inQuotes;
      continue;
    }
    if (ch === "," && !inQuotes) {
      if (current.trim()) parts.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function parseArgs(argv = process.argv.slice(2)) {
  let root = DEFAULT_ROOT;
  let rescan = true;
  let refresh = true;
  let apply = false;
  let folders = [];
  let reportName = "";
  for (const arg of argv) {
    if (arg === "--apply") apply = true;
    else if (arg === "--no-rescan") rescan = false;
    else if (arg === "--no-refresh") refresh = false;
    else if (arg.startsWith("--root=")) {
      root = arg.slice("--root=".length).replace(/^["']|["']$/g, "");
    } else if (arg.startsWith("--folders=")) {
      folders.push(...parseFoldersArg(arg.slice("--folders=".length)));
    } else if (arg.startsWith("--report=")) {
      reportName = arg.slice("--report=".length).replace(/^["']|["']$/g, "");
      if (!reportName.endsWith(".json")) reportName += ".json";
    }
  }
  if (!folders.length) folders = ["Boho"];
  if (!reportName) {
    const slug = folders
      .map((f) =>
        String(f)
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "")
      )
      .join("-");
    reportName = `${slug || "folder"}-botanical-tag-remove-report.json`;
  }
  return { root, rescan, refresh, apply, folders, reportName };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function normTag(value) {
  return String(value || "").trim().toLowerCase();
}

function collectFolderProducts(scan, folderNames) {
  const folderNorm = new Set(folderNames.map(normTag));
  /** @type {Map<string, { paths: string[], matchedFolders: Set<string> }>} */
  const byProduct = new Map();
  for (const image of scan.images || []) {
    if (image.relevance !== "relevant") continue;
    const productId = productIdFromFilename(image.filename || image.id);
    if (!productId) continue;
    const tags = image.tags || [];
    const matched = tags.filter((t) => folderNorm.has(normTag(t)));
    if (!matched.length) continue;
    if (!byProduct.has(productId)) {
      byProduct.set(productId, { paths: [], matchedFolders: new Set() });
    }
    const entry = byProduct.get(productId);
    for (const m of matched) entry.matchedFolders.add(m);
    if (image.relativePath) {
      entry.paths.push(image.relativePath);
    }
  }
  return byProduct;
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

function tagsToRemove(tags) {
  return tags.filter((t) => RULE_TAGS_NORM.has(normTag(t)));
}

function tagsAfterRemoval(tags) {
  return tags.filter((t) => !RULE_TAGS_NORM.has(normTag(t)));
}

async function main() {
  const { root, rescan, refresh, apply, folders, reportName } = parseArgs();
  const rootPath = normalizeRootPath(root);
  const reportPath = path.join(CONFIG_DIR, reportName);
  const credentials = getShopifyCredentials();
  if (!credentials.storeDomain || !credentials.accessToken) {
    throw new Error("Shopify is not connected.");
  }

  console.log(`Root: ${rootPath}`);
  console.log(`Mode: ${apply ? "APPLY" : "DRY-RUN"}`);
  console.log(`Folders: ${folders.join(", ")}`);
  console.log("Remove: botanical / flower / Botanical Prints");

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

  if (refresh) {
    console.log("Refreshing Shopify product index (tags)…");
    const prodSync = await syncShopifyProductIndex();
    console.log(
      `Products scanned: ${prodSync.shopifyProductsScanned}, unique IDs: ${prodSync.uniqueProductIds}`
    );
  }

  const folderMap = collectFolderProducts(scan, folders);
  const liveIndex = loadLiveProductIndex();
  const products = liveIndex.products || {};

  console.log(`Folder products: ${folderMap.size}`);

  const targets = [];
  const missing = [];

  for (const [productId, meta] of folderMap) {
    const entry = products[productId];
    if (!entry?.shopifyProductId) {
      missing.push({ productId, paths: meta.paths, reason: "not in live product index" });
      continue;
    }
    const currentTags = normalizeTags(entry.tags);
    const remove = tagsToRemove(currentTags);
    if (!remove.length) continue;
    targets.push({
      productId,
      handle: entry.handle || "",
      shopifyProductId: entry.shopifyProductId,
      paths: meta.paths,
      matchedFolders: [...meta.matchedFolders].sort(),
      currentTags,
      tagsToRemove: remove,
      tagsAfter: tagsAfterRemoval(currentTags),
    });
  }

  console.log(`Targets (have botanical rule tags): ${targets.length}`);
  console.log(`Missing from index: ${missing.length}`);

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
      const liveRemove = tagsToRemove(live.tags);
      if (!liveRemove.length) {
        console.log("skip (no rule tags live)");
        skipped += 1;
        results.push({
          ...row,
          status: "skip",
          liveTags: live.tags,
          tagsRemoved: [],
        });
        continue;
      }

      const nextTags = tagsAfterRemoval(live.tags);
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
        matchedFolders: row.matchedFolders,
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
    folderTags: folders,
    ruleTagsRemoved: ["botanical", "flower", "Botanical Prints"],
    summary: {
      folderProducts: folderMap.size,
      targets: targets.length,
      missing: missing.length,
      updated,
      skipped,
      errors: errors.length,
    },
    missing,
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
