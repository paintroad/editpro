#!/usr/bin/env node
/**
 * Set collection featured images from square Shopify Files.
 *
 * Usage:
 *   node scripts/set-collection-images-from-files.js
 *   node scripts/set-collection-images-from-files.js --apply
 *
 * Report: ~/.editpro/set-collection-images-report.json
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { getShopifyCredentials } = require("../lib/config-store");
const { shopifyGraphql } = require("../lib/shopify-client");

const CONFIG_DIR = path.join(os.homedir(), ".editpro");
const REPORT_PATH = path.join(CONFIG_DIR, "set-collection-images-report.json");

/** handle -> square File filename */
const COLLECTION_FILE_MAP = {
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
  "baby-room": "collection-baby-room.jpg",
  cowgirl: "collection-cowgirl.jpg",
  devotional: "collection-devotional.jpg",
  gond: "collection-gond.jpg",
  "indian-art-wall-paintings": "collection-indian.jpg",
  "love-romance": "collection-love-romance.jpg",
  "maximalist-art": "collection-maximalist-art.jpg",
  "picasso-inspired": "collection-picasso-inspired.jpg",
  pichwai: "collection-pichwai.jpg",
  "winslow-homer": "collection-winslow-homer.jpg",
  "women-illustrations": "collection-women.jpg",
  animal: "collection-animal.jpg",
  "beach-vacation": "collection-beach-vacation.jpg",
  "cat-lovers": "collection-cat-lovers.jpg",
  "dog-lovers": "collection-dog-lovers.jpg",
  "famous-artists": "collection-famous-artists.jpg",
  gods: "collection-gods.jpg",
  "hindu-gods": "collection-hindu-gods.jpg",
  "intricate-patterns": "collection-intricate-patterns.jpg",
  maximalist: "collection-maximalist.jpg",
  "pop-art": "collection-pop-art.jpg",
  travel: "collection-travel.jpg",
};

const SKIP_HANDLES = [];

function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

function filenameFromUrl(url) {
  try {
    return path.basename(new URL(url).pathname);
  } catch {
    return "";
  }
}

async function fetchCollectionByHandle(storeDomain, accessToken, handle) {
  const data = await shopifyGraphql(
    storeDomain,
    accessToken,
    `query CollectionByHandle($handle: String!) {
      collectionByHandle(handle: $handle) {
        id
        title
        handle
        image { url width height altText }
      }
    }`,
    { handle }
  );
  return data.collectionByHandle || null;
}

async function fetchSquareFileByFilename(storeDomain, accessToken, filename) {
  const data = await shopifyGraphql(
    storeDomain,
    accessToken,
    `query FileByFilename($query: String!) {
      files(first: 5, query: $query) {
        nodes {
          ... on MediaImage {
            id
            image { url width height }
          }
        }
      }
    }`,
    { query: `filename:${filename}` }
  );

  const nodes = data.files?.nodes || [];
  const target = String(filename).toLowerCase();
  for (const node of nodes) {
    const url = node?.image?.url;
    if (!url) continue;
    const name = filenameFromUrl(url).toLowerCase();
    if (name !== target) continue;
    const width = Number(node.image.width) || 0;
    const height = Number(node.image.height) || 0;
    if (!width || !height || width !== height) {
      return {
        file: null,
        reason: `File found but not square (${width}x${height}).`,
      };
    }
    return {
      file: {
        id: node.id,
        url,
        width,
        height,
        filename: name,
      },
      reason: "",
    };
  }

  // Fallback: single result with matching query
  if (nodes.length === 1 && nodes[0]?.image?.url) {
    const node = nodes[0];
    const width = Number(node.image.width) || 0;
    const height = Number(node.image.height) || 0;
    if (width && height && width === height) {
      return {
        file: {
          id: node.id,
          url: node.image.url,
          width,
          height,
          filename,
        },
        reason: "",
      };
    }
  }

  return { file: null, reason: "Square File not found for filename." };
}

async function updateCollectionImage(storeDomain, accessToken, collectionId, imageUrl) {
  const data = await shopifyGraphql(
    storeDomain,
    accessToken,
    `mutation CollectionUpdate($input: CollectionInput!) {
      collectionUpdate(input: $input) {
        collection {
          id
          title
          handle
          image { url width height }
        }
        userErrors { field message }
      }
    }`,
    {
      input: {
        id: collectionId,
        image: { src: imageUrl },
      },
    }
  );
  const errors = data.collectionUpdate?.userErrors || [];
  if (errors.length) {
    throw new Error(errors.map((e) => e.message).join("; "));
  }
  return data.collectionUpdate?.collection || null;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const credentials = getShopifyCredentials();
  if (!credentials.storeDomain || !credentials.accessToken) {
    throw new Error("Shopify is not connected. Add credentials in EditPro Settings.");
  }

  ensureConfigDir();
  const handles = Object.keys(COLLECTION_FILE_MAP);
  console.log(`Store: ${credentials.storeDomain}`);
  console.log(`Mode: ${apply ? "APPLY" : "DRY-RUN"}`);
  console.log(`Mapped collections: ${handles.length}`);
  console.log(`Planned skips (no square file): ${SKIP_HANDLES.length}`);
  console.log("");

  const results = [];
  let planned = 0;
  let updated = 0;
  let skipped = 0;
  let errors = 0;

  for (const handle of SKIP_HANDLES) {
    skipped += 1;
    results.push({
      handle,
      status: "skipped-no-file",
      reason: "No square File available for this collection (per plan).",
    });
    console.log(`SKIP ${handle}: no square File in map`);
  }
  console.log("");

  for (let i = 0; i < handles.length; i += 1) {
    const handle = handles[i];
    const filename = COLLECTION_FILE_MAP[handle];
    process.stdout.write(`[${i + 1}/${handles.length}] ${handle} ← ${filename}… `);

    try {
      const collection = await fetchCollectionByHandle(
        credentials.storeDomain,
        credentials.accessToken,
        handle
      );
      if (!collection?.id) {
        skipped += 1;
        console.log("SKIP: collection not found");
        results.push({
          handle,
          filename,
          status: "skipped-missing-collection",
          reason: "Collection not found by handle.",
        });
        continue;
      }

      const fileLookup = await fetchSquareFileByFilename(
        credentials.storeDomain,
        credentials.accessToken,
        filename
      );
      if (!fileLookup.file) {
        skipped += 1;
        console.log(`SKIP: ${fileLookup.reason}`);
        results.push({
          handle,
          title: collection.title,
          filename,
          status: "skipped-missing-file",
          reason: fileLookup.reason,
          oldImageUrl: collection.image?.url || "",
          oldWidth: collection.image?.width || null,
          oldHeight: collection.image?.height || null,
        });
        continue;
      }

      const oldUrl = collection.image?.url || "";
      const oldWidth = collection.image?.width || null;
      const oldHeight = collection.image?.height || null;
      const already =
        oldUrl &&
        filenameFromUrl(oldUrl).toLowerCase() === filename.toLowerCase() &&
        Number(oldWidth) === Number(oldHeight);

      const entry = {
        handle,
        title: collection.title,
        collectionId: collection.id,
        filename,
        oldImageUrl: oldUrl,
        oldWidth,
        oldHeight,
        newImageUrl: fileLookup.file.url,
        newWidth: fileLookup.file.width,
        newHeight: fileLookup.file.height,
      };

      if (already) {
        console.log("OK (already square file)");
        results.push({ ...entry, status: "noop" });
        continue;
      }

      planned += 1;

      if (!apply) {
        console.log(`PLAN ${oldWidth || "?"}x${oldHeight || "?"} → ${fileLookup.file.width}x${fileLookup.file.height}`);
        results.push({ ...entry, status: "planned" });
        continue;
      }

      const updatedCollection = await updateCollectionImage(
        credentials.storeDomain,
        credentials.accessToken,
        collection.id,
        fileLookup.file.url
      );

      // Re-fetch to verify dims (API may report after processing)
      const refreshed = await fetchCollectionByHandle(
        credentials.storeDomain,
        credentials.accessToken,
        handle
      );
      const rw = Number(refreshed?.image?.width) || 0;
      const rh = Number(refreshed?.image?.height) || 0;
      const square = rw > 0 && rw === rh;
      const urlOk =
        filenameFromUrl(refreshed?.image?.url || "")
          .toLowerCase()
          .includes(path.parse(filename).name.toLowerCase()) ||
        (refreshed?.image?.url || "").includes("/collections/");

      updated += 1;
      const status = square || urlOk ? "updated" : "updated-unverified";
      console.log(
        `UPDATED → ${(refreshed?.image && `${rw}x${rh}`) || updatedCollection?.image?.url || "ok"}`
      );
      results.push({
        ...entry,
        status,
        verifiedWidth: rw || null,
        verifiedHeight: rh || null,
        verifiedUrl: refreshed?.image?.url || updatedCollection?.image?.url || "",
      });
    } catch (error) {
      errors += 1;
      console.log(`ERROR: ${error.message || error}`);
      results.push({
        handle,
        filename,
        status: "error",
        reason: error.message || String(error),
      });
    }
  }

  const summary = {
    mode: apply ? "apply" : "dry-run",
    mapped: handles.length,
    planned,
    updated,
    skipped,
    errors,
    noop: results.filter((r) => r.status === "noop").length,
  };

  fs.writeFileSync(REPORT_PATH, JSON.stringify({ summary, results }, null, 2), "utf8");

  console.log("");
  console.log("=== SUMMARY ===");
  console.log(`Mapped: ${summary.mapped}`);
  console.log(`Planned/applied changes: ${apply ? summary.updated : summary.planned}`);
  console.log(`Already OK: ${summary.noop}`);
  console.log(`Skipped: ${summary.skipped}`);
  console.log(`Errors: ${summary.errors}`);
  console.log(`Report: ${REPORT_PATH}`);

  if (!apply) {
    console.log("");
    console.log("Dry-run complete. Re-run with --apply to update collection images.");
  }

  if (apply && summary.errors > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`Error: ${error.message || error}`);
  process.exit(1);
});
