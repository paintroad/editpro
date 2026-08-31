#!/usr/bin/env node
/**
 * Scan all Shopify blog articles for broken images (featured + body HTML).
 *
 * Usage:
 *   node scripts/scan-broken-blog-images.js
 *
 * Writes: ~/.editpro/broken-blog-images.csv
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { getShopifyCredentials } = require("../lib/config-store");
const { shopifyGraphql } = require("../lib/shopify-client");

const CONFIG_DIR = path.join(os.homedir(), ".editpro");
const REPORT_PATH = path.join(CONFIG_DIR, "broken-blog-images.csv");
const PAGE_SIZE = 50;
const CONCURRENCY = 10;
const BROKEN_STATUSES = new Set([403, 404, 410]);

const ARTICLES_QUERY = `query ArticlesWithBody($cursor: String) {
  articles(first: ${PAGE_SIZE}, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      title
      handle
      body
      blog { id title handle }
      image { url }
    }
  }
}`;

function articleStoreUrl(article, storeDomain) {
  const blogHandle = article.blog?.handle || "";
  const articleHandle = article.handle || "";
  if (!storeDomain || !blogHandle || !articleHandle) {
    return "";
  }
  return `https://${storeDomain}/blogs/${blogHandle}/${articleHandle}`;
}

function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

function csvEscape(value) {
  const text = value == null ? "" : String(value);
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function absoluteUrl(rawUrl, storeDomain) {
  const value = String(rawUrl || "").trim();
  if (!value || value.startsWith("data:")) {
    return null;
  }
  if (/^https?:\/\//i.test(value)) {
    return value;
  }
  if (value.startsWith("//")) {
    return `https:${value}`;
  }
  if (value.startsWith("/") && storeDomain) {
    return `https://${storeDomain}${value}`;
  }
  return value;
}

function extractUrlsFromSrcset(srcset) {
  const urls = [];
  for (const part of String(srcset || "").split(",")) {
    const url = part.trim().split(/\s+/)[0];
    if (url) {
      urls.push(url);
    }
  }
  return urls;
}

function extractImageUrlsFromHtml(html) {
  const urls = [];
  const body = String(html || "");
  const srcRe = /<img\b[^>]*?\bsrc\s*=\s*(["'])(.*?)\1/gi;
  const srcsetRe = /<img\b[^>]*?\bsrcset\s*=\s*(["'])(.*?)\1/gi;
  let match;
  while ((match = srcRe.exec(body))) {
    urls.push(match[2]);
  }
  while ((match = srcsetRe.exec(body))) {
    urls.push(...extractUrlsFromSrcset(match[2]));
  }
  return urls;
}

async function fetchAllArticles(storeDomain, accessToken) {
  const articles = [];
  let cursor = null;
  let hasNext = true;

  while (hasNext) {
    let data;
    try {
      data = await shopifyGraphql(storeDomain, accessToken, ARTICLES_QUERY, { cursor });
    } catch (error) {
      const message = String(error.message || error);
      if (/access|scope|denied|unauthorized/i.test(message)) {
        throw new Error(
          "Cannot read blog articles. Ensure your API token has the read_content scope."
        );
      }
      throw error;
    }

    const page = data.articles;
    const nodes = page?.nodes || [];
    articles.push(...nodes);
    process.stdout.write(`\rFetched ${articles.length} articles…`);
    hasNext = Boolean(page?.pageInfo?.hasNextPage);
    cursor = page?.pageInfo?.endCursor || null;
  }

  process.stdout.write("\n");
  return articles;
}

function collectImageReferences(articles, storeDomain) {
  /** @type {Map<string, Array<{article: object, source: string}>>} */
  const byUrl = new Map();

  const add = (rawUrl, article, source) => {
    const url = absoluteUrl(rawUrl, storeDomain);
    if (!url) {
      return;
    }
    if (!byUrl.has(url)) {
      byUrl.set(url, []);
    }
    byUrl.get(url).push({ article, source });
  };

  for (const article of articles) {
    if (article.image?.url) {
      add(article.image.url, article, "featured");
    }
    for (const raw of extractImageUrlsFromHtml(article.body)) {
      add(raw, article, "body");
    }
  }

  return byUrl;
}

async function probeUrl(url) {
  const tryRequest = async (method) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(url, {
        method,
        redirect: "follow",
        signal: controller.signal,
        headers: {
          "User-Agent": "EditPro-BrokenBlogImageScan/1.0",
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
    if (!result.ok || BROKEN_STATUSES.has(result.status)) {
      return {
        ok: false,
        status: result.status,
        error: result.ok ? "" : `HTTP ${result.status}`,
      };
    }
    return { ok: true, status: result.status, error: "" };
  } catch (error) {
    return {
      ok: false,
      status: "",
      error: error.name === "AbortError" ? "timeout" : error.message || "network error",
    };
  }
}

async function mapPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function run() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  }

  const runners = Array.from({ length: Math.min(concurrency, items.length) }, () => run());
  await Promise.all(runners);
  return results;
}

async function probeAllUrls(urls) {
  const broken = new Map();
  let checked = 0;

  await mapPool(urls, CONCURRENCY, async (url) => {
    const result = await probeUrl(url);
    checked += 1;
    if (checked % 5 === 0 || checked === urls.length) {
      process.stdout.write(`\rChecked ${checked}/${urls.length} image URLs…`);
    }
    if (!result.ok) {
      broken.set(url, result);
    }
  });

  process.stdout.write("\n");
  return broken;
}

function writeCsv(rows) {
  ensureConfigDir();
  const header = [
    "imageUrl",
    "httpStatus",
    "error",
    "blogTitle",
    "articleTitle",
    "articleHandle",
    "articleId",
    "articleUrl",
    "source",
  ];
  const lines = [header.join(",")];
  for (const row of rows) {
    lines.push(
      [
        row.imageUrl,
        row.httpStatus,
        row.error,
        row.blogTitle,
        row.articleTitle,
        row.articleHandle,
        row.articleId,
        row.articleUrl,
        row.source,
      ]
        .map(csvEscape)
        .join(",")
    );
  }
  fs.writeFileSync(REPORT_PATH, `${lines.join("\n")}\n`, "utf8");
}

async function main() {
  const credentials = getShopifyCredentials();
  if (!credentials.storeDomain || !credentials.accessToken) {
    throw new Error("Shopify is not connected. Add store domain and access token in EditPro Settings.");
  }

  console.log(`Store: ${credentials.storeDomain}`);
  console.log("Fetching blog articles (including body HTML)…");
  const articles = await fetchAllArticles(credentials.storeDomain, credentials.accessToken);
  if (!articles.length) {
    console.log("No articles found.");
    writeCsv([]);
    console.log(`Empty report written to: ${REPORT_PATH}`);
    return;
  }

  const byUrl = collectImageReferences(articles, credentials.storeDomain);
  const urls = [...byUrl.keys()];
  console.log(`Found ${urls.length} unique image URLs across ${articles.length} articles.`);
  console.log("Probing image URLs…");

  const brokenMap = await probeAllUrls(urls);
  const rows = [];
  for (const [url, probe] of brokenMap) {
    const usages = byUrl.get(url) || [];
    for (const usage of usages) {
      const article = usage.article;
      rows.push({
        imageUrl: url,
        httpStatus: probe.status,
        error: probe.error,
        blogTitle: article.blog?.title || "",
        articleTitle: article.title || "",
        articleHandle: article.handle || "",
        articleId: article.id || "",
        articleUrl: articleStoreUrl(article, credentials.storeDomain),
        source: usage.source,
      });
    }
  }

  rows.sort((a, b) => {
    const blogCmp = a.blogTitle.localeCompare(b.blogTitle);
    if (blogCmp) return blogCmp;
    const titleCmp = a.articleTitle.localeCompare(b.articleTitle);
    if (titleCmp) return titleCmp;
    return a.imageUrl.localeCompare(b.imageUrl);
  });

  writeCsv(rows);

  console.log("");
  console.log(`Broken image usages: ${rows.length}`);
  console.log(`Unique broken URLs: ${brokenMap.size}`);
  console.log(`Report: ${REPORT_PATH}`);
  console.log("");

  if (!brokenMap.size) {
    console.log("No broken blog images found.");
    return;
  }

  console.log("Broken URLs (unique):");
  for (const [url, probe] of brokenMap) {
    const usages = byUrl.get(url) || [];
    const articleTitles = [...new Set(usages.map((u) => u.article.title || u.article.handle || "?"))];
    const status = probe.status || probe.error || "?";
    console.log(`- [${status}] ${url}`);
    console.log(`  used in ${articleTitles.length} article(s): ${articleTitles.slice(0, 5).join("; ")}${articleTitles.length > 5 ? "…" : ""}`);
  }
}

main().catch((error) => {
  console.error(`Error: ${error.message || error}`);
  process.exit(1);
});
