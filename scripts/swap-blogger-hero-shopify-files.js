#!/usr/bin/env node
/**
 * Swap legacy Blogger hero Shopify Files (same filename) to lifestyle mockups.
 * Does NOT edit Blogger posts — CDN URL stays the same, pixels change on Shopify.
 *
 * Safety: never replace a file whose basename is a live product primary (images[0]).
 *
 * Usage:
 *   node scripts/swap-blogger-hero-shopify-files.js
 *   node scripts/swap-blogger-hero-shopify-files.js --apply
 *
 * Report: ~/.editpro/swap-blogger-hero-shopify-files-report.json
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { getShopifyCredentials } = require("../lib/config-store");
const { shopifyGraphql } = require("../lib/shopify-client");
const { mimeTypeForPath } = require("../lib/shopify-staged-upload");
const {
  isBasePaintingFilename,
  parseRoomFromFilename,
} = require("../lib/room-from-filename");

const CONFIG_DIR = path.join(os.homedir(), ".editpro");
const REPORT_PATH = path.join(CONFIG_DIR, "swap-blogger-hero-shopify-files-report.json");
const BLOGGER_FEED =
  "https://mypaintroad.blogspot.com/feeds/posts/default?alt=json&max-results=150";
const STOREFRONT = "https://paintroad.com";

const HANDLE_ALIASES = {
  "perfect-isnt-real": "perfect-isn-t-real",
};

function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

function parseArgs(argv) {
  return { apply: argv.includes("--apply") };
}

function normalizeUrl(url) {
  return String(url || "").split("?")[0].trim();
}

function filenameFromUrl(url) {
  try {
    return path.basename(new URL(url).pathname);
  } catch {
    return String(url || "").split("?")[0].split("/").pop() || "";
  }
}

function normalizeRoom(room) {
  return String(room || "")
    .toLowerCase()
    .replace(/-/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function firstImgInHtml(html) {
  const match = /<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/i.exec(html || "");
  return match ? match[1] : null;
}

function handlesFromHtml(html) {
  const handles = new Set();
  const re = /\/products\/([a-z0-9\-]+)/gi;
  let m;
  while ((m = re.exec(html || ""))) {
    let handle = m[1].toLowerCase();
    if (HANDLE_ALIASES[handle]) {
      handle = HANDLE_ALIASES[handle];
    }
    handles.add(handle);
  }
  return [...handles];
}

async function fetchBloggerPosts() {
  const posts = [];
  let start = 1;
  for (let page = 0; page < 20; page += 1) {
    const url = `${BLOGGER_FEED}&start-index=${start}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(90000) });
    if (!res.ok) {
      throw new Error(`Blogger feed failed (${res.status})`);
    }
    const data = await res.json();
    const entries = data.feed?.entry || [];
    if (!entries.length) break;
    for (const entry of entries) {
      posts.push({
        id: entry.id?.$t || entry.id || String(posts.length),
        title: entry.title?.$t || "",
        url: (entry.link || []).find((l) => l.rel === "alternate")?.href || "",
        html: entry.content?.$t || "",
      });
    }
    if (entries.length < 150) break;
    start += 150;
  }
  return posts;
}

const productCache = new Map();

async function fetchProduct(handle) {
  const key = String(handle || "").toLowerCase();
  if (!key) return null;
  if (productCache.has(key)) return productCache.get(key);
  try {
    const res = await fetch(`${STOREFRONT}/products/${key}.json`, {
      signal: AbortSignal.timeout(45000),
    });
    if (!res.ok) {
      productCache.set(key, null);
      return null;
    }
    const data = await res.json();
    const images = (data.product?.images || []).map((img) => ({
      src: normalizeUrl(img.src),
      basename: filenameFromUrl(img.src),
    }));
    const product = {
      handle: key,
      title: data.product?.title || "",
      images,
      primaryBasename: images[0]?.basename || "",
    };
    productCache.set(key, product);
    return product;
  } catch {
    productCache.set(key, null);
    return null;
  }
}

function lifestyleUrlsFromProduct(product) {
  if (!product?.images?.length) return [];
  return product.images
    .slice(1)
    .map((img) => img.src)
    .filter((url) => url && !isBasePaintingFilename(url));
}

function pickLifestyleSource(product, preferredRoom) {
  const pool = lifestyleUrlsFromProduct(product);
  if (!pool.length) return null;
  const normPreferred = normalizeRoom(preferredRoom);
  if (normPreferred) {
    const matched = pool.filter((url) => {
      const room = parseRoomFromFilename(url);
      return room && normalizeRoom(room) === normPreferred;
    });
    if (matched.length) {
      return matched[0];
    }
  }
  return pool[0];
}

function normalizeFilename(name) {
  return String(name || "").trim().toLowerCase();
}

async function findShopifyFileByFilename(storeDomain, accessToken, filename) {
  const data = await shopifyGraphql(
    storeDomain,
    accessToken,
    `query FilesByFilename($query: String!) {
      files(first: 10, query: $query) {
        nodes {
          id
          fileStatus
          alt
          ... on MediaImage {
            id
            mimeType
            image { url }
            originalSource { url }
          }
          ... on GenericFile {
            id
            mimeType
            url
            originalFileSize
          }
        }
      }
    }`,
    { query: `filename:${filename}` }
  );

  const nodes = data.files?.nodes || [];
  const targetName = normalizeFilename(filename);
  const exact = [];

  for (const node of nodes) {
    const url = node.image?.url || node.url || node.originalSource?.url || "";
    let nodeFilename = "";
    try {
      nodeFilename = path.basename(new URL(url).pathname);
    } catch {
      nodeFilename = "";
    }
    if (nodeFilename && normalizeFilename(nodeFilename) === targetName) {
      exact.push({
        id: node.id,
        fileStatus: node.fileStatus || "",
        url,
        mimeType: node.mimeType || "",
        alt: node.alt || "",
        filename: nodeFilename,
      });
    }
  }

  if (!exact.length && nodes.length === 1) {
    const node = nodes[0];
    const url = node.image?.url || node.url || "";
    exact.push({
      id: node.id,
      fileStatus: node.fileStatus || "",
      url,
      mimeType: node.mimeType || "",
      alt: node.alt || "",
      filename,
    });
  }

  if (!exact.length) {
    return { match: null, reason: "No Shopify file with this filename." };
  }

  const ready = exact.filter((f) => !f.fileStatus || f.fileStatus === "READY");
  const candidates = ready.length ? ready : exact;
  if (candidates.length > 1) {
    return {
      match: null,
      reason: `Ambiguous: ${candidates.length} Shopify files matched filename.`,
      candidates,
    };
  }
  return { match: candidates[0], reason: "" };
}

async function stagedUploadAsFile(storeDomain, accessToken, localPath, filename) {
  const mimeType = mimeTypeForPath(localPath);
  const data = await shopifyGraphql(
    storeDomain,
    accessToken,
    `mutation StagedUploadsCreate($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets { url resourceUrl parameters { name value } }
        userErrors { field message }
      }
    }`,
    {
      input: [
        {
          filename,
          mimeType,
          resource: "FILE",
          httpMethod: "POST",
        },
      ],
    }
  );
  const result = data.stagedUploadsCreate;
  if (result.userErrors?.length) {
    throw new Error(result.userErrors.map((e) => e.message).join("; "));
  }
  const target = result.stagedTargets?.[0];
  if (!target?.url || !target.resourceUrl) {
    throw new Error("Staged upload target missing.");
  }

  const fileBuffer = fs.readFileSync(localPath);
  const form = new FormData();
  for (const param of target.parameters || []) {
    form.append(param.name, param.value);
  }
  form.append("file", new Blob([fileBuffer], { type: mimeType }), filename);

  const uploadResponse = await fetch(target.url, { method: "POST", body: form });
  if (!uploadResponse.ok) {
    const text = await uploadResponse.text().catch(() => "");
    throw new Error(
      `Staged upload failed (${uploadResponse.status}): ${text.slice(0, 200)}`
    );
  }

  return { resourceUrl: target.resourceUrl, filename, mimeType };
}

async function replaceFileContent(storeDomain, accessToken, fileId, resourceUrl) {
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
          ... on GenericFile {
            url
          }
        }
        userErrors { field message code }
      }
    }`,
    {
      files: [
        {
          id: fileId,
          originalSource: resourceUrl,
        },
      ],
    }
  );
  const errors = data.fileUpdate?.userErrors || [];
  if (errors.length) {
    throw new Error(errors.map((e) => e.message).join("; "));
  }
  return data.fileUpdate?.files?.[0] || null;
}

async function downloadToFile(url, destPath) {
  const res = await fetch(url, { signal: AbortSignal.timeout(90000) });
  if (!res.ok) {
    throw new Error(`Download failed (${res.status})`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) {
    throw new Error("Downloaded empty file");
  }
  fs.writeFileSync(destPath, buf);
  return buf.length;
}

async function main() {
  const { apply } = parseArgs(process.argv.slice(2));
  const credentials = getShopifyCredentials();
  if (!credentials.storeDomain || !credentials.accessToken) {
    throw new Error("Shopify is not connected. Add credentials in EditPro Settings.");
  }

  ensureConfigDir();
  console.log(`Store: ${credentials.storeDomain}`);
  console.log(`Mode: ${apply ? "APPLY" : "DRY-RUN"}`);
  console.log("Fetching Blogger posts…");
  const posts = await fetchBloggerPosts();
  console.log(`Posts: ${posts.length}`);

  const heroByPost = [];
  const heroMap = new Map();

  for (const post of posts) {
    const heroSrc = firstImgInHtml(post.html);
    if (!heroSrc) continue;
    const basename = filenameFromUrl(heroSrc);
    if (!basename) continue;
    const handles = handlesFromHtml(post.html);
    const entry = {
      postId: post.id,
      postTitle: post.title,
      postUrl: post.url,
      heroSrc,
      heroBasename: basename,
      handles,
    };
    heroByPost.push(entry);
    if (!heroMap.has(basename)) {
      heroMap.set(basename, {
        heroBasename: basename,
        heroSrc,
        posts: [],
        handles: new Set(),
      });
    }
    const bucket = heroMap.get(basename);
    bucket.posts.push({ title: post.title, url: post.url });
    for (const h of handles) bucket.handles.add(h);
  }

  console.log(`Unique hero basenames: ${heroMap.size}`);

  const allProducts = new Map();
  const primaryBasenames = new Set();

  for (const bucket of heroMap.values()) {
    for (const handle of bucket.handles) {
      if (allProducts.has(handle)) continue;
      const product = await fetchProduct(handle);
      allProducts.set(handle, product);
      if (product?.primaryBasename) {
        primaryBasenames.add(product.primaryBasename.toLowerCase());
      }
    }
  }

  const results = {
    generatedAt: new Date().toISOString(),
    mode: apply ? "apply" : "dry-run",
    postCount: posts.length,
    uniqueHeroCount: heroMap.size,
    eligible: [],
    skipped_product_primary: [],
    already_lifestyle: [],
    no_lifestyle_source: [],
    missing_shopify_file: [],
    errors: [],
    updated: [],
  };

  const tempDir = path.join(os.tmpdir(), "editpro-hero-swap");
  if (apply && !fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  for (const [basename, bucket] of heroMap.entries()) {
    const normBasename = basename.toLowerCase();
    const record = {
      heroBasename: basename,
      heroSrc: bucket.heroSrc,
      postCount: bucket.posts.length,
      posts: bucket.posts,
      handles: [...bucket.handles],
    };

    if (!isBasePaintingFilename(basename)) {
      results.already_lifestyle.push({
        ...record,
        reason: "Hero is not a base painting (-1); already lifestyle or non-standard.",
      });
      continue;
    }

    if (primaryBasenames.has(normBasename)) {
      results.skipped_product_primary.push({
        ...record,
        reason: "Hero basename matches a live product primary image (images[0]).",
      });
      continue;
    }

    let lifestyleSource = null;
    let sourceHandle = null;
    let preferredRoom = "";

    for (const post of bucket.posts) {
      preferredRoom = parseRoomFromFilename(post.title) || preferredRoom;
    }

    for (const handle of bucket.handles) {
      const product = allProducts.get(handle);
      if (!product) continue;
      const pick = pickLifestyleSource(product, preferredRoom);
      if (pick) {
        lifestyleSource = pick;
        sourceHandle = handle;
        break;
      }
    }

    if (!lifestyleSource) {
      for (const [, product] of allProducts) {
        if (!product) continue;
        const pick = pickLifestyleSource(product, preferredRoom);
        if (pick) {
          lifestyleSource = pick;
          sourceHandle = product.handle;
          break;
        }
      }
    }

    if (!lifestyleSource) {
      results.no_lifestyle_source.push({
        ...record,
        reason: "No lifestyle image in linked product gallery (images[1+]).",
      });
      continue;
    }

    const eligible = {
      ...record,
      preferredRoom: preferredRoom || null,
      lifestyleSource,
      sourceHandle,
      lifestyleBasename: filenameFromUrl(lifestyleSource),
    };
    results.eligible.push(eligible);

    const found = await findShopifyFileByFilename(
      credentials.storeDomain,
      credentials.accessToken,
      basename
    );

    if (!found.match) {
      results.missing_shopify_file.push({
        ...eligible,
        reason: found.reason,
      });
      continue;
    }

    if (!apply) {
      console.log(
        `DRY eligible: ${basename} ← ${filenameFromUrl(lifestyleSource)} (${bucket.posts.length} post(s))`
      );
      continue;
    }

    try {
      const ext = path.extname(basename) || ".jpg";
      const localPath = path.join(tempDir, basename);
      await downloadToFile(lifestyleSource, localPath);
      const staged = await stagedUploadAsFile(
        credentials.storeDomain,
        credentials.accessToken,
        localPath,
        basename
      );
      const updatedFile = await replaceFileContent(
        credentials.storeDomain,
        credentials.accessToken,
        found.match.id,
        staged.resourceUrl
      );
      results.updated.push({
        ...eligible,
        shopifyFileId: found.match.id,
        newFileStatus: updatedFile?.fileStatus || "",
        newUrl: updatedFile?.image?.url || updatedFile?.url || found.match.url,
      });
      console.log(`UPDATED ${basename}`);
      try {
        fs.unlinkSync(localPath);
      } catch {
        // ignore
      }
    } catch (error) {
      results.errors.push({
        ...eligible,
        reason: error.message || String(error),
      });
      console.log(`ERROR ${basename}: ${error.message || error}`);
    }
  }

  fs.writeFileSync(REPORT_PATH, JSON.stringify(results, null, 2));

  console.log("");
  console.log("Summary");
  console.log(`  eligible: ${results.eligible.length}`);
  console.log(`  skipped_product_primary: ${results.skipped_product_primary.length}`);
  console.log(`  already_lifestyle: ${results.already_lifestyle.length}`);
  console.log(`  no_lifestyle_source: ${results.no_lifestyle_source.length}`);
  console.log(`  missing_shopify_file: ${results.missing_shopify_file.length}`);
  console.log(`  updated: ${results.updated.length}`);
  console.log(`  errors: ${results.errors.length}`);
  console.log(`Report: ${REPORT_PATH}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
