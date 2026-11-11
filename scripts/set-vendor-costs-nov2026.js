#!/usr/bin/env node
/**
 * Unit costs (vendor rate, pre-GST) for the November 2026 sizes on live variants:
 * L 24x32 and the 16:9 ladder. Stretched Canvas is Mayapuri, the other frames Naraina.
 * Rates match the OrderPro rate cards from 11 Nov 2026.
 *
 *   node scripts/set-vendor-costs-nov2026.js [--numbers=10744] [--limit=5]   show what would change
 *   node scripts/set-vendor-costs-nov2026.js --apply [--workers=2]
 */
const { getShopifyCredentials } = require("../lib/config-store");
const { shopifyGraphql } = require("../lib/shopify-client");

const COSTS = {
  "24x32": { naraina: 1452, mayapuri: 1387 },
  "9x16": { naraina: 350, mayapuri: 260 },
  "14x24": { naraina: 750, mayapuri: 607 },
  "18x32": { naraina: 1150, mayapuri: 1040 },
  "27x48": { naraina: 2600, mayapuri: 2340 },
};

const LIST = `query($cursor: String) {
  products(first: 100, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes { id options { name optionValues { name } } variants(first: 1) { nodes { sku } } }
  }
}`;
const PRODUCT = `query($id: ID!) {
  product(id: $id) {
    variants(first: 100) { nodes { id selectedOptions { name value } inventoryItem { unitCost { amount } } } }
  }
}`;
const BULK_UPDATE = `mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
  productVariantsBulkUpdate(productId: $productId, variants: $variants) {
    userErrors { field message }
  }
}`;

const numberOf = (sku) => (String(sku || "").match(/^(\d+)/) || [])[1] || null;
const sizeKey = (value) => {
  const m = String(value || "").replace(/["″]/g, "").match(/(\d+)\s*[x×]\s*(\d+)/i);
  if (!m) return null;
  const direct = `${m[1]}x${m[2]}`;
  if (COSTS[direct]) return direct;
  const flipped = `${m[2]}x${m[1]}`;
  return COSTS[flipped] ? flipped : null;
};

async function pool(items, n, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}

(async () => {
  const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
  const apply = process.argv.includes("--apply");
  const c = getShopifyCredentials();
  const gql = (query, variables) => shopifyGraphql(c.storeDomain, c.accessToken, query, variables);

  let products = [];
  for (let cursor = null; ;) {
    const page = (await gql(LIST, { cursor })).products;
    for (const p of page.nodes) {
      const size = p.options.find((o) => o.name.toLowerCase() === "size");
      if (size && size.optionValues.some((v) => sizeKey(v.name))) products.push({ id: p.id, number: numberOf(p.variants.nodes[0]?.sku) });
    }
    if (!page.pageInfo.hasNextPage) break;
    cursor = page.pageInfo.endCursor;
  }
  if (arg("numbers")) {
    const want = new Set(arg("numbers").split(","));
    products = products.filter((p) => want.has(p.number));
  }
  if (arg("limit")) products = products.slice(0, Number(arg("limit")));
  console.log(`${apply ? "APPLY" : "DRY RUN"}: ${products.length} products with the new sizes`);

  let ok = 0, failed = 0, variantsChanged = 0, shown = 0;
  const skipped = {};
  const started = Date.now();
  await pool(products, Math.max(1, Number(arg("workers")) || 2), async (p) => {
    try {
      const variants = (await gql(PRODUCT, { id: p.id })).product.variants.nodes;
      const changes = [];
      for (const v of variants) {
        const opt = (name) => v.selectedOptions.find((o) => o.name.toLowerCase() === name)?.value || "";
        const key = sizeKey(opt("size"));
        if (!key) continue;
        if (/paper/i.test(opt("material"))) { skipped.paper = (skipped.paper || 0) + 1; continue; }
        const cost = /stretch/i.test(opt("frame")) ? COSTS[key].mayapuri : COSTS[key].naraina;
        const now = v.inventoryItem?.unitCost ? Number(v.inventoryItem.unitCost.amount) : null;
        if (now === cost) continue;
        changes.push({ id: v.id, inventoryItem: { cost }, from: now, label: `${opt("size")} ${opt("frame")}` });
      }
      if (!apply && changes.length && shown < 3) {
        shown++;
        console.log(p.number, changes.map((x) => `${x.label}: ${x.from} -> ${x.inventoryItem.cost}`).join("; "));
      }
      if (apply && changes.length) {
        const r = (await gql(BULK_UPDATE, { productId: p.id, variants: changes.map(({ id, inventoryItem }) => ({ id, inventoryItem })) })).productVariantsBulkUpdate;
        if (r.userErrors.length) throw new Error(r.userErrors.map((e) => e.message).join("; "));
      }
      variantsChanged += changes.length;
      ok++;
    } catch (e) {
      failed++;
      console.error(`${p.number} FAILED: ${e.message}`);
    }
    if ((ok + failed) % 250 === 0) {
      const rate = (ok + failed) / ((Date.now() - started) / 1000);
      console.log(`${ok + failed}/${products.length} (${Math.round((products.length - ok - failed) / rate / 60)} min left)`);
    }
  });
  console.log(`done: ${ok} products ok, ${failed} failed, ${variantsChanged} variants ${apply ? "updated" : "to update"}${skipped.paper ? `, ${skipped.paper} paper variants skipped` : ""}`);
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
