#!/usr/bin/env node
/**
 * Number the new-catalog prints, enrich them, and generate lifestyle images.
 * Does not upload to Shopify.
 */

const fs = require("fs");
const path = require("path");
const { importCatalog } = require("../lib/catalog-importer");
const {
  loadCatalogStore,
  saveCatalogStore,
  mergeImportResults,
} = require("../lib/catalog-products-store");
const orientation = require("../lib/orientation-runner");
const enrich = require("../lib/catalog-enrich-runner");
const lifestyle = require("../lib/lifestyle-runner");

const INPUT = "C:\\Users\\divya\\Downloads\\_New Catalog\\Output";
const OUTPUT = "C:\\Users\\divya\\Downloads\\_New Generated Catalog";
const FRAMES = "C:\\Users\\divya\\Downloads\\_Frame References";
const START_ID = 13213;
const IDS = ["13213", "13214", "13215"];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function renamePrints() {
  const files = fs
    .readdirSync(INPUT)
    .filter((name) => /\.(png|jpe?g|webp)$/i.test(name) && !name.startsWith("."));
  const numbered = files.filter((name) => IDS.includes(path.parse(name).name));
  if (numbered.length === IDS.length) {
    console.log("prints already numbered:", numbered.join(", "));
    return;
  }
  const pending = files
    .filter((name) => !/^\d+$/.test(path.parse(name).name))
    .sort((a, b) => a.localeCompare(b));
  if (pending.length !== IDS.length) {
    throw new Error(`Expected ${IDS.length} new prints, found: ${files.join(", ")}`);
  }
  pending.forEach((name, index) => {
    const dest = `${START_ID + index}${path.extname(name).toLowerCase()}`;
    fs.renameSync(path.join(INPUT, name), path.join(INPUT, dest));
    console.log(`renamed ${name} -> ${dest}`);
  });
}

async function waitFor(label, getStatus) {
  let last = "";
  for (;;) {
    const status = getStatus();
    const line = `${label} ${status.state} ${status.current || 0}/${status.total || 0} errors=${status.errors || 0}`;
    if (line !== last) {
      console.log(line);
      last = line;
    }
    if (status.state === "done" || status.state === "idle" || status.state === "stopped") {
      return status;
    }
    if (status.state === "error") {
      throw new Error(status.error || `${label} failed.`);
    }
    await sleep(2000);
  }
}

async function main() {
  renamePrints();
  const imported = await importCatalog(INPUT);
  const wanted = imported.products.filter((product) => IDS.includes(product.productId));
  if (wanted.length !== IDS.length) {
    throw new Error(`Import found ${wanted.length} of ${IDS.join(", ")}.`);
  }
  const store = loadCatalogStore();
  const merged = mergeImportResults(store, { ...imported, products: wanted });
  store.lastAssignedProductId = IDS[IDS.length - 1];
  saveCatalogStore(store);
  console.log("imported", merged);

  await orientation.start({ productIds: IDS });
  await waitFor("orientation", () => orientation.getStatus());

  await enrich.start({ productIds: IDS });
  await waitFor("enrich", () => enrich.getStatus());

  const afterEnrich = loadCatalogStore();
  for (const id of IDS) {
    const product = afterEnrich.products[id];
    if (!product || product.status !== "enriched") {
      throw new Error(`${id} was not enriched: ${product?.error || product?.status || "missing"}`);
    }
    console.log(
      [
        id,
        product.orientation,
        product.title,
        (product.styleTags || []).join("/"),
        (product.roomTags || []).join("/"),
      ].join(" | ")
    );
  }

  await lifestyle.start({
    productIds: IDS,
    frameTemplatesPath: FRAMES,
    outputPath: OUTPUT,
    frameSets: { portrait: "Portrait", landscape: "Landscape", square: "Square" },
  });
  await waitFor("lifestyle", () => lifestyle.getStatus());

  const done = loadCatalogStore();
  done.lastAssignedProductId = IDS[IDS.length - 1];
  saveCatalogStore(done);
  for (const id of IDS) {
    const product = done.products[id];
    const files = (product.lifestyleImages || []).map((image) => image.filename);
    console.log(id, product.lifestyleStatus, files.join(", "));
    if (product.lifestyleError) console.log("  error", product.lifestyleError);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
