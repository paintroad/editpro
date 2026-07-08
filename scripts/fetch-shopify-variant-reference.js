/**
 * Fetches variant weight + cost from live Shopify reference products (rectangle + square).
 * Saves ~/.editpro/catalog-variant-reference.json
 *
 * Usage: node scripts/fetch-shopify-variant-reference.js
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { getShopifyCredentials } = require("../lib/config-store");
const { shopifyGraphql } = require("../lib/shopify-client");

const REF_PATH = path.join(os.homedir(), ".editpro", "catalog-variant-reference.json");

const PRODUCTS_QUERY = `query Products($cursor: String) {
  products(first: 50, after: $cursor, query: "status:active") {
    pageInfo { hasNextPage endCursor }
    nodes {
      id title handle
      variants(first: 40) {
        nodes {
          sku
          selectedOptions { name value }
          inventoryItem {
            unitCost { amount }
            measurement { weight { value unit } }
          }
        }
      }
    }
  }
}`;

function optionValue(selectedOptions, name) {
  const target = String(name || "").toLowerCase();
  const hit = (selectedOptions || []).find(
    (opt) => String(opt?.name || "").toLowerCase() === target
  );
  return hit?.value || "";
}

function parseSizeCode(sizeLabel) {
  const m = String(sizeLabel || "").match(/^([A-Z]+)\s/i);
  return m ? m[1].toUpperCase() : "";
}

function normalizeFrame(frame) {
  const f = String(frame || "").trim().toLowerCase();
  if (f === "black-frame") {
    return "black";
  }
  if (f === "stretched canvas" || f === "stretched-canvas") {
    return "stretched-canvas";
  }
  return f;
}

function inferShape(sizeLabel) {
  const dims = String(sizeLabel || "").match(/(\d+(?:\.\d+)?)\s*["']?\s*x\s*(\d+(?:\.\d+)?)/i);
  if (!dims) {
    return "";
  }
  const w = parseFloat(dims[1]);
  const h = parseFloat(dims[2]);
  if (!w || !h) {
    return "";
  }
  return w === h ? "square" : "rectangle";
}

function variantKey(shape, sizeCode, material, frame) {
  return `${shape}|${sizeCode}|${material}|${frame}`;
}

function extractVariantEntry(variant) {
  const size = optionValue(variant.selectedOptions, "Size");
  const material = optionValue(variant.selectedOptions, "Material");
  const frame = normalizeFrame(optionValue(variant.selectedOptions, "Frame"));
  const sizeCode = parseSizeCode(size);
  const shape = inferShape(size);
  if (!shape || !sizeCode || !material || !frame) {
    return null;
  }

  const weight = variant.inventoryItem?.measurement?.weight;
  const costRaw = variant.inventoryItem?.unitCost?.amount;

  return {
    key: variantKey(shape, sizeCode, material, frame),
    shape,
    sizeCode,
    size,
    material,
    frame,
    weight: weight?.value != null ? Number(weight.value) : null,
    weightUnit: weight?.unit ? String(weight.unit).toLowerCase() : "g",
    cost: costRaw != null && costRaw !== "" ? Number(costRaw) : null,
  };
}

function buildLookupFromProduct(product) {
  const entries = {};
  for (const variant of product.variants?.nodes || []) {
    const row = extractVariantEntry(variant);
    if (!row || row.weight == null || row.weight <= 0) {
      continue;
    }
    entries[row.key] = {
      weight: row.weight,
      weightUnit: row.weightUnit,
      cost: row.cost,
      size: row.size,
      material: row.material,
      frame: row.frame,
    };
  }
  return entries;
}

function scoreProduct(entries) {
  return Object.keys(entries).length;
}

async function fetchAllActiveProducts(storeDomain, accessToken) {
  const products = [];
  let cursor = null;
  let hasNext = true;
  while (hasNext) {
    const data = await shopifyGraphql(storeDomain, accessToken, PRODUCTS_QUERY, { cursor });
    const page = data.products;
    products.push(...(page.nodes || []));
    hasNext = page.pageInfo?.hasNextPage;
    cursor = page.pageInfo?.endCursor;
  }
  return products;
}

function pickBestReference(products, shape) {
  let best = null;
  let bestScore = 0;
  for (const product of products) {
    const entries = buildLookupFromProduct(product);
    const shapeEntries = Object.fromEntries(
      Object.entries(entries).filter(([key]) => key.startsWith(`${shape}|`))
    );
    const score = scoreProduct(shapeEntries);
    if (score > bestScore) {
      bestScore = score;
      best = { product, entries: shapeEntries };
    }
  }
  return best;
}

async function main() {
  const credentials = getShopifyCredentials();
  if (!credentials.storeDomain || !credentials.accessToken) {
    throw new Error("Shopify is not connected.");
  }

  console.log("Fetching active products from Shopify...");
  const products = await fetchAllActiveProducts(
    credentials.storeDomain,
    credentials.accessToken
  );
  console.log(`Scanned ${products.length} products.`);

  const rectangleRef = pickBestReference(products, "rectangle");
  const squareRef = pickBestReference(products, "square");

  if (!rectangleRef?.entries || !Object.keys(rectangleRef.entries).length) {
    throw new Error("No rectangle reference product with weight data found on Shopify.");
  }
  if (!squareRef?.entries || !Object.keys(squareRef.entries).length) {
    throw new Error("No square reference product with weight data found on Shopify.");
  }

  const payload = {
    fetchedAt: new Date().toISOString(),
    rectangle: {
      sourceHandle: rectangleRef.product.handle,
      sourceTitle: rectangleRef.product.title,
      variants: rectangleRef.entries,
    },
    square: {
      sourceHandle: squareRef.product.handle,
      sourceTitle: squareRef.product.title,
      variants: squareRef.entries,
    },
  };

  fs.mkdirSync(path.dirname(REF_PATH), { recursive: true });
  fs.writeFileSync(REF_PATH, JSON.stringify(payload, null, 2), "utf8");

  console.log(`Rectangle reference: ${rectangleRef.product.title} (${Object.keys(rectangleRef.entries).length} variants)`);
  console.log(`Square reference: ${squareRef.product.title} (${Object.keys(squareRef.entries).length} variants)`);
  console.log(`Saved to ${REF_PATH}`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
