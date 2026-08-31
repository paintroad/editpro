const fs = require("fs");
const path = require("path");
const os = require("os");

const CONFIG_DIR = path.join(os.homedir(), ".editpro");
const STORE_PATH = path.join(CONFIG_DIR, "artists.json");
const STORE_VERSION = 1;
const DEFAULT_SOURCE_PATH = path.join(
  "C:",
  "Paintroad",
  "Files",
  "Prints_Categories",
  "Famous Painters"
);
const ARTISTS_IMAGE_DIR = path.join("C:", "Paintroad", "Files", "Artists");

function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

function ensureArtistsImageDir() {
  if (!fs.existsSync(ARTISTS_IMAGE_DIR)) {
    fs.mkdirSync(ARTISTS_IMAGE_DIR, { recursive: true });
  }
  return ARTISTS_IMAGE_DIR;
}

function defaultStore() {
  return {
    version: STORE_VERSION,
    scannedAt: null,
    sourcePath: DEFAULT_SOURCE_PATH,
    imageDir: ARTISTS_IMAGE_DIR,
    artists: [],
    countries: [],
  };
}

function loadArtistsStore() {
  ensureConfigDir();
  if (!fs.existsSync(STORE_PATH)) {
    return defaultStore();
  }
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
    const store = { ...defaultStore(), ...raw };
    if (!Array.isArray(store.artists)) store.artists = [];
    if (!Array.isArray(store.countries)) store.countries = [];
    return store;
  } catch {
    return defaultStore();
  }
}

function saveArtistsStore(store) {
  ensureConfigDir();
  const next = {
    ...defaultStore(),
    ...store,
    version: STORE_VERSION,
    artists: Array.isArray(store.artists) ? store.artists : [],
    countries: Array.isArray(store.countries) ? store.countries : [],
  };
  fs.writeFileSync(STORE_PATH, JSON.stringify(next, null, 2), "utf8");
  return next;
}

function getArtist(store, id) {
  return (store.artists || []).find((a) => a.id === id) || null;
}

function upsertArtist(store, artist) {
  const artists = [...(store.artists || [])];
  const idx = artists.findIndex((a) => a.id === artist.id);
  if (idx >= 0) artists[idx] = { ...artists[idx], ...artist };
  else artists.push(artist);
  store.artists = artists;
  return store;
}

function computeArtistStats(store) {
  const artists = store.artists || [];
  return {
    total: artists.length,
    enriched: artists.filter((a) => a.enrichStatus === "enriched").length,
    onShopify: artists.filter((a) => a.shopifyStatus === "created").length,
    pendingEnrich: artists.filter(
      (a) => !a.enrichStatus || a.enrichStatus === "pending"
    ).length,
    pendingShopify: artists.filter(
      (a) => a.enrichStatus === "enriched" && a.shopifyStatus !== "created"
    ).length,
    errors: artists.filter(
      (a) => a.enrichStatus === "error" || a.shopifyStatus === "error"
    ).length,
  };
}

function stripImagesFromHtml(html) {
  let out = String(html || "");
  out = out.replace(/<img\b[^>]*>/gi, "");
  out = out.replace(/<figure\b[^>]*>[\s\S]*?<\/figure>/gi, "");
  out = out.replace(/data:image\/[^"'\s)]+/gi, "");
  return out.trim();
}

function htmlToPlainPreview(html, maxLen = 120) {
  const plain = String(html || "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/p>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (plain.length <= maxLen) return plain;
  return `${plain.slice(0, maxLen - 1)}…`;
}

const PORTRAIT_EXTS = [".jpg", ".jpeg", ".png", ".webp", ".avif", ".gif"];

function portraitPathForSlug(slug) {
  ensureArtistsImageDir();
  const base = path.join(ARTISTS_IMAGE_DIR, slug);
  for (const ext of PORTRAIT_EXTS) {
    const candidate = `${base}${ext}`;
    if (fs.existsSync(candidate)) return candidate;
  }
  return `${base}.jpg`;
}

/** Re-read C:\Paintroad\Files\Artists\{slug}.* into each artist's imageLocalPath. */
function syncArtistPortraitsFromDisk(store = null) {
  const current = store || loadArtistsStore();
  let changed = false;
  const artists = (current.artists || []).map((artist) => {
    const onDisk = portraitPathForSlug(artist.id);
    if (fs.existsSync(onDisk) && artist.imageLocalPath !== onDisk) {
      changed = true;
      return { ...artist, imageLocalPath: onDisk };
    }
    if (fs.existsSync(onDisk)) {
      return { ...artist, imageLocalPath: onDisk };
    }
    return artist;
  });
  current.artists = artists;
  if (changed || store == null) {
    return saveArtistsStore(current);
  }
  return current;
}

module.exports = {
  STORE_PATH,
  DEFAULT_SOURCE_PATH,
  ARTISTS_IMAGE_DIR,
  PORTRAIT_EXTS,
  ensureArtistsImageDir,
  loadArtistsStore,
  saveArtistsStore,
  getArtist,
  upsertArtist,
  computeArtistStats,
  stripImagesFromHtml,
  htmlToPlainPreview,
  portraitPathForSlug,
  syncArtistPortraitsFromDisk,
};
