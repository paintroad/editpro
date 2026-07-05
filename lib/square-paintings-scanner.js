const fs = require("fs/promises");
const path = require("path");
const sharp = require("sharp");
const ExcelJS = require("exceljs");

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const DARK_THRESHOLD = 70;
const SQUARE_MIN_RATIO = 0.9;
const SQUARE_MAX_RATIO = 1.1;

function luminance(r, g, b) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

async function detectPaintingAspectRatio(imagePath) {
  const { data, info } = await sharp(imagePath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let darkCount = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const lum = luminance(r, g, b);

      if (lum < DARK_THRESHOLD) {
        darkCount++;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (darkCount === 0 || maxX < minX || maxY < minY) {
    return { aspectRatio: null, method: "none", box: null };
  }

  const boxWidth = maxX - minX + 1;
  const boxHeight = maxY - minY + 1;
  const aspectRatio = boxWidth / boxHeight;

  return {
    aspectRatio,
    method: "black-frame",
    box: { minX, minY, maxX, maxY, width: boxWidth, height: boxHeight },
  };
}

function isSquarePainting(aspectRatio) {
  if (aspectRatio == null || !Number.isFinite(aspectRatio)) return false;
  return aspectRatio >= SQUARE_MIN_RATIO && aspectRatio <= SQUARE_MAX_RATIO;
}

function isImageFile(name) {
  return IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase());
}

function pickFirstImage(files) {
  const images = files
    .filter(isImageFile)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return images[0] ?? null;
}

async function collectProductFolders(catalogRoot) {
  const productFolders = [];
  const topEntries = await fs.readdir(catalogRoot, { withFileTypes: true });

  for (const entry of topEntries) {
    if (!entry.isDirectory()) continue;
    const rangePath = path.join(catalogRoot, entry.name);
    const productEntries = await fs.readdir(rangePath, { withFileTypes: true });

    for (const productEntry of productEntries) {
      if (!productEntry.isDirectory()) continue;
      productFolders.push({
        productId: productEntry.name,
        folderPath: path.join(rangePath, productEntry.name),
      });
    }
  }

  productFolders.sort((a, b) =>
    a.productId.localeCompare(b.productId, undefined, { numeric: true }),
  );
  return productFolders;
}

async function scanCatalog(catalogRoot) {
  const folders = await collectProductFolders(catalogRoot);
  const squareProducts = [];
  const nonSquareProducts = [];
  const skipped = [];

  for (const { productId, folderPath } of folders) {
    const files = await fs.readdir(folderPath);
    const firstImage = pickFirstImage(files);

    if (!firstImage) {
      skipped.push({ productId, reason: "no image files" });
      continue;
    }

    const imagePath = path.join(folderPath, firstImage);
    const { aspectRatio, method } = await detectPaintingAspectRatio(imagePath);

    if (aspectRatio == null) {
      skipped.push({ productId, reason: "could not detect frame", image: firstImage });
      continue;
    }

    const record = {
      productId,
      aspectRatio: Math.round(aspectRatio * 1000) / 1000,
      image: firstImage,
      method,
    };
    if (isSquarePainting(aspectRatio)) {
      squareProducts.push(record);
    } else {
      nonSquareProducts.push(record);
    }
  }

  return {
    total: folders.length,
    squareProducts,
    nonSquareCount: nonSquareProducts.length,
    skipped,
  };
}

async function writeExcel(outputPath, squareProducts) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Square Paintings");

  sheet.columns = [{ header: "Product ID", key: "productId", width: 16 }];
  sheet.getRow(1).font = { bold: true };

  for (const { productId } of squareProducts) {
    sheet.addRow({ productId });
  }

  await workbook.xlsx.writeFile(outputPath);
}

module.exports = {
  detectPaintingAspectRatio,
  isSquarePainting,
  scanCatalog,
  writeExcel,
};
