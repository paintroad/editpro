const os = require("os");
const path = require("path");

const DOCUMENTS_DIR = path.join(os.homedir(), "OneDrive", "Documents");
const CATALOG_ROOT = path.join(DOCUMENTS_DIR, "Paintroad", "Catalog");
const DEFAULT_CATALOG_PATH = path.join(CATALOG_ROOT, "Optimised Catalog");
const DEFAULT_CATALOG_BUILDER_PATH =
  "C:\\Paintroad\\Files\\Prints_Optimized_Only_New";

module.exports = {
  DOCUMENTS_DIR,
  CATALOG_ROOT,
  DEFAULT_CATALOG_PATH,
  DEFAULT_CATALOG_BUILDER_PATH,
};
