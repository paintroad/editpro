/**
 * Set product mm-google-shopping custom_label_0..4 and variant custom_label_0.
 *
 * Product label 0: devotional, else artist name, else keep trendy, else empty.
 * Label 1: first style in the reviewed order.
 * Label 2: first art form (Line art, Watercolour, Geometric, Floral).
 * Label 3: shopify.color-pattern; two or more names become multicolor.
 * Label 4: first subject in the reviewed order.
 * Variant label 0: sale-price band under_1000 / 1000_3000 / 3000_6000 / 6000_plus.
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

const NAMESPACE = "mm-google-shopping";
const METAFIELD_TYPE = "single_line_text_field";
const COLLECTIONS_PATH = path.join(os.homedir(), ".editpro", "shopify-live-collections.json");
const REPORT_PATH = path.join(os.homedir(), ".editpro", "custom-labels-apply-report.json");
const BATCH_SIZE = 25;

const STYLE_HANDLES = [
  "modern",
  "abstract",
  "boho",
  "monochrome",
  "maximalist",
  "pop-art",
  "bauhaus",
  "picasso-inspired",
  "natural-vintage",
  "maximalist-art",
  "mattise-style",
  "banksy",
  "intricate-patterns",
];

const SUBJECT_HANDLES = [
  "travel",
  "botanical-prints",
  "beach-vacation",
  "animal",
  "women-illustrations",
  "love-romance",
  "cowgirl",
  "autumn",
  "kitchen-prints",
  "motivational-quotes",
  "cocktails",
  "greek",
  "dog-lovers",
  "sun-signs",
  "cat-lovers",
];

const ART_FORMS = [
  { label: "Line art", tags: ["line art"] },
  { label: "Watercolour", tags: ["watercolour", "watercolor"] },
  { label: "Geometric", tags: ["geometric"] },
  { label: "Floral", tags: ["floral"] },
];

const BULK_QUERY = `{
  products {
    edges {
      node {
        id
        handle
        status
        tags
        artist: metafield(namespace: "custom", key: "artist") { value }
        colorPattern: metafield(namespace: "shopify", key: "color-pattern") { value }
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
              label0: metafield(namespace: "mm-google-shopping", key: "custom_label_0") { value }
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

function loadCollection(handle) {
  const data = JSON.parse(fs.readFileSync(COLLECTIONS_PATH, "utf8"));
  const collection = (data.collections || []).find((row) => row.handle === handle);
  if (!collection?.ruleSet?.rules?.length) {
    throw new Error(`Collection rules missing for ${handle}`);
  }
  return collection;
}

function tagSet(tags) {
  return new Set((tags || []).map((tag) => String(tag).trim().toLowerCase()));
}

function matchesCollection(tags, artistGid, collection) {
  const have = tagSet(tags);
  const checks = collection.ruleSet.rules.map((rule) => {
    if (rule.column === "TAG") {
      return have.has(String(rule.condition || "").trim().toLowerCase());
    }
    if (rule.column === "PRODUCT_METAFIELD_DEFINITION") {
      return Boolean(artistGid) && artistGid === rule.condition;
    }
    return false;
  });
  return collection.ruleSet.appliedDisjunctively ? checks.some(Boolean) : checks.every(Boolean);
}

function firstCollectionTitle(tags, artistGid, collections) {
  for (const collection of collections) {
    if (matchesCollection(tags, artistGid, collection)) return collection.title;
  }
  return "";
}

function artForm(tags) {
  const have = tagSet(tags);
  for (const form of ART_FORMS) {
    if (form.tags.some((tag) => have.has(tag))) return form.label;
  }
  return "";
}

function priceBand(price) {
  const value = Number(price);
  if (Number.isNaN(value)) return "";
  if (value < 1000) return "under_1000";
  if (value < 3000) return "1000_3000";
  if (value < 6000) return "3000_6000";
  return "6000_plus";
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
  const styles = STYLE_HANDLES.map(loadCollection);
  const subjects = SUBJECT_HANDLES.map(loadCollection);
  const devotional = loadCollection("devotional");
  const { storeDomain, accessToken } = getShopifyCredentials();

  console.log("Loading artist and colour names…");
  const artistNames = await loadIdNames(storeDomain, accessToken, "artists", "name");
  const colorNames = await loadIdNames(storeDomain, accessToken, "shopify--color-pattern", "label");
  console.log(`Artists ${artistNames.size} | Colours ${colorNames.size}`);

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
  const colorAssigned = {};
  const subjectMembership = {};
  const subjectAssigned = {};
  const bandCounts = {};
  const sets = [];
  const deletes = [];
  let activeProducts = 0;
  let activeVariants = 0;
  let unresolvedColors = 0;

  for (const product of products.values()) {
    if (product.status !== "ACTIVE") continue;
    activeProducts += 1;
    const artistGid = parseGids(product.artist?.value)[0] || "";
    const artistName = artistGid ? artistNames.get(artistGid) || "" : "";
    const tags = product.tags || [];
    const devotionalHit = matchesCollection(tags, artistGid, devotional);
    let label0 = "";
    if (devotionalHit) label0 = "devotional";
    else if (artistName) label0 = artistName;
    else if (String(product.label0?.value || "") === "trendy") label0 = "trendy";
    bump(label0Counts, label0 || "(empty)");

    for (const collection of styles) {
      if (matchesCollection(tags, artistGid, collection)) bump(styleMembership, collection.title);
    }
    const label1 = firstCollectionTitle(tags, artistGid, styles);
    bump(styleAssigned, label1 || "(empty)");

    const label2 = artForm(tags);
    bump(artAssigned, label2 || "(empty)");

    const colorIds = parseGids(product.colorPattern?.value);
    const colorLabels = [];
    for (const id of colorIds) {
      const name = colorNames.get(id);
      if (!name) unresolvedColors += 1;
      else if (!colorLabels.includes(name)) colorLabels.push(name);
    }
    let label3 = "";
    if (colorLabels.length === 1) label3 = colorLabels[0];
    else if (colorLabels.length > 1) label3 = "multicolor";
    bump(colorAssigned, label3 || "(empty)");

    for (const collection of subjects) {
      if (matchesCollection(tags, artistGid, collection)) bump(subjectMembership, collection.title);
    }
    const label4 = firstCollectionTitle(tags, artistGid, subjects);
    bump(subjectAssigned, label4 || "(empty)");

    const desired = [label0, label1, label2, label3, label4];
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
      const band = priceBand(variant.price);
      bump(bandCounts, band || "(empty)");
      if (!band || band === String(variant.label0?.value || "")) continue;
      sets.push({
        ownerId: variant.id,
        namespace: NAMESPACE,
        key: "custom_label_0",
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
    colorAssigned,
    subjectMembership,
    subjectAssigned,
    bandCounts,
    unresolvedColors,
    sets: sets.length,
    deletes: deletes.length,
  };
  console.log(JSON.stringify(summary, null, 2));

  if (!apply) {
    console.log("Dry run only. Re-run with --apply to write.");
    return;
  }

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
