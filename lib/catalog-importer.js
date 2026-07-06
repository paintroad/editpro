const fs = require("fs/promises");
const path = require("path");
const { collectProductFolders } = require("./square-paintings-scanner");

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

function isImageFile(name) {
  return IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase());
}

function isHiddenFile(name) {
  return name.startsWith(".") || name.startsWith("._");
}

function parseProductImageFilename(filename, productId) {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  const pattern = new RegExp(`^${productId}_(\\d+)$`, "i");
  const match = base.match(pattern);
  if (!match) {
    return null;
  }
  return {
    index: parseInt(match[1], 10),
    filename,
  };
}

function parseFlatProductImageFilename(filename) {
  const ext = path.extname(filename);
  const productId = path.basename(filename, ext);
  if (!productId || !/^\d+$/.test(productId)) {
    return null;
  }
  return {
    productId,
    index: 0,
    filename,
  };
}

async function scanProductImages(folderPath, productId) {
  const files = await fs.readdir(folderPath);
  const images = [];

  for (const file of files) {
    if (!isImageFile(file) || isHiddenFile(file)) {
      continue;
    }
    const parsed = parseProductImageFilename(file, productId);
    if (!parsed) {
      continue;
    }
    images.push({
      index: parsed.index,
      filename: parsed.filename,
      path: path.join(folderPath, parsed.filename),
    });
  }

  images.sort((a, b) => a.index - b.index);
  return images;
}

async function detectCatalogLayout(catalogRoot) {
  const entries = await fs.readdir(catalogRoot, { withFileTypes: true });
  const rootImages = entries.filter(
    (entry) => entry.isFile() && isImageFile(entry.name) && !isHiddenFile(entry.name),
  );
  const rootDirs = entries.filter((entry) => entry.isDirectory() && !isHiddenFile(entry.name));

  if (rootImages.length > 0 && rootImages.length >= rootDirs.length) {
    return "flat";
  }
  return "nested";
}

async function collectFlatProducts(catalogRoot) {
  const files = await fs.readdir(catalogRoot);
  const byProductId = new Map();

  for (const file of files) {
    if (!isImageFile(file) || isHiddenFile(file)) {
      continue;
    }
    const parsed = parseFlatProductImageFilename(file);
    if (!parsed) {
      continue;
    }
    const imagePath = path.join(catalogRoot, parsed.filename);
    const existing = byProductId.get(parsed.productId);
    if (!existing) {
      byProductId.set(parsed.productId, {
        productId: parsed.productId,
        folderPath: catalogRoot,
        images: [
          {
            index: parsed.index,
            filename: parsed.filename,
            path: imagePath,
          },
        ],
      });
      continue;
    }
    existing.images.push({
      index: parsed.index,
      filename: parsed.filename,
      path: imagePath,
    });
    existing.images.sort((a, b) => a.index - b.index);
  }

  return [...byProductId.values()].sort((a, b) =>
    a.productId.localeCompare(b.productId, undefined, { numeric: true }),
  );
}

async function importNestedCatalog(normalized) {
  const folders = await collectProductFolders(normalized);
  const products = [];
  const skipped = [];

  for (const { productId, folderPath } of folders) {
    const images = await scanProductImages(folderPath, productId);
    if (!images.length) {
      skipped.push({ productId, reason: "no matching images (expected {productId}_{n}.jpg)" });
      continue;
    }
    if (!images.some((img) => img.index === 0)) {
      skipped.push({ productId, reason: "missing portrait image {productId}_0" });
    }
    products.push({
      productId,
      folderPath,
      images,
    });
  }

  return {
    catalogPath: normalized,
    layout: "nested",
    products,
    skipped,
    total: folders.length,
  };
}

async function importFlatCatalog(normalized) {
  const products = await collectFlatProducts(normalized);
  const skipped = [];

  for (const product of products) {
    if (!product.images.some((img) => img.index === 0)) {
      skipped.push({ productId: product.productId, reason: "missing portrait image" });
    }
  }

  return {
    catalogPath: normalized,
    layout: "flat",
    products,
    skipped,
    total: products.length,
  };
}

async function importCatalog(catalogRoot) {
  const normalized = path.normalize(catalogRoot.trim());
  const layout = await detectCatalogLayout(normalized);
  if (layout === "flat") {
    return importFlatCatalog(normalized);
  }
  return importNestedCatalog(normalized);
}

module.exports = {
  importCatalog,
  detectCatalogLayout,
  collectFlatProducts,
  scanProductImages,
  parseProductImageFilename,
  parseFlatProductImageFilename,
};
