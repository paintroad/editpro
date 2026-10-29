/**
 * Set mm-google-shopping custom labels on every active product and variant.
 * The rules live in lib/google-custom-labels.js (also used by the Pipeline).
 *
 * Run:
 *   node scripts/set-product-custom-labels.js
 *   node scripts/set-product-custom-labels.js --apply
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { shopifyGraphql } = require("../lib/shopify-client");
const { getShopifyCredentials } = require("../lib/config-store");
const {
  NAMESPACE,
  METAFIELD_TYPE,
  VARIANT_LABEL_KEYS,
  loadLabelCollections,
  matchesCollection,
  productLabels,
  priceBand,
} = require("../lib/google-custom-labels");

const REPORT_PATH = path.join(os.homedir(), ".editpro", "custom-labels-apply-report.json");
const BATCH_SIZE = 25;

const BULK_QUERY = `{
  products {
    edges {
      node {
        id
        handle
        status
        tags
        artist: metafield(namespace: "custom", key: "artist") { value }
        label0: metafield(namespace: "mm-google-shopping", key: "custom_label_0") { value }
        label1: metafield(namespace: "mm-google-shopping", key: "custom_label_1") { value }
        label2: metafield(namespace: "mm-google-shopping", key: "custom_label_2") { value }
        label3: metafield(namespace: "mm-google-shopping", key: "custom_label_3") { value }
        label4: metafield(namespace: "mm-google-shopping", key: "custom_label_4") { value }
        variants {
          edges {
            node {
              id
              sku
              price
              selectedOptions { name value }
              label0: metafield(namespace: "mm-google-shopping", key: "custom_label_0") { value }
              label1: metafield(namespace: "mm-google-shopping", key: "custom_label_1") { value }
              label2: metafield(namespace: "mm-google-shopping", key: "custom_label_2") { value }
              label3: metafield(namespace: "mm-google-shopping", key: "custom_label_3") { value }
              label4: metafield(namespace: "mm-google-shopping", key: "custom_label_4") { value }
            }
          }
        }
      }
    }
  }
}`;

const METAFIELDS_SET = `mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
  metafieldsSet(metafields: $metafields) {
    metafields { id }
    userErrors { field message }
  }
}`;

const METAFIELDS_DELETE = `mutation MetafieldsDelete($metafields: [MetafieldIdentifierInput!]!) {
  metafieldsDelete(metafields: $metafields) {
    deletedMetafields { ownerId key }
    userErrors { field message }
  }
}`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isApply(argv = process.argv) {
  return argv.includes("--apply");
}

async function gql(storeDomain, accessToken, query, variables) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      return await shopifyGraphql(storeDomain, accessToken, query, variables);
    } catch (error) {
      const message = String(error?.message || error);
      if (!/throttl/i.test(message) || attempt === 7) throw error;
      const wait = Math.min(60000, 2000 * 2 ** attempt);
      console.warn(`Throttled — retry in ${wait}ms`);
      await sleep(wait);
    }
  }
  return null;
}

function parseGids(value) {
  const text = String(value || "").trim();
  if (!text) return [];
  if (text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  if (text.startsWith("gid://")) return [text];
  return [];
}

async function loadIdNames(storeDomain, accessToken, type, nameKey) {
  const names = new Map();
  let cursor = null;
  let hasNext = true;
  while (hasNext) {
    const data = await gql(
      storeDomain,
      accessToken,
      `query($type: String!, $cursor: String) {
        metaobjects(type: $type, first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes { id displayName fields { key value } }
        }
      }`,
      { type, cursor }
    );
    const page = data.metaobjects;
    for (const node of page?.nodes || []) {
      const field = (node.fields || []).find((row) => row.key === nameKey)?.value;
      names.set(node.id, String(field || node.displayName || "").trim());
    }
    hasNext = Boolean(page?.pageInfo?.hasNextPage);
    cursor = page?.pageInfo?.endCursor || null;
  }
  return names;
}

async function downloadProducts(storeDomain, accessToken) {
  const current = await gql(storeDomain, accessToken, `query { currentBulkOperation { id status } }`);
  const running = current.currentBulkOperation;
  if (running && !["COMPLETED", "FAILED", "CANCELED", "EXPIRED"].includes(running.status)) {
    throw new Error(`A Shopify bulk operation is already ${running.status}.`);
  }
  const started = await gql(
    storeDomain,
    accessToken,
    `mutation ($query: String!) {
      bulkOperationRunQuery(query: $query) {
        bulkOperation { id status }
        userErrors { field message }
      }
    }`,
    { query: BULK_QUERY }
  );
  const errors = started.bulkOperationRunQuery?.userErrors || [];
  if (errors.length) throw new Error(errors.map((error) => error.message).join("; "));

  let url = "";
  for (let attempt = 0; attempt < 180; attempt += 1) {
    await sleep(5000);
    const poll = await gql(
      storeDomain,
      accessToken,
      `query { currentBulkOperation { status errorCode objectCount url } }`
    );
    const op = poll.currentBulkOperation;
    console.log(`${op?.status || "unknown"} objects=${op?.objectCount || 0}`);
    if (op?.status === "COMPLETED") {
      url = op.url || "";
      break;
    }
    if (["FAILED", "CANCELED", "EXPIRED"].includes(op?.status)) {
      throw new Error(`Bulk operation ${op.status} ${op.errorCode || ""}`);
    }
  }
  if (!url) throw new Error("Bulk operation finished without a download URL.");
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed ${response.status}`);
  const file = path.join(os.tmpdir(), "custom-label-source.jsonl");
  fs.writeFileSync(file, Buffer.from(await response.arrayBuffer()));
  return file;
}

function bump(map, key) {
  map[key] = (map[key] || 0) + 1;
}

async function writeBatches(storeDomain, accessToken, mutation, field, rows, label) {
  let done = 0;
  const errors = [];
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const chunk = rows.slice(i, i + BATCH_SIZE);
    try {
      const data = await gql(storeDomain, accessToken, mutation, { metafields: chunk });
      const userErrors = data?.[field]?.userErrors || [];
      if (userErrors.length) {
        errors.push({ at: i, message: userErrors.map((error) => error.message).join("; ") });
      } else {
        done += chunk.length;
      }
    } catch (error) {
      errors.push({ at: i, message: error?.message || String(error) });
    }
    if ((i / BATCH_SIZE) % 20 === 0 || i + BATCH_SIZE >= rows.length) {
      process.stdout.write(`\r${label} ${Math.min(i + chunk.length, rows.length)}/${rows.length} errors ${errors.length}   `);
    }
    await sleep(40);
  }
  process.stdout.write("\n");
  return { done, errors };
}

async function main() {
  const apply = isApply();
  const collections = loadLabelCollections();
  const { storeDomain, accessToken } = getShopifyCredentials();

  console.log("Loading artist names…");
  const artistNames = await loadIdNames(storeDomain, accessToken, "artists", "name");
  console.log(`Artists ${artistNames.size}`);

  console.log("Downloading active catalog…");
  const file = await downloadProducts(storeDomain, accessToken);
  const products = new Map();
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    const row = JSON.parse(line);
    if (String(row.id || "").includes("/Product/")) {
      products.set(row.id, { ...row, variants: [] });
    } else if (String(row.id || "").includes("/ProductVariant/")) {
      const product = products.get(row.__parentId);
      if (product) product.variants.push(row);
    }
  }

  const label0Counts = {};
  const styleMembership = {};
  const styleAssigned = {};
  const artAssigned = {};
  const subjectMembership = {};
  const subjectAssigned = {};
  const bandCounts = {};
  const sets = [];
  const deletes = [];
  let activeProducts = 0;
  let activeVariants = 0;

  for (const product of products.values()) {
    if (product.status !== "ACTIVE") continue;
    activeProducts += 1;
    const artistGid = parseGids(product.artist?.value)[0] || "";
    const artistName = artistGid ? artistNames.get(artistGid) || "" : "";
    const tags = product.tags || [];
    const desired = productLabels(
      { tags, artistGid, artistName, currentLabel0: String(product.label0?.value || "") },
      collections
    );
    bump(label0Counts, desired[0] || "(empty)");
    bump(styleAssigned, desired[1] || "(empty)");
    bump(artAssigned, desired[2] || "(empty)");
    bump(subjectAssigned, desired[3] || "(empty)");
    for (const collection of collections.styles) {
      if (matchesCollection(tags, artistGid, collection)) bump(styleMembership, collection.title);
    }
    for (const collection of collections.subjects) {
      if (matchesCollection(tags, artistGid, collection)) bump(subjectMembership, collection.title);
    }

    const current = [0, 1, 2, 3, 4].map((index) => String(product[`label${index}`]?.value || ""));
    desired.forEach((value, index) => {
      const key = `custom_label_${index}`;
      if (value === current[index]) return;
      if (value) {
        sets.push({
          ownerId: product.id,
          namespace: NAMESPACE,
          key,
          type: METAFIELD_TYPE,
          value,
        });
      } else if (current[index]) {
        deletes.push({ ownerId: product.id, namespace: NAMESPACE, key });
      }
    });

    for (const variant of product.variants) {
      activeVariants += 1;
      const band = priceBand(variant);
      bump(bandCounts, band || "(empty)");
      VARIANT_LABEL_KEYS.forEach((key, index) => {
        if (String(variant[`label${index}`]?.value || "")) {
          deletes.push({ ownerId: variant.id, namespace: NAMESPACE, key });
        }
      });
      if (!band || band === String(variant.label4?.value || "")) continue;
      sets.push({
        ownerId: variant.id,
        namespace: NAMESPACE,
        key: "custom_label_4",
        type: METAFIELD_TYPE,
        value: band,
      });
    }
  }

  const summary = {
    activeProducts,
    activeVariants,
    label0Counts,
    styleMembership,
    styleAssigned,
    artAssigned,
    subjectMembership,
    subjectAssigned,
    bandCounts,
    sets: sets.length,
    deletes: deletes.length,
  };
  console.log(JSON.stringify(summary, null, 2));

  if (!apply) {
    console.log("Dry run only. Re-run with --apply to write.");
    return;
  }

  const backupDir = path.join(os.homedir(), ".editpro", "backups");
  fs.mkdirSync(backupDir, { recursive: true });
  const backup = path.join(backupDir, `custom-labels-before-${Date.now()}.jsonl`);
  fs.copyFileSync(file, backup);
  console.log(`Previous labels saved to ${backup}`);
  console.log(`Writing ${sets.length} metafields, deleting ${deletes.length}…`);
  const setResult = await writeBatches(storeDomain, accessToken, METAFIELDS_SET, "metafieldsSet", sets, "set");
  const deleteResult = await writeBatches(
    storeDomain,
    accessToken,
    METAFIELDS_DELETE,
    "metafieldsDelete",
    deletes,
    "delete"
  );
  const report = {
    generatedAt: new Date().toISOString(),
    ...summary,
    setDone: setResult.done,
    setErrors: setResult.errors,
    deleteDone: deleteResult.done,
    deleteErrors: deleteResult.errors,
  };
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  console.log(`Report: ${REPORT_PATH}`);
  if (setResult.errors.length || deleteResult.errors.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exit(1);
});
