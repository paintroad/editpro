#!/usr/bin/env node
/**
 * Build placement-correct Deprecated images from live Shopify product media.
 *
 * Rules (matches fix-blog-images-from-products.js / BlogPro image-pool):
 * - carousel (blogpro-product-stack): media[0]
 * - body/section: media[1+] only, per-article dedup
 *
 * Only re-downloads slug-named missing files (*-original-painting-online-at-paintroad-*).
 * SKU catalog copies in Deprecated are left untouched.
 *
 * Usage:
 *   node scripts/build-deprecated-images-from-live.js
 *   node scripts/build-deprecated-images-from-live.js --apply
 *   node scripts/build-deprecated-images-from-live.js --folder="C:\\Users\\divya\\Downloads\\Deprecated" --apply
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

const CONFIG_DIR = path.join(os.homedir(), ".editpro");
const DEFAULT_FOLDER = "C:\\Users\\divya\\Downloads\\Deprecated";
const BLOGGER_FEED = "https://mypaintroad.blogspot.com/feeds/posts/default?alt=json&max-results=150";
const STOREFRONT = "https://paintroad.com";
const REPORT_JSON = path.join(CONFIG_DIR, "deprecated-live-selection-report.json");
const BROKEN_STATUSES = new Set([403, 404, 410]);

const HANDLE_ALIASES = {
  "perfect-isnt-real": "perfect-isn-t-real",
};

function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

function parseArgs(argv) {
  const apply = argv.includes("--apply");
  let folder = DEFAULT_FOLDER;
  for (const arg of argv) {
    if (arg.startsWith("--folder=")) {
      folder = arg.slice("--folder=".length).trim().replace(/^["']|["']$/g, "");
    }
  }
  return { apply, folder };
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

function isSlugRecoveryFile(filename) {
  return /-original-painting-online-at-paintroad-\d+\./i.test(filename);
}

function handleFromSlugFilename(filename) {
  const base = String(filename || "").replace(/\.[^.]+$/, "");
  let stem = base.replace(/-\d+$/, "");
  stem = stem.replace(/-original-painting-online-at-paintroad$/, "");
  if (HANDLE_ALIASES[stem]) {
    stem = HANDLE_ALIASES[stem];
  }
  return stem;
}

function pickUniqueUrl({ role, oldSrc, mediaUrls, usedUrls }) {
  if (!mediaUrls.length) {
    return { url: null, mediaIndex: null, reason: "Product has no media." };
  }

  const tryClaim = (url, mediaIndex, reason) => {
    const norm = normalizeUrl(url);
    if (!norm || usedUrls.has(norm)) {
      return null;
    }
    return { url, mediaIndex, reason };
  };

  if (role === "carousel") {
    const claimed = tryClaim(mediaUrls[0], 0, "carousel uses media[0]");
    if (claimed) return claimed;
    return { url: null, mediaIndex: null, reason: "cover already used in article" };
  }

  if (mediaUrls.length < 2) {
    return {
      url: null,
      mediaIndex: null,
      reason: "Only one product image; cannot avoid cover for body/section.",
    };
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
      index,
      index === preferredIndex
        ? `body/section uses media[${index}] from filename`
        : `body/section uses unused media[${index}]`
    );
    if (claimed) return claimed;
  }

  return {
    url: null,
    mediaIndex: null,
    reason: "No unused non-cover media left for this article.",
  };
}

function findBodyImageTargets(bodyHtml) {
  const targets = [];
  const stackRe =
    /<div\b[^>]*class="[^"]*\bblogpro-product-stack\b[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
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
      absIndex: imgMatch.index,
      productIdHint: productIdFromFilename(filenameFromUrl(imgMatch[1])),
    });
  }

  return targets;
}

async function probeUrl(url) {
  const norm = normalizeUrl(url);
  if (!norm || !norm.includes("cdn.shopify.com")) {
    return { ok: true, status: 200 };
  }
  try {
    const code = execFileSync(
      "curl.exe",
      ["-sI", "-o", "NUL", "-w", "%{http_code}", "--max-time", "20", norm],
      { encoding: "utf8" }
    ).trim();
    const status = Number(code) || 0;
    const ok =
      status === 200 || status === 301 || status === 302 || status === 206;
    return { ok, status };
  } catch {
    return { ok: false, status: 0 };
  }
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

const productMediaCache = new Map();

async function fetchProductMediaUrls(handle) {
  const key = String(handle || "").toLowerCase();
  if (!key) return null;
  if (productMediaCache.has(key)) {
    return productMediaCache.get(key);
  }
  try {
    const res = await fetch(`${STOREFRONT}/products/${key}.json`, {
      signal: AbortSignal.timeout(45000),
    });
    if (!res.ok) {
      productMediaCache.set(key, null);
      return null;
    }
    const data = await res.json();
    const urls = (data.product?.images || [])
      .map((img) => normalizeUrl(img.src))
      .filter(Boolean);
    productMediaCache.set(key, urls);
    return urls;
  } catch {
    productMediaCache.set(key, null);
    return null;
  }
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

function resolveHandle(target) {
  if (target.handle) return target.handle;
  const fn = filenameFromUrl(target.oldSrc);
  if (isSlugRecoveryFile(fn)) {
    return handleFromSlugFilename(fn);
  }
  return null;
}

async function main() {
  const { apply, folder } = parseArgs(process.argv.slice(2));
  ensureConfigDir();

  if (!fs.existsSync(folder)) {
    throw new Error(`Folder not found: ${folder}`);
  }

  console.log(`Mode: ${apply ? "APPLY" : "DRY-RUN"}`);
  console.log(`Deprecated folder: ${folder}`);
  console.log("Fetching Blogger posts…");
  const posts = await fetchBloggerPosts();
  console.log(`Posts: ${posts.length}`);

  const probeCache = new Map();
  async function isBrokenShopifyUrl(src) {
    const norm = normalizeUrl(src);
    if (!norm.includes("cdn.shopify.com")) return false;
    if (probeCache.has(norm)) return probeCache.get(norm);
    const probe = await probeUrl(norm);
    const broken = !probe.ok || BROKEN_STATUSES.has(probe.status);
    probeCache.set(norm, broken);
    return broken;
  }

  const assignments = new Map();
  const unresolved = [];
  const perPostResults = [];

  for (const post of posts) {
    const targets = findBodyImageTargets(post.html);
    const usedUrls = new Set();
    const postPicks = [];

    for (const target of targets.sort((a, b) => a.absIndex - b.absIndex)) {
      const filename = filenameFromUrl(target.oldSrc);
      if (!isSlugRecoveryFile(filename)) continue;
      if (!(await isBrokenShopifyUrl(target.oldSrc))) continue;

      if (assignments.has(filename)) {
        postPicks.push({ filename, reused: true, ...assignments.get(filename) });
        continue;
      }

      const handle = resolveHandle(target);
      if (!handle) {
        unresolved.push({
          filename,
          postTitle: post.title,
          reason: "Could not resolve product handle",
        });
        continue;
      }

      const mediaUrls = await fetchProductMediaUrls(handle);
      if (!mediaUrls?.length) {
        unresolved.push({
          filename,
          handle,
          postTitle: post.title,
          reason: "Product not found or has no images",
        });
        continue;
      }

      const pick = pickUniqueUrl({
        role: target.role,
        oldSrc: target.oldSrc,
        mediaUrls,
        usedUrls,
      });

      if (!pick.url) {
        unresolved.push({
          filename,
          handle,
          role: target.role,
          postTitle: post.title,
          reason: pick.reason,
        });
        continue;
      }

      usedUrls.add(normalizeUrl(pick.url));
      const entry = {
        filename,
        role: target.role,
        handle,
        chosenUrl: pick.url,
        chosenBasename: filenameFromUrl(pick.url),
        mediaIndex: pick.mediaIndex,
        reason: pick.reason,
        postTitle: post.title,
      };
      assignments.set(filename, entry);
      postPicks.push(entry);
    }

    if (postPicks.length) {
      perPostResults.push({ postId: post.id, title: post.title, picks: postPicks });
    }
  }

  console.log(`Slug broken files to replace: ${assignments.size}`);
  console.log(`Unresolved: ${unresolved.length}`);

  const downloadResults = [];
  if (apply) {
    for (const entry of assignments.values()) {
      const dest = path.join(folder, entry.filename);
      try {
        const bytes = await downloadToFile(entry.chosenUrl, dest);
        entry.status = "downloaded";
        entry.bytes = bytes;
        console.log(
          `OK ${entry.filename} <= ${entry.chosenBasename} [${entry.role} media[${entry.mediaIndex}]]`
        );
        downloadResults.push({ ...entry, dest });
      } catch (error) {
        entry.status = "error";
        entry.error = error.message || String(error);
        console.log(`FAIL ${entry.filename}: ${entry.error}`);
        downloadResults.push({ ...entry, dest });
      }
    }
  } else {
    for (const entry of assignments.values()) {
      console.log(
        `PLAN ${entry.filename} | ${entry.role} | ${entry.handle} | media[${entry.mediaIndex}] | ${entry.chosenBasename}`
      );
    }
  }

  const carouselCount = [...assignments.values()].filter((e) => e.role === "carousel").length;
  const bodyCount = [...assignments.values()].filter((e) => e.role === "body").length;
  const media0 = [...assignments.values()].filter((e) => e.mediaIndex === 0).length;
  const media1plus = [...assignments.values()].filter((e) => e.mediaIndex >= 1).length;

  const summary = {
    mode: apply ? "apply" : "dry-run",
    folder,
    postsScanned: posts.length,
    slugAssignments: assignments.size,
    carouselAssignments: carouselCount,
    bodyAssignments: bodyCount,
    mediaIndex0: media0,
    mediaIndex1Plus: media1plus,
    unresolved: unresolved.length,
    downloaded: downloadResults.filter((r) => r.status === "downloaded").length,
    errors: downloadResults.filter((r) => r.status === "error").length,
    generatedAt: new Date().toISOString(),
  };

  const report = {
    summary,
    assignments: [...assignments.values()],
    unresolved,
    perPostResults,
    downloadResults,
  };

  fs.writeFileSync(REPORT_JSON, JSON.stringify(report, null, 2), "utf8");

  const txtLines = [
    "Deprecated live image selection report",
    `Generated: ${summary.generatedAt}`,
    `Mode: ${summary.mode}`,
    `Slug files assigned: ${summary.slugAssignments}`,
    `Carousel (media[0]): ${summary.carouselAssignments} assignments, ${summary.mediaIndex0} at index 0`,
    `Body/section (media[1+]): ${summary.bodyAssignments} assignments, ${summary.mediaIndex1Plus} at index 1+`,
    `Unresolved: ${summary.unresolved}`,
    "",
    "filename\trole\thandle\tmediaIndex\tchosenBasename\tchosenUrl",
    ...report.assignments.map(
      (a) =>
        `${a.filename}\t${a.role}\t${a.handle}\t${a.mediaIndex}\t${a.chosenBasename}\t${a.chosenUrl}`
    ),
  ];
  if (unresolved.length) {
    txtLines.push("", "UNRESOLVED:");
    for (const u of unresolved) {
      txtLines.push(`${u.filename}\t${u.reason}\t${u.handle || ""}\t${u.postTitle || ""}`);
    }
  }
  const txtReport = path.join(folder, "live-selection-report.txt");
  fs.writeFileSync(txtReport, txtLines.join("\n"), "utf8");

  console.log("");
  console.log("=== SUMMARY ===");
  console.log(JSON.stringify(summary, null, 2));
  console.log(`JSON report: ${REPORT_JSON}`);
  console.log(`Text report: ${txtReport}`);

  if (!apply) {
    console.log("");
    console.log("Dry-run complete. Re-run with --apply to download into Deprecated.");
  }

  if (unresolved.length > 0 || summary.errors > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`Error: ${error.message || error}`);
  process.exit(1);
});
