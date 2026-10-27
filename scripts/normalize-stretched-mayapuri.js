#!/usr/bin/env node
/**
 * Normalize Stretched Canvas inventory after warehouse move:
 *   Mayapuri available = max(0, Naraina + Mayapuri)
 *   Naraina available = 0
 * Also moves any remaining positive Naraina stock.
 *
 * Usage:
 *   node scripts/normalize-stretched-mayapuri.js
 *   node scripts/normalize-stretched-mayapuri.js --apply
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { getShopifyCredentials } = require("../lib/config-store");
const { shopifyGraphql } = require("../lib/shopify-client");

const CONFIG_DIR = path.join(os.homedir(), ".editpro");
const PROGRESS_PATH = path.join(
  CONFIG_DIR,
  "normalize-stretched-mayapuri-progress.json"
);
const VARIANT_QUERY = 'option3:"Stretched Canvas"';
const FROM_NAMES = ["naraina", "nariana"];
const TO_NAMES = ["mayapuri"];
const BATCH = 25;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function gql(storeDomain, accessToken, query, variables = {}, attempt = 0) {
  try {
    return await shopifyGraphql(storeDomain, accessToken, query, variables);
  } catch (err) {
    if (/throttl/i.test(String(err.message || err)) && attempt < 12) {
      const wait = Math.min(60000, 2000 * 2 ** Math.min(attempt, 5));
      console.warn(`Throttled — retry in ${wait}ms`);
      await sleep(wait);
      return gql(storeDomain, accessToken, query, variables, attempt + 1);
    }
    throw err;
  }
}

function loadProgress() {
  if (!fs.existsSync(PROGRESS_PATH)) return { done: [] };
  try {
    return JSON.parse(fs.readFileSync(PROGRESS_PATH, "utf8"));
  } catch {
    return { done: [] };
  }
}

function saveProgress(p) {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(PROGRESS_PATH, JSON.stringify(p, null, 2));
}

async function resolveLocations(storeDomain, accessToken) {
  const data = await gql(
    storeDomain,
    accessToken,
    `query { locations(first: 25, includeInactive: true) { nodes { id name } } }`
  );
  const nodes = data.locations?.nodes || [];
  const findBy = (needles) =>
    nodes.find((n) =>
      needles.some((x) => String(n.name || "").toLowerCase().includes(x))
    );
  const from = findBy(FROM_NAMES);
  const to = findBy(TO_NAMES);
  if (!from || !to) throw new Error("Locations not found");
  return { from, to };
}

function qtyAt(levels, locationId) {
  const level = (levels || []).find((l) => l.location?.id === locationId);
  if (!level) return { exists: false, available: 0 };
  const q = (level.quantities || []).find((x) => x.name === "available");
  return { exists: true, available: Number(q?.quantity) || 0 };
}

async function activate(storeDomain, accessToken, inventoryItemId, locationId) {
  const data = await gql(
    storeDomain,
    accessToken,
    `mutation($inventoryItemId: ID!, $locationId: ID!) {
      inventoryActivate(inventoryItemId: $inventoryItemId, locationId: $locationId) {
        userErrors { message }
      }
    }`,
    { inventoryItemId, locationId }
  );
  const errors = data.inventoryActivate?.userErrors || [];
  if (errors.length && !/already|activated|exists/i.test(errors.map((e) => e.message).join("; "))) {
    throw new Error(errors.map((e) => e.message).join("; "));
  }
}

async function setQty(storeDomain, accessToken, quantities, tag) {
  const data = await gql(
    storeDomain,
    accessToken,
    `mutation($input: InventorySetQuantitiesInput!) {
      inventorySetQuantities(input: $input) {
        userErrors { message code }
      }
    }`,
    {
      input: {
        name: "available",
        reason: "correction",
        referenceDocumentUri: `gid://editpro/StretchedNormalize/${tag}`,
        quantities,
      },
    }
  );
  const errors = data.inventorySetQuantities?.userErrors || [];
  if (errors.length) throw new Error(errors.map((e) => e.message).join("; "));
}

async function main() {
  const apply = process.argv.includes("--apply");
  const reset = process.argv.includes("--reset");
  const { storeDomain, accessToken } = getShopifyCredentials();
  const { from, to } = await resolveLocations(storeDomain, accessToken);
  let progress = reset ? { done: [] } : loadProgress();
  const done = new Set(progress.done || []);

  console.log(apply ? "Mode: APPLY" : "Mode: DRY-RUN");
  console.log(`FROM ${from.name} → TO ${to.name}`);
  console.log(`Already done: ${done.size}`);

  let cursor = null;
  let scanned = 0;
  let needsFix = 0;
  let fixed = 0;
  let errors = 0;
  let pending = [];
  const samples = [];

  async function flush() {
    if (!pending.length) return;
    if (!apply) {
      needsFix += pending.length;
      pending = [];
      return;
    }
    // Ensure Mayapuri activated
    for (const job of pending) {
      if (job.needActivate) {
        try {
          await activate(storeDomain, accessToken, job.inventoryItemId, to.id);
        } catch (e) {
          console.error(`activate ${job.sku}: ${e.message}`);
        }
        await sleep(50);
      }
    }
    try {
      await setQty(
        storeDomain,
        accessToken,
        pending.flatMap((j) => [
          {
            inventoryItemId: j.inventoryItemId,
            locationId: to.id,
            quantity: j.targetMayapuri,
            changeFromQuantity: j.needActivate ? null : j.toAvail,
          },
          {
            inventoryItemId: j.inventoryItemId,
            locationId: from.id,
            quantity: 0,
            changeFromQuantity: j.fromAvail,
          },
        ]),
        `${Date.now()}`
      );
      for (const j of pending) {
        done.add(j.inventoryItemId);
        fixed += 1;
      }
    } catch (err) {
      console.warn(`Batch failed: ${err.message}; per-item…`);
      for (const j of pending) {
        try {
          if (j.needActivate) {
            await activate(storeDomain, accessToken, j.inventoryItemId, to.id);
          }
          await setQty(
            storeDomain,
            accessToken,
            [
              {
                inventoryItemId: j.inventoryItemId,
                locationId: to.id,
                quantity: j.targetMayapuri,
                changeFromQuantity: j.needActivate ? null : j.toAvail,
              },
              {
                inventoryItemId: j.inventoryItemId,
                locationId: from.id,
                quantity: 0,
                changeFromQuantity: j.fromAvail,
              },
            ],
            j.sku || Date.now()
          );
          done.add(j.inventoryItemId);
          fixed += 1;
        } catch (e) {
          errors += 1;
          console.error(`${j.handle} ${j.sku}: ${e.message}`);
        }
        await sleep(70);
      }
    }
    progress.done = [...done];
    saveProgress(progress);
    console.log(`… fixed ${fixed} (errors ${errors})`);
    pending = [];
    await sleep(120);
  }

  do {
    const data = await gql(
      storeDomain,
      accessToken,
      `query($cursor: String, $query: String!) {
        productVariants(first: 50, after: $cursor, query: $query) {
          pageInfo { hasNextPage endCursor }
          nodes {
            sku
            product { handle }
            selectedOptions { name value }
            inventoryItem {
              id
              inventoryLevels(first: 5) {
                nodes {
                  location { id name }
                  quantities(names: ["available"]) { name quantity }
                }
              }
            }
          }
        }
      }`,
      { cursor, query: VARIANT_QUERY }
    );
    const page = data.productVariants;
    for (const variant of page?.nodes || []) {
      const frame = (variant.selectedOptions || []).find(
        (o) => String(o.name).toLowerCase() === "frame"
      );
      if (String(frame?.value) !== "Stretched Canvas") continue;
      const inventoryItemId = variant.inventoryItem?.id;
      if (!inventoryItemId || done.has(inventoryItemId)) continue;

      scanned += 1;
      const levels = variant.inventoryItem?.inventoryLevels?.nodes || [];
      const atFrom = qtyAt(levels, from.id);
      const atTo = qtyAt(levels, to.id);
      const targetMayapuri = Math.max(0, atFrom.available + atTo.available);
      const alreadyGood =
        atFrom.available === 0 &&
        atTo.exists &&
        atTo.available === targetMayapuri &&
        targetMayapuri > 0;

      if (alreadyGood) {
        done.add(inventoryItemId);
        continue;
      }

      // Skip empty both sides
      if (targetMayapuri === 0 && atFrom.available === 0 && atTo.available === 0) {
        done.add(inventoryItemId);
        continue;
      }

      const job = {
        inventoryItemId,
        sku: variant.sku,
        handle: variant.product?.handle,
        fromAvail: atFrom.available,
        toAvail: atTo.available,
        targetMayapuri,
        needActivate: !atTo.exists,
      };
      if (samples.length < 8) samples.push(job);
      pending.push(job);
      needsFix += 1;
      if (pending.length >= BATCH) await flush();
    }
    if (!page?.pageInfo?.hasNextPage) break;
    cursor = page.pageInfo.endCursor;
    await sleep(200);
  } while (true);

  await flush();
  progress.done = [...done];
  saveProgress(progress);

  console.log("Sample:", samples);
  console.log("Done:", {
    scanned,
    needsFix,
    fixed: apply ? fixed : 0,
    errors,
    apply,
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
