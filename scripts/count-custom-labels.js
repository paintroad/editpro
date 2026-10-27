/**
 * Count live mm-google-shopping custom_label_0..4 values
 * at product level and variant level.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { shopifyGraphql } = require("../lib/shopify-client");
const { getShopifyCredentials } = require("../lib/config-store");

const LABEL_KEYS = new Set([
  "custom_label_0",
  "custom_label_1",
  "custom_label_2",
  "custom_label_3",
  "custom_label_4",
]);

const BULK_QUERY = `{
  products {
    edges {
      node {
        id
        status
        metafields(namespace: "mm-google-shopping") {
          edges { node { key value } }
        }
        variants {
          edges {
            node {
              id
              metafields(namespace: "mm-google-shopping") {
                edges { node { key value } }
              }
            }
          }
        }
      }
    }
  }
}`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function bump(map, key, value, id) {
  const label = `${key} = ${value}`;
  if (!map.has(label)) map.set(label, { key, value, ids: new Set() });
  map.get(label).ids.add(id);
}

async function main() {
  const { storeDomain, accessToken } = getShopifyCredentials();
  const current = await shopifyGraphql(
    storeDomain,
    accessToken,
    `query { currentBulkOperation { id status } }`
  );
  const running = current.currentBulkOperation;
  if (running && !["COMPLETED", "FAILED", "CANCELED", "EXPIRED"].includes(running.status)) {
    throw new Error(`A Shopify bulk operation is already ${running.status}.`);
  }

  const started = await shopifyGraphql(
    storeDomain,
    accessToken,
    `mutation ($query: String!) {
      bulkOperationRunQuery(query: $query) {
        bulkOperation { id status }
        userErrors { field message }
      }
    }`,
    { query: BULK_QUERY }
  );
  const errors = started.bulkOperationRunQuery?.userErrors || [];
  if (errors.length) throw new Error(errors.map((error) => error.message).join("; "));

  let url = "";
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await sleep(5000);
    const poll = await shopifyGraphql(
      storeDomain,
      accessToken,
      `query { currentBulkOperation { status errorCode objectCount url } }`
    );
    const op = poll.currentBulkOperation;
    console.log(`${op?.status || "unknown"} objects=${op?.objectCount || 0}`);
    if (op?.status === "COMPLETED") {
      url = op.url || "";
      break;
    }
    if (["FAILED", "CANCELED", "EXPIRED"].includes(op?.status)) {
      throw new Error(`Bulk operation ${op.status} ${op.errorCode || ""}`);
    }
  }
  if (!url) throw new Error("Bulk operation finished without a download URL.");

  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed ${response.status}`);
  const file = path.join(os.tmpdir(), "custom-labels.jsonl");
  fs.writeFileSync(file, Buffer.from(await response.arrayBuffer()));

  const products = new Map();
  const variants = new Map();
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  for (const line of lines) {
    const row = JSON.parse(line);
    if (String(row.id || "").includes("/Product/")) {
      products.set(row.id, { status: row.status, variantIds: new Set() });
    } else if (String(row.id || "").includes("/ProductVariant/")) {
      variants.set(row.id, { parentId: row.__parentId });
      const product = products.get(row.__parentId);
      if (product) product.variantIds.add(row.id);
    }
  }

  const productLabels = new Map();
  const variantLabels = new Map();
  const variantProducts = new Map();
  let activeProducts = 0;
  let activeVariants = 0;
  for (const product of products.values()) {
    if (product.status === "ACTIVE") activeProducts += 1;
  }
  for (const variant of variants.values()) {
    const product = products.get(variant.parentId);
    if (product?.status === "ACTIVE") activeVariants += 1;
  }

  for (const line of lines) {
    const row = JSON.parse(line);
    if (!row.key || !LABEL_KEYS.has(row.key)) continue;
    const value = String(row.value || "").trim();
    if (!value) continue;
    const parent = row.__parentId;
    if (products.has(parent)) {
      if (products.get(parent).status !== "ACTIVE") continue;
      bump(productLabels, row.key, value, parent);
    } else if (variants.has(parent)) {
      const productId = variants.get(parent).parentId;
      if (products.get(productId)?.status !== "ACTIVE") continue;
      bump(variantLabels, row.key, value, parent);
      bump(variantProducts, row.key, value, productId);
    }
  }

  function dump(map) {
    return [...map.values()]
      .map((row) => ({ key: row.key, value: row.value, count: row.ids.size }))
      .sort((a, b) => a.key.localeCompare(b.key) || b.count - a.count);
  }

  const summary = {
    activeProducts,
    activeVariants,
    productLevel: dump(productLabels),
    variantLevelVariants: dump(variantLabels),
    variantLevelProducts: dump(variantProducts),
  };
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
