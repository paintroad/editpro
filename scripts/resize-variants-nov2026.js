#!/usr/bin/env node
/**
 * November 2026 size change on live products.
 *   rename   3:4 / 4:3 products: Size value `L - 24"x36"` becomes `L - 24"x32"` (same variants, prices, SKUs).
 *   rebuild  16:9 / 9:16 products: all variants replaced by the wide ladder (S 9x16, M 14x24, L 18x32,
 *            XL 27x48; Canvas, 5 frames). New variants are created before the old ones are deleted.
 * Which products are 16:9 / 9:16 comes from set-assignments.json (shape wide / tall).
 *
 *   node scripts/resize-variants-nov2026.js --mode=rebuild --numbers=10744 [--apply]
 *   node scripts/resize-variants-nov2026.js --mode=rename --limit=3 [--apply]
 *   node scripts/resize-variants-nov2026.js --mode=all --apply [--workers=2]
 *
 * Without --apply nothing is written. Every product's variants are saved to
 * ~/.editpro/backups/resize-variants-nov2026/<number>.json before a change; results go to
 * ~/.editpro/resize-variants-nov2026.json and finished products are skipped on later runs.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { getShopifyCredentials } = require("../lib/config-store");
const { shopifyGraphql } = require("../lib/shopify-client");
const {
  PRODUCT_DEFAULTS, VARIANT_ROWS_CANVAS, WIDE_SIZES, WIDE_SIZE_CODES, MATERIAL_CANVAS,
  pricingForVariant, weightForVariant, frameDisplayLabel, normalizeFrame,
} = require("../lib/catalog-variant-templates");
const { METAOBJECT_TYPES, createMetaobjectResolver } = require("../lib/shopify-metaobject-resolver");
const { sizeKeyFromOptionValue, packageGidForSizeKey, loadShippingPackageMap } = require("../lib/package-dimensions");

const HOME = path.join(os.homedir(), ".editpro");
const LOG = path.join(HOME, "resize-variants-nov2026.json");
const BACKUPS = path.join(HOME, "backups", "resize-variants-nov2026");
const OLD_L = /24\s*"?\s*[x×]\s*"?\s*36/i;
const NEW_L = 'L - 24"x32"';
const readJson = (f, d) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : d);

const PRODUCT = `query($id: ID!) {
  product(id: $id) {
    id handle title
    options { id name optionValues { id name } }
    variants(first: 100) { nodes { id sku title price compareAtPrice selectedOptions { name value } } }
  }
}`;
const LIST = `query($cursor: String) {
  products(first: 100, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes { id handle options { name optionValues { name } } variants(first: 1) { nodes { sku } } }
  }
}`;
const OPTION_UPDATE = `mutation($productId: ID!, $option: OptionUpdateInput!, $optionValuesToAdd: [OptionValueCreateInput!], $optionValuesToUpdate: [OptionValueUpdateInput!], $optionValuesToDelete: [ID!]) {
  productOptionUpdate(productId: $productId, option: $option, optionValuesToAdd: $optionValuesToAdd, optionValuesToUpdate: $optionValuesToUpdate, optionValuesToDelete: $optionValuesToDelete) {
    userErrors { field message code }
  }
}`;
const BULK_CREATE = `mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
  productVariantsBulkCreate(productId: $productId, variants: $variants) {
    productVariants { id sku }
    userErrors { field message code }
  }
}`;
const BULK_DELETE = `mutation($productId: ID!, $variantsIds: [ID!]!) {
  productVariantsBulkDelete(productId: $productId, variantsIds: $variantsIds) {
    userErrors { field message code }
  }
}`;
const LOCATIONS = `query { locations(first: 25, includeInactive: true) { nodes { id name } } }`;

function check(result, what) {
  const errors = result?.userErrors || [];
  if (errors.length) throw new Error(`${what}: ${errors.map((e) => e.message).join("; ")}`);
  return result;
}

const optionNamed = (product, name) => product.options.find((o) => o.name.toLowerCase() === name);
const numberOf = (sku) => (String(sku || "").match(/^(\d+)/) || [])[1] || null;

async function rename(ctx, id, number, apply) {
  const { product } = await ctx.gql(PRODUCT, { id });
  const size = optionNamed(product, "size");
  const old = size?.optionValues.find((v) => OLD_L.test(v.name));
  if (!old) return { skipped: "no 24x36 size" };
  if (!apply) return { plan: `${old.name} -> ${NEW_L}` };
  backup(number, product);
  check((await ctx.gql(OPTION_UPDATE, { productId: id, option: { id: size.id }, optionValuesToUpdate: [{ id: old.id, name: NEW_L }] })).productOptionUpdate, "rename");
  return { renamed: old.name };
}

async function rebuild(ctx, id, number, apply) {
  let { product } = await ctx.gql(PRODUCT, { id });
  const size = optionNamed(product, "size");
  const frame = optionNamed(product, "frame");
  if (!size || !frame) throw new Error("product has no Size or Frame option");
  const labels = WIDE_SIZE_CODES.map((c) => WIDE_SIZES[c]);
  const old = product.variants.nodes;
  const done = old.length === labels.length * VARIANT_ROWS_CANVAS.length &&
    old.every((v) => labels.includes(v.selectedOptions.find((o) => o.name === "Size")?.value));
  if (done) return { skipped: "already on the wide sizes" };

  const sku = numberOf(old[0]?.sku) || number;
  const rows = [];
  for (const code of WIDE_SIZE_CODES) {
    for (const row of VARIANT_ROWS_CANVAS) {
      const pricing = pricingForVariant("wide", code, MATERIAL_CANVAS, row.frame);
      const key = sizeKeyFromOptionValue(WIDE_SIZES[code]);
      rows.push({
        code, row, label: WIDE_SIZES[code], frameLabel: frameDisplayLabel(row.frame),
        sku: `${sku}-${code}-${row.n}`, price: String(pricing.price), compareAtPrice: String(pricing.compareAt),
        weight: weightForVariant("wide", code), packageGid: packageGidForSizeKey(key, ctx.packages),
      });
    }
  }
  if (!apply) return { plan: `-${old.length} +${rows.length}`, sample: rows.slice(0, 2).map((r) => `${r.sku} ${r.label} ${r.frameLabel} ${r.price}`) };
  backup(number, product);

  const missingSizes = labels.filter((l) => !size.optionValues.some((v) => v.name === l));
  if (missingSizes.length) {
    check((await ctx.gql(OPTION_UPDATE, { productId: id, option: { id: size.id }, optionValuesToAdd: missingSizes.map((name) => ({ name })) })).productOptionUpdate, "add sizes");
  }
  const missingFrames = VARIANT_ROWS_CANVAS.map((r) => frameDisplayLabel(r.frame)).filter((l) => !frame.optionValues.some((v) => v.name === l));
  if (missingFrames.length) {
    const add = [];
    for (const label of missingFrames) add.push({ linkedMetafieldValue: await ctx.resolver.resolveId(METAOBJECT_TYPES.frameStyle, label) });
    check((await ctx.gql(OPTION_UPDATE, { productId: id, option: { id: frame.id }, optionValuesToAdd: add })).productOptionUpdate, "add frames");
  }
  product = (await ctx.gql(PRODUCT, { id })).product;
  const valueId = (option, name) => {
    const v = optionNamed(product, option)?.optionValues.find((x) => x.name === name);
    if (!v) throw new Error(`no ${option} value "${name}"`);
    return v.id;
  };
  const material = optionNamed(product, "material");

  const variants = rows.map((r) => ({
    price: r.price,
    compareAtPrice: r.compareAtPrice,
    inventoryPolicy: "CONTINUE",
    taxable: true,
    optionValues: [
      ...(material ? [{ optionName: material.name, id: valueId("material", MATERIAL_CANVAS) }] : []),
      { optionName: size.name, id: valueId("size", r.label) },
      { optionName: frame.name, id: valueId("frame", r.frameLabel) },
    ],
    inventoryItem: {
      sku: r.sku, tracked: true, requiresShipping: true, countryCodeOfOrigin: PRODUCT_DEFAULTS.countryOfOrigin,
      measurement: { weight: { value: r.weight, unit: "GRAMS" }, ...(r.packageGid ? { shippingPackageId: r.packageGid } : {}) },
    },
    inventoryQuantities: [{
      availableQuantity: PRODUCT_DEFAULTS.inventoryQty,
      locationId: normalizeFrame(r.row.frame) === "stretched-canvas" ? ctx.locations.mayapuri : ctx.locations.naraina,
    }],
  }));
  const created = check((await ctx.gql(BULK_CREATE, { productId: id, variants })).productVariantsBulkCreate, "create").productVariants;
  if (created.length !== rows.length) throw new Error(`created ${created.length} of ${rows.length} variants`);
  check((await ctx.gql(BULK_DELETE, { productId: id, variantsIds: old.map((v) => v.id) })).productVariantsBulkDelete, "delete old");

  // Option values no longer used by any variant (old sizes, Fine Art Paper).
  product = (await ctx.gql(PRODUCT, { id })).product;
  for (const option of product.options) {
    const used = new Set(product.variants.nodes.map((v) => v.selectedOptions.find((o) => o.name === option.name)?.value));
    const unused = option.optionValues.filter((v) => !used.has(v.name)).map((v) => v.id);
    if (unused.length) check((await ctx.gql(OPTION_UPDATE, { productId: id, option: { id: option.id }, optionValuesToDelete: unused })).productOptionUpdate, `prune ${option.name}`);
  }
  return { deleted: old.length, created: created.length };
}

function backup(number, product) {
  fs.mkdirSync(BACKUPS, { recursive: true });
  const file = path.join(BACKUPS, `${number}.json`);
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({ savedAt: new Date().toISOString(), product }, null, 1));
}

async function pool(items, n, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}

(async () => {
  const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
  const apply = process.argv.includes("--apply");
  const mode = arg("mode") || "all";
  const c = getShopifyCredentials();
  const gql = (query, variables) => shopifyGraphql(c.storeDomain, c.accessToken, query, variables);
  const locs = (await gql(LOCATIONS)).locations.nodes;
  const find = (re) => locs.find((l) => re.test(l.name))?.id;
  const ctx = {
    gql,
    resolver: createMetaobjectResolver(shopifyGraphql, c.storeDomain, c.accessToken),
    packages: loadShippingPackageMap(),
    locations: { naraina: find(/naraina|nariana/i), mayapuri: find(/mayapuri/i) },
  };
  if (!ctx.locations.naraina || !ctx.locations.mayapuri) throw new Error("Naraina or Mayapuri location not found");

  const assignments = readJson(path.join(HOME, "lifestyle-sets", "set-assignments.json"), { paintings: {} }).paintings;
  const wideNumbers = new Set(Object.entries(assignments).filter(([, p]) => p.shape === "wide" || p.shape === "tall").map(([n]) => n));

  // Every live product with a Size option, by catalog number (from the SKU).
  const products = [];
  for (let cursor = null; ;) {
    const page = (await gql(LIST, { cursor })).products;
    for (const p of page.nodes) {
      const size = p.options.find((o) => o.name.toLowerCase() === "size");
      const number = numberOf(p.variants.nodes[0]?.sku);
      if (size && number) products.push({ id: p.id, number, has24x36: size.optionValues.some((v) => OLD_L.test(v.name)) });
    }
    if (!page.pageInfo.hasNextPage) break;
    cursor = page.pageInfo.endCursor;
  }
  const log = readJson(LOG, {});
  let jobs = products.map((p) => ({ ...p, kind: wideNumbers.has(p.number) ? "rebuild" : p.has24x36 ? "rename" : null }))
    .filter((j) => j.kind && (mode === "all" || mode === j.kind) && log[j.number]?.status !== "done");
  if (arg("numbers")) {
    const want = new Set(arg("numbers").split(","));
    jobs = jobs.filter((j) => want.has(j.number));
  }
  const count = (k) => jobs.filter((j) => j.kind === k).length;
  console.log(`${apply ? "APPLY" : "DRY RUN"}: ${products.length} products scanned; ${count("rename")} to rename, ${count("rebuild")} to rebuild`);
  if (process.argv.includes("--count")) {
    for (const j of jobs.filter((x) => !/^\d{5}$/.test(x.number) || x.number === "00000")) console.log("  unusual:", j.number, j.id);
    return;
  }
  if (arg("limit")) jobs = jobs.slice(0, Number(arg("limit")));

  let ok = 0, failed = 0;
  const started = Date.now();
  await pool(jobs, Math.max(1, Number(arg("workers")) || 2), async (job) => {
    try {
      const r = await (job.kind === "rename" ? rename : rebuild)(ctx, job.id, job.number, apply);
      if (apply) log[job.number] = { status: "done", kind: job.kind, at: new Date().toISOString(), productId: job.id, ...r };
      else if (ok < 5) console.log(job.number, job.kind, JSON.stringify(r));
      ok++;
    } catch (e) {
      failed++;
      if (apply) log[job.number] = { status: "failed", kind: job.kind, at: new Date().toISOString(), productId: job.id, error: e.message };
      console.error(`${job.number} ${job.kind} FAILED: ${e.message}`);
    }
    if (apply) fs.writeFileSync(LOG, JSON.stringify(log, null, 1));
    if ((ok + failed) % 100 === 0) {
      const rate = (ok + failed) / ((Date.now() - started) / 1000);
      console.log(`${ok + failed}/${jobs.length} (${Math.round((jobs.length - ok - failed) / rate / 60)} min left)`);
    }
  });
  console.log(`done: ${ok} ok, ${failed} failed${apply ? "" : " (dry run, nothing written)"}`);
})();
