#!/usr/bin/env node
/**
 * Rename Wooden → Wooden Finish, add Dark Wood Finish + Stretched Canvas variants.
 *
 * Usage:
 *   node scripts/migrate-frame-variants.js
 *   node scripts/migrate-frame-variants.js --handles=soulful-serenity
 *   node scripts/migrate-frame-variants.js --limit=3 --apply
 *   node scripts/migrate-frame-variants.js --apply
 *
 * Progress: ~/.editpro/migrate-frame-variants-progress.json
 * Report:   ~/.editpro/migrate-frame-variants-report.json
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { getShopifyCredentials } = require("../lib/config-store");
const { shopifyGraphql } = require("../lib/shopify-client");
const {
  METAOBJECT_TYPES,
  createMetaobjectResolver,
  normalizeLookupKey,
} = require("../lib/shopify-metaobject-resolver");
const {
  buildVariants,
  frameDisplayLabel,
  normalizeFrame,
  normalizeShape,
  PRODUCT_DEFAULTS,
  SQUARE_SIZES,
  RECTANGLE_SIZES,
} = require("../lib/catalog-variant-templates");

const CONFIG_DIR = path.join(os.homedir(), ".editpro");
const PROGRESS_PATH = path.join(CONFIG_DIR, "migrate-frame-variants-progress.json");
const REPORT_PATH = path.join(CONFIG_DIR, "migrate-frame-variants-report.json");
const DARK_WOOD_GID_PATH = path.join(CONFIG_DIR, "dark-wood-finish-metaobject-gid.txt");

const WOODEN_OLD = "Wooden";
const WOODEN_NEW = "Wooden Finish";
const DARK_WOOD = "Dark Wood Finish";
const STRETCHED = "Stretched Canvas";

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
  let limit = null;
  let concurrency = 1;
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
  return { apply, limit, handles, concurrency };
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
  fs.writeFileSync(PROGRESS_PATH, JSON.stringify(progress, null, 2), "utf8");
}

function weightUnitToShopify(unit) {
  const u = String(unit || "g").toLowerCase();
  if (u === "kg" || u === "kilograms") return "KILOGRAMS";
  return "GRAMS";
}

function optionByName(options, name) {
  const target = String(name || "").toLowerCase();
  return (options || []).find((o) => String(o.name || "").toLowerCase() === target) || null;
}

function selectedValue(selectedOptions, name) {
  const target = String(name || "").toLowerCase();
  const hit = (selectedOptions || []).find(
    (o) => String(o.name || "").toLowerCase() === target
  );
  return hit ? String(hit.value || "") : "";
}

function detectShapeFromSizeLabels(sizeLabels) {
  let squareHits = 0;
  let rectHits = 0;
  for (const label of sizeLabels || []) {
    const text = String(label || "");
    for (const v of Object.values(SQUARE_SIZES)) {
      if (text === v || text.includes(v.replace(/^[^"]+/, "").trim())) {
        // loose: equal sides
      }
    }
    const m = text.match(/(\d+(?:\.\d+)?)\s*"?\s*[x×]\s*"?\s*(\d+(?:\.\d+)?)/i);
    if (!m) continue;
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === b) squareHits += 1;
    else rectHits += 1;
  }
  return squareHits >= rectHits ? "square" : "rectangle";
}

function extractProductIdFromSkus(variants) {
  for (const v of variants || []) {
    const sku = String(v.sku || "");
    const m = sku.match(/^(.+)-(XS|S|M|L|XL)-\d+$/i);
    if (m) return m[1];
  }
  return null;
}

function variantKey(size, material, frame) {
  return `${size}||${material}||${frameDisplayLabel(frame)}`;
}

async function getPrimaryLocationId(storeDomain, accessToken) {
  const data = await shopifyGraphql(
    storeDomain,
    accessToken,
    `query { locations(first: 1) { nodes { id name } } }`
  );
  const id = data.locations?.nodes?.[0]?.id;
  if (!id) throw new Error("No Shopify location found.");
  return id;
}

async function ensureDarkWoodMetaobject(storeDomain, accessToken, resolver) {
  let gid = await resolver.resolveId(METAOBJECT_TYPES.frameStyle, DARK_WOOD);
  if (gid) return gid;
  gid = await resolver.resolveId(METAOBJECT_TYPES.frameStyle, "dark-wood");
  if (gid) return gid;

  if (fs.existsSync(DARK_WOOD_GID_PATH)) {
    const saved = fs.readFileSync(DARK_WOOD_GID_PATH, "utf8").trim();
    if (saved.startsWith("gid://")) return saved;
  }

  // Reuse Wooden taxonomy base (standard frame-style values share TaxonomyValue/24017).
  const woodenTaxonomy = "gid://shopify/TaxonomyValue/24017";
  const handle = "dark-wood-finish";
  const data = await shopifyGraphql(
    storeDomain,
    accessToken,
    `mutation CreateDarkWood($metaobject: MetaobjectCreateInput!) {
      metaobjectCreate(metaobject: $metaobject) {
        metaobject { id handle displayName }
        userErrors { field message code }
      }
    }`,
    {
      metaobject: {
        type: METAOBJECT_TYPES.frameStyle,
        handle,
        fields: [
          { key: "label", value: DARK_WOOD },
          { key: "taxonomy_reference", value: woodenTaxonomy },
        ],
      },
    }
  );
  const errors = data.metaobjectCreate?.userErrors || [];
  if (errors.length) {
    // Taxonomy types often reject create — try searching again after soft failure
    const msg = errors.map((e) => e.message).join("; ");
    const retry = await resolver.resolveId(METAOBJECT_TYPES.frameStyle, DARK_WOOD);
    if (retry) return retry;
    throw new Error(`Could not create Dark Wood Finish metaobject: ${msg}`);
  }
  gid = data.metaobjectCreate?.metaobject?.id;
  if (!gid) throw new Error("Dark Wood Finish metaobject create returned no id.");
  fs.writeFileSync(DARK_WOOD_GID_PATH, gid, "utf8");
  return gid;
}

async function tryRenameWoodenMetaobject(storeDomain, accessToken, woodenGid) {
  if (!woodenGid) return { ok: false, reason: "no-gid" };
  const data = await shopifyGraphql(
    storeDomain,
    accessToken,
    `mutation UpdateWoodenLabel($id: ID!, $metaobject: MetaobjectUpdateInput!) {
      metaobjectUpdate(id: $id, metaobject: $metaobject) {
        metaobject { id displayName fields { key value } }
        userErrors { field message code }
      }
    }`,
    {
      id: woodenGid,
      metaobject: {
        fields: [{ key: "label", value: WOODEN_NEW }],
      },
    }
  );
  const errors = data.metaobjectUpdate?.userErrors || [];
  if (errors.length) {
    return { ok: false, reason: errors.map((e) => e.message).join("; ") };
  }
  return { ok: true, displayName: data.metaobjectUpdate?.metaobject?.displayName };
}

async function fetchProductPage(storeDomain, accessToken, cursor, query) {
  return shopifyGraphql(
    storeDomain,
    accessToken,
    `query Products($cursor: String, $query: String) {
      products(first: 50, after: $cursor, query: $query) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          title
          handle
          options {
            id
            name
            optionValues { id name hasVariants linkedMetafieldValue }
          }
          variants(first: 100) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id
              sku
              title
              price
              compareAtPrice
              selectedOptions { name value }
            }
          }
        }
      }
    }`,
    { cursor, query }
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
              title
              price
              compareAtPrice
              selectedOptions { name value }
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

async function updateFrameOption(storeDomain, accessToken, productId, optionId, {
  valuesToAdd = [],
  valuesToUpdate = [],
} = {}) {
  if (!valuesToAdd.length && !valuesToUpdate.length) {
    return null;
  }
  const data = await shopifyGraphql(
    storeDomain,
    accessToken,
    `mutation ProductOptionUpdate(
      $productId: ID!
      $option: OptionUpdateInput!
      $optionValuesToAdd: [OptionValueCreateInput!]
      $optionValuesToUpdate: [OptionValueUpdateInput!]
      $variantStrategy: ProductOptionUpdateVariantStrategy
    ) {
      productOptionUpdate(
        productId: $productId
        option: $option
        optionValuesToAdd: $optionValuesToAdd
        optionValuesToUpdate: $optionValuesToUpdate
        variantStrategy: $variantStrategy
      ) {
        userErrors { field message code }
        product {
          options {
            id
            name
            optionValues { id name linkedMetafieldValue }
          }
        }
      }
    }`,
    {
      productId,
      option: { id: optionId },
      optionValuesToAdd: valuesToAdd.length ? valuesToAdd : null,
      optionValuesToUpdate: valuesToUpdate.length ? valuesToUpdate : null,
      variantStrategy: "LEAVE_AS_IS",
    }
  );
  const errors = data.productOptionUpdate?.userErrors || [];
  if (errors.length) {
    throw new Error(errors.map((e) => e.message).join("; "));
  }
  return data.productOptionUpdate?.product?.options || [];
}

function buildOptionValueIdMaps(options) {
  const sizeByName = new Map();
  const materialByName = new Map();
  const materialByMetaobjectId = new Map();
  const frameByName = new Map();
  const frameByMetaobjectId = new Map();

  for (const option of options || []) {
    const name = String(option.name || "").toLowerCase();
    for (const value of option.optionValues || []) {
      if (name === "size") {
        sizeByName.set(value.name, value.id);
      } else if (name === "material") {
        if (value.linkedMetafieldValue) {
          materialByMetaobjectId.set(value.linkedMetafieldValue, value.id);
        }
        materialByName.set(value.name, value.id);
      } else if (name === "frame") {
        if (value.linkedMetafieldValue) {
          frameByMetaobjectId.set(value.linkedMetafieldValue, value.id);
        }
        frameByName.set(value.name, value.id);
      }
    }
  }
  return {
    sizeByName,
    materialByName,
    materialByMetaobjectId,
    frameByName,
    frameByMetaobjectId,
  };
}

function resolveOptionValues(variant, optionValueIds, linked, useLinked) {
  const size = variant.size;
  const material = variant.material;
  const frame = frameDisplayLabel(variant.exportFrame || variant.frame);

  if (!useLinked) {
    return [
      { optionName: "Size", name: size },
      { optionName: "Material", name: material },
      { optionName: "Frame", name: frame },
    ];
  }

  const sizeId = optionValueIds.sizeByName.get(size);
  const materialGid = linked.materialByLabel.get(material);
  const frameGid =
    linked.frameByLabel.get(frame) ||
    linked.frameByLabel.get(normalizeFrame(frame));
  const materialId =
    (materialGid && optionValueIds.materialByMetaobjectId.get(materialGid)) ||
    optionValueIds.materialByName.get(material);
  const frameId =
    (frameGid && optionValueIds.frameByMetaobjectId.get(frameGid)) ||
    optionValueIds.frameByName.get(frame);

  if (!sizeId || !materialId || !frameId) {
    throw new Error(
      `Missing option value ids for ${size} / ${material} / ${frame}`
    );
  }
  return [
    { optionName: "Size", id: sizeId },
    { optionName: "Material", id: materialId },
    { optionName: "Frame", id: frameId },
  ];
}

async function bulkCreateVariants(
  storeDomain,
  accessToken,
  productId,
  variants,
  locationId,
  optionValueIds,
  linked,
  useLinked
) {
  if (!variants.length) return [];
  const created = [];
  const CHUNK = 25;
  for (let i = 0; i < variants.length; i += CHUNK) {
    const chunk = variants.slice(i, i + CHUNK);
    const input = chunk.map((variant) => {
      const inventoryItem = {
        sku: variant.sku,
        tracked: true,
        requiresShipping: true,
      };
      if (variant.weight != null) {
        inventoryItem.measurement = {
          weight: {
            value: Number(variant.weight),
            unit: weightUnitToShopify(variant.weightUnit),
          },
        };
      }
      return {
        price: String(variant.price ?? ""),
        compareAtPrice:
          variant.compareAtPrice != null ? String(variant.compareAtPrice) : null,
        optionValues: resolveOptionValues(variant, optionValueIds, linked, useLinked),
        inventoryItem,
        inventoryQuantities: [
          {
            availableQuantity:
              Number(variant.inventoryQty) || PRODUCT_DEFAULTS.inventoryQty,
            locationId,
          },
        ],
        inventoryPolicy: "CONTINUE",
        taxable: true,
      };
    });

    const data = await shopifyGraphql(
      storeDomain,
      accessToken,
      `mutation ProductVariantsBulkCreate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkCreate(productId: $productId, variants: $variants) {
          productVariants { id sku inventoryItem { id } }
          userErrors { field message }
        }
      }`,
      { productId, variants: input }
    );
    const errors = data.productVariantsBulkCreate?.userErrors || [];
    if (errors.length) {
      throw new Error(errors.map((e) => e.message).join("; "));
    }
    const rows = data.productVariantsBulkCreate?.productVariants || [];
    created.push(...rows);

    const costJobs = [];
    for (let j = 0; j < chunk.length; j += 1) {
      const variant = chunk[j];
      const row = rows.find((r) => r.sku === variant.sku) || rows[j];
      const inventoryItemId = row?.inventoryItem?.id;
      if (!inventoryItemId || variant.cost == null) continue;
      costJobs.push({ inventoryItemId, cost: variant.cost });
    }

    if (costJobs.length) {
      await mapPool(costJobs, Math.min(10, costJobs.length), async (job) => {
        await shopifyGraphql(
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
      });
    }
  }
  return created;
}

async function processProduct(product, ctx) {
  const {
    storeDomain,
    accessToken,
    locationId,
    apply,
    frameGids,
    linked,
  } = ctx;

  const options = product.options || [];
  const frameOpt = optionByName(options, "Frame");
  const sizeOpt = optionByName(options, "Size");
  const materialOpt = optionByName(options, "Material");
  if (!frameOpt || !sizeOpt || !materialOpt) {
    return {
      status: "skipped-missing-options",
      handle: product.handle,
      productId: product.id,
    };
  }

  const variants = await fetchAllVariants(
    storeDomain,
    accessToken,
    product.id,
    product.variants
  );

  const sizeLabels = (sizeOpt.optionValues || []).map((v) => v.name);
  const shape = detectShapeFromSizeLabels(sizeLabels);
  const productKey =
    extractProductIdFromSkus(variants) ||
    String(product.handle || "").replace(/[^a-zA-Z0-9_-]/g, "") ||
    "product";

  const expected = buildVariants(productKey, shape);
  const existingKeys = new Set();
  const existingSkus = new Set();
  for (const v of variants) {
    existingSkus.add(String(v.sku || ""));
    existingKeys.add(
      variantKey(
        selectedValue(v.selectedOptions, "Size"),
        selectedValue(v.selectedOptions, "Material"),
        selectedValue(v.selectedOptions, "Frame")
      )
    );
  }

  const woodenValue = (frameOpt.optionValues || []).find(
    (v) => v.name === WOODEN_OLD || v.name === WOODEN_NEW
  );
  const hasDark = (frameOpt.optionValues || []).some((v) => v.name === DARK_WOOD);
  const hasStretched = (frameOpt.optionValues || []).some(
    (v) => v.name === STRETCHED
  );

  const missing = expected.filter((v) => {
    if (existingSkus.has(v.sku)) return false;
    const key = variantKey(v.size, v.material, v.exportFrame);
    return !existingKeys.has(key);
  });

  const plan = {
    handle: product.handle,
    productId: product.id,
    shape,
    productKey,
    renameWooden: Boolean(
      woodenValue && woodenValue.name === WOODEN_OLD
    ),
    addDarkWood: !hasDark,
    addStretched: !hasStretched,
    missingCount: missing.length,
    sampleMissingSkus: missing.slice(0, 5).map((v) => v.sku),
  };

  if (!apply) {
    return { status: "planned", ...plan };
  }

  if (
    !plan.renameWooden &&
    !plan.addDarkWood &&
    !plan.addStretched &&
    missing.length === 0
  ) {
    return { status: "applied", ...plan, createdCount: 0, alreadyComplete: true };
  }

  let optionsAfter = options;
  const valuesToUpdate = [];
  const valuesToAdd = [];

  if (plan.renameWooden && woodenValue) {
    // Prefer renaming display via option value when possible.
    valuesToUpdate.push({
      id: woodenValue.id,
      name: WOODEN_NEW,
    });
  }
  if (plan.addDarkWood) {
    if (frameGids.darkWood) {
      valuesToAdd.push({ linkedMetafieldValue: frameGids.darkWood });
    } else {
      valuesToAdd.push({ name: DARK_WOOD });
    }
  }
  if (plan.addStretched) {
    if (frameGids.stretched) {
      valuesToAdd.push({ linkedMetafieldValue: frameGids.stretched });
    } else {
      valuesToAdd.push({ name: STRETCHED });
    }
  }

  const frameLinked = (frameOpt.optionValues || []).some(
    (v) => v.linkedMetafieldValue
  );

  try {
    if (valuesToUpdate.length || valuesToAdd.length) {
      // Linked options often reject name updates — fall back to metafield-only adds.
      try {
        optionsAfter = await updateFrameOption(
          storeDomain,
          accessToken,
          product.id,
          frameOpt.id,
          { valuesToAdd, valuesToUpdate }
        );
      } catch (error) {
        const msg = String(error.message || error);
        if (valuesToUpdate.length && /name|linked/i.test(msg)) {
          optionsAfter = await updateFrameOption(
            storeDomain,
            accessToken,
            product.id,
            frameOpt.id,
            {
              valuesToAdd,
              valuesToUpdate: [],
            }
          );
          plan.renameWoodenError = msg;
        } else if (valuesToAdd.some((v) => v.linkedMetafieldValue) && /linked/i.test(msg)) {
          optionsAfter = await updateFrameOption(
            storeDomain,
            accessToken,
            product.id,
            frameOpt.id,
            {
              valuesToAdd: valuesToAdd.map((v) =>
                v.linkedMetafieldValue
                  ? { name: v.linkedMetafieldValue === frameGids.darkWood ? DARK_WOOD : STRETCHED }
                  : v
              ),
              valuesToUpdate: [],
            }
          );
          plan.addOptionFallback = msg;
        } else {
          throw error;
        }
      }
    }
  } catch (error) {
    return {
      status: "error-options",
      ...plan,
      error: String(error.message || error),
    };
  }

  const optionValueIds = buildOptionValueIdMaps(optionsAfter || options);
  // After rename, map both Wooden and Wooden Finish to same id if needed
  if (!optionValueIds.frameByName.get(WOODEN_NEW) && woodenValue) {
    optionValueIds.frameByName.set(WOODEN_NEW, woodenValue.id);
  }

  const useLinked = frameLinked || (frameOpt.optionValues || []).some((v) => v.linkedMetafieldValue);

  try {
    const created = await bulkCreateVariants(
      storeDomain,
      accessToken,
      product.id,
      missing,
      locationId,
      optionValueIds,
      linked,
      useLinked
    );
    return {
      status: "applied",
      ...plan,
      createdCount: created.length,
    };
  } catch (error) {
    return {
      status: "error-variants",
      ...plan,
      error: String(error.message || error),
    };
  }
}

async function main() {
  const { apply, limit, handles, concurrency } = parseArgs(process.argv.slice(2));
  const credentials = getShopifyCredentials();
  if (!credentials.storeDomain || !credentials.accessToken) {
    throw new Error("Shopify is not connected. Add credentials in EditPro Settings.");
  }
  ensureConfigDir();

  console.log(`Store: ${credentials.storeDomain}`);
  console.log(`Mode: ${apply ? "APPLY" : "DRY-RUN"}`);
  console.log(`Concurrency: ${concurrency}`);
  if (handles.length) console.log(`Handles: ${handles.join(", ")}`);
  if (limit) console.log(`Limit: ${limit}`);
  console.log("");

  const resolver = createMetaobjectResolver(
    shopifyGraphql,
    credentials.storeDomain,
    credentials.accessToken
  );

  console.log("Resolving frame-style metaobjects…");
  const woodenGid = await resolver.resolveId(METAOBJECT_TYPES.frameStyle, "wooden");
  const stretchedGid = await resolver.resolveId(
    METAOBJECT_TYPES.frameStyle,
    STRETCHED
  );
  let darkWoodGid = null;
  try {
    darkWoodGid = await ensureDarkWoodMetaobject(
      credentials.storeDomain,
      credentials.accessToken,
      resolver
    );
    console.log(`Dark Wood Finish metaobject: ${darkWoodGid}`);
  } catch (error) {
    console.warn(`Dark Wood metaobject: ${error.message}`);
    console.warn("Will try plain option value name if linked add fails.");
  }

  if (apply && woodenGid) {
    const renamed = await tryRenameWoodenMetaobject(
      credentials.storeDomain,
      credentials.accessToken,
      woodenGid
    );
    console.log(
      renamed.ok
        ? `Wooden metaobject label → ${WOODEN_NEW}`
        : `Wooden metaobject rename skipped: ${renamed.reason}`
    );
  }

  const locationId = await getPrimaryLocationId(
    credentials.storeDomain,
    credentials.accessToken
  );

  const materialPaper = await resolver.resolveId(
    METAOBJECT_TYPES.material,
    "Fine Art Paper"
  );
  const materialCanvas = await resolver.resolveId(
    METAOBJECT_TYPES.material,
    "Canvas"
  );

  const linked = {
    materialByLabel: new Map([
      ["Fine Art Paper", materialPaper],
      ["Canvas", materialCanvas],
    ]),
    frameByLabel: new Map([
      ["Black", await resolver.resolveId(METAOBJECT_TYPES.frameStyle, "Black")],
      ["White", await resolver.resolveId(METAOBJECT_TYPES.frameStyle, "White")],
      [WOODEN_NEW, woodenGid],
      [WOODEN_OLD, woodenGid],
      [DARK_WOOD, darkWoodGid],
      [STRETCHED, stretchedGid],
      ["wooden", woodenGid],
      ["dark-wood", darkWoodGid],
      ["stretched-canvas", stretchedGid],
    ]),
  };

  const frameGids = {
    wooden: woodenGid,
    darkWood: darkWoodGid,
    stretched: stretchedGid,
  };

  const progress = apply ? loadProgress() : { doneProductIds: [] };
  const doneSet = new Set(progress.doneProductIds || []);
  let progressDirty = false;
  const flushProgress = () => {
    if (!apply || !progressDirty) return;
    progress.doneProductIds = Array.from(doneSet);
    saveProgress(progress);
    progressDirty = false;
  };

  const queryParts = ["status:active"];
  if (handles.length === 1) {
    queryParts.push(`handle:${handles[0]}`);
  }
  const query = queryParts.join(" ");

  let cursor = null;
  let hasNext = true;
  let scanned = 0;
  let processed = 0;
  const results = [];
  let plannedMissing = 0;
  let createdTotal = 0;
  let errors = 0;
  let skippedDone = 0;
  const startedAt = Date.now();
  let workStartedAt = null;
  let workProcessed = 0;

  const handleSet = handles.length ? new Set(handles) : null;
  const ctx = {
    storeDomain: credentials.storeDomain,
    accessToken: credentials.accessToken,
    locationId,
    apply,
    frameGids,
    linked,
  };

  let pending = [];

  async function flushPending(force = false) {
    while (
      pending.length >= concurrency ||
      (force && pending.length) ||
      (limit && pending.length && processed + pending.length >= limit)
    ) {
      let batch = pending;
      if (limit) {
        const remain = limit - processed;
        if (remain <= 0) {
          pending = [];
          return;
        }
        batch = pending.slice(0, Math.min(pending.length, remain, Math.max(concurrency, remain)));
        pending = pending.slice(batch.length);
      } else if (!force && pending.length > concurrency) {
        batch = pending.slice(0, concurrency);
        pending = pending.slice(concurrency);
      } else if (!force) {
        batch = pending.slice(0, concurrency);
        pending = pending.slice(batch.length);
      } else {
        pending = [];
      }
      if (!batch.length) return;
      if (!workStartedAt) workStartedAt = Date.now();

      const batchResults = await mapPool(batch, concurrency, async (product) => {
        const result = await processProduct(product, ctx);
        return { product, result };
      });

      for (const { product, result } of batchResults) {
        processed += 1;
        workProcessed += 1;
        results.push(result);
        const label = `[${processed}+${skippedDone}skip] ${product.handle}`;
        if (result.status === "planned") {
          plannedMissing += result.missingCount || 0;
          console.log(`${label}… PLAN missing=${result.missingCount}`);
        } else if (result.status === "applied") {
          createdTotal += result.createdCount || 0;
          doneSet.add(product.id);
          progressDirty = true;
          console.log(`${label}… OK created=${result.createdCount}`);
        } else if (String(result.status).startsWith("error")) {
          errors += 1;
          console.log(`${label}… ERROR ${result.error}`);
        } else {
          console.log(`${label}… ${result.status}`);
        }
      }
      flushProgress();

      const workElapsedMin = workStartedAt
        ? (Date.now() - workStartedAt) / 60000
        : 0;
      const rate = workElapsedMin > 0 ? workProcessed / workElapsedMin : 0;
      const remainingApprox = Math.max(0, 3098 - doneSet.size);
      const etaHr = rate > 0 ? remainingApprox / rate : 0;
      console.log(
        `  … pace ${rate.toFixed(0)}/hr | done ${doneSet.size} | rem~${remainingApprox} | eta ${etaHr.toFixed(1)} hr | errors ${errors}`
      );

      if (limit && processed >= limit) {
        pending = [];
        return;
      }
      if (!force) break;
    }
  }

  while (hasNext) {
    const data = await fetchProductPage(
      credentials.storeDomain,
      credentials.accessToken,
      cursor,
      query
    );
    const page = data.products;
    for (const product of page?.nodes || []) {
      if (handleSet && !handleSet.has(product.handle)) continue;
      scanned += 1;
      if (doneSet.has(product.id)) {
        skippedDone += 1;
        continue;
      }
      if (limit && processed + pending.length >= limit) {
        hasNext = false;
        break;
      }
      pending.push(product);
    }

    await flushPending(false);
    if (limit && processed >= limit) break;
    hasNext = Boolean(page?.pageInfo?.hasNextPage) && hasNext !== false;
    cursor = page?.pageInfo?.endCursor || null;
  }

  await flushPending(true);
  flushProgress();

  const report = {
    generatedAt: new Date().toISOString(),
    mode: apply ? "apply" : "dry-run",
    concurrency,
    scanned,
    skippedDone,
    processed,
    resultsCount: results.length,
    plannedMissingVariants: plannedMissing,
    createdVariants: createdTotal,
    errors,
    elapsedMs: Date.now() - startedAt,
    results,
  };
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), "utf8");
  console.log("");
  console.log(
    JSON.stringify(
      {
        scanned,
        skippedDone,
        processed,
        createdVariants: createdTotal,
        errors,
        doneTotal: doneSet.size,
        elapsedMin: Math.round((Date.now() - startedAt) / 60000),
        report: REPORT_PATH,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
