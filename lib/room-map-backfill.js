/**
 * Sync portrait none + backfill lifestyle rooms from SEO filenames into image-room-map.json
 */

const { getShopifyCredentials } = require("./config-store");
const {
  fetchAllProducts,
  fetchAllCollections,
  fetchAllArticles,
} = require("./catalog-fetcher");
const {
  enumerateCatalogImages,
  isPortraitProductImage,
} = require("./catalog-images");
const {
  createMutableStore,
  upsertInStore,
  flushStore,
  getRoomForImage,
  hasMappingForImage,
} = require("./image-room-store");
const { isNoneRoom } = require("./room-utils");
const {
  parseRoomFromFilename,
  isBasePaintingFilename,
} = require("./room-from-filename");

function hasRealRoom(img, store) {
  if (!hasMappingForImage(img, store)) return false;
  return !isNoneRoom(getRoomForImage(img, store));
}

function emptyTotals() {
  return {
    scanned: 0,
    portraitsSet: 0,
    baseFilenameNone: 0,
    filledFromFilename: 0,
    skippedExisting: 0,
    skippedNoRoomInName: 0,
    stillUnmapped: 0,
    batches: 0,
    productsSeen: 0,
    collectionsSeen: 0,
    articlesSeen: 0,
    updatedAt: null,
  };
}

function accumulate(totals, result) {
  totals.scanned += result.scanned || 0;
  totals.portraitsSet += result.portraitsSet || 0;
  totals.baseFilenameNone += result.baseFilenameNone || 0;
  totals.filledFromFilename += result.filledFromFilename || 0;
  totals.skippedExisting += result.skippedExisting || 0;
  totals.skippedNoRoomInName += result.skippedNoRoomInName || 0;
  totals.stillUnmapped += result.stillUnmapped || 0;
  totals.updatedAt = result.updatedAt || totals.updatedAt;
}

/**
 * @param {object} storeData live Shopify catalog { products, collections, articles }
 */
function backfillRoomsFromFilenames(storeData) {
  const images = enumerateCatalogImages(storeData || {});
  const store = createMutableStore();
  const now = new Date().toISOString();

  let portraitsSet = 0;
  let baseFilenameNone = 0;
  let filledFromFilename = 0;
  let skippedExisting = 0;
  let skippedNoRoomInName = 0;
  let stillUnmapped = 0;

  // Pass A — product imageIndex 1 → none
  for (const img of images) {
    if (!isPortraitProductImage(img)) continue;
    upsertInStore(store, img, {
      room: "none",
      source: "portrait",
      detectedAt: now,
    });
    portraitsSet += 1;
  }

  // Also force none for any product lifestyle row whose filename is *-1 (mis-indexed safety)
  for (const img of images) {
    if (img.resourceType !== "product") continue;
    if (isPortraitProductImage(img)) continue;
    if (!isBasePaintingFilename(img.url)) continue;
    upsertInStore(store, img, {
      room: "none",
      source: "portrait",
      detectedAt: now,
    });
    baseFilenameNone += 1;
  }

  // Pass B — lifestyle filename backfill
  for (const img of images) {
    if (isPortraitProductImage(img)) continue;
    if (img.resourceType === "product" && isBasePaintingFilename(img.url)) {
      continue;
    }

    if (hasRealRoom(img, store)) {
      skippedExisting += 1;
      continue;
    }

    const room = parseRoomFromFilename(img.url);
    if (!room) {
      skippedNoRoomInName += 1;
      continue;
    }

    upsertInStore(store, img, {
      room,
      source: "filename",
      detectedAt: now,
    });
    filledFromFilename += 1;
  }

  flushStore(store);

  // Recount still-unmapped lifestyle (product index>=2, collections, articles)
  for (const img of images) {
    if (isPortraitProductImage(img)) continue;
    if (img.resourceType === "product" && isBasePaintingFilename(img.url)) {
      continue;
    }
    if (!hasRealRoom(img, store)) {
      stillUnmapped += 1;
    }
  }

  return {
    scanned: images.length,
    portraitsSet,
    baseFilenameNone,
    filledFromFilename,
    skippedExisting,
    skippedNoRoomInName,
    stillUnmapped,
    updatedAt: store.updatedAt,
  };
}

/**
 * Fetch Shopify catalog page-by-page and backfill after each page (progress is flushed).
 * @param {{ onBatch?: (info: object) => void }} [options]
 */
async function backfillRoomsFromFilenamesBatched({ onBatch } = {}) {
  const { storeDomain, accessToken } = getShopifyCredentials();
  if (!storeDomain || !accessToken) {
    throw new Error("Shopify credentials missing. Connect your store in SEO Engine.");
  }

  const totals = emptyTotals();

  function runSlice(type, storeData, seenKey, seenCount) {
    const result = backfillRoomsFromFilenames(storeData);
    accumulate(totals, result);
    totals.batches += 1;
    if (seenKey) {
      totals[seenKey] = seenCount;
    }
    const info = {
      type,
      batch: totals.batches,
      productsSeen: totals.productsSeen,
      collectionsSeen: totals.collectionsSeen,
      articlesSeen: totals.articlesSeen,
      ...result,
      totals: { ...totals },
    };
    onBatch?.(info);
    return result;
  }

  await fetchAllProducts(storeDomain, accessToken, {
    onPage: ({ items, count }) => {
      runSlice(
        "products",
        { products: items, collections: [], articles: [] },
        "productsSeen",
        count
      );
    },
  });

  await fetchAllCollections(storeDomain, accessToken, {
    onPage: ({ items, count }) => {
      runSlice(
        "collections",
        { products: [], collections: items, articles: [] },
        "collectionsSeen",
        count
      );
    },
  });

  await fetchAllArticles(storeDomain, accessToken, {
    onPage: ({ items, count }) => {
      runSlice(
        "articles",
        { products: [], collections: [], articles: items },
        "articlesSeen",
        count
      );
    },
  });

  return totals;
}

function upsertManualRooms(items) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) {
    throw new Error("items array is required.");
  }

  const store = createMutableStore();
  const now = new Date().toISOString();
  let updated = 0;
  let rejected = 0;
  const errors = [];

  for (const item of list) {
    try {
      const img = {
        fileId: item.fileId,
        handle: item.handle || "",
        resourceType: item.resourceType,
        resourceId: item.resourceId,
        resourceTitle: item.resourceTitle || "",
        imageIndex: Number(item.imageIndex) || 1,
        url: item.url || "",
      };
      if (!img.fileId || !img.resourceType || !img.resourceId) {
        rejected += 1;
        errors.push({ item, message: "fileId, resourceType, and resourceId are required." });
        continue;
      }

      const isPortrait =
        img.resourceType === "product" && img.imageIndex === 1;
      const isDashOne =
        img.resourceType === "product" && isBasePaintingFilename(img.url);

      let room = String(item.room || "").trim().toLowerCase();
      if (isPortrait || isDashOne) {
        room = "none";
      }
      if (!room) {
        rejected += 1;
        errors.push({ item, message: "room is required." });
        continue;
      }

      upsertInStore(store, img, {
        room,
        source: isPortrait || isDashOne ? "portrait" : "manual",
        detectedAt: now,
        frameColour: item.frameColour || null,
      });
      updated += 1;
    } catch (error) {
      rejected += 1;
      errors.push({ item, message: error.message || "Failed to upsert." });
    }
  }

  flushStore(store);
  return { updated, rejected, errors, updatedAt: store.updatedAt };
}

module.exports = {
  backfillRoomsFromFilenames,
  backfillRoomsFromFilenamesBatched,
  upsertManualRooms,
};
