const path = require("path");
const { truncate } = require("./catalog-text-utils");
const { getRoomForImage } = require("./image-room-store");

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

function filenameFromUrl(url) {
  if (!url) {
    return "";
  }
  try {
    const pathname = new URL(url).pathname;
    return path.basename(pathname.split("?")[0] || "");
  } catch {
    const parts = String(url).split("/");
    return (parts[parts.length - 1] || "").split("?")[0];
  }
}

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
      : ".jpg";
  if (filename.toLowerCase().endsWith(currentExt.toLowerCase())) {
    return filename;
  }
  return `${filename}${currentExt}`;
}

function sanitizeFilename(value, currentFilename = "") {
  const sanitized = sanitizeField(value);
  return ensureExtension(sanitized, currentFilename || ".jpg").toLowerCase();
}

function pickRandom(arr) {
  if (!Array.isArray(arr) || arr.length === 0) {
    return "";
  }
  return arr[Math.floor(Math.random() * arr.length)];
}

function collectionContext(collection, shopName = "", options = {}) {
  const description = stripHtml(collection.descriptionHtml || "");
  const title = collection.title || "";
  const handle = collection.handle || "";
  const localImagePath = options.localImagePath || collection.localImagePath || "";
  const localExt = localImagePath ? path.extname(localImagePath).toLowerCase() : ".jpg";
  const plannedFilename = sanitizeFilename(
    applyTemplate(options.rules?.imageFilename, {
      title,
      handle,
      collection_name: title,
      description,
      description100: truncate(description, 100),
      description160: truncate(description, 160),
      shopName: shopName || "",
      shop_name: shopName || "",
      "image.index": "1",
      incrementing_number: "1",
      room: options.room || "",
      random_description: options.randomDescription || "",
      "image.alt": "",
      "image.filename": "",
    }),
    `placeholder${localExt}`
  );
  const imageUrl = collection.image?.url || collection.imageUrl || "";
  return {
    title,
    handle,
    collection_name: title,
    description,
    description100: truncate(description, 100),
    description160: truncate(description, 160),
    shopName: shopName || "",
    shop_name: shopName || "",
    "image.index": "1",
    incrementing_number: "1",
    room: options.room || "",
    random_description: options.randomDescription || "",
    "image.alt": collection.image?.alt || "",
    "image.filename": plannedFilename || filenameFromUrl(imageUrl),
  };
}

function buildCollectionSeoAndImageFields({
  collection,
  rules,
  shopName = "",
  localImagePath = "",
  room = "",
  randomDescription = "",
}) {
  const ctx = collectionContext(collection, shopName, {
    rules,
    localImagePath,
    room,
    randomDescription,
  });
  const localExt = localImagePath ? path.extname(localImagePath).toLowerCase() : ".jpg";
  const seedFilename = `placeholder${localExt}`;
  return {
    seoTitle: applyTemplate(rules?.seoTitle, ctx),
    seoDescription: applyTemplate(rules?.seoDescription, ctx),
    imageAlt: applyTemplate(rules?.imageAlt, ctx),
    imageFilename: sanitizeFilename(applyTemplate(rules?.imageFilename, ctx), seedFilename),
  };
}

function resolveRoomForPortrait({ productId, productHandle, shopifyProductId }) {
  return getRoomForImage({
    handle: productHandle || "",
    resourceType: "product",
    resourceId: shopifyProductId || productId || "",
    imageIndex: 1,
  });
}

module.exports = {
  stripHtml,
  applyTemplate,
  collectionContext,
  buildCollectionSeoAndImageFields,
  sanitizeFilename,
  filenameFromUrl,
  resolveRoomForPortrait,
  pickRandom,
};
