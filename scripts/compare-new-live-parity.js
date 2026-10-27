/**
 * Structural parity: three new products vs three already-live catalog products.
 */
const { getShopifyCredentials } = require("../lib/config-store");
const { shopifyGraphql } = require("../lib/shopify-client");

const NEW_HANDLES = [
  "monochrome-lord-hanuman-op-art",
  "vibrant-pop-art-icon",
  "mystical-hypnotic-hanuman",
];

const PRODUCT_QUERY = `query ($handle: String!) {
  productByHandle(handle: $handle) {
    id title handle status vendor productType templateSuffix
    descriptionHtml
    category { id name fullName }
    seo { title description }
    tags
    options {
      name
      values
      linkedMetafield { namespace key }
    }
    media(first: 20) {
      nodes {
        mediaContentType
        status
        ... on MediaImage { image { url altText } }
      }
    }
    resourcePublications(first: 15) {
      nodes { isPublished publication { name } }
    }
    metafields(first: 40) {
      nodes { namespace key type value }
    }
    variants(first: 40) {
      nodes {
        sku price compareAtPrice taxable inventoryPolicy
        selectedOptions { name value }
        inventoryItem {
          tracked requiresShipping countryCodeOfOrigin
          unitCost { amount }
          measurement { weight { value unit } }
          inventoryLevels(first: 6) {
            nodes {
              location { name }
              quantities(names: ["available"]) { name quantity }
            }
          }
        }
      }
    }
  }
}`;

function sizeCode(label) {
  return String(label || "").split(" ")[0];
}

function levels(variant) {
  return (variant.inventoryItem?.inventoryLevels?.nodes || [])
    .map((node) => {
      const qty = (node.quantities || []).find((row) => row.name === "available");
      return `${node.location?.name}=${qty ? qty.quantity : "?"}`;
    })
    .sort();
}

function fingerprint(product) {
  const variants = {};
  for (const variant of product.variants.nodes) {
    const options = Object.fromEntries(
      (variant.selectedOptions || []).map((row) => [row.name, row.value])
    );
    const key = [options.Material, sizeCode(options.Size), options.Frame].join("|");
    variants[key] = {
      price: variant.price,
      compare: variant.compareAtPrice,
      taxable: variant.taxable,
      policy: variant.inventoryPolicy,
      tracked: variant.inventoryItem?.tracked,
      shipping: variant.inventoryItem?.requiresShipping,
      origin: variant.inventoryItem?.countryCodeOfOrigin,
      cost: variant.inventoryItem?.unitCost?.amount || null,
      weight: variant.inventoryItem?.measurement?.weight
        ? `${variant.inventoryItem.measurement.weight.value}${variant.inventoryItem.measurement.weight.unit}`
        : null,
      stock: levels(variant).join(","),
      skuSuffix: String(variant.sku || "").replace(/^\d+/, "{id}"),
    };
  }
  const media = product.media.nodes || [];
  const files = media.map((node) => {
    const url = node.image?.url || "";
    const file = decodeURIComponent(url.split("/").pop() || "").split("?")[0];
    return {
      ext: (file.split(".").pop() || "").toLowerCase(),
      alt: Boolean(node.image?.altText),
      status: node.status,
      index: (file.match(/-(\d+)\.[a-z]+$/i) || [])[1] || "",
    };
  });
  const metafields = {};
  for (const field of product.metafields.nodes || []) {
    const key = `${field.namespace}.${field.key}`;
    let value = field.value;
    if (field.type && field.type.startsWith("list.")) {
      try {
        value = `count:${JSON.parse(field.value).length}`;
      } catch {
        value = "list";
      }
    }
    metafields[key] = `${field.type}:${value}`;
  }
  const seoTitle = product.seo?.title || "";
  const seoDescription = product.seo?.description || "";
  return {
    status: product.status,
    vendor: product.vendor,
    productType: product.productType,
    templateSuffix: product.templateSuffix || "",
    category: product.category?.fullName || product.category?.name || "",
    descriptionChars: (product.descriptionHtml || "").length,
    seoTitleShape: seoTitle.includes(product.title) && /Paintroad/.test(seoTitle),
    seoDescriptionShape:
      /₹499/.test(seoDescription) &&
      /Paintroad/.test(seoDescription) &&
      product.title &&
      seoDescription.includes(product.title),
    tagCount: (product.tags || []).length,
    options: (product.options || []).map(
      (option) =>
        `${option.name}[${(option.linkedMetafield && option.linkedMetafield.key) || "plain"}]=${option.values.join(" | ")}`
    ),
    mediaCount: files.length,
    mediaReady: files.every((file) => file.status === "READY"),
    alts: files.every((file) => file.alt),
    firstExt: files[0]?.ext || "",
    pngIndexes: files.filter((file) => file.ext === "png").map((file) => file.index),
    jpgIndexes: files.filter((file) => file.ext === "jpg" || file.ext === "jpeg").map((file) => file.index),
    publications: (product.resourcePublications.nodes || [])
      .filter((node) => node.isPublished)
      .map((node) => node.publication?.name)
      .sort(),
    metafields,
    variantCount: Object.keys(variants).length,
    variants,
  };
}

function diffObjects(left, right, prefix = "") {
  const gaps = [];
  const keys = new Set([...Object.keys(left || {}), ...Object.keys(right || {})]);
  for (const key of [...keys].sort()) {
    const path = prefix ? `${prefix}.${key}` : key;
    const a = left?.[key];
    const b = right?.[key];
    if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
      gaps.push(...diffObjects(a, b, path));
      continue;
    }
    const as = JSON.stringify(a);
    const bs = JSON.stringify(b);
    if (as !== bs) {
      gaps.push({ path, live: a === undefined ? "(missing)" : a, new: b === undefined ? "(missing)" : b });
    }
  }
  return gaps;
}

async function main() {
  const credentials = getShopifyCredentials();
  const recent = await shopifyGraphql(
    credentials.storeDomain,
    credentials.accessToken,
    `query {
      products(first: 12, sortKey: CREATED_AT, reverse: true) {
        nodes { handle title createdAt }
      }
    }`
  );
  const older = (recent.products.nodes || []).filter((node) => !NEW_HANDLES.includes(node.handle));
  const referenceHandles = older.slice(0, 3).map((node) => node.handle);
  console.log(
    "references",
    older
      .slice(0, 3)
      .map((node) => `${node.handle} (${node.title})`)
      .join(" | ")
  );

  async function load(handle) {
    const data = await shopifyGraphql(
      credentials.storeDomain,
      credentials.accessToken,
      PRODUCT_QUERY,
      { handle }
    );
    if (!data.productByHandle) {
      throw new Error(`Missing ${handle}`);
    }
    return fingerprint(data.productByHandle);
  }

  const references = [];
  for (const handle of referenceHandles) {
    references.push({ handle, fp: await load(handle) });
  }
  const created = [];
  for (const handle of NEW_HANDLES) {
    created.push({ handle, fp: await load(handle) });
  }

  const referenceVariants = references.map((row) => row.fp.variants);
  const sharedVariantKeys = Object.keys(referenceVariants[0]).filter((key) =>
    referenceVariants.every((matrix) => matrix[key])
  );
  const canonical = { ...references[0].fp, variants: {} };
  for (const key of sharedVariantKeys) {
    const values = referenceVariants.map((matrix) => JSON.stringify(matrix[key]));
    if (new Set(values).size === 1) {
      canonical.variants[key] = referenceVariants[0][key];
    }
  }
  const refMeta = {};
  for (const key of Object.keys(references[0].fp.metafields)) {
    const values = references.map((row) => row.fp.metafields[key]);
    if (values.every((value) => value === values[0])) {
      refMeta[key] = values[0];
    }
  }
  canonical.metafields = refMeta;
  delete canonical.tagCount;
  delete canonical.mediaCount;
  delete canonical.pngIndexes;
  delete canonical.jpgIndexes;

  for (const row of created) {
    const compare = { ...row.fp };
    delete compare.tagCount;
    delete compare.mediaCount;
    delete compare.pngIndexes;
    delete compare.jpgIndexes;
    const gaps = diffObjects(canonical, compare).filter((gap) => {
      if (gap.path.startsWith("variants.") && !canonical.variants[gap.path.split(".").slice(1, 3).join(".")] && gap.live === "(missing)") {
        return false;
      }
      return true;
    });
    console.log("\n==", row.handle, "media", row.fp.mediaCount, "png", row.fp.pngIndexes.join(","), "jpg", row.fp.jpgIndexes.join(","));
    if (!gaps.length) {
      console.log("parity with shared live structure");
      continue;
    }
    for (const gap of gaps) {
      console.log(`- ${gap.path}\n    live: ${JSON.stringify(gap.live)}\n    new:  ${JSON.stringify(gap.new)}`);
    }
  }

  console.log("\nreference media");
  for (const row of references) {
    console.log(row.handle, "media", row.fp.mediaCount, "png", row.fp.pngIndexes.join(","), "jpg", row.fp.jpgIndexes.join(","), "first", row.fp.firstExt);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
