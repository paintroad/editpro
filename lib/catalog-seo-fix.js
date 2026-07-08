const fs = require("fs");
const path = require("path");
const { loadConfig } = require("./config-store");
const { truncate } = require("./catalog-text-utils");
const { loadCatalogStore, getProduct, saveCatalogStore } = require("./catalog-products-store");
const { isNoneRoom } = require("./room-utils");

const DEFAULT_ROOM_FALLBACKS = require("./default-room-fallbacks").DEFAULT_ROOM_FALLBACKS;

function stripHtml(html) {
  return String(html || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function applyTemplate(template, context) {
  if (!template) {
    return "";
  }
  return String(template)
    .replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_match, key) => {
      const value = context[key];
      return value == null ? "" : String(value);
    })
    .replace(/\s+/g, " ")
    .trim();
}

function tagTokens(tags) {
  const arr = Array.isArray(tags) ? tags : [];
  return {
    tags: arr.join(", "),
    tag1: arr[0] || "",
    tag2: arr[1] || "",
    tag3: arr[2] || "",
  };
}

function hashSeedKey(seedKey) {
  let hash = 0;
  const str = String(seedKey);
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function basenameFromPath(filePath) {
  if (!filePath) {
    return "";
  }
  return path.basename(String(filePath));
}

function referenceProductImage(product) {
  if (!product?.sourceImage?.path) {
    return null;
  }
  return {
    ...product.sourceImage,
    catalogImageKind: "reference",
    lifestyleListIndex: null,
    isReference: true,
  };
}

/** Catalog / Shopify / Fix SEO images — lifestyle only (reference portrait excluded). */
function catalogProductImages(product) {
  const lifestyle = [...(product.lifestyleImages || [])].sort(
    (a, b) => (a.index ?? 0) - (b.index ?? 0)
  );
  return lifestyle.map((img, i) => ({
    ...img,
    catalogImageKind: "lifestyle",
    lifestyleListIndex: i,
    catalogGalleryIndex: i + 1,
  }));
}

function collectCatalogFilenames(products) {
  const used = new Set();
  for (const product of products) {
    const reference = referenceProductImage(product);
    if (reference) {
      const refName = reference.filename || basenameFromPath(reference.path);
      if (refName) {
        used.add(refName.toLowerCase());
      }
    }
    for (const img of catalogProductImages(product)) {
      const name = img.filename || basenameFromPath(img.path);
      if (name) {
        used.add(name.toLowerCase());
      }
    }
  }
  return used;
}

function templateUsesRoom(template) {
  return /\{\{\s*room\s*\}\}/.test(String(template || ""));
}

function pickRoomFallback(seedKey, roomFallbacks, usedRooms, roomFallbackCache) {
  if (roomFallbackCache[seedKey]) {
    return roomFallbackCache[seedKey];
  }
  const start = roomFallbacks.length ? hashSeedKey(seedKey) % roomFallbacks.length : 0;
  for (let i = 0; i < roomFallbacks.length; i++) {
    const candidate = roomFallbacks[(start + i) % roomFallbacks.length] || "";
    const key = candidate.toLowerCase();
    if (candidate && !usedRooms.has(key)) {
      roomFallbackCache[seedKey] = candidate;
      usedRooms.add(key);
      return candidate;
    }
  }
  const fallback = roomFallbacks[start] || "";
  roomFallbackCache[seedKey] = fallback;
  if (fallback) {
    usedRooms.add(fallback.toLowerCase());
  }
  return fallback;
}

function catalogResolveRoom(
  product,
  imageEntry,
  imageIndex,
  roomFallbacks,
  roomFallbackCache,
  usedRooms
) {
  const seedKey = `${product.productId}:${imageIndex}`;
  if (roomFallbackCache[seedKey]) {
    return roomFallbackCache[seedKey];
  }
  const roomLabel = imageEntry?.roomLabel || imageEntry?.room || "";
  if (roomLabel && !isNoneRoom(roomLabel)) {
    const normalized = String(roomLabel).trim();
    const key = normalized.toLowerCase();
    if (!usedRooms.has(key)) {
      usedRooms.add(key);
      roomFallbackCache[seedKey] = normalized;
      return normalized;
    }
  }
  return pickRoomFallback(seedKey, roomFallbacks, usedRooms, roomFallbackCache);
}

function catalogProductContext(
  product,
  imageEntry,
  imageIndex,
  shopName,
  roomFallbacks,
  roomFallbackCache,
  usedRooms
) {
  const description = stripHtml(product.descriptionHtml || product.descriptionPlain || "");
  const title = product.title || "";
  const productType = product.productType || "";
  const currentFilename = imageEntry?.filename || basenameFromPath(imageEntry?.path);
  const room = catalogResolveRoom(
    product,
    imageEntry,
    imageIndex,
    roomFallbacks,
    roomFallbackCache,
    usedRooms
  );
  const imageIndexTokens =
    imageIndex > 0
      ? { "image.index": String(imageIndex), incrementing_number: String(imageIndex) }
      : { "image.index": "", incrementing_number: "" };
  return {
    title,
    handle: product.handle || "",
    productType,
    shopName: shopName || "",
    ...tagTokens(product.tags),
    description,
    description100: product.description100 || truncate(description, 100),
    description160: product.description160 || truncate(description, 160),
    product_name: title,
    product_type: productType,
    product_vendor: product.vendor || "",
    shop_name: shopName || "",
    room,
    ...imageIndexTokens,
    "image.alt": imageEntry?.alt || "",
    "image.filename": currentFilename || "",
  };
}

/**
 * Spaces → hyphens; strip symbols unsafe for filenames; lowercase.
 * Matches SEO engine (rules-engine.js). Keeps letters, digits, hyphen, underscore, period.
 */
function sanitizeField(value) {
  if (!value) {
    return "";
  }
  return String(value)
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9._-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function ensureExtension(filename, currentFilename) {
  if (!filename) {
    return filename;
  }
  const currentExt =
    currentFilename && currentFilename.includes(".")
      ? currentFilename.slice(currentFilename.lastIndexOf("."))
      : "";
  if (!currentExt) {
    return filename;
  }
  if (filename.toLowerCase().endsWith(currentExt.toLowerCase())) {
    return filename;
  }
  return `${filename}${currentExt}`;
}

function sanitizeFilename(value, currentFilename) {
  const sanitized = sanitizeField(value);
  return ensureExtension(sanitized, currentFilename).toLowerCase();
}

function appendSuffixBeforeExt(filename, suffix, currentFilename) {
  if (!suffix) {
    return filename;
  }
  const safeSuffix = sanitizeField(suffix) || String(suffix);
  const ext =
    currentFilename && currentFilename.includes(".")
      ? currentFilename.slice(currentFilename.lastIndexOf("."))
      : "";
  let base = filename;
  if (ext && base.toLowerCase().endsWith(ext.toLowerCase())) {
    base = base.slice(0, -ext.length);
  }
  return ensureExtension(`${base}-${safeSuffix}`, currentFilename).toLowerCase();
}

function buildFilenameCandidates({ template, buildContext, seedKey, currentFilename, roomFallbacks }) {
  const fallbacks = roomFallbacks || DEFAULT_ROOM_FALLBACKS;
  const usesRoom = templateUsesRoom(template);

  const buildFilename = (roomOverride, suffixFallback) => {
    let ctx = buildContext();
    if (roomOverride != null) {
      ctx = { ...ctx, room: roomOverride };
    }
    let raw = applyTemplate(template, ctx);
    let filename = sanitizeFilename(raw, currentFilename);
    if (!usesRoom && suffixFallback) {
      filename = appendSuffixBeforeExt(filename, suffixFallback, currentFilename);
    }
    return filename;
  };

  const candidates = [];
  const seen = new Set();
  const addCandidate = (name) => {
    const key = (name || "").toLowerCase();
    if (key && !seen.has(key)) {
      seen.add(key);
      candidates.push(name);
    }
  };

  addCandidate(buildFilename(null, null));
  const start = fallbacks.length ? hashSeedKey(seedKey) % fallbacks.length : 0;
  for (let i = 0; i < fallbacks.length; i++) {
    const fallback = fallbacks[(start + i) % fallbacks.length];
    addCandidate(usesRoom ? buildFilename(fallback, null) : buildFilename(null, fallback));
  }

  const primary = candidates[0] || "";
  for (let i = 2; i <= 5; i++) {
    addCandidate(appendSuffixBeforeExt(primary, String(i), currentFilename));
  }
  const hashSuffix = hashSeedKey(seedKey).toString(36).slice(0, 6);
  addCandidate(appendSuffixBeforeExt(primary, hashSuffix, currentFilename));

  return candidates;
}

function isFilenameCollision(filename, usedFilenames, currentFilename) {
  const key = (filename || "").toLowerCase();
  if (!key) {
    return false;
  }
  const ownName = (currentFilename || "").toLowerCase();
  if (key === ownName) {
    return false;
  }
  return usedFilenames.has(key);
}

function resolveUniqueImageFilename({
  template,
  buildContext,
  seedKey,
  usedFilenames,
  currentFilename,
  roomFallbacks,
}) {
  if (!template) {
    return "";
  }
  const candidates = buildFilenameCandidates({
    template,
    buildContext,
    seedKey,
    currentFilename,
    roomFallbacks,
  });
  for (const filename of candidates) {
    if (!isFilenameCollision(filename, usedFilenames, currentFilename)) {
      usedFilenames.add(filename.toLowerCase());
      return filename;
    }
  }
  const last = candidates[candidates.length - 1] || "";
  if (last) {
    usedFilenames.add(last.toLowerCase());
  }
  return last;
}

function makeChangeId(change) {
  if (change.catalogInput?.imageIndex) {
    return `${change.resourceId}|${change.field}|${change.mutation}|${change.catalogInput.imageIndex}`;
  }
  return `${change.resourceId}|${change.field}|${change.mutation}`;
}

function mergeUniqueTags(tagList, additions) {
  const merged = [...tagList];
  for (const raw of additions) {
    const tag = String(raw || "").trim().toLowerCase();
    if (!tag) {
      continue;
    }
    if (!merged.some((existing) => existing.toLowerCase() === tag)) {
      merged.push(tag);
    }
  }
  return merged;
}

function computeCatalogTagList(product, rules, ctx) {
  let tagList;
  if (rules.tags) {
    tagList = applyTemplate(rules.tags, ctx)
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
  } else {
    tagList = [...(product.tags || [])];
  }

  if (rules.newTags) {
    const added = applyTemplate(rules.newTags, ctx)
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    tagList = mergeUniqueTags(tagList, added);
  }

  return mergeUniqueTags(tagList, product.colors || []);
}

function buildCatalogProductChanges(product, rules, shopName, descriptionPhrases, usedFilenames) {
  const changes = [];
  if (!rules) {
    return changes;
  }
  const roomFallbacks =
    Array.isArray(descriptionPhrases?.roomFallbacks) && descriptionPhrases.roomFallbacks.length
      ? descriptionPhrases.roomFallbacks
      : DEFAULT_ROOM_FALLBACKS;
  const phrases = descriptionPhrases?.phrases || [];
  const roomFallbackCache = {};
  const usedRooms = new Set();
  const images = catalogProductImages(product);
  const random = {
    random_tag: Array.isArray(product.tags) && product.tags.length
      ? product.tags[Math.floor(Math.random() * product.tags.length)]
      : "",
    random_description: phrases.length
      ? phrases[Math.floor(Math.random() * phrases.length)]
      : "",
  };
  const base = {
    ...catalogProductContext(
      product,
      images[0] || {},
      0,
      shopName,
      roomFallbacks,
      roomFallbackCache,
      usedRooms
    ),
    ...random,
  };

  const seoTitle = applyTemplate(rules.seoTitle, base);
  const seoDescription = applyTemplate(rules.seoDescription, base);
  const tagList = computeCatalogTagList(product, rules, base);
  const tagsJoined = tagList.join(", ");
  const currentTagsJoined = Array.isArray(product.tags) ? product.tags.join(", ") : "";

  if ((product.seoTitle || "") !== seoTitle) {
    changes.push({
      resourceType: "catalog-product",
      resourceId: product.productId,
      resourceTitle: product.title,
      field: "SEO title",
      current: product.seoTitle || "",
      proposed: seoTitle,
      mutation: "catalogSeoUpdate",
      catalogInput: { productId: product.productId, field: "seoTitle", value: seoTitle },
    });
  }

  if ((product.seoDescription || "") !== seoDescription) {
    changes.push({
      resourceType: "catalog-product",
      resourceId: product.productId,
      resourceTitle: product.title,
      field: "SEO description",
      current: product.seoDescription || "",
      proposed: seoDescription,
      mutation: "catalogSeoUpdate",
      catalogInput: {
        productId: product.productId,
        field: "seoDescription",
        value: seoDescription,
      },
    });
  }

  if (currentTagsJoined !== tagsJoined) {
    changes.push({
      resourceType: "catalog-product",
      resourceId: product.productId,
      resourceTitle: product.title,
      field: "Tags",
      current: currentTagsJoined,
      proposed: tagsJoined,
      mutation: "catalogTagsUpdate",
      catalogInput: { productId: product.productId, tags: tagList },
    });
  }

  for (const imageEntry of images) {
    const imageIndex = imageEntry.catalogGalleryIndex;
    const currentFilename = imageEntry.filename || basenameFromPath(imageEntry.path);
    const ctx = {
      ...catalogProductContext(
        product,
        imageEntry,
        imageIndex,
        shopName,
        roomFallbacks,
        roomFallbackCache,
        usedRooms
      ),
      ...random,
    };
    const alt = applyTemplate(rules.imageAlt, ctx);
    const filename = resolveUniqueImageFilename({
      template: rules.imageFilename,
      buildContext: () => ctx,
      seedKey: `${product.productId}:${imageIndex}`,
      usedFilenames,
      currentFilename,
      roomFallbacks,
    });

    if ((imageEntry.alt || "") !== alt) {
      changes.push({
        resourceType: "catalog-product",
        resourceId: product.productId,
        resourceTitle: product.title,
        field: `Image ${imageIndex} alt`,
        current: imageEntry.alt || "",
        proposed: alt,
        mutation: "catalogImageAlt",
        catalogInput: {
          productId: product.productId,
          imageKind: imageEntry.catalogImageKind,
          lifestyleListIndex: imageEntry.lifestyleListIndex,
          imageIndex,
          value: alt,
        },
      });
    }

    if (filename && (currentFilename || "") !== filename) {
      const dir = imageEntry.path ? path.dirname(imageEntry.path) : "";
      changes.push({
        resourceType: "catalog-product",
        resourceId: product.productId,
        resourceTitle: product.title,
        field: `Image ${imageIndex} filename`,
        current: currentFilename || "",
        proposed: filename,
        mutation: "catalogFileRename",
        catalogInput: {
          productId: product.productId,
          imageKind: imageEntry.catalogImageKind,
          lifestyleListIndex: imageEntry.lifestyleListIndex,
          imageIndex,
          oldPath: imageEntry.path,
          newFilename: filename,
          newPath: dir ? path.join(dir, filename) : filename,
        },
      });
    }
  }

  return changes;
}

function buildPreviewChanges(productIds) {
  const config = loadConfig();
  const rules = config.rules?.product;
  const shopName = config.shopName || "";
  const descriptionPhrases = {
    phrases: config.descriptionPhrases || [],
    roomFallbacks: config.roomFallbacks || DEFAULT_ROOM_FALLBACKS,
  };
  const store = loadCatalogStore();
  const products = productIds
    .map((id) => getProduct(id, store))
    .filter(Boolean);
  const usedFilenames = collectCatalogFilenames(products);
  const changes = [];
  for (const product of products) {
    changes.push(
      ...buildCatalogProductChanges(product, rules, shopName, descriptionPhrases, usedFilenames)
    );
  }
  return changes.map((c) => ({ ...c, changeId: makeChangeId(c) }));
}

function applyImageAlt(store, input) {
  const product = store.products[input.productId];
  if (!product) {
    throw new Error(`Product ${input.productId} not found.`);
  }
  if (input.imageKind === "source" || input.imageKind === "reference") {
    // Legacy: reference portrait is not a catalog image; ignore alt updates.
    return;
  }
  const idx = input.lifestyleListIndex;
  if (!Array.isArray(product.lifestyleImages) || product.lifestyleImages[idx] == null) {
    throw new Error("Lifestyle image not found.");
  }
  product.lifestyleImages[idx] = { ...product.lifestyleImages[idx], alt: input.value };
}

function applyFileRename(store, input) {
  const product = store.products[input.productId];
  if (!product) {
    throw new Error(`Product ${input.productId} not found.`);
  }
  if (input.imageKind === "source" || input.imageKind === "reference") {
    // Legacy: do not rename the reference portrait.
    return;
  }
  const oldPath = input.oldPath;
  const newPath = input.newPath;
  if (!oldPath || !newPath) {
    throw new Error("Missing file path for rename.");
  }
  if (!fs.existsSync(oldPath)) {
    throw new Error(`File not found: ${oldPath}`);
  }
  if (fs.existsSync(newPath) && path.resolve(newPath) !== path.resolve(oldPath)) {
    throw new Error(`Target file already exists: ${newPath}`);
  }
  if (path.resolve(oldPath) !== path.resolve(newPath)) {
    fs.renameSync(oldPath, newPath);
  }
  const updateEntry = (entry) => {
    if (entry?.index === 0) {
      return entry;
    }
    if (entry && path.resolve(entry.path) === path.resolve(oldPath)) {
      return { ...entry, path: newPath, filename: input.newFilename };
    }
    return entry;
  };
  product.images = (product.images || []).map(updateEntry);
  product.lifestyleImages = (product.lifestyleImages || []).map(updateEntry);
}

function applySeoField(store, input) {
  const product = store.products[input.productId];
  if (!product) {
    throw new Error(`Product ${input.productId} not found.`);
  }
  if (input.field === "seoTitle") {
    product.seoTitle = input.value;
  } else if (input.field === "seoDescription") {
    product.seoDescription = input.value;
  } else {
    throw new Error(`Unknown SEO field: ${input.field}`);
  }
}

function applyTags(store, input) {
  const product = store.products[input.productId];
  if (!product) {
    throw new Error(`Product ${input.productId} not found.`);
  }
  product.tags = Array.isArray(input.tags) ? [...input.tags] : [];
}

function applyChanges(changes) {
  const store = loadCatalogStore();
  const errors = [];
  const succeeded = [];
  const touchedProducts = new Set();

  for (const change of changes) {
    try {
      const input = change.catalogInput;
      if (!input) {
        throw new Error("Missing catalogInput.");
      }
      if (change.mutation === "catalogSeoUpdate") {
        applySeoField(store, input);
      } else if (change.mutation === "catalogImageAlt") {
        applyImageAlt(store, input);
      } else if (change.mutation === "catalogFileRename") {
        applyFileRename(store, input);
      } else if (change.mutation === "catalogTagsUpdate") {
        applyTags(store, input);
      } else {
        throw new Error(`Unknown mutation: ${change.mutation}`);
      }
      touchedProducts.add(input.productId);
      succeeded.push(change.changeId || makeChangeId(change));
    } catch (error) {
      errors.push({
        changeId: change.changeId || makeChangeId(change),
        resourceTitle: change.resourceTitle,
        field: change.field,
        message: error.message || "Apply failed.",
      });
    }
  }

  const now = new Date().toISOString();
  for (const productId of touchedProducts) {
    const product = store.products[productId];
    if (product) {
      product.seoFixedAt = now;
      product.seoStatus = "fixed";
    }
  }

  saveCatalogStore(store);
  return { succeeded, errors, touchedProductIds: [...touchedProducts] };
}

function lifestyleImagesHaveAlts(product) {
  const lifestyle = product.lifestyleImages || [];
  if (!lifestyle.length) {
    return false;
  }
  return lifestyle.every((img) => String(img?.alt || "").trim().length > 0);
}

/**
 * Prefer existing seoStatus === "fixed"; also mark enriched products whose
 * lifestyle images all have non-empty alt text.
 */
function backfillSeoStatus(store = loadCatalogStore()) {
  const now = new Date().toISOString();
  let alreadyFixed = 0;
  let newlyFixed = 0;
  let stillPending = 0;

  for (const product of Object.values(store.products || {})) {
    if (product.seoStatus === "fixed") {
      alreadyFixed += 1;
      continue;
    }
    const lifestyleCount = product.lifestyleImages?.length || 0;
    const eligible = product.status === "enriched" && lifestyleCount > 0;
    if (!eligible) {
      continue;
    }
    if (lifestyleImagesHaveAlts(product)) {
      product.seoStatus = "fixed";
      product.seoFixedAt = product.seoFixedAt || now;
      newlyFixed += 1;
    } else {
      stillPending += 1;
    }
  }

  if (newlyFixed > 0) {
    saveCatalogStore(store);
  }
  return { alreadyFixed, newlyFixed, stillPending };
}

/** Clear SEO fixed status on all products so Fix SEO must be re-run. */
function resetSeoStatusPending(store = loadCatalogStore()) {
  let reset = 0;
  for (const product of Object.values(store.products || {})) {
    if (product.seoStatus != null || product.seoFixedAt != null) {
      reset += 1;
    }
    product.seoStatus = null;
    product.seoFixedAt = null;
  }
  saveCatalogStore(store);
  return { reset, total: Object.keys(store.products || {}).length };
}

module.exports = {
  buildPreviewChanges,
  applyChanges,
  catalogProductImages,
  referenceProductImage,
  backfillSeoStatus,
  resetSeoStatusPending,
  sanitizeField,
  sanitizeFilename,
  applyTemplate,
  catalogProductContext,
  stripHtml,
};
