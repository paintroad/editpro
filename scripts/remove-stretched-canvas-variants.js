#!/usr/bin/env node
/**
 * Remove "Stretched Canvas" Frame variants from all Shopify products.
 *
 * Usage:
 *   node scripts/remove-stretched-canvas-variants.js
 *   node scripts/remove-stretched-canvas-variants.js --apply
 *
 * Report: ~/.editpro/remove-stretched-canvas-report.json
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { getShopifyCredentials } = require("../lib/config-store");
const { shopifyGraphql } = require("../lib/shopify-client");

const CONFIG_DIR = path.join(os.homedir(), ".editpro");
const REPORT_PATH = path.join(CONFIG_DIR, "remove-stretched-canvas-report.json");
const PROGRESS_PATH = path.join(
  CONFIG_DIR,
  "remove-stretched-canvas-progress.json"
);
const FRAME_VALUE = "Stretched Canvas";
const VARIANT_QUERY = 'option3:"Stretched Canvas"';

function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadProgress() {
  if (!fs.existsSync(PROGRESS_PATH)) {
    return { doneProductIds: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(PROGRESS_PATH, "utf8"));
  } catch {
    return { doneProductIds: [] };
  }
}

function saveProgress(progress) {
  fs.writeFileSync(PROGRESS_PATH, JSON.stringify(progress, null, 2), "utf8");
}

async function scanStretchedVariants(storeDomain, accessToken) {
  const byProduct = new Map();
  let cursor = null;
  let hasNext = true;
  let totalVariants = 0;

  while (hasNext) {
    const data = await shopifyGraphql(
      storeDomain,
      accessToken,
      `query StretchedVariants($cursor: String, $query: String!) {
        productVariants(first: 250, after: $cursor, query: $query) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            title
            sku
            selectedOptions { name value }
            product { id title handle }
          }
        }
      }`,
      { cursor, query: VARIANT_QUERY }
    );

    const page = data.productVariants;
    for (const node of page?.nodes || []) {
      const frame = (node.selectedOptions || []).find(
        (o) => String(o.name).toLowerCase() === "frame"
      );
      if (!frame || frame.value !== FRAME_VALUE) continue;

      const productId = node.product?.id;
      if (!productId) continue;

      if (!byProduct.has(productId)) {
        byProduct.set(productId, {
          productId,
          title: node.product.title || "",
          handle: node.product.handle || "",
          variants: [],
        });
      }
      byProduct.get(productId).variants.push({
        id: node.id,
        title: node.title || "",
        sku: node.sku || "",
      });
      totalVariants += 1;
    }

    hasNext = Boolean(page?.pageInfo?.hasNextPage);
    cursor = page?.pageInfo?.endCursor || null;
    process.stdout.write(
      `\rScanned variants: ${totalVariants} | products: ${byProduct.size}   `
    );
  }
  process.stdout.write("\n");
  return { byProduct, totalVariants };
}

async function fetchFrameOption(storeDomain, accessToken, productId) {
  const data = await shopifyGraphql(
    storeDomain,
    accessToken,
    `query ProductFrameOption($id: ID!) {
      product(id: $id) {
        id
        options {
          id
          name
          optionValues { id name hasVariants }
        }
      }
    }`,
    { id: productId }
  );

  const options = data.product?.options || [];
  const frame = options.find((o) => String(o.name).toLowerCase() === "frame");
  if (!frame) return null;
  const stretched = (frame.optionValues || []).find(
    (v) => v.name === FRAME_VALUE
  );
  return {
    optionId: frame.id,
    stretchedValueId: stretched?.id || null,
    values: (frame.optionValues || []).map((v) => v.name),
  };
}

async function bulkDeleteVariants(storeDomain, accessToken, productId, variantIds) {
  if (!variantIds.length) return;
  const data = await shopifyGraphql(
    storeDomain,
    accessToken,
    `mutation ProductVariantsBulkDelete($productId: ID!, $variantsIds: [ID!]!) {
      productVariantsBulkDelete(productId: $productId, variantsIds: $variantsIds) {
        product { id }
        userErrors { field message }
      }
    }`,
    { productId, variantsIds: variantIds }
  );
  const errors = data.productVariantsBulkDelete?.userErrors || [];
  if (errors.length) {
    throw new Error(errors.map((e) => e.message).join("; "));
  }
}

async function removeFrameOptionValue(
  storeDomain,
  accessToken,
  productId,
  optionId,
  valueId
) {
  if (!optionId || !valueId) return { skipped: true, reason: "missing-ids" };

  const data = await shopifyGraphql(
    storeDomain,
    accessToken,
    `mutation ProductOptionUpdate(
      $productId: ID!
      $option: OptionUpdateInput!
      $optionValuesToDelete: [ID!]
      $variantStrategy: ProductOptionUpdateVariantStrategy
    ) {
      productOptionUpdate(
        productId: $productId
        option: $option
        optionValuesToDelete: $optionValuesToDelete
        variantStrategy: $variantStrategy
      ) {
        userErrors { field message code }
        product {
          options {
            name
            values
          }
        }
      }
    }`,
    {
      productId,
      option: { id: optionId },
      optionValuesToDelete: [valueId],
      variantStrategy: "LEAVE_AS_IS",
    }
  );

  const errors = data.productOptionUpdate?.userErrors || [];
  if (errors.length) {
    throw new Error(errors.map((e) => e.message).join("; "));
  }
  const frame = (data.productOptionUpdate?.product?.options || []).find(
    (o) => String(o.name).toLowerCase() === "frame"
  );
  return {
    skipped: false,
    remainingFrameValues: frame?.values || [],
  };
}

async function main() {
  const apply = process.argv.includes("--apply");
  const credentials = getShopifyCredentials();
  if (!credentials.storeDomain || !credentials.accessToken) {
    throw new Error("Shopify is not connected. Add credentials in EditPro Settings.");
  }

  ensureConfigDir();
  console.log(`Store: ${credentials.storeDomain}`);
  console.log(`Mode: ${apply ? "APPLY (DELETE)" : "DRY-RUN"}`);
  console.log(`Target Frame value: ${FRAME_VALUE}`);
  console.log("");

  console.log("Scanning for Stretched Canvas variants…");
  const { byProduct, totalVariants } = await scanStretchedVariants(
    credentials.storeDomain,
    credentials.accessToken
  );
  const products = Array.from(byProduct.values()).sort((a, b) =>
    a.handle.localeCompare(b.handle)
  );

  console.log(`Found ${totalVariants} variants across ${products.length} products`);
  console.log("");

  const progress = apply ? loadProgress() : { doneProductIds: [] };
  const doneSet = new Set(progress.doneProductIds || []);

  const results = [];
  let plannedProducts = 0;
  let plannedVariants = 0;
  let deletedProducts = 0;
  let deletedVariants = 0;
  let optionsCleaned = 0;
  let skippedDone = 0;
  let errors = 0;

  for (let i = 0; i < products.length; i += 1) {
    const product = products[i];
    const label = `[${i + 1}/${products.length}] ${product.handle}`;

    if (doneSet.has(product.productId)) {
      skippedDone += 1;
      process.stdout.write(`${label}… SKIP already-done\n`);
      results.push({
        productId: product.productId,
        handle: product.handle,
        title: product.title,
        status: "skipped-already-done",
        variantCount: product.variants.length,
      });
      continue;
    }

    if (!apply) {
      plannedProducts += 1;
      plannedVariants += product.variants.length;
      if (i < 8 || i === products.length - 1) {
        console.log(
          `${label}… PLAN delete ${product.variants.length} variants (${product.variants
            .map((v) => v.sku)
            .slice(0, 3)
            .join(", ")}${product.variants.length > 3 ? ", …" : ""})`
        );
      } else if (i === 8) {
        console.log("…");
      }
      results.push({
        productId: product.productId,
        handle: product.handle,
        title: product.title,
        status: "planned",
        variantCount: product.variants.length,
        sampleSkus: product.variants.slice(0, 5).map((v) => v.sku),
      });
      continue;
    }

    process.stdout.write(
      `${label}… delete ${product.variants.length} variants… `
    );

    try {
      const variantIds = product.variants.map((v) => v.id);
      await bulkDeleteVariants(
        credentials.storeDomain,
        credentials.accessToken,
        product.productId,
        variantIds
      );
      deletedVariants += variantIds.length;

      let optionResult = { skipped: true, reason: "not-fetched" };
      try {
        const frameOpt = await fetchFrameOption(
          credentials.storeDomain,
          credentials.accessToken,
          product.productId
        );
        if (frameOpt?.stretchedValueId) {
          optionResult = await removeFrameOptionValue(
            credentials.storeDomain,
            credentials.accessToken,
            product.productId,
            frameOpt.optionId,
            frameOpt.stretchedValueId
          );
          if (!optionResult.skipped) optionsCleaned += 1;
        } else {
          optionResult = {
            skipped: true,
            reason: "stretched-value-already-gone",
            remainingFrameValues: frameOpt?.values || [],
          };
        }
      } catch (optError) {
        optionResult = {
          skipped: true,
          reason: `option-cleanup-failed: ${optError.message || optError}`,
        };
      }

      deletedProducts += 1;
      doneSet.add(product.productId);
      progress.doneProductIds = Array.from(doneSet);
      if (deletedProducts % 25 === 0) {
        saveProgress(progress);
      }

      console.log(
        `OK` +
          (optionResult.skipped
            ? ` (option: ${optionResult.reason})`
            : ` (Frame → ${(optionResult.remainingFrameValues || []).join(", ")})`)
      );

      results.push({
        productId: product.productId,
        handle: product.handle,
        title: product.title,
        status: "deleted",
        variantCount: variantIds.length,
        optionCleanup: optionResult,
      });

      await sleep(150);
    } catch (error) {
      errors += 1;
      console.log(`ERROR: ${error.message || error}`);
      results.push({
        productId: product.productId,
        handle: product.handle,
        title: product.title,
        status: "error",
        variantCount: product.variants.length,
        reason: error.message || String(error),
      });
      saveProgress(progress);
      await sleep(500);
    }
  }

  if (apply) {
    saveProgress(progress);
  }

  // Verify remaining
  let remainingVariants = null;
  if (apply) {
    console.log("");
    console.log("Verifying remaining Stretched Canvas variants…");
    const verify = await scanStretchedVariants(
      credentials.storeDomain,
      credentials.accessToken
    );
    remainingVariants = verify.totalVariants;
  }

  const summary = {
    mode: apply ? "apply" : "dry-run",
    frameValue: FRAME_VALUE,
    productsFound: products.length,
    variantsFound: totalVariants,
    plannedProducts,
    plannedVariants,
    deletedProducts,
    deletedVariants,
    optionsCleaned,
    skippedAlreadyDone: skippedDone,
    errors,
    remainingVariants,
  };

  fs.writeFileSync(
    REPORT_PATH,
    JSON.stringify(
      {
        summary,
        sample: products.slice(0, 10).map((p) => ({
          handle: p.handle,
          title: p.title,
          variantCount: p.variants.length,
          skus: p.variants.map((v) => v.sku),
        })),
        results,
      },
      null,
      2
    ),
    "utf8"
  );

  console.log("");
  console.log("=== SUMMARY ===");
  console.log(`Products with Stretched Canvas: ${summary.productsFound}`);
  console.log(`Variants found: ${summary.variantsFound}`);
  if (apply) {
    console.log(`Products cleaned: ${summary.deletedProducts}`);
    console.log(`Variants deleted: ${summary.deletedVariants}`);
    console.log(`Frame options cleaned: ${summary.optionsCleaned}`);
    console.log(`Skipped (resume): ${summary.skippedAlreadyDone}`);
    console.log(`Remaining variants: ${summary.remainingVariants}`);
  } else {
    console.log(`Planned products: ${summary.plannedProducts}`);
    console.log(`Planned variants: ${summary.plannedVariants}`);
  }
  console.log(`Errors: ${summary.errors}`);
  console.log(`Report: ${REPORT_PATH}`);
  if (apply) {
    console.log(`Progress: ${PROGRESS_PATH}`);
  }

  if (!apply) {
    console.log("");
    console.log(
      "Dry-run complete. Re-run with --apply to permanently delete Stretched Canvas variants."
    );
  }

  if (apply && (summary.errors > 0 || summary.remainingVariants > 0)) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`Error: ${error.message || error}`);
  process.exit(1);
});
