const fs = require("fs");
const path = require("path");
const os = require("os");
const { enumerateCatalogImages } = require("./catalog-images");
const {
  canonicalKey,
  lookupKeys,
  isLegacyFileIdKey,
} = require("./room-map-keys");

const CONFIG_DIR = path.join(os.homedir(), ".editpro");
const IMAGE_ROOM_PATH = path.join(CONFIG_DIR, "image-room-map.json");
const STORE_VERSION = 2;

function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

function defaultStore() {
  return {
    version: STORE_VERSION,
    updatedAt: null,
    mappings: {},
  };
}

function loadImageRoomMap() {
  ensureConfigDir();
  if (!fs.existsSync(IMAGE_ROOM_PATH)) {
    return defaultStore();
  }
  try {
    const raw = JSON.parse(fs.readFileSync(IMAGE_ROOM_PATH, "utf8"));
    return {
      version: raw.version || 1,
      updatedAt: raw.updatedAt || null,
      mappings: raw.mappings && typeof raw.mappings === "object" ? raw.mappings : {},
    };
  } catch {
    return defaultStore();
  }
}

function saveImageRoomMap(store) {
  ensureConfigDir();
  const next = {
    version: STORE_VERSION,
    updatedAt: new Date().toISOString(),
    mappings: store.mappings || {},
  };
  fs.writeFileSync(IMAGE_ROOM_PATH, JSON.stringify(next, null, 2), "utf8");
  return next;
}

function findMappingEntry(store, img) {
  const keys = lookupKeys(img);
  for (const key of keys) {
    if (store.mappings[key]) {
      return { key, entry: store.mappings[key] };
    }
  }
  return null;
}

function getMappingForImage(img, store = loadImageRoomMap()) {
  return findMappingEntry(store, img)?.entry || null;
}

function getRoomForImage(img, store = loadImageRoomMap()) {
  return getMappingForImage(img, store)?.room || "";
}

function hasMappingForImage(img, store = loadImageRoomMap()) {
  return Boolean(findMappingEntry(store, img));
}

function getMapping(fileId) {
  const store = loadImageRoomMap();
  return store.mappings[fileId] || null;
}

function buildEntry(img, fields) {
  const key = canonicalKey(img) || img.fileId;
  return {
    key,
    entry: {
      room: fields.room,
      source: fields.source || "openai",
      resourceType: img.resourceType,
      handle: img.handle || "",
      resourceId: img.resourceId,
      resourceTitle: img.resourceTitle || "",
      imageIndex: img.imageIndex,
      fileId: img.fileId,
      url: img.url || "",
      detectedAt: fields.detectedAt || new Date().toISOString(),
    },
  };
}

function upsertInStore(store, img, fields) {
  const { key, entry } = buildEntry(img, fields);
  if (!key) {
    throw new Error("Cannot upsert mapping without canonical key or fileId.");
  }

  const legacyKeys = lookupKeys(img).filter((k) => k !== key && isLegacyFileIdKey(k));
  for (const legacyKey of legacyKeys) {
    if (store.mappings[legacyKey] && legacyKey !== key) {
      delete store.mappings[legacyKey];
    }
  }

  for (const [mapKey, existing] of Object.entries(store.mappings)) {
    if (
      mapKey !== key &&
      existing.fileId === img.fileId &&
      isLegacyFileIdKey(mapKey)
    ) {
      delete store.mappings[mapKey];
    }
  }

  store.mappings[key] = entry;
  return store;
}

function upsertMapping(img, fields) {
  const store = loadImageRoomMap();
  upsertInStore(store, img, fields);
  return saveImageRoomMap(store);
}

function upsertMappings(entries) {
  const store = loadImageRoomMap();
  const now = new Date().toISOString();
  for (const item of entries) {
    const img = item.fileId
      ? item
      : {
          fileId: item.fileId,
          handle: item.handle,
          resourceType: item.resourceType,
          resourceId: item.resourceId,
          resourceTitle: item.resourceTitle,
          imageIndex: item.imageIndex,
          url: item.url,
        };
    upsertInStore(store, img, { ...item, detectedAt: item.detectedAt || now });
  }
  return saveImageRoomMap(store);
}

function createMutableStore() {
  return loadImageRoomMap();
}

function flushStore(store) {
  return saveImageRoomMap(store);
}

function getMappingsList() {
  const store = loadImageRoomMap();
  return Object.values(store.mappings);
}

function buildCatalogHandleIndex(storeData) {
  const index = new Map();
  for (const img of enumerateCatalogImages(storeData)) {
    const key = canonicalKey(img);
    if (key) {
      index.set(key, img);
    }
    const gidKey = `${img.resourceType}:${img.resourceId}:${img.imageIndex}`;
    if (!index.has(gidKey)) {
      index.set(gidKey, img);
    }
    if (img.fileId) {
      index.set(img.fileId, img);
    }
  }
  return index;
}

function reconcileImageRoomMap(storeData, store = loadImageRoomMap()) {
  const catalogIndex = buildCatalogHandleIndex(storeData);
  const images = enumerateCatalogImages(storeData);
  let migrated = 0;
  let updated = 0;
  const keysToDelete = [];

  for (const [mapKey, entry] of Object.entries(store.mappings)) {
    if (!isLegacyFileIdKey(mapKey)) {
      continue;
    }
    const catalogImg =
      catalogIndex.get(mapKey) ||
      (entry.resourceId && entry.imageIndex
        ? catalogIndex.get(`${entry.resourceType}:${entry.resourceId}:${entry.imageIndex}`)
        : null);

    if (!catalogImg) {
      continue;
    }

    const canonical = canonicalKey(catalogImg);
    if (!canonical) {
      continue;
    }

    const merged = {
      ...entry,
      room: entry.room,
      source: entry.source || "openai",
      resourceType: catalogImg.resourceType,
      handle: catalogImg.handle || entry.handle || "",
      resourceId: catalogImg.resourceId,
      resourceTitle: catalogImg.resourceTitle || entry.resourceTitle || "",
      imageIndex: catalogImg.imageIndex,
      fileId: catalogImg.fileId,
      url: catalogImg.url || entry.url || "",
      detectedAt: entry.detectedAt || new Date().toISOString(),
    };

    if (!store.mappings[canonical]) {
      store.mappings[canonical] = merged;
      migrated += 1;
    } else {
      store.mappings[canonical] = {
        ...store.mappings[canonical],
        ...merged,
        room: store.mappings[canonical].room || merged.room,
      };
      updated += 1;
    }
    keysToDelete.push(mapKey);
  }

  for (const img of images) {
    const canonical = canonicalKey(img);
    if (!canonical || !store.mappings[canonical]) {
      continue;
    }
    const existing = store.mappings[canonical];
    if (existing.fileId !== img.fileId || existing.url !== img.url) {
      store.mappings[canonical] = {
        ...existing,
        handle: img.handle || existing.handle,
        resourceId: img.resourceId,
        resourceTitle: img.resourceTitle || existing.resourceTitle,
        fileId: img.fileId,
        url: img.url,
      };
      updated += 1;
    }
  }

  for (const key of keysToDelete) {
    delete store.mappings[key];
  }

  store.version = STORE_VERSION;
  saveImageRoomMap(store);

  return {
    version: store.version,
    migrated,
    updated,
    total: Object.keys(store.mappings).length,
  };
}

module.exports = {
  IMAGE_ROOM_PATH,
  STORE_VERSION,
  loadImageRoomMap,
  saveImageRoomMap,
  getMapping,
  getMappingForImage,
  getRoomForImage,
  hasMappingForImage,
  upsertMapping,
  upsertMappings,
  createMutableStore,
  upsertInStore,
  flushStore,
  getMappingsList,
  reconcileImageRoomMap,
  findMappingEntry,
};
