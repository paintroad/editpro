/**
 * Deactivate Stretched Canvas inventory at Naraina/Nariana (leave Mayapuri only).
 *
 * Usage:
 *   node scripts/deactivate-stretched-at-naraina.js
 *   node scripts/deactivate-stretched-at-naraina.js --apply
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { getShopifyCredentials } = require("../lib/config-store");
const { shopifyGraphql } = require("../lib/shopify-client");

const CONFIG_DIR = path.join(os.homedir(), ".editpro");
const PROGRESS_PATH = path.join(CONFIG_DIR, "deactivate-stretched-naraina-progress.json");
const FROM_NAMES = ["naraina", "nariana"];
const FRAME_VALUE = "Stretched Canvas";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function gql(storeDomain, accessToken, query, variables = {}, attempt = 0) {
  try {
    return await shopifyGraphql(storeDomain, accessToken, query, variables);
  } catch (err) {
    const msg = String(err.message || err);
    if (/throttl/i.test(msg) && attempt < 12) {
      const wait = Math.min(60000, 2000 * 2 ** Math.min(attempt, 5));
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

async function resolveNaraina(storeDomain, accessToken) {
  const data = await gql(
    storeDomain,
    accessToken,
    `query { locations(first: 25, includeInactive: true) { nodes { id name } } }`
  );
  const nodes = data.locations?.nodes || [];
  const naraina = nodes.find((n) =>
    FROM_NAMES.some((x) => String(n.name || "").toLowerCase().includes(x))
  );
  if (!naraina) throw new Error("Naraina location not found");
  return naraina;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const reset = process.argv.includes("--reset");
  const { storeDomain, accessToken } = getShopifyCredentials();
  const naraina = await resolveNaraina(storeDomain, accessToken);
  let progress = reset ? { done: [] } : loadProgress();
  const done = new Set(progress.done || []);

  console.log(apply ? "APPLY" : "DRY-RUN");
  console.log("Deactivate Stretched Canvas at:", naraina.name, naraina.id);

  let cursor = null;
  let hasNext = true;
  let scanned = 0;
  let need = 0;
  let fixed = 0;
  let errors = 0;

  while (hasNext) {
    const data = await gql(
      storeDomain,
      accessToken,
      `query ($cursor: String, $query: String!) {
        productVariants(first: 50, after: $cursor, query: $query) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            sku
            selectedOptions { name value }
            inventoryItem {
              id
              inventoryLevels(first: 10) {
                nodes {
                  id
                  location { id name }
                  quantities(names: ["available"]) { name quantity }
                }
              }
            }
          }
        }
      }`,
      { cursor, query: 'option2:"Stretched Canvas"' }
    );

    const page = data.productVariants;
    for (const node of page?.nodes || []) {
      const frame = (node.selectedOptions || []).find(
        (o) => String(o.name).toLowerCase() === "frame"
      );
      if (!frame || frame.value !== FRAME_VALUE) continue;
      scanned += 1;
      const invId = node.inventoryItem?.id;
      if (!invId || done.has(invId)) continue;

      const level = (node.inventoryItem?.inventoryLevels?.nodes || []).find(
        (l) => l.location?.id === naraina.id
      );
      if (!level) {
        done.add(invId);
        continue;
      }

      need += 1;
      const avail =
        (level.quantities || []).find((q) => q.name === "available")?.quantity || 0;

      if (!apply) {
        if (need <= 5) {
          console.log(`PLAN deactivate ${node.sku} Naraina avail=${avail}`);
        }
        continue;
      }

      try {
        // Zero first if needed, then deactivate
        if (Number(avail) !== 0) {
          const setData = await gql(
            storeDomain,
            accessToken,
            `mutation($input: InventorySetQuantitiesInput!) {
              inventorySetQuantities(input: $input) {
                userErrors { message }
              }
            }`,
            {
              input: {
                name: "available",
                reason: "correction",
                referenceDocumentUri: `gid://editpro/DeactivateStretchedNaraina/${invId}`,
                quantities: [
                  {
                    inventoryItemId: invId,
                    locationId: naraina.id,
                    quantity: 0,
                    changeFromQuantity: Number(avail),
                  },
                ],
              },
            }
          );
          const setErr = setData.inventorySetQuantities?.userErrors || [];
          if (setErr.length) throw new Error(setErr.map((e) => e.message).join("; "));
        }

        const deact = await gql(
          storeDomain,
          accessToken,
          `mutation($inventoryLevelId: ID!) {
            inventoryDeactivate(inventoryLevelId: $inventoryLevelId) {
              userErrors { message }
            }
          }`,
          { inventoryLevelId: level.id }
        );
        const dErr = deact.inventoryDeactivate?.userErrors || [];
        if (dErr.length && !/not found|already/i.test(dErr.map((e) => e.message).join("; "))) {
          throw new Error(dErr.map((e) => e.message).join("; "));
        }
        fixed += 1;
        done.add(invId);
        progress.done = [...done];
        if (fixed % 25 === 0) {
          saveProgress(progress);
          console.log(`Fixed ${fixed}…`);
        }
      } catch (e) {
        errors += 1;
        console.error(`ERR ${node.sku}:`, e.message || e);
      }
      await sleep(150);
    }

    hasNext = Boolean(page?.pageInfo?.hasNextPage);
    cursor = page?.pageInfo?.endCursor || null;
  }

  if (apply) saveProgress(progress);
  console.log({ scanned, need, fixed, errors, apply });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
