/**
 * One-off job: set vendor = "Paintroad" on every Shopify product.
 * Consolidates existing vendor strings (e.g. "Paint Road", "Royal Creations")
 * into a single "Paintroad" vendor. Products already set to "Paintroad" are skipped.
 *
 * Run: node editpro/scripts/change-vendor.js
 */
const { shopifyGraphql } = require("../lib/shopify-client");
const { getShopifyCredentials } = require("../lib/config-store");

const TARGET_VENDOR = "Paintroad";
const PAGE_SIZE = 250;
const CONCURRENCY = 3;

const PRODUCTS_QUERY = `query Products($cursor: String) {
  products(first: ${PAGE_SIZE}, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes { id title vendor }
  }
}`;

const UPDATE_MUTATION = `mutation UpdateVendor($input: ProductInput!) {
  productUpdate(input: $input) {
    product { id vendor }
    userErrors { field message }
  }
}`;

async function fetchAllProducts(storeDomain, accessToken) {
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

async function updateVendor(storeDomain, accessToken, product) {
  const data = await shopifyGraphql(storeDomain, accessToken, UPDATE_MUTATION, {
    input: { id: product.id, vendor: TARGET_VENDOR },
  });
  const errors = data.productUpdate?.userErrors || [];
  if (errors.length) {
    throw new Error(errors.map((e) => e.message).join("; "));
  }
  return data.productUpdate.product;
}

async function run() {
  const { storeDomain, accessToken } = getShopifyCredentials();
  if (!storeDomain || !accessToken) {
    throw new Error("Shopify is not connected. Configure store credentials in Settings.");
  }

  console.log("Fetching products...");
  const all = await fetchAllProducts(storeDomain, accessToken);
  const toUpdate = all.filter((p) => (p.vendor || "").trim() !== TARGET_VENDOR);
  console.log(
    `Total products: ${all.length}. Already "${TARGET_VENDOR}": ${all.length - toUpdate.length}. To update: ${toUpdate.length}.`
  );

  const queue = [...toUpdate];
  let done = 0;
  let failed = 0;
  const vendorCounts = {};

  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    while (queue.length) {
      const product = queue.shift();
      const oldVendor = product.vendor || "(blank)";
      try {
        await updateVendor(storeDomain, accessToken, product);
        vendorCounts[oldVendor] = (vendorCounts[oldVendor] || 0) + 1;
        done += 1;
        console.log(`OK   ${oldVendor} -> ${TARGET_VENDOR}  |  ${product.title}`);
      } catch (error) {
        failed += 1;
        console.error(`FAIL ${product.title} (${product.id}): ${error.message}`);
      }
    }
  });

  await Promise.all(workers);

  console.log("\n--- Summary ---");
  console.log(`Updated: ${done}  Failed: ${failed}`);
  console.log("Consolidated from:", JSON.stringify(vendorCounts, null, 2));
}

run().catch((error) => {
  console.error("Vendor job failed:", error.message);
  process.exitCode = 1;
});
