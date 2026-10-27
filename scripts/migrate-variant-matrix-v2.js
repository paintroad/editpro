#!/usr/bin/env node
/**
 * Migrate live Shopify products to variant matrix v2:
 * - Size S–XL × Frame only (drop Material option; product metafield Material=Canvas)
 * - New size ladder + prices/costs/weights/SKUs
 * - Keep product handles (SEO-safe)
 *
 * Usage:
 *   node scripts/migrate-variant-matrix-v2.js
 *   node scripts/migrate-variant-matrix-v2.js --limit=5
 *   node scripts/migrate-variant-matrix-v2.js --handles=soulful-serenity --apply
 *   node scripts/migrate-variant-matrix-v2.js --apply
 *
 * Progress: ~/.editpro/migrate-variant-matrix-v2-progress.json
 * Report:   ~/.editpro/migrate-variant-matrix-v2-report.json
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { getShopifyCredentials } = require("../lib/config-store");
const { shopifyGraphql } = require("../lib/shopify-client");
const {
  PRODUCT_MATERIAL,
  PRODUCT_DEFAULTS,
  VARIANT_ROWS,
  SQUARE_SIZES,
  RECTANGLE_SIZES,
  pricingForVariant,
  weightForVariant,
  normalizeFrame,
  normalizeShape,
  frameDisplayLabel,
  sizeCodeFromLabel,
} = require("../lib/catalog-variant-templates");
const {
  METAOBJECT_TYPES,
  createMetaobjectResolver,
} = require("../lib/shopify-metaobject-resolver");
const {
  sizeKeyFromOptionValue,
  packageGidForSizeKey,
  PACKAGE_MAP_PATH,
} = require("../lib/package-dimensions");

const CONFIG_DIR = path.join(os.homedir(), ".editpro");
const PROGRESS_PATH = path.join(CONFIG_DIR, "migrate-variant-matrix-v2-progress.json");
const REPORT_PATH = path.join(CONFIG_DIR, "migrate-variant-matrix-v2-report.json");

const OBSOLETE_SIZE_RE = {
  xs: /\bXS\b/i,
  rectS: /11\s*["″']?\s*[x×]\s*["″']?\s*14/i,
  rectM: /16\s*["″']?\s*[x×]\s*["″']?\s*20/i,
  squareXs: /10\s*["″']?\s*[x×]\s*["″']?\s*10/i,
};

function loadPackageMapSoft() {
  try {
    if (!fs.existsSync(PACKAGE_MAP_PATH)) return {};
    const raw = JSON.parse(fs.readFileSync(PACKAGE_MAP_PATH, "utf8"));
    const out = {};
    for (const [key, gid] of Object.entries(raw || {})) {
      const k = String(key).trim();
      const id = String(gid || "").trim();
      if (!k || !id) continue;
      out[k] = id.startsWith("gid://")
        ? id
        : `gid://shopify/ShippingPackageV2/${id}`;
    }
    return out;
  } catch {
    return {};
  }
}

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
  let concurrency = 2;
  let handles = [];
  for (const arg of argv) {
    if (arg.startsWith("--limit=")) limit = Number(arg.slice("--limit=".length));
    if (arg.startsWith("--concurrency=")) {
      concurrency = Math.max(1, Number(arg.slice("--concurrency=".length)) || 2);
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

function loadProgress() {
  if (!fs.existsSync(PROGRESS_PATH)) return { doneProductIds: [] };
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

function selectedValue(selectedOptions, name) {
  const n = String(name || "").toLowerCase();
  const hit = (selectedOptions || []).find(
    (o) => String(o.name || "").toLowerCase() === n
  );
  return hit ? String(hit.value || "") : "";
}

function detectShapeFromSizeLabels(labels) {
  const joined = (labels || []).join(" | ");
  if (/12\s*["″']?\s*[x×]\s*["″']?\s*12|18\s*["″']?\s*[x×]\s*["″']?\s*18|10\s*["″']?\s*[x×]\s*["″']?\s*10/i.test(joined)) {
    return "square";
  }
  if (/8\s*["″']?\s*[x×]|11\s*["″']?\s*[x×]|16\s*["″']?\s*[x×]|12\s*["″']?\s*[x×]\s*["″']?\s*16|36\s*["″']?\s*[x×]\s*["″']?\s*48/i.test(joined)) {
    return "rectangle";
  }
  if (/24\s*["″']?\s*[x×]\s*["″']?\s*36|18\s*["″']?\s*[x×]\s*["″']?\s*24/i.test(joined) &&
      !/24\s*["″']?\s*[x×]\s*["″']?\s*24|36\s*["″']?\s*[x×]\s*["″']?\s*36/i.test(joined)) {
    return "rectangle";
  }
  return "square";
}

function inchesKey(sizeLabel) {
  const m = String(sizeLabel || "").match(
    /(\d+(?:\.\d+)?)\s*["″']?\s*[x×]\s*["″']?\s*(\d+(?:\.\d+)?)/i
  );
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return `${Math.min(a, b)}x${Math.max(a, b)}`;
}

function targetSizeLabel(shape, sizeCode) {
  const sizes = normalizeShape(shape) === "rectangle" ? RECTANGLE_SIZES : SQUARE_SIZES;
  return sizes[sizeCode] || null;
}

function productIdFromSku(sku) {
  const m = String(sku || "").match(/^(\d{4,})-/);
  return m ? m[1] : null;
}

function frameSuffixFromSku(sku) {
  const m = String(sku || "").match(/-(XS|S|M|L|XL)-(\d+)$/i);
  return m ? Number(m[2]) : null;
}

function frameKeyFromLabel(frameLabel) {
  return normalizeFrame(frameLabel);
}

function suffixForFrame(frameKey) {
  const row = VARIANT_ROWS.find((r) => r.frame === normalizeFrame(frameKey));
  return row ? row.n : null;
}

function shouldDeleteVariant(shape, sizeLabel, material) {
  const mat = String(material || "").toLowerCase();
  if (mat.includes("paper")) return "paper";
  if (OBSOLETE_SIZE_RE.xs.test(sizeLabel)) return "xs";
  if (normalizeShape(shape) === "rectangle") {
    if (OBSOLETE_SIZE_RE.rectS.test(sizeLabel)) return "obsolete-rect-s";
    if (OBSOLETE_SIZE_RE.rectM.test(sizeLabel)) return "obsolete-rect-m";
  } else if (OBSOLETE_SIZE_RE.squareXs.test(sizeLabel) || OBSOLETE_SIZE_RE.xs.test(sizeLabel)) {
    return "xs";
  }
  return null;
}

/** Map surviving physical size → new size code. */
function remapSizeCode(shape, sizeLabel) {
  const key = inchesKey(sizeLabel);
  if (!key) return sizeCodeFromLabel(sizeLabel);

  if (normalizeShape(shape) === "rectangle") {
    if (key === "18x24") return "M";
    if (key === "24x36") return "L";
    if (key === "12x16") return "S";
    if (key === "36x48") return "XL";
  } else {
    if (key === "12x12") return "S";
    if (key === "18x18") return "M";
    if (key === "24x24") return "L";
    if (key === "36x36") return "XL";
  }
  return sizeCodeFromLabel(sizeLabel);
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

async function resolveWarehouseLocations(storeDomain, accessToken) {
  const data = await shopifyGraphql(
    storeDomain,
    accessToken,
    `query {
      locations(first: 25, includeInactive: true) {
        nodes { id name isActive }
      }
    }`
  );
  const nodes = data.locations?.nodes || [];
  const findBy = (needles) =>
    nodes.find((n) => {
      const name = String(n.name || "").toLowerCase();
      return needles.some((x) => name.includes(x));
    });
  const naraina = findBy(["naraina", "nariana"]);
  const mayapuri = findBy(["mayapuri"]);
  if (!naraina) {
    throw new Error("Naraina/Nariana warehouse location not found");
  }
  if (!mayapuri) {
    throw new Error("Mayapuri warehouse location not found");
  }
  return { naraina, mayapuri };
}

/** Coloured frames → Naraina; Stretched Canvas → Mayapuri. */
function locationForFrame(frameKey, locations) {
  if (normalizeFrame(frameKey) === "stretched-canvas") {
    return locations.mayapuri;
  }
  return locations.naraina;
}

async function listProducts(storeDomain, accessToken, { handles, limit }) {
  const out = [];
  if (handles.length) {
    for (const handle of handles) {
      const data = await shopifyGraphql(
        storeDomain,
        accessToken,
        `query ($q: String!) {
          products(first: 1, query: $q) {
            nodes { id title handle status options { id name position optionValues { id name linkedMetafieldValue } } }
          }
        }`,
        { q: `handle:${handle}` }
      );
      const node = data.products?.nodes?.[0];
      if (node) out.push(node);
    }
    return out;
  }

  let cursor = null;
  let hasNext = true;
  while (hasNext) {
    const data = await shopifyGraphql(
      storeDomain,
      accessToken,
      `query ($cursor: String) {
        products(first: 50, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes { id title handle status options { id name position optionValues { id name linkedMetafieldValue } } }
        }
      }`,
      { cursor }
    );
    const page = data.products;
    out.push(...(page?.nodes || []));
    if (limit && out.length >= limit) {
      return out.slice(0, limit);
    }
    hasNext = Boolean(page?.pageInfo?.hasNextPage);
    cursor = page?.pageInfo?.endCursor || null;
  }
  return out;
}

async function fetchAllVariants(storeDomain, accessToken, productId) {
  const variants = [];
  let cursor = null;
  let hasNext = true;
  while (hasNext) {
    const data = await shopifyGraphql(
      storeDomain,
      accessToken,
      `query ($id: ID!, $cursor: String) {
        product(id: $id) {
          variants(first: 100, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id
              title
              sku
              price
              compareAtPrice
              selectedOptions { name value }
              inventoryItem {
                id
                unitCost { amount currencyCode }
                measurement { weight { value unit } }
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

async function bulkDeleteVariants(storeDomain, accessToken, productId, variantIds) {
  if (!variantIds.length) return;
  for (let i = 0; i < variantIds.length; i += 50) {
    const chunk = variantIds.slice(i, i + 50);
    const data = await shopifyGraphql(
      storeDomain,
      accessToken,
      `mutation ($productId: ID!, $variantsIds: [ID!]!) {
        productVariantsBulkDelete(productId: $productId, variantsIds: $variantsIds) {
          userErrors { field message }
        }
      }`,
      { productId, variantsIds: chunk }
    );
    const errors = data.productVariantsBulkDelete?.userErrors || [];
    if (errors.length) {
      throw new Error(errors.map((e) => e.message).join("; "));
    }
    await sleep(250);
  }
}

async function bulkUpdateVariants(storeDomain, accessToken, productId, variants) {
  if (!variants.length) return;
  for (let i = 0; i < variants.length; i += 25) {
    const chunk = variants.slice(i, i + 25);
    const data = await shopifyGraphql(
      storeDomain,
      accessToken,
      `mutation ($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkUpdate(productId: $productId, variants: $variants) {
          userErrors { field message }
        }
      }`,
      { productId, variants: chunk }
    );
    const errors = data.productVariantsBulkUpdate?.userErrors || [];
    if (errors.length) {
      throw new Error(errors.map((e) => e.message).join("; "));
    }
    await sleep(250);
  }
}

async function bulkCreateVariants(storeDomain, accessToken, productId, variants) {
  const created = [];
  if (!variants.length) return created;
  for (let i = 0; i < variants.length; i += 25) {
    const chunk = variants.slice(i, i + 25);
    const data = await shopifyGraphql(
      storeDomain,
      accessToken,
      `mutation ($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkCreate(productId: $productId, variants: $variants) {
          productVariants {
            id
            sku
            inventoryItem { id }
          }
          userErrors { field message }
        }
      }`,
      { productId, variants: chunk }
    );
    const errors = data.productVariantsBulkCreate?.userErrors || [];
    if (errors.length) {
      throw new Error(errors.map((e) => e.message).join("; "));
    }
    created.push(...(data.productVariantsBulkCreate?.productVariants || []));
    await sleep(250);
  }
  return created;
}

async function ensureSizeOptionValues(storeDomain, accessToken, product, neededLabels) {
  const sizeOpt = (product.options || []).find(
    (o) => String(o.name || "").toLowerCase() === "size"
  );
  if (!sizeOpt) return;
  const existing = new Set((sizeOpt.optionValues || []).map((v) => v.name));
  const toAdd = neededLabels.filter((label) => label && !existing.has(label));
  if (!toAdd.length) return;

  const data = await shopifyGraphql(
    storeDomain,
    accessToken,
    `mutation ($productId: ID!, $option: OptionUpdateInput!, $optionValuesToAdd: [OptionValueCreateInput!]) {
      productOptionUpdate(productId: $productId, option: $option, optionValuesToAdd: $optionValuesToAdd) {
        userErrors { field message }
      }
    }`,
    {
      productId: product.id,
      option: { id: sizeOpt.id },
      optionValuesToAdd: toAdd.map((name) => ({ name })),
    }
  );
  const errors = data.productOptionUpdate?.userErrors || [];
  const real = errors.filter(
    (e) => !/already exists|taken|duplicate/i.test(String(e.message || ""))
  );
  if (real.length) {
    throw new Error(real.map((e) => e.message).join("; "));
  }
}
async function ensureFrameOptionValues(storeDomain, accessToken, product, resolver) {
  const frameOpt = (product.options || []).find(
    (o) => String(o.name || "").toLowerCase() === "frame"
  );
  if (!frameOpt) return;

  const needed = VARIANT_ROWS.map((r) => frameDisplayLabel(r.frame));
  const existing = new Set((frameOpt.optionValues || []).map((v) => v.name));
  const missing = needed.filter((label) => !existing.has(label));
  if (!missing.length) return;

  const optionValuesToAdd = [];
  for (const label of missing) {
    const metaId = await resolver.resolveId(METAOBJECT_TYPES.frameStyle, label);
    if (!metaId) {
      throw new Error(`Could not resolve frame metaobject for "${label}"`);
    }
    optionValuesToAdd.push({
      linkedMetafieldValue: metaId,
    });
  }

  const data = await shopifyGraphql(
    storeDomain,
    accessToken,
    `mutation ($productId: ID!, $option: OptionUpdateInput!, $optionValuesToAdd: [OptionValueCreateInput!]) {
      productOptionUpdate(productId: $productId, option: $option, optionValuesToAdd: $optionValuesToAdd) {
        userErrors { field message }
      }
    }`,
    {
      productId: product.id,
      option: { id: frameOpt.id },
      optionValuesToAdd,
    }
  );
  const errors = data.productOptionUpdate?.userErrors || [];
  const real = errors.filter(
    (e) => !/already exists|taken|duplicate/i.test(String(e.message || ""))
  );
  if (real.length) {
    throw new Error(real.map((e) => e.message).join("; "));
  }
}

async function deleteMaterialOption(storeDomain, accessToken, product) {
  const materialOpt = (product.options || []).find(
    (o) => String(o.name || "").toLowerCase() === "material"
  );
  if (!materialOpt) return false;

  const data = await shopifyGraphql(
    storeDomain,
    accessToken,
    `mutation ($productId: ID!, $options: [ID!]!, $strategy: ProductOptionDeleteStrategy) {
      productOptionsDelete(productId: $productId, options: $options, strategy: $strategy) {
        deletedOptionsIds
        userErrors { field message code }
      }
    }`,
    {
      productId: product.id,
      options: [materialOpt.id],
      strategy: "DEFAULT",
    }
  );
  const errors = data.productOptionsDelete?.userErrors || [];
  if (errors.length) {
    throw new Error(errors.map((e) => e.message).join("; "));
  }
  return true;
}

async function pruneObsoleteSizeValues(storeDomain, accessToken, product, keepLabels) {
  const sizeOpt = (product.options || []).find(
    (o) => String(o.name || "").toLowerCase() === "size"
  );
  if (!sizeOpt) return;
  const keep = new Set(keepLabels);
  const toDelete = (sizeOpt.optionValues || [])
    .filter((v) => !keep.has(v.name))
    .map((v) => v.id);
  if (!toDelete.length) return;

  const data = await shopifyGraphql(
    storeDomain,
    accessToken,
    `mutation ($productId: ID!, $option: OptionUpdateInput!, $optionValuesToDelete: [ID!]) {
      productOptionUpdate(productId: $productId, option: $option, optionValuesToDelete: $optionValuesToDelete) {
        userErrors { field message }
      }
    }`,
    {
      productId: product.id,
      option: { id: sizeOpt.id },
      optionValuesToDelete: toDelete,
    }
  );
  const errors = data.productOptionUpdate?.userErrors || [];
  if (errors.length) {
    // Non-fatal if values still referenced
    console.warn(`  prune sizes warn: ${errors.map((e) => e.message).join("; ")}`);
  }
}

async function setProductMaterialMetafield(storeDomain, accessToken, productId, resolver) {
  const ids = await resolver.resolveIds(METAOBJECT_TYPES.material, [PRODUCT_MATERIAL]);
  if (!ids.length) {
    throw new Error("Could not resolve Canvas material metaobject");
  }
  const data = await shopifyGraphql(
    storeDomain,
    accessToken,
    `mutation ($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        userErrors { field message }
      }
    }`,
    {
      metafields: [
        {
          ownerId: productId,
          namespace: "shopify",
          key: "material",
          type: "list.metaobject_reference",
          value: JSON.stringify(ids),
        },
      ],
    }
  );
  const errors = data.metafieldsSet?.userErrors || [];
  if (errors.length) {
    throw new Error(errors.map((e) => e.message).join("; "));
  }
}

function buildOptionValueMaps(options) {
  const sizeByName = new Map();
  const materialByName = new Map();
  const frameByName = new Map();
  for (const option of options || []) {
    const name = String(option.name || "").toLowerCase();
    for (const value of option.optionValues || []) {
      if (name === "size") sizeByName.set(value.name, value.id);
      else if (name === "material") materialByName.set(value.name, value.id);
      else if (name === "frame") frameByName.set(value.name, value.id);
    }
  }
  return { sizeByName, materialByName, frameByName };
}

/**
 * Linked Material/Frame options require value IDs (not names) on bulk create/update.
 */
function buildOptionValues(product, sizeLabel, frameLabel, hasMaterial) {
  const maps = buildOptionValueMaps(product.options);
  const out = [];

  const sizeId = maps.sizeByName.get(sizeLabel);
  if (sizeId) out.push({ optionName: "Size", id: sizeId });
  else out.push({ optionName: "Size", name: sizeLabel });

  if (hasMaterial) {
    const materialId =
      maps.materialByName.get(PRODUCT_MATERIAL) ||
      maps.materialByName.get("Canvas");
    if (!materialId) {
      throw new Error(`Missing Material option value id for "${PRODUCT_MATERIAL}"`);
    }
    out.push({ optionName: "Material", id: materialId });
  }

  const frameId = maps.frameByName.get(frameLabel);
  if (!frameId) {
    throw new Error(`Missing Frame option value id for "${frameLabel}"`);
  }
  out.push({ optionName: "Frame", id: frameId });

  return out;
}

async function refreshProductOptions(storeDomain, accessToken, productId) {
  const data = await shopifyGraphql(
    storeDomain,
    accessToken,
    `query ($id: ID!) {
      product(id: $id) {
        id
        options { id name position optionValues { id name linkedMetafieldValue } }
      }
    }`,
    { id: productId }
  );
  return data.product;
}

function buildInventoryItemUpdate(sku, weightG, packageGid) {
  const input = {
    sku,
    tracked: true,
    requiresShipping: true,
    countryCodeOfOrigin: PRODUCT_DEFAULTS.countryOfOrigin,
  };
  const measurement = {};
  if (weightG != null) {
    measurement.weight = { value: Number(weightG), unit: "GRAMS" };
  }
  if (packageGid) {
    measurement.shippingPackageId = packageGid;
  }
  if (Object.keys(measurement).length) {
    input.measurement = measurement;
  }
  return input;
}

function packageGidForSizeLabel(sizeLabel, packageMap) {
  const key = sizeKeyFromOptionValue(sizeLabel);
  return packageGidForSizeKey(key, packageMap);
}

function inventoryQuantitiesForFrame(frameKey, locations) {
  const qty = PRODUCT_DEFAULTS.inventoryQty;
  if (normalizeFrame(frameKey) === "stretched-canvas") {
    // Stretched Canvas stock only at Mayapuri — never activate Naraina
    return [
      { availableQuantity: qty, locationId: locations.mayapuri.id },
    ];
  }
  return [
    { availableQuantity: qty, locationId: locations.naraina.id },
  ];
}

function planProduct(product, variants) {
  const sizeOpt = (product.options || []).find(
    (o) => String(o.name || "").toLowerCase() === "size"
  );
  const sizeLabels = (sizeOpt?.optionValues || []).map((v) => v.name);
  const shape = normalizeShape(detectShapeFromSizeLabels(sizeLabels));
  const targetSizes =
    shape === "rectangle" ? RECTANGLE_SIZES : SQUARE_SIZES;
  const hasMaterial = (product.options || []).some(
    (o) => String(o.name || "").toLowerCase() === "material"
  );

  let catalogProductId = null;
  for (const v of variants) {
    catalogProductId = productIdFromSku(v.sku);
    if (catalogProductId) break;
  }

  const toDelete = [];
  const toUpdate = [];
  const presentKeys = new Set(); // `${sizeCode}|${frameKey}`

  for (const variant of variants) {
    const sizeLabel = selectedValue(variant.selectedOptions, "Size");
    const material = selectedValue(variant.selectedOptions, "Material");
    const frameLabel = selectedValue(variant.selectedOptions, "Frame");
    const frameKey = frameKeyFromLabel(frameLabel);
    const deleteReason = shouldDeleteVariant(shape, sizeLabel, material);

    if (deleteReason) {
      toDelete.push({
        id: variant.id,
        sku: variant.sku,
        reason: deleteReason,
        title: variant.title,
      });
      continue;
    }

    if (!frameKey || !VARIANT_ROWS.some((r) => r.frame === frameKey)) {
      toDelete.push({
        id: variant.id,
        sku: variant.sku,
        reason: "unknown-frame",
        title: variant.title,
      });
      continue;
    }

    const newSizeCode = remapSizeCode(shape, sizeLabel);
    const newSizeLabel = targetSizeLabel(shape, newSizeCode);
    if (!newSizeCode || !newSizeLabel) {
      toDelete.push({
        id: variant.id,
        sku: variant.sku,
        reason: "unmapped-size",
        title: variant.title,
      });
      continue;
    }

    const pricing = pricingForVariant(shape, newSizeCode, frameKey);
    const weight = weightForVariant(shape, newSizeCode);
    const n =
      suffixForFrame(frameKey) ||
      frameSuffixFromSku(variant.sku) ||
      5;
    const newSku = catalogProductId
      ? `${catalogProductId}-${newSizeCode}-${n}`
      : variant.sku;

    presentKeys.add(`${newSizeCode}|${frameKey}`);

    toUpdate.push({
      id: variant.id,
      oldSku: variant.sku,
      newSku,
      sizeCode: newSizeCode,
      sizeLabel: newSizeLabel,
      frameLabel: frameDisplayLabel(frameKey),
      frame: frameDisplayLabel(frameKey),
      price: pricing?.price,
      compareAt: pricing?.compareAt,
      cost: pricing?.cost,
      weight,
      inventoryItemId: variant.inventoryItem?.id,
      inventoryPolicy: "CONTINUE",
    });
  }

  const toCreate = [];
  if (catalogProductId) {
    for (const sizeCode of Object.keys(targetSizes)) {
      for (const row of VARIANT_ROWS) {
        const key = `${sizeCode}|${row.frame}`;
        if (presentKeys.has(key)) continue;
        const pricing = pricingForVariant(shape, sizeCode, row.frame);
        const weight = weightForVariant(shape, sizeCode);
        toCreate.push({
          sizeCode,
          sizeLabel: targetSizes[sizeCode],
          frame: row.frame,
          frameLabel: frameDisplayLabel(row.frame),
          sku: `${catalogProductId}-${sizeCode}-${row.n}`,
          price: String(pricing.price),
          compareAtPrice: String(pricing.compareAt),
          cost: pricing.cost,
          weight,
          warehouse: normalizeFrame(row.frame) === "stretched-canvas" ? "mayapuri" : "naraina",
        });
      }
    }
  }

  return {
    shape,
    hasMaterial,
    catalogProductId,
    keepSizeLabels: Object.values(targetSizes),
    toDelete,
    toUpdate,
    toCreate,
  };
}

async function inventoryItemUpdate(storeDomain, accessToken, id, input) {
  const data = await shopifyGraphql(
    storeDomain,
    accessToken,
    `mutation ($id: ID!, $input: InventoryItemInput!) {
      inventoryItemUpdate(id: $id, input: $input) {
        userErrors { field message }
      }
    }`,
    { id, input }
  );
  const errors = data.inventoryItemUpdate?.userErrors || [];
  if (errors.length) {
    throw new Error(errors.map((e) => e.message).join("; "));
  }
}

async function applyProductPlan(
  storeDomain,
  accessToken,
  product,
  plan,
  resolver,
  locations,
  packageMap
) {
  if (plan.toDelete.length) {
    await bulkDeleteVariants(
      storeDomain,
      accessToken,
      product.id,
      plan.toDelete.map((v) => v.id)
    );
  }

  await ensureSizeOptionValues(
    storeDomain,
    accessToken,
    product,
    plan.keepSizeLabels
  );
  await ensureFrameOptionValues(storeDomain, accessToken, product, resolver);

  // Refresh options so new Size/Frame values + linked IDs are available
  let liveProduct =
    (await refreshProductOptions(storeDomain, accessToken, product.id)) || product;
  const hasMaterial = (liveProduct.options || []).some(
    (o) => String(o.name || "").toLowerCase() === "material"
  );

  if (plan.toUpdate.length) {
    const variants = plan.toUpdate.map((row) => {
      const packageGid = packageGidForSizeLabel(row.sizeLabel, packageMap);
      return {
        id: row.id,
        price: String(row.price),
        compareAtPrice: String(row.compareAt),
        optionValues: buildOptionValues(
          liveProduct,
          row.sizeLabel,
          row.frameLabel || row.frame,
          hasMaterial
        ),
        inventoryPolicy: "CONTINUE",
        taxable: true,
        inventoryItem: buildInventoryItemUpdate(
          row.newSku,
          row.weight,
          packageGid
        ),
      };
    });
    await bulkUpdateVariants(storeDomain, accessToken, product.id, variants);

    for (const row of plan.toUpdate) {
      if (!row.inventoryItemId) continue;
      const packageGid = packageGidForSizeLabel(row.sizeLabel, packageMap);
      const input = {
        tracked: true,
        requiresShipping: true,
        countryCodeOfOrigin: PRODUCT_DEFAULTS.countryOfOrigin,
      };
      if (row.cost != null) input.cost = String(row.cost);
      const measurement = {};
      if (row.weight != null) {
        measurement.weight = { value: Number(row.weight), unit: "GRAMS" };
      }
      if (packageGid) measurement.shippingPackageId = packageGid;
      if (Object.keys(measurement).length) input.measurement = measurement;
      await inventoryItemUpdate(
        storeDomain,
        accessToken,
        row.inventoryItemId,
        input
      );
    }
  }

  if (plan.toCreate.length) {
    // Refresh again in case updates changed option state
    liveProduct =
      (await refreshProductOptions(storeDomain, accessToken, product.id)) ||
      liveProduct;
    const stillHasMaterial = (liveProduct.options || []).some(
      (o) => String(o.name || "").toLowerCase() === "material"
    );

    const variants = plan.toCreate.map((row) => {
      const sizeLabel = row.sizeLabel;
      const packageGid = packageGidForSizeLabel(sizeLabel, packageMap);
      const measurement = {
        weight: { value: Number(row.weight), unit: "GRAMS" },
      };
      if (packageGid) measurement.shippingPackageId = packageGid;
      return {
        price: row.price,
        compareAtPrice: row.compareAtPrice,
        optionValues: buildOptionValues(
          liveProduct,
          sizeLabel,
          row.frameLabel || frameDisplayLabel(row.frame),
          stillHasMaterial
        ),
        inventoryPolicy: "CONTINUE",
        taxable: true,
        inventoryItem: {
          sku: row.sku,
          tracked: true,
          requiresShipping: true,
          countryCodeOfOrigin: PRODUCT_DEFAULTS.countryOfOrigin,
          measurement,
          ...(row.cost != null ? { cost: String(row.cost) } : {}),
        },
        inventoryQuantities: inventoryQuantitiesForFrame(row.frame, locations),
      };
    });
    const created = await bulkCreateVariants(
      storeDomain,
      accessToken,
      product.id,
      variants
    );

    for (const createdRow of created || []) {
      if (!createdRow?.inventoryItem?.id) continue;
      const planRow = plan.toCreate.find((r) => r.sku === createdRow.sku);
      if (!planRow) continue;
      const packageGid = packageGidForSizeLabel(planRow.sizeLabel, packageMap);
      const input = {
        tracked: true,
        requiresShipping: true,
        countryCodeOfOrigin: PRODUCT_DEFAULTS.countryOfOrigin,
      };
      if (planRow.cost != null) input.cost = String(planRow.cost);
      const measurement = {
        weight: { value: Number(planRow.weight), unit: "GRAMS" },
      };
      if (packageGid) measurement.shippingPackageId = packageGid;
      input.measurement = measurement;
      await inventoryItemUpdate(
        storeDomain,
        accessToken,
        createdRow.inventoryItem.id,
        input
      );
    }
  }

  // Re-fetch options after structural changes
  const refreshed = await shopifyGraphql(
    storeDomain,
    accessToken,
    `query ($id: ID!) {
      product(id: $id) {
        id
        options { id name position optionValues { id name } }
      }
    }`,
    { id: product.id }
  );
  const freshProduct = refreshed.product || product;

  if (plan.hasMaterial) {
    await deleteMaterialOption(storeDomain, accessToken, freshProduct);
  }

  await setProductMaterialMetafield(
    storeDomain,
    accessToken,
    product.id,
    resolver
  );

  // Refresh again for prune
  const refreshed2 = await shopifyGraphql(
    storeDomain,
    accessToken,
    `query ($id: ID!) {
      product(id: $id) {
        id
        options { id name position optionValues { id name } }
      }
    }`,
    { id: product.id }
  );
  await pruneObsoleteSizeValues(
    storeDomain,
    accessToken,
    refreshed2.product || freshProduct,
    plan.keepSizeLabels
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  ensureConfigDir();
  if (args.reset && fs.existsSync(PROGRESS_PATH)) {
    fs.unlinkSync(PROGRESS_PATH);
  }
  const progress = loadProgress();
  const done = new Set(progress.doneProductIds || []);

  const creds = getShopifyCredentials();
  const resolver = createMetaobjectResolver(
    shopifyGraphql,
    creds.storeDomain,
    creds.accessToken
  );
  const locations = await resolveWarehouseLocations(
    creds.storeDomain,
    creds.accessToken
  );
  const packageMap = loadPackageMapSoft();
  const packageKeys = Object.keys(packageMap);
  console.log(
    `Warehouses: coloured frames → ${locations.naraina.name}; Stretched Canvas → ${locations.mayapuri.name}`
  );
  console.log(
    `Shipping packages mapped: ${packageKeys.length} sizes` +
      (packageKeys.includes("12x16") && packageKeys.includes("36x48")
        ? " (includes 12x16 + 36x48)"
        : " — WARNING: missing 12x16 and/or 36x48 GIDs")
  );

  console.log(
    args.apply
      ? "APPLY mode — writing to Shopify"
      : "DRY-RUN — pass --apply to execute"
  );

  const products = await listProducts(creds.storeDomain, creds.accessToken, args);
  const pending = products.filter((p) => !done.has(p.id));
  console.log(`Products: ${products.length} listed, ${pending.length} pending`);

  const report = {
    startedAt: new Date().toISOString(),
    apply: args.apply,
    products: [],
    totals: {
      delete: 0,
      update: 0,
      create: 0,
      errors: 0,
      materialRemoved: 0,
    },
  };

  await mapPool(pending, args.concurrency, async (product) => {
    try {
      const variants = await fetchAllVariants(
        creds.storeDomain,
        creds.accessToken,
        product.id
      );
      const plan = planProduct(product, variants);
      const summary = {
        id: product.id,
        handle: product.handle,
        title: product.title,
        shape: plan.shape,
        delete: plan.toDelete.length,
        update: plan.toUpdate.length,
        create: plan.toCreate.length,
        hasMaterial: plan.hasMaterial,
        sampleDeletes: plan.toDelete.slice(0, 3),
        sampleUpdates: plan.toUpdate.slice(0, 3).map((u) => ({
          from: u.oldSku,
          to: u.newSku,
          size: u.sizeLabel,
          price: u.price,
        })),
        sampleCreates: plan.toCreate.slice(0, 3).map((c) => ({
          sku: c.sku,
          size: c.sizeLabel,
          warehouse: c.warehouse,
        })),
      };

      if (args.apply) {
        await applyProductPlan(
          creds.storeDomain,
          creds.accessToken,
          product,
          plan,
          resolver,
          locations,
          packageMap
        );
        done.add(product.id);
        progress.doneProductIds = [...done];
        saveProgress(progress);
        if (plan.hasMaterial) report.totals.materialRemoved += 1;
      }

      report.totals.delete += plan.toDelete.length;
      report.totals.update += plan.toUpdate.length;
      report.totals.create += plan.toCreate.length;
      report.products.push(summary);
      console.log(
        `${args.apply ? "OK" : "PLAN"} ${product.handle}: -${plan.toDelete.length} ~${plan.toUpdate.length} +${plan.toCreate.length} (${plan.shape})`
      );
    } catch (error) {
      report.totals.errors += 1;
      report.products.push({
        id: product.id,
        handle: product.handle,
        error: String(error.message || error),
      });
      console.error(`ERR ${product.handle}:`, error.message || error);
    }
  });

  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), "utf8");
  console.log("Report:", REPORT_PATH);
  console.log("Totals:", report.totals);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
