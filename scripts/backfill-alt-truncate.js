/**
 * Recompute description100/160 (word-boundary, no ellipsis) and regenerate
 * lifestyleImages[].alt from the current product SEO imageAlt rule.
 * Optionally fileUpdate alts on a short list of live Shopify products.
 *
 * Usage:
 *   node scripts/backfill-alt-truncate.js
 *   node scripts/backfill-alt-truncate.js --shopify
 */
const { loadConfig } = require("../lib/config-store");
const { truncate } = require("../lib/catalog-text-utils");
const { loadCatalogStore, saveCatalogStore, getProduct } = require("../lib/catalog-products-store");
const {
  catalogProductImages,
  applyTemplate,
  catalogProductContext,
  stripHtml,
} = require("../lib/catalog-seo-fix");
const { getShopifyCredentials } = require("../lib/config-store");
const { shopifyGraphql } = require("../lib/shopify-client");

const LIVE_PRODUCT_IDS = ["11524", "11522", "11525", "11523"];
const pushShopify = process.argv.includes("--shopify");

function recomputeDescriptions(product) {
  const description = stripHtml(product.descriptionHtml || product.descriptionPlain || "");
  const description100 = truncate(description, 100);
  const description160 = truncate(description, 160);
  return { description, description100, description160 };
}

function regenerateLifestyleAlts(product, rules, shopName, roomFallbacks) {
  const images = catalogProductImages(product);
  if (!images.length) {
    return { updated: 0, sample: null };
  }
  const roomFallbackCache = {};
  const usedRooms = new Set();
  let updated = 0;
  let sample = null;

  for (const imageEntry of images) {
    const imageIndex = imageEntry.catalogGalleryIndex;
    const listIndex = imageEntry.lifestyleListIndex;
    const ctx = catalogProductContext(
      product,
      imageEntry,
      imageIndex,
      shopName,
      roomFallbacks,
      roomFallbackCache,
      usedRooms
    );
    const alt = applyTemplate(rules.imageAlt, ctx);
    if (!sample && alt) {
      sample = alt;
    }
    const target = product.lifestyleImages[listIndex];
    if (!target) {
      continue;
    }
    if ((target.alt || "") !== alt) {
      target.alt = alt;
      updated += 1;
    } else if (!target.alt && alt) {
      target.alt = alt;
      updated += 1;
    }
  }
  return { updated, sample };
}

async function fetchProductMedia(storeDomain, accessToken, productGid) {
  const data = await shopifyGraphql(
    storeDomain,
    accessToken,
    `query($id: ID!) {
      product(id: $id) {
        id
        title
        media(first: 50) {
          nodes {
            ... on MediaImage {
              id
              alt
              image { url }
            }
          }
        }
      }
    }`,
    { id: productGid }
  );
  return data.product;
}

async function fileUpdateAlts(storeDomain, accessToken, updates) {
  if (!updates.length) {
    return;
  }
  // Batch in chunks of 10
  for (let i = 0; i < updates.length; i += 10) {
    const chunk = updates.slice(i, i + 10);
    const data = await shopifyGraphql(
      storeDomain,
      accessToken,
      `mutation FileUpdate($files: [FileUpdateInput!]!) {
        fileUpdate(files: $files) {
          userErrors { field message }
        }
      }`,
      {
        files: chunk.map((row) => ({ id: row.id, alt: row.alt })),
      }
    );
    const errors = data.fileUpdate?.userErrors || [];
    if (errors.length) {
      throw new Error(errors.map((e) => e.message).join("; "));
    }
  }
}

async function pushShopifyAlts(store) {
  const credentials = getShopifyCredentials();
  if (!credentials.storeDomain || !credentials.accessToken) {
    throw new Error("Shopify is not connected.");
  }

  for (const productId of LIVE_PRODUCT_IDS) {
    const product = getProduct(productId, store);
    if (!product?.shopifyProductId) {
      console.warn(`Skip ${productId}: missing shopifyProductId`);
      continue;
    }
    const localImages = catalogProductImages(product);
    const remote = await fetchProductMedia(
      credentials.storeDomain,
      credentials.accessToken,
      product.shopifyProductId
    );
    const media = (remote?.media?.nodes || []).filter((n) => n?.id);
    console.log(
      `\n${product.title} local=${localImages.length} remoteMedia=${media.length}`
    );

    const count = Math.min(localImages.length, media.length);
    const updates = [];
    for (let i = 0; i < count; i++) {
      const nextAlt = localImages[i].alt || "";
      const prevAlt = media[i].alt || "";
      if (nextAlt === prevAlt) {
        continue;
      }
      updates.push({ id: media[i].id, alt: nextAlt, prev: prevAlt });
      if (updates.length <= 2) {
        console.log(`  [${i + 1}] ${prevAlt.slice(0, 70)}…`);
        console.log(`      → ${nextAlt.slice(0, 90)}`);
      }
    }
    console.log(`  Updating ${updates.length} media alts…`);
    await fileUpdateAlts(credentials.storeDomain, credentials.accessToken, updates);
    console.log(`  Done.`);
  }
}

function main() {
  const config = loadConfig();
  const rules = config.rules?.product || {};
  const shopName = config.shopify?.shopName || "";
  const roomFallbacks =
    Array.isArray(config.roomFallbacks) && config.roomFallbacks.length
      ? config.roomFallbacks
      : ["Hall", "Living Room", "Bedroom", "Office"];

  if (!rules.imageAlt) {
    throw new Error("No product imageAlt rule in config.");
  }
  console.log(`imageAlt rule: ${rules.imageAlt}`);

  const store = loadCatalogStore();
  let productsTouched = 0;
  let descUpdated = 0;
  let altsUpdated = 0;
  let withEllipsisBefore = 0;
  let sampleBefore = null;
  let sampleAfter = null;

  for (const product of Object.values(store.products || {})) {
    const beforeDesc100 = product.description100 || "";
    if (beforeDesc100.includes("…") || beforeDesc100.includes("...")) {
      withEllipsisBefore += 1;
    }
    for (const img of product.lifestyleImages || []) {
      if (!sampleBefore && img.alt && (img.alt.includes("…") || img.alt.includes("..."))) {
        sampleBefore = img.alt;
      }
    }

    const { description100, description160 } = recomputeDescriptions(product);
    let touched = false;
    if (product.description100 !== description100) {
      product.description100 = description100;
      descUpdated += 1;
      touched = true;
    }
    if (product.description160 !== description160) {
      product.description160 = description160;
      touched = true;
    }

    // Context prefers stored description100 — already updated above.
    const { updated, sample } = regenerateLifestyleAlts(
      product,
      rules,
      shopName,
      roomFallbacks
    );
    if (updated > 0) {
      altsUpdated += updated;
      touched = true;
    }
    if (!sampleAfter && sample) {
      sampleAfter = sample;
    }
    if (touched) {
      productsTouched += 1;
    }
  }

  saveCatalogStore(store);
  console.log(
    JSON.stringify(
      {
        productsTouched,
        descUpdated,
        altsUpdated,
        withEllipsisBefore,
        sampleBefore,
        sampleAfter,
      },
      null,
      2
    )
  );

  if (!pushShopify) {
    return;
  }
  return pushShopifyAlts(store);
}

Promise.resolve()
  .then(() => main())
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
