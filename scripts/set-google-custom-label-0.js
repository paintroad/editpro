/**
 * Set mm-google-shopping.custom_label_0 = "trendy" on all products
 * in the Google Shopping Feed collection.
 *
 * Run:
 *   node editpro/scripts/set-google-custom-label-0.js --dry-run
 *   node editpro/scripts/set-google-custom-label-0.js
 */
const { getShopifyCredentials } = require("../lib/config-store");
const { shopifyGraphql } = require("../lib/shopify-client");
const { fetchProductsByCollectionHandles } = require("../lib/marketplace/shopify-collections-fetcher");

const COLLECTION_HANDLE = "google-shopping-feed";
const NAMESPACE = "mm-google-shopping";
const KEY = "custom_label_0";
const VALUE = "trendy";
const METAFIELD_TYPE = "single_line_text_field";
const BATCH_SIZE = 25;

const METAFIELDS_SET = `mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
  metafieldsSet(metafields: $metafields) {
    metafields { id namespace key value }
    userErrors { field message }
  }
}`;

function isDryRun(argv = process.argv) {
  return argv.includes("--dry-run");
}

async function setCustomLabelBatch(storeDomain, accessToken, products) {
  const metafields = products.map((product) => ({
    ownerId: product.id,
    namespace: NAMESPACE,
    key: KEY,
    type: METAFIELD_TYPE,
    value: VALUE,
  }));

  const data = await shopifyGraphql(storeDomain, accessToken, METAFIELDS_SET, { metafields });
  const errors = data.metafieldsSet?.userErrors || [];
  if (errors.length) {
    throw new Error(errors.map((e) => e.message).join("; "));
  }
  return data.metafieldsSet?.metafields?.length || 0;
}

async function verifyOne(storeDomain, accessToken, handle) {
  const data = await shopifyGraphql(
    storeDomain,
    accessToken,
    `query($handle: String!) {
      productByHandle(handle: $handle) {
        handle
        metafield(namespace: "${NAMESPACE}", key: "${KEY}") {
          value
        }
      }
    }`,
    { handle }
  );
  return data.productByHandle;
}

async function main() {
  const dryRun = isDryRun();
  const { storeDomain, accessToken } = getShopifyCredentials();

  console.log(`Loading products from collection: ${COLLECTION_HANDLE}`);
  const { products, warnings } = await fetchProductsByCollectionHandles(
    storeDomain,
    accessToken,
    [COLLECTION_HANDLE]
  );

  if (warnings?.length) {
    console.log("Warnings:", warnings.join(" | "));
  }

  const withIds = products.filter((p) => p?.id);
  console.log(`Products found: ${withIds.length}`);
  console.log(
    "Sample handles:",
    withIds
      .slice(0, 5)
      .map((p) => p.handle)
      .join(", ")
  );
  console.log(`Will set ${NAMESPACE}.${KEY} = "${VALUE}"`);

  if (!withIds.length) {
    throw new Error("No products found in collection.");
  }

  if (dryRun) {
    console.log("Dry run only — no metafields written.");
    return;
  }

  let updated = 0;
  for (let i = 0; i < withIds.length; i += BATCH_SIZE) {
    const chunk = withIds.slice(i, i + BATCH_SIZE);
    const count = await setCustomLabelBatch(storeDomain, accessToken, chunk);
    updated += count;
    console.log(`Updated ${Math.min(i + chunk.length, withIds.length)} / ${withIds.length}`);
  }

  const spot = withIds.find((p) => p.handle === "kaleidoscope-queen") || withIds[0];
  const verified = await verifyOne(storeDomain, accessToken, spot.handle);
  console.log(
    `Spot-check ${verified?.handle}: ${NAMESPACE}.${KEY} = ${JSON.stringify(verified?.metafield?.value)}`
  );
  console.log(`Done. Metafields written: ${updated}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
