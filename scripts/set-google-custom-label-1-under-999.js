/**
 * Set mm-google-shopping.custom_label_1 = "under_999" on every live
 * Shopify variant priced under 999 INR.
 *
 * Run:
 *   node editpro/scripts/set-google-custom-label-1-under-999.js --dry-run
 *   node editpro/scripts/set-google-custom-label-1-under-999.js
 */
const { getShopifyCredentials } = require("../lib/config-store");
const { shopifyGraphql } = require("../lib/shopify-client");

const NAMESPACE = "mm-google-shopping";
const KEY = "custom_label_1";
const VALUE = "under_999";
const METAFIELD_TYPE = "single_line_text_field";
const PRICE_THRESHOLD = 999;
const PRODUCT_PAGE_SIZE = 50;
const VARIANT_PAGE_SIZE = 100;
const BATCH_SIZE = 25;

const PRODUCTS_QUERY = `query ActiveProducts($cursor: String) {
  products(first: ${PRODUCT_PAGE_SIZE}, after: $cursor, query: "status:active") {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      handle
      variants(first: ${VARIANT_PAGE_SIZE}) {
        pageInfo { hasNextPage endCursor }
        nodes { id sku price }
      }
    }
  }
}`;

const MORE_VARIANTS_QUERY = `query MoreVariants($id: ID!, $cursor: String) {
  product(id: $id) {
    variants(first: ${VARIANT_PAGE_SIZE}, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { id sku price }
    }
  }
}`;

const METAFIELDS_SET = `mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
  metafieldsSet(metafields: $metafields) {
    metafields { id namespace key value }
    userErrors { field message }
  }
}`;

function isDryRun(argv = process.argv) {
  return argv.includes("--dry-run");
}

function isUnderThreshold(price) {
  return Number(price) < PRICE_THRESHOLD;
}

async function fetchAllVariantsForProduct(storeDomain, accessToken, product) {
  const variants = [...(product.variants?.nodes || [])];
  let hasNext = product.variants?.pageInfo?.hasNextPage;
  let cursor = product.variants?.pageInfo?.endCursor;

  while (hasNext) {
    const data = await shopifyGraphql(storeDomain, accessToken, MORE_VARIANTS_QUERY, {
      id: product.id,
      cursor,
    });
    const page = data.product?.variants;
    variants.push(...(page?.nodes || []));
    hasNext = page?.pageInfo?.hasNextPage;
    cursor = page?.pageInfo?.endCursor;
  }

  return variants.map((v) => ({
    ...v,
    productHandle: product.handle,
    productId: product.id,
  }));
}

async function fetchActiveVariants(storeDomain, accessToken) {
  const variants = [];
  let cursor = null;
  let hasNext = true;
  let productCount = 0;

  while (hasNext) {
    const data = await shopifyGraphql(storeDomain, accessToken, PRODUCTS_QUERY, { cursor });
    const page = data.products;
    const nodes = page.nodes || [];
    productCount += nodes.length;

    for (const product of nodes) {
      const productVariants = await fetchAllVariantsForProduct(storeDomain, accessToken, product);
      variants.push(...productVariants);
    }

    hasNext = page.pageInfo?.hasNextPage;
    cursor = page.pageInfo?.endCursor;
    console.log(`Fetched products: ${productCount}, variants so far: ${variants.length}`);
  }

  return { productCount, variants };
}

async function setCustomLabelBatch(storeDomain, accessToken, variants) {
  const metafields = variants.map((variant) => ({
    ownerId: variant.id,
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

async function verifyVariant(storeDomain, accessToken, variantId) {
  const data = await shopifyGraphql(
    storeDomain,
    accessToken,
    `query($id: ID!) {
      productVariant(id: $id) {
        id
        sku
        price
        metafield(namespace: "${NAMESPACE}", key: "${KEY}") {
          value
        }
      }
    }`,
    { id: variantId }
  );
  return data.productVariant;
}

async function main() {
  const dryRun = isDryRun();
  const { storeDomain, accessToken } = getShopifyCredentials();
  if (!storeDomain || !accessToken) {
    throw new Error("Shopify is not connected. Configure store credentials in Settings.");
  }

  console.log(`Loading active products and variants (price < ${PRICE_THRESHOLD})...`);
  const { productCount, variants } = await fetchActiveVariants(storeDomain, accessToken);
  const under999 = variants.filter((v) => isUnderThreshold(v.price));
  const atOrAbove = variants.length - under999.length;

  console.log(`Active products: ${productCount}`);
  console.log(`Total variants: ${variants.length}`);
  console.log(`Under ${PRICE_THRESHOLD}: ${under999.length}`);
  console.log(`At or above ${PRICE_THRESHOLD}: ${atOrAbove}`);
  console.log(
    "Sample under-threshold:",
    under999
      .slice(0, 5)
      .map((v) => `${v.sku || v.id} @ ${v.price}`)
      .join(", ") || "(none)"
  );
  console.log(`Will set ${NAMESPACE}.${KEY} = "${VALUE}" on under-threshold variants`);

  if (!under999.length) {
    console.log("Nothing to update.");
    return;
  }

  if (dryRun) {
    console.log("Dry run only — no metafields written.");
    return;
  }

  let updated = 0;
  for (let i = 0; i < under999.length; i += BATCH_SIZE) {
    const chunk = under999.slice(i, i + BATCH_SIZE);
    const count = await setCustomLabelBatch(storeDomain, accessToken, chunk);
    updated += count;
    console.log(`Updated ${Math.min(i + chunk.length, under999.length)} / ${under999.length}`);
  }

  const underSpot = under999.find((v) => Number(v.price) === 699) || under999[0];
  const aboveSpot = variants.find((v) => Number(v.price) >= PRICE_THRESHOLD);

  const underVerified = await verifyVariant(storeDomain, accessToken, underSpot.id);
  console.log(
    `Spot-check under: ${underVerified?.sku} @ ${underVerified?.price} → ${NAMESPACE}.${KEY} = ${JSON.stringify(underVerified?.metafield?.value)}`
  );

  if (aboveSpot) {
    const aboveVerified = await verifyVariant(storeDomain, accessToken, aboveSpot.id);
    console.log(
      `Spot-check >=${PRICE_THRESHOLD}: ${aboveVerified?.sku} @ ${aboveVerified?.price} → ${NAMESPACE}.${KEY} = ${JSON.stringify(aboveVerified?.metafield?.value)}`
    );
  }

  console.log(`Done. Metafields written: ${updated}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
