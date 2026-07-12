const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const os = require("os");
const sharp = require("sharp");

const CONFIG_DIR = path.join(os.homedir(), ".editpro");
const THUMB_CACHE_DIRS = {
  collections: path.join(CONFIG_DIR, "collections-thumbs"),
  catalog: path.join(CONFIG_DIR, "catalog-thumbs"),
};

const DEFAULT_WIDTH = 360;
const DEFAULT_QUALITY = 75;
const MAX_WIDTH = 800;

function ensureThumbCacheDir(namespace) {
  const cacheDir = THUMB_CACHE_DIRS[namespace] || THUMB_CACHE_DIRS.collections;
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }
  return cacheDir;
}

function parseThumbWidth(value) {
  const width = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(width) || width <= 0) {
    return DEFAULT_WIDTH;
  }
  return Math.min(width, MAX_WIDTH);
}

function thumbCacheKey(filePath, mtimeMs, width) {
  return crypto
    .createHash("sha1")
    .update(`${filePath}|${mtimeMs}|${width}`)
    .digest("hex");
}

function thumbCachePath(cacheDir, cacheKey) {
  return path.join(cacheDir, `${cacheKey}.jpg`);
}

async function generateThumbnail(sourcePath, width, namespace = "collections") {
  const cacheDir = ensureThumbCacheDir(namespace);
  const stat = fs.statSync(sourcePath);
  const cacheKey = thumbCacheKey(sourcePath, stat.mtimeMs, width);
  const cachedPath = thumbCachePath(cacheDir, cacheKey);

  if (fs.existsSync(cachedPath)) {
    return cachedPath;
  }

  const buffer = await sharp(sourcePath)
    .rotate()
    .resize({ width, withoutEnlargement: true })
    .jpeg({ quality: DEFAULT_QUALITY })
    .toBuffer();

  fs.writeFileSync(cachedPath, buffer);
  return cachedPath;
}

async function getThumbnail(filePath, options = {}) {
  const width = parseThumbWidth(options.width);
  const namespace = options.namespace || "collections";
  return generateThumbnail(filePath, width, namespace);
}

async function getCollectionThumbnail(filePath, options = {}) {
  return getThumbnail(filePath, { ...options, namespace: "collections" });
}

async function getCatalogThumbnail(filePath, options = {}) {
  return getThumbnail(filePath, { ...options, namespace: "catalog" });
}

module.exports = {
  DEFAULT_WIDTH,
  parseThumbWidth,
  getThumbnail,
  getCollectionThumbnail,
  getCatalogThumbnail,
};
