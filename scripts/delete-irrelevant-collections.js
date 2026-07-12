#!/usr/bin/env node
/**
 * Delete irrelevant collection images from a folder.
 *
 * Relevant: plain 5-digit filename only (e.g. 11391.jpg)
 * Irrelevant: everything else (._* sidecars, non-product names, etc.)
 *
 * Usage:
 *   node scripts/delete-irrelevant-collections.js --path "D:\Collections\Folder" --dry-run
 *   node scripts/delete-irrelevant-collections.js --path "D:\Collections\Folder" --apply
 */

const fs = require("fs");
const {
  scanCollectionRoot,
  resolveUnderRoot,
} = require("../lib/collections-scanner");
const { saveScanResult } = require("../lib/collections-store");

function parseArgs(argv) {
  const options = { path: "", apply: false, dryRun: true };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") {
      options.apply = true;
      options.dryRun = false;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
      options.apply = false;
    } else if (arg === "--path" && argv[i + 1]) {
      options.path = String(argv[i + 1]).trim();
      i += 1;
    }
  }
  return options;
}

function formatBytes(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function main() {
  const { path: rootPath, apply } = parseArgs(process.argv);
  if (!rootPath) {
    console.error("Error: --path is required.");
    console.error(
      'Example: node scripts/delete-irrelevant-collections.js --path "C:\\Paintroad\\Files\\Prints_Categories" --dry-run'
    );
    process.exit(1);
  }

  const scan = scanCollectionRoot(rootPath);
  const irrelevant = scan.images.filter((image) => image.relevance === "irrelevant");
  const relevant = scan.images.filter((image) => image.relevance === "relevant");
  const totalBytes = irrelevant.reduce((sum, image) => sum + (image.size || 0), 0);

  console.log(`Folder: ${scan.rootPath}`);
  console.log(`Mode: ${apply ? "APPLY (deleting files)" : "DRY-RUN (preview only)"}`);
  console.log(`Total images: ${scan.images.length}`);
  console.log(`Relevant (keep): ${relevant.length}`);
  console.log(`Irrelevant (delete): ${irrelevant.length}`);
  console.log(`Space to free: ${formatBytes(totalBytes)}`);
  console.log("");

  if (!irrelevant.length) {
    console.log("Nothing to delete.");
    return;
  }

  if (!apply) {
    console.log("Files to delete (first 50 shown):");
    for (const image of irrelevant.slice(0, 50)) {
      console.log(`  ${image.relativePath} (${formatBytes(image.size || 0)})`);
    }
    if (irrelevant.length > 50) {
      console.log(`  ... and ${irrelevant.length - 50} more`);
    }
    console.log("");
    console.log("Dry-run complete. Re-run with --apply to delete these files.");
    return;
  }

  console.log("Deleting...");

  let deleted = 0;
  let failed = 0;
  const errors = [];

  for (const image of irrelevant) {
    try {
      const absolutePath = resolveUnderRoot(scan.rootPath, image.relativePath);
      if (!fs.existsSync(absolutePath)) {
        failed += 1;
        errors.push(`${image.relativePath}: file not found`);
        continue;
      }
      fs.unlinkSync(absolutePath);
      deleted += 1;
    } catch (error) {
      failed += 1;
      errors.push(`${image.relativePath}: ${error.message}`);
    }
  }

  const refreshed = scanCollectionRoot(scan.rootPath);
  saveScanResult(refreshed);

  console.log("");
  console.log(`Deleted: ${deleted}`);
  console.log(`Failed: ${failed}`);
  console.log(`Remaining relevant images: ${refreshed.images.filter((i) => i.relevance === "relevant").length}`);
  if (errors.length) {
    console.log("Errors:");
    for (const err of errors.slice(0, 20)) {
      console.log(`  ${err}`);
    }
    if (errors.length > 20) {
      console.log(`  ... and ${errors.length - 20} more errors`);
    }
  }
}

main();
