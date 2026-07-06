const express = require("express");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const {
  saveConfig,
  getPublicSettings,
  getShopifyCredentials,
  loadConfig,
  getOpenAiApiKey,
  maskToken,
} = require("./lib/config-store");
const {
  loadSyncLog,
  addSyncLogEntry,
  getSyncLogEntry,
  updateSyncLogEntry,
} = require("./lib/sync-log-store");
const { shopifyGraphql, testConnection } = require("./lib/shopify-client");
const { fetchCatalog, fetchCatalogCounts } = require("./lib/catalog-fetcher");
const {
  loadResults: loadSquareImageResults,
  runScan: runSquareImageScan,
  getExcelPath,
  excelExists,
} = require("./lib/square-paintings-store");
const { enumerateCatalogImages, isPortraitProductImage } = require("./lib/catalog-images");
const { isNoneRoom } = require("./lib/room-utils");
const {
  loadImageRoomMap,
  getRoomForImage,
  hasMappingForImage,
  reconcileImageRoomMap,
} = require("./lib/image-room-store");
const { clearCache, getCacheStats } = require("./lib/image-cache");
const { importCatalog } = require("./lib/catalog-importer");
const {
  loadCatalogStore,
  saveCatalogStore,
  mergeImportResults,
  listProductSummaries,
  getProduct,
  computeLifestyleStats,
} = require("./lib/catalog-products-store");
const { productsToCsv } = require("./lib/catalog-export");
const { buildPreviewChanges, applyChanges } = require("./lib/catalog-seo-fix");
const {
  buildPreviewPlans,
  pushProducts,
  getPushStatus,
} = require("./lib/catalog-shopify-push");
const roomScanRunner = require("./lib/room-scan-runner");
const catalogEnrichRunner = require("./lib/catalog-enrich-runner");
const lifestyleRunner = require("./lib/lifestyle-runner");
const orientationRunner = require("./lib/orientation-runner");
const pythonSetup = require("./lib/python-setup");
const { summarizeFrameTemplates } = require("./lib/frame-template-parser");

const app = express();
const PORT = process.env.PORT || 3847;
const BASE_PATH = (process.env.BASE_PATH || "/editpro").replace(/\/$/, "");
const PUBLIC_DIR = path.join(__dirname, "public");
const router = express.Router();

app.use(express.json({ limit: "10mb" }));

function listFilesInFolder(folderPath) {
  const entries = fs.readdirSync(folderPath, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const fullPath = path.join(folderPath, entry.name);
      const stat = fs.statSync(fullPath);
      return {
        name: entry.name,
        extension: path.extname(entry.name),
        size: stat.size,
        modified: stat.mtime.toISOString(),
      };
    });
}

function sortFiles(files, sortBy) {
  const sorted = [...files];
  switch (sortBy) {
    case "modified-asc":
      sorted.sort((a, b) => new Date(a.modified) - new Date(b.modified));
      break;
    case "modified-desc":
      sorted.sort((a, b) => new Date(b.modified) - new Date(a.modified));
      break;
    case "name-desc":
      sorted.sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }));
      break;
    case "name-asc":
    default:
      sorted.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      break;
  }
  return sorted;
}

function buildRenamePlan(folderPath, options) {
  const {
    startNumber,
    gap = 1,
    padding = 0,
    prefix = "",
    suffix = "",
    sortBy = "name-asc",
  } = options;

  const start = Number(startNumber);
  if (!Number.isInteger(start) || start < 0) {
    throw new Error("Start number must be a non-negative integer.");
  }

  const step = Number(gap);
  if (!Number.isInteger(step) || step < 1) {
    throw new Error("Gap must be a positive integer.");
  }

  const paddingDigits = Number(padding);
  if (!Number.isInteger(paddingDigits) || paddingDigits < 0 || paddingDigits > 10) {
    throw new Error("Padding must be an integer between 0 and 10.");
  }

  const files = sortFiles(listFilesInFolder(folderPath), sortBy);
  const plan = files.map((file, index) => {
    const number = start + index * step;
    const padded = paddingDigits > 0
      ? String(number).padStart(paddingDigits, "0")
      : String(number);
    const newName = `${prefix}${padded}${suffix}${file.extension}`;
    return { oldName: file.name, newName, extension: file.extension };
  });

  const newNames = new Set(plan.map((item) => item.newName.toLowerCase()));
  if (newNames.size !== plan.length) {
    throw new Error("Rename plan would create duplicate file names. Adjust your settings.");
  }

  for (const item of plan) {
    if (item.oldName.toLowerCase() === item.newName.toLowerCase()) {
      continue;
    }
    const targetPath = path.join(folderPath, item.newName);
    if (fs.existsSync(targetPath)) {
      const alreadyPlanned = plan.some(
        (p) => p.oldName.toLowerCase() === item.newName.toLowerCase()
      );
      if (!alreadyPlanned) {
        throw new Error(`Target name already exists: ${item.newName}`);
      }
    }
  }

  return plan;
}

function executeRename(folderPath, plan) {
  const toRename = plan.filter(
    (item) => item.oldName.toLowerCase() !== item.newName.toLowerCase()
  );

  if (toRename.length === 0) {
    return { renamed: 0, skipped: plan.length };
  }

  const tempPrefix = `.__renamer_${Date.now()}_`;
  const tempMoves = [];

  try {
    for (let i = 0; i < toRename.length; i++) {
      const item = toRename[i];
      const tempName = `${tempPrefix}${i}${item.extension}`;
      fs.renameSync(path.join(folderPath, item.oldName), path.join(folderPath, tempName));
      tempMoves.push({ tempPath: path.join(folderPath, tempName), finalName: item.newName });
    }
    for (const move of tempMoves) {
      fs.renameSync(move.tempPath, path.join(folderPath, move.finalName));
    }
    return { renamed: toRename.length, skipped: plan.length - toRename.length };
  } catch (error) {
    for (const move of tempMoves) {
      if (fs.existsSync(move.tempPath)) {
        const original = toRename[tempMoves.indexOf(move)];
        if (original) {
          try {
            fs.renameSync(move.tempPath, path.join(folderPath, original.oldName));
          } catch {
            // Best-effort rollback
          }
        }
      }
    }
    throw error;
  }
}

router.get("/api/settings", (_req, res) => {
  try {
    res.json(getPublicSettings());
  } catch (error) {
    res.status(500).json({ error: error.message || "Failed to load settings." });
  }
});

router.post("/api/settings", (req, res) => {
  try {
    saveConfig(req.body || {});
    res.json(getPublicSettings());
  } catch (error) {
    res.status(400).json({ error: error.message || "Failed to save settings." });
  }
});

router.post("/api/shopify/test", async (_req, res) => {
  try {
    const { storeDomain, accessToken } = getShopifyCredentials();
    const shop = await testConnection(storeDomain, accessToken);
    saveConfig({ shopName: shop.name });
    res.json({ shop });
  } catch (error) {
    res.status(400).json({ error: error.message || "Connection test failed." });
  }
});

router.post("/api/shopify/graphql", async (req, res) => {
  try {
    const { query, variables } = req.body || {};
    if (!query) {
      return res.status(400).json({ error: "GraphQL query is required." });
    }
    const { storeDomain, accessToken } = getShopifyCredentials();
    const data = await shopifyGraphql(storeDomain, accessToken, query, variables || {});
    res.json(data);
  } catch (error) {
    res.status(400).json({ error: error.message || "Shopify request failed." });
  }
});

router.post("/api/shopify/catalog-counts", async (_req, res) => {
  try {
    const { storeDomain, accessToken } = getShopifyCredentials();
    const counts = await fetchCatalogCounts(storeDomain, accessToken);
    res.json(counts);
  } catch (error) {
    res.status(400).json({ error: error.message || "Failed to fetch catalog counts." });
  }
});

router.post("/api/shopify/catalog", async (req, res) => {
  let aborted = false;
  req.on("aborted", () => {
    aborted = true;
  });

  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Accel-Buffering", "no");

  try {
    const { storeDomain, accessToken } = getShopifyCredentials();
    const result = await fetchCatalog(storeDomain, accessToken, {
      shouldAbort: () => aborted,
      onProgress: (progress) => {
        if (!aborted && !res.writableEnded) {
          res.write(`${JSON.stringify({ event: "progress", ...progress })}\n`);
        }
      },
      onPage: (page) => {
        if (!aborted && !res.writableEnded) {
          res.write(`${JSON.stringify({ event: "page", ...page })}\n`);
        }
      },
    });

    if (!aborted && !res.writableEnded) {
      res.write(
        `${JSON.stringify({
          event: "done",
          complete: result.complete !== false,
          warning: result.warning || null,
          counts: {
            products: result.products.length,
            collections: result.collections.length,
            articles: result.articles.length,
          },
        })}\n`
      );
      res.end();
    }
  } catch (error) {
    if (!aborted && !res.writableEnded) {
      res.write(`${JSON.stringify({ event: "error", error: error.message || "Catalog fetch failed." })}\n`);
      res.end();
    }
  }
});

router.get("/api/sync-log", (_req, res) => {
  try {
    res.json({ entries: loadSyncLog() });
  } catch (error) {
    res.status(500).json({ error: error.message || "Failed to load sync log." });
  }
});

router.post("/api/sync-log", (req, res) => {
  try {
    const entry = addSyncLogEntry(req.body || {});
    res.json({ entry });
  } catch (error) {
    res.status(400).json({ error: error.message || "Failed to save sync log entry." });
  }
});

router.patch("/api/sync-log/:id", (req, res) => {
  try {
    const entry = updateSyncLogEntry(req.params.id, req.body || {});
    if (!entry) {
      return res.status(404).json({ error: "Log entry not found." });
    }
    res.json({ entry });
  } catch (error) {
    res.status(400).json({ error: error.message || "Failed to update sync log entry." });
  }
});

router.get("/api/sync-log/:id", (req, res) => {
  try {
    const entry = getSyncLogEntry(req.params.id);
    if (!entry) {
      return res.status(404).json({ error: "Log entry not found." });
    }
    res.json({ entry });
  } catch (error) {
    res.status(500).json({ error: error.message || "Failed to load sync log entry." });
  }
});

router.post("/api/set-folder", (req, res) => {
  try {
    const { folderPath } = req.body;
    if (!folderPath || typeof folderPath !== "string") {
      return res.status(400).json({ error: "Folder path is required." });
    }
    const normalized = path.normalize(folderPath.trim());
    if (!fs.existsSync(normalized)) {
      return res.status(400).json({ error: "Folder does not exist." });
    }
    if (!fs.statSync(normalized).isDirectory()) {
      return res.status(400).json({ error: "Path is not a folder." });
    }
    const files = listFilesInFolder(normalized);
    res.json({ folderPath: normalized, fileCount: files.length, files });
  } catch (error) {
    res.status(500).json({ error: error.message || "Failed to read folder." });
  }
});

router.post("/api/preview", (req, res) => {
  try {
    const { folderPath, startNumber, gap, padding, prefix, suffix, sortBy } = req.body;
    if (!folderPath) {
      return res.status(400).json({ error: "Folder path is required." });
    }
    const plan = buildRenamePlan(folderPath, {
      startNumber,
      gap,
      padding,
      prefix,
      suffix,
      sortBy,
    });
    res.json({ plan, total: plan.length });
  } catch (error) {
    res.status(400).json({ error: error.message || "Failed to build preview." });
  }
});

router.post("/api/rename", (req, res) => {
  try {
    const { folderPath, startNumber, gap, padding, prefix, suffix, sortBy } = req.body;
    if (!folderPath) {
      return res.status(400).json({ error: "Folder path is required." });
    }
    const plan = buildRenamePlan(folderPath, {
      startNumber,
      gap,
      padding,
      prefix,
      suffix,
      sortBy,
    });
    const result = executeRename(folderPath, plan);
    const files = listFilesInFolder(folderPath);
    res.json({ ...result, files, plan });
  } catch (error) {
    res.status(400).json({ error: error.message || "Rename failed." });
  }
});

router.get("/api/square-images", (_req, res) => {
  try {
    res.json(loadSquareImageResults());
  } catch (error) {
    res.status(500).json({ error: error.message || "Failed to load square image results." });
  }
});

router.post("/api/square-images/scan", async (req, res) => {
  try {
    const { catalogPath } = req.body || {};
    if (!catalogPath || typeof catalogPath !== "string") {
      return res.status(400).json({ error: "Catalog path is required." });
    }
    const results = await runSquareImageScan(catalogPath);
    res.json(results);
  } catch (error) {
    res.status(400).json({ error: error.message || "Square image scan failed." });
  }
});

router.get("/api/square-images/download", (_req, res) => {
  try {
    if (!excelExists()) {
      return res.status(404).json({ error: "No Excel file available. Run a scan first." });
    }
    res.download(getExcelPath(), "square-paintings.xlsx");
  } catch (error) {
    res.status(500).json({ error: error.message || "Failed to download Excel file." });
  }
});

router.get("/api/image-room-map", (_req, res) => {
  try {
    const store = loadImageRoomMap();
    res.json({
      version: store.version,
      mappings: store.mappings,
      updatedAt: store.updatedAt,
      count: Object.keys(store.mappings).length,
    });
  } catch (error) {
    res.status(500).json({ error: error.message || "Failed to load image room map." });
  }
});

router.post("/api/image-room-map/reconcile", (req, res) => {
  try {
    const storeData = req.body?.storeData || {};
    const result = reconcileImageRoomMap(storeData);
    const store = loadImageRoomMap();
    res.json({
      ...result,
      mappings: store.mappings,
      updatedAt: store.updatedAt,
    });
  } catch (error) {
    res.status(400).json({ error: error.message || "Failed to reconcile image room map." });
  }
});

router.post("/api/image-room-map/summary", (req, res) => {
  try {
    const storeData = req.body?.storeData || {};
    const images = enumerateCatalogImages(storeData);
    const store = loadImageRoomMap();
    const portraits = images.filter((img) => isPortraitProductImage(img)).length;
    const lifestyleImages = images.filter((img) => !isPortraitProductImage(img));
    const rows = lifestyleImages.map((img) => {
      const room = getRoomForImage(img, store);
      const hasMapping = hasMappingForImage(img, store);
      const mapped = hasMapping && !isNoneRoom(room);
      return {
        ...img,
        room,
        mapped,
        hasMapping,
      };
    });
    const lifestyleMapped = rows.filter((r) => r.mapped).length;
    const scannable = lifestyleImages.length;
    const unmapped = scannable - lifestyleMapped;
    res.json({
      total: images.length,
      portraits,
      scannable,
      lifestyleMapped,
      mapped: portraits + lifestyleMapped,
      unmapped,
      complete: scannable > 0 ? unmapped === 0 : portraits > 0,
      rows,
    });
  } catch (error) {
    res.status(400).json({ error: error.message || "Failed to summarize image room map." });
  }
});

router.post("/api/image-room-map/scan/start", async (_req, res) => {
  try {
    const status = roomScanRunner.getStatus();
    if (status.state === "running" || status.state === "paused") {
      return res.status(409).json({ error: "A room mapping job is already running.", ...status });
    }
    const result = await roomScanRunner.start();
    res.status(202).json(result);
  } catch (error) {
    res.status(400).json({ error: error.message || "Failed to start room mapping." });
  }
});

router.get("/api/image-room-map/scan/status", (_req, res) => {
  try {
    res.json(roomScanRunner.getStatus());
  } catch (error) {
    res.status(500).json({ error: error.message || "Failed to read scan status." });
  }
});

router.post("/api/image-room-map/scan/stop", (_req, res) => {
  try {
    res.json(roomScanRunner.stop());
  } catch (error) {
    res.status(400).json({ error: error.message || "Failed to stop room mapping." });
  }
});

router.post("/api/image-room-map/cache/clear", (_req, res) => {
  try {
    const stats = clearCache();
    res.json({ message: "Image cache cleared.", ...stats });
  } catch (error) {
    res.status(500).json({ error: error.message || "Failed to clear image cache." });
  }
});

router.get("/api/image-room-map/cache/stats", (_req, res) => {
  try {
    res.json(getCacheStats());
  } catch (error) {
    res.status(500).json({ error: error.message || "Failed to read cache stats." });
  }
});

router.post("/api/image-room-map/scan", async (_req, res) => {
  res.status(410).json({
    error: "This endpoint is deprecated. Use POST /api/image-room-map/scan/start instead.",
  });
});

router.get("/api/openai/status", (_req, res) => {
  try {
    const apiKey = getOpenAiApiKey();
    res.json({
      configured: Boolean(apiKey),
      apiKeyMasked: maskToken(apiKey),
    });
  } catch (error) {
    res.status(400).json({ error: error.message || "Failed to check OpenAI status." });
  }
});

router.get("/api/catalog/products", (_req, res) => {
  try {
    const store = loadCatalogStore();
    const products = listProductSummaries(store);
    const enriched = products.filter((p) => p.status === "enriched").length;
    const pending = products.filter((p) => p.status === "imported").length;
    const errors = products.filter((p) => p.status === "error").length;
    res.json({
      catalogPath: store.catalogPath,
      lastImportAt: store.lastImportAt,
      total: products.length,
      enriched,
      pending,
      errors,
      lifestyleStats: computeLifestyleStats(store),
      lifestyleSettings: store.lifestyleSettings || null,
      products,
    });
  } catch (error) {
    res.status(500).json({ error: error.message || "Failed to list catalog products." });
  }
});

router.get("/api/catalog/products/:productId", (req, res) => {
  try {
    const product = getProduct(req.params.productId);
    if (!product) {
      return res.status(404).json({ error: "Product not found." });
    }
    res.json(product);
  } catch (error) {
    res.status(500).json({ error: error.message || "Failed to load product." });
  }
});

router.get("/api/catalog/products/:productId/image/:index", (req, res) => {
  try {
    const product = getProduct(req.params.productId);
    if (!product) {
      return res.status(404).json({ error: "Product not found." });
    }
    const imageIndex = parseInt(req.params.index, 10);
    const image = product.images?.find((img) => img.index === imageIndex);
    if (!image?.path || !fs.existsSync(image.path)) {
      return res.status(404).json({ error: "Image not found." });
    }
    res.sendFile(path.resolve(image.path));
  } catch (error) {
    res.status(500).json({ error: error.message || "Failed to serve image." });
  }
});

router.get("/api/catalog/products/:productId/lifestyle/:index", (req, res) => {
  try {
    const product = getProduct(req.params.productId);
    if (!product) {
      return res.status(404).json({ error: "Product not found." });
    }
    const imageIndex = parseInt(req.params.index, 10);
    const image = product.lifestyleImages?.find((img) => img.index === imageIndex);
    if (!image?.path || !fs.existsSync(image.path)) {
      return res.status(404).json({ error: "Lifestyle image not found." });
    }
    res.sendFile(path.resolve(image.path));
  } catch (error) {
    res.status(500).json({ error: error.message || "Failed to serve lifestyle image." });
  }
});

router.get("/api/catalog/lifestyle/preflight", (_req, res) => {
  try {
    res.json(pythonSetup.getPreflightStatus());
  } catch (error) {
    res.status(500).json({ error: error.message || "Failed to check Python environment." });
  }
});

router.post("/api/catalog/lifestyle/setup", async (_req, res) => {
  try {
    const result = await pythonSetup.runSetup();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message || "Python setup failed." });
  }
});

router.post("/api/catalog/lifestyle/validate-frames", (req, res) => {
  try {
    const { frameTemplatesPath } = req.body || {};
    res.json(summarizeFrameTemplates(frameTemplatesPath));
  } catch (error) {
    res.status(400).json({ error: error.message || "Failed to validate frame templates." });
  }
});

router.post("/api/catalog/lifestyle/start", async (req, res) => {
  try {
    const { productIds, frameTemplatesPath, outputPath } = req.body || {};
    if (!Array.isArray(productIds) || !productIds.length) {
      return res.status(400).json({ error: "Select at least one product." });
    }
    const ids = productIds.map((id) => String(id || "").trim()).filter(Boolean);
    const result = await lifestyleRunner.start({
      productIds: ids,
      frameTemplatesPath,
      outputPath,
    });
    res.status(202).json(result);
  } catch (error) {
    res.status(400).json({ error: error.message || "Failed to start lifestyle generation." });
  }
});

router.get("/api/catalog/lifestyle/status", (_req, res) => {
  try {
    res.json(lifestyleRunner.getStatus());
  } catch (error) {
    res.status(500).json({ error: error.message || "Failed to read lifestyle status." });
  }
});

router.post("/api/catalog/lifestyle/stop", (_req, res) => {
  try {
    res.json(lifestyleRunner.stop());
  } catch (error) {
    res.status(400).json({ error: error.message || "Failed to stop lifestyle generation." });
  }
});

router.post("/api/catalog/orientation/start", async (req, res) => {
  try {
    const { productIds } = req.body || {};
    let ids = null;
    if (productIds != null) {
      if (!Array.isArray(productIds)) {
        return res.status(400).json({ error: "productIds must be an array of product IDs." });
      }
      ids = productIds.map((id) => String(id || "").trim()).filter(Boolean);
    }
    const result = await orientationRunner.start({ productIds: ids });
    res.status(202).json(result);
  } catch (error) {
    res.status(400).json({ error: error.message || "Failed to start orientation detection." });
  }
});

router.get("/api/catalog/orientation/status", (_req, res) => {
  try {
    res.json(orientationRunner.getStatus());
  } catch (error) {
    res.status(500).json({ error: error.message || "Failed to read orientation status." });
  }
});

router.post("/api/catalog/orientation/stop", (_req, res) => {
  try {
    res.json(orientationRunner.stop());
  } catch (error) {
    res.status(400).json({ error: error.message || "Failed to stop orientation detection." });
  }
});

router.post("/api/catalog/import", async (req, res) => {
  try {
    const { catalogPath } = req.body || {};
    if (!catalogPath || typeof catalogPath !== "string") {
      return res.status(400).json({ error: "Catalog path is required." });
    }
    const importResult = await importCatalog(catalogPath);
    const store = loadCatalogStore();
    const mergeStats = mergeImportResults(store, importResult);
    saveCatalogStore(store);
    if (mergeStats.orientationProductIds?.length) {
      orientationRunner
        .start({ productIds: mergeStats.orientationProductIds })
        .catch(() => {});
    }
    res.json({
      ...mergeStats,
      catalogPath: store.catalogPath,
      lastImportAt: store.lastImportAt,
      imported: importResult.products.length,
      totalFolders: importResult.total,
      skipped: importResult.skipped,
      lifestyleStats: computeLifestyleStats(store),
      lifestyleSettings: store.lifestyleSettings || null,
      products: listProductSummaries(store),
    });
  } catch (error) {
    res.status(400).json({ error: error.message || "Catalog import failed." });
  }
});

router.post("/api/catalog/enrich/start", async (req, res) => {
  try {
    const { productIds } = req.body || {};
    let ids = null;
    if (productIds != null) {
      if (!Array.isArray(productIds)) {
        return res.status(400).json({ error: "productIds must be an array of product IDs." });
      }
      ids = productIds.map((id) => String(id || "").trim()).filter(Boolean);
      if (!ids.length) {
        return res.status(400).json({ error: "Select at least one product to generate." });
      }
    }
    const result = await catalogEnrichRunner.start({ productIds: ids });
    res.status(202).json(result);
  } catch (error) {
    res.status(400).json({ error: error.message || "Failed to start catalog enrichment." });
  }
});

router.get("/api/catalog/enrich/status", (_req, res) => {
  try {
    res.json(catalogEnrichRunner.getStatus());
  } catch (error) {
    res.status(500).json({ error: error.message || "Failed to read enrich status." });
  }
});

router.post("/api/catalog/enrich/stop", (_req, res) => {
  try {
    res.json(catalogEnrichRunner.stop());
  } catch (error) {
    res.status(400).json({ error: error.message || "Failed to stop catalog enrichment." });
  }
});

router.get("/api/catalog/export", (_req, res) => {
  try {
    const store = loadCatalogStore();
    const products = Object.values(store.products).filter((p) => p.status === "enriched");
    if (!products.length) {
      return res.status(404).json({ error: "No enriched products to export." });
    }
    const csv = productsToCsv(products);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="catalog-products.csv"');
    res.send(csv);
  } catch (error) {
    res.status(500).json({ error: error.message || "Failed to export catalog." });
  }
});

router.post("/api/catalog/fix-seo/preview", (req, res) => {
  try {
    const productIds = Array.isArray(req.body?.productIds) ? req.body.productIds : [];
    if (!productIds.length) {
      return res.status(400).json({ error: "productIds is required." });
    }
    const changes = buildPreviewChanges(productIds);
    res.json({ changes, count: changes.length });
  } catch (error) {
    res.status(500).json({ error: error.message || "Failed to build SEO preview." });
  }
});

router.post("/api/catalog/fix-seo/apply", (req, res) => {
  try {
    const changes = Array.isArray(req.body?.changes) ? req.body.changes : [];
    if (!changes.length) {
      return res.status(400).json({ error: "changes is required." });
    }
    const result = applyChanges(changes);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message || "Failed to apply SEO fixes." });
  }
});

router.post("/api/catalog/shopify/preview", async (req, res) => {
  try {
    const productIds = Array.isArray(req.body?.productIds) ? req.body.productIds : [];
    if (!productIds.length) {
      return res.status(400).json({ error: "productIds is required." });
    }
    const plans = await buildPreviewPlans(productIds);
    res.json({ changes: plans, count: plans.length });
  } catch (error) {
    res.status(500).json({ error: error.message || "Failed to build Shopify preview." });
  }
});

router.post("/api/catalog/shopify/push", async (req, res) => {
  try {
    const productIds = Array.isArray(req.body?.productIds) ? req.body.productIds : [];
    if (!productIds.length) {
      return res.status(400).json({ error: "productIds is required." });
    }
    const result = await pushProducts(productIds);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message || "Failed to push products to Shopify." });
  }
});

router.get("/api/catalog/shopify/status", (_req, res) => {
  try {
    res.json(getPushStatus());
  } catch (error) {
    res.status(500).json({ error: error.message || "Failed to read push status." });
  }
});

router.get("/api/health", (_req, res) => {
  res.json({ ok: true, basePath: BASE_PATH });
});

router.use(express.static(PUBLIC_DIR));
router.get("/", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

app.use(BASE_PATH, router);
app.get("/", (_req, res) => {
  res.redirect(`${BASE_PATH}/`);
});

app.listen(PORT, () => {
  const directUrl = `http://localhost:${PORT}${BASE_PATH}/`;
  const proxyUrl = `http://localhost${BASE_PATH}/`;
  console.log(`EditPro running at ${directUrl}`);
  console.log(`With port-80 proxy: ${proxyUrl}`);
  console.log("Press Ctrl+C to stop.");

  if (process.platform === "win32") {
    try {
      execFileSync("cmd", ["/c", "start", "", directUrl], { windowsHide: true });
    } catch {
      console.log(`Open ${directUrl} in your browser.`);
    }
  }

  orientationRunner.startMissing().catch(() => {});
});
