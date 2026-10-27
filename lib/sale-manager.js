/**
 * Sale session: discount random XL (24x36) Canvas Black/White variants across collections.
 * State: ~/.editpro/sale-state.json
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { shopifyGraphql } = require("./shopify-client");
const { getShopifyCredentials } = require("./config-store");
const {
  loadLiveCollectionsIndex,
  ensureLiveCollectionsIndex,
} = require("./shopify-live-collections-index");
const { productIdFromSku } = require("./shopify-live-product-index");

const CONFIG_DIR = path.join(os.homedir(), ".editpro");
const STATE_PATH = path.join(CONFIG_DIR, "sale-state.json");
const TARGET_COUNT = 200;
const DEFAULT_MIN = 5;
const DEFAULT_MAX = 15;

const PRODUCT_FIELDS = `
  id
  title
  handle
  status
  media(first: 1) {
    nodes {
      ... on MediaImage {
        image { url }
      }
    }
  }
  variants(first: 100) {
    nodes {
      id
      sku
      price
      compareAtPrice
      selectedOptions { name value }
    }
  }
`;

const COLLECTION_PRODUCTS_QUERY = `query CollectionProducts($id: ID!, $cursor: String) {
  collection(id: $id) {
    id
    title
    handle
    products(first: 50, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        ${PRODUCT_FIELDS}
      }
    }
  }
}`;

const BULK_VARIANT_UPDATE = `mutation ProductVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
  productVariantsBulkUpdate(productId: $productId, variants: $variants) {
    productVariants { id }
    userErrors { field message }
  }
}`;

function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

function defaultState() {
  return {
    version: 1,
    updatedAt: null,
    discountMin: DEFAULT_MIN,
    discountMax: DEFAULT_MAX,
    items: [],
  };
}

function loadSaleState() {
  ensureConfigDir();
  if (!fs.existsSync(STATE_PATH)) {
    return defaultState();
  }
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    return {
      ...defaultState(),
      ...raw,
      items: Array.isArray(raw.items) ? raw.items : [],
      discountMin:
        raw.discountMin != null ? Number(raw.discountMin) : DEFAULT_MIN,
      discountMax:
        raw.discountMax != null ? Number(raw.discountMax) : DEFAULT_MAX,
    };
  } catch {
    return defaultState();
  }
}

function saveSaleState(state) {
  ensureConfigDir();
  const payload = {
    version: 1,
    updatedAt: new Date().toISOString(),
    discountMin: state.discountMin,
    discountMax: state.discountMax,
    items: state.items || [],
  };
  fs.writeFileSync(STATE_PATH, JSON.stringify(payload, null, 2), "utf8");
  return payload;
}

function clampDiscount(min, max) {
  let lo = Math.round(Number(min));
  let hi = Math.round(Number(max));
  if (Number.isNaN(lo)) lo = DEFAULT_MIN;
  if (Number.isNaN(hi)) hi = DEFAULT_MAX;
  lo = Math.max(1, Math.min(90, lo));
  hi = Math.max(1, Math.min(90, hi));
  if (lo > hi) {
    const t = lo;
    lo = hi;
    hi = t;
  }
  return { discountMin: lo, discountMax: hi };
}

function optionValue(selectedOptions, name) {
  const n = String(name || "").toLowerCase();
  const hit = (selectedOptions || []).find(
    (o) => String(o.name || "").toLowerCase() === n
  );
  return hit ? String(hit.value || "") : "";
}

function isSaleTargetSize(sizeValue) {
  const s = String(sizeValue || "");
  // Target: L - 24"x36" (was XL before matrix v2)
  if (/24\s*["″']?\s*[x×]\s*["″']?\s*36/i.test(s)) return true;
  return false;
}

function isBlackOrWhiteFrame(frame) {
  const f = String(frame || "").trim().toLowerCase();
  return f === "black" || f === "white";
}

function pickSaleVariant(product) {
  const variants = product?.variants?.nodes || [];
  const matches = [];
  for (const v of variants) {
    const size = optionValue(v.selectedOptions, "Size");
    const material =
      optionValue(v.selectedOptions, "Material") || "Canvas";
    const frame = optionValue(v.selectedOptions, "Frame");
    // Material option may be gone (product-level Canvas); still require 24x36 Black/White.
    if (!isSaleTargetSize(size) || !isBlackOrWhiteFrame(frame)) {
      continue;
    }
    matches.push({
      variant: v,
      size,
      material: material || "Canvas",
      frame,
    });
  }
  if (!matches.length) return null;
  return matches[Math.floor(Math.random() * matches.length)];
}

function imageUrl(product) {
  const node = product?.media?.nodes?.[0];
  return node?.image?.url || "";
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function randomDiscountPercent(min, max) {
  if (min === max) return min;
  return min + Math.floor(Math.random() * (max - min + 1));
}

function computeSalePrice(originalPrice, pct) {
  const price = Number(originalPrice);
  if (!Number.isFinite(price) || price <= 0) return null;
  return Math.max(1, Math.round(price * (1 - pct / 100)));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function getCredentials() {
  const credentials = getShopifyCredentials();
  if (!credentials.storeDomain || !credentials.accessToken) {
    throw new Error("Shopify is not connected.");
  }
  return credentials;
}

async function updateVariantPrices(storeDomain, accessToken, productId, variants) {
  const data = await shopifyGraphql(
    storeDomain,
    accessToken,
    BULK_VARIANT_UPDATE,
    { productId, variants }
  );
  const errors = data.productVariantsBulkUpdate?.userErrors || [];
  if (errors.length) {
    throw new Error(errors.map((e) => e.message).join("; "));
  }
  return data.productVariantsBulkUpdate.productVariants;
}

async function revertItems(storeDomain, accessToken, items) {
  const byProduct = new Map();
  for (const item of items) {
    if (!item.shopifyProductId || !item.variantId) continue;
    if (!byProduct.has(item.shopifyProductId)) {
      byProduct.set(item.shopifyProductId, []);
    }
    byProduct.get(item.shopifyProductId).push({
      id: item.variantId,
      price: String(item.originalPrice),
      compareAtPrice:
        item.originalCompareAt != null && item.originalCompareAt !== ""
          ? String(item.originalCompareAt)
          : null,
    });
  }

  const errors = [];
  for (const [productId, variants] of byProduct) {
    try {
      await updateVariantPrices(storeDomain, accessToken, productId, variants);
      await sleep(120);
    } catch (error) {
      errors.push({
        productId,
        message: error.message || "Failed to revert prices.",
      });
    }
  }
  return errors;
}

async function applySaleItems(storeDomain, accessToken, items) {
  const byProduct = new Map();
  for (const item of items) {
    if (!byProduct.has(item.shopifyProductId)) {
      byProduct.set(item.shopifyProductId, []);
    }
    byProduct.get(item.shopifyProductId).push({
      id: item.variantId,
      price: String(item.salePrice),
      compareAtPrice: String(item.listPrice),
    });
  }

  const errors = [];
  for (const [productId, variants] of byProduct) {
    try {
      await updateVariantPrices(storeDomain, accessToken, productId, variants);
      await sleep(120);
    } catch (error) {
      errors.push({
        productId,
        message: error.message || "Failed to apply sale prices.",
      });
    }
  }
  return errors;
}

/**
 * Fetch eligible candidates from multiple collections with diversity.
 */
async function collectCandidates(storeDomain, accessToken, excludeVariantIds) {
  await ensureLiveCollectionsIndex({ refresh: false });
  const index = loadLiveCollectionsIndex();
  const allCollections = index.collections || [];
  const collections = shuffle(
    allCollections.filter((c) => {
      const count =
        typeof c.productCount === "number"
          ? c.productCount
          : c.productsCount?.count || 0;
      return count > 0;
    })
  );

  // #region agent log
  fetch('http://127.0.0.1:7567/ingest/1bff2221-480a-47ef-8c5e-4768a0c5d71b',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'b9cb80'},body:JSON.stringify({sessionId:'b9cb80',runId:'post-fix',hypothesisId:'A',location:'sale-manager.js:collectCandidates',message:'collection filter counts',data:{allCount:allCollections.length,afterFilter:collections.length,sampleFields:allCollections.slice(0,3).map(c=>({title:c.title,productCount:c.productCount,productsCount:c.productsCount,hasProductsCountCount:c.productsCount?.count})),syncedAt:index.syncedAt},timestamp:Date.now()})}).catch(()=>{});
  // #endregion

  /** @type {Map<string, object[]>} collectionTitle -> candidates */
  const byCollection = new Map();
  const seenProducts = new Set();
  const maxCollectionsToScan = Math.min(40, collections.length);
  const maxPagesPerCollection = 2;

  let scannedProducts = 0;
  let matchedVariants = 0;
  let nullCollectionPages = 0;
  let sampleRejectReasons = { noPick: 0, inactive: 0, badPrice: 0 };
  let sampleOptionShapes = [];

  for (let i = 0; i < maxCollectionsToScan; i++) {
    const coll = collections[i];
    let cursor = null;
    let pages = 0;
    while (pages < maxPagesPerCollection) {
      const data = await shopifyGraphql(
        storeDomain,
        accessToken,
        COLLECTION_PRODUCTS_QUERY,
        { id: coll.id, cursor }
      );
      const page = data.collection?.products;
      if (!page) {
        nullCollectionPages += 1;
        // #region agent log
        fetch('http://127.0.0.1:7567/ingest/1bff2221-480a-47ef-8c5e-4768a0c5d71b',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'b9cb80'},body:JSON.stringify({sessionId:'b9cb80',runId:'post-fix',hypothesisId:'B',location:'sale-manager.js:collectCandidates:page',message:'null collection products page',data:{collectionId:coll.id,title:coll.title,hasCollection:Boolean(data.collection),dataKeys:Object.keys(data||{})},timestamp:Date.now()})}).catch(()=>{});
        // #endregion
        break;
      }
      for (const product of page.nodes || []) {
        scannedProducts += 1;
        if (product.status && product.status !== "ACTIVE") {
          sampleRejectReasons.inactive += 1;
          continue;
        }
        if (seenProducts.has(product.id)) continue;
        const picked = pickSaleVariant(product);
        if (!picked) {
          sampleRejectReasons.noPick += 1;
          if (sampleOptionShapes.length < 5) {
            const v0 = product.variants?.nodes?.[0];
            if (v0) {
              sampleOptionShapes.push({
                handle: product.handle,
                options: (v0.selectedOptions || []).map((o) => ({
                  name: o.name,
                  value: o.value,
                })),
              });
            }
          }
          continue;
        }
        if (excludeVariantIds.has(picked.variant.id)) continue;
        const price = Number(picked.variant.price);
        if (!Number.isFinite(price) || price <= 0) {
          sampleRejectReasons.badPrice += 1;
          continue;
        }

        matchedVariants += 1;
        seenProducts.add(product.id);
        const productId =
          productIdFromSku(picked.variant.sku) ||
          String(picked.variant.sku || "").match(/^(\d{5})/)?.[1] ||
          "";

        const candidate = {
          productId,
          shopifyProductId: product.id,
          handle: product.handle || "",
          title: product.title || "",
          collection: coll.title || "",
          collectionHandle: coll.handle || "",
          imageUrl: imageUrl(product),
          variantId: picked.variant.id,
          sku: picked.variant.sku || "",
          size: picked.size,
          material: picked.material,
          frame: picked.frame,
          originalPrice: price,
          originalCompareAt:
            picked.variant.compareAtPrice != null &&
            picked.variant.compareAtPrice !== ""
              ? Number(picked.variant.compareAtPrice)
              : null,
        };
        if (!byCollection.has(coll.title)) {
          byCollection.set(coll.title, []);
        }
        byCollection.get(coll.title).push(candidate);
      }
      pages += 1;
      if (!page.pageInfo?.hasNextPage) break;
      cursor = page.pageInfo.endCursor;
      await sleep(80);
    }
    // Early exit if we already have plenty
    let total = 0;
    for (const list of byCollection.values()) total += list.length;
    if (total >= TARGET_COUNT * 3) break;
  }

  let candidateTotal = 0;
  for (const list of byCollection.values()) candidateTotal += list.length;

  // #region agent log
  fetch('http://127.0.0.1:7567/ingest/1bff2221-480a-47ef-8c5e-4768a0c5d71b',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'b9cb80'},body:JSON.stringify({sessionId:'b9cb80',runId:'post-fix',hypothesisId:'C',location:'sale-manager.js:collectCandidates:end',message:'candidate scan summary',data:{maxCollectionsToScan,scannedProducts,matchedVariants,candidateTotal,collectionsWithHits:byCollection.size,nullCollectionPages,sampleRejectReasons,sampleOptionShapes},timestamp:Date.now()})}).catch(()=>{});
  // #endregion

  return byCollection;
}

/**
 * Round-robin sample across collections for diversity.
 */
function sampleDiverse(byCollection, count) {
  const keys = shuffle([...byCollection.keys()]);
  const queues = keys.map((k) => shuffle(byCollection.get(k)));
  const picked = [];
  const usedProducts = new Set();

  let madeProgress = true;
  while (picked.length < count && madeProgress) {
    madeProgress = false;
    for (const q of queues) {
      if (picked.length >= count) break;
      while (q.length) {
        const c = q.shift();
        if (usedProducts.has(c.shopifyProductId)) continue;
        usedProducts.add(c.shopifyProductId);
        picked.push(c);
        madeProgress = true;
        break;
      }
    }
  }
  return picked;
}

function buildSaleItem(candidate, discountMin, discountMax) {
  const pct = randomDiscountPercent(discountMin, discountMax);
  const salePrice = computeSalePrice(candidate.originalPrice, pct);
  if (salePrice == null || salePrice >= candidate.originalPrice) {
    return null;
  }
  const listPrice = Math.max(
    candidate.originalPrice,
    Number.isFinite(candidate.originalCompareAt)
      ? candidate.originalCompareAt
      : 0
  );
  return {
    ...candidate,
    discountPercent: pct,
    salePrice,
    listPrice,
    appliedAt: new Date().toISOString(),
  };
}

function publicState(state) {
  return {
    discountMin: state.discountMin,
    discountMax: state.discountMax,
    updatedAt: state.updatedAt,
    count: (state.items || []).length,
    items: state.items || [],
  };
}

function getSaleSession() {
  return publicState(loadSaleState());
}

function updateSaleSettings({ discountMin, discountMax } = {}) {
  const state = loadSaleState();
  const clamped = clampDiscount(
    discountMin != null ? discountMin : state.discountMin,
    discountMax != null ? discountMax : state.discountMax
  );
  state.discountMin = clamped.discountMin;
  state.discountMax = clamped.discountMax;
  saveSaleState(state);
  return publicState(state);
}

async function revertSelected({ variantIds, productIds } = {}) {
  const { storeDomain, accessToken } = getCredentials();
  const state = loadSaleState();
  const variantSet = new Set((variantIds || []).map(String));
  const productSet = new Set((productIds || []).map(String));

  const toRevert = state.items.filter((item) => {
    if (variantSet.size && variantSet.has(item.variantId)) return true;
    if (productSet.size && productSet.has(String(item.productId))) return true;
    if (productSet.size && productSet.has(String(item.shopifyProductId))) {
      return true;
    }
    return false;
  });

  if (!toRevert.length) {
    throw new Error("No matching sale items to revert.");
  }

  const errors = await revertItems(storeDomain, accessToken, toRevert);
  const revertIds = new Set(toRevert.map((i) => i.variantId));
  state.items = state.items.filter((i) => !revertIds.has(i.variantId));
  saveSaleState(state);

  return {
    ...publicState(state),
    reverted: toRevert.length,
    errors,
  };
}

async function refreshSale({ discountMin, discountMax } = {}) {
  const { storeDomain, accessToken } = getCredentials();
  const state = loadSaleState();

  if (discountMin != null || discountMax != null) {
    const clamped = clampDiscount(
      discountMin != null ? discountMin : state.discountMin,
      discountMax != null ? discountMax : state.discountMax
    );
    state.discountMin = clamped.discountMin;
    state.discountMax = clamped.discountMax;
  }

  // 1) Revert current sale items
  const revertErrors = await revertItems(
    storeDomain,
    accessToken,
    state.items || []
  );
  state.items = [];
  saveSaleState(state);

  // 2) Collect candidates (no active sale variants to exclude after clear)
  const byCollection = await collectCandidates(
    storeDomain,
    accessToken,
    new Set()
  );
  const sampled = sampleDiverse(byCollection, TARGET_COUNT);

  // #region agent log
  fetch('http://127.0.0.1:7567/ingest/1bff2221-480a-47ef-8c5e-4768a0c5d71b',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'b9cb80'},body:JSON.stringify({sessionId:'b9cb80',runId:'post-fix',hypothesisId:'D',location:'sale-manager.js:refreshSale',message:'after sampleDiverse',data:{sampled:sampled.length,collectionBuckets:byCollection.size,discountMin:state.discountMin,discountMax:state.discountMax},timestamp:Date.now()})}).catch(()=>{});
  // #endregion

  // 3) Build sale rows
  const nextItems = [];
  let buildNull = 0;
  for (const candidate of sampled) {
    const item = buildSaleItem(
      candidate,
      state.discountMin,
      state.discountMax
    );
    if (item) nextItems.push(item);
    else buildNull += 1;
  }

  // #region agent log
  fetch('http://127.0.0.1:7567/ingest/1bff2221-480a-47ef-8c5e-4768a0c5d71b',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'b9cb80'},body:JSON.stringify({sessionId:'b9cb80',runId:'post-fix',hypothesisId:'D',location:'sale-manager.js:refreshSale:build',message:'buildSaleItem results',data:{nextItems:nextItems.length,buildNull},timestamp:Date.now()})}).catch(()=>{});
  // #endregion

  // 4) Apply to Shopify
  const applyErrors = await applySaleItems(
    storeDomain,
    accessToken,
    nextItems
  );
  const failedProducts = new Set(
    applyErrors.map((e) => e.productId).filter(Boolean)
  );
  state.items = nextItems.filter(
    (i) => !failedProducts.has(i.shopifyProductId)
  );
  saveSaleState(state);

  return {
    ...publicState(state),
    sampled: sampled.length,
    collectionsScanned: byCollection.size,
    revertErrors,
    applyErrors,
  };
}

async function fetchVariantPricing(storeDomain, accessToken, variantId) {
  const data = await shopifyGraphql(
    storeDomain,
    accessToken,
    `query VariantPrice($id: ID!) {
      productVariant(id: $id) {
        id
        price
        compareAtPrice
      }
    }`,
    { id: variantId }
  );
  return data.productVariant;
}

/**
 * Recompute sale prices for existing sale-state items (no reshuffle).
 * Pass discountMin/discountMax to set the session range for this reapply.
 */
async function reapplySaleDiscounts({ discountMin, discountMax } = {}) {
  const { storeDomain, accessToken } = getCredentials();
  const state = loadSaleState();
  const items = state.items || [];
  if (!items.length) {
    throw new Error("No sale items to reapply.");
  }

  if (discountMin != null || discountMax != null) {
    const clamped = clampDiscount(
      discountMin != null ? discountMin : state.discountMin,
      discountMax != null ? discountMax : state.discountMax
    );
    state.discountMin = clamped.discountMin;
    state.discountMax = clamped.discountMax;
  }

  const nextItems = [];
  const resolveErrors = [];

  for (const item of items) {
    let originalPrice = Number(item.originalPrice);
    let originalCompareAt =
      item.originalCompareAt != null && item.originalCompareAt !== ""
        ? Number(item.originalCompareAt)
        : null;

    try {
      const live = await fetchVariantPricing(
        storeDomain,
        accessToken,
        item.variantId
      );
      if (live) {
        const livePrice = Number(live.price);
        const liveCompare =
          live.compareAtPrice != null && live.compareAtPrice !== ""
            ? Number(live.compareAtPrice)
            : null;
        if (
          Number.isFinite(liveCompare) &&
          Number.isFinite(livePrice) &&
          liveCompare > livePrice
        ) {
          // Still showing as on-sale: keep stored regular sell as baseline when available
          originalPrice = Number.isFinite(originalPrice)
            ? originalPrice
            : liveCompare;
          originalCompareAt = Number.isFinite(originalCompareAt)
            ? originalCompareAt
            : liveCompare;
        } else if (Number.isFinite(livePrice) && livePrice > 0) {
          // Full price restored (e.g. after catalog sync)
          originalPrice = livePrice;
          if (Number.isFinite(liveCompare)) {
            originalCompareAt = liveCompare;
          }
        }
      }
      await sleep(80);
    } catch (error) {
      resolveErrors.push({
        variantId: item.variantId,
        handle: item.handle,
        message: error.message || "Failed to refresh live price.",
      });
    }

    const rebuilt = buildSaleItem(
      {
        ...item,
        originalPrice,
        originalCompareAt,
      },
      state.discountMin,
      state.discountMax
    );
    if (rebuilt) {
      nextItems.push(rebuilt);
    }
  }

  const applyErrors = await applySaleItems(
    storeDomain,
    accessToken,
    nextItems
  );
  const failedProducts = new Set(
    applyErrors.map((e) => e.productId).filter(Boolean)
  );
  state.items = nextItems.filter(
    (i) => !failedProducts.has(i.shopifyProductId)
  );
  saveSaleState(state);

  return {
    ...publicState(state),
    reapplied: state.items.length,
    resolveErrors,
    applyErrors,
  };
}

module.exports = {
  TARGET_COUNT,
  loadSaleState,
  saveSaleState,
  getSaleSession,
  updateSaleSettings,
  refreshSale,
  reapplySaleDiscounts,
  applySaleItems,
  revertSelected,
  isXl24x36: isSaleTargetSize,
  isSaleTargetSize,
  pickSaleVariant,
};
