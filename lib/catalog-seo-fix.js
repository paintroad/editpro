const fs = require("fs");
const path = require("path");
const { loadConfig } = require("./config-store");
const { truncate } = require("./catalog-text-utils");
const { loadCatalogStore, getProduct, saveCatalogStore } = require("./catalog-products-store");

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

function catalogProductImages(product) {
  const images = [];
  if (product.sourceImage?.path) {
    images.push({
      ...product.sourceImage,
      catalogImageKind: "source",
      lifestyleListIndex: null,
    });
  }
  const lifestyle = [...(product.lifestyleImages || [])].sort(
    (a, b) => (a.index ?? 0) - (b.index ?? 0)
  );
  for (let i = 0; i < lifestyle.length; i++) {
    images.push({
      ...lifestyle[i],
      catalogImageKind: "lifestyle",
      lifestyleListIndex: i,
    });
  }
  return images.map((img, i) => ({ ...img, catalogGalleryIndex: i + 1 }));
}

function collectCatalogFilenames(products) {
  const used = new Set();
  for (const product of products) {
    for (const img of catalogProductImages(product)) {
      const name = img.filename || basenameFromPath(img.path);
      if (name) {
        used.add(name.toLowerCase());
      }
    }
  }
  return used;
}

function catalogResolveRoom(product, imageEntry, imageIndex, roomFallbacks, roomFallbackCache) {
  const roomLabel = imageEntry?.roomLabel || imageEntry?.room || "";
  if (roomLabel) {
    return roomLabel;
  }
  const seedKey = `${product.productId}:${imageIndex}`;
  if (!roomFallbackCache[seedKey]) {
    const idx = roomFallbacks.length ? hashSeedKey(seedKey) % roomFallbacks.length : 0;
    roomFallbackCache[seedKey] = roomFallbacks[idx] || "";
  }
  return roomFallbackCache[seedKey];
}

function catalogProductContext(product, imageEntry, imageIndex, shopName, roomFallbacks, roomFallbackCache) {
  const description = stripHtml(product.descriptionHtml || product.descriptionPlain || "");
  const title = product.title || "";
  const productType = product.productType || "";
  const currentFilename = imageEntry?.filename || basenameFromPath(imageEntry?.path);
  const room = catalogResolveRoom(product, imageEntry, imageIndex, roomFallbacks, roomFallbackCache);
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

function ensureExtension(filename, currentFilename) {
  if (!filename) {
    return filename;
  }
  if (filename.includes(".")) {
    return filename;
  }
  const ext = currentFilename && currentFilename.includes(".")
    ? currentFilename.slice(currentFilename.lastIndexOf("."))
    : ".jpg";
  return `${filename}${ext}`;
}

function buildFilenameCandidates({ template, buildContext, seedKey, currentFilename }) {
  const ctx = buildContext();
  let filename = applyTemplate(template, ctx);
  filename = ensureExtension(filename, currentFilename).toLowerCase();
  const candidates = [filename];
  for (let i = 2; i <= 5; i++) {
    const suffix = String(i);
    const ext =
      currentFilename && currentFilename.includes(".")
        ? currentFilename.slice(currentFilename.lastIndexOf("."))
        : "";
    let base = filename;
    if (ext && base.toLowerCase().endsWith(ext.toLowerCase())) {
      base = base.slice(0, -ext.length);
    }
    candidates.push(ensureExtension(`${base}-${suffix}`, currentFilename).toLowerCase());
  }
  const hashSuffix = hashSeedKey(seedKey).toString(36).slice(0, 6);
  const ext =
    currentFilename && currentFilename.includes(".")
      ? currentFilename.slice(currentFilename.lastIndexOf("."))
      : "";
  let base = filename;
  if (ext && base.toLowerCase().endsWith(ext.toLowerCase())) {
    base = base.slice(0, -ext.length);
  }
  candidates.push(ensureExtension(`${base}-${hashSuffix}`, currentFilename).toLowerCase());
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
}) {
  if (!template) {
    return "";
  }
  const candidates = buildFilenameCandidates({ template, buildContext, seedKey, currentFilename });
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
  const images = catalogProductImages(product);
  const random = {
    random_tag: Array.isArray(product.tags) && product.tags.length
      ? product.tags[Math.floor(Math.random() * product.tags.length)]
      : "",
    random_description: phrases.length
      ? phrases[Math.floor(Math.random() * phrases.length)]
      : "",
  };
  const base = { ...catalogProductContext(product, images[0] || {}, 0, shopName, roomFallbacks, roomFallbackCache), ...random };

  const seoTitle = applyTemplate(rules.seoTitle, base);
  const seoDescription = applyTemplate(rules.seoDescription, base);

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
        roomFallbackCache
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
  if (input.imageKind === "source") {
    if (!product.sourceImage) {
      throw new Error("Source image missing.");
    }
    product.sourceImage = { ...product.sourceImage, alt: input.value };
    const portrait = product.images?.find((img) => img.index === 0);
    if (portrait) {
      portrait.alt = input.value;
    }
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
    if (entry && path.resolve(entry.path) === path.resolve(oldPath)) {
      return { ...entry, path: newPath, filename: input.newFilename };
    }
    return entry;
  };
  product.sourceImage = updateEntry(product.sourceImage);
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

module.exports = {
  buildPreviewChanges,
  applyChanges,
  catalogProductImages,
};
