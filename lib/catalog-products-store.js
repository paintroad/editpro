const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const {
  applyProductDefaults,
  refreshProductVariants,
  DEFAULT_METAFIELDS,
} = require("./catalog-variant-templates");

const CONFIG_DIR = path.join(os.homedir(), ".editpro");
const STORE_PATH = path.join(CONFIG_DIR, "catalog-products.json");
const STORE_VERSION = 2;

function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

function defaultLifestyleSettings() {
  return {
    frameTemplatesPath: null,
    outputPath: null,
    lastRunAt: null,
  };
}

function defaultStore() {
  return {
    version: STORE_VERSION,
    catalogPath: null,
    lastImportAt: null,
    lifestyleSettings: defaultLifestyleSettings(),
    products: {},
  };
}

const PORTRAIT_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp"];

function portraitEntryFromPath(imagePath, index = 0) {
  if (!imagePath) {
    return null;
  }
  return {
    index,
    filename: path.basename(imagePath),
    path: imagePath,
  };
}

function findCanonicalPortraitPath(product) {
  const productId = String(product?.productId || "").trim();
  if (!productId) {
    return null;
  }
  const searchDirs = [];
  if (product.folderPath) {
    searchDirs.push(product.folderPath);
  }
  const storedPath = product.sourceImage?.path || product.images?.find((img) => img.index === 0)?.path;
  if (storedPath) {
    searchDirs.push(path.dirname(storedPath));
  }
  const seen = new Set();
  for (const dir of searchDirs) {
    if (!dir || seen.has(dir)) {
      continue;
    }
    seen.add(dir);
    for (const ext of PORTRAIT_EXTENSIONS) {
      const candidate = path.join(dir, `${productId}${ext}`);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
    for (const ext of PORTRAIT_EXTENSIONS) {
      const candidate = path.join(dir, `${productId}_0${ext}`);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

function resolvePortraitPath(product) {
  const portrait = product?.images?.find((img) => img.index === 0) || product?.sourceImage;
  if (portrait?.path && fs.existsSync(portrait.path)) {
    return portraitEntryFromPath(portrait.path, portrait.index ?? 0);
  }
  const canonical = findCanonicalPortraitPath(product);
  if (canonical) {
    return portraitEntryFromPath(canonical, 0);
  }
  if (portrait?.path) {
    return portraitEntryFromPath(portrait.path, portrait.index ?? 0);
  }
  return null;
}

function getPortraitImage(product) {
  return resolvePortraitPath(product);
}

function syncSourceImage(product) {
  const portrait = product.images?.find((img) => img.index === 0);
  if (portrait) {
    product.sourceImage = {
      index: portrait.index,
      filename: portrait.filename,
      path: portrait.path,
    };
  } else if (!product.sourceImage) {
    product.sourceImage = null;
  }
  if (!Array.isArray(product.lifestyleImages)) {
    product.lifestyleImages = [];
  }
  if (!product.lifestyleStatus) {
    product.lifestyleStatus = product.lifestyleImages.length ? "generated" : "none";
  }
  if (product.lifestyleError === undefined) {
    product.lifestyleError = null;
  }
  if (product.lifestyleGeneratedAt === undefined) {
    product.lifestyleGeneratedAt = null;
  }
  if (product.orientation === undefined) {
    product.orientation = null;
  }
  if (product.orientationDetectedAt === undefined) {
    product.orientationDetectedAt = null;
  }
  if (product.orientationError === undefined) {
    product.orientationError = null;
  }
  return product;
}

function migrateProduct(product) {
  syncSourceImage(product);
  applyProductDefaults(product);
  if (product.shape && product.variants?.length) {
    refreshProductVariants(product);
  }
  if (product.templateSuffix === undefined) {
    product.templateSuffix = "product";
  }
  if (product.productCategoryId === undefined) {
    product.productCategoryId = "gid://shopify/TaxonomyCategory/hg-3-4-2-3";
  }
  if (!Array.isArray(product.salesChannels)) {
    product.salesChannels = [
      "Online Store",
      "Facebook & Instagram",
      "Inbox",
      "Google & YouTube",
    ];
  }
  if (product.countryOfOrigin === undefined) {
    product.countryOfOrigin = "IN";
  }
  return product;
}

function migrateStore(raw) {
  const store = {
    version: STORE_VERSION,
    catalogPath: raw.catalogPath || null,
    lastImportAt: raw.lastImportAt || null,
    lifestyleSettings: {
      ...defaultLifestyleSettings(),
      ...(raw.lifestyleSettings || {}),
    },
    products: raw.products && typeof raw.products === "object" ? raw.products : {},
  };
  for (const productId of Object.keys(store.products)) {
    store.products[productId] = migrateProduct(store.products[productId]);
  }
  return store;
}

function loadCatalogStore() {
  ensureConfigDir();
  if (!fs.existsSync(STORE_PATH)) {
    return defaultStore();
  }
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
    return migrateStore(raw);
  } catch {
    return defaultStore();
  }
}

function saveCatalogStore(store) {
  ensureConfigDir();
  const payload = {
    version: STORE_VERSION,
    catalogPath: store.catalogPath || null,
    lastImportAt: store.lastImportAt || null,
    lifestyleSettings: {
      ...defaultLifestyleSettings(),
      ...(store.lifestyleSettings || {}),
    },
    products: store.products || {},
  };
  fs.writeFileSync(STORE_PATH, JSON.stringify(payload, null, 2), "utf8");
  return payload;
}

function fileFingerprint(imagePath) {
  try {
    const stat = fs.statSync(imagePath);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return null;
  }
}

function portraitFingerprint(product) {
  const portrait = getPortraitImage(product);
  if (!portrait?.path) {
    return null;
  }
  return fileFingerprint(portrait.path);
}

function lifestyleOutputFolderName(product) {
  const portrait = getPortraitImage(product);
  if (!portrait?.path) {
    return String(product.productId || "");
  }
  return path.basename(portrait.path, path.extname(portrait.path));
}

function getLifestyleOutputFolder(product, outputPath) {
  if (!outputPath) {
    return null;
  }
  return path.join(outputPath, lifestyleOutputFolderName(product));
}

function computeLifestyleStats(store = loadCatalogStore()) {
  const outputPath = store.lifestyleSettings?.outputPath || null;
  let totalImages = 0;
  let productsWithImages = 0;
  for (const product of Object.values(store.products || {})) {
    const count = product.lifestyleImages?.length || 0;
    totalImages += count;
    if (count > 0) {
      productsWithImages += 1;
    }
  }
  return {
    outputPath,
    frameTemplatesPath: store.lifestyleSettings?.frameTemplatesPath || null,
    lastRunAt: store.lifestyleSettings?.lastRunAt || null,
    totalImages,
    productsWithImages,
  };
}

function deriveShapeFromOrientation(orientation) {
  const value = String(orientation || "").toLowerCase().trim();
  if (value === "square") {
    return "square";
  }
  if (value === "landscape" || value === "portrait") {
    return "rectangle";
  }
  return null;
}

function hasCatalogGeometry(product) {
  return Boolean(String(product?.orientation || "").trim() && String(product?.shape || "").trim());
}

function needsOrientationDetection(product) {
  const portrait = getPortraitImage(product);
  if (!portrait?.path) {
    return false;
  }
  if (product.orientationError) {
    return true;
  }
  return !String(product.orientation || "").trim() || !String(product.shape || "").trim();
}

function clearCatalogGeometry(product) {
  product.orientation = null;
  product.shape = null;
  product.orientationDetectedAt = null;
  product.orientationError = null;
}

function createImportedProduct(entry) {
  const images = entry.images.map((img) => ({
    index: img.index,
    filename: img.filename,
    path: img.path,
  }));
  const portrait = images.find((img) => img.index === 0) || images[0] || null;
  return applyProductDefaults({
    productId: entry.productId,
    folderPath: entry.folderPath,
    images,
    sourceImage: portrait
      ? { index: portrait.index, filename: portrait.filename, path: portrait.path }
      : null,
    lifestyleImages: [],
    lifestyleStatus: "none",
    lifestyleError: null,
    lifestyleGeneratedAt: null,
    orientation: null,
    orientationDetectedAt: null,
    orientationError: null,
    shape: null,
    status: "imported",
    title: "",
    handle: "",
    descriptionHtml: "",
    descriptionPlain: "",
    description160: "",
    description100: "",
    colors: [],
    tags: [],
    metafields: {
      color: [],
      artworkFrameMaterial: [...DEFAULT_METAFIELDS.artworkFrameMaterial],
      frameStyle: [...DEFAULT_METAFIELDS.frameStyle],
      theme: [],
      searchProductBoosts: "",
    },
    variants: [],
    seoTitle: "",
    seoDescription: "",
    enrichedAt: null,
    error: null,
    importedAt: new Date().toISOString(),
  });
}

function mergeImportResults(store, importResult) {
  store.catalogPath = importResult.catalogPath;
  store.lastImportAt = new Date().toISOString();

  let added = 0;
  let updated = 0;
  let resetForReenrich = 0;

  const orientationProductIds = [];

  for (const entry of importResult.products) {
    const existing = store.products[entry.productId];
    if (!existing) {
      store.products[entry.productId] = createImportedProduct(entry);
      added += 1;
      orientationProductIds.push(entry.productId);
      continue;
    }

    const prevPortraitFp = portraitFingerprint(existing);
    existing.folderPath = entry.folderPath;
    existing.images = entry.images.map((img) => ({
      index: img.index,
      filename: img.filename,
      path: img.path,
    }));
    syncSourceImage(existing);
    applyProductDefaults(existing);
    updated += 1;

    const nextPortraitFp = portraitFingerprint(existing);
    if (prevPortraitFp && nextPortraitFp && prevPortraitFp !== nextPortraitFp) {
      existing.status = "imported";
      existing.error = null;
      resetForReenrich += 1;
      clearCatalogGeometry(existing);
      orientationProductIds.push(entry.productId);
    }
  }

  return {
    added,
    updated,
    resetForReenrich,
    skipped: importResult.skipped?.length || 0,
    orientationProductIds,
  };
}

function listProductSummaries(store = loadCatalogStore()) {
  const outputPath = store.lifestyleSettings?.outputPath || null;
  return Object.values(store.products)
    .map((p) => {
      const lifestyleImageCount = p.lifestyleImages?.length || 0;
      return {
        productId: p.productId,
        title: p.title || "",
        handle: p.handle || "",
        shape: p.shape || "",
        orientation: p.orientation || "",
        status: p.status || "imported",
        imageCount: p.images?.length || 0,
        tagCount: p.tags?.length || 0,
        variantCount: p.variants?.length || 0,
        description100: p.description100 || "",
        colors: p.colors || [],
        error: p.error || null,
        enrichedAt: p.enrichedAt || null,
        portraitPath: getPortraitImage(p)?.path || null,
        lifestyleImageCount,
        lifestyleStatus: p.lifestyleStatus || (lifestyleImageCount ? "generated" : "none"),
        lifestyleOutputFolder: getLifestyleOutputFolder(p, outputPath),
        lifestyleError: p.lifestyleError || null,
        seoStatus: p.seoStatus || null,
        seoFixedAt: p.seoFixedAt || null,
        shopifyStatus: p.shopifyStatus || null,
        shopifyProductId: p.shopifyProductId || null,
        shopifySyncedAt: p.shopifySyncedAt || null,
        shopifyError: p.shopifyError || null,
      };
    })
    .sort((a, b) =>
      String(a.productId).localeCompare(String(b.productId), undefined, { numeric: true })
    );
}

function getProduct(productId, store = loadCatalogStore()) {
  const product = store.products[productId] || null;
  if (!product) {
    return null;
  }
  const outputPath = store.lifestyleSettings?.outputPath || null;
  return {
    ...product,
    lifestyleOutputFolder: getLifestyleOutputFolder(product, outputPath),
  };
}

function updateProduct(productId, fields, store = loadCatalogStore()) {
  if (!store.products[productId]) {
    throw new Error(`Product ${productId} not found.`);
  }
  store.products[productId] = {
    ...store.products[productId],
    ...fields,
  };
  saveCatalogStore(store);
  return store.products[productId];
}

function isTitleTaken(title, excludeProductId, store = loadCatalogStore()) {
  const normalized = String(title || "").trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return Object.values(store.products).some(
    (p) =>
      p.productId !== excludeProductId &&
      String(p.title || "")
        .trim()
        .toLowerCase() === normalized
  );
}

function ensureUniqueTitle(title, productId, store = loadCatalogStore()) {
  let candidate = String(title || "").trim();
  if (!candidate) {
    candidate = `Artwork ${productId}`;
  }
  if (!isTitleTaken(candidate, productId, store)) {
    return candidate;
  }
  const withId = `${candidate} — ${productId}`;
  if (!isTitleTaken(withId, productId, store)) {
    return withId;
  }
  return `${candidate} — ${productId}-${crypto.randomBytes(2).toString("hex")}`;
}

function getProductsNeedingEnrichment(store = loadCatalogStore()) {
  return Object.values(store.products).filter((p) => p.status !== "enriched");
}

module.exports = {
  STORE_PATH,
  STORE_VERSION,
  loadCatalogStore,
  saveCatalogStore,
  mergeImportResults,
  listProductSummaries,
  getProduct,
  updateProduct,
  ensureUniqueTitle,
  isTitleTaken,
  getProductsNeedingEnrichment,
  createImportedProduct,
  getPortraitImage,
  resolvePortraitPath,
  findCanonicalPortraitPath,
  lifestyleOutputFolderName,
  getLifestyleOutputFolder,
  computeLifestyleStats,
  syncSourceImage,
  deriveShapeFromOrientation,
  hasCatalogGeometry,
  needsOrientationDetection,
  clearCatalogGeometry,
};
