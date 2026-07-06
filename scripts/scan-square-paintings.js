#!/usr/bin/env node
/**
 * CLI for scanning a nested catalog folder and listing square paintings.
 * Usage:
 *   node scripts/scan-square-paintings.js [catalogRoot]
 *   node scripts/scan-square-paintings.js --calibrate [catalogRoot]
 */
const fs = require("fs/promises");
const path = require("path");
const {
  detectPaintingAspectRatio,
  isSquarePainting,
  scanCatalog,
  writeExcel,
} = require("../lib/square-paintings-scanner");
const { DEFAULT_CATALOG_PATH, CATALOG_ROOT } = require("../lib/catalog-paths");

const DEFAULT_OUTPUT = path.join(CATALOG_ROOT, "square-paintings.xlsx");

async function runCalibration(samples) {
  console.log("Calibration on known samples:\n");
  let ok = true;

  for (const sample of samples) {
    const { path: imagePath, expected } = sample;
    const { aspectRatio, box } = await detectPaintingAspectRatio(imagePath);
    const square = isSquarePainting(aspectRatio);
    const pass = square === expected;
    if (!pass) {
      ok = false;
    }

    console.log(
      `${pass ? "PASS" : "FAIL"}  ${path.basename(imagePath)}  ratio=${aspectRatio?.toFixed(3) ?? "n/a"}  box=${box ? `${box.width}x${box.height}` : "n/a"}  expected=${expected ? "square" : "non-square"}  got=${square ? "square" : "non-square"}`,
    );
  }

  console.log(ok ? "\nCalibration passed.\n" : "\nCalibration FAILED — check thresholds.\n");
  return ok;
}

async function main() {
  const args = process.argv.slice(2);
  const calibrateOnly = args.includes("--calibrate");
  const catalogRoot = args.find((a) => !a.startsWith("--")) ?? DEFAULT_CATALOG_PATH;
  const outputPath = DEFAULT_OUTPUT;

  const calibrationSamples = [
    {
      path: path.join(catalogRoot, "10001-10575", "10001", "10001_0.jpg"),
      expected: true,
    },
    {
      path: path.join(catalogRoot, "10001-10575", "10002", "10002_0.jpg"),
      expected: true,
    },
    {
      path: path.join(catalogRoot, "10001-10575", "10050", "10050_0.jpg"),
      expected: false,
    },
    {
      path: path.join(catalogRoot, "10001-10575", "10100", "10100_0.jpg"),
      expected: false,
    },
  ];

  const calibrationOk = await runCalibration(calibrationSamples);
  if (!calibrationOk) {
    process.exitCode = 1;
    return;
  }

  if (calibrateOnly) {
    return;
  }

  console.log(`Scanning catalog: ${catalogRoot}`);
  const { total, squareProducts, nonSquareCount, skipped } = await scanCatalog(catalogRoot);

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await writeExcel(outputPath, squareProducts);

  console.log(`Total product folders: ${total}`);
  console.log(`Square paintings:      ${squareProducts.length}`);
  console.log(`Non-square paintings:  ${nonSquareCount}`);
  console.log(`Skipped:               ${skipped.length}`);
  console.log(`Output written to:     ${outputPath}`);

  if (skipped.length > 0) {
    console.log("\nSkipped folders:");
    for (const s of skipped.slice(0, 20)) {
      console.log(`  ${s.productId}: ${s.reason}${s.image ? ` (${s.image})` : ""}`);
    }
    if (skipped.length > 20) {
      console.log(`  ... and ${skipped.length - 20} more`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
