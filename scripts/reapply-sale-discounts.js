#!/usr/bin/env node
/**
 * Refresh or reapply sale discounts at an explicit % range.
 * Does not change EditPro DEFAULT_MIN / DEFAULT_MAX constants.
 *
 * Usage:
 *   node scripts/reapply-sale-discounts.js --refresh --min=25 --max=35
 *   node scripts/reapply-sale-discounts.js --refresh --min=25 --max=35 --apply
 *   node scripts/reapply-sale-discounts.js --reapply --min=25 --max=35 --apply
 */

const {
  refreshSale,
  reapplySaleDiscounts,
  getSaleSession,
} = require("../lib/sale-manager");

function parseArgs(argv) {
  const apply = argv.includes("--apply");
  const doRefresh = argv.includes("--refresh");
  const doReapply = argv.includes("--reapply");
  let min = 25;
  let max = 35;
  for (const arg of argv) {
    if (arg.startsWith("--min=")) min = Number(arg.slice("--min=".length));
    if (arg.startsWith("--max=")) max = Number(arg.slice("--max=".length));
  }
  return { apply, doRefresh, doReapply, min, max };
}

async function main() {
  const { apply, doRefresh, doReapply, min, max } = parseArgs(
    process.argv.slice(2)
  );

  if (!doRefresh && !doReapply) {
    console.error("Pass --refresh and/or --reapply (plus --apply to write).");
    process.exit(1);
  }

  console.log(
    apply ? "Mode: APPLY" : "Mode: DRY-RUN (pass --apply to write to Shopify)"
  );
  console.log(`Discount range: ${min}–${max}%`);
  console.log("");

  if (!apply) {
    const session = getSaleSession();
    console.log("Current sale session:", {
      count: session.count,
      discountMin: session.discountMin,
      discountMax: session.discountMax,
      updatedAt: session.updatedAt,
    });
    console.log(
      doRefresh
        ? `Would run refreshSale({ discountMin: ${min}, discountMax: ${max} })`
        : `Would run reapplySaleDiscounts({ discountMin: ${min}, discountMax: ${max} })`
    );
    if (doRefresh && doReapply) {
      console.log("(Both flags set: refresh runs first, then reapply is skipped in dry-run.)");
    }
    return;
  }

  if (doRefresh) {
    console.log("Running refreshSale…");
    const result = await refreshSale({
      discountMin: min,
      discountMax: max,
    });
    console.log("refreshSale done:", {
      count: result.count,
      discountMin: result.discountMin,
      discountMax: result.discountMax,
      sampled: result.sampled,
      collectionsScanned: result.collectionsScanned,
      revertErrors: result.revertErrors?.length || 0,
      applyErrors: result.applyErrors?.length || 0,
    });
    const sample = (result.items || []).slice(0, 5).map((i) => ({
      handle: i.handle,
      sku: i.sku,
      pct: i.discountPercent,
      sale: i.salePrice,
      list: i.listPrice,
      original: i.originalPrice,
    }));
    console.log("Sample items:", sample);
    return;
  }

  if (doReapply) {
    console.log("Running reapplySaleDiscounts…");
    const result = await reapplySaleDiscounts({
      discountMin: min,
      discountMax: max,
    });
    console.log("reapplySaleDiscounts done:", {
      count: result.count,
      discountMin: result.discountMin,
      discountMax: result.discountMax,
      reapplied: result.reapplied,
      resolveErrors: result.resolveErrors?.length || 0,
      applyErrors: result.applyErrors?.length || 0,
    });
    const sample = (result.items || []).slice(0, 5).map((i) => ({
      handle: i.handle,
      sku: i.sku,
      pct: i.discountPercent,
      sale: i.salePrice,
      list: i.listPrice,
      original: i.originalPrice,
    }));
    console.log("Sample items:", sample);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
