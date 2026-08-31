const fs = require("fs");
const path = require("path");
const {
  DEFAULT_SOURCE_PATH,
  loadArtistsStore,
  saveArtistsStore,
  ARTISTS_IMAGE_DIR,
  portraitPathForSlug,
} = require("./artists-store");

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);

function slugify(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/['']/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function normalizeDisplayName(folderName) {
  let name = String(folderName || "").trim();
  name = name.replace(/\?+$/g, "");
  name = name.replace(/\s+/g, " ");
  // Keep (Japan) / Style in folderName; strip for cleaner display name
  name = name.replace(/\s*\(Japan\)\s*$/i, "").trim();
  name = name.replace(/\s+Style\s*$/i, "").trim();
  return name || String(folderName || "").trim();
}

function productIdsFromArtistDir(dirPath) {
  if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
    return [];
  }
  const ids = new Set();
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (!IMAGE_EXTS.has(ext)) continue;
    const base = path.basename(entry.name, ext);
    const match = String(base).match(/^(\d+)/);
    if (match) ids.add(match[1]);
  }
  return [...ids].sort((a, b) => Number(a) - Number(b));
}

function scanFamousPainters(sourcePath = DEFAULT_SOURCE_PATH) {
  const root = path.resolve(sourcePath || DEFAULT_SOURCE_PATH);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`Famous Painters folder not found: ${root}`);
  }

  const existingStore = loadArtistsStore();
  const existingById = new Map(
    (existingStore.artists || []).map((a) => [a.id, a])
  );

  const artists = [];
  const dirs = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b));

  for (const folderName of dirs) {
    const folderPath = path.join(root, folderName);
    const name = normalizeDisplayName(folderName);
    const id = slugify(name) || slugify(folderName);
    if (!id) continue;

    const productIds = productIdsFromArtistDir(folderPath);
    const prev = existingById.get(id);
    const imageLocalPath = portraitPathForSlug(id);
    const hasImage = fs.existsSync(imageLocalPath);

    artists.push({
      id,
      name,
      folderName,
      folderPath,
      productIds,
      enrichStatus: prev?.enrichStatus || "pending",
      shopifyStatus: prev?.shopifyStatus || "pending",
      biographyHtml: prev?.biographyHtml || "",
      wikipediaUrl: prev?.wikipediaUrl || "",
      imageLocalPath: hasImage ? imageLocalPath : prev?.imageLocalPath || imageLocalPath,
      shopifyMetaobjectId: prev?.shopifyMetaobjectId || null,
      shopifyImageFileId: prev?.shopifyImageFileId || null,
      nationality: prev?.nationality || null,
      countryIso2: prev?.countryIso2 || null,
      countryHandle: prev?.countryHandle || null,
      shopifyCountryId: prev?.shopifyCountryId || null,
      error: prev?.error || null,
      enrichedAt: prev?.enrichedAt || null,
      pushedAt: prev?.pushedAt || null,
      biographyEditedAt: prev?.biographyEditedAt || null,
      linkedProductCount: prev?.linkedProductCount || 0,
    });
  }

  const store = saveArtistsStore({
    ...existingStore,
    scannedAt: new Date().toISOString(),
    sourcePath: root,
    imageDir: ARTISTS_IMAGE_DIR,
    countries: existingStore.countries || [],
    artists,
  });

  return store;
}

module.exports = {
  slugify,
  normalizeDisplayName,
  productIdsFromArtistDir,
  scanFamousPainters,
};
