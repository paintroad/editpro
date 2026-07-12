const fs = require("fs");
const path = require("path");
const os = require("os");
const { shopifyGraphql } = require("./shopify-client");
const { getShopifyCredentials } = require("./config-store");
const { slugify } = require("./catalog-text-utils");

const CONFIG_DIR = path.join(os.homedir(), ".editpro");
const STORE_PATH = path.join(CONFIG_DIR, "shopify-live-collections.json");
const STORE_VERSION = 1;

const COLLECTIONS_QUERY = `query CollectionsWithRules($cursor: String) {
  collections(first: 100, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      title
      handle
      descriptionHtml
      seo { title description }
      ruleSet {
        appliedDisjunctively
        rules { column relation condition }
      }
      productsCount { count }
      image {
        id
        alt: altText
        url
      }
    }
  }
}`;

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
    collections: [],
  };
}

function loadLiveCollectionsIndex() {
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
      collections: Array.isArray(raw.collections) ? raw.collections : [],
    };
  } catch {
    return defaultStore();
  }
}

function saveLiveCollectionsIndex(store) {
  ensureConfigDir();
  const payload = {
    version: STORE_VERSION,
    syncedAt: store.syncedAt || null,
    storeDomain: store.storeDomain || null,
    collections: store.collections || [],
  };
  fs.writeFileSync(STORE_PATH, JSON.stringify(payload, null, 2), "utf8");
  return payload;
}

function normalizeName(value) {
  return String(value || "").trim().toLowerCase();
}

function hasTagEqualsRule(collection, collectionName) {
  const rules = collection?.ruleSet?.rules || [];
  return rules.some((rule) => {
    return (
      String(rule.column || "").toUpperCase() === "TAG" &&
      String(rule.relation || "").toUpperCase() === "EQUALS" &&
      normalizeName(rule.condition) === normalizeName(collectionName)
    );
  });
}

function isLiveCollectionName(collectionName, collections = []) {
  return Boolean(getLiveCollectionByName(collectionName, collections));
}

function findCollectionByHandle(handle, collections = []) {
  const target = normalizeName(handle);
  if (!target) {
    return null;
  }
  for (const collection of collections) {
    if (normalizeName(collection.handle) === target) {
      return collection;
    }
  }
  return null;
}

function getLiveCollectionByName(collectionName, collections = []) {
  const target = normalizeName(collectionName);
  if (!target) {
    return null;
  }
  for (const collection of collections) {
    if (hasTagEqualsRule(collection, collectionName)) {
      return collection;
    }
  }
  for (const collection of collections) {
    if (normalizeName(collection.title) === target) {
      return collection;
    }
  }
  const slug = slugify(collectionName);
  if (slug) {
    return findCollectionByHandle(slug, collections);
  }
  return null;
}

function resolveLiveCollectionForFolder(collectionName, collections = []) {
  return getLiveCollectionByName(collectionName, collections);
}

function normalizeCollectionNode(node) {
  if (!node?.id) {
    return null;
  }
  return {
    id: node.id,
    title: node.title || "",
    handle: node.handle || "",
    descriptionHtml: node.descriptionHtml || "",
    seo: node.seo || { title: "", description: "" },
    ruleSet: node.ruleSet || null,
    productCount: node.productsCount?.count ?? 0,
    image: node.image || null,
  };
}

async function fetchCollectionByHandle(storeDomain, accessToken, handle) {
  const normalizedHandle = String(handle || "").trim();
  if (!normalizedHandle) {
    return null;
  }

  const byHandleQuery = `query CollectionByHandle($handle: String!) {
    collectionByHandle(handle: $handle) {
      id
      title
      handle
      descriptionHtml
      seo { title description }
      ruleSet {
        appliedDisjunctively
        rules { column relation condition }
      }
      productsCount { count }
      image {
        id
        alt: altText
        url
      }
    }
  }`;
  const byHandleData = await shopifyGraphql(storeDomain, accessToken, byHandleQuery, {
    handle: normalizedHandle,
  });
  const directMatch = normalizeCollectionNode(byHandleData.collectionByHandle);
  if (directMatch) {
    return directMatch;
  }

  const searchQuery = `query CollectionsByHandleSearch($query: String!) {
    collections(first: 1, query: $query) {
      nodes {
        id
        title
        handle
        descriptionHtml
        seo { title description }
        ruleSet {
          appliedDisjunctively
          rules { column relation condition }
        }
        productsCount { count }
        image {
          id
          alt: altText
          url
        }
      }
    }
  }`;
  const searchData = await shopifyGraphql(storeDomain, accessToken, searchQuery, {
    query: `handle:${normalizedHandle}`,
  });
  return normalizeCollectionNode(searchData.collections?.nodes?.[0]);
}

function rememberLiveCollection(collection, liveCollections = []) {
  if (!collection?.id) {
    return liveCollections;
  }
  const existingIndex = liveCollections.findIndex((entry) => entry.id === collection.id);
  if (existingIndex >= 0) {
    liveCollections[existingIndex] = { ...liveCollections[existingIndex], ...collection };
    return liveCollections;
  }
  liveCollections.push(collection);
  return liveCollections;
}

async function findOrFetchCollectionByHandle(handle, liveCollections = [], storeDomain, accessToken) {
  const localMatch = findCollectionByHandle(handle, liveCollections);
  if (localMatch) {
    return localMatch;
  }
  if (!storeDomain || !accessToken) {
    return null;
  }
  const remoteMatch = await fetchCollectionByHandle(storeDomain, accessToken, handle);
  if (remoteMatch) {
    rememberLiveCollection(remoteMatch, liveCollections);
  }
  return remoteMatch;
}

function buildLiveStatusMap(collectionNames, collections = []) {
  const live = {};
  for (const name of collectionNames || []) {
    const match = getLiveCollectionByName(name, collections);
    if (match) {
      live[String(name)] = {
        id: match.id,
        handle: match.handle || "",
        title: match.title || "",
      };
    }
  }
  return live;
}

async function fetchAllCollectionsWithRules(storeDomain, accessToken) {
  const collections = [];
  let cursor = null;

  for (;;) {
    const data = await shopifyGraphql(storeDomain, accessToken, COLLECTIONS_QUERY, { cursor });
    const page = data.collections;
    for (const node of page?.nodes || []) {
      collections.push({
        id: node.id,
        title: node.title || "",
        handle: node.handle || "",
        descriptionHtml: node.descriptionHtml || "",
        seo: node.seo || { title: "", description: "" },
        ruleSet: node.ruleSet || null,
        productCount: node.productsCount?.count ?? 0,
        image: node.image || null,
      });
    }
    if (!page?.pageInfo?.hasNextPage) {
      break;
    }
    cursor = page.pageInfo.endCursor;
  }

  return collections;
}

async function syncShopifyCollectionsIndex() {
  const credentials = getShopifyCredentials();
  if (!credentials.storeDomain || !credentials.accessToken) {
    throw new Error("Shopify is not connected.");
  }

  const collections = await fetchAllCollectionsWithRules(
    credentials.storeDomain,
    credentials.accessToken
  );
  const payload = saveLiveCollectionsIndex({
    syncedAt: new Date().toISOString(),
    storeDomain: credentials.storeDomain,
    collections,
  });

  return {
    storeDomain: payload.storeDomain,
    syncedAt: payload.syncedAt,
    collectionCount: payload.collections.length,
    storePath: STORE_PATH,
  };
}

async function ensureLiveCollectionsIndex({ refresh = false } = {}) {
  const existing = loadLiveCollectionsIndex();
  if (!refresh && existing.syncedAt && existing.collections.length) {
    return existing;
  }
  await syncShopifyCollectionsIndex();
  return loadLiveCollectionsIndex();
}

function getExampleCollectionDescriptions(collections = [], limit = 5) {
  return collections
    .filter((collection) => String(collection.descriptionHtml || "").trim())
    .slice(0, limit)
    .map((collection) => ({
      title: collection.title || "",
      descriptionHtml: collection.descriptionHtml || "",
    }));
}

module.exports = {
  STORE_PATH,
  loadLiveCollectionsIndex,
  saveLiveCollectionsIndex,
  syncShopifyCollectionsIndex,
  ensureLiveCollectionsIndex,
  isLiveCollectionName,
  getLiveCollectionByName,
  resolveLiveCollectionForFolder,
  findCollectionByHandle,
  fetchCollectionByHandle,
  findOrFetchCollectionByHandle,
  rememberLiveCollection,
  buildLiveStatusMap,
  getExampleCollectionDescriptions,
  hasTagEqualsRule,
};
