const path = require("path");
const { shopifyGraphql } = require("./shopify-client");
const { getShopifyCredentials } = require("./config-store");
const { getProduct, loadCatalogStore } = require("./catalog-products-store");
const {
  getCachedScan,
  mergeProductIndex,
} = require("./collections-store");
const { scanCollectionRoot } = require("./collections-scanner");
const {
  getLiveProductMap,
  normalizeTags,
  productIdFromSku,
} = require("./shopify-live-product-index");

function productIdFromFilename(filename) {
  const base = path.parse(String(filename || "")).name;
  return /^\d{5}$/.test(base) ? base : null;
}

function collectProductsForCollections(scan, collectionNames) {
  const selected = new Set(collectionNames.map((name) => String(name)));
  const productMap = new Map();

  for (const image of scan.images || []) {
    if (image.relevance !== "relevant") {
      continue;
    }
    const productId = productIdFromFilename(image.filename || image.id);
    if (!productId) {
      continue;
    }
    const matchingCollections = (image.tags || []).filter((tag) => selected.has(tag));
    if (!matchingCollections.length) {
      continue;
    }
    if (!productMap.has(productId)) {
      productMap.set(productId, {
        productId,
        collections: new Set(),
      });
    }
    for (const collectionName of matchingCollections) {
      productMap.get(productId).collections.add(collectionName);
    }
  }

  return productMap;
}

function resolveFromCatalog(productId, catalogStore) {
  const product = getProduct(productId, catalogStore);
  if (!product?.shopifyProductId) {
    return null;
  }
  return {
    productId: String(productId),
    shopifyProductId: product.shopifyProductId,
    handle: product.shopifyHandle || product.handle || "",
    tags: normalizeTags(product.tags),
    source: "catalog",
  };
}

function resolveFromProductIndex(productId, productIndex) {
  const entry = productIndex?.[String(productId)];
  if (!entry?.shopifyProductId) {
    return null;
  }
  return {
    productId: String(productId),
    shopifyProductId: entry.shopifyProductId,
    handle: entry.handle || "",
    tags: [],
    source: entry.source || "collections-cache",
  };
}

function resolveFromLiveIndex(productId, liveIndex) {
  const entry = liveIndex.get(String(productId));
  if (!entry?.shopifyProductId) {
    return null;
  }
  return {
    productId: String(productId),
    shopifyProductId: entry.shopifyProductId,
    handle: entry.handle || "",
    tags: normalizeTags(entry.tags),
    source: entry.source || "shopify-live-index",
  };
}

async function fetchProductTags(storeDomain, accessToken, shopifyProductId) {
  const query = `query ProductTags($id: ID!) {
    product(id: $id) {
      id
      handle
      tags
    }
  }`;
  const data = await shopifyGraphql(storeDomain, accessToken, query, { id: shopifyProductId });
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
  const mutation = `mutation ProductUpdate($input: ProductInput!) {
    productUpdate(input: $input) {
      product { id handle tags }
      userErrors { field message }
    }
  }`;
  const data = await shopifyGraphql(storeDomain, accessToken, mutation, {
    input: {
      id: shopifyProductId,
      tags,
    },
  });
  const errors = data.productUpdate?.userErrors || [];
  if (errors.length) {
    throw new Error(errors.map((error) => error.message).join("; "));
  }
  return data.productUpdate.product;
}

async function resolveProductRecord(
  productId,
  productIndex,
  liveIndex,
  catalogStore,
  storeDomain,
  accessToken,
  fetchLiveTags
) {
  const candidates = [
    resolveFromCatalog(productId, catalogStore),
    resolveFromProductIndex(productId, productIndex),
    resolveFromLiveIndex(productId, liveIndex),
  ].filter(Boolean);

  const resolved = candidates[0];
  if (!resolved) {
    return null;
  }

  if (!fetchLiveTags) {
    return resolved;
  }

  try {
    const live = await fetchProductTags(storeDomain, accessToken, resolved.shopifyProductId);
    return {
      ...resolved,
      handle: live.handle || resolved.handle,
      tags: live.tags,
    };
  } catch {
    return resolved;
  }
}

function buildChangeRow(productId, entry, resolved) {
  const collections = [...entry.collections].sort();
  const tagsToAdd = collections;
  const currentTags = resolved ? normalizeTags(resolved.tags) : [];
  const mergedTags = resolved
    ? [...new Set([...currentTags, ...tagsToAdd])]
    : [];

  let status = "missing";
  if (resolved?.shopifyProductId) {
    status = tagsToAdd.every((tag) => currentTags.includes(tag)) ? "skip" : "ready";
  }

  return {
    productId,
    handle: resolved?.handle || "",
    shopifyProductId: resolved?.shopifyProductId || "",
    resolveSource: resolved?.source || "missing",
    collections,
    tagsToAdd,
    currentTags,
    mergedTags,
    status,
  };
}

async function buildCollectionTagPlan({ rootPath, collections, fetchLiveTags = true }) {
  const credentials = getShopifyCredentials();
  if (!credentials.storeDomain || !credentials.accessToken) {
    throw new Error("Shopify is not connected.");
  }

  const collectionNames = Array.isArray(collections)
    ? collections.map((name) => String(name).trim()).filter(Boolean)
    : [];
  if (!collectionNames.length) {
    throw new Error("Select at least one collection.");
  }
  if (!rootPath || typeof rootPath !== "string") {
    throw new Error("Folder path is required.");
  }

  let scan = getCachedScan(rootPath);
  if (!scan) {
    scan = scanCollectionRoot(rootPath);
  }

  const productMap = collectProductsForCollections(scan, collectionNames);
  const productIndex = scan.productIndex || {};
  const liveIndex = getLiveProductMap();
  const catalogStore = loadCatalogStore();
  const changes = [];

  for (const [productId, entry] of productMap.entries()) {
    const resolved = await resolveProductRecord(
      productId,
      productIndex,
      liveIndex,
      catalogStore,
      credentials.storeDomain,
      credentials.accessToken,
      fetchLiveTags
    );
    changes.push(buildChangeRow(productId, entry, resolved));
  }

  const ready = changes.filter((change) => change.status === "ready").length;
  const skip = changes.filter((change) => change.status === "skip").length;
  const missing = changes.filter((change) => change.status === "missing").length;

  return {
    collections: collectionNames,
    summary: {
      productsTargeted: changes.length,
      ready,
      skip,
      missing,
    },
    changes,
  };
}

async function previewCollectionTags({ rootPath, collections }) {
  return buildCollectionTagPlan({ rootPath, collections, fetchLiveTags: false });
}

async function addCollectionTagsToShopify({ rootPath, collections }) {
  const plan = await buildCollectionTagPlan({ rootPath, collections, fetchLiveTags: false });
  const credentials = getShopifyCredentials();
  const errors = [];
  const indexUpdates = {};
  let updated = 0;
  let skipped = 0;

  for (const change of plan.changes) {
    if (change.status === "missing") {
      skipped += 1;
      errors.push({
        productId: change.productId,
        message: "No Shopify product found for this ID.",
      });
      continue;
    }

    if (change.status === "skip") {
      skipped += 1;
      if (change.shopifyProductId) {
        indexUpdates[change.productId] = {
          handle: change.handle,
          shopifyProductId: change.shopifyProductId,
          source: change.resolveSource,
          updatedAt: new Date().toISOString(),
        };
      }
      continue;
    }

    try {
      const live = await fetchProductTags(
        credentials.storeDomain,
        credentials.accessToken,
        change.shopifyProductId
      );
      const currentTags = normalizeTags(live.tags);
      const mergedTags = [...new Set([...currentTags, ...change.tagsToAdd])];

      const product = await updateProductTags(
        credentials.storeDomain,
        credentials.accessToken,
        change.shopifyProductId,
        mergedTags
      );
      updated += 1;
      indexUpdates[change.productId] = {
        handle: product.handle || change.handle,
        shopifyProductId: product.id,
        source: change.resolveSource,
        updatedAt: new Date().toISOString(),
      };
    } catch (error) {
      skipped += 1;
      errors.push({
        productId: change.productId,
        message: error.message || "Failed to update product tags.",
      });
    }
  }

  if (Object.keys(indexUpdates).length) {
    mergeProductIndex(rootPath, indexUpdates);
  }

  return {
    collections: plan.collections,
    productsTargeted: plan.summary.productsTargeted,
    updated,
    skipped,
    errors,
    summary: plan.summary,
  };
}

module.exports = {
  productIdFromFilename,
  productIdFromSku,
  collectProductsForCollections,
  buildCollectionTagPlan,
  previewCollectionTags,
  addCollectionTagsToShopify,
};
