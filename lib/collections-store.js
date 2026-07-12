const fs = require("fs");
const path = require("path");
const os = require("os");
const { normalizeRootPath } = require("./collections-scanner");

const CONFIG_DIR = path.join(os.homedir(), ".editpro");
const STORE_PATH = path.join(CONFIG_DIR, "collections-scans.json");
const STORE_VERSION = 1;

function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

function defaultStore() {
  return {
    version: STORE_VERSION,
    scans: {},
  };
}

function loadCollectionsStore() {
  ensureConfigDir();
  if (!fs.existsSync(STORE_PATH)) {
    return defaultStore();
  }
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
    return {
      version: raw.version || STORE_VERSION,
      scans: raw.scans && typeof raw.scans === "object" ? raw.scans : {},
    };
  } catch {
    return defaultStore();
  }
}

function saveCollectionsStore(store) {
  ensureConfigDir();
  const payload = {
    version: STORE_VERSION,
    scans: store.scans || {},
  };
  fs.writeFileSync(STORE_PATH, JSON.stringify(payload, null, 2), "utf8");
  return payload;
}

function getResolvedKey(rootPath) {
  return normalizeRootPath(rootPath);
}

function getCachedScan(rootPath) {
  const resolved = getResolvedKey(rootPath);
  const store = loadCollectionsStore();
  return store.scans[resolved] || null;
}

function saveScanResult(result) {
  const resolved = normalizeRootPath(result.rootPath);
  const store = loadCollectionsStore();
  const existing = store.scans[resolved];
  store.scans[resolved] = {
    rootPath: result.rootPath,
    images: Array.isArray(result.images) ? result.images : [],
    tagOptions: Array.isArray(result.tagOptions) ? result.tagOptions : [],
    total: result.total ?? (result.images?.length || 0),
    scannedAt: result.scannedAt || new Date().toISOString(),
    productIndex: existing?.productIndex && typeof existing.productIndex === "object" ? existing.productIndex : {},
  };
  saveCollectionsStore(store);
  return store.scans[resolved];
}

function getProductIndex(rootPath) {
  const scan = getCachedScan(rootPath);
  if (!scan?.productIndex || typeof scan.productIndex !== "object") {
    return {};
  }
  return scan.productIndex;
}

function upsertProductIndexEntry(rootPath, productId, entry) {
  const resolved = getResolvedKey(rootPath);
  const store = loadCollectionsStore();
  const scan = store.scans[resolved];
  if (!scan) {
    return null;
  }
  if (!scan.productIndex || typeof scan.productIndex !== "object") {
    scan.productIndex = {};
  }
  scan.productIndex[String(productId)] = {
    productId: String(productId),
    handle: entry.handle || "",
    shopifyProductId: entry.shopifyProductId || "",
    source: entry.source || "unknown",
    updatedAt: entry.updatedAt || new Date().toISOString(),
  };
  saveCollectionsStore(store);
  return scan.productIndex[String(productId)];
}

function mergeProductIndex(rootPath, entries) {
  const resolved = getResolvedKey(rootPath);
  const store = loadCollectionsStore();
  const scan = store.scans[resolved];
  if (!scan) {
    return null;
  }
  if (!scan.productIndex || typeof scan.productIndex !== "object") {
    scan.productIndex = {};
  }
  for (const [productId, entry] of Object.entries(entries || {})) {
    scan.productIndex[String(productId)] = {
      productId: String(productId),
      handle: entry.handle || "",
      shopifyProductId: entry.shopifyProductId || "",
      source: entry.source || "unknown",
      updatedAt: entry.updatedAt || new Date().toISOString(),
    };
  }
  saveCollectionsStore(store);
  return scan.productIndex;
}

module.exports = {
  loadCollectionsStore,
  saveCollectionsStore,
  getCachedScan,
  saveScanResult,
  getProductIndex,
  upsertProductIndexEntry,
  mergeProductIndex,
};
