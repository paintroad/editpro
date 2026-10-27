#!/usr/bin/env node
/**
 * Live migrate: reintroduce Material (Canvas + Fine Art Paper).
 *
 * - Tag existing Size×Frame variants as Material=Canvas (no recreate)
 * - Delete Canvas Size=S variants
 * - Add Size XS; create Fine Art Paper XS/S × 4 framed frames
 * - Sync price/compareAt/cost/weight/package; Paper → Naraina only
 *
 * Usage:
 *   node scripts/migrate-fine-art-paper-matrix.js
 *   node scripts/migrate-fine-art-paper-matrix.js --limit=2
 *   node scripts/migrate-fine-art-paper-matrix.js --handles=soulful-serenity --apply
 *   node scripts/migrate-fine-art-paper-matrix.js --apply
 *
 * Progress: ~/.editpro/migrate-fine-art-paper-progress.json
 * Report:   ~/.editpro/migrate-fine-art-paper-report.json
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { getShopifyCredentials } = require("../lib/config-store");
const { shopifyGraphql } = require("../lib/shopify-client");
const {
  PRODUCT_MATERIAL,
  MATERIAL_CANVAS,
  MATERIAL_PAPER,
  PRODUCT_DEFAULTS,
  VARIANT_ROWS_CANVAS,
  VARIANT_ROWS_PAPER,
  CANVAS_SIZE_CODES,
  PAPER_SIZE_CODES,
  SIZE_CODES,
  SQUARE_SIZES,
  RECTANGLE_SIZES,
  pricingForVariant,
  weightForVariant,
  normalizeFrame,
  normalizeShape,
  normalizeMaterial,
  isPaperMaterial,
  frameDisplayLabel,
  sizeCodeFromLabel,
  isStretchedFrame,
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
const PROGRESS_PATH = path.join(CONFIG_DIR, "migrate-fine-art-paper-progress.json");
const REPORT_PATH = path.join(CONFIG_DIR, "migrate-fine-art-paper-report.json");

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
  if (
    /12\s*["″']?\s*[x×]\s*["″']?\s*12|18\s*["″']?\s*[x×]\s*["″']?\s*18|10\s*["″']?\s*[x×]\s*["″']?\s*10/i.test(
      joined
    )
  ) {
    return "square";
  }
  if (
    /8\s*["″']?\s*[x×]|12\s*["″']?\s*[x×]\s*["″']?\s*16|36\s*["″']?\s*[x×]\s*["″']?\s*48/i.test(
      joined
    )
  ) {
    return "rectangle";
  }
  if (
    /24\s*["″']?\s*[x×]\s*["″']?\s*36|18\s*["″']?\s*[x×]\s*["″']?\s*24/i.test(joined) &&
    !/24\s*["″']?\s*[x×]\s*["″']?\s*24|36\s*["″']?\s*[x×]\s*["″']?\s*36/i.test(joined)
  ) {
    return "rectangle";
  }
  return "square";
}

function targetSizes(shape) {
  return normalizeShape(shape) === "rectangle" ? RECTANGLE_SIZES : SQUARE_SIZES;
}

function productIdFromSku(sku) {
  const m = String(sku || "").match(/^(\d{4,})-/);
  return m ? m[1] : null;
}

function frameSuffixFromSku(sku) {
  const m = String(sku || "").match(/-(XS|S|M|L|XL)-(\d+)$/i);
  return m ? Number(m[2]) : null;
}

function suffixForCombo(material, frameKey) {
  const rows = isPaperMaterial(material)
    ? VARIANT_ROWS_PAPER
    : VARIANT_ROWS_CANVAS;
  const hit = rows.find((r) => r.frame === normalizeFrame(frameKey));
  return hit ? hit.n : null;
}

function shouldSkipProduct(product) {
  const type = String(product.productType || "").toLowerCase();
  const title = String(product.title || "").toLowerCase();
  const handle = String(product.handle || "").toLowerCase();
  if (type.includes("gift") || title.includes("gift card") || handle.includes("gift-card")) {
    return "gift-card";
  }
  return null;
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
  if (!naraina) throw new Error("Naraina/Nariana warehouse location not found");
  if (!mayapuri) throw new Error("Mayapuri warehouse location not found");
  return { naraina, mayapuri };
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
            nodes {
              id title handle status productType
              options { id name position optionValues { id name linkedMetafieldValue } }
            }
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
          nodes {
            id title handle status productType
            options { id name position optionValues { id name linkedMetafieldValue } }
          }
        }
      }`,
      { cursor }
    );
    const page = data.products;
    out.push(...(page?.nodes || []));
    if (limit && out.length >= limit) return out.slice(0, limit);
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

async function refreshProductOptions(storeDomain, accessToken, productId) {
  const data = await shopifyGraphql(
    storeDomain,
    accessToken,
    `query ($id: ID!) {
      product(id: $id) {
        id
        title
        handle
        productType
        options { id name position optionValues { id name linkedMetafieldValue } }
      }
    }`,
    { id: productId }
  );
  return data.product;
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

function buildOptionValueMaps(options) {
  const sizeByName = new Map();
  const materialByName = new Map();
  const frameByName = new Map();
  for (const option of options || []) {
    const name = String(option.name || "").toLowerCase();
    for (const value of option.optionValues || []) {
      if (name === "size") sizeByName.set(value.name, value.id);
      else if (name === "material") {
        materialByName.set(value.name, value.id);
        materialByName.set(normalizeMaterial(value.name), value.id);
      } else if (name === "frame") frameByName.set(value.name, value.id);
    }
  }
  return { sizeByName, materialByName, frameByName };
}

function buildOptionValues(product, sizeLabel, materialLabel, frameLabel) {
  const maps = buildOptionValueMaps(product.options);
  const out = [];

  const materialId =
    maps.materialByName.get(materialLabel) ||
    maps.materialByName.get(normalizeMaterial(materialLabel));
  if (!materialId) {
    throw new Error(`Missing Material option value id for "${materialLabel}"`);
  }
  out.push({ optionName: "Material", id: materialId });

  const sizeId = maps.sizeByName.get(sizeLabel);
  if (sizeId) out.push({ optionName: "Size", id: sizeId });
  else out.push({ optionName: "Size", name: sizeLabel });

  const frameId = maps.frameByName.get(frameLabel);
  if (!frameId) {
    throw new Error(`Missing Frame option value id for "${frameLabel}"`);
  }
  out.push({ optionName: "Frame", id: frameId });

  return out;
}

function packageGidForSizeLabel(sizeLabel, packageMap) {
  const key = sizeKeyFromOptionValue(sizeLabel);
  return packageGidForSizeKey(key, packageMap);
}

function inventoryQuantitiesForVariant(material, frameKey, locations) {
  const qty = PRODUCT_DEFAULTS.inventoryQty;
  if (isPaperMaterial(material)) {
    return [{ availableQuantity: qty, locationId: locations.naraina.id }];
  }
  if (isStretchedFrame(frameKey)) {
    return [{ availableQuantity: qty, locationId: locations.mayapuri.id }];
  }
  return [{ availableQuantity: qty, locationId: locations.naraina.id }];
}

async function ensureMaterialOption(storeDomain, accessToken, product, resolver) {
  const materialOpt = (product.options || []).find(
    (o) => String(o.name || "").toLowerCase() === "material"
  );

  const canvasGid = await resolver.resolveId(METAOBJECT_TYPES.material, MATERIAL_CANVAS);
  const paperGid = await resolver.resolveId(METAOBJECT_TYPES.material, MATERIAL_PAPER);
  if (!canvasGid || !paperGid) {
    throw new Error("Could not resolve Canvas / Fine Art Paper material metaobjects");
  }

  if (!materialOpt) {
    // Add Material with Canvas only so existing variants inherit Canvas.
    const data = await shopifyGraphql(
      storeDomain,
      accessToken,
      `mutation ($productId: ID!, $options: [OptionCreateInput!]!, $variantStrategy: ProductOptionCreateVariantStrategy) {
        productOptionsCreate(productId: $productId, options: $options, variantStrategy: $variantStrategy) {
          userErrors { field message code }
          product {
            id
            options { id name position optionValues { id name linkedMetafieldValue } }
          }
        }
      }`,
      {
        productId: product.id,
        variantStrategy: "LEAVE_AS_IS",
        options: [
          {
            name: "Material",
            position: 1,
            linkedMetafield: {
              namespace: "shopify",
              key: "material",
              values: [canvasGid],
            },
          },
        ],
      }
    );
    const errors = data.productOptionsCreate?.userErrors || [];
    const real = errors.filter(
      (e) =>
        !/already exists|taken|duplicate|linked to the 'shopify\.material'/i.test(
          String(e.message || "")
        )
    );
    if (real.length) {
      throw new Error(real.map((e) => e.message).join("; "));
    }
  }

  let live =
    (await refreshProductOptions(storeDomain, accessToken, product.id)) || product;
  let opt = (live.options || []).find(
    (o) => String(o.name || "").toLowerCase() === "material"
  );
  if (!opt) {
    throw new Error("Material option missing after create");
  }

  const names = new Set((opt.optionValues || []).map((v) => v.name));
  const toAdd = [];
  if (![...names].some((n) => normalizeMaterial(n) === MATERIAL_CANVAS)) {
    toAdd.push({ linkedMetafieldValue: canvasGid });
  }
  if (![...names].some((n) => normalizeMaterial(n) === MATERIAL_PAPER)) {
    toAdd.push({ linkedMetafieldValue: paperGid });
  }

  if (toAdd.length) {
    const data = await shopifyGraphql(
      storeDomain,
      accessToken,
      `mutation ($productId: ID!, $option: OptionUpdateInput!, $optionValuesToAdd: [OptionValueCreateInput!]) {
        productOptionUpdate(productId: $productId, option: $option, optionValuesToAdd: $optionValuesToAdd) {
          userErrors { field message }
        }
      }`,
      {
        productId: live.id,
        option: { id: opt.id },
        optionValuesToAdd: toAdd,
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

  return refreshProductOptions(storeDomain, accessToken, product.id);
}

async function ensureSizeOptionValues(storeDomain, accessToken, product, neededLabels) {
  const sizeOpt = (product.options || []).find(
    (o) => String(o.name || "").toLowerCase() === "size"
  );
  if (!sizeOpt) return product;
  const existing = new Set((sizeOpt.optionValues || []).map((v) => v.name));
  const toAdd = neededLabels.filter((label) => label && !existing.has(label));
  if (!toAdd.length) return product;

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
  return refreshProductOptions(storeDomain, accessToken, product.id);
}

async function reorderOptions(storeDomain, accessToken, product) {
  const byName = new Map(
    (product.options || []).map((o) => [String(o.name || "").toLowerCase(), o])
  );
  const material = byName.get("material");
  const size = byName.get("size");
  const frame = byName.get("frame");
  if (!material || !size || !frame) return;

  const data = await shopifyGraphql(
    storeDomain,
    accessToken,
    `mutation ($productId: ID!, $options: [OptionReorderInput!]!) {
      productOptionsReorder(productId: $productId, options: $options) {
        userErrors { field message }
      }
    }`,
    {
      productId: product.id,
      options: [
        {
          name: material.name,
          values: orderedMaterialValues(material).map((name) => ({ name })),
        },
        {
          name: size.name,
          values: orderedSizeValues(size).map((name) => ({ name })),
        },
        {
          name: frame.name,
          values: (frame.optionValues || []).map((v) => ({ name: v.name })),
        },
      ],
    }
  );
  const errors = data.productOptionsReorder?.userErrors || [];
  if (errors.length) {
    console.warn(
      `  reorder warn: ${errors.map((e) => e.message).join("; ")}`
    );
  }
}

function orderedMaterialValues(materialOpt) {
  const names = (materialOpt.optionValues || []).map((v) => v.name);
  const canvas = names.find((n) => normalizeMaterial(n) === MATERIAL_CANVAS);
  const paper = names.find((n) => normalizeMaterial(n) === MATERIAL_PAPER);
  const ordered = [];
  if (canvas) ordered.push(canvas);
  if (paper) ordered.push(paper);
  for (const n of names) {
    if (!ordered.includes(n)) ordered.push(n);
  }
  return ordered;
}

function orderedSizeValues(sizeOpt) {
  const names = (sizeOpt.optionValues || []).map((v) => v.name);
  const byCode = new Map();
  for (const name of names) {
    const code = sizeCodeFromLabel(name);
    if (code) byCode.set(code, name);
  }
  const ordered = [];
  for (const code of SIZE_CODES) {
    if (byCode.has(code)) ordered.push(byCode.get(code));
  }
  for (const name of names) {
    if (!ordered.includes(name)) ordered.push(name);
  }
  return ordered;
}

async function setProductMaterialMetafield(storeDomain, accessToken, productId, resolver) {
  const ids = await resolver.resolveIds(METAOBJECT_TYPES.material, [
    MATERIAL_CANVAS,
  ]);
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

function planProduct(product, variants) {
  const sizeOpt = (product.options || []).find(
    (o) => String(o.name || "").toLowerCase() === "size"
  );
  const sizeLabels = (sizeOpt?.optionValues || []).map((v) => v.name);
  const shape = normalizeShape(detectShapeFromSizeLabels(sizeLabels));
  const sizes = targetSizes(shape);
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
  const presentKeys = new Set(); // material|sizeCode|frame

  for (const variant of variants) {
    const sizeLabel = selectedValue(variant.selectedOptions, "Size");
    const materialRaw = selectedValue(variant.selectedOptions, "Material");
    const frameLabel = selectedValue(variant.selectedOptions, "Frame");
    const frameKey = normalizeFrame(frameLabel);
    const sizeCode = sizeCodeFromLabel(sizeLabel);
    const material = materialRaw
      ? normalizeMaterial(materialRaw)
      : MATERIAL_CANVAS;

    // Delete Canvas S (and any paper that somehow has stretched)
    if (
      material === MATERIAL_CANVAS &&
      sizeCode === "S"
    ) {
      toDelete.push({
        id: variant.id,
        sku: variant.sku,
        reason: "canvas-s",
        title: variant.title,
      });
      continue;
    }

    if (material === MATERIAL_PAPER && isStretchedFrame(frameKey)) {
      toDelete.push({
        id: variant.id,
        sku: variant.sku,
        reason: "paper-stretched",
        title: variant.title,
      });
      continue;
    }

    if (material === MATERIAL_CANVAS && !CANVAS_SIZE_CODES.includes(sizeCode)) {
      // XS on canvas shouldn't exist; paper handles XS. Orphan → delete.
      if (sizeCode === "XS") {
        toDelete.push({
          id: variant.id,
          sku: variant.sku,
          reason: "canvas-xs",
          title: variant.title,
        });
        continue;
      }
    }

    if (material === MATERIAL_PAPER && !PAPER_SIZE_CODES.includes(sizeCode)) {
      toDelete.push({
        id: variant.id,
        sku: variant.sku,
        reason: "paper-wrong-size",
        title: variant.title,
      });
      continue;
    }

    const allowedFrames = (
      material === MATERIAL_PAPER ? VARIANT_ROWS_PAPER : VARIANT_ROWS_CANVAS
    ).map((r) => r.frame);
    if (!frameKey || !allowedFrames.includes(frameKey)) {
      toDelete.push({
        id: variant.id,
        sku: variant.sku,
        reason: "unknown-frame",
        title: variant.title,
      });
      continue;
    }

    const newSizeLabel = sizes[sizeCode];
    if (!sizeCode || !newSizeLabel) {
      toDelete.push({
        id: variant.id,
        sku: variant.sku,
        reason: "unmapped-size",
        title: variant.title,
      });
      continue;
    }

    const pricing = pricingForVariant(shape, sizeCode, material, frameKey);
    const weight = weightForVariant(shape, sizeCode);
    const n =
      suffixForCombo(material, frameKey) ||
      frameSuffixFromSku(variant.sku) ||
      5;
    const newSku = catalogProductId
      ? `${catalogProductId}-${sizeCode}-${n}`
      : variant.sku;

    presentKeys.add(`${material}|${sizeCode}|${frameKey}`);

    toUpdate.push({
      id: variant.id,
      oldSku: variant.sku,
      newSku,
      sizeCode,
      sizeLabel: newSizeLabel,
      material,
      frameLabel: frameDisplayLabel(frameKey),
      frame: frameKey,
      price: pricing?.price,
      compareAt: pricing?.compareAt,
      cost: pricing?.cost,
      weight,
      inventoryItemId: variant.inventoryItem?.id,
    });
  }

  const toCreate = [];
  if (catalogProductId) {
    for (const sizeCode of PAPER_SIZE_CODES) {
      for (const row of VARIANT_ROWS_PAPER) {
        const key = `${MATERIAL_PAPER}|${sizeCode}|${row.frame}`;
        if (presentKeys.has(key)) continue;
        const pricing = pricingForVariant(
          shape,
          sizeCode,
          MATERIAL_PAPER,
          row.frame
        );
        if (!pricing) continue;
        const weight = weightForVariant(shape, sizeCode);
        toCreate.push({
          sizeCode,
          sizeLabel: sizes[sizeCode],
          material: MATERIAL_PAPER,
          frame: row.frame,
          frameLabel: frameDisplayLabel(row.frame),
          sku: `${catalogProductId}-${sizeCode}-${row.n}`,
          price: String(pricing.price),
          compareAtPrice: String(pricing.compareAt),
          cost: pricing.cost,
          weight,
          warehouse: "naraina",
        });
      }
    }

    for (const sizeCode of CANVAS_SIZE_CODES) {
      for (const row of VARIANT_ROWS_CANVAS) {
        const key = `${MATERIAL_CANVAS}|${sizeCode}|${row.frame}`;
        if (presentKeys.has(key)) continue;
        const pricing = pricingForVariant(
          shape,
          sizeCode,
          MATERIAL_CANVAS,
          row.frame
        );
        if (!pricing) continue;
        const weight = weightForVariant(shape, sizeCode);
        toCreate.push({
          sizeCode,
          sizeLabel: sizes[sizeCode],
          material: MATERIAL_CANVAS,
          frame: row.frame,
          frameLabel: frameDisplayLabel(row.frame),
          sku: `${catalogProductId}-${sizeCode}-${row.n}`,
          price: String(pricing.price),
          compareAtPrice: String(pricing.compareAt),
          cost: pricing.cost,
          weight,
          warehouse: isStretchedFrame(row.frame) ? "mayapuri" : "naraina",
        });
      }
    }
  }

  const keepSizeLabels = SIZE_CODES.map((c) => sizes[c]).filter(Boolean);

  return {
    shape,
    hasMaterial,
    catalogProductId,
    keepSizeLabels,
    toDelete,
    toUpdate,
    toCreate,
  };
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
  // 1. Ensure Material option (Canvas + Fine Art Paper)
  let live = await ensureMaterialOption(
    storeDomain,
    accessToken,
    product,
    resolver
  );

  // 2. Ensure all size labels including XS
  live = (await ensureSizeOptionValues(
    storeDomain,
    accessToken,
    live,
    plan.keepSizeLabels
  )) || live;

  // 3. Delete Canvas S (and other obsolete)
  if (plan.toDelete.length) {
    await bulkDeleteVariants(
      storeDomain,
      accessToken,
      product.id,
      plan.toDelete.map((v) => v.id)
    );
  }

  // Refresh after structural changes
  live =
    (await refreshProductOptions(storeDomain, accessToken, product.id)) || live;

  // 4. Update remaining variants → Material=Canvas (or paper), prices, SKUs
  if (plan.toUpdate.length) {
    const variants = plan.toUpdate.map((row) => {
      const packageGid = packageGidForSizeLabel(row.sizeLabel, packageMap);
      const measurement = {};
      if (row.weight != null) {
        measurement.weight = { value: Number(row.weight), unit: "GRAMS" };
      }
      if (packageGid) measurement.shippingPackageId = packageGid;
      return {
        id: row.id,
        price: String(row.price),
        compareAtPrice: String(row.compareAt),
        optionValues: buildOptionValues(
          live,
          row.sizeLabel,
          row.material,
          row.frameLabel
        ),
        inventoryPolicy: "CONTINUE",
        taxable: true,
        inventoryItem: {
          sku: row.newSku,
          tracked: true,
          requiresShipping: true,
          countryCodeOfOrigin: PRODUCT_DEFAULTS.countryOfOrigin,
          ...(Object.keys(measurement).length ? { measurement } : {}),
        },
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

  // 5. Create missing paper (+ any missing canvas)
  if (plan.toCreate.length) {
    live =
      (await refreshProductOptions(storeDomain, accessToken, product.id)) ||
      live;

    const variants = plan.toCreate.map((row) => {
      const packageGid = packageGidForSizeLabel(row.sizeLabel, packageMap);
      const measurement = {
        weight: { value: Number(row.weight), unit: "GRAMS" },
      };
      if (packageGid) measurement.shippingPackageId = packageGid;
      return {
        price: row.price,
        compareAtPrice: row.compareAtPrice,
        optionValues: buildOptionValues(
          live,
          row.sizeLabel,
          row.material,
          row.frameLabel
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
        inventoryQuantities: inventoryQuantitiesForVariant(
          row.material,
          row.frame,
          locations
        ),
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

  live =
    (await refreshProductOptions(storeDomain, accessToken, product.id)) || live;
  try {
    await reorderOptions(storeDomain, accessToken, live);
  } catch (error) {
    console.warn(`  reorder failed: ${error.message || error}`);
  }
  // Product material metafield is linked to the Material option — Shopify rejects metafieldsSet.
  // Option values own the material taxonomy now; skip product metafield write.
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

  console.log(
    `Warehouses: framed/paper → ${locations.naraina.name}; Stretched Canvas → ${locations.mayapuri.name}`
  );
  console.log(
    `Packages mapped: ${Object.keys(packageMap).length} (8x10=${Boolean(packageMap["8x10"])}, 10x10=${Boolean(packageMap["10x10"])})`
  );
  console.log(
    args.apply
      ? "APPLY mode — writing to Shopify"
      : "DRY-RUN — pass --apply to execute"
  );

  let products = await listProducts(creds.storeDomain, creds.accessToken, args);
  // When --limit without handles, listProducts already sliced; still filter skips after
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
      skipped: 0,
      errors: 0,
    },
  };

  await mapPool(pending, args.concurrency, async (product) => {
    const skip = shouldSkipProduct(product);
    if (skip) {
      report.totals.skipped += 1;
      report.products.push({
        id: product.id,
        handle: product.handle,
        skipped: skip,
      });
      console.log(`SKIP ${product.handle}: ${skip}`);
      if (args.apply) {
        done.add(product.id);
        progress.doneProductIds = [...done];
        saveProgress(progress);
      }
      return;
    }

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
        sampleCreates: plan.toCreate.slice(0, 4).map((c) => ({
          sku: c.sku,
          material: c.material,
          size: c.sizeLabel,
          price: c.price,
          compareAt: c.compareAtPrice,
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
