#!/usr/bin/env node
/**
 * Sync variant price / compareAtPrice / cost from catalog templates to Shopify.
 *
 * Usage:
 *   node scripts/sync-variant-pricing.js
 *   node scripts/sync-variant-pricing.js --apply
 *   node scripts/sync-variant-pricing.js --apply --handles=soulful-serenity
 *   node scripts/sync-variant-pricing.js --limit=5 --apply
 *
 * Progress: ~/.editpro/sync-variant-pricing-progress.json
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { getShopifyCredentials } = require("../lib/config-store");
const { shopifyGraphql } = require("../lib/shopify-client");
const {
  pricingForVariant,
  normalizeFrame,
  normalizeShape,
  SQUARE_SIZES,
  RECTANGLE_SIZES,
  PRODUCT_DEFAULTS,
} = require("../lib/catalog-variant-templates");

const CONFIG_DIR = path.join(os.homedir(), ".editpro");
const PROGRESS_PATH = path.join(CONFIG_DIR, "sync-variant-pricing-progress.json");

function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv) {
  const apply = argv.includes("--apply");
  const reset = argv.includes("--reset");
  let limit = null;
  let concurrency = 4;
  let handles = [];
  for (const arg of argv) {
    if (arg.startsWith("--limit=")) {
      limit = Number(arg.slice("--limit=".length));
    }
    if (arg.startsWith("--concurrency=")) {
      concurrency = Math.max(1, Number(arg.slice("--concurrency=".length)) || 4);
    }
    if (arg.startsWith("--handles=")) {
      handles = arg
        .slice("--handles=".length)
        .split(",")
        .map((h) => h.trim())
        .filter(Boolean);
    }
  }
  return { apply, reset, limit, handles, concurrency };
}

async function mapPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }
  const n = Math.min(concurrency, Math.max(1, items.length));
  await Promise.all(Array.from({ length: n }, () => run()));
  return results;
}

function loadProgress() {
  if (!fs.existsSync(PROGRESS_PATH)) {
    return { doneProductIds: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(PROGRESS_PATH, "utf8"));
  } catch {
    return { doneProductIds: [] };
  }
}

function saveProgress(progress) {
  ensureConfigDir();
  fs.writeFileSync(PROGRESS_PATH, JSON.stringify(progress, null, 2), "utf8");
}

function sizeCodeFromLabel(label) {
  const text = String(label || "").trim();
  const prefix = text.match(/^(XS|S|M|L|XL)\b/i);
  if (prefix) {
    return prefix[1].toUpperCase();
  }
  for (const [code, sizeLabel] of Object.entries(SQUARE_SIZES)) {
    if (text === sizeLabel) return code;
  }
  for (const [code, sizeLabel] of Object.entries(RECTANGLE_SIZES)) {
    if (text === sizeLabel) return code;
  }
  return null;
}

function detectShapeFromSizeLabels(sizeLabels) {
  let squareHits = 0;
  let rectHits = 0;
  for (const label of sizeLabels || []) {
    const m = String(label || "").match(
      /(\d+(?:\.\d+)?)\s*"?\s*[x×]\s*"?\s*(\d+(?:\.\d+)?)/i
    );
    if (!m) continue;
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === b) squareHits += 1;
    else rectHits += 1;
  }
  return squareHits >= rectHits ? "square" : "rectangle";
}

function selectedValue(selectedOptions, name) {
  const target = String(name || "").toLowerCase();
  const hit = (selectedOptions || []).find(
    (o) => String(o.name || "").toLowerCase() === target
  );
  return hit ? String(hit.value || "") : "";
}

async function fetchProductPage(storeDomain, accessToken, cursor, query) {
  return shopifyGraphql(
    storeDomain,
    accessToken,
    `query Products($cursor: String, $query: String) {
      products(first: 25, after: $cursor, query: $query) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          title
          handle
          productType
          status
          options {
            name
            optionValues { name }
          }
          variants(first: 100) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id
              sku
              price
              compareAtPrice
              selectedOptions { name value }
              inventoryItem {
                id
                unitCost { amount currencyCode }
              }
            }
          }
        }
      }
    }`,
    { cursor: cursor || null, query: query || null }
  );
}

async function fetchAllVariants(storeDomain, accessToken, productId, firstPage) {
  const variants = [...(firstPage?.nodes || [])];
  let hasNext = Boolean(firstPage?.pageInfo?.hasNextPage);
  let cursor = firstPage?.pageInfo?.endCursor || null;
  while (hasNext) {
    const data = await shopifyGraphql(
      storeDomain,
      accessToken,
      `query MoreVariants($id: ID!, $cursor: String) {
        product(id: $id) {
          variants(first: 100, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id
              sku
              price
              compareAtPrice
              selectedOptions { name value }
              inventoryItem {
                id
                unitCost { amount currencyCode }
              }
            }
          }
        }
      }`,
      { id: productId, cursor }
    );
    const page = data.product?.variants;
    variants.push(...(page?.nodes || []));
    hasNext = Boolean(page?.pageInfo?.hasNextPage);
    cursor = page?.pageInfo?.endCursor || null;
  }
  return variants;
}

function planProductUpdates(product, variants) {
  const sizeOpt = (product.options || []).find(
    (o) => String(o.name || "").toLowerCase() === "size"
  );
  const sizeLabels = (sizeOpt?.optionValues || []).map((v) => v.name);
  const shape = normalizeShape(detectShapeFromSizeLabels(sizeLabels));

  const priceUpdates = [];
  const costUpdates = [];
  const samples = [];

  for (const variant of variants) {
    const sizeLabel = selectedValue(variant.selectedOptions, "Size");
    const frameLabel = selectedValue(variant.selectedOptions, "Frame");
    const materialLabel = selectedValue(variant.selectedOptions, "Material");
    const sizeCode = sizeCodeFromLabel(sizeLabel);
    const frame = normalizeFrame(frameLabel);
    if (!sizeCode || !frame) {
      continue;
    }

    const expected = materialLabel
      ? pricingForVariant(shape, sizeCode, materialLabel, frame)
      : pricingForVariant(shape, sizeCode, frame);
    if (!expected) continue;

    const currentPrice = Number(variant.price);
    const currentCompare =
      variant.compareAtPrice != null && variant.compareAtPrice !== ""
        ? Number(variant.compareAtPrice)
        : null;
    const currentCost =
      variant.inventoryItem?.unitCost?.amount != null
        ? Number(variant.inventoryItem.unitCost.amount)
        : null;

    const priceChanged =
      currentPrice !== Number(expected.price) ||
      currentCompare !== Number(expected.compareAt);
    const costChanged =
      expected.cost != null &&
      (currentCost == null || currentCost !== Number(expected.cost));

    if (priceChanged) {
      priceUpdates.push({
        id: variant.id,
        price: String(expected.price),
        compareAtPrice: String(expected.compareAt),
      });
    }
    if (costChanged && variant.inventoryItem?.id) {
      costUpdates.push({
        inventoryItemId: variant.inventoryItem.id,
        cost: expected.cost,
      });
    }

    if (
      samples.length < 8 &&
      (priceChanged || costChanged) &&
      (sizeCode === "M" || sizeCode === "L" || sizeCode === "XL")
    ) {
      samples.push({
        sku: variant.sku,
        sizeCode,
        frame,
        from: {
          price: currentPrice,
          compareAt: currentCompare,
          cost: currentCost,
        },
        to: expected,
      });
    }
  }

  return {
    shape,
    priceUpdates,
    costUpdates,
    samples,
    variantCount: variants.length,
  };
}

async function applyPriceUpdates(storeDomain, accessToken, productId, updates) {
  if (!updates.length) return;
  const chunkSize = 50;
  for (let i = 0; i < updates.length; i += chunkSize) {
    const chunk = updates.slice(i, i + chunkSize);
    const data = await shopifyGraphql(
      storeDomain,
      accessToken,
      `mutation ProductVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkUpdate(productId: $productId, variants: $variants) {
          productVariants { id }
          userErrors { field message }
        }
      }`,
      { productId, variants: chunk }
    );
    const errors = data.productVariantsBulkUpdate?.userErrors || [];
    if (errors.length) {
      throw new Error(errors.map((e) => e.message).join("; "));
    }
  }
}

async function applyCostUpdates(storeDomain, accessToken, updates, concurrency) {
  if (!updates.length) return;
  await mapPool(updates, Math.min(concurrency, 8), async (job) => {
    const data = await shopifyGraphql(
      storeDomain,
      accessToken,
      `mutation InventoryItemUpdate($id: ID!, $input: InventoryItemInput!) {
        inventoryItemUpdate(id: $id, input: $input) {
          userErrors { field message }
        }
      }`,
      {
        id: job.inventoryItemId,
        input: {
          cost: String(job.cost),
          tracked: true,
          requiresShipping: true,
          countryCodeOfOrigin: PRODUCT_DEFAULTS.countryOfOrigin,
        },
      }
    );
    const errors = data.inventoryItemUpdate?.userErrors || [];
    if (errors.length) {
      throw new Error(errors.map((e) => e.message).join("; "));
    }
  });
}

async function main() {
  const { apply, reset, limit, handles, concurrency } = parseArgs(
    process.argv.slice(2)
  );
  const { storeDomain, accessToken } = getShopifyCredentials();
  if (!storeDomain || !accessToken) {
    throw new Error("Missing Shopify credentials in ~/.editpro/config.json");
  }

  ensureConfigDir();
  let progress = reset ? { doneProductIds: [] } : loadProgress();
  if (reset) saveProgress(progress);

  const done = new Set(progress.doneProductIds || []);
  console.log(apply ? "Mode: APPLY" : "Mode: DRY-RUN (pass --apply to write)");
  console.log(`Concurrency: ${concurrency}`);
  if (handles.length) console.log(`Handles: ${handles.join(", ")}`);
  if (limit) console.log(`Limit: ${limit}`);
  console.log(`Already done: ${done.size}`);
  console.log("");

  const query =
    handles.length > 0
      ? handles.map((h) => `handle:${h}`).join(" OR ")
      : "product_type:Painting";

  let cursor = null;
  let processed = 0;
  let skippedDone = 0;
  let productsChanged = 0;
  let totalPriceUpdates = 0;
  let totalCostUpdates = 0;
  let errors = 0;

  do {
    const data = await fetchProductPage(storeDomain, accessToken, cursor, query);
    const connection = data.products;
    const nodes = connection?.nodes || [];

    for (const product of nodes) {
      if (limit != null && processed >= limit) break;
      if (done.has(product.id)) {
        skippedDone += 1;
        continue;
      }
      if (
        String(product.productType || "").toLowerCase() === "gift card" ||
        /gift\s*card/i.test(product.title || "")
      ) {
        done.add(product.id);
        continue;
      }

      processed += 1;
      try {
        const variants = await fetchAllVariants(
          storeDomain,
          accessToken,
          product.id,
          product.variants
        );
        const plan = planProductUpdates(product, variants);
        const changed =
          plan.priceUpdates.length > 0 || plan.costUpdates.length > 0;

        if (changed) {
          productsChanged += 1;
          totalPriceUpdates += plan.priceUpdates.length;
          totalCostUpdates += plan.costUpdates.length;
          console.log(
            `${product.handle} [${plan.shape}] variants=${plan.variantCount} priceΔ=${plan.priceUpdates.length} costΔ=${plan.costUpdates.length}`
          );
          for (const sample of plan.samples.slice(0, 3)) {
            console.log(
              `  ${sample.sku} ${sample.sizeCode} ${sample.frame}: ${sample.from.price}/${sample.from.compareAt}/${sample.from.cost} → ${sample.to.price}/${sample.to.compareAt}/${sample.to.cost}`
            );
          }
          if (apply) {
            await applyPriceUpdates(
              storeDomain,
              accessToken,
              product.id,
              plan.priceUpdates
            );
            await applyCostUpdates(
              storeDomain,
              accessToken,
              plan.costUpdates,
              concurrency
            );
          }
        }

        if (apply) {
          done.add(product.id);
          progress.doneProductIds = [...done];
          if (processed % 10 === 0) {
            saveProgress(progress);
          }
        }
      } catch (err) {
        errors += 1;
        console.error(`${product.handle}: ${err.message || err}`);
      }

      await sleep(50);
    }

    if (limit != null && processed >= limit) break;
    if (!connection?.pageInfo?.hasNextPage) break;
    cursor = connection.pageInfo.endCursor;
  } while (true);

  if (apply) {
    progress.doneProductIds = [...done];
    saveProgress(progress);
  }

  console.log("");
  console.log("Done:", {
    processed,
    skippedDone,
    productsChanged,
    totalPriceUpdates,
    totalCostUpdates,
    errors,
    apply,
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
