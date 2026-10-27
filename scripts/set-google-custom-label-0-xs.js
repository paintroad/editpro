/**
 * Set mm-google-shopping.custom_label_0 = "under_999" on every live
 * Shopify variant whose size is XS. Product-level custom_label_0 is unchanged.
 *
 * Run:
 *   node scripts/set-google-custom-label-0-xs.js --dry-run
 *   node scripts/set-google-custom-label-0-xs.js
 */
const { getShopifyCredentials } = require("../lib/config-store");
const { shopifyGraphql } = require("../lib/shopify-client");

const NAMESPACE = "mm-google-shopping";
const KEY = "custom_label_0";
const VALUE = "under_999";
const METAFIELD_TYPE = "single_line_text_field";
const PRODUCT_PAGE_SIZE = 40;
const VARIANT_PAGE_SIZE = 100;
const BATCH_SIZE = 25;

const PRODUCTS_QUERY = `query ActiveProducts($cursor: String) {
  products(first: ${PRODUCT_PAGE_SIZE}, after: $cursor, query: "status:active") {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      handle
      label0: metafield(namespace: "${NAMESPACE}", key: "${KEY}") { value }
      variants(first: ${VARIANT_PAGE_SIZE}) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          sku
          price
          selectedOptions { name value }
        }
      }
    }
  }
}`;

const MORE_VARIANTS_QUERY = `query MoreVariants($id: ID!, $cursor: String) {
  product(id: $id) {
    variants(first: ${VARIANT_PAGE_SIZE}, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        sku
        price
        selectedOptions { name value }
      }
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function gql(storeDomain, accessToken, query, variables = {}, attempt = 0) {
  try {
    return await shopifyGraphql(storeDomain, accessToken, query, variables);
  } catch (err) {
    if (/throttl/i.test(String(err.message || err)) && attempt < 12) {
      const wait = Math.min(60000, 2000 * 2 ** Math.min(attempt, 5));
      console.warn(`Throttled — retry in ${wait}ms`);
      await sleep(wait);
      return gql(storeDomain, accessToken, query, variables, attempt + 1);
    }
    throw err;
  }
}

function isXsVariant(variant) {
  const size = (variant.selectedOptions || []).find((option) =>
    /size/i.test(option.name || "")
  );
  if (size && /^(XS)\b/i.test(String(size.value || "").trim())) return true;
  return /-(XS)-\d+$/i.test(String(variant.sku || ""));
}

function sizeLabel(variant) {
  const size = (variant.selectedOptions || []).find((option) =>
    /size/i.test(option.name || "")
  );
  return size?.value || "";
}

async function fetchAllVariantsForProduct(storeDomain, accessToken, product) {
  const variants = [...(product.variants?.nodes || [])];
  let hasNext = product.variants?.pageInfo?.hasNextPage;
  let cursor = product.variants?.pageInfo?.endCursor;

  while (hasNext) {
    const data = await gql(storeDomain, accessToken, MORE_VARIANTS_QUERY, {
      id: product.id,
      cursor,
    });
    const page = data.product?.variants;
    variants.push(...(page?.nodes || []));
    hasNext = page?.pageInfo?.hasNextPage;
    cursor = page?.pageInfo?.endCursor;
  }

  return variants.map((variant) => ({
    ...variant,
    productHandle: product.handle,
    productId: product.id,
    productLabel0: product.label0?.value || "",
  }));
}

async function fetchActiveVariants(storeDomain, accessToken) {
  const variants = [];
  let cursor = null;
  let hasNext = true;
  let productCount = 0;

  while (hasNext) {
    const data = await gql(storeDomain, accessToken, PRODUCTS_QUERY, { cursor });
    const page = data.products;
    const nodes = page.nodes || [];
    productCount += nodes.length;

    for (const product of nodes) {
      const productVariants = await fetchAllVariantsForProduct(
        storeDomain,
        accessToken,
        product
      );
      variants.push(...productVariants);
    }

    hasNext = page.pageInfo?.hasNextPage;
    cursor = page.pageInfo?.endCursor;
    if (productCount % 200 === 0 || !hasNext) {
      console.log(`Fetched products: ${productCount}, variants so far: ${variants.length}`);
    }
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

  const data = await gql(storeDomain, accessToken, METAFIELDS_SET, { metafields });
  const errors = data.metafieldsSet?.userErrors || [];
  if (errors.length) {
    throw new Error(errors.map((error) => error.message).join("; "));
  }
  return data.metafieldsSet?.metafields?.length || 0;
}

async function verifyVariant(storeDomain, accessToken, variantId) {
  const data = await gql(
    storeDomain,
    accessToken,
    `query($id: ID!) {
      productVariant(id: $id) {
        id
        sku
        price
        product {
          handle
          metafield(namespace: "${NAMESPACE}", key: "${KEY}") { value }
        }
        metafield(namespace: "${NAMESPACE}", key: "${KEY}") { value }
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

  console.log("Loading active products and variants (XS size only)...");
  const { productCount, variants } = await fetchActiveVariants(storeDomain, accessToken);
  const xs = variants.filter(isXsVariant);
  const other = variants.filter((variant) => !isXsVariant(variant));

  console.log(`Active products: ${productCount}`);
  console.log(`Total variants: ${variants.length}`);
  console.log(`XS variants: ${xs.length}`);
  console.log(`Other variants: ${other.length}`);
  console.log(
    "Sample XS:",
    xs
      .slice(0, 5)
      .map((variant) => `${variant.sku || variant.id} (${sizeLabel(variant) || "sku"})`)
      .join(", ") || "(none)"
  );
  console.log(`Will set variant ${NAMESPACE}.${KEY} = "${VALUE}"`);
  console.log("Product custom_label_0 is not modified.");

  if (!xs.length) {
    console.log("Nothing to update.");
    return;
  }

  if (dryRun) {
    console.log("Dry run only — no metafields written.");
    return;
  }

  let updated = 0;
  for (let i = 0; i < xs.length; i += BATCH_SIZE) {
    const chunk = xs.slice(i, i + BATCH_SIZE);
    const count = await setCustomLabelBatch(storeDomain, accessToken, chunk);
    updated += count;
    const done = Math.min(i + chunk.length, xs.length);
    if (done % 500 === 0 || done === xs.length) {
      console.log(`Updated ${done} / ${xs.length}`);
    }
    await sleep(80);
  }

  const xsSpot = xs[0];
  const otherSpot = other[0];
  const xsVerified = await verifyVariant(storeDomain, accessToken, xsSpot.id);
  console.log(
    `Spot-check XS: ${xsVerified?.sku} variant ${NAMESPACE}.${KEY} = ${JSON.stringify(xsVerified?.metafield?.value)}; product ${NAMESPACE}.${KEY} = ${JSON.stringify(xsVerified?.product?.metafield?.value)}`
  );

  if (otherSpot) {
    const otherVerified = await verifyVariant(storeDomain, accessToken, otherSpot.id);
    console.log(
      `Spot-check other: ${otherVerified?.sku} variant ${NAMESPACE}.${KEY} = ${JSON.stringify(otherVerified?.metafield?.value)}; product ${NAMESPACE}.${KEY} = ${JSON.stringify(otherVerified?.product?.metafield?.value)}`
    );
  }

  console.log(`Done. Metafields written: ${updated}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
