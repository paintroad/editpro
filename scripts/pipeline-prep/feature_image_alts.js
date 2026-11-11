#!/usr/bin/env node
/**
 * Generic alt text for the shared info graphics (features-*.jpg) shown at the end of every product gallery.
 * Each file is stored once in Shopify Files, so its single alt text appears on every product.
 *
 *   node scripts/pipeline-prep/feature_image_alts.js           list current alt text
 *   node scripts/pipeline-prep/feature_image_alts.js --apply   set the alt text below
 */
const path = require("path");
const { getShopifyCredentials } = require(path.join(__dirname, "../../lib/config-store"));
const { shopifyGraphql } = require(path.join(__dirname, "../../lib/shopify-client"));

const ALTS = {
  "features-material": "Paintroad canvas print material and print quality",
  "features-frame-size": "Paintroad frame thickness and available sizes",
  "features-frame-built": "How a Paintroad frame is built, premium frame quality",
  "features-packaging": "Paintroad 4-layer secured packaging for framed art",
};

const apply = process.argv.includes("--apply");

(async () => {
  const c = getShopifyCredentials();
  const d = await shopifyGraphql(c.storeDomain, c.accessToken,
    `query { files(first: 50, query: "filename:features-*") { nodes { id alt fileStatus ... on MediaImage { image { url } } } } }`);
  const files = d.files.nodes.map((f) => {
    const name = String(f.image?.url || "").split("/").pop().split("?")[0];
    const key = name.replace(/\.[a-z]+$/i, "").replace(/_[0-9a-f-]{36}$/i, "");
    return { ...f, name, key };
  }).filter((f) => ALTS[f.key]);

  for (const f of files) console.log(`${f.name}  ${f.fileStatus}\n  now: ${f.alt}\n  new: ${ALTS[f.key]}`);
  if (!apply) return;

  const r = await shopifyGraphql(c.storeDomain, c.accessToken,
    `mutation ($files: [FileUpdateInput!]!) { fileUpdate(files: $files) { files { id alt } userErrors { field message } } }`,
    { files: files.map((f) => ({ id: f.id, alt: ALTS[f.key] })) });
  if (r.fileUpdate.userErrors.length) throw new Error(JSON.stringify(r.fileUpdate.userErrors));
  console.log(`updated ${r.fileUpdate.files.length} files`);
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
