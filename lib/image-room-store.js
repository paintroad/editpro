const fs = require("fs");
const path = require("path");
const os = require("os");

const CONFIG_DIR = path.join(os.homedir(), ".editpro");
const IMAGE_ROOM_PATH = path.join(CONFIG_DIR, "image-room-map.json");

function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

function defaultStore() {
  return {
    version: 1,
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
    version: 1,
    updatedAt: new Date().toISOString(),
    mappings: store.mappings || {},
  };
  fs.writeFileSync(IMAGE_ROOM_PATH, JSON.stringify(next, null, 2), "utf8");
  return next;
}

function getMapping(fileId) {
  return loadImageRoomMap().mappings[fileId] || null;
}

function upsertMapping(entry) {
  const store = loadImageRoomMap();
  store.mappings[entry.fileId] = {
    ...entry,
    detectedAt: entry.detectedAt || new Date().toISOString(),
    source: entry.source || "ollama",
  };
  return saveImageRoomMap(store);
}

function upsertMappings(entries) {
  const store = loadImageRoomMap();
  const now = new Date().toISOString();
  for (const entry of entries) {
    store.mappings[entry.fileId] = {
      ...entry,
      detectedAt: entry.detectedAt || now,
      source: entry.source || "ollama",
    };
  }
  return saveImageRoomMap(store);
}

function getMappingsList() {
  const store = loadImageRoomMap();
  return Object.values(store.mappings);
}

module.exports = {
  IMAGE_ROOM_PATH,
  loadImageRoomMap,
  saveImageRoomMap,
  getMapping,
  upsertMapping,
  upsertMappings,
  getMappingsList,
};
