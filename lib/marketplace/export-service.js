const fs = require("fs");
const path = require("path");
const os = require("os");
const { getMarketplace } = require("./registry");
const { normalizeProducts, expandVariantRows } = require("./product-normalizer");
const { fetchProductsForExport } = require("./shopify-export-fetcher");
const { filterProductsForExport, filterByProductHandles, exclusionWarning } = require("./export-filters");
const { loadRoomByHandle, loadRoomsByHandle } = require("./marketplace-config");
const { loadCatalogStore } = require("../catalog-products-store");
const { getShopifyCredentials } = require("../config-store");
const {
  readWorkbook,
  sheetToRows,
  readCsvRows,
  writeCsvRows,
  writeWorkbook,
} = require("./excel-io");

const EXPORT_DIR = path.join(os.homedir(), ".editpro", "marketplace-exports");
const DEFAULT_TEMPLATE_DIR = path.join(
  os.homedir(),
  "Downloads",
  "Marketplace",
  "Templates"
);

const recentExports = new Map();

const SPLIT_LIMITS = {
  amazon: { maxRows: 10000, maxBytes: 150 * 1024 * 1024 },
  flipkart: { maxRows: 4500, maxBytes: 150 * 1024 * 1024 },
  pinterest: { maxRows: Infinity, maxBytes: Infinity },
};

const DEFAULT_SPLIT_LIMITS = { maxRows: Infinity, maxBytes: Infinity };

function dateStamp() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function createExportFolder(targetDir, adapterId) {
  const date = dateStamp();
  const baseName = `${adapterId}-newproducts-${date}`;
  let folderName = baseName;
  let suffix = 1;
  let folderPath = path.join(targetDir, folderName);

  while (fs.existsSync(folderPath)) {
    suffix += 1;
    folderName = `${baseName}-${suffix}`;
    folderPath = path.join(targetDir, folderName);
  }

  fs.mkdirSync(folderPath, { recursive: true });
  return { folderPath, folderName, baseName };
}

function writeSplitParts({
  preserved,
  dataRows,
  allSheets,
  sheetName,
  folderPath,
  baseName,
  ext,
  format,
  bookType,
  limits,
}) {
  const parts = [];
  const preservedCount = preserved.length;
  const maxDataPerPart =
    limits.maxRows === Infinity ? dataRows.length : Math.max(1, limits.maxRows - preservedCount);

  let chunkSize = maxDataPerPart;
  let offset = 0;
  let partIndex = 1;

  while (offset < dataRows.length) {
    const chunk = dataRows.slice(offset, offset + chunkSize);
    const fileName = `${baseName}-${partIndex}${ext}`;
    const filePath = path.join(folderPath, fileName);

    if (format === "csv") {
      writeCsvRows([...preserved, ...chunk], filePath);
    } else {
      const rowsBySheet = allSheets ? { ...allSheets } : {};
      rowsBySheet[sheetName] = [...preserved, ...chunk];
      writeWorkbook(rowsBySheet, filePath, bookType);
    }

    const sizeBytes = fs.statSync(filePath).size;
    if (sizeBytes > limits.maxBytes) {
      if (chunk.length <= 1) {
        fs.unlinkSync(filePath);
        throw new Error(
          `Export part exceeds ${Math.round(limits.maxBytes / (1024 * 1024))}MB limit even with a single row.`
        );
      }
      fs.unlinkSync(filePath);
      chunkSize = Math.max(1, Math.floor(chunkSize / 2));
      continue;
    }

    recentExports.set(fileName, filePath);
    parts.push({ fileName, path: filePath, rowCount: chunk.length, sizeBytes });
    offset += chunk.length;
    partIndex += 1;
  }

  return parts;
}

function ensureExportDir() {
  if (!fs.existsSync(EXPORT_DIR)) {
    fs.mkdirSync(EXPORT_DIR, { recursive: true });
  }
}

function resolveOutputDir(outputDir) {
  const trimmed = String(outputDir || "").trim();
  if (!trimmed) {
    ensureExportDir();
    return EXPORT_DIR;
  }
  const normalized = path.normalize(trimmed);
  try {
    fs.mkdirSync(normalized, { recursive: true });
  } catch (error) {
    throw new Error(`Cannot use download folder: ${error.message}`);
  }
  if (!fs.statSync(normalized).isDirectory()) {
    throw new Error(`Download path is not a folder: ${normalized}`);
  }
  return normalized;
}

function resolveSamplePath(samplePath) {
  const normalized = path.normalize(String(samplePath || "").trim());
  if (!normalized) {
    throw new Error("Sample file path is required.");
  }
  if (!fs.existsSync(normalized)) {
    throw new Error(`Sample file not found: ${normalized}`);
  }
  return normalized;
}

function defaultSamplePath(adapter) {
  const candidate = path.join(DEFAULT_TEMPLATE_DIR, adapter.defaultSampleName);
  return fs.existsSync(candidate) ? candidate : "";
}

function loadSampleRows(samplePath, adapter) {
  const ext = path.extname(samplePath).toLowerCase();
  if (ext === ".csv") {
    return { rows: readCsvRows(samplePath), sheetName: null, allSheets: null };
  }

  const workbook = readWorkbook(samplePath);
  const sheetName = adapter.sheetName || workbook.SheetNames[0];
  const { rows } = sheetToRows(workbook, sheetName);
  const allSheets = {};
  for (const name of workbook.SheetNames) {
    allSheets[name] = sheetToRows(workbook, name).rows;
  }
  return { rows, sheetName, allSheets };
}

async function loadSourceProducts(source, { shopifyProductFilter = "all" } = {}) {
  if (source === "shopify") {
    const { storeDomain, accessToken } = getShopifyCredentials();
    const { products, ctx, productFilter } = await fetchProductsForExport(storeDomain, accessToken, {
      productFilter: shopifyProductFilter,
    });
    return {
      rawProducts: products,
      ctx: {
        ...ctx,
        source: "shopify",
        shopifyProductFilter: productFilter,
      },
    };
  }

  if (source === "catalog") {
    const store = loadCatalogStore();
    const products = Object.values(store.products || {});
    return {
      rawProducts: products,
      ctx: {
        source: "catalog",
        storeDomain: "",
        shopName: "",
        currencyCode: "INR",
      },
    };
  }

  throw new Error('source must be "shopify" or "catalog".');
}

function applyExportFilters(rawProducts, source, productHandles) {
  const { products: afterExclusion, excluded } = filterProductsForExport(rawProducts, source);
  const products = filterByProductHandles(afterExclusion, source, productHandles);
  return { products, excludedProducts: excluded };
}

function outputExtension(adapter, samplePath) {
  if (adapter.format === "csv") {
    return ".csv";
  }
  const sampleExt = path.extname(samplePath).toLowerCase();
  if (adapter.id === "amazon") {
    return ".xlsx";
  }
  if (sampleExt === ".xls") {
    return ".xls";
  }
  return ".xlsx";
}

function countEmptyMappedFields(adapter, sampleRows, variantRows, ctx) {
  const headers = adapter.inspect(sampleRows).headers || [];
  const emptyCounts = {};
  for (const header of headers) {
    emptyCounts[header] = 0;
  }

  for (const entry of variantRows) {
    const mapped = adapter.mapRow(entry, ctx);
    for (const header of headers) {
      const value = mapped[header];
      if (value == null || value === "" || (Array.isArray(value) && !value.length)) {
        emptyCounts[header] += 1;
      }
    }
  }

  const frequentlyEmpty = Object.entries(emptyCounts)
    .filter(([, count]) => count > 0 && variantRows.length && count === variantRows.length)
    .map(([header]) => header)
    .slice(0, 12);

  return frequentlyEmpty;
}

async function inspectMarketplace({
  marketplaceId,
  samplePath,
  source = "shopify",
  shopifyProductFilter = "all",
  productHandles,
}) {
  const adapter = getMarketplace(marketplaceId);
  const resolvedSamplePath = resolveSamplePath(samplePath || defaultSamplePath(adapter));
  const { rows } = loadSampleRows(resolvedSamplePath, adapter);
  const meta = adapter.inspect(rows);
  const { rawProducts, ctx } = await loadSourceProducts(source, { shopifyProductFilter });
  const { products: filteredProducts, excludedProducts } = applyExportFilters(
    rawProducts,
    source,
    productHandles
  );
  const normalized = normalizeProducts(filteredProducts, source, ctx);
  const variantRows = expandVariantRows(normalized);

  return {
    marketplace: adapter.id,
    name: adapter.name,
    format: adapter.format,
    samplePath: resolvedSamplePath,
    source,
    shopifyProductFilter: source === "shopify" ? ctx.shopifyProductFilter || shopifyProductFilter : null,
    productHandles: Array.isArray(productHandles) ? productHandles : null,
    productCount: normalized.length,
    variantCount: variantRows.length,
    excludedProducts,
    excludedCount: excludedProducts.length,
    columnCount: meta.columnCount,
    headers: meta.headers,
    dataStartRow: meta.dataStartRow,
    sheetName: meta.sheetName || adapter.sheetName || null,
    notes: adapter.notes,
    warnings: buildWarnings(source, normalized, excludedProducts),
    frequentlyEmptyColumns: countEmptyMappedFields(adapter, rows, variantRows.slice(0, 5), {
      ...ctx,
      currencyCode: ctx.currencyCode || adapter.defaultCurrency,
      roomByHandle: loadRoomByHandle(),
      roomsByHandle: loadRoomsByHandle(),
    }),
  };
}

function buildWarnings(source, products, excludedProducts = []) {
  const warnings = [];
  const exclusionMsg = exclusionWarning(excludedProducts);
  if (exclusionMsg) {
    warnings.push(exclusionMsg);
  }
  if (source === "catalog") {
    const withoutImages = products.filter((p) => !(p.imageUrls || []).length).length;
    if (withoutImages) {
      warnings.push(
        `${withoutImages} catalog product(s) have no public image URLs. Image columns will be blank unless products were pushed to Shopify.`
      );
    }
  }
  return warnings;
}

async function exportMarketplace({
  marketplaceId,
  samplePath,
  source = "shopify",
  outputDir,
  shopifyProductFilter = "all",
  productHandles,
}) {
  const adapter = getMarketplace(marketplaceId);
  const resolvedSamplePath = resolveSamplePath(samplePath || defaultSamplePath(adapter));
  const { rows, sheetName, allSheets } = loadSampleRows(resolvedSamplePath, adapter);
  const { rawProducts, ctx } = await loadSourceProducts(source, { shopifyProductFilter });
  const { products: filteredProducts, excludedProducts } = applyExportFilters(
    rawProducts,
    source,
    productHandles
  );
  const normalized = normalizeProducts(filteredProducts, source, ctx);
  const variantRows = expandVariantRows(normalized);

  if (!variantRows.length) {
    throw new Error("No products available to export for the selected source.");
  }

  const exportCtx = {
    ...ctx,
    currencyCode: ctx.currencyCode || adapter.defaultCurrency,
    roomByHandle: loadRoomByHandle(),
    roomsByHandle: loadRoomsByHandle(),
  };

  const builtRows = adapter.buildRows(rows, variantRows, exportCtx);
  const meta = adapter.inspect(rows);
  const dataStartRow = meta.dataStartRow || 1;
  const preserved = builtRows.slice(0, dataStartRow - 1);
  const dataRows = builtRows.slice(dataStartRow - 1);

  const targetDir = resolveOutputDir(outputDir);
  const { folderPath, folderName, baseName } = createExportFolder(targetDir, adapter.id);
  const ext = outputExtension(adapter, resolvedSamplePath);
  const bookType = ext === ".xls" ? "biff8" : "xlsx";
  const limits = SPLIT_LIMITS[adapter.id] || DEFAULT_SPLIT_LIMITS;

  const parts = writeSplitParts({
    preserved,
    dataRows,
    allSheets,
    sheetName: sheetName || adapter.sheetName,
    folderPath,
    baseName,
    ext,
    format: adapter.format,
    bookType,
    limits,
  });

  const warnings = buildWarnings(source, normalized, excludedProducts);
  const frequentlyEmptyColumns = countEmptyMappedFields(adapter, rows, variantRows, exportCtx);

  return {
    marketplace: adapter.id,
    name: adapter.name,
    source,
    shopifyProductFilter: source === "shopify" ? ctx.shopifyProductFilter || shopifyProductFilter : null,
    productHandles: Array.isArray(productHandles) ? productHandles : null,
    productCount: normalized.length,
    variantCount: variantRows.length,
    excludedProducts,
    excludedCount: excludedProducts.length,
    folderName,
    savedDir: folderPath,
    partCount: parts.length,
    parts: parts.map((part) => ({
      fileName: part.fileName,
      rowCount: part.rowCount,
      sizeBytes: part.sizeBytes,
    })),
    warnings,
    frequentlyEmptyColumns,
    notes: adapter.notes,
  };
}

function getExportFilePath(fileName) {
  const safeName = path.basename(fileName);
  const tracked = recentExports.get(safeName);
  if (tracked && fs.existsSync(tracked)) {
    return tracked;
  }
  const fullPath = path.join(EXPORT_DIR, safeName);
  if (!fs.existsSync(fullPath)) {
    throw new Error("Export file not found.");
  }
  return fullPath;
}

module.exports = {
  EXPORT_DIR,
  DEFAULT_TEMPLATE_DIR,
  defaultSamplePath,
  listMarketplaces: () => require("./registry").listMarketplaces(),
  inspectMarketplace,
  exportMarketplace,
  getExportFilePath,
};
