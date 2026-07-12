const fs = require("fs");
const path = require("path");
const os = require("os");
const { shopifyGraphql } = require("./shopify-client");
const { getShopifyCredentials } = require("./config-store");
const { loadCatalogStore } = require("./catalog-products-store");

const CONFIG_DIR = path.join(os.homedir(), ".editpro");
const STORE_PATH = path.join(CONFIG_DIR, "shopify-live-products.json");
const STORE_VERSION = 1;

function productIdFromSku(sku) {
  const value = String(sku || "").trim();
  const match = value.match(/^(\d{5})(?:[_-]|$)/);
  return match ? match[1] : null;
}

function normalizeTags(tags) {
  if (!tags) {
    return [];
  }
  if (Array.isArray(tags)) {
    return tags.map((tag) => String(tag).trim()).filter(Boolean);
  }
  if (typeof tags === "string") {
    return tags
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean);
  }
  return [];
}

function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

function defaultStore() {
  return {
    version: STORE_VERSION,
    syncedAt: null,
    storeDomain: null,
    products: {},
  };
}

function loadLiveProductIndex() {
  ensureConfigDir();
  if (!fs.existsSync(STORE_PATH)) {
    return defaultStore();
  }
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
    return {
      version: raw.version || STORE_VERSION,
      syncedAt: raw.syncedAt || null,
      storeDomain: raw.storeDomain || null,
      products: raw.products && typeof raw.products === "object" ? raw.products : {},
    };
  } catch {
    return defaultStore();
  }
}

function saveLiveProductIndex(store) {
  ensureConfigDir();
  const payload = {
    version: STORE_VERSION,
    syncedAt: store.syncedAt || null,
    storeDomain: store.storeDomain || null,
    products: store.products || {},
  };
  fs.writeFileSync(STORE_PATH, JSON.stringify(payload, null, 2), "utf8");
  return payload;
}

function getLiveProductMap() {
  const store = loadLiveProductIndex();
  return new Map(Object.entries(store.products || {}));
}

async function fetchShopifyProductsBySku(storeDomain, accessToken) {
  const products = {};
  let cursor = null;
  let shopifyProductCount = 0;
  const query = `query ProductsWithVariants($cursor: String) {
    products(first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        handle
        tags
        variants(first: 100) {
          nodes { sku }
        }
      }
    }
  }`;

  for (;;) {
    const data = await shopifyGraphql(storeDomain, accessToken, query, { cursor });
    const page = data.products;
    for (const product of page?.nodes || []) {
      shopifyProductCount += 1;
      const tags = normalizeTags(product.tags);
      for (const variant of product.variants?.nodes || []) {
        const productId = productIdFromSku(variant.sku);
        if (!productId || products[productId]) {
          continue;
        }
        products[productId] = {
          productId,
          shopifyProductId: product.id,
          handle: product.handle || "",
          sampleSku: variant.sku || "",
          tags,
          source: "shopify-sku",
        };
      }
    }
    if (!page?.pageInfo?.hasNextPage) {
      break;
    }
    cursor = page.pageInfo.endCursor;
  }

  return { products, shopifyProductCount };
}

function mergeCatalogProducts(products) {
  const store = loadCatalogStore();
  let merged = 0;
  for (const [productId, product] of Object.entries(store.products || {})) {
    if (!product?.shopifyProductId) {
      continue;
    }
    products[String(productId)] = {
      productId: String(productId),
      shopifyProductId: product.shopifyProductId,
      handle: product.shopifyHandle || product.handle || "",
      sampleSku: product.variants?.[0]?.sku || "",
      tags: normalizeTags(product.tags),
      source: "catalog",
    };
    merged += 1;
  }
  return merged;
}

async function syncShopifyProductIndex() {
  const credentials = getShopifyCredentials();
  if (!credentials.storeDomain || !credentials.accessToken) {
    throw new Error("Shopify is not connected.");
  }

  const { products, shopifyProductCount } = await fetchShopifyProductsBySku(
    credentials.storeDomain,
    credentials.accessToken
  );
  const catalogMerged = mergeCatalogProducts(products);
  const payload = saveLiveProductIndex({
    syncedAt: new Date().toISOString(),
    storeDomain: credentials.storeDomain,
    products,
  });

  return {
    storeDomain: payload.storeDomain,
    syncedAt: payload.syncedAt,
    shopifyProductsScanned: shopifyProductCount,
    uniqueProductIds: Object.keys(payload.products).length,
    catalogEntriesMerged: catalogMerged,
    storePath: STORE_PATH,
  };
}

module.exports = {
  STORE_PATH,
  productIdFromSku,
  normalizeTags,
  loadLiveProductIndex,
  saveLiveProductIndex,
  getLiveProductMap,
  syncShopifyProductIndex,
};
