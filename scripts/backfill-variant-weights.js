#!/usr/bin/env node
/**
 * Backfill variant inventory weights that are 0 from catalog-variant-reference.json.
 *
 * Targets (from weight analysis):
 *   - products where all variants are 0 g
 *   - mixed products where only the M size tier is 0 g
 *
 * Skips: gift-card and variants without Size/Material/Frame.
 *
 * Square M is missing from the reference file; falls back to rectangle M
 * (18×18 ≈ 16×20 area) for the same material/frame.
 *
 * Usage:
 *   node scripts/backfill-variant-weights.js
 *   node scripts/backfill-variant-weights.js --product=soulful-serenity
 *   node scripts/backfill-variant-weights.js --apply
 *
 * Report: ~/.editpro/variant-weight-backfill-report.json
 *
 * PARKED apply: do not run store-wide --apply until explicitly requested.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { getShopifyCredentials } = require("../lib/config-store");
const { shopifyGraphql } = require("../lib/shopify-client");

const CONFIG_DIR = path.join(os.homedir(), ".editpro");
const REF_PATH = path.join(CONFIG_DIR, "catalog-variant-reference.json");
const ANALYSIS_PATH = path.join(CONFIG_DIR, "variant-weight-analysis.json");
const REPORT_PATH = path.join(CONFIG_DIR, "variant-weight-backfill-report.json");

const SKIP_HANDLES = new Set(["gift-card"]);

const INVENTORY_ITEM_UPDATE = `mutation InventoryItemUpdate($id: ID!, $input: InventoryItemInput!) {
  inventoryItemUpdate(id: $id, input: $input) {
    inventoryItem { id measurement { weight { value unit } } }
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
  for (const arg of argv) {
    if (arg === "--apply") apply = true;
    else if (arg.startsWith("--product=")) {
      product = arg.slice("--product=".length).replace(/^["']|["']$/g, "");
    }
  }
  return { apply, product };
}

function optionValue(selectedOptions, name) {
  const target = String(name || "").toLowerCase();
  const hit = (selectedOptions || []).find(
    (opt) => String(opt?.name || "").toLowerCase() === target
  );
  return hit ? String(hit.value || "") : "";
}

function parseSizeCode(sizeLabel) {
  const m = String(sizeLabel || "").match(/^([A-Z]+)\s/i);
  return m ? m[1].toUpperCase() : "";
}

function normalizeFrame(frame) {
  const f = String(frame || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-");
  if (f === "black-frame") return "black";
  if (f === "wooden-finish") return "wooden";
  if (
    f === "dark-wood-finish" ||
    f === "dark-wood" ||
    f === "dark-brown"
  ) {
    return "dark-wood";
  }
  if (f === "stretched-canvas" || f === "stretchedcanvas") {
    return "stretched-canvas";
  }
  return f;
}

function inferShape(sizeLabel) {
  const dims = String(sizeLabel || "").match(
    /(\d+(?:\.\d+)?)\s*["']?\s*[x×]\s*["']?\s*(\d+(?:\.\d+)?)/i
  );
  if (!dims) return "";
  const w = parseFloat(dims[1]);
  const h = parseFloat(dims[2]);
  if (!w || !h) return "";
  return w === h ? "square" : "rectangle";
}

function variantKey(shape, sizeCode, material, frame) {
  return `${shape}|${sizeCode}|${material}|${frame}`;
}

function weightUnitToShopify(unit) {
  const u = String(unit || "").toLowerCase();
  if (u === "g" || u === "grams" || u === "gram") return "GRAMS";
  if (u === "kg" || u === "kilograms" || u === "kilogram") return "KILOGRAMS";
  if (u === "oz" || u === "ounces" || u === "ounce") return "OUNCES";
  if (u === "lb" || u === "lbs" || u === "pounds" || u === "pound") {
    return "POUNDS";
  }
  return "GRAMS";
}

function loadReferenceLookup() {
  if (!fs.existsSync(REF_PATH)) {
    throw new Error(`Missing reference file: ${REF_PATH}`);
  }
  const ref = JSON.parse(fs.readFileSync(REF_PATH, "utf8"));
  const lookup = {};
  for (const shape of ["rectangle", "square"]) {
    const variants = ref[shape]?.variants || {};
    for (const [key, row] of Object.entries(variants)) {
      if (row?.weight != null && Number(row.weight) > 0) {
        lookup[key] = {
          weight: Number(row.weight),
          weightUnit: row.weightUnit || "grams",
          source: `${shape}:${ref[shape]?.sourceHandle || "ref"}`,
        };
      }
    }
  }

  // Square M missing from reference — use rectangle M (near-equal area).
  for (const [key, row] of Object.entries(lookup)) {
    if (!key.startsWith("rectangle|M|")) continue;
    const squareKey = key.replace(/^rectangle\|/, "square|");
    if (!lookup[squareKey]) {
      lookup[squareKey] = {
        ...row,
        source: `${row.source}->squareM_from_rectM`,
      };
    }
  }
  return lookup;
}

function loadTargetHandles(productFilter) {
  if (productFilter) return [productFilter];
  if (!fs.existsSync(ANALYSIS_PATH)) {
    throw new Error(
      `Missing analysis file: ${ANALYSIS_PATH}. Run weight analysis first.`
    );
  }
  const analysis = JSON.parse(fs.readFileSync(ANALYSIS_PATH, "utf8"));
  const handles = new Set();
  for (const p of analysis.productsAllZeroOrMissing || []) {
    if (p.handle && !SKIP_HANDLES.has(p.handle)) handles.add(p.handle);
  }
  for (const p of analysis.productsMixed || []) {
    if (p.handle && !SKIP_HANDLES.has(p.handle)) handles.add(p.handle);
  }
  return [...handles];
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
          variants(first: 250) {
            nodes {
              id
              title
              sku
              selectedOptions { name value }
              inventoryItem {
                id
                measurement { weight { value unit } }
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

function planProduct(product, lookup) {
  const planned = [];
  const skipped = [];
  for (const variant of product.variants?.nodes || []) {
    const current = variant.inventoryItem?.measurement?.weight;
    const currentValue =
      current?.value != null ? Number(current.value) : null;
    const size = optionValue(variant.selectedOptions, "Size");
    const material = optionValue(variant.selectedOptions, "Material");
    const frame = normalizeFrame(optionValue(variant.selectedOptions, "Frame"));
    const sizeCode = parseSizeCode(size);
    const shape = inferShape(size);
    const key =
      shape && sizeCode && material && frame
        ? variantKey(shape, sizeCode, material, frame)
        : null;
    const ref = key ? lookup[key] : null;
    const base = {
      productId: product.id,
      productTitle: product.title,
      productHandle: product.handle,
      variantId: variant.id,
      sku: variant.sku || "",
      size,
      material,
      frame,
      sizeCode,
      shape,
      key,
      currentWeight: currentValue,
      targetWeight: ref?.weight ?? null,
      targetUnit: ref ? weightUnitToShopify(ref.weightUnit) : null,
      refSource: ref?.source || null,
      inventoryItemId: variant.inventoryItem?.id || null,
    };

    if (currentValue != null && currentValue > 0) {
      skipped.push({ ...base, reason: "already_has_weight" });
      continue;
    }
    if (!key) {
      skipped.push({ ...base, reason: "cannot_build_key" });
      continue;
    }
    if (!ref) {
      skipped.push({ ...base, reason: "no_reference_weight" });
      continue;
    }
    if (!base.inventoryItemId) {
      skipped.push({ ...base, reason: "no_inventory_item" });
      continue;
    }
    planned.push(base);
  }
  return { planned, skipped };
}

async function applyWeight(storeDomain, accessToken, row) {
  const data = await shopifyGraphql(
    storeDomain,
    accessToken,
    INVENTORY_ITEM_UPDATE,
    {
      id: row.inventoryItemId,
      input: {
        measurement: {
          weight: {
            value: row.targetWeight,
            unit: row.targetUnit,
          },
        },
      },
    }
  );
  const result = data.inventoryItemUpdate;
  if (result?.userErrors?.length) {
    throw new Error(result.userErrors.map((e) => e.message).join("; "));
  }
  return result?.inventoryItem?.measurement?.weight || null;
}

async function main() {
  const { apply, product: productFilter } = parseArgs();
  ensureConfigDir();

  const lookup = loadReferenceLookup();
  const handles = loadTargetHandles(productFilter);
  const { storeDomain, accessToken } = getShopifyCredentials();
  if (!storeDomain || !accessToken) {
    throw new Error("Shopify credentials missing in ~/.editpro/config.json");
  }

  console.log(
    `Targets: ${handles.length} product(s) | Mode: ${
      apply ? "APPLY" : "DRY-RUN"
    }`
  );
  console.log(`Reference keys: ${Object.keys(lookup).length}`);

  const allPlanned = [];
  const allSkipped = [];
  const updated = [];
  const errors = [];
  const missingProducts = [];

  for (let i = 0; i < handles.length; i++) {
    const handle = handles[i];
    const product = await fetchProductByHandle(
      storeDomain,
      accessToken,
      handle
    );
    if (!product) {
      missingProducts.push(handle);
      continue;
    }
    const { planned, skipped } = planProduct(product, lookup);
    allPlanned.push(...planned);
    allSkipped.push(...skipped);
    if ((i + 1) % 10 === 0 || i === handles.length - 1) {
      process.stdout.write(
        `\rLoaded ${i + 1}/${handles.length} | planned ${allPlanned.length}   `
      );
    }
    await sleep(60);
  }
  process.stdout.write("\n");

  console.log(
    `Planned: ${allPlanned.length} | Skipped: ${allSkipped.length} | Missing products: ${missingProducts.length}`
  );

  if (apply) {
    let n = 0;
    for (const row of allPlanned) {
      n += 1;
      try {
        const weight = await applyWeight(storeDomain, accessToken, row);
        updated.push({ ...row, writtenWeight: weight, ok: true });
      } catch (err) {
        const message = err?.message || String(err);
        errors.push({ ...row, error: message });
        console.error(`\nError ${row.sku || row.variantId}: ${message}`);
      }
      if (n % 10 === 0 || n === allPlanned.length) {
        process.stdout.write(
          `\rUpdated ${updated.length}/${allPlanned.length} (errors ${errors.length})   `
        );
      }
      await sleep(80);
    }
    process.stdout.write("\n");
  }

  const report = {
    generatedAt: new Date().toISOString(),
    apply,
    productFilter: productFilter || null,
    parkedNote:
      "Store-wide --apply is parked until explicitly requested; dry-run is safe anytime.",
    counts: {
      targetProducts: handles.length,
      missingProducts: missingProducts.length,
      planned: allPlanned.length,
      skipped: allSkipped.length,
      updated: updated.length,
      errors: errors.length,
    },
    missingProducts,
    plannedSample: allPlanned.slice(0, 40),
    skippedSample: allSkipped.slice(0, 40),
    updated: updated.slice(0, 200),
    errors,
  };
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), "utf8");
  console.log(`Report: ${REPORT_PATH}`);

  if (errors.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
