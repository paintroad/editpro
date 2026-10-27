/**
 * List live products in god/lord collections whose media filename contains "bathroom".
 * Read-only. Writes a JSON inventory; does not download or delete media.
 */
const fs = require("fs");
const path = require("path");
const { shopifyGraphql } = require("../lib/shopify-client");
const { getShopifyCredentials } = require("../lib/config-store");
const { hasDeityText } = require("../lib/deity-bathroom");

const OUT = process.argv[2] || path.join("C:\\Users\\divya\\Downloads\\Bathroom Cleanup", "bathroom-gods-list.json");

function filenameFromUrl(url) {
  const raw = String(url || "").split("?")[0];
  const base = raw.split("/").pop() || "";
  try {
    return decodeURIComponent(base);
  } catch {
    return base;
  }
}

async function main() {
  const { storeDomain, accessToken } = getShopifyCredentials();
  const collections = [];
  let cursor = null;
  do {
    const data = await shopifyGraphql(
      storeDomain,
      accessToken,
      `query ($c: String) {
        collections(first: 100, after: $c) {
          pageInfo { hasNextPage endCursor }
          nodes { id title handle }
        }
      }`,
      { c: cursor }
    );
    collections.push(...(data.collections?.nodes || []));
    const page = data.collections?.pageInfo;
    cursor = page?.hasNextPage ? page.endCursor : null;
  } while (cursor);

  const gods = collections.filter((col) => hasDeityText(col.title) || hasDeityText(col.handle));
  const byProduct = new Map();

  for (const col of gods) {
    let productCursor = null;
    do {
      const data = await shopifyGraphql(
        storeDomain,
        accessToken,
        `query ($id: ID!, $c: String) {
          collection(id: $id) {
            products(first: 40, after: $c) {
              pageInfo { hasNextPage endCursor }
              nodes {
                id
                title
                handle
                status
                tags
                media(first: 40) {
                  nodes {
                    id
                    alt
                    ... on MediaImage { image { url } }
                  }
                }
              }
            }
          }
        }`,
        { id: col.id, c: productCursor }
      );
      const conn = data.collection?.products;
      for (const product of conn?.nodes || []) {
        let row = byProduct.get(product.id);
        if (!row) {
          row = {
            id: product.id,
            numericId: String(product.id).split("/").pop(),
            title: product.title,
            handle: product.handle,
            status: product.status,
            tags: product.tags || [],
            collections: [],
            bathroomImages: [],
          };
          byProduct.set(product.id, row);
        }
        if (!row.collections.includes(col.title)) row.collections.push(col.title);
        for (const media of product.media?.nodes || []) {
          const url = media.image?.url || "";
          const filename = filenameFromUrl(url);
          if (!/bathroom/i.test(filename) && !/bathroom/i.test(media.alt || "")) continue;
          if (row.bathroomImages.some((img) => img.mediaId === media.id)) continue;
          row.bathroomImages.push({
            mediaId: media.id,
            filename,
            alt: media.alt || "",
            url,
          });
        }
      }
      const page = conn?.pageInfo;
      productCursor = page?.hasNextPage ? page.endCursor : null;
    } while (productCursor);
  }

  const hits = [...byProduct.values()]
    .filter((row) => row.bathroomImages.length)
    .sort((a, b) => a.title.localeCompare(b.title));

  const report = {
    scannedAt: new Date().toISOString(),
    collections: gods.map((col) => ({ title: col.title, handle: col.handle, id: col.id })),
    productsInGodCollections: byProduct.size,
    productsWithBathroomImage: hits.length,
    bathroomImages: hits.reduce((sum, row) => sum + row.bathroomImages.length, 0),
    products: hits,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2), "utf8");
  console.log(
    JSON.stringify(
      {
        out: OUT,
        collections: report.collections.map((c) => c.title),
        productsInGodCollections: report.productsInGodCollections,
        productsWithBathroomImage: report.productsWithBathroomImage,
        bathroomImages: report.bathroomImages,
        products: hits.map((row) => ({
          title: row.title,
          handle: row.handle,
          collections: row.collections,
          images: row.bathroomImages.map((img) => img.filename),
        })),
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
