/**
 * Page-batched Image Room Map backfill from SEO filenames.
 *
 * Usage:
 *   node scripts/backfill-rooms-from-filenames.js
 */
const {
  backfillRoomsFromFilenamesBatched,
} = require("../lib/room-map-backfill");

function formatNumber(n) {
  return Number(n || 0).toLocaleString();
}

(async () => {
  console.log("Starting batched room-map filename backfill…");
  const started = Date.now();

  const totals = await backfillRoomsFromFilenamesBatched({
    onBatch: (info) => {
      const filled = info.filledFromFilename || 0;
      const still = info.stillUnmapped || 0;
      const seen =
        info.type === "products"
          ? `${formatNumber(info.productsSeen)} products`
          : info.type === "collections"
            ? `${formatNumber(info.collectionsSeen)} collections`
            : `${formatNumber(info.articlesSeen)} articles`;
      console.log(
        `Batch ${info.batch} (${info.type}) — ${seen} | +${filled} filled, ${still} still unmapped in page | total filled ${formatNumber(info.totals.filledFromFilename)}`
      );
    },
  });

  const elapsedSec = ((Date.now() - started) / 1000).toFixed(1);
  console.log("\n=== Done ===");
  console.log(JSON.stringify({
    elapsedSec: Number(elapsedSec),
    batches: totals.batches,
    productsSeen: totals.productsSeen,
    collectionsSeen: totals.collectionsSeen,
    articlesSeen: totals.articlesSeen,
    scanned: totals.scanned,
    portraitsSet: totals.portraitsSet,
    baseFilenameNone: totals.baseFilenameNone,
    filledFromFilename: totals.filledFromFilename,
    skippedExisting: totals.skippedExisting,
    skippedNoRoomInName: totals.skippedNoRoomInName,
    stillUnmapped: totals.stillUnmapped,
    updatedAt: totals.updatedAt,
  }, null, 2));
})().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
