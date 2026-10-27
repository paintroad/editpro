#!/usr/bin/env node
/**
 * Reorder PDP option values so the storefront default is XS + Fine Art Paper:
 *   Material: Fine Art Paper → Canvas
 *   Size:     XS → S → M → L → XL
 *   Frame:    Black → White → Wooden → Dark Brown → Stretched Canvas
 *
 * Usage:
 *   node scripts/reorder-size-s-first.js
 *   node scripts/reorder-size-s-first.js --product=coastal-vista
 *   node scripts/reorder-size-s-first.js --apply
 *   node scripts/reorder-size-s-first.js --product=coastal-vista --apply
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { getShopifyCredentials } = require("../lib/config-store");
const { shopifyGraphql } = require("../lib/shopify-client");

const REPORT_PATH = path.join(os.homedir(), ".editpro", "reorder-size-s-first-report.json");

const SIZE_RANK = { XS: 0, S: 1, M: 2, L: 3, XL: 4 };
const FRAME_RANK = {
  Black: 0,
  White: 1,
  Wooden: 2,
  "Dark Brown": 3,
  "Stretched Canvas": 4,
};

function materialRank(name) {
  const n = String(name || "").toLowerCase();
  if (n.includes("paper")) return 0;
  if (n.includes("canvas")) return 1;
  return 50;
}

const REORDER_MUTATION = `mutation ($productId: ID!, $options: [OptionReorderInput!]!) {
  productOptionsReorder(productId: $productId, options: $options) {
    product {
      id
      handle
      options { name optionValues { name } }
      variants(first: 1) { nodes { title position } }
    }
    userErrors { field message code }
  }
}`;

function parseArgs(argv = process.argv.slice(2)) {
  let apply = false;
  let product = null;
  for (const arg of argv) {
    if (arg === "--apply") apply = true;
    else if (arg.startsWith("--product=")) {
      product = arg.slice("--product=".length).replace(/^["']|["']$/g, "");
    }
  }
  return { apply, product };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function sizeRank(name) {
  const m = String(name || "").match(/^(XS|S|M|L|XL)\b/i);
  return SIZE_RANK[(m?.[1] || "").toUpperCase()] ?? 99;
}

function frameRank(name) {
  return FRAME_RANK[String(name || "")] ?? 50;
}

function sortedNames(values, rankFn) {
  return [...(values || [])]
    .sort((a, b) => rankFn(a.name) - rankFn(b.name) || String(a.name).localeCompare(String(b.name)))
    .map((v) => v.name);
}

function needsReorder(option, rankFn) {
  const current = (option?.optionValues || []).map((v) => v.name);
  const desired = sortedNames(option?.optionValues || [], rankFn);
  if (current.length !== desired.length) return true;
  return current.some((name, i) => name !== desired[i]);
}

function productFragment() {
  return `
    id
    title
    handle
    status
    options {
      id
      name
      optionValues { id name }
    }
  `;
}

async function fetchByHandle(storeDomain, accessToken, handle) {
  const data = await shopifyGraphql(
    storeDomain,
    accessToken,
    `query ($q: String!) {
      products(first: 1, query: $q) { nodes { ${productFragment()} } }
    }`,
    { q: `handle:${handle}` }
  );
  return data.products?.nodes?.[0] || null;
}

async function fetchById(storeDomain, accessToken, id) {
  const data = await shopifyGraphql(
    storeDomain,
    accessToken,
    `query ($id: ID!) { product(id: $id) { ${productFragment()} } }`,
    { id }
  );
  return data.product || null;
}

async function* iterateActive(storeDomain, accessToken) {
  let cursor = null;
  let hasNext = true;
  while (hasNext) {
    const data = await shopifyGraphql(
      storeDomain,
      accessToken,
      `query ($cursor: String) {
        products(first: 50, after: $cursor, query: "status:active") {
          pageInfo { hasNextPage endCursor }
          nodes { ${productFragment()} }
        }
      }`,
      { cursor }
    );
    const page = data.products;
    for (const node of page?.nodes || []) yield node;
    hasNext = Boolean(page?.pageInfo?.hasNextPage);
    cursor = page?.pageInfo?.endCursor || null;
  }
}

function planProduct(product) {
  const optionsList = product.options || [];
  const sizeOpt = optionsList.find((o) => o.name === "Size");
  const frameOpt = optionsList.find((o) => o.name === "Frame");
  const materialOpt = optionsList.find((o) => o.name === "Material");
  if (!sizeOpt || !(sizeOpt.optionValues || []).length) {
    return { skip: true, reason: "no_size_option" };
  }
  const sizeNeeded = needsReorder(sizeOpt, sizeRank);
  const frameNeeded = frameOpt ? needsReorder(frameOpt, frameRank) : false;
  const materialNeeded = materialOpt ? needsReorder(materialOpt, materialRank) : false;
  if (!sizeNeeded && !frameNeeded && !materialNeeded) {
    return { skip: true, reason: "already_ordered" };
  }

  // productOptionsReorder requires every option name present on the product.
  const options = optionsList.map((opt) => {
    if (opt.name === "Size") {
      return {
        name: "Size",
        values: sortedNames(opt.optionValues, sizeRank).map((name) => ({ name })),
      };
    }
    if (opt.name === "Frame") {
      return {
        name: "Frame",
        values: sortedNames(opt.optionValues, frameRank).map((name) => ({ name })),
      };
    }
    if (opt.name === "Material") {
      return {
        name: "Material",
        values: sortedNames(opt.optionValues, materialRank).map((name) => ({ name })),
      };
    }
    return {
      name: opt.name,
      values: (opt.optionValues || []).map((v) => ({ name: v.name })),
    };
  });

  return {
    skip: false,
    sizeNeeded,
    frameNeeded,
    materialNeeded,
    fromSize: (sizeOpt.optionValues || []).map((v) => v.name),
    toSize: sortedNames(sizeOpt.optionValues, sizeRank),
    fromFrame: frameOpt ? (frameOpt.optionValues || []).map((v) => v.name) : [],
    toFrame: frameOpt ? sortedNames(frameOpt.optionValues, frameRank) : [],
    fromMaterial: materialOpt ? (materialOpt.optionValues || []).map((v) => v.name) : [],
    toMaterial: materialOpt ? sortedNames(materialOpt.optionValues, materialRank) : [],
    options,
  };
}

async function applyReorder(storeDomain, accessToken, productId, options) {
  const data = await shopifyGraphql(storeDomain, accessToken, REORDER_MUTATION, {
    productId,
    options,
  });
  const result = data.productOptionsReorder;
  if (result?.userErrors?.length) {
    throw new Error(result.userErrors.map((e) => e.message).join("; "));
  }
  return result?.product;
}

async function main() {
  const { apply, product: productArg } = parseArgs();
  const { storeDomain, accessToken } = getShopifyCredentials();
  if (!storeDomain || !accessToken) {
    throw new Error("Shopify credentials missing");
  }

  const products = [];
  if (productArg) {
    const one =
      productArg.startsWith("gid://") || /^\d+$/.test(productArg)
        ? await fetchById(
            storeDomain,
            accessToken,
            productArg.startsWith("gid://")
              ? productArg
              : `gid://shopify/Product/${productArg}`
          )
        : await fetchByHandle(storeDomain, accessToken, productArg);
    if (!one) throw new Error(`Product not found: ${productArg}`);
    products.push(one);
  } else {
    console.log("Scanning active products…");
    for await (const p of iterateActive(storeDomain, accessToken)) {
      products.push(p);
      if (products.length % 100 === 0) {
        process.stdout.write(`\rLoaded ${products.length}   `);
      }
    }
    process.stdout.write(`\rLoaded ${products.length}   \n`);
  }

  const planned = [];
  const skipped = [];
  for (const product of products) {
    const plan = planProduct(product);
    if (plan.skip) {
      skipped.push({ handle: product.handle, reason: plan.reason });
      continue;
    }
    planned.push({
      id: product.id,
      handle: product.handle,
      title: product.title,
      sizeNeeded: plan.sizeNeeded,
      frameNeeded: plan.frameNeeded,
      materialNeeded: plan.materialNeeded,
      fromSize: plan.fromSize,
      toSize: plan.toSize,
      fromFrame: plan.fromFrame,
      toFrame: plan.toFrame,
      fromMaterial: plan.fromMaterial,
      toMaterial: plan.toMaterial,
      options: plan.options,
    });
  }

  console.log(
    `Need reorder: ${planned.length} | Already OK / skipped: ${skipped.length} | Mode: ${
      apply ? "APPLY" : "DRY-RUN"
    }`
  );

  const updated = [];
  const errors = [];
  if (apply) {
    for (let i = 0; i < planned.length; i += 1) {
      const row = planned[i];
      try {
        const product = await applyReorder(storeDomain, accessToken, row.id, row.options);
        updated.push({
          handle: row.handle,
          firstVariant: product?.variants?.nodes?.[0]?.title || null,
          sizes: (product?.options || []).find((o) => o.name === "Size")?.optionValues?.map(
            (v) => v.name
          ),
        });
      } catch (err) {
        errors.push({ handle: row.handle, error: err?.message || String(err) });
        console.error(`\nError ${row.handle}: ${err?.message || err}`);
      }
      if ((i + 1) % 25 === 0 || i + 1 === planned.length) {
        process.stdout.write(
          `\rReorder ${i + 1}/${planned.length} | ok ${updated.length} | err ${errors.length}   `
        );
      }
      await sleep(40);
    }
    process.stdout.write("\n");
  }

  const report = {
    generatedAt: new Date().toISOString(),
    apply,
    productFilter: productArg || null,
    counts: {
      products: products.length,
      planned: planned.length,
      skipped: skipped.length,
      updated: updated.length,
      errors: errors.length,
    },
    plannedSample: planned.slice(0, 30).map((p) => ({
      handle: p.handle,
      fromSize: p.fromSize,
      toSize: p.toSize,
      fromFrame: p.fromFrame,
      toFrame: p.toFrame,
      fromMaterial: p.fromMaterial,
      toMaterial: p.toMaterial,
    })),
    updatedSample: updated.slice(0, 40),
    errors,
  };
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), "utf8");
  console.log(`Report: ${REPORT_PATH}`);
  if (errors.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
