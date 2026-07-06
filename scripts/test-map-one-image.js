#!/usr/bin/env node
/**
 * Map a single lifestyle image to verify OpenAI room detection end-to-end.
 */
const { getShopifyCredentials, getOpenAiApiKey, loadConfig } = require("../lib/config-store");
const { fetchCatalog } = require("../lib/catalog-fetcher");
const { enumerateCatalogImages, isPortraitProductImage } = require("../lib/catalog-images");
const { isNoneRoom } = require("../lib/room-utils");
const { detectRoomFromImageUrl } = require("../lib/room-detector");
const {
  getMappingForImage,
  upsertMapping,
  reconcileImageRoomMap,
} = require("../lib/image-room-store");

async function main() {
  if (!getOpenAiApiKey()) {
    throw new Error("OpenAI API key is not configured.");
  }

  const { storeDomain, accessToken } = getShopifyCredentials();
  if (!storeDomain || !accessToken) {
    throw new Error("Shopify credentials missing in ~/.editpro/config.json");
  }

  console.log(`Store: ${storeDomain}`);
  console.log("Fetching catalog…");

  const catalog = await fetchCatalog(storeDomain, accessToken, {});
  reconcileImageRoomMap(catalog);
  const images = enumerateCatalogImages(catalog);
  const lifestyle = images.filter((img) => !isPortraitProductImage(img));

  const target =
    lifestyle.find((img) => {
      const existing = getMappingForImage(img);
      return !existing || isNoneRoom(existing.room);
    }) || lifestyle[0];

  if (!target) {
    throw new Error("No lifestyle images found in catalog.");
  }

  console.log(`Testing image: ${target.resourceTitle} (#${target.imageIndex})`);
  console.log(`Handle key: product:${target.handle}:${target.imageIndex}`);
  console.log(`File ID: ${target.fileId}`);

  const opts = { ...loadConfig().roomDetection, openaiApiKey: getOpenAiApiKey() };
  const started = Date.now();
  const room = await detectRoomFromImageUrl(target.url, opts);
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  upsertMapping(target, {
    room,
    source: "openai",
  });

  const saved = getMappingForImage(target);
  console.log(`\nResult: ${room}`);
  console.log(`OpenAI call took ${elapsed}s`);
  console.log(`Saved under slot key: ${saved ? "yes" : "no"}`);
  console.log(`Source: ${saved?.source || "n/a"}`);
}

main().catch((error) => {
  console.error(`\nFAILED: ${error.message}`);
  process.exit(1);
});
