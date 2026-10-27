#!/usr/bin/env node
/**
 * Move Stretched Canvas inventory from Nariana/Naraina → Mayapuri.
 *
 * Streams pages of variants, then inventorySetQuantities batches
 * (Mayapuri = qty, Nariana = 0). Falls back to activate+adjust per item.
 *
 * Usage:
 *   node scripts/move-stretched-inventory-to-mayapuri.js
 *   node scripts/move-stretched-inventory-to-mayapuri.js --apply
 *   node scripts/move-stretched-inventory-to-mayapuri.js --limit=5 --apply
 *   node scripts/move-stretched-inventory-to-mayapuri.js --apply --reset
 *
 * Progress: ~/.editpro/move-stretched-mayapuri-progress.json
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { getShopifyCredentials } = require("../lib/config-store");
const { shopifyGraphql } = require("../lib/shopify-client");

const CONFIG_DIR = path.join(os.homedir(), ".editpro");
const PROGRESS_PATH = path.join(
  CONFIG_DIR,
  "move-stretched-mayapuri-progress.json"
);
const FRAME_VALUE = "Stretched Canvas";
const VARIANT_QUERY = 'option3:"Stretched Canvas"';
const FROM_NAMES = ["naraina", "nariana"];
const TO_NAMES = ["mayapuri"];
const SET_BATCH = 25;

function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function gql(storeDomain, accessToken, query, variables = {}, attempt = 0) {
  try {
    return await shopifyGraphql(storeDomain, accessToken, query, variables);
  } catch (err) {
    const msg = String(err.message || err);
    if (/throttl/i.test(msg) && attempt < 12) {
      const wait = Math.min(60000, 2000 * 2 ** Math.min(attempt, 5));
      console.warn(`Throttled — retry in ${wait}ms (attempt ${attempt + 1})`);
      await sleep(wait);
      return gql(storeDomain, accessToken, query, variables, attempt + 1);
    }
    throw err;
  }
}

function parseArgs(argv) {
  const apply = argv.includes("--apply");
  const reset = argv.includes("--reset");
  let limit = null;
  for (const arg of argv) {
    if (arg.startsWith("--limit=")) {
      limit = Number(arg.slice("--limit=".length));
    }
  }
  return { apply, reset, limit };
}

function loadProgress() {
  if (!fs.existsSync(PROGRESS_PATH)) {
    return { doneInventoryItemIds: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(PROGRESS_PATH, "utf8"));
  } catch {
    return { doneInventoryItemIds: [] };
  }
}

function saveProgress(progress) {
  ensureConfigDir();
  fs.writeFileSync(PROGRESS_PATH, JSON.stringify(progress, null, 2), "utf8");
}

async function resolveLocations(storeDomain, accessToken) {
  const data = await gql(
    storeDomain,
    accessToken,
    `query {
      locations(first: 25, includeInactive: true) {
        nodes { id name isActive }
      }
    }`
  );
  const nodes = data.locations?.nodes || [];
  const findBy = (needles) =>
    nodes.find((n) => {
      const name = String(n.name || "").toLowerCase();
      return needles.some((needle) => name.includes(needle));
    });
  const from = findBy(FROM_NAMES);
  const to = findBy(TO_NAMES);
  if (!from || !to) {
    throw new Error(
      `Need both source (${FROM_NAMES.join("/")}) and Mayapuri. Found: ${nodes
        .map((n) => n.name)
        .join(", ")}`
    );
  }
  return { from, to, all: nodes };
}

function availableAt(levels, locationId) {
  const level = (levels || []).find((l) => l.location?.id === locationId);
  if (!level) return { exists: false, available: 0 };
  const qty = (level.quantities || []).find((q) => q.name === "available");
  return { exists: true, available: Number(qty?.quantity) || 0 };
}

function isStretchedFrame(variant) {
  const frame = (variant.selectedOptions || []).find(
    (o) => String(o.name || "").toLowerCase() === "frame"
  );
  return String(frame?.value || "") === FRAME_VALUE;
}

async function fetchStretchedPage(storeDomain, accessToken, cursor) {
  return gql(
    storeDomain,
    accessToken,
    `query StretchedVariants($cursor: String, $query: String!) {
      productVariants(first: 50, after: $cursor, query: $query) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          sku
          selectedOptions { name value }
          product { handle }
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
    { cursor: cursor || null, query: VARIANT_QUERY }
  );
}

async function activateAtLocation(
  storeDomain,
  accessToken,
  inventoryItemId,
  locationId
) {
  const data = await gql(
    storeDomain,
    accessToken,
    `mutation Activate($inventoryItemId: ID!, $locationId: ID!) {
      inventoryActivate(inventoryItemId: $inventoryItemId, locationId: $locationId) {
        userErrors { field message }
      }
    }`,
    { inventoryItemId, locationId }
  );
  const errors = data.inventoryActivate?.userErrors || [];
  if (errors.length) {
    const msg = errors.map((e) => e.message).join("; ");
    if (/already|activated|exists/i.test(msg)) return;
    throw new Error(msg);
  }
}

async function setQuantitiesBatch(
  storeDomain,
  accessToken,
  quantities,
  batchTag
) {
  const data = await gql(
    storeDomain,
    accessToken,
    `mutation SetQty($input: InventorySetQuantitiesInput!) {
      inventorySetQuantities(input: $input) {
        userErrors { field message code }
      }
    }`,
    {
      input: {
        name: "available",
        reason: "correction",
        referenceDocumentUri: `gid://editpro/StretchedMoveSet/${batchTag}`,
        quantities,
      },
    }
  );
  const errors = data.inventorySetQuantities?.userErrors || [];
  if (errors.length) {
    throw new Error(errors.map((e) => e.message).join("; "));
  }
}

async function adjustMove(
  storeDomain,
  accessToken,
  inventoryItemId,
  fromId,
  toId,
  qty,
  toAvailable,
  sku
) {
  const data = await gql(
    storeDomain,
    accessToken,
    `mutation Adjust($input: InventoryAdjustQuantitiesInput!) {
      inventoryAdjustQuantities(input: $input) {
        userErrors { field message code }
      }
    }`,
    {
      input: {
        reason: "correction",
        name: "available",
        referenceDocumentUri: `gid://editpro/StretchedMove/${encodeURIComponent(
          sku || inventoryItemId
        )}`,
        changes: [
          {
            delta: -qty,
            inventoryItemId,
            locationId: fromId,
            changeFromQuantity: qty,
          },
          {
            delta: qty,
            inventoryItemId,
            locationId: toId,
            changeFromQuantity:
              toAvailable == null ? null : Number(toAvailable) || 0,
          },
        ],
      },
    }
  );
  const errors = data.inventoryAdjustQuantities?.userErrors || [];
  if (errors.length) {
    throw new Error(errors.map((e) => e.message).join("; "));
  }
}

async function moveChunk(storeDomain, accessToken, chunk, from, to) {
  const quantities = [];
  for (const job of chunk) {
    quantities.push({
      inventoryItemId: job.inventoryItemId,
      locationId: to.id,
      quantity: job.toAvailable + job.qty,
      // CAS: expected current available at destination (null if not stocked yet)
      changeFromQuantity: job.needActivate ? null : job.toAvailable,
    });
    quantities.push({
      inventoryItemId: job.inventoryItemId,
      locationId: from.id,
      quantity: 0,
      changeFromQuantity: job.qty,
    });
  }
  try {
    await setQuantitiesBatch(
      storeDomain,
      accessToken,
      quantities,
      `${Date.now()}`
    );
    return { moved: chunk.length, errors: [] };
  } catch (err) {
    const errors = [];
    let moved = 0;
    for (const job of chunk) {
      try {
        if (job.needActivate) {
          await activateAtLocation(
            storeDomain,
            accessToken,
            job.inventoryItemId,
            to.id
          );
          await sleep(60);
        }
        await adjustMove(
          storeDomain,
          accessToken,
          job.inventoryItemId,
          from.id,
          to.id,
          job.qty,
          job.needActivate ? 0 : job.toAvailable,
          job.sku
        );
        moved += 1;
      } catch (itemErr) {
        errors.push({
          handle: job.handle,
          sku: job.sku,
          message: itemErr.message || String(itemErr),
        });
      }
      await sleep(80);
    }
    return { moved, errors, batchError: err.message };
  }
}

async function main() {
  const { apply, reset, limit } = parseArgs(process.argv.slice(2));
  const { storeDomain, accessToken } = getShopifyCredentials();
  if (!storeDomain || !accessToken) {
    throw new Error("Missing Shopify credentials in ~/.editpro/config.json");
  }

  ensureConfigDir();
  let progress = reset ? { doneInventoryItemIds: [] } : loadProgress();
  if (reset) saveProgress(progress);
  const done = new Set(progress.doneInventoryItemIds || []);

  console.log(apply ? "Mode: APPLY" : "Mode: DRY-RUN (pass --apply to write)");
  if (limit) console.log(`Limit: ${limit}`);
  console.log(`Already done: ${done.size}`);
  console.log("");

  const { from, to, all } = await resolveLocations(storeDomain, accessToken);
  console.log("Locations:");
  for (const loc of all) {
    console.log(`  ${loc.name} (${loc.id}) active=${loc.isActive}`);
  }
  console.log(`FROM: ${from.name} → TO: ${to.name}`);
  console.log("");

  let cursor = null;
  let scanned = 0;
  let toMove = 0;
  let units = 0;
  let moved = 0;
  let skipped = 0;
  let errors = 0;
  const samples = [];
  let pending = [];

  async function flushPending() {
    if (!pending.length) return;
    if (!apply) {
      toMove += pending.length;
      units += pending.reduce((s, j) => s + j.qty, 0);
      pending = [];
      return;
    }
    for (let i = 0; i < pending.length; i += SET_BATCH) {
      const chunk = pending.slice(i, i + SET_BATCH);
      const result = await moveChunk(
        storeDomain,
        accessToken,
        chunk,
        from,
        to
      );
      if (result.batchError) {
        console.warn(`Set batch fallback: ${result.batchError}`);
      }
      for (const job of chunk) {
        const failed = result.errors.some(
          (e) => e.sku === job.sku && e.handle === job.handle
        );
        if (!failed) {
          done.add(job.inventoryItemId);
          moved += 1;
          toMove += 1;
          units += job.qty;
        }
      }
      for (const e of result.errors) {
        errors += 1;
        console.error(`${e.handle} ${e.sku}: ${e.message}`);
      }
      progress.doneInventoryItemIds = [...done];
      saveProgress(progress);
      console.log(`… moved ${moved} (errors ${errors})`);
      await sleep(150);
    }
    pending = [];
  }

  do {
    const data = await fetchStretchedPage(storeDomain, accessToken, cursor);
    const connection = data.productVariants;
    for (const variant of connection?.nodes || []) {
      if (limit != null && scanned >= limit && !pending.length) break;
      if (!isStretchedFrame(variant)) continue;
      const inventoryItemId = variant.inventoryItem?.id;
      if (!inventoryItemId) {
        skipped += 1;
        continue;
      }
      if (done.has(inventoryItemId)) {
        skipped += 1;
        continue;
      }
      if (limit != null && scanned >= limit) break;

      scanned += 1;
      const levels = variant.inventoryItem?.inventoryLevels?.nodes || [];
      const atFrom = availableAt(levels, from.id);
      const atTo = availableAt(levels, to.id);
      if (atFrom.available <= 0) {
        skipped += 1;
        done.add(inventoryItemId);
        continue;
      }

      const job = {
        inventoryItemId,
        sku: variant.sku,
        handle: variant.product?.handle,
        qty: atFrom.available,
        needActivate: !atTo.exists,
        toAvailable: atTo.available,
      };
      if (samples.length < 6) samples.push(job);
      pending.push(job);

      if (pending.length >= SET_BATCH) {
        await flushPending();
      }
    }

    if (limit != null && scanned >= limit) {
      await flushPending();
      break;
    }
    if (!connection?.pageInfo?.hasNextPage) break;
    cursor = connection.pageInfo.endCursor;
    await sleep(200);
  } while (true);

  await flushPending();

  if (apply || done.size) {
    progress.doneInventoryItemIds = [...done];
    saveProgress(progress);
  }

  console.log("");
  console.log("Sample:", samples);
  console.log("Done:", {
    scanned,
    toMove: apply ? moved : toMove,
    units,
    moved: apply ? moved : 0,
    skipped,
    errors,
    apply,
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
