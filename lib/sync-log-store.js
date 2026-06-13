const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const CONFIG_DIR = path.join(os.homedir(), ".editpro");
const SYNC_LOG_PATH = path.join(CONFIG_DIR, "sync-log.json");
const MAX_ENTRIES = 200;

function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

function loadSyncLog() {
  ensureConfigDir();
  if (!fs.existsSync(SYNC_LOG_PATH)) {
    return [];
  }
  try {
    const raw = JSON.parse(fs.readFileSync(SYNC_LOG_PATH, "utf8"));
    return Array.isArray(raw.entries) ? raw.entries : [];
  } catch {
    return [];
  }
}

function saveSyncLog(entries) {
  ensureConfigDir();
  fs.writeFileSync(SYNC_LOG_PATH, JSON.stringify({ entries }, null, 2), "utf8");
}

function addSyncLogEntry(entry) {
  const entries = loadSyncLog();
  const record = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    status: entry.status || "synced",
    changeCount: entry.changeCount || 0,
    resourceCount: entry.resourceCount || 0,
    summary: entry.summary || "",
    changes: entry.changes || [],
  };
  entries.unshift(record);
  if (entries.length > MAX_ENTRIES) {
    entries.length = MAX_ENTRIES;
  }
  saveSyncLog(entries);
  return record;
}

function getSyncLogEntry(id) {
  return loadSyncLog().find((e) => e.id === id) || null;
}

function updateSyncLogEntry(id, updates) {
  const entries = loadSyncLog();
  const index = entries.findIndex((e) => e.id === id);
  if (index === -1) {
    return null;
  }
  entries[index] = { ...entries[index], ...updates };
  saveSyncLog(entries);
  return entries[index];
}

module.exports = {
  SYNC_LOG_PATH,
  loadSyncLog,
  addSyncLogEntry,
  getSyncLogEntry,
  updateSyncLogEntry,
};
