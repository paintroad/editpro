#!/usr/bin/env node
/**
 * Delete Shopify products whose variant SKUs start with listed numeric IDs.
 *
 * Usage:
 *   node scripts/delete-products-by-sku-ids.js
 *   node scripts/delete-products-by-sku-ids.js --apply
 *
 * Report: ~/.editpro/delete-products-by-sku-ids-report.json
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { getShopifyCredentials } = require("../lib/config-store");
const { shopifyGraphql } = require("../lib/shopify-client");

const CONFIG_DIR = path.join(os.homedir(), ".editpro");
const REPORT_PATH = path.join(CONFIG_DIR, "delete-products-by-sku-ids-report.json");

/** Inclusive ranges of 5-digit product SKU prefixes to delete. */
const SKU_ID_RANGES = [
  [12390, 12393],
  [12395, 12400],
  [12402, 12405],
  [12407, 12414],
  [12416, 12421],
  [12423, 12428],
  [12430, 12431],
];

function expandSkuIds(ranges) {
  const ids = [];
  for (const [start, end] of ranges) {
    for (let n = start; n <= end; n += 1) {
      ids.push(String(n));
    }
  }
  return ids;
}

function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findProductBySkuPrefix(storeDomain, accessToken, skuId) {
  const data = await shopifyGraphql(
    storeDomain,
    accessToken,
    `query ProductBySkuPrefix($query: String!) {
      productVariants(first: 5, query: $query) {
        nodes {
          sku
          product {
            id
            title
            handle
            status
          }
        }
      }
    }`,
    { query: `sku:${skuId}*` }
  );

  const nodes = data.productVariants?.nodes || [];
  const prefix = `${skuId}-`;
  const exactPrefix = String(skuId);

  for (const node of nodes) {
    const sku = String(node?.sku || "");
    const product = node?.product;
    if (!product?.id) continue;
    // Prefer SKUs that start with "{id}-" (e.g. 12390-XS-1)
    if (sku === exactPrefix || sku.startsWith(prefix) || sku.startsWith(`${skuId}_`)) {
      return {
        skuId,
        productId: product.id,
        title: product.title || "",
        handle: product.handle || "",
        status: product.status || "",
        sampleSku: sku,
      };
    }
  }

  // Fallback: first result if Shopify query was tight enough
  const first = nodes[0];
  if (first?.product?.id && String(first.sku || "").startsWith(exactPrefix)) {
    return {
      skuId,
      productId: first.product.id,
      title: first.product.title || "",
      handle: first.product.handle || "",
      status: first.product.status || "",
      sampleSku: first.sku || "",
    };
  }

  return null;
}

async function deleteProduct(storeDomain, accessToken, productId) {
  const data = await shopifyGraphql(
    storeDomain,
    accessToken,
    `mutation ProductDelete($input: ProductDeleteInput!) {
      productDelete(input: $input) {
        deletedProductId
        userErrors { field message }
      }
    }`,
    { input: { id: productId } }
  );

  const errors = data.productDelete?.userErrors || [];
  if (errors.length) {
    throw new Error(errors.map((e) => e.message).join("; "));
  }
  return data.productDelete?.deletedProductId || null;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const credentials = getShopifyCredentials();
  if (!credentials.storeDomain || !credentials.accessToken) {
    throw new Error("Shopify is not connected. Add credentials in EditPro Settings.");
  }

  ensureConfigDir();
  const skuIds = expandSkuIds(SKU_ID_RANGES);
  console.log(`Store: ${credentials.storeDomain}`);
  console.log(`Mode: ${apply ? "APPLY (DELETE)" : "DRY-RUN"}`);
  console.log(`SKU IDs: ${skuIds.length}`);
  console.log("");

  const results = [];
  let found = 0;
  let missing = 0;
  let deleted = 0;
  let errors = 0;
  const seenProductIds = new Set();

  for (let i = 0; i < skuIds.length; i += 1) {
    const skuId = skuIds[i];
    process.stdout.write(`[${i + 1}/${skuIds.length}] ${skuId}… `);

    try {
      const match = await findProductBySkuPrefix(
        credentials.storeDomain,
        credentials.accessToken,
        skuId
      );

      if (!match) {
        missing += 1;
        console.log("MISSING");
        results.push({ skuId, status: "missing" });
        continue;
      }

      found += 1;
      const entry = {
        skuId,
        productId: match.productId,
        handle: match.handle,
        title: match.title,
        status: match.status,
        sampleSku: match.sampleSku,
      };

      if (seenProductIds.has(match.productId)) {
        console.log(`SKIP duplicate product ${match.handle}`);
        results.push({ ...entry, status: "duplicate-skip" });
        continue;
      }
      seenProductIds.add(match.productId);

      if (!apply) {
        console.log(`PLAN delete ${match.handle} (${match.title})`);
        results.push({ ...entry, status: "planned" });
        continue;
      }

      const deletedId = await deleteProduct(
        credentials.storeDomain,
        credentials.accessToken,
        match.productId
      );
      deleted += 1;
      console.log(`DELETED ${match.handle} (${deletedId || match.productId})`);
      results.push({ ...entry, status: "deleted", deletedProductId: deletedId });
      await sleep(200);
    } catch (error) {
      errors += 1;
      console.log(`ERROR: ${error.message || error}`);
      results.push({
        skuId,
        status: "error",
        reason: error.message || String(error),
      });
    }
  }

  // Post-verify a few IDs when applying
  const verifySample = apply
    ? skuIds.filter((_, idx) => idx % 7 === 0 || idx === skuIds.length - 1)
    : [];
  const verifyResults = [];
  for (const skuId of verifySample) {
    const stillThere = await findProductBySkuPrefix(
      credentials.storeDomain,
      credentials.accessToken,
      skuId
    );
    verifyResults.push({
      skuId,
      stillPresent: Boolean(stillThere),
      handle: stillThere?.handle || null,
    });
  }

  const summary = {
    mode: apply ? "apply" : "dry-run",
    skuIdCount: skuIds.length,
    found,
    missing,
    planned: results.filter((r) => r.status === "planned").length,
    deleted,
    errors,
    uniqueProducts: seenProductIds.size,
    verifyStillPresent: verifyResults.filter((v) => v.stillPresent).length,
  };

  fs.writeFileSync(
    REPORT_PATH,
    JSON.stringify({ summary, results, verifyResults }, null, 2),
    "utf8"
  );

  console.log("");
  console.log("=== SUMMARY ===");
  console.log(`SKU IDs: ${summary.skuIdCount}`);
  console.log(`Found: ${summary.found}`);
  console.log(`Missing: ${summary.missing}`);
  console.log(`Unique products: ${summary.uniqueProducts}`);
  if (apply) {
    console.log(`Deleted: ${summary.deleted}`);
    console.log(`Verify still present: ${summary.verifyStillPresent}`);
  } else {
    console.log(`Planned deletes: ${summary.planned}`);
  }
  console.log(`Errors: ${summary.errors}`);
  console.log(`Report: ${REPORT_PATH}`);

  if (!apply) {
    console.log("");
    console.log("Dry-run complete. Re-run with --apply to permanently delete these products.");
  }

  if (apply && (summary.errors > 0 || summary.verifyStillPresent > 0)) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`Error: ${error.message || error}`);
  process.exit(1);
});
