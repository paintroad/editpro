const fs = require("fs");
const path = require("path");
const os = require("os");
const { scanCatalog, writeExcel } = require("./square-paintings-scanner");

const CONFIG_DIR = path.join(os.homedir(), ".editpro");
const RESULTS_PATH = path.join(CONFIG_DIR, "square-paintings-results.json");
const EXCEL_PATH = path.join(CONFIG_DIR, "square-paintings.xlsx");

function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

function emptyResults() {
  return {
    scannedAt: null,
    catalogPath: null,
    total: 0,
    squareCount: 0,
    nonSquareCount: 0,
    skippedCount: 0,
    squareProducts: [],
    excelAvailable: false,
  };
}

function loadResults() {
  ensureConfigDir();
  if (!fs.existsSync(RESULTS_PATH)) {
    return emptyResults();
  }
  try {
    const raw = JSON.parse(fs.readFileSync(RESULTS_PATH, "utf8"));
    return {
      ...emptyResults(),
      ...raw,
      excelAvailable: fs.existsSync(EXCEL_PATH),
    };
  } catch {
    return emptyResults();
  }
}

function saveResults(results) {
  ensureConfigDir();
  const payload = {
    scannedAt: results.scannedAt,
    catalogPath: results.catalogPath,
    total: results.total,
    squareCount: results.squareCount,
    nonSquareCount: results.nonSquareCount,
    skippedCount: results.skippedCount,
    squareProducts: results.squareProducts,
  };
  fs.writeFileSync(RESULTS_PATH, JSON.stringify(payload, null, 2), "utf8");
}

async function runScan(catalogPath) {
  const normalized = path.normalize(catalogPath.trim());
  if (!fs.existsSync(normalized)) {
    throw new Error("Catalog folder does not exist.");
  }
  if (!fs.statSync(normalized).isDirectory()) {
    throw new Error("Catalog path is not a folder.");
  }

  const scanResult = await scanCatalog(normalized);
  await writeExcel(EXCEL_PATH, scanResult.squareProducts);

  const results = {
    scannedAt: new Date().toISOString(),
    catalogPath: normalized,
    total: scanResult.total,
    squareCount: scanResult.squareProducts.length,
    nonSquareCount: scanResult.nonSquareCount,
    skippedCount: scanResult.skipped.length,
    squareProducts: scanResult.squareProducts.map(({ productId, aspectRatio }) => ({
      productId,
      aspectRatio,
    })),
    excelAvailable: true,
  };

  saveResults(results);
  return results;
}

function getExcelPath() {
  return EXCEL_PATH;
}

function excelExists() {
  return fs.existsSync(EXCEL_PATH);
}

module.exports = {
  CONFIG_DIR,
  RESULTS_PATH,
  EXCEL_PATH,
  loadResults,
  runScan,
  getExcelPath,
  excelExists,
};
