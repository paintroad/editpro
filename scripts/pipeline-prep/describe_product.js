#!/usr/bin/env node
/**
 * Write a description for live products that have none, using the Enrich step (one OpenAI call per product).
 * Only the description is written; title, handle, tags and variants stay as they are.
 *
 *   node scripts/pipeline-prep/describe_product.js --numbers=11016           generate and show (cached)
 *   node scripts/pipeline-prep/describe_product.js --numbers=11016 --apply   write the cached description
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { getShopifyCredentials } = require("../../lib/config-store");
const { shopifyGraphql } = require("../../lib/shopify-client");
const { enrichProductFromFile } = require("../../lib/catalog-enricher");
const { assertClean } = require("../../lib/brand-guard");

const HOME = path.join(os.homedir(), ".editpro");
const CACHE = path.join(HOME, "pipeline-prep", "describe-product.json");
const arg = (name) => (process.argv.find((a) => a.startsWith(`--${name}=`)) || "").split("=")[1];
const numbers = String(arg("numbers") || "").split(",").map((s) => s.trim()).filter(Boolean);
const apply = process.argv.includes("--apply");

(async () => {
  if (!numbers.length) throw new Error("--numbers is required");
  const assignments = JSON.parse(fs.readFileSync(path.join(HOME, "lifestyle-sets", "set-assignments.json"), "utf8")).paintings;
  const cache = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, "utf8")) : {};
  const c = getShopifyCredentials();

  for (const n of numbers) {
    const d = await shopifyGraphql(c.storeDomain, c.accessToken,
      `query($q:String!){ productVariants(first:1, query:$q){ nodes { product { id title descriptionHtml } } } }`, { q: `sku:${n}-*` });
    const product = d.productVariants.nodes[0]?.product;
    if (!product) { console.log(`${n}: not found`); continue; }
    if (product.descriptionHtml.trim()) { console.log(`${n}: already has a description`); continue; }

    if (!cache[n]) {
      const image = assignments[n]?.image;
      if (!image || !fs.existsSync(image)) throw new Error(`${n}: painting image not found`);
      const result = await enrichProductFromFile(image, n, { useReference: false }, { products: {} });
      cache[n] = { title: product.title, descriptionPlain: result.descriptionPlain, descriptionHtml: result.descriptionHtml, at: new Date().toISOString() };
      fs.mkdirSync(path.dirname(CACHE), { recursive: true });
      fs.writeFileSync(CACHE, JSON.stringify(cache, null, 2));
    }
    console.log(`${n} "${product.title}":\n  ${cache[n].descriptionPlain}`);
    if (!apply) continue;

    assertClean(cache[n].descriptionHtml, `description ${n}`);
    const r = await shopifyGraphql(c.storeDomain, c.accessToken,
      `mutation($p: ProductUpdateInput!){ productUpdate(product: $p){ product { id } userErrors { field message } } }`,
      { p: { id: product.id, descriptionHtml: cache[n].descriptionHtml } });
    if (r.productUpdate.userErrors.length) throw new Error(JSON.stringify(r.productUpdate.userErrors));
    console.log(`  written`);
  }
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
