/**
 * Google Shopping custom labels (mm-google-shopping namespace).
 *
 * Product label 0: devotional, else artist name, else keep trendy, else empty.
 * Label 1: first style in the reviewed order.
 * Label 2: first art form (Line art, Watercolour, Geometric, Floral), else the Indian art form.
 * Label 3: first subject in the reviewed order.
 * Product label 4 and variant labels 0..3 stay empty.
 * Variant label 4: under_999 for XS (and anything under ₹1000), else 1000_3000 / 3000_6000 / 6000_plus.
 *
 * Styles, subjects and devotional follow the smart-collection rules saved in
 * ~/.editpro/shopify-live-collections.json.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { shopifyGraphql } = require("./shopify-client");

const NAMESPACE = "mm-google-shopping";
const METAFIELD_TYPE = "single_line_text_field";
const COLLECTIONS_PATH = path.join(os.homedir(), ".editpro", "shopify-live-collections.json");
const VARIANT_LABEL_KEYS = ["custom_label_0", "custom_label_1", "custom_label_2", "custom_label_3"];

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
  { label: "Pichwai", tags: ["pichwai"] },
  { label: "Gond", tags: ["gond"] },
  { label: "Madhubani", tags: ["madhubani"] },
  { label: "Warli", tags: ["warli art", "warli"] },
  { label: "Pattachitra", tags: ["pattachitra"] },
  { label: "Kalighat", tags: ["kalighat"] },
  { label: "Kalamkari", tags: ["kalamkari"] },
  { label: "Phad", tags: ["phad"] },
  { label: "Tanjore", tags: ["tanjore"] },
  { label: "Thangka", tags: ["thangka"] },
  { label: "Ragamala", tags: ["ragamala"] },
  { label: "Mughal Art", tags: ["mughal art"] },
  { label: "Indian Miniature", tags: ["indian miniature"] },
  { label: "Raja Ravi Verma", tags: ["raja ravi verma"] },
  { label: "Vintage Indian Art", tags: ["vintage indian art"] },
];

function loadLabelCollections() {
  const data = JSON.parse(fs.readFileSync(COLLECTIONS_PATH, "utf8"));
  const byHandle = (handle) => {
    const collection = (data.collections || []).find((row) => row.handle === handle);
    if (!collection?.ruleSet?.rules?.length) {
      throw new Error(`Collection rules missing for ${handle}`);
    }
    return collection;
  };
  return {
    styles: STYLE_HANDLES.map(byHandle),
    subjects: SUBJECT_HANDLES.map(byHandle),
    devotional: byHandle("devotional"),
  };
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

/** Product labels 0..4 in order; empty strings mean the label should not be set. */
function productLabels({ tags, artistGid = "", artistName = "", currentLabel0 = "" }, collections) {
  let label0 = "";
  if (matchesCollection(tags, artistGid, collections.devotional)) label0 = "devotional";
  else if (artistName) label0 = artistName;
  else if (currentLabel0 === "trendy") label0 = "trendy";
  return [
    label0,
    firstCollectionTitle(tags, artistGid, collections.styles),
    artForm(tags),
    firstCollectionTitle(tags, artistGid, collections.subjects),
    "",
  ];
}

function isXs(variant) {
  const size = (variant.selectedOptions || []).find((option) => /size/i.test(option.name || ""));
  if (size) return /^XS\b/i.test(String(size.value || "").trim());
  return /-XS-\d+$/i.test(String(variant.sku || ""));
}

function priceBand(variant) {
  if (isXs(variant)) return "under_999";
  const value = Number(variant.price);
  if (Number.isNaN(value)) return "";
  if (value < 1000) return "under_999";
  if (value < 3000) return "1000_3000";
  if (value < 6000) return "3000_6000";
  return "6000_plus";
}

const PRODUCT_QUERY = `query($id: ID!) {
  product(id: $id) {
    id
    tags
    label0: metafield(namespace: "${NAMESPACE}", key: "custom_label_0") { value }
    variants(first: 100) {
      nodes {
        id
        sku
        price
        selectedOptions { name value }
        label0: metafield(namespace: "${NAMESPACE}", key: "custom_label_0") { value }
        label1: metafield(namespace: "${NAMESPACE}", key: "custom_label_1") { value }
        label2: metafield(namespace: "${NAMESPACE}", key: "custom_label_2") { value }
        label3: metafield(namespace: "${NAMESPACE}", key: "custom_label_3") { value }
      }
    }
  }
}`;

const METAFIELDS_SET = `mutation($metafields: [MetafieldsSetInput!]!) {
  metafieldsSet(metafields: $metafields) { userErrors { message } }
}`;

const METAFIELDS_DELETE = `mutation($metafields: [MetafieldIdentifierInput!]!) {
  metafieldsDelete(metafields: $metafields) { userErrors { message } }
}`;

/**
 * Write the labels for one live product from its Shopify tags and variant prices.
 * The artist metafield is not read here; products put live by the Pipeline have none.
 */
async function applyLabelsToProduct(storeDomain, accessToken, shopifyProductId, collections) {
  const data = await shopifyGraphql(storeDomain, accessToken, PRODUCT_QUERY, { id: shopifyProductId });
  const product = data.product;
  if (!product) throw new Error(`Product ${shopifyProductId} not found on Shopify.`);
  const labels = productLabels({ tags: product.tags, currentLabel0: product.label0?.value || "" }, collections);
  const sets = [];
  labels.forEach((value, index) => {
    if (value) {
      sets.push({ ownerId: product.id, namespace: NAMESPACE, key: `custom_label_${index}`, type: METAFIELD_TYPE, value });
    }
  });
  const deletes = [];
  for (const variant of product.variants.nodes) {
    const band = priceBand(variant);
    if (band) {
      sets.push({ ownerId: variant.id, namespace: NAMESPACE, key: "custom_label_4", type: METAFIELD_TYPE, value: band });
    }
    VARIANT_LABEL_KEYS.forEach((key, index) => {
      if (variant[`label${index}`]?.value) deletes.push({ ownerId: variant.id, namespace: NAMESPACE, key });
    });
  }
  for (let i = 0; i < sets.length; i += 25) {
    const result = await shopifyGraphql(storeDomain, accessToken, METAFIELDS_SET, { metafields: sets.slice(i, i + 25) });
    const errors = result.metafieldsSet?.userErrors || [];
    if (errors.length) throw new Error(errors.map((error) => error.message).join("; "));
  }
  for (let i = 0; i < deletes.length; i += 25) {
    const result = await shopifyGraphql(storeDomain, accessToken, METAFIELDS_DELETE, { metafields: deletes.slice(i, i + 25) });
    const errors = result.metafieldsDelete?.userErrors || [];
    if (errors.length) throw new Error(errors.map((error) => error.message).join("; "));
  }
  return labels;
}

module.exports = {
  NAMESPACE,
  METAFIELD_TYPE,
  VARIANT_LABEL_KEYS,
  loadLabelCollections,
  matchesCollection,
  productLabels,
  priceBand,
  applyLabelsToProduct,
};
