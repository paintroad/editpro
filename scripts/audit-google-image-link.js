#!/usr/bin/env node
/**
 * Read-only audit: which products lack custom.google_image_link, split by creation week and status.
 *
 *   node scripts/audit-google-image-link.js [--since=2026-10-26]
 *
 * Report: ~/.editpro/google-image-link-audit.json
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { getShopifyCredentials } = require("../lib/config-store");
const { shopifyGraphql } = require("../lib/shopify-client");

const REPORT = path.join(os.homedir(), ".editpro", "google-image-link-audit.json");
const sinceArg = process.argv.find((a) => a.startsWith("--since="));
const SINCE = new Date(sinceArg ? sinceArg.slice(8) : Date.now() - 10 * 864e5);

const QUERY = `query($after: String) {
  products(first: 250, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id title handle status createdAt
      variants(first: 1) { nodes { sku } }
      featuredMedia { preview { image { url } } }
      metafield(namespace: "custom", key: "google_image_link") { value }
    }
  }
}`;

async function main() {
  const { storeDomain, accessToken } = getShopifyCredentials();
  const all = [];
  let after = null;
  do {
    const data = await shopifyGraphql(storeDomain, accessToken, QUERY, { after });
    all.push(...data.products.nodes);
    after = data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null;
  } while (after);

  const rows = all.map((p) => ({
    id: p.id,
    title: p.title,
    handle: p.handle,
    status: p.status,
    createdAt: p.createdAt,
    sku: p.variants.nodes[0]?.sku || "",
    link: p.metafield?.value || "",
    hasImage: Boolean(p.featuredMedia?.preview?.image?.url),
  }));
  const recent = rows.filter((r) => new Date(r.createdAt) >= SINCE);
  const missing = rows.filter((r) => !r.link);
  const bad = rows.filter((r) => r.link && !/^https?:\/\//.test(r.link));
  const by = (list, f) => list.reduce((m, r) => ((m[f(r)] = (m[f(r)] || 0) + 1), m), {});

  console.log(`Products: ${rows.length}  missing link: ${missing.length}  malformed link: ${bad.length}`);
  console.log("Missing by status:", by(missing, (r) => r.status));
  console.log(`Created since ${SINCE.toISOString().slice(0, 10)}: ${recent.length}, missing link: ${recent.filter((r) => !r.link).length}`);
  console.log("Recent missing by status:", by(recent.filter((r) => !r.link), (r) => r.status));
  console.log("Missing by created month:", by(missing, (r) => r.createdAt.slice(0, 7)));
  console.log("Link hosts:", by(rows.filter((r) => r.link), (r) => r.link.replace(/^https?:\/\/([^/]+).*/, "$1")));
  console.log("Sample missing:", missing.slice(0, 10).map((r) => `${r.sku || r.handle} (${r.status}, ${r.createdAt.slice(0, 10)})`).join(", "));

  fs.writeFileSync(REPORT, JSON.stringify({ generatedAt: new Date().toISOString(), since: SINCE, total: rows.length, missing, bad, recentCount: recent.length }, null, 1));
  console.log(`Report: ${REPORT}`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
