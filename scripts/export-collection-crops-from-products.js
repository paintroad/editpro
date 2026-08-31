#!/usr/bin/env node
/**
 * Export 690x690 center-cropped collection images from each collection's
 * first product image, skipping collections that already have a matching
 * file in the local Collection Images folder.
 *
 * Usage:
 *   node scripts/export-collection-crops-from-products.js
 *
 * Output: C:\Users\divya\Downloads\Collection Images\New\collection-<slug>.jpg
 * Report: ~/.editpro/export-collection-crops-report.json
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync } = require("child_process");
const { getShopifyCredentials } = require("../lib/config-store");
const { shopifyGraphql } = require("../lib/shopify-client");

const CONFIG_DIR = path.join(os.homedir(), ".editpro");
const REPORT_PATH = path.join(CONFIG_DIR, "export-collection-crops-report.json");
const LOCAL_FOLDER = "C:\\Users\\divya\\Downloads\\Collection Images";
const OUTPUT_FOLDER = path.join(LOCAL_FOLDER, "New");
const TEMP_DIR = path.join(CONFIG_DIR, "tmp-collection-crops");
const CROP_SIZE = 690;

/** handle -> existing local basename (without path), from set-collection-images map */
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
    if (localBasenames.has(key)) {
      return key;
    }
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
  return destPath;
}

async function cropWithSharp(inputPath, outputPath, size) {
  const sharp = require("sharp");
  await sharp(inputPath)
    .rotate()
    .resize(size, size, { fit: "cover", position: "centre" })
    .jpeg({ quality: 90 })
    .toFile(outputPath);
}

function cropWithSystemDrawing(inputPath, outputPath, size) {
  const ps = `
Add-Type -AssemblyName System.Drawing
$in = '${inputPath.replace(/'/g, "''")}'
$out = '${outputPath.replace(/'/g, "''")}'
$size = ${size}
$src = [System.Drawing.Image]::FromFile($in)
try {
  $sw = $src.Width
  $sh = $src.Height
  if ($sw -lt 1 -or $sh -lt 1) { throw "Invalid source dimensions" }
  $scale = [Math]::Max($size / [double]$sw, $size / [double]$sh)
  $nw = [int][Math]::Ceiling($sw * $scale)
  $nh = [int][Math]::Ceiling($sh * $scale)
  $scaled = New-Object System.Drawing.Bitmap $nw, $nh
  $g1 = [System.Drawing.Graphics]::FromImage($scaled)
  $g1.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g1.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g1.DrawImage($src, 0, 0, $nw, $nh)
  $g1.Dispose()
  $x = [int](($nw - $size) / 2)
  $y = [int](($nh - $size) / 2)
  $rect = New-Object System.Drawing.Rectangle $x, $y, $size, $size
  $crop = $scaled.Clone($rect, $scaled.PixelFormat)
  $scaled.Dispose()
  $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
  $eps = New-Object System.Drawing.Imaging.EncoderParameters 1
  $eps.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality, 90L)
  $crop.Save($out, $codec, $eps)
  $crop.Dispose()
  Write-Output "OK $size $size"
} finally {
  $src.Dispose()
}
`;
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", ps],
    { encoding: "utf8", windowsHide: true, maxBuffer: 10 * 1024 * 1024 }
  );
  if (result.status !== 0) {
    throw new Error(
      (result.stderr || result.stdout || "System.Drawing crop failed").trim()
    );
  }
  const out = String(result.stdout || "").trim();
  if (!out.startsWith("OK")) {
    throw new Error(out || "System.Drawing crop failed");
  }
}

async function cropCenterSquare(inputPath, outputPath, size) {
  try {
    await cropWithSharp(inputPath, outputPath, size);
    return "sharp";
  } catch {
    cropWithSystemDrawing(inputPath, outputPath, size);
    return "system-drawing";
  }
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

async function main() {
  const credentials = getShopifyCredentials();
  if (!credentials.storeDomain || !credentials.accessToken) {
    throw new Error("Shopify is not connected. Add credentials in EditPro Settings.");
  }

  ensureDir(CONFIG_DIR);
  ensureDir(OUTPUT_FOLDER);
  ensureDir(TEMP_DIR);

  const localBasenames = listLocalBasenames(LOCAL_FOLDER);
  console.log(`Store: ${credentials.storeDomain}`);
  console.log(`Local folder: ${LOCAL_FOLDER} (${localBasenames.size} images)`);
  console.log(`Output folder: ${OUTPUT_FOLDER}`);
  console.log(`Crop size: ${CROP_SIZE}x${CROP_SIZE}`);
  console.log("");

  const collections = await fetchAllCollections(
    credentials.storeDomain,
    credentials.accessToken
  );

  const results = [];
  let skipped = 0;
  let noProduct = 0;
  let noImage = 0;
  let exported = 0;
  let errors = 0;
  let cropEngine = null;

  const withImage = collections.filter((c) => c.image?.url);
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
    const label = `[${i + 1}/${withImage.length}] ${handle}`;

    process.stdout.write(`${label}… `);

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
      const tempPath = path.join(
        TEMP_DIR,
        `${handle}${path.extname(new URL(image.url).pathname) || ".jpg"}`
      );
      await downloadFile(image.url, tempPath);
      const engine = await cropCenterSquare(tempPath, outPath, CROP_SIZE);
      cropEngine = cropEngine || engine;
      const dims = readImageSize(outPath);
      if (!dims || dims.width !== CROP_SIZE || dims.height !== CROP_SIZE) {
        throw new Error(
          `Output not ${CROP_SIZE}x${CROP_SIZE}: ${dims ? `${dims.width}x${dims.height}` : "unknown"}`
        );
      }
      exported += 1;
      console.log(
        `OK ${outName} ← ${product.title} (${dims.width}x${dims.height}, ${engine})`
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
        width: dims.width,
        height: dims.height,
        cropEngine: engine,
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
    totalCollections: collections.length,
    withFeaturedImage: withImage.length,
    localImages: localBasenames.size,
    skipped,
    noProduct,
    noImage,
    exported,
    errors,
    cropSize: CROP_SIZE,
    cropEngine,
    outputFolder: OUTPUT_FOLDER,
  };

  fs.writeFileSync(REPORT_PATH, JSON.stringify({ summary, results }, null, 2), "utf8");

  console.log("");
  console.log("=== SUMMARY ===");
  console.log(`Skipped (local match): ${skipped}`);
  console.log(`Skipped (no product): ${noProduct}`);
  console.log(`Skipped (no product image): ${noImage}`);
  console.log(`Exported: ${exported}`);
  console.log(`Errors: ${errors}`);
  console.log(`Crop engine: ${cropEngine || "n/a"}`);
  console.log(`Output: ${OUTPUT_FOLDER}`);
  console.log(`Report: ${REPORT_PATH}`);

  if (errors > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`Error: ${error.message || error}`);
  process.exit(1);
});
