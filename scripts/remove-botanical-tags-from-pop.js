#!/usr/bin/env node
/**
 * Remove Botanical Prints rule tags from products that have any Pop collection rule tag.
 *
 * Pop collection (OR): pop | pop art | pop art. | pop culture
 * Botanical tags removed: botanical | flower | Botanical Prints
 *
 * Usage:
 *   node scripts/remove-botanical-tags-from-pop.js
 *   node scripts/remove-botanical-tags-from-pop.js --no-refresh
 *   node scripts/remove-botanical-tags-from-pop.js --apply
 *
 * Report: ~/.editpro/pop-botanical-tag-remove-report.json
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { getShopifyCredentials } = require("../lib/config-store");
const { shopifyGraphql } = require("../lib/shopify-client");
const {
  syncShopifyProductIndex,
  loadLiveProductIndex,
  normalizeTags,
} = require("../lib/shopify-live-product-index");

const CONFIG_DIR = path.join(os.homedir(), ".editpro");
const REPORT_PATH = path.join(CONFIG_DIR, "pop-botanical-tag-remove-report.json");

const POP_RULE_NORM = new Set(["pop", "pop art", "pop art.", "pop culture"]);
const BOT_RULE_NORM = new Set(["botanical", "flower", "botanical prints"]);

function parseArgs(argv = process.argv.slice(2)) {
  let refresh = true;
  let apply = false;
  for (const arg of argv) {
    if (arg === "--apply") apply = true;
    else if (arg === "--no-refresh") refresh = false;
  }
  return { refresh, apply };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function normTag(value) {
  return String(value || "").trim().toLowerCase();
}

function matchingTags(tags, ruleSet) {
  return (tags || []).filter((t) => ruleSet.has(normTag(t)));
}

function tagsWithoutBot(tags) {
  return (tags || []).filter((t) => !BOT_RULE_NORM.has(normTag(t)));
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
  const { refresh, apply } = parseArgs();
  const credentials = getShopifyCredentials();
  if (!credentials.storeDomain || !credentials.accessToken) {
    throw new Error("Shopify is not connected.");
  }

  console.log(`Mode: ${apply ? "APPLY" : "DRY-RUN"}`);
  console.log("Select: any Pop rule tag (pop / pop art / pop art. / pop culture)");
  console.log("Remove: botanical / flower / Botanical Prints");

  if (refresh) {
    console.log("Refreshing Shopify product index (tags)…");
    const prodSync = await syncShopifyProductIndex();
    console.log(
      `Products scanned: ${prodSync.shopifyProductsScanned}, unique IDs: ${prodSync.uniqueProductIds}`
    );
  }

  const liveIndex = loadLiveProductIndex();
  const products = liveIndex.products || {};

  let withPop = 0;
  const targets = [];

  for (const [productId, entry] of Object.entries(products)) {
    if (!entry?.shopifyProductId) continue;
    const tags = normalizeTags(entry.tags);
    const popTags = matchingTags(tags, POP_RULE_NORM);
    if (!popTags.length) continue;
    withPop += 1;
    const botTags = matchingTags(tags, BOT_RULE_NORM);
    if (!botTags.length) continue;
    targets.push({
      productId,
      handle: entry.handle || "",
      shopifyProductId: entry.shopifyProductId,
      popTags,
      tagsToRemove: botTags,
      currentTags: tags,
    });
  }

  console.log(`Products with Pop rule tag: ${withPop}`);
  console.log(`Targets (also have Botanical rule tags): ${targets.length}`);

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
      const livePop = matchingTags(live.tags, POP_RULE_NORM);
      const liveRemove = matchingTags(live.tags, BOT_RULE_NORM);

      if (!livePop.length) {
        console.log("skip (no Pop rule tag live)");
        skipped += 1;
        results.push({ ...row, status: "skip", reason: "no-pop-live", liveTags: live.tags });
        continue;
      }
      if (!liveRemove.length) {
        console.log("skip (no Botanical rule tags live)");
        skipped += 1;
        results.push({ ...row, status: "skip", reason: "no-bot-live", liveTags: live.tags });
        continue;
      }

      const nextTags = tagsWithoutBot(live.tags);
      if (!apply) {
        console.log(`dry-run remove [${liveRemove.join(", ")}]`);
        results.push({
          ...row,
          status: "dry-run",
          popTags: livePop,
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
        status: "updated",
        popTags: livePop,
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
    popRuleTags: ["pop", "pop art", "pop art.", "pop culture"],
    botanicalRuleTagsRemoved: ["botanical", "flower", "Botanical Prints"],
    summary: {
      productsWithPopRuleTag: withPop,
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
