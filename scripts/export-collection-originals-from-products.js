#!/usr/bin/env node
/**
 * Export original (uncropped) first product images for collections that do
 * not already have a matching file in Collection Images.
 *
 * Usage:
 *   node scripts/export-collection-originals-from-products.js
 *
 * Output: C:\Users\divya\Downloads\Collection Images\New\collection-<slug>.jpg
 * Report: ~/.editpro/export-collection-originals-report.json
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync } = require("child_process");
const { getShopifyCredentials } = require("../lib/config-store");
const { shopifyGraphql } = require("../lib/shopify-client");

const CONFIG_DIR = path.join(os.homedir(), ".editpro");
const REPORT_PATH = path.join(
  CONFIG_DIR,
  "export-collection-originals-report.json"
);
const LOCAL_FOLDER = "C:\\Users\\divya\\Downloads\\Collection Images";
const OUTPUT_FOLDER = path.join(LOCAL_FOLDER, "New");

const COLLECTION_FILE_ALIASES = {
  abstract: "collection-abstract.jpg",
  "august-macke": "collection-august-macke.jpg",
  autumn: "collection-autumn.jpg",
  "banksy-style": "collection-banksy-style.jpg",
  boho: "collection-boho.jpg",
  "claude-monet": "collection-claude-monet.jpg",
  greek: "collection-greek.jpg",
  "gustav-klimt": "collection-gustav-klimt.jpg",
  "henri-edmond-cross": "collection-henry-edmond-cross.jpg",
  "indian-folk-art": "collection-indian-folk-art.jpg",
  "john-singer-sargent": "collection-john-singer-sargent.jpg",
  "kamisaka-sekka-japan": "collection-kamisaka-sekka.jpg",
  "katsushika-hokusai-japan": "collection-katsushika-hokusai.jpg",
  "lord-ganesha": "collection-ganesha.jpg",
  "lord-krishna": "collection-krishna.jpg",
  "lord-shiva": "collection-shiva.jpg",
  madhubani: "collection-madubani.jpg",
  monochrome: "collection-monochrome.jpg",
  "more-famous-painters": "collection-leonardo-da-vinci.jpg",
  "ohara-koson-japan": "collection-ohara-koson.jpg",
  "pop-art": "collection-pop-art.jpg",
  "raja-ravi-verma": "collection-raja-ravi-verma.jpg",
  "utagawa-kuniyoshi-japan": "collection-utagawa-kuniyoshi.jpg",
  "vincent-van-gogh": "collection-vincent-van-gogh.jpg",
  wildlife: "collection-wildlife.jpg",
  "famous-artists-from-japan": "collection-japan.jpg",
  bauhaus: "collection-bauhaus.jpg",
  "botanical-prints": "collection-botanical-prints.jpg",
  cocktails: "collection-cocktail.jpg",
  "lord-buddha": "collection-buddha.jpg",
  "lord-hanuman": "collection-hanuman.jpg",
  "mattise-style": "collection-matisse-style.jpg",
  "picasso-style": "collection-picasso-style.jpg",
  "sun-signs": "collection-sun-signs.jpg",
  astronaut: "collection-astronaut.jpg",
  "natural-vintage": "collection-natural-vintage.jpg",
  "johannes-vermeer": "collection-johannes-vermeer.jpg",
};

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function titleSlug(title) {
  return String(title || "")
    .toLowerCase()
    .replace(/&/g, " ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function listLocalBasenames(folder) {
  if (!fs.existsSync(folder)) return new Set();
  const set = new Set();
  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (![".jpg", ".jpeg", ".png", ".webp", ".gif"].includes(ext)) continue;
    set.add(path.basename(entry.name, ext).toLowerCase());
  }
  return set;
}

function findLocalMatch(handle, title, localBasenames) {
  const candidates = [
    `collection-${titleSlug(title)}`,
    `collection-${handle}`,
  ];
  const alias = COLLECTION_FILE_ALIASES[handle];
  if (alias) {
    candidates.push(path.basename(alias, path.extname(alias)).toLowerCase());
  }
  for (const name of candidates) {
    const key = name.toLowerCase();
    if (localBasenames.has(key)) return key;
  }
  return null;
}

async function fetchAllCollections(storeDomain, accessToken) {
  const collections = [];
  let cursor = null;
  let hasNext = true;

  while (hasNext) {
    const data = await shopifyGraphql(
      storeDomain,
      accessToken,
      `query Collections($cursor: String) {
        collections(first: 50, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            title
            handle
            image { url width height }
            products(first: 1) {
              nodes {
                id
                title
                handle
                featuredMedia {
                  ... on MediaImage {
                    image { url width height }
                  }
                }
                media(first: 1) {
                  nodes {
                    ... on MediaImage {
                      image { url width height }
                    }
                  }
                }
              }
            }
          }
        }
      }`,
      { cursor }
    );

    const page = data.collections;
    collections.push(...(page?.nodes || []));
    hasNext = Boolean(page?.pageInfo?.hasNextPage);
    cursor = page?.pageInfo?.endCursor || null;
  }

  return collections;
}

function firstProductImage(product) {
  const featured = product?.featuredMedia?.image;
  if (featured?.url) return featured;
  const media0 = product?.media?.nodes?.[0]?.image;
  if (media0?.url) return media0;
  return null;
}

async function downloadFile(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Download failed (${res.status})`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(destPath, buf);
  return buf.length;
}

function readImageSize(filePath) {
  const ps = `
Add-Type -AssemblyName System.Drawing
$img = [System.Drawing.Image]::FromFile('${filePath.replace(/'/g, "''")}')
try { Write-Output "$($img.Width)x$($img.Height)" } finally { $img.Dispose() }
`;
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", ps],
    { encoding: "utf8", windowsHide: true }
  );
  if (result.status !== 0) return null;
  const m = String(result.stdout || "")
    .trim()
    .match(/^(\d+)x(\d+)$/);
  if (!m) return null;
  return { width: Number(m[1]), height: Number(m[2]) };
}

function clearOutputFolder(folder) {
  if (!fs.existsSync(folder)) return 0;
  let removed = 0;
  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    fs.unlinkSync(path.join(folder, entry.name));
    removed += 1;
  }
  return removed;
}

async function main() {
  const credentials = getShopifyCredentials();
  if (!credentials.storeDomain || !credentials.accessToken) {
    throw new Error("Shopify is not connected. Add credentials in EditPro Settings.");
  }

  ensureDir(CONFIG_DIR);
  ensureDir(OUTPUT_FOLDER);

  const cleared = clearOutputFolder(OUTPUT_FOLDER);
  const localBasenames = listLocalBasenames(LOCAL_FOLDER);

  console.log(`Store: ${credentials.storeDomain}`);
  console.log(`Local folder: ${LOCAL_FOLDER} (${localBasenames.size} images)`);
  console.log(`Output folder: ${OUTPUT_FOLDER}`);
  console.log(`Cleared previous files: ${cleared}`);
  console.log("Mode: ORIGINAL (no crop)");
  console.log("");

  const collections = await fetchAllCollections(
    credentials.storeDomain,
    credentials.accessToken
  );
  const withImage = collections.filter((c) => c.image?.url);

  const results = [];
  let skipped = 0;
  let noProduct = 0;
  let noImage = 0;
  let exported = 0;
  let errors = 0;

  console.log(
    `Collections: ${collections.length} total, ${withImage.length} with featured image`
  );
  console.log("");

  for (let i = 0; i < withImage.length; i += 1) {
    const col = withImage[i];
    const handle = col.handle;
    const title = col.title || handle;
    const outName = `collection-${titleSlug(title)}.jpg`;
    const outPath = path.join(OUTPUT_FOLDER, outName);

    process.stdout.write(`[${i + 1}/${withImage.length}] ${handle}… `);

    const localHit = findLocalMatch(handle, title, localBasenames);
    if (localHit) {
      skipped += 1;
      console.log(`SKIP local:${localHit}`);
      results.push({
        handle,
        title,
        status: "skipped-local",
        localMatch: localHit,
        outputFilename: outName,
      });
      continue;
    }

    const product = col.products?.nodes?.[0];
    if (!product) {
      noProduct += 1;
      console.log("SKIP no-product");
      results.push({
        handle,
        title,
        status: "skipped-no-product",
        outputFilename: outName,
      });
      continue;
    }

    const image = firstProductImage(product);
    if (!image?.url) {
      noImage += 1;
      console.log("SKIP no-product-image");
      results.push({
        handle,
        title,
        status: "skipped-no-product-image",
        productTitle: product.title,
        outputFilename: outName,
      });
      continue;
    }

    try {
      const bytes = await downloadFile(image.url, outPath);
      const dims = readImageSize(outPath);
      exported += 1;
      console.log(
        `OK ${outName} ← ${product.title} (${dims ? `${dims.width}x${dims.height}` : "?"}, ${bytes} bytes)`
      );
      results.push({
        handle,
        title,
        status: "exported",
        productTitle: product.title,
        productHandle: product.handle,
        sourceImageUrl: image.url,
        sourceWidth: image.width || null,
        sourceHeight: image.height || null,
        outputFilename: outName,
        outputPath: outPath,
        width: dims?.width || null,
        height: dims?.height || null,
        bytes,
      });
    } catch (error) {
      errors += 1;
      console.log(`ERROR: ${error.message || error}`);
      results.push({
        handle,
        title,
        status: "error",
        reason: error.message || String(error),
        outputFilename: outName,
      });
    }
  }

  const summary = {
    mode: "original-no-crop",
    totalCollections: collections.length,
    withFeaturedImage: withImage.length,
    localImages: localBasenames.size,
    cleared,
    skipped,
    noProduct,
    noImage,
    exported,
    errors,
    outputFolder: OUTPUT_FOLDER,
  };

  fs.writeFileSync(REPORT_PATH, JSON.stringify({ summary, results }, null, 2), "utf8");

  console.log("");
  console.log("=== SUMMARY ===");
  console.log(`Skipped (local match): ${skipped}`);
  console.log(`Skipped (no product): ${noProduct}`);
  console.log(`Skipped (no product image): ${noImage}`);
  console.log(`Exported (original): ${exported}`);
  console.log(`Errors: ${errors}`);
  console.log(`Output: ${OUTPUT_FOLDER}`);
  console.log(`Report: ${REPORT_PATH}`);

  if (errors > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`Error: ${error.message || error}`);
  process.exit(1);
});
