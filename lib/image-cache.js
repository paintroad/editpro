const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const os = require("os");

const CONFIG_DIR = path.join(os.homedir(), ".editpro");
const CACHE_DIR = path.join(CONFIG_DIR, "image-cache");
const INDEX_PATH = path.join(CONFIG_DIR, "image-cache-index.json");

const DEFAULTS = {
  imageMaxWidth: 512,
  maxDownloadBytes: 2 * 1024 * 1024,
  maxCacheMb: 500,
};

function ensureDirs() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

function safeFileId(fileId) {
  const hash = crypto.createHash("sha1").update(String(fileId)).digest("hex").slice(0, 16);
  return hash;
}

function urlHash(url) {
  return crypto.createHash("sha1").update(String(url)).digest("hex").slice(0, 12);
}

function resizeImageUrl(url, maxWidth) {
  const raw = String(url || "").trim();
  if (!raw) {
    return raw;
  }
  try {
    const parsed = new URL(raw);
    parsed.searchParams.set("width", String(maxWidth));
    return parsed.toString();
  } catch {
    const sep = raw.includes("?") ? "&" : "?";
    return `${raw}${sep}width=${maxWidth}`;
  }
}

function loadIndex() {
  ensureDirs();
  if (!fs.existsSync(INDEX_PATH)) {
    return { version: 1, entries: {} };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(INDEX_PATH, "utf8"));
    return { version: 1, entries: raw.entries && typeof raw.entries === "object" ? raw.entries : {} };
  } catch {
    return { version: 1, entries: {} };
  }
}

function saveIndex(index) {
  ensureDirs();
  fs.writeFileSync(INDEX_PATH, JSON.stringify({ version: 1, entries: index.entries }, null, 2), "utf8");
}

function localPathFor(fileId) {
  return path.join(CACHE_DIR, `${safeFileId(fileId)}.jpg`);
}

function getCacheStats() {
  const index = loadIndex();
  let totalBytes = 0;
  for (const entry of Object.values(index.entries)) {
    totalBytes += entry.bytes || 0;
  }
  return {
    count: Object.keys(index.entries).length,
    totalBytes,
    totalMb: totalBytes / 1024 / 1024,
  };
}

function evictIfNeeded(maxCacheMb) {
  const maxBytes = maxCacheMb * 1024 * 1024;
  const index = loadIndex();
  const entries = Object.entries(index.entries).sort(
    (a, b) => new Date(a[1].lastUsedAt || a[1].fetchedAt) - new Date(b[1].lastUsedAt || b[1].fetchedAt)
  );
  let totalBytes = entries.reduce((sum, [, e]) => sum + (e.bytes || 0), 0);
  for (const [fileId, entry] of entries) {
    if (totalBytes <= maxBytes) {
      break;
    }
    try {
      if (entry.localPath && fs.existsSync(entry.localPath)) {
        fs.unlinkSync(entry.localPath);
      }
    } catch {
      // ignore
    }
    delete index.entries[fileId];
    totalBytes -= entry.bytes || 0;
  }
  saveIndex(index);
}

async function downloadToFile(url, destPath, maxBytes) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!response.ok) {
    throw new Error(`Failed to download image (${response.status}).`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > maxBytes) {
    throw new Error(`Image too large (${Math.round(buffer.length / 1024)} KB).`);
  }
  fs.writeFileSync(destPath, buffer);
  return buffer.length;
}

async function ensureCached(imageMeta, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  ensureDirs();
  evictIfNeeded(opts.maxCacheMb);

  const fileId = imageMeta.fileId;
  const url = imageMeta.url;
  if (!fileId || !url) {
    throw new Error("Image metadata missing fileId or url.");
  }

  const index = loadIndex();
  const hash = urlHash(url);
  const destPath = localPathFor(fileId);
  const existing = index.entries[fileId];

  if (existing && existing.urlHash === hash && fs.existsSync(destPath)) {
    existing.lastUsedAt = new Date().toISOString();
    index.entries[fileId] = existing;
    saveIndex(index);
    return { localPath: destPath, fromCache: true };
  }

  const downloadUrl = resizeImageUrl(url, opts.imageMaxWidth);
  const bytes = await downloadToFile(downloadUrl, destPath, opts.maxDownloadBytes);
  index.entries[fileId] = {
    fileId,
    localPath: destPath,
    url,
    urlHash: hash,
    bytes,
    fetchedAt: new Date().toISOString(),
    lastUsedAt: new Date().toISOString(),
  };
  saveIndex(index);
  evictIfNeeded(opts.maxCacheMb);
  return { localPath: destPath, fromCache: false };
}

function clearCache() {
  ensureDirs();
  const index = loadIndex();
  for (const entry of Object.values(index.entries)) {
    try {
      if (entry.localPath && fs.existsSync(entry.localPath)) {
        fs.unlinkSync(entry.localPath);
      }
    } catch {
      // ignore
    }
  }
  saveIndex({ version: 1, entries: {} });
  return getCacheStats();
}

module.exports = {
  CACHE_DIR,
  DEFAULTS,
  resizeImageUrl,
  ensureCached,
  getCacheStats,
  evictIfNeeded,
  clearCache,
};
