#!/usr/bin/env node
/**
 * Fix broken blog images using live Shopify product media.
 *
 * Rules:
 * - carousel (blogpro-product-stack): always product cover (media[0])
 * - body / featured: never media[0]; prefer index>=1 else next available media[1+]
 * - within one article, no image URL may repeat (query string ignored)
 *
 * Usage:
 *   node scripts/fix-blog-images-from-products.js
 *   node scripts/fix-blog-images-from-products.js --apply
 *   node scripts/fix-blog-images-from-products.js --article=<id|handle>
 *   node scripts/fix-blog-images-from-products.js --article=<id|handle> --apply
 *
 * Article list defaults to unique articleIds in ~/.editpro/broken-blog-images.csv
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { getShopifyCredentials } = require("../lib/config-store");
const { shopifyGraphql } = require("../lib/shopify-client");

const CONFIG_DIR = path.join(os.homedir(), ".editpro");
const REPORT_PATH = path.join(CONFIG_DIR, "blog-image-fix-report.json");
const BROKEN_CSV_PATH = path.join(CONFIG_DIR, "broken-blog-images.csv");
const BROKEN_STATUSES = new Set([403, 404, 410]);

function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
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

function productIdFromFilename(filename) {
  const match = String(filename || "").match(/^(\d{4,6})_/);
  return match ? match[1] : null;
}

function imageIndexFromFilename(filename) {
  const base = String(filename || "").replace(/\.[^.]+$/, "");
  const match = base.match(/_(\d+)(?:_|$)/);
  if (!match) return null;
  const index = Number(match[1]);
  return Number.isFinite(index) ? index : null;
}

function parseArgs(argv) {
  const apply = argv.includes("--apply");
  let articleFilter = "";
  for (const arg of argv) {
    if (arg.startsWith("--article=")) {
      articleFilter = arg.slice("--article=".length).trim();
    }
  }
  return { apply, articleFilter };
}

function parseCsvLine(line) {
  const cols = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      cols.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  cols.push(current);
  return cols;
}

function loadBrokenCsv() {
  if (!fs.existsSync(BROKEN_CSV_PATH)) {
    throw new Error(`Broken image CSV not found: ${BROKEN_CSV_PATH}. Run scan-broken-blog-images.js first.`);
  }
  const text = fs.readFileSync(BROKEN_CSV_PATH, "utf8");
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) {
    return { brokenSet: new Set(), articles: [] };
  }
  const header = parseCsvLine(lines[0]);
  const idx = Object.fromEntries(header.map((name, i) => [name, i]));
  const brokenSet = new Set();
  const byArticle = new Map();

  for (const line of lines.slice(1)) {
    const cols = parseCsvLine(line);
    const imageUrl = cols[idx.imageUrl] || "";
    const articleId = cols[idx.articleId] || "";
    const articleTitle = cols[idx.articleTitle] || "";
    const articleHandle = cols[idx.articleHandle] || "";
    if (imageUrl.startsWith("http")) {
      brokenSet.add(imageUrl);
      brokenSet.add(normalizeUrl(imageUrl));
    }
    if (!articleId) continue;
    if (!byArticle.has(articleId)) {
      byArticle.set(articleId, {
        articleId,
        articleTitle,
        articleHandle,
      });
    }
  }

  return {
    brokenSet,
    articles: [...byArticle.values()],
  };
}

async function probeUrl(url) {
  const tryRequest = async (method) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(url, {
        method,
        redirect: "follow",
        signal: controller.signal,
        headers: {
          "User-Agent": "EditPro-BlogImageFix/1.0",
          Accept: "image/*,*/*",
        },
      });
      return { status: response.status, ok: response.ok };
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    let result = await tryRequest("HEAD");
    if (result.status === 405 || result.status === 501 || result.status === 403) {
      result = await tryRequest("GET");
    }
    return result;
  } catch (error) {
    return { status: 0, ok: false, error: error.message || "network error" };
  }
}

async function isBrokenOrWrong(src, brokenSet, role, coverUrl) {
  if (!src) return true;
  const norm = normalizeUrl(src);
  if (brokenSet.has(src) || brokenSet.has(norm)) {
    return true;
  }
  const coverNorm = coverUrl ? normalizeUrl(coverUrl) : "";
  if ((role === "body" || role === "featured") && coverNorm && norm === coverNorm) {
    return true;
  }
  if (role === "carousel" && coverNorm && norm !== coverNorm) {
    return true;
  }
  const probe = await probeUrl(src);
  return !probe.ok || BROKEN_STATUSES.has(probe.status);
}

function pickUniqueUrl({ role, oldSrc, mediaUrls, usedUrls }) {
  if (!mediaUrls.length) {
    return { url: null, reason: "Product has no media." };
  }

  const tryClaim = (url, reason) => {
    const norm = normalizeUrl(url);
    if (!norm || usedUrls.has(norm)) {
      return null;
    }
    return { url, reason };
  };

  if (role === "carousel") {
    const cover = mediaUrls[0];
    const claimed = tryClaim(cover, "carousel uses cover media[0]");
    if (claimed) return claimed;
    return { url: null, reason: "cover already used in article" };
  }

  if (mediaUrls.length < 2) {
    return { url: null, reason: "Only one product image; cannot avoid cover for body/featured." };
  }

  const preferredIndex = imageIndexFromFilename(filenameFromUrl(oldSrc));
  const candidateIndexes = [];
  if (preferredIndex != null && preferredIndex >= 1 && preferredIndex < mediaUrls.length) {
    candidateIndexes.push(preferredIndex);
  }
  for (let i = 1; i < mediaUrls.length; i += 1) {
    if (!candidateIndexes.includes(i)) {
      candidateIndexes.push(i);
    }
  }

  for (const index of candidateIndexes) {
    const claimed = tryClaim(
      mediaUrls[index],
      index === preferredIndex
        ? `body/featured uses media[${index}] from filename`
        : `body/featured uses unused media[${index}]`
    );
    if (claimed) return claimed;
  }

  return { url: null, reason: "No unused non-cover media left for this article." };
}

async function fetchArticle(storeDomain, accessToken, articleId) {
  const data = await shopifyGraphql(
    storeDomain,
    accessToken,
    `query ArticleById($id: ID!) {
      article(id: $id) {
        id
        title
        handle
        body
        image { url altText }
        blog { id title handle }
      }
    }`,
    { id: articleId }
  );
  if (!data.article?.id) {
    throw new Error(`Article not found: ${articleId}`);
  }
  return data.article;
}

async function fetchProductMedia(storeDomain, accessToken, handle, cache) {
  if (cache.has(handle)) {
    return cache.get(handle);
  }
  const data = await shopifyGraphql(
    storeDomain,
    accessToken,
    `query ProductByHandle($handle: String!) {
      productByHandle(handle: $handle) {
        id
        title
        handle
        media(first: 50) {
          nodes {
            ... on MediaImage {
              id
              image { url altText }
            }
          }
        }
      }
    }`,
    { handle }
  );
  const product = data.productByHandle;
  if (!product?.id) {
    cache.set(handle, null);
    return null;
  }
  const mediaUrls = (product.media?.nodes || [])
    .map((node) => node?.image?.url)
    .filter(Boolean);
  const value = { product, mediaUrls };
  cache.set(handle, value);
  return value;
}

async function findHandleByProductId(storeDomain, accessToken, productId, knownHandles, idCache) {
  if (idCache.has(productId)) {
    return idCache.get(productId);
  }
  for (const [handle, info] of knownHandles) {
    if (info.sampleFilenames?.some((name) => name.startsWith(`${productId}_`))) {
      idCache.set(productId, handle);
      return handle;
    }
  }

  const data = await shopifyGraphql(
    storeDomain,
    accessToken,
    `query ProductsByIdHint($query: String!) {
      products(first: 10, query: $query) {
        nodes {
          id
          handle
          title
          media(first: 5) {
            nodes {
              ... on MediaImage {
                image { url }
              }
            }
          }
        }
      }
    }`,
    { query: productId }
  );

  let resolved = null;
  for (const product of data.products?.nodes || []) {
    const urls = (product.media?.nodes || []).map((n) => n?.image?.url).filter(Boolean);
    const hit = urls.some((url) => filenameFromUrl(url).startsWith(`${productId}_`));
    if (hit || product.handle.includes(productId)) {
      resolved = product.handle;
      break;
    }
  }
  if (!resolved && (data.products?.nodes || []).length === 1) {
    resolved = data.products.nodes[0].handle;
  }
  idCache.set(productId, resolved);
  return resolved;
}

function extractProductHandlesFromBody(bodyHtml) {
  const handles = new Set();
  const re = /\/products\/([a-z0-9\-]+)/gi;
  let match;
  while ((match = re.exec(bodyHtml))) {
    handles.add(match[1].toLowerCase());
  }
  return [...handles];
}

function findBodyImageTargets(bodyHtml) {
  const targets = [];
  const stackRe = /<div\b[^>]*class="[^"]*\bblogpro-product-stack\b[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
  const stackRanges = [];
  let stackMatch;
  while ((stackMatch = stackRe.exec(bodyHtml))) {
    stackRanges.push({
      start: stackMatch.index,
      end: stackMatch.index + stackMatch[0].length,
    });
  }

  function roleAt(index) {
    for (const range of stackRanges) {
      if (index >= range.start && index < range.end) {
        return "carousel";
      }
    }
    return "body";
  }

  const anchorRe =
    /<a\b[^>]*href=["'][^"']*\/products\/([a-z0-9\-]+)["'][^>]*>([\s\S]*?)<\/a>|<a\b[^>]*class=["'][^"']*\bblogpro-link\b[^"']*["'][^>]*href=["'][^"']*\/products\/([a-z0-9\-]+)["'][^>]*>([\s\S]*?)<\/a>/gi;

  const claimedImgIndexes = new Set();
  let anchorMatch;
  while ((anchorMatch = anchorRe.exec(bodyHtml))) {
    const handle = (anchorMatch[1] || anchorMatch[3] || "").toLowerCase();
    const inner = anchorMatch[2] || anchorMatch[4] || "";
    const anchorStart = anchorMatch.index;
    const role = roleAt(anchorStart);
    const imgRe = /<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;
    let imgMatch;
    while ((imgMatch = imgRe.exec(inner))) {
      const absIndex = anchorStart + anchorMatch[0].indexOf(imgMatch[0]);
      claimedImgIndexes.add(absIndex);
      targets.push({
        role,
        handle,
        oldSrc: imgMatch[1],
        imgTag: imgMatch[0],
        absIndex,
      });
    }
  }

  const allImgRe = /<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;
  let imgMatch;
  while ((imgMatch = allImgRe.exec(bodyHtml))) {
    if (claimedImgIndexes.has(imgMatch.index)) continue;
    targets.push({
      role: roleAt(imgMatch.index),
      handle: null,
      oldSrc: imgMatch[1],
      imgTag: imgMatch[0],
      absIndex: imgMatch.index,
      productIdHint: productIdFromFilename(filenameFromUrl(imgMatch[1])),
    });
  }

  return targets;
}

function buildKnownHandleHints(targets) {
  const map = new Map();
  for (const target of targets) {
    if (!target.handle) continue;
    if (!map.has(target.handle)) {
      map.set(target.handle, { sampleFilenames: [] });
    }
    map.get(target.handle).sampleFilenames.push(filenameFromUrl(target.oldSrc));
  }
  return map;
}

async function updateArticle(storeDomain, accessToken, articleId, { body, imageSrc, imageAlt }) {
  const articleInput = {};
  if (body != null) {
    articleInput.body = body;
  }
  if (imageSrc) {
    articleInput.image = {
      src: imageSrc,
      ...(imageAlt ? { altText: imageAlt } : {}),
    };
  }

  const data = await shopifyGraphql(
    storeDomain,
    accessToken,
    `mutation ArticleUpdate($id: ID!, $article: ArticleUpdateInput!) {
      articleUpdate(id: $id, article: $article) {
        article { id title image { url } }
        userErrors { field message }
      }
    }`,
    {
      id: articleId,
      article: articleInput,
    }
  );
  const errors = data.articleUpdate?.userErrors || [];
  if (errors.length) {
    throw new Error(errors.map((e) => e.message).join("; "));
  }
  return data.articleUpdate.article;
}

function collectDuplicateUrls(bodyHtml, featuredUrl) {
  const counts = new Map();
  const add = (url) => {
    const norm = normalizeUrl(url);
    if (!norm) return;
    counts.set(norm, (counts.get(norm) || 0) + 1);
  };
  for (const match of bodyHtml.matchAll(/\bsrc=["']([^"']+)["']/gi)) {
    add(match[1]);
  }
  if (featuredUrl) add(featuredUrl);
  return [...counts.entries()].filter(([, count]) => count > 1).map(([url]) => url);
}

async function planArticle({
  storeDomain,
  accessToken,
  articleMeta,
  brokenSet,
  mediaCache,
  idCache,
}) {
  const article = await fetchArticle(storeDomain, accessToken, articleMeta.articleId);
  const targets = findBodyImageTargets(article.body || "");
  const knownHints = buildKnownHandleHints(targets);

  if (article.image?.url) {
    targets.push({
      role: "featured",
      handle: null,
      oldSrc: article.image.url,
      imgTag: null,
      absIndex: -1,
      productIdHint: productIdFromFilename(filenameFromUrl(article.image.url)),
    });
  }

  for (const target of targets) {
    if (target.handle) continue;
    const productId = target.productIdHint || productIdFromFilename(filenameFromUrl(target.oldSrc));
    if (!productId) continue;
    const handle = await findHandleByProductId(
      storeDomain,
      accessToken,
      productId,
      knownHints,
      idCache
    );
    if (handle) target.handle = handle;
  }

  const handlesNeeded = [
    ...new Set(
      targets
        .map((t) => t.handle)
        .filter(Boolean)
        .concat(extractProductHandlesFromBody(article.body || ""))
    ),
  ];

  for (const handle of handlesNeeded) {
    await fetchProductMedia(storeDomain, accessToken, handle, mediaCache);
  }

  // Probe which images need fixing, then assign in role order with uniqueness.
  const needsFixFlags = new Map();
  for (const target of targets) {
    const key = `${target.role}:${target.absIndex}:${target.oldSrc}`;
    const mediaInfo = target.handle ? mediaCache.get(target.handle) : null;
    const coverUrl = mediaInfo?.mediaUrls?.[0] || "";
    const needs = await isBrokenOrWrong(target.oldSrc, brokenSet, target.role, coverUrl);
    needsFixFlags.set(key, needs);
  }

  const usedUrls = new Set();
  // Seed with healthy images that will remain.
  for (const target of targets) {
    const key = `${target.role}:${target.absIndex}:${target.oldSrc}`;
    if (!needsFixFlags.get(key)) {
      usedUrls.add(normalizeUrl(target.oldSrc));
    }
  }

  const replacements = [];
  const skips = [];
  let newBody = article.body || "";
  let newFeaturedSrc = null;

  const ordered = [
    ...targets.filter((t) => t.role === "carousel"),
    ...targets.filter((t) => t.role === "body").sort((a, b) => a.absIndex - b.absIndex),
    ...targets.filter((t) => t.role === "featured"),
  ];

  // Apply body replacements from end to start after planning, so collect planned first.
  const plannedBody = [];

  for (const target of ordered) {
    const key = `${target.role}:${target.absIndex}:${target.oldSrc}`;
    if (!needsFixFlags.get(key)) {
      continue;
    }

    const mediaInfo = target.handle ? mediaCache.get(target.handle) : null;
    if (!mediaInfo?.mediaUrls?.length) {
      skips.push({
        articleId: article.id,
        articleTitle: article.title,
        role: target.role,
        handle: target.handle || "",
        oldSrc: target.oldSrc,
        reason: "No product handle/media resolved.",
      });
      continue;
    }

    const picked = pickUniqueUrl({
      role: target.role,
      oldSrc: target.oldSrc,
      mediaUrls: mediaInfo.mediaUrls,
      usedUrls,
    });

    if (!picked.url) {
      skips.push({
        articleId: article.id,
        articleTitle: article.title,
        role: target.role,
        handle: target.handle || "",
        oldSrc: target.oldSrc,
        reason: picked.reason,
      });
      continue;
    }

    usedUrls.add(normalizeUrl(picked.url));

    const replacement = {
      articleId: article.id,
      articleTitle: article.title,
      articleHandle: article.handle,
      role: target.role,
      handle: target.handle || "",
      oldSrc: target.oldSrc,
      newSrc: picked.url,
      oldFilename: filenameFromUrl(target.oldSrc),
      newFilename: filenameFromUrl(picked.url),
      reason: picked.reason,
      absIndex: target.absIndex,
      imgTag: target.imgTag,
    };

    if (target.role === "featured") {
      newFeaturedSrc = picked.url;
      replacements.push(replacement);
    } else {
      plannedBody.push(replacement);
      replacements.push(replacement);
    }
  }

  // Apply body replacements from end to start.
  plannedBody.sort((a, b) => b.absIndex - a.absIndex);
  for (const item of plannedBody) {
    if (item.imgTag && newBody.includes(item.imgTag)) {
      const newTag = item.imgTag.replace(item.oldSrc, item.newSrc);
      newBody = newBody.replace(item.imgTag, newTag);
    } else {
      // Replace only first remaining occurrence near this index if possible.
      const idx = newBody.indexOf(item.oldSrc);
      if (idx >= 0) {
        newBody = newBody.slice(0, idx) + item.newSrc + newBody.slice(idx + item.oldSrc.length);
      }
    }
  }

  return {
    article,
    newBody,
    newFeaturedSrc,
    newFeaturedAlt: article.image?.altText || "",
    replacements,
    skips,
  };
}

function verifyPlannedBody(newBody, featuredUrl, mediaCache, replacements) {
  const roleErrors = [];
  const targets = findBodyImageTargets(newBody);
  for (const target of targets) {
    if (!target.handle) continue;
    const mediaInfo = mediaCache.get(target.handle);
    if (!mediaInfo?.mediaUrls?.length) continue;
    const cover = normalizeUrl(mediaInfo.mediaUrls[0]);
    const srcBase = normalizeUrl(target.oldSrc);
    if (target.role === "carousel" && srcBase !== cover) {
      roleErrors.push(`carousel ${target.handle} is not cover`);
    }
    if (target.role === "body" && srcBase === cover) {
      roleErrors.push(`body ${target.handle} still uses cover`);
    }
  }

  const featuredRep = replacements.find((r) => r.role === "featured");
  if (featuredRep?.handle) {
    const mediaInfo = mediaCache.get(featuredRep.handle);
    if (mediaInfo?.mediaUrls?.[0] && featuredUrl) {
      if (normalizeUrl(featuredUrl) === normalizeUrl(mediaInfo.mediaUrls[0])) {
        roleErrors.push("featured image uses cover");
      }
    }
  }

  const duplicates = collectDuplicateUrls(newBody, featuredUrl);
  return { roleErrors, duplicates };
}

async function main() {
  const { apply, articleFilter } = parseArgs(process.argv.slice(2));
  const credentials = getShopifyCredentials();
  if (!credentials.storeDomain || !credentials.accessToken) {
    throw new Error("Shopify is not connected. Add credentials in EditPro Settings.");
  }

  ensureConfigDir();
  const { brokenSet, articles: allArticles } = loadBrokenCsv();
  let articles = allArticles;
  if (articleFilter) {
    const filter = articleFilter.toLowerCase();
    articles = allArticles.filter(
      (a) =>
        a.articleId === articleFilter ||
        a.articleId.toLowerCase().endsWith(`/${filter}`) ||
        (a.articleHandle || "").toLowerCase() === filter ||
        (a.articleTitle || "").toLowerCase().includes(filter)
    );
    if (!articles.length) {
      throw new Error(`No articles matched --article=${articleFilter}`);
    }
  }

  console.log(`Store: ${credentials.storeDomain}`);
  console.log(`Mode: ${apply ? "APPLY" : "DRY-RUN"}`);
  console.log(`Articles: ${articles.length}`);
  console.log(`Broken URL set: ${brokenSet.size}`);
  console.log("");

  const mediaCache = new Map();
  const idCache = new Map();
  const allReplacements = [];
  const allSkips = [];
  const articleResults = [];

  for (let i = 0; i < articles.length; i += 1) {
    const meta = articles[i];
    process.stdout.write(`[${i + 1}/${articles.length}] ${meta.articleTitle || meta.articleHandle || meta.articleId}… `);
    try {
      const plan = await planArticle({
        storeDomain: credentials.storeDomain,
        accessToken: credentials.accessToken,
        articleMeta: meta,
        brokenSet,
        mediaCache,
        idCache,
      });

      const featuredForVerify = plan.newFeaturedSrc || plan.article.image?.url || "";
      const { roleErrors, duplicates } = verifyPlannedBody(
        plan.newBody,
        featuredForVerify,
        mediaCache,
        plan.replacements
      );

      let applyStatus = "dry-run";
      let applyError = "";
      let verified = plan.replacements;

      if (apply && plan.replacements.length) {
        try {
          await updateArticle(credentials.storeDomain, credentials.accessToken, plan.article.id, {
            body: plan.newBody,
            imageSrc: plan.newFeaturedSrc || undefined,
            imageAlt: plan.newFeaturedAlt || undefined,
          });
          applyStatus = "updated";

          const refreshed = await fetchArticle(
            credentials.storeDomain,
            credentials.accessToken,
            plan.article.id
          );
          const liveFeatured = refreshed.image?.url || "";
          const liveCheck = verifyPlannedBody(
            refreshed.body || "",
            liveFeatured,
            mediaCache,
            plan.replacements
          );

          verified = [];
          for (const item of plan.replacements) {
            const probe = await probeUrl(item.newSrc);
            verified.push({
              ...item,
              verifyStatus: probe.status,
              verifyOk: Boolean(probe.ok),
            });
          }

          const failedUrls = verified.filter((v) => !v.verifyOk);
          if (liveCheck.roleErrors.length || liveCheck.duplicates.length || failedUrls.length) {
            applyStatus = "updated-with-warnings";
            applyError = [
              ...liveCheck.roleErrors,
              ...liveCheck.duplicates.map((u) => `duplicate ${filenameFromUrl(u)}`),
              ...failedUrls.map((v) => `bad url ${v.newFilename}`),
            ].join("; ");
          }
        } catch (error) {
          applyStatus = "error";
          applyError = error.message || String(error);
        }
      } else if (apply && !plan.replacements.length) {
        applyStatus = "noop";
      }

      allReplacements.push(...verified);
      allSkips.push(...plan.skips);
      articleResults.push({
        articleId: plan.article.id,
        articleTitle: plan.article.title,
        articleHandle: plan.article.handle,
        replacementCount: plan.replacements.length,
        skipCount: plan.skips.length,
        planRoleErrors: roleErrors,
        planDuplicates: duplicates,
        status: applyStatus,
        error: applyError,
      });

      console.log(
        `${plan.replacements.length} replacements, ${plan.skips.length} skips` +
          (apply ? ` → ${applyStatus}` : "")
      );
    } catch (error) {
      console.log(`ERROR: ${error.message || error}`);
      articleResults.push({
        articleId: meta.articleId,
        articleTitle: meta.articleTitle,
        articleHandle: meta.articleHandle,
        replacementCount: 0,
        skipCount: 0,
        status: "error",
        error: error.message || String(error),
      });
    }
  }

  const summary = {
    mode: apply ? "apply" : "dry-run",
    articleCount: articles.length,
    replacementCount: allReplacements.length,
    skipCount: allSkips.length,
    updated: articleResults.filter((a) => a.status === "updated" || a.status === "updated-with-warnings").length,
    errors: articleResults.filter((a) => a.status === "error").length,
    warnings: articleResults.filter((a) => a.status === "updated-with-warnings").length,
  };

  const report = {
    summary,
    articles: articleResults,
    replacements: allReplacements,
    skips: allSkips,
  };
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), "utf8");

  console.log("");
  console.log("=== SUMMARY ===");
  console.log(`Articles: ${summary.articleCount}`);
  console.log(`Replacements: ${summary.replacementCount}`);
  console.log(`Skips: ${summary.skipCount}`);
  if (apply) {
    console.log(`Updated: ${summary.updated}`);
    console.log(`Warnings: ${summary.warnings}`);
    console.log(`Errors: ${summary.errors}`);
  }
  console.log(`Report: ${REPORT_PATH}`);

  if (!apply) {
    console.log("");
    console.log("Dry-run complete. Re-run with --apply to update Shopify.");
  }

  if (apply && summary.errors > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`Error: ${error.message || error}`);
  process.exit(1);
});
