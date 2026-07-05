#!/usr/bin/env node
/**
 * Batch-map catalog images to rooms using Ollama vision.
 * Usage: node scripts/map-image-rooms.js
 * Requires Shopify credentials in ~/.editpro/config.json and Ollama running.
 */
const { loadConfig, getShopifyCredentials } = require("../lib/config-store");
const { fetchCatalog } = require("../lib/catalog-fetcher");
const { enumerateCatalogImages } = require("../lib/catalog-images");
const { loadImageRoomMap, upsertMapping } = require("../lib/image-room-store");
const { detectRoomFromImageUrl } = require("../lib/room-detector");

async function main() {
  const { storeDomain, accessToken } = getShopifyCredentials();
  if (!storeDomain || !accessToken) {
    console.error("Shopify credentials missing. Configure EditPro first.");
    process.exit(1);
  }

  const config = loadConfig();
  const roomOptions = config.roomDetection || {};
  console.log("Fetching catalog…");
  const catalog = await fetchCatalog(storeDomain, accessToken, {});
  const images = enumerateCatalogImages(catalog);
  const existing = loadImageRoomMap().mappings;
  const toScan = images.filter((img) => !existing[img.fileId]);

  console.log(`${images.length} images total, ${toScan.length} unmapped.`);
  if (!toScan.length) {
    console.log("Nothing to map.");
    return;
  }

  for (let i = 0; i < toScan.length; i++) {
    const img = toScan[i];
    process.stdout.write(`[${i + 1}/${toScan.length}] ${img.resourceTitle} #${img.imageIndex}… `);
    try {
      const room = await detectRoomFromImageUrl(img.url, roomOptions);
      upsertMapping({
        fileId: img.fileId,
        resourceType: img.resourceType,
        resourceId: img.resourceId,
        resourceTitle: img.resourceTitle,
        imageIndex: img.imageIndex,
        url: img.url,
        room,
        source: "ollama",
      });
      console.log(room);
    } catch (error) {
      console.log(`ERROR: ${error.message}`);
      process.exit(1);
    }
  }

  console.log("Done.");
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
