#!/usr/bin/env node
/**
 * Assign Shopify shipping packages to variants by Size option (frame inches).
 *
 * PARKED: store-wide --apply is on hold (see ~/.editpro/package-rollout-parked.json).
 * Smoke test already done on soulful-serenity. Resume store-wide when park is cleared.
 *
 * Defensive: when applying, re-sends the variant's current inventory weight together with
 * shippingPackageId so Shopify cannot clear weight if measurement is replaced.
 *
 * Usage:
 *   node scripts/set-variant-package-dimensions.js
 *   node scripts/set-variant-package-dimensions.js --product=soulful-serenity
 *   node scripts/set-variant-package-dimensions.js --product=soulful-serenity --apply
 *   node scripts/set-variant-package-dimensions.js --apply
 *   node scripts/set-variant-package-dimensions.js --sizes=12x16,36x48 --apply
 *
 * Report: ~/.editpro/variant-package-dimensions-report.json
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { getShopifyCredentials } = require("../lib/config-store");
const { shopifyGraphql } = require("../lib/shopify-client");
const {
  CONFIG_DIR,
  FRAME_BOX_CM,
  loadShippingPackageMap,
  sizeKeyFromOptionValue,
  optionValue,
  packageGidForSizeKey,
} = require("../lib/package-dimensions");

const UNSTABLE_API = "unstable";

const REPORT_PATH = path.join(
  CONFIG_DIR,
  "variant-package-dimensions-report.json"
);

const INVENTORY_ITEM_UPDATE = `mutation InventoryItemUpdate($id: ID!, $input: InventoryItemInput!) {
  inventoryItemUpdate(id: $id, input: $input) {
    inventoryItem {
                id
                measurement {
                  weight { value unit }
                }
              }
    userErrors { field message }
  }
}`;

function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv = process.argv.slice(2)) {
  let apply = false;
  let product = null;
  /** Optional comma-separated size keys, e.g. 12x16,36x48 */
  let sizes = null;
  for (const arg of argv) {
    if (arg === "--apply") apply = true;
    else if (arg.startsWith("--product=")) {
      product = arg.slice("--product=".length).replace(/^["']|["']$/g, "");
    } else if (arg.startsWith("--sizes=")) {
      sizes = new Set(
        arg
          .slice("--sizes=".length)
          .split(",")
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean)
      );
    }
  }
  return { apply, product, sizes };
}

function toProductGid(product) {
  if (!product) return null;
  if (product.startsWith("gid://")) return product;
  if (/^\d+$/.test(product)) return `gid://shopify/Product/${product}`;
  return null;
}

async function fetchProductByHandle(storeDomain, accessToken, handle) {
  const data = await shopifyGraphql(
    storeDomain,
    accessToken,
    `query ProductByHandle($query: String!) {
      products(first: 1, query: $query) {
        nodes {
          id
          title
          handle
          status
          variants(first: 250) {
            nodes {
              id
              title
              sku
              selectedOptions { name value }
              inventoryItem {
                id
                measurement {
                  weight { value unit }
                }
              }
            }
          }
        }
      }
    }`,
    { query: `handle:${handle}` }
  );
  return data.products?.nodes?.[0] || null;
}

async function fetchProductById(storeDomain, accessToken, id) {
  const data = await shopifyGraphql(
    storeDomain,
    accessToken,
    `query ProductById($id: ID!) {
      product(id: $id) {
        id
        title
        handle
        status
        variants(first: 250) {
          nodes {
            id
            title
            sku
            selectedOptions { name value }
            inventoryItem {
              id
              measurement {
                weight { value unit }
              }
            }
          }
        }
      }
    }`,
    { id }
  );
  return data.product || null;
}

async function* iterateActiveProducts(storeDomain, accessToken) {
  let cursor = null;
  let hasNext = true;
  while (hasNext) {
    const data = await shopifyGraphql(
      storeDomain,
      accessToken,
      `query ActiveProducts($cursor: String) {
        products(first: 25, after: $cursor, query: "status:active") {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            title
            handle
            status
            variants(first: 250) {
              nodes {
                id
                title
                sku
                selectedOptions { name value }
                inventoryItem {
                  id
                  measurement {
                    weight { value unit }
                  }
                }
              }
            }
          }
        }
      }`,
      { cursor }
    );
    const page = data.products;
    for (const node of page?.nodes || []) {
      yield node;
    }
    hasNext = Boolean(page?.pageInfo?.hasNextPage);
    cursor = page?.pageInfo?.endCursor || null;
  }
}

const BULK_VARIANT_UPDATE = `mutation ProductVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
  productVariantsBulkUpdate(productId: $productId, variants: $variants) {
    productVariants { id }
    userErrors { field message }
  }
}`;

function currentWeight(variant) {
  const w = variant?.inventoryItem?.measurement?.weight;
  if (!w || w.value == null || w.value === "") return null;
  const value = Number(w.value);
  if (Number.isNaN(value)) return null;
  return {
    value,
    unit: String(w.unit || "GRAMS").toUpperCase(),
  };
}

function planVariantUpdates(product, packageMap, sizeFilter = null) {
  const planned = [];
  const skipped = [];
  for (const variant of product.variants?.nodes || []) {
    const sizeValue = optionValue(variant.selectedOptions, "Size");
    const sizeKey = sizeKeyFromOptionValue(sizeValue);
    const packageGid = packageGidForSizeKey(sizeKey, packageMap);
    const inventoryItemId = variant.inventoryItem?.id;
    const weight = currentWeight(variant);
    const base = {
      productId: product.id,
      productTitle: product.title,
      productHandle: product.handle,
      variantId: variant.id,
      variantTitle: variant.title,
      sku: variant.sku || "",
      sizeValue,
      sizeKey,
      inventoryItemId: inventoryItemId || null,
      packageGid: packageGid || null,
      weight,
    };
    if (!sizeKey) {
      skipped.push({ ...base, reason: "no_size_parse" });
      continue;
    }
    if (sizeFilter && !sizeFilter.has(String(sizeKey).toLowerCase())) {
      skipped.push({ ...base, reason: "size_filtered" });
      continue;
    }
    if (!packageGid) {
      skipped.push({ ...base, reason: "no_package_map" });
      continue;
    }
    if (!inventoryItemId) {
      skipped.push({ ...base, reason: "no_inventory_item" });
      continue;
    }
    planned.push(base);
  }
  return { planned, skipped };
}

function measurementForRow(row) {
  const measurement = {
    shippingPackageId: row.packageGid,
  };
  const box = FRAME_BOX_CM[row.sizeKey];
  if (box) {
    measurement.packedDimensions = {
      length: box.length,
      width: box.width,
      height: box.height,
      unit: "CENTIMETERS",
    };
  }
  // Defensive: re-send existing weight so measurement update cannot clear it.
  if (row.weight && row.weight.value != null && !Number.isNaN(Number(row.weight.value))) {
    measurement.weight = {
      value: Number(row.weight.value),
      unit: row.weight.unit || "GRAMS",
    };
  }
  return measurement;
}

async function applyUpdate(storeDomain, accessToken, row) {
  const data = await shopifyGraphql(
    storeDomain,
    accessToken,
    INVENTORY_ITEM_UPDATE,
    {
      id: row.inventoryItemId,
      input: { measurement: measurementForRow(row) },
    },
    UNSTABLE_API
  );
  const result = data.inventoryItemUpdate;
  if (result?.userErrors?.length) {
    throw new Error(result.userErrors.map((e) => e.message).join("; "));
  }
  return result?.inventoryItem?.id || row.inventoryItemId;
}

function buildBulkVariantInput(row) {
  return {
    id: row.variantId,
    inventoryItem: { measurement: measurementForRow(row) },
  };
}

async function applyProductBulk(storeDomain, accessToken, productId, rows) {
  const CHUNK = 50;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const data = await shopifyGraphql(
      storeDomain,
      accessToken,
      BULK_VARIANT_UPDATE,
      {
        productId,
        variants: chunk.map(buildBulkVariantInput),
      },
      UNSTABLE_API
    );
    const result = data.productVariantsBulkUpdate;
    if (result?.userErrors?.length) {
      throw new Error(result.userErrors.map((e) => e.message).join("; "));
    }
  }
}

async function main() {
  const { apply, product: productArg, sizes: sizeFilter } = parseArgs();
  ensureConfigDir();

  // Clear park marker when running store-wide apply
  const parkPath = path.join(CONFIG_DIR, "package-rollout-parked.json");
  if (apply && !productArg && fs.existsSync(parkPath)) {
    fs.writeFileSync(
      parkPath,
      JSON.stringify(
        {
          parkedAt: null,
          status: "cleared",
          clearedAt: new Date().toISOString(),
          reason: "Store-wide package assignment started",
        },
        null,
        2
      ),
      "utf8"
    );
  }

  const packageMap = loadShippingPackageMap();
  const { storeDomain, accessToken } = getShopifyCredentials();
  if (!storeDomain || !accessToken) {
    throw new Error("Shopify credentials missing in ~/.editpro/config.json");
  }

  const allPlanned = [];
  const allSkipped = [];
  const updated = [];
  const errors = [];
  const countsBySize = {};

  let products = [];
  if (productArg) {
    const gid = toProductGid(productArg);
    const one = gid
      ? await fetchProductById(storeDomain, accessToken, gid)
      : await fetchProductByHandle(storeDomain, accessToken, productArg);
    if (!one) {
      throw new Error(`Product not found: ${productArg}`);
    }
    products = [one];
    console.log(`Target product: ${one.title} (${one.handle})`);
  } else {
    console.log("Scanning all active products…");
    for await (const p of iterateActiveProducts(storeDomain, accessToken)) {
      products.push(p);
      if (products.length % 50 === 0) {
        process.stdout.write(`\rProducts loaded: ${products.length}   `);
      }
    }
    process.stdout.write(`\rProducts loaded: ${products.length}   \n`);
  }

  if (sizeFilter) {
    console.log(`Size filter: ${[...sizeFilter].join(", ")}`);
  }

  const plannedByProduct = new Map();
  for (const product of products) {
    const { planned, skipped } = planVariantUpdates(product, packageMap, sizeFilter);
    allPlanned.push(...planned);
    allSkipped.push(...skipped);
    if (planned.length) {
      plannedByProduct.set(product.id, planned);
    }
    for (const row of planned) {
      countsBySize[row.sizeKey] = (countsBySize[row.sizeKey] || 0) + 1;
    }
  }

  console.log(
    `Planned: ${allPlanned.length} | Skipped: ${allSkipped.length} | Products: ${plannedByProduct.size} | Mode: ${
      apply ? "APPLY" : "DRY-RUN"
    }`
  );
  console.log("By size:", countsBySize);

  if (apply) {
    let productDone = 0;
    const productIds = [...plannedByProduct.keys()];
    for (const productId of productIds) {
      const rows = plannedByProduct.get(productId);
      productDone += 1;
      try {
        await applyProductBulk(storeDomain, accessToken, productId, rows);
        for (const row of rows) {
          updated.push({ ...row, ok: true });
        }
      } catch (err) {
        // Fallback: per-variant inventoryItemUpdate
        const message = err?.message || String(err);
        console.error(
          `\nBulk failed ${rows[0]?.productHandle || productId}: ${message} — falling back per variant`
        );
        for (const row of rows) {
          try {
            await applyUpdate(storeDomain, accessToken, row);
            updated.push({ ...row, ok: true, fallback: true });
          } catch (err2) {
            errors.push({ ...row, error: err2?.message || String(err2) });
            console.error(`\nError ${row.sku || row.variantId}: ${err2?.message || err2}`);
          }
          await sleep(50);
        }
      }
      if (productDone % 10 === 0 || productDone === productIds.length) {
        process.stdout.write(
          `\rProducts ${productDone}/${productIds.length} | variants ok ${updated.length} | errors ${errors.length}   `
        );
      }
      await sleep(40);
    }
    process.stdout.write("\n");
  }

  const report = {
    generatedAt: new Date().toISOString(),
    apply,
    productFilter: productArg || null,
    counts: {
      products: products.length,
      productsWithUpdates: plannedByProduct.size,
      planned: allPlanned.length,
      skipped: allSkipped.length,
      updated: updated.length,
      errors: errors.length,
    },
    countsBySize,
    packageMap,
    updated: updated.slice(0, 500),
    skipped: allSkipped.slice(0, 200),
    errors,
    plannedSample: allPlanned.slice(0, 40),
  };
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), "utf8");
  console.log(`Report: ${REPORT_PATH}`);

  if (errors.length) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
