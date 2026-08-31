#!/usr/bin/env node
/**
 * Bulk-link all (or selected) artists' products via custom.artist.
 *
 * Usage:
 *   node scripts/link-artist-products.js
 *   node scripts/link-artist-products.js --ids=claude-monet,banksy
 *
 * Report: ~/.editpro/artists-link-report.json (cumulative)
 */

const { loadArtistsStore } = require("../lib/artists-store");
const { linkArtistsProducts, LINK_REPORT_PATH } = require("../lib/artists-shopify");

function parseArgs(argv = process.argv.slice(2)) {
  let ids = null;
  for (const arg of argv) {
    if (arg.startsWith("--ids=")) {
      ids = arg
        .slice("--ids=".length)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }
  return { ids };
}

async function main() {
  const { ids: requested } = parseArgs();
  const store = loadArtistsStore();
  const artists = store.artists || [];
  const ids =
    requested && requested.length
      ? requested
      : artists
          .filter((a) => a.shopifyMetaobjectId)
          .map((a) => a.id);

  if (!ids.length) {
    throw new Error("No artists with Shopify metaobject IDs to link.");
  }

  console.log(`Linking products for ${ids.length} artist(s)…`);
  const result = await linkArtistsProducts(ids);
  const totals = result.cumulative?.totals || {};
  console.log("Totals:", totals);
  for (const row of result.cumulative?.byArtist || []) {
    console.log(
      `  ${row.artistName}: linked ${row.linkedCount}/${row.targetCount}` +
        (row.missingCount ? ` missing ${row.missingCount}` : "") +
        (row.errorCount ? ` errors ${row.errorCount}` : "")
    );
  }
  if (result.errors?.length) {
    console.error("Artist-level errors:", result.errors);
  }
  console.log(`Report: ${LINK_REPORT_PATH}`);
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
