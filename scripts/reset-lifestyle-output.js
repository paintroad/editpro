#!/usr/bin/env node
/**
 * Reset lifestyle output folders and catalog state.
 *
 * Frame reference note:
 * - Grey frames (_Frame References) are required at runtime for compositing.
 * - Green quad refs (_Frame_References_Quads) are calibration-only; quads live in frame-quads.json.
 *
 * Usage:
 *   node scripts/reset-lifestyle-output.js --keep 11525,11526
 *   node scripts/reset-lifestyle-output.js --keep 11525,11526 --dry-run
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

const STORE_PATH = path.join(os.homedir(), ".editpro", "catalog-products.json");

function parseArgs(argv) {
  const options = { keep: new Set(), dryRun: false };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--keep" && argv[i + 1]) {
      for (const id of String(argv[i + 1]).split(",")) {
        const trimmed = id.trim();
        if (trimmed) {
          options.keep.add(trimmed);
        }
      }
      i += 1;
    }
  }
  return options;
}

function loadStore() {
  if (!fs.existsSync(STORE_PATH)) {
    throw new Error(`Catalog store not found: ${STORE_PATH}`);
  }
  return JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
}

function saveStore(store) {
  fs.writeFileSync(STORE_PATH, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

function clearLifestyleFields(product) {
  product.lifestyleImages = [];
  product.lifestyleStatus = "none";
  product.lifestyleError = null;
  product.lifestyleGeneratedAt = null;
}

function listOutputSubdirs(outputPath) {
  if (!fs.existsSync(outputPath)) {
    return [];
  }
  return fs
    .readdirSync(outputPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

function removeDir(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
}

function main() {
  const { keep, dryRun } = parseArgs(process.argv);
  if (!keep.size) {
    console.error("Error: --keep is required (e.g. --keep 11525,11526)");
    process.exit(1);
  }

  const store = loadStore();
  const outputPath = String(store.lifestyleSettings?.outputPath || "").trim();
  if (!outputPath) {
    throw new Error("lifestyleSettings.outputPath is not set in catalog store.");
  }

  const subdirs = listOutputSubdirs(outputPath);
  const foldersToDelete = subdirs.filter((name) => !keep.has(name));
  const productsToReset = [];
  const productsKept = [];

  for (const [productId, product] of Object.entries(store.products || {})) {
    const hasLifestyle =
      (product.lifestyleImages?.length || 0) > 0 ||
      product.lifestyleStatus === "generated" ||
      product.lifestyleStatus === "error" ||
      product.lifestyleGeneratedAt ||
      product.lifestyleError;

    if (!hasLifestyle) {
      continue;
    }

    if (keep.has(productId)) {
      productsKept.push({
        productId,
        imageCount: product.lifestyleImages?.length || 0,
        status: product.lifestyleStatus,
      });
      continue;
    }

    productsToReset.push({
      productId,
      imageCount: product.lifestyleImages?.length || 0,
      status: product.lifestyleStatus,
    });
  }

  console.log(`Output path: ${outputPath}`);
  console.log(`Keep folders/products: ${[...keep].sort().join(", ")}`);
  console.log(`Folders to delete (${foldersToDelete.length}):`);
  for (const name of foldersToDelete.sort()) {
    console.log(`  - ${name}`);
  }
  console.log(`Products to reset (${productsToReset.length}):`);
  for (const item of productsToReset.sort((a, b) => a.productId.localeCompare(b.productId))) {
    console.log(`  - ${item.productId} (${item.imageCount} images, was ${item.status})`);
  }
  console.log(`Products kept (${productsKept.length}):`);
  for (const item of productsKept.sort((a, b) => a.productId.localeCompare(b.productId))) {
    console.log(`  - ${item.productId} (${item.imageCount} images, ${item.status})`);
  }

  if (dryRun) {
    console.log("\nDry run — no changes made.");
    return;
  }

  for (const name of foldersToDelete) {
    removeDir(path.join(outputPath, name));
  }

  for (const item of productsToReset) {
    clearLifestyleFields(store.products[item.productId]);
  }

  saveStore(store);

  const remaining = listOutputSubdirs(outputPath);
  const missingKeep = [...keep].filter((name) => !remaining.includes(name));
  if (missingKeep.length) {
    console.warn(`Warning: expected keep folders missing after run: ${missingKeep.join(", ")}`);
  }

  console.log("\nDone.");
  console.log(`Deleted ${foldersToDelete.length} folder(s).`);
  console.log(`Reset ${productsToReset.length} product(s) in ${STORE_PATH}.`);
  console.log(`Remaining folders (${remaining.length}): ${remaining.sort().join(", ") || "(none)"}`);
}

try {
  main();
} catch (error) {
  console.error(error.message || error);
  process.exit(1);
}
