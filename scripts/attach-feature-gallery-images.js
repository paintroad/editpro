#!/usr/bin/env node
/**
 * Append four shared feature images to every non–gift-card product gallery
 * (at the end, reference-only via fileUpdate.referencesToAdd).
 *
 * Sequence (last four slots):
 *   1. features-material.jpg
 *   2. features-frame-size.jpg
 *   3. features-frame-built.jpg
 *   4. features-packaging.jpg
 *
 * Usage:
 *   node scripts/attach-feature-gallery-images.js
 *   node scripts/attach-feature-gallery-images.js --handles=krishna-raas-leela-pattachitra-art-raasleela-patta-painting-framed-wall-art
 *   node scripts/attach-feature-gallery-images.js --handles=... --apply
 *   node scripts/attach-feature-gallery-images.js --apply
 *   node scripts/attach-feature-gallery-images.js --apply --reset
 *
 * Progress: ~/.editpro/attach-feature-gallery-progress.json
 * Report:   ~/.editpro/attach-feature-gallery-report.json
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { getShopifyCredentials } = require("../lib/config-store");
const { shopifyGraphql } = require("../lib/shopify-client");

const CONFIG_DIR = path.join(os.homedir(), ".editpro");
const PROGRESS_PATH = path.join(CONFIG_DIR, "attach-feature-gallery-progress.json");
const REPORT_PATH = path.join(CONFIG_DIR, "attach-feature-gallery-report.json");

const FEATURE_FILES = [
  {
    key: "material",
    filename: "features-material.jpg",
    urlHint:
      "https://cdn.shopify.com/s/files/1/0694/3496/6165/files/features-material.jpg",
  },
  {
    key: "frame-size",
    filename: "features-frame-size.jpg",
    urlHint:
      "https://cdn.shopify.com/s/files/1/0694/3496/6165/files/features-frame-size.jpg",
  },
  {
    key: "frame-built",
    filename: "features-frame-built.jpg",
    urlHint:
      "https://cdn.shopify.com/s/files/1/0694/3496/6165/files/features-frame-built.jpg",
  },
  {
    key: "packaging",
    filename: "features-packaging.jpg",
    urlHint:
      "https://cdn.shopify.com/s/files/1/0694/3496/6165/files/features-packaging.jpg",
  },
];

function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv) {
  const apply = argv.includes("--apply");
  const reset = argv.includes("--reset");
  let limit = null;
  let concurrency = 2;
  let handles = [];
  for (const arg of argv) {
    if (arg.startsWith("--limit=")) limit = Number(arg.slice("--limit=".length));
    if (arg.startsWith("--concurrency=")) {
      concurrency = Math.max(1, Number(arg.slice("--concurrency=".length)) || 2);
    }
    if (arg.startsWith("--handles=")) {
      handles = arg
        .slice("--handles=".length)
        .split(",")
        .map((h) => h.trim())
        .filter(Boolean);
    }
  }
  return { apply, reset, limit, handles, concurrency };
}

function loadProgress() {
  if (!fs.existsSync(PROGRESS_PATH)) return { doneProductIds: [] };
  try {
    return JSON.parse(fs.readFileSync(PROGRESS_PATH, "utf8"));
  } catch {
    return { doneProductIds: [] };
  }
}

function saveProgress(progress) {
  ensureConfigDir();
  fs.writeFileSync(PROGRESS_PATH, JSON.stringify(progress, null, 2), "utf8");
}

function filenameFromUrl(url) {
  try {
    return path.basename(new URL(url).pathname).toLowerCase();
  } catch {
    return "";
  }
}

function shouldSkipProduct(product) {
  const type = String(product.productType || "").toLowerCase();
  const title = String(product.title || "").toLowerCase();
  const handle = String(product.handle || "").toLowerCase();
  if (type.includes("gift") || title.includes("gift card") || handle.includes("gift-card")) {
    return "gift-card";
  }
  return null;
}

async function mapPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }
  const n = Math.min(concurrency, Math.max(1, items.length));
  await Promise.all(Array.from({ length: n }, () => run()));
  return results;
}

async function resolveFeatureFile(storeDomain, accessToken, spec) {
  const data = await shopifyGraphql(
    storeDomain,
    accessToken,
    `query FileByFilename($query: String!) {
      files(first: 10, query: $query) {
        nodes {
          ... on MediaImage {
            id
            fileStatus
            alt
            image { url }
          }
        }
      }
    }`,
    { query: `filename:${spec.filename}` }
  );

  const nodes = data.files?.nodes || [];
  const target = spec.filename.toLowerCase();
  let match = null;
  for (const node of nodes) {
    const url = node?.image?.url || "";
    const name = filenameFromUrl(url);
    if (name === target) {
      match = node;
      break;
    }
    if (url.includes(spec.filename)) {
      match = node;
      break;
    }
  }

  if (!match && nodes.length === 1 && nodes[0]?.id) {
    match = nodes[0];
  }

  if (!match?.id) {
    throw new Error(`File not found: ${spec.filename}`);
  }
  if (String(match.fileStatus || "").toUpperCase() !== "READY") {
    throw new Error(
      `File not READY (${match.fileStatus || "unknown"}): ${spec.filename}`
    );
  }

  return {
    key: spec.key,
    filename: spec.filename,
    id: match.id,
    url: match.image?.url || "",
    alt: match.alt || "",
  };
}

async function resolveAllFeatureFiles(storeDomain, accessToken) {
  const out = [];
  for (const spec of FEATURE_FILES) {
    const file = await resolveFeatureFile(storeDomain, accessToken, spec);
    out.push(file);
    console.log(`  ✓ ${file.filename} → ${file.id}`);
  }
  return out;
}

async function listProducts(storeDomain, accessToken, { handles, limit }) {
  const out = [];
  if (handles.length) {
    for (const handle of handles) {
      const data = await shopifyGraphql(
        storeDomain,
        accessToken,
        `query ($q: String!) {
          products(first: 1, query: $q) {
            nodes {
              id
              title
              handle
              status
              productType
              media(first: 50) {
                nodes {
                  id
                  ... on MediaImage {
                    image { url }
                  }
                }
              }
            }
          }
        }`,
        { q: `handle:${handle}` }
      );
      const node = data.products?.nodes?.[0];
      if (node) out.push(node);
    }
    return out;
  }

  let cursor = null;
  let hasNext = true;
  while (hasNext) {
    const data = await shopifyGraphql(
      storeDomain,
      accessToken,
      `query ($cursor: String) {
        products(first: 50, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            title
            handle
            status
            productType
            media(first: 50) {
              nodes {
                id
                ... on MediaImage {
                  image { url }
                }
              }
            }
          }
        }
      }`,
      { cursor }
    );
    const page = data.products;
    for (const node of page?.nodes || []) out.push(node);
    hasNext = Boolean(page?.pageInfo?.hasNextPage);
    cursor = page?.pageInfo?.endCursor || null;
    if (limit && out.length >= limit) {
      return out.slice(0, limit);
    }
  }
  return out;
}

async function fetchProductMedia(storeDomain, accessToken, productId) {
  const data = await shopifyGraphql(
    storeDomain,
    accessToken,
    `query ($id: ID!) {
      product(id: $id) {
        id
        media(first: 50) {
          nodes {
            id
            ... on MediaImage {
              image { url }
            }
          }
        }
      }
    }`,
    { id: productId }
  );
  return data.product?.media?.nodes || [];
}

function mediaFilename(node) {
  return filenameFromUrl(node?.image?.url || "");
}

function findFeatureOnProduct(mediaNodes, featureFile) {
  const target = featureFile.filename.toLowerCase();
  for (const node of mediaNodes) {
    if (node.id === featureFile.id) return node;
    if (mediaFilename(node) === target) return node;
  }
  return null;
}

function featureOrderCorrect(mediaNodes, featureFiles) {
  if (mediaNodes.length < featureFiles.length) return false;
  const tail = mediaNodes.slice(-featureFiles.length);
  return featureFiles.every((f, i) => {
    const node = tail[i];
    if (!node) return false;
    return node.id === f.id || mediaFilename(node) === f.filename.toLowerCase();
  });
}

async function attachFilesToProduct(storeDomain, accessToken, productId, fileIds) {
  if (!fileIds.length) return [];
  const data = await shopifyGraphql(
    storeDomain,
    accessToken,
    `mutation FileUpdate($files: [FileUpdateInput!]!) {
      fileUpdate(files: $files) {
        files {
          id
          fileStatus
          ... on MediaImage {
            image { url }
          }
        }
        userErrors { field message code }
      }
    }`,
    {
      files: fileIds.map((id) => ({
        id,
        referencesToAdd: [productId],
      })),
    }
  );
  const errors = data.fileUpdate?.userErrors || [];
  if (errors.length) {
    throw new Error(errors.map((e) => e.message).join("; "));
  }
  return data.fileUpdate?.files || [];
}

async function reorderProductMedia(storeDomain, accessToken, productId, moves) {
  if (!moves.length) return;
  const data = await shopifyGraphql(
    storeDomain,
    accessToken,
    `mutation ProductReorderMedia($id: ID!, $moves: [MoveInput!]!) {
      productReorderMedia(id: $id, moves: $moves) {
        job { id done }
        mediaUserErrors { field message code }
        userErrors { field message }
      }
    }`,
    { id: productId, moves }
  );
  const result = data.productReorderMedia;
  const errors = [
    ...(result?.mediaUserErrors || []),
    ...(result?.userErrors || []),
  ];
  if (errors.length) {
    throw new Error(errors.map((e) => e.message).join("; "));
  }
  return result?.job || null;
}

function buildReorderMoves(mediaNodes, featureFiles) {
  const featureIdSet = new Set(featureFiles.map((f) => f.id));
  const featureByFilename = new Map(
    featureFiles.map((f) => [f.filename.toLowerCase(), f])
  );

  const nonFeature = [];
  const featurePresent = new Map(); // key -> media node id to reorder

  for (const node of mediaNodes) {
    const name = mediaFilename(node);
    const byId = featureFiles.find((f) => f.id === node.id);
    const byName = featureByFilename.get(name);
    const feature = byId || byName;
    if (feature) {
      featurePresent.set(feature.key, node.id);
    } else {
      nonFeature.push(node.id);
    }
  }

  // Ensure all four feature slots are present in map (prefer file GID)
  for (const f of featureFiles) {
    if (!featurePresent.has(f.key)) {
      featurePresent.set(f.key, f.id);
    }
  }

  const orderedIds = [
    ...nonFeature,
    ...featureFiles.map((f) => featurePresent.get(f.key)),
  ].filter(Boolean);

  // Deduplicate while preserving order
  const seen = new Set();
  const uniqueOrdered = [];
  for (const id of orderedIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    uniqueOrdered.push(id);
  }

  const currentIds = mediaNodes.map((n) => n.id);
  const same =
    currentIds.length === uniqueOrdered.length &&
    currentIds.every((id, i) => id === uniqueOrdered[i]);
  if (same) return [];

  return uniqueOrdered.map((id, index) => ({
    id,
    newPosition: String(index),
  }));
}

async function processProduct(storeDomain, accessToken, product, featureFiles, apply) {
  const skipReason = shouldSkipProduct(product);
  if (skipReason) {
    return { status: "skipped", reason: skipReason, handle: product.handle };
  }

  let media = product.media?.nodes || [];
  const missing = [];
  for (const f of featureFiles) {
    if (!findFeatureOnProduct(media, f)) missing.push(f);
  }

  const alreadyOk =
    missing.length === 0 && featureOrderCorrect(media, featureFiles);

  if (alreadyOk) {
    return {
      status: "already-ok",
      handle: product.handle,
      mediaCount: media.length,
    };
  }

  if (!apply) {
    return {
      status: "planned",
      handle: product.handle,
      attach: missing.map((f) => f.filename),
      reorder: !(missing.length === 0 && featureOrderCorrect(media, featureFiles)),
      mediaCount: media.length,
    };
  }

  if (missing.length) {
    await attachFilesToProduct(
      storeDomain,
      accessToken,
      product.id,
      missing.map((f) => f.id)
    );
    await sleep(400);
    media = await fetchProductMedia(storeDomain, accessToken, product.id);
  }

  // Wait briefly if attachments not yet visible
  let tries = 0;
  while (tries < 5) {
    const stillMissing = featureFiles.filter((f) => !findFeatureOnProduct(media, f));
    if (!stillMissing.length) break;
    await sleep(600);
    media = await fetchProductMedia(storeDomain, accessToken, product.id);
    tries += 1;
  }

  const stillMissing = featureFiles.filter((f) => !findFeatureOnProduct(media, f));
  if (stillMissing.length) {
    throw new Error(
      `Attach did not appear on product: ${stillMissing.map((f) => f.filename).join(", ")}`
    );
  }

  const moves = buildReorderMoves(media, featureFiles);
  if (moves.length) {
    await reorderProductMedia(storeDomain, accessToken, product.id, moves);
    await sleep(500);
    media = await fetchProductMedia(storeDomain, accessToken, product.id);
  }

  const ok = featureOrderCorrect(media, featureFiles);
  return {
    status: ok ? "updated" : "updated-unverified-order",
    handle: product.handle,
    attached: missing.map((f) => f.filename),
    reordered: moves.length > 0,
    mediaCount: media.length,
    tail: media.slice(-4).map((n) => mediaFilename(n) || n.id),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const creds = getShopifyCredentials();
  if (!creds.storeDomain || !creds.accessToken) {
    throw new Error("Shopify is not connected. Add credentials in EditPro Settings.");
  }

  ensureConfigDir();
  if (args.reset && fs.existsSync(PROGRESS_PATH)) {
    fs.unlinkSync(PROGRESS_PATH);
    console.log("Progress reset.");
  }

  const progress = loadProgress();
  const doneSet = new Set(progress.doneProductIds || []);

  console.log(`Store: ${creds.storeDomain}`);
  console.log(`Mode: ${args.apply ? "APPLY" : "DRY-RUN"}`);
  console.log("");
  console.log("Resolving feature Files…");
  const featureFiles = await resolveAllFeatureFiles(
    creds.storeDomain,
    creds.accessToken
  );
  console.log("");

  let products = await listProducts(creds.storeDomain, creds.accessToken, args);
  console.log(`Products loaded: ${products.length}`);

  if (!args.handles.length && !args.reset) {
    const pending = products.filter((p) => !doneSet.has(p.id));
    console.log(`Already done (progress): ${products.length - pending.length}`);
    products = pending;
  }

  const report = {
    startedAt: new Date().toISOString(),
    mode: args.apply ? "apply" : "dry-run",
    featureFiles: featureFiles.map((f) => ({
      filename: f.filename,
      id: f.id,
      url: f.url,
    })),
    results: [],
  };

  let counts = {
    updated: 0,
    planned: 0,
    alreadyOk: 0,
    skipped: 0,
    errors: 0,
  };

  await mapPool(products, args.concurrency, async (product, index) => {
    const label = `[${index + 1}/${products.length}] ${product.handle}`;
    try {
      const result = await processProduct(
        creds.storeDomain,
        creds.accessToken,
        product,
        featureFiles,
        args.apply
      );
      report.results.push({
        id: product.id,
        title: product.title,
        ...result,
      });

      if (result.status === "skipped") {
        counts.skipped += 1;
        console.log(`${label} SKIP ${result.reason}`);
        if (args.apply) {
          doneSet.add(product.id);
          progress.doneProductIds = [...doneSet];
          saveProgress(progress);
        }
      } else if (result.status === "already-ok") {
        counts.alreadyOk += 1;
        console.log(`${label} OK (already)`);
        if (args.apply) {
          doneSet.add(product.id);
          progress.doneProductIds = [...doneSet];
          saveProgress(progress);
        }
      } else if (result.status === "planned") {
        counts.planned += 1;
        console.log(
          `${label} PLAN attach=[${(result.attach || []).join(",")}] reorder=${result.reorder}`
        );
      } else if (
        result.status === "updated" ||
        result.status === "updated-unverified-order"
      ) {
        counts.updated += 1;
        console.log(
          `${label} ${result.status} attached=${(result.attached || []).length} reorder=${result.reordered} tail=[${(result.tail || []).join(",")}]`
        );
        doneSet.add(product.id);
        progress.doneProductIds = [...doneSet];
        saveProgress(progress);
      } else {
        console.log(`${label} ${result.status}`);
      }
    } catch (err) {
      counts.errors += 1;
      const message = err?.message || String(err);
      console.log(`${label} ERROR ${message}`);
      report.results.push({
        id: product.id,
        handle: product.handle,
        title: product.title,
        status: "error",
        error: message,
      });
    }
  });

  report.finishedAt = new Date().toISOString();
  report.counts = counts;
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), "utf8");

  console.log("");
  console.log("Done.", counts);
  console.log(`Report: ${REPORT_PATH}`);
  if (!args.apply) {
    console.log("Dry-run only. Re-run with --apply to write.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
