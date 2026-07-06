/** Canonical and fallback keys for stable room map lookups. */

function canonicalKey(img) {
  const handle = img.handle || img.resourceHandle || "";
  if (!handle) {
    return null;
  }
  if (img.resourceType === "product") {
    return `product:${handle}:${img.imageIndex}`;
  }
  return `${img.resourceType}:${handle}:1`;
}

function fallbackGidKey(img) {
  if (!img.resourceId) {
    return null;
  }
  return `${img.resourceType}:${img.resourceId}:${img.imageIndex}`;
}

function lookupKeys(img) {
  const keys = [];
  const primary = canonicalKey(img);
  if (primary) {
    keys.push(primary);
  }
  const gidKey = fallbackGidKey(img);
  if (gidKey && gidKey !== primary) {
    keys.push(gidKey);
  }
  if (img.fileId) {
    keys.push(img.fileId);
  }
  return keys;
}

function isLegacyFileIdKey(key) {
  return typeof key === "string" && key.startsWith("gid://");
}

function imageFromResource(resource, resourceType, imageIndex = 1) {
  const image =
    resourceType === "product"
      ? resource.media?.nodes?.[imageIndex - 1]
      : resource.image;
  return {
    fileId: image?.id || "",
    handle: resource.handle || "",
    resourceType,
    resourceId: resource.id || "",
    resourceTitle: resource.title || "",
    imageIndex,
    url: image?.image?.url || image?.url || "",
  };
}

module.exports = {
  canonicalKey,
  fallbackGidKey,
  lookupKeys,
  isLegacyFileIdKey,
  imageFromResource,
};
