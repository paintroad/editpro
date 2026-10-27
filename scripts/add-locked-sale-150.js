#!/usr/bin/env node
/**
 * Append the approved 150 sale variants. Does not revert or reprice the existing set.
 * Locked rows are read from the approved plan (name, SKU, sale price, discount %).
 */

const fs = require("fs");
const path = require("path");
const { shopifyGraphql } = require("../lib/shopify-client");
const { getShopifyCredentials } = require("../lib/config-store");
const {
  loadSaleState,
  saveSaleState,
  applySaleItems,
} = require("../lib/sale-manager");

const PLAN_PATH = path.join(
  process.env.USERPROFILE || "",
  ".cursor",
  "plans",
  "expand_sale_to_200_d6b491c7.plan.md"
);

const VARIANT_FIELDS = `
  id
  sku
  price
  compareAtPrice
  selectedOptions { name value }
  product {
    id
    title
    handle
    status
    media(first: 1) {
      nodes {
        ... on MediaImage { image { url } }
      }
    }
    collections(first: 1) {
      nodes { title handle }
    }
  }
`;

function parsePlan(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  const rows = [];
  const re =
    /^- (.+) \| L 24x36 (White|Black) \(([0-9]+-L-[56])\) \| (\d+) \| (\d+) \((\d+)%\)\s*$/gm;
  let match;
  while ((match = re.exec(text))) {
    rows.push({
      title: match[1].trim(),
      frame: match[2],
      sku: match[3],
      originalPrice: Number(match[4]),
      salePrice: Number(match[5]),
      discountPercent: Number(match[6]),
    });
  }
  return rows;
}

function optionValue(selectedOptions, name) {
  const n = String(name || "").toLowerCase();
  const hit = (selectedOptions || []).find(
    (o) => String(o.name || "").toLowerCase() === n
  );
  return hit ? String(hit.value || "") : "";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resolveSku(storeDomain, accessToken, sku) {
  const data = await shopifyGraphql(
    storeDomain,
    accessToken,
    `query VariantBySku($query: String!) {
      productVariants(first: 5, query: $query) {
        nodes { ${VARIANT_FIELDS} }
      }
    }`,
    { query: `sku:${sku}` }
  );
  const nodes = data.productVariants?.nodes || [];
  return nodes.find((node) => node.sku === sku) || null;
}

function buildItem(row, variant) {
  const product = variant.product;
  const size = optionValue(variant.selectedOptions, "Size");
  const frame = optionValue(variant.selectedOptions, "Frame");
  const material = optionValue(variant.selectedOptions, "Material") || "Canvas";
  const collection = product.collections?.nodes?.[0] || null;
  const imageUrl = product.media?.nodes?.[0]?.image?.url || "";
  return {
    productId: row.sku.split("-")[0],
    shopifyProductId: product.id,
    handle: product.handle || "",
    title: product.title || row.title,
    collection: collection?.title || "",
    collectionHandle: collection?.handle || "",
    imageUrl,
    variantId: variant.id,
    sku: row.sku,
    size,
    material,
    frame,
    originalPrice: row.originalPrice,
    originalCompareAt: 8999,
    discountPercent: row.discountPercent,
    salePrice: row.salePrice,
    listPrice: 8999,
    appliedAt: new Date().toISOString(),
    _livePrice: Number(variant.price),
    _status: product.status || "",
  };
}

async function main() {
  const rows = parsePlan(PLAN_PATH);
  if (rows.length !== 150) {
    throw new Error(`Expected 150 locked rows, parsed ${rows.length}.`);
  }
  const skus = new Set(rows.map((row) => row.sku));
  if (skus.size !== 150) {
    throw new Error("Locked SKU list has duplicates.");
  }

  const state = loadSaleState();
  const existing = state.items || [];
  const existingSkus = new Set(existing.map((item) => item.sku));
  const overlap = [...skus].filter((sku) => existingSkus.has(sku));
  if (overlap.length) {
    throw new Error(`Locked SKUs already on sale: ${overlap.join(", ")}`);
  }
  const fingerprint = existing.map(
    (item) => `${item.variantId}|${item.salePrice}|${item.discountPercent}`
  );

  const credentials = getShopifyCredentials();
  if (!credentials.storeDomain || !credentials.accessToken) {
    throw new Error("Shopify is not connected.");
  }

  const added = [];
  const errors = [];
  const priceWarnings = [];

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    try {
      const variant = await resolveSku(
        credentials.storeDomain,
        credentials.accessToken,
        row.sku
      );
      if (!variant?.product?.id) {
        throw new Error("Variant not found.");
      }
      const item = buildItem(row, variant);
      if (!/24\s*["″']?\s*[x×]\s*["″']?\s*36/i.test(item.size)) {
        throw new Error(`Unexpected size: ${item.size}`);
      }
      if (item.frame.toLowerCase() !== row.frame.toLowerCase()) {
        throw new Error(`Frame mismatch: live ${item.frame}, plan ${row.frame}`);
      }
      if (item._livePrice !== row.originalPrice) {
        priceWarnings.push(`${row.sku} live ${item._livePrice}`);
      }
      const { _livePrice, _status, ...saleItem } = item;
      const applyErrors = await applySaleItems(
        credentials.storeDomain,
        credentials.accessToken,
        [saleItem]
      );
      if (applyErrors.length) {
        throw new Error(applyErrors.map((error) => error.message).join("; "));
      }
      added.push(saleItem);
      const latest = loadSaleState();
      latest.items = existing.concat(added);
      latest.discountMin = state.discountMin;
      latest.discountMax = state.discountMax;
      saveSaleState(latest);
      if ((i + 1) % 10 === 0 || i === rows.length - 1) {
        console.log(`applied ${i + 1}/${rows.length} ${row.sku} -> ${row.salePrice}`);
      }
    } catch (error) {
      errors.push({ sku: row.sku, message: error.message || String(error) });
      console.error(`fail ${row.sku}: ${error.message || error}`);
    }
    await sleep(40);
  }

  const after = loadSaleState();
  const afterFingerprint = (after.items || [])
    .slice(0, existing.length)
    .map((item) => `${item.variantId}|${item.salePrice}|${item.discountPercent}`);
  const preserved =
    fingerprint.length === afterFingerprint.length &&
    fingerprint.every((value, index) => value === afterFingerprint[index]);

  console.log(
    JSON.stringify(
      {
        existing: existing.length,
        added: added.length,
        total: (after.items || []).length,
        preserved,
        discountMin: after.discountMin,
        discountMax: after.discountMax,
        errors,
        priceWarnings,
      },
      null,
      2
    )
  );
  if (!preserved || errors.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
