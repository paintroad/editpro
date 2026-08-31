#!/usr/bin/env node
/**
 * Set custom.google_image_link (url) on products from Paintroad Excel.
 * Matches File Name → variant SKU prefix (exact / {id}- / {id}_).
 *
 * Usage:
 *   node scripts/set-google-image-link-from-excel.js
 *   node scripts/set-google-image-link-from-excel.js --apply
 *   node scripts/set-google-image-link-from-excel.js --file="C:\path\to\file.xlsx"
 *
 * Report: ~/.editpro/google-image-link-from-excel-report.json
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const XLSX = require("xlsx");
const { getShopifyCredentials } = require("../lib/config-store");
const { shopifyGraphql } = require("../lib/shopify-client");

const CONFIG_DIR = path.join(os.homedir(), ".editpro");
const REPORT_PATH = path.join(
  CONFIG_DIR,
  "google-image-link-from-excel-report.json"
);
const DEFAULT_FILE = path.join(
  os.homedir(),
  "Downloads",
  "Paintroad Printable Images Link.xlsx"
);

const NAMESPACE = "custom";
const KEY = "google_image_link";
const METAFIELD_TYPE = "url";
const WRITE_BATCH = 25;
const LOOKUP_SLEEP_MS = 120;

const METAFIELDS_SET = `mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
  metafieldsSet(metafields: $metafields) {
    metafields { id namespace key value }
    userErrors { field message }
  }
}`;

function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv = process.argv.slice(2)) {
  let file = DEFAULT_FILE;
  let apply = false;
  for (const arg of argv) {
    if (arg === "--apply") apply = true;
    else if (arg.startsWith("--file=")) {
      file = arg.slice("--file=".length).replace(/^["']|["']$/g, "");
    }
  }
  return { file, apply };
}

function readExcelRows(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Excel file not found: ${filePath}`);
  }
  const workbook = XLSX.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
  const out = [];
  for (const row of rows) {
    const fileName = String(
      row["File Name"] ?? row["File name"] ?? row.fileName ?? ""
    ).trim();
    const urlLink = String(
      row["URL Link"] ?? row["Url Link"] ?? row.urlLink ?? ""
    ).trim();
    if (!fileName || !urlLink) continue;
    out.push({ fileName, urlLink });
  }
  return out;
}

async function findProductBySkuPrefix(storeDomain, accessToken, skuId) {
  const data = await shopifyGraphql(
    storeDomain,
    accessToken,
    `query ProductBySkuPrefix($query: String!) {
      productVariants(first: 5, query: $query) {
        nodes {
          sku
          product {
            id
            title
            handle
            status
          }
        }
      }
    }`,
    { query: `sku:${skuId}*` }
  );

  const nodes = data.productVariants?.nodes || [];
  const prefix = `${skuId}-`;
  const exactPrefix = String(skuId);

  for (const node of nodes) {
    const sku = String(node?.sku || "");
    const product = node?.product;
    if (!product?.id) continue;
    if (
      sku === exactPrefix ||
      sku.startsWith(prefix) ||
      sku.startsWith(`${skuId}_`)
    ) {
      return {
        skuId,
        productId: product.id,
        title: product.title || "",
        handle: product.handle || "",
        status: product.status || "",
        sampleSku: sku,
      };
    }
  }

  const first = nodes[0];
  if (first?.product?.id && String(first.sku || "").startsWith(exactPrefix)) {
    return {
      skuId,
      productId: first.product.id,
      title: first.product.title || "",
      handle: first.product.handle || "",
      status: first.product.status || "",
      sampleSku: first.sku || "",
    };
  }

  return null;
}

async function metafieldsSetBatch(storeDomain, accessToken, entries) {
  const data = await shopifyGraphql(storeDomain, accessToken, METAFIELDS_SET, {
    metafields: entries,
  });
  const errors = data.metafieldsSet?.userErrors || [];
  if (errors.length) {
    throw new Error(errors.map((e) => e.message).join("; "));
  }
  return data.metafieldsSet?.metafields?.length || 0;
}

async function verifyProductMetafield(storeDomain, accessToken, productId) {
  const data = await shopifyGraphql(
    storeDomain,
    accessToken,
    `query($id: ID!) {
      product(id: $id) {
        id
        handle
        title
        metafield(namespace: "${NAMESPACE}", key: "${KEY}") {
          value
          type
        }
      }
    }`,
    { id: productId }
  );
  return data.product;
}

async function main() {
  const { file, apply } = parseArgs();
  const { storeDomain, accessToken } = getShopifyCredentials();

  console.log(`Excel: ${file}`);
  console.log(`Mode: ${apply ? "APPLY" : "DRY-RUN"}`);
  console.log(`Target: ${NAMESPACE}.${KEY} (${METAFIELD_TYPE}) on products`);

  const rows = readExcelRows(file);
  console.log(`Rows with File Name + URL Link: ${rows.length}`);

  const matched = [];
  const missing = [];
  const conflicts = [];
  const byProductId = new Map();

  for (let i = 0; i < rows.length; i += 1) {
    const { fileName, urlLink } = rows[i];
    if ((i + 1) % 100 === 0 || i === 0) {
      console.log(`Lookup ${i + 1}/${rows.length}… (${matched.length} matched)`);
    }
    let hit = null;
    try {
      hit = await findProductBySkuPrefix(storeDomain, accessToken, fileName);
    } catch (err) {
      missing.push({
        fileName,
        urlLink,
        error: err.message || String(err),
      });
      await sleep(LOOKUP_SLEEP_MS);
      continue;
    }

    if (!hit) {
      missing.push({ fileName, urlLink });
    } else {
      const entry = {
        fileName,
        urlLink,
        productId: hit.productId,
        title: hit.title,
        handle: hit.handle,
        sampleSku: hit.sampleSku,
      };
      if (byProductId.has(hit.productId)) {
        const prev = byProductId.get(hit.productId);
        conflicts.push({
          productId: hit.productId,
          previousFileName: prev.fileName,
          nextFileName: fileName,
          urlKept: urlLink,
        });
      }
      byProductId.set(hit.productId, entry);
      matched.push(entry);
    }
    await sleep(LOOKUP_SLEEP_MS);
  }

  const uniqueWrites = [...byProductId.values()];
  console.log("");
  console.log(`Matched (row hits): ${matched.length}`);
  console.log(`Unique products:    ${uniqueWrites.length}`);
  console.log(`Missing:            ${missing.length}`);
  console.log(`Conflicts (same product, last wins): ${conflicts.length}`);
  if (missing.length) {
    const sample = missing.slice(0, 15).map((m) => m.fileName);
    console.log(`Missing sample: ${sample.join(", ")}`);
  }

  let written = 0;
  const writeErrors = [];

  if (apply) {
    for (let i = 0; i < uniqueWrites.length; i += WRITE_BATCH) {
      const chunk = uniqueWrites.slice(i, i + WRITE_BATCH);
      const metafields = chunk.map((row) => ({
        ownerId: row.productId,
        namespace: NAMESPACE,
        key: KEY,
        type: METAFIELD_TYPE,
        value: row.urlLink,
      }));
      try {
        const n = await metafieldsSetBatch(
          storeDomain,
          accessToken,
          metafields
        );
        written += n;
        console.log(
          `Wrote batch ${Math.floor(i / WRITE_BATCH) + 1}: ${n} metafields (${written} total)`
        );
      } catch (err) {
        writeErrors.push({
          from: i,
          size: chunk.length,
          error: err.message || String(err),
          productIds: chunk.map((c) => c.productId),
        });
        console.error(`Batch error at ${i}: ${err.message || err}`);
      }
      await sleep(200);
    }
  } else {
    console.log("Dry run only — no metafields written. Pass --apply to write.");
  }

  let spotCheck = null;
  const spot =
    uniqueWrites.find((r) => r.fileName === "12480") || uniqueWrites[0];
  if (apply && spot) {
    try {
      spotCheck = await verifyProductMetafield(
        storeDomain,
        accessToken,
        spot.productId
      );
      console.log("");
      console.log("Spot-check:");
      console.log(
        `  ${spotCheck?.handle} → ${NAMESPACE}.${KEY} = ${spotCheck?.metafield?.value || "(empty)"}`
      );
      console.log(`  Expected: ${spot.urlLink}`);
    } catch (err) {
      console.error(`Spot-check failed: ${err.message || err}`);
    }
  }

  ensureConfigDir();
  const report = {
    generatedAt: new Date().toISOString(),
    file,
    apply,
    namespace: NAMESPACE,
    key: KEY,
    type: METAFIELD_TYPE,
    rowCount: rows.length,
    matchedCount: matched.length,
    uniqueProductCount: uniqueWrites.length,
    missingCount: missing.length,
    conflictCount: conflicts.length,
    written,
    writeErrorCount: writeErrors.length,
    missingSample: missing.slice(0, 50),
    conflicts,
    writeErrors,
    matchedSample: uniqueWrites.slice(0, 20),
    spotCheck: spotCheck
      ? {
          productId: spotCheck.id,
          handle: spotCheck.handle,
          value: spotCheck.metafield?.value || null,
          expected: spot?.urlLink || null,
        }
      : null,
  };
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), "utf8");
  console.log(`Report: ${REPORT_PATH}`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
