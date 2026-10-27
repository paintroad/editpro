/**
 * Download bathroom images for god/lord products, then delete only that media on Shopify.
 * Products, other images, and variants are left in place.
 */
const fs = require("fs");
const path = require("path");
const { shopifyGraphql } = require("../lib/shopify-client");
const { getShopifyCredentials } = require("../lib/config-store");

const LIST = "C:\\Users\\divya\\Downloads\\Bathroom Cleanup\\bathroom-gods-list.json";
const ROOT = "C:\\Users\\divya\\Downloads\\Bathroom Cleanup";
const RESULT = path.join(ROOT, "bathroom-cleanup-result.json");

function filenameFromUrl(url) {
  const raw = String(url || "").split("?")[0];
  const base = raw.split("/").pop() || "";
  try {
    return decodeURIComponent(base);
  } catch {
    return base;
  }
}

async function mapPool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => run()));
  return results;
}

async function downloadFile(url, dest) {
  if (fs.existsSync(dest) && fs.statSync(dest).size > 1000) {
    return { bytes: fs.statSync(dest).size, skipped: true };
  }
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Download failed ${response.status} for ${url}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 1000) {
    throw new Error(`Download too small (${bytes.length} bytes) for ${url}`);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const partial = `${dest}.partial`;
  fs.writeFileSync(partial, bytes);
  fs.renameSync(partial, dest);
  return { bytes: bytes.length, skipped: false };
}

async function deleteMedia(storeDomain, accessToken, productId, mediaId) {
  const data = await shopifyGraphql(
    storeDomain,
    accessToken,
    `mutation ProductDeleteMedia($productId: ID!, $mediaIds: [ID!]!) {
      productDeleteMedia(productId: $productId, mediaIds: $mediaIds) {
        deletedMediaIds
        mediaUserErrors { field message }
      }
    }`,
    { productId, mediaIds: [mediaId] }
  );
  const result = data.productDeleteMedia;
  const errors = result?.mediaUserErrors || [];
  if (errors.length) {
    throw new Error(errors.map((error) => error.message).join("; "));
  }
  const deleted = result?.deletedMediaIds || [];
  if (!deleted.includes(mediaId)) {
    throw new Error(`Shopify did not confirm deletion of ${mediaId}`);
  }
  return deleted;
}

async function remainingBathroom(storeDomain, accessToken, ids) {
  const found = [];
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const data = await shopifyGraphql(
      storeDomain,
      accessToken,
      `query ($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on Product {
            id
            title
            media(first: 40) {
              nodes {
                ... on MediaImage { image { url } }
              }
            }
          }
        }
      }`,
      { ids: chunk }
    );
    for (const node of data.nodes || []) {
      if (!node?.id) continue;
      for (const media of node.media?.nodes || []) {
        const filename = filenameFromUrl(media.image?.url || "");
        if (/bathroom/i.test(filename)) {
          found.push({ id: node.id, title: node.title, filename });
        }
      }
    }
  }
  return found;
}

async function main() {
  const report = JSON.parse(fs.readFileSync(LIST, "utf8"));
  const jobs = [];
  for (const product of report.products) {
    for (const image of product.bathroomImages || []) {
      if (!/bathroom/i.test(image.filename || "")) {
        throw new Error(`Refusing non-bathroom file on ${product.title}: ${image.filename}`);
      }
      jobs.push({
        productId: product.id,
        title: product.title,
        handle: product.handle,
        mediaId: image.mediaId,
        filename: image.filename,
        url: image.url,
        dest: path.join(ROOT, image.filename),
      });
    }
  }

  console.log(`Downloading ${jobs.length} bathroom images...`);
  const downloaded = await mapPool(jobs, 6, async (job, index) => {
    const file = await downloadFile(job.url, job.dest);
    if ((index + 1) % 20 === 0 || index === jobs.length - 1) {
      console.log(`downloaded ${index + 1}/${jobs.length}`);
    }
    return { ...job, bytes: file.bytes, downloadSkipped: file.skipped };
  });

  const { storeDomain, accessToken } = getShopifyCredentials();
  console.log(`Deleting ${downloaded.length} media files from Shopify...`);
  const deleted = await mapPool(downloaded, 3, async (job, index) => {
    await deleteMedia(storeDomain, accessToken, job.productId, job.mediaId);
    if ((index + 1) % 20 === 0 || index === jobs.length - 1) {
      console.log(`deleted ${index + 1}/${jobs.length}`);
    }
    return {
      title: job.title,
      handle: job.handle,
      filename: job.filename,
      bytes: job.bytes,
      dest: job.dest,
      mediaId: job.mediaId,
      productId: job.productId,
    };
  });

  const stillThere = await remainingBathroom(
    storeDomain,
    accessToken,
    [...new Set(deleted.map((row) => row.productId))]
  );

  const summary = {
    finishedAt: new Date().toISOString(),
    downloaded: deleted.length,
    deleted: deleted.length,
    bytes: deleted.reduce((sum, row) => sum + row.bytes, 0),
    remainingBathroomImages: stillThere,
    files: deleted,
  };
  fs.writeFileSync(RESULT, JSON.stringify(summary, null, 2), "utf8");
  console.log(
    JSON.stringify(
      {
        downloaded: summary.downloaded,
        deleted: summary.deleted,
        bytes: summary.bytes,
        remainingBathroomImages: stillThere.length,
        result: RESULT,
      },
      null,
      2
    )
  );
  if (stillThere.length) process.exitCode = 2;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
