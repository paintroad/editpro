#!/usr/bin/env node
/**
 * Audit Shopify product tags against Prints_Categories folder membership.
 *
 * A tag is unauthorized when:
 *   - it appears in some smart collection's TAG EQUALS rule, AND
 *   - it is NOT among the folder-path segments for that product's #####.jpg
 *
 * Usage:
 *   node scripts/audit-collection-tags-vs-folder.js
 *   node scripts/audit-collection-tags-vs-folder.js --root="C:\Paintroad\Files\Prints_Categories"
 *   node scripts/audit-collection-tags-vs-folder.js --no-rescan --no-refresh
 *   node scripts/audit-collection-tags-vs-folder.js --apply
 *
 * Report: ~/.editpro/collection-tag-folder-audit-report.json
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
  syncShopifyCollectionsIndex,
  loadLiveCollectionsIndex,
  ensureLiveCollectionsIndex,
} = require("../lib/shopify-live-collections-index");
const {
  syncShopifyProductIndex,
  loadLiveProductIndex,
  normalizeTags,
} = require("../lib/shopify-live-product-index");
const { productIdFromFilename } = require("../lib/collections-shopify-tags");

const CONFIG_DIR = path.join(os.homedir(), ".editpro");
const REPORT_PATH = path.join(
  CONFIG_DIR,
  "collection-tag-folder-audit-report.json"
);
const DEFAULT_ROOT = "C:\\Paintroad\\Files\\Prints_Categories";

function parseArgs(argv = process.argv.slice(2)) {
  let root = DEFAULT_ROOT;
  let rescan = true;
  let refresh = true;
  let apply = false;
  for (const arg of argv) {
    if (arg === "--apply") apply = true;
    else if (arg === "--no-rescan") rescan = false;
    else if (arg === "--no-refresh") refresh = false;
    else if (arg.startsWith("--root=")) {
      root = arg.slice("--root=".length).replace(/^["']|["']$/g, "");
    }
  }
  return { root, rescan, refresh, apply };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function normTag(value) {
  return String(value || "").trim().toLowerCase();
}

function buildAllowedTagsFromScan(scan) {
  /** @type {Map<string, { tags: Set<string>, paths: string[] }>} */
  const byProduct = new Map();
  for (const image of scan.images || []) {
    if (image.relevance !== "relevant") continue;
    const productId = productIdFromFilename(image.filename || image.id);
    if (!productId) continue;
    if (!byProduct.has(productId)) {
      byProduct.set(productId, { tags: new Set(), paths: [] });
    }
    const entry = byProduct.get(productId);
    for (const tag of image.tags || []) {
      entry.tags.add(tag);
    }
    if (entry.paths.length < 5) {
      entry.paths.push(image.relativePath);
    }
  }
  return byProduct;
}

function buildCollectionTagIndex(collections) {
  /** @type {Map<string, { tag: string, collections: { id: string, title: string, handle: string }[] }>} */
  const byNorm = new Map();

  for (const collection of collections || []) {
    const rules = collection.ruleSet?.rules || [];
    for (const rule of rules) {
      if (String(rule.column || "").toUpperCase() !== "TAG") continue;
      if (String(rule.relation || "").toUpperCase() !== "EQUALS") continue;
      const tag = String(rule.condition || "").trim();
      if (!tag) continue;
      const key = normTag(tag);
      if (!byNorm.has(key)) {
        byNorm.set(key, { tag, collections: [] });
      }
      const bucket = byNorm.get(key);
      if (!bucket.collections.some((c) => c.id === collection.id)) {
        bucket.collections.push({
          id: collection.id,
          title: collection.title || "",
          handle: collection.handle || "",
        });
      }
    }
  }

  return { byNorm };
}

function findUnauthorizedTags(productTags, allowedTags, collectionTagIndex) {
  const allowedNorm = new Set([...allowedTags].map(normTag));
  const unauthorized = [];
  for (const tag of productTags) {
    const key = normTag(tag);
    const collEntry = collectionTagIndex.byNorm.get(key);
    if (!collEntry) continue; // not a collection-related tag
    if (allowedNorm.has(key)) continue; // allowed by folder
    unauthorized.push({
      tag,
      collectionsAffected: collEntry.collections,
    });
  }
  return unauthorized;
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
  const { root, rescan, refresh, apply } = parseArgs();
  const rootPath = normalizeRootPath(root);
  const credentials = getShopifyCredentials();
  if (!credentials.storeDomain || !credentials.accessToken) {
    throw new Error("Shopify is not connected.");
  }

  console.log(`Root: ${rootPath}`);
  console.log(`Mode: ${apply ? "APPLY (remove unauthorized tags)" : "DRY-RUN"}`);

  let scan;
  if (rescan) {
    console.log("Scanning folder…");
    scan = scanCollectionRoot(rootPath);
    saveScanResult(scan);
    console.log(`Scanned ${scan.total} images, ${scan.tagOptions.length} folder tags`);
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

  const folderTagNorm = new Set((scan.tagOptions || []).map(normTag));

  if (refresh) {
    console.log("Refreshing Shopify collections index…");
    const collSync = await syncShopifyCollectionsIndex();
    console.log(`Collections: ${collSync.collectionCount}`);
    console.log("Refreshing Shopify product index (tags)…");
    const prodSync = await syncShopifyProductIndex();
    console.log(
      `Products scanned: ${prodSync.shopifyProductsScanned}, unique IDs: ${prodSync.uniqueProductIds}`
    );
  } else {
    await ensureLiveCollectionsIndex({ refresh: false });
  }

  const liveCollections = loadLiveCollectionsIndex();
  const liveProducts = loadLiveProductIndex();
  const collectionTagIndex = buildCollectionTagIndex(liveCollections.collections);
  const allowedByProduct = buildAllowedTagsFromScan(scan);

  console.log(
    `Folder products: ${allowedByProduct.size} | Collection-related tags: ${collectionTagIndex.byNorm.size}`
  );

  const rows = [];
  const byCollection = {};
  const byUnauthorizedTag = {};
  let productsWithBadTags = 0;
  let missingOnShopify = 0;
  const looseRuleTags = [];

  for (const [tagKey, entry] of collectionTagIndex.byNorm.entries()) {
    if (!folderTagNorm.has(tagKey)) {
      looseRuleTags.push({
        tag: entry.tag,
        collections: entry.collections.map((c) => c.title),
      });
    }
  }

  for (const [productId, folderEntry] of allowedByProduct.entries()) {
    const live = liveProducts.products?.[productId];
    if (!live?.shopifyProductId) {
      missingOnShopify += 1;
      continue;
    }
    const currentTags = normalizeTags(live.tags);
    const unauthorized = findUnauthorizedTags(
      currentTags,
      folderEntry.tags,
      collectionTagIndex
    );
    if (!unauthorized.length) continue;

    productsWithBadTags += 1;
    for (const u of unauthorized) {
      for (const col of u.collectionsAffected) {
        byCollection[col.title] = (byCollection[col.title] || 0) + 1;
      }
      byUnauthorizedTag[u.tag] = (byUnauthorizedTag[u.tag] || 0) + 1;
      rows.push({
        productId,
        handle: live.handle || "",
        shopifyProductId: live.shopifyProductId,
        unauthorizedTag: u.tag,
        collectionsAffected: u.collectionsAffected.map((c) => c.title),
        allowedTags: [...folderEntry.tags].sort(),
        pathExamples: folderEntry.paths,
        currentTags,
      });
    }
  }

  // Spotlight: Botanical vs Boho
  const botanicalSpotlight = rows.filter((r) => {
    const allowed = new Set(r.allowedTags.map(normTag));
    const inBoho = allowed.has("boho");
    const hitsBotanical = r.collectionsAffected.some((t) =>
      /botanical/i.test(t)
    );
    return inBoho && hitsBotanical;
  });

  const sortedCollections = Object.entries(byCollection).sort(
    (a, b) => b[1] - a[1]
  );
  const sortedTags = Object.entries(byUnauthorizedTag).sort(
    (a, b) => b[1] - a[1]
  );

  const report = {
    generatedAt: new Date().toISOString(),
    apply,
    rootPath,
    sources: {
      folderScannedAt: scan.scannedAt,
      collectionsSyncedAt: liveCollections.syncedAt,
      productsSyncedAt: liveProducts.syncedAt,
    },
    summary: {
      folderProducts: allowedByProduct.size,
      collectionRelatedTags: collectionTagIndex.byNorm.size,
      productsWithUnauthorizedTags: productsWithBadTags,
      unauthorizedTagInstances: rows.length,
      missingOnShopify,
      looseRuleTagsNotInFolder: looseRuleTags.length,
    },
    byCollection: Object.fromEntries(sortedCollections),
    byUnauthorizedTag: Object.fromEntries(sortedTags),
    looseRuleTags,
    botanicalBohoCrossContamination: {
      count: botanicalSpotlight.length,
      sample: botanicalSpotlight.slice(0, 40),
    },
    rows,
  };

  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), "utf8");

  console.log("\n=== Summary ===");
  console.log(JSON.stringify(report.summary, null, 2));
  console.log("\nTop collections affected (unauthorized tag instances):");
  for (const [title, count] of sortedCollections.slice(0, 15)) {
    console.log(`  ${count}\t${title}`);
  }
  console.log("\nTop unauthorized tags:");
  for (const [tag, count] of sortedTags.slice(0, 15)) {
    console.log(`  ${count}\t${tag}`);
  }
  console.log(
    `\nBotanical∩Boho cross-contamination rows: ${botanicalSpotlight.length}`
  );
  console.log(
    `\nLoose collection rule tags (not a folder name): ${looseRuleTags.length}`
  );
  for (const item of looseRuleTags.slice(0, 20)) {
    console.log(`  "${item.tag}" → ${item.collections.join(", ")}`);
  }

  if (apply) {
    // Group removals by product
    /** @type {Map<string, { shopifyProductId: string, handle: string, remove: Set<string>, keep: string[] }>} */
    const byProduct = new Map();
    for (const row of rows) {
      if (!byProduct.has(row.productId)) {
        byProduct.set(row.productId, {
          shopifyProductId: row.shopifyProductId,
          handle: row.handle,
          remove: new Set(),
          keep: row.currentTags,
        });
      }
      byProduct.get(row.productId).remove.add(row.unauthorizedTag);
    }

    let updated = 0;
    const errors = [];
    let i = 0;
    for (const [productId, entry] of byProduct.entries()) {
      i += 1;
      const removeNorm = new Set([...entry.remove].map(normTag));
      const nextTags = entry.keep.filter((t) => !removeNorm.has(normTag(t)));
      try {
        await updateProductTags(
          credentials.storeDomain,
          credentials.accessToken,
          entry.shopifyProductId,
          nextTags
        );
        updated += 1;
      } catch (err) {
        errors.push({
          productId,
          handle: entry.handle,
          error: err?.message || String(err),
        });
      }
      if (i % 25 === 0 || i === byProduct.size) {
        process.stdout.write(
          `\rRemoved tags on ${updated}/${byProduct.size} products (errors ${errors.length})   `
        );
      }
      await sleep(80);
    }
    process.stdout.write("\n");
    report.applyResult = {
      productsUpdated: updated,
      errors,
    };
    fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), "utf8");
    console.log(`Apply done: ${updated} products updated, ${errors.length} errors`);
  } else {
    console.log(
      "\nDry-run only. Re-run with --apply to remove unauthorized collection tags."
    );
  }

  console.log(`\nReport: ${REPORT_PATH}`);
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
