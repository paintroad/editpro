const fs = require("fs");
const path = require("path");
const { shopifyGraphql } = require("./shopify-client");
const { getShopifyCredentials } = require("./config-store");
const { loadCatalogStore, getProduct, saveCatalogStore } = require("./catalog-products-store");
const { catalogProductImages } = require("./catalog-seo-fix");

const PUSH_CONCURRENCY = 3;
let pushJob = null;

function mimeTypeForPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") {
    return "image/png";
  }
  if (ext === ".webp") {
    return "image/webp";
  }
  if (ext === ".gif") {
    return "image/gif";
  }
  return "image/jpeg";
}

function joinList(values, sep = "; ") {
  if (!Array.isArray(values)) {
    return "";
  }
  return values.map((v) => String(v || "").trim()).filter(Boolean).join(sep);
}

function uniqueOptionValues(variants, key) {
  const seen = new Set();
  const values = [];
  for (const variant of variants) {
    const value = variant[key];
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    values.push(value);
  }
  return values;
}

function buildProductOptions(variants) {
  const sizes = uniqueOptionValues(variants, "size");
  const materials = uniqueOptionValues(variants, "material");
  const frames = uniqueOptionValues(variants, "exportFrame");
  const options = [];
  if (sizes.length) {
    options.push({ name: "Size", values: sizes.map((name) => ({ name })) });
  }
  if (materials.length) {
    options.push({ name: "Material", values: materials.map((name) => ({ name })) });
  }
  if (frames.length) {
    options.push({ name: "Frame", values: frames.map((name) => ({ name })) });
  }
  return options;
}

function buildMetafields(product) {
  const mf = product.metafields || {};
  const entries = [];
  const color = joinList(mf.color, "; ");
  const theme = joinList(mf.theme, "; ");
  const artworkFrameMaterial = joinList(mf.artworkFrameMaterial, "; ");
  const frameStyle = joinList(mf.frameStyle, "; ");
  const searchBoosts = String(mf.searchProductBoosts || "").trim();

  if (color) {
    entries.push({
      namespace: "shopify",
      key: "color-pattern",
      type: "list.single_line_text_field",
      value: JSON.stringify(color.split("; ").filter(Boolean)),
    });
  }
  if (theme) {
    entries.push({
      namespace: "shopify",
      key: "theme",
      type: "list.single_line_text_field",
      value: JSON.stringify(theme.split("; ").filter(Boolean)),
    });
  }
  if (artworkFrameMaterial) {
    entries.push({
      namespace: "shopify",
      key: "artwork-frame-material",
      type: "list.single_line_text_field",
      value: JSON.stringify(artworkFrameMaterial.split("; ").filter(Boolean)),
    });
  }
  if (frameStyle) {
    entries.push({
      namespace: "shopify",
      key: "frame-style",
      type: "list.single_line_text_field",
      value: JSON.stringify(frameStyle.split("; ").filter(Boolean)),
    });
  }
  if (searchBoosts) {
    entries.push({
      namespace: "shopify--discovery--product_search_boost",
      key: "queries",
      type: "single_line_text_field",
      value: searchBoosts,
    });
  }
  return entries;
}

async function getPrimaryLocationId(storeDomain, accessToken) {
  const data = await shopifyGraphql(
    storeDomain,
    accessToken,
    `query { locations(first: 1) { nodes { id name } } }`
  );
  const location = data.locations?.nodes?.[0];
  if (!location?.id) {
    throw new Error("No Shopify location found for inventory.");
  }
  return location.id;
}

async function productExistsByHandle(storeDomain, accessToken, handle) {
  const data = await shopifyGraphql(
    storeDomain,
    accessToken,
    `query ProductByHandle($handle: String!) {
      productByHandle(handle: $handle) { id handle }
    }`,
    { handle }
  );
  return data.productByHandle || null;
}

async function stagedUploadFile(storeDomain, accessToken, localPath) {
  const filename = path.basename(localPath);
  const mimeType = mimeTypeForPath(localPath);
  const data = await shopifyGraphql(
    storeDomain,
    accessToken,
    `mutation StagedUploadsCreate($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets { url resourceUrl parameters { name value } }
        userErrors { field message }
      }
    }`,
    {
      input: [
        {
          filename,
          mimeType,
          resource: "PRODUCT_IMAGE",
          httpMethod: "POST",
        },
      ],
    }
  );
  const result = data.stagedUploadsCreate;
  if (result.userErrors?.length) {
    throw new Error(result.userErrors.map((e) => e.message).join("; "));
  }
  const target = result.stagedTargets?.[0];
  if (!target?.url) {
    throw new Error("Staged upload target missing.");
  }

  const fileBuffer = fs.readFileSync(localPath);
  const form = new FormData();
  for (const param of target.parameters || []) {
    form.append(param.name, param.value);
  }
  form.append("file", new Blob([fileBuffer], { type: mimeType }), filename);

  const uploadResponse = await fetch(target.url, { method: "POST", body: form });
  if (!uploadResponse.ok) {
    const text = await uploadResponse.text().catch(() => "");
    throw new Error(`Image upload failed (${uploadResponse.status}): ${text.slice(0, 200)}`);
  }

  return {
    resourceUrl: target.resourceUrl,
    filename,
    alt: "",
  };
}

async function createProduct(storeDomain, accessToken, product) {
  const tags = Array.isArray(product.tags) ? product.tags : [];
  const productOptions = buildProductOptions(product.variants || []);
  const data = await shopifyGraphql(
    storeDomain,
    accessToken,
    `mutation ProductCreate($product: ProductCreateInput!) {
      productCreate(product: $product) {
        product { id handle title }
        userErrors { field message }
      }
    }`,
    {
      product: {
        title: product.title,
        handle: product.handle,
        descriptionHtml: product.descriptionHtml || "",
        vendor: product.vendor || "",
        productType: product.productType || "",
        tags,
        status: "ACTIVE",
        seo: {
          title: product.seoTitle || "",
          description: product.seoDescription || "",
        },
        productOptions,
      },
    }
  );
  const result = data.productCreate;
  if (result.userErrors?.length) {
    throw new Error(result.userErrors.map((e) => e.message).join("; "));
  }
  if (!result.product?.id) {
    throw new Error("Product create returned no product id.");
  }
  return result.product;
}

async function createVariants(storeDomain, accessToken, productId, variants, locationId) {
  const bulkVariants = variants.map((variant) => ({
    price: String(variant.price ?? ""),
    compareAtPrice: variant.compareAtPrice != null ? String(variant.compareAtPrice) : null,
    optionValues: [
      { optionName: "Size", name: variant.size },
      { optionName: "Material", name: variant.material },
      { optionName: "Frame", name: variant.exportFrame },
    ].filter((row) => row.name),
    inventoryItem: { sku: variant.sku, tracked: true },
    inventoryQuantities: [
      {
        availableQuantity: Number(variant.inventoryQty) || 0,
        locationId,
      },
    ],
    taxable: variant.taxable !== false,
    requiresShipping: variant.requiresShipping !== false,
  }));

  const data = await shopifyGraphql(
    storeDomain,
    accessToken,
    `mutation ProductVariantsBulkCreate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkCreate(productId: $productId, strategy: REMOVE_STANDALONE_VARIANT, variants: $variants) {
        productVariants { id sku }
        userErrors { field message }
      }
    }`,
    { productId, variants: bulkVariants }
  );
  const result = data.productVariantsBulkCreate;
  if (result.userErrors?.length) {
    throw new Error(result.userErrors.map((e) => e.message).join("; "));
  }
  return result.productVariants || [];
}

async function attachMedia(storeDomain, accessToken, productId, uploads) {
  if (!uploads.length) {
    return [];
  }
  const media = uploads.map((upload) => ({
    originalSource: upload.resourceUrl,
    alt: upload.alt || "",
    mediaContentType: "IMAGE",
  }));
  const data = await shopifyGraphql(
    storeDomain,
    accessToken,
    `mutation ProductCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
      productCreateMedia(productId: $productId, media: $media) {
        media { id }
        mediaUserErrors { field message }
        userErrors { field message }
      }
    }`,
    { productId, media }
  );
  const result = data.productCreateMedia;
  const errors = [...(result.userErrors || []), ...(result.mediaUserErrors || [])];
  if (errors.length) {
    throw new Error(errors.map((e) => e.message).join("; "));
  }
  return result.media || [];
}

async function setMetafields(storeDomain, accessToken, productId, metafields) {
  if (!metafields.length) {
    return;
  }
  const data = await shopifyGraphql(
    storeDomain,
    accessToken,
    `mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id }
        userErrors { field message }
      }
    }`,
    {
      metafields: metafields.map((mf) => ({
        ownerId: productId,
        namespace: mf.namespace,
        key: mf.key,
        type: mf.type,
        value: mf.value,
      })),
    }
  );
  const result = data.metafieldsSet;
  if (result.userErrors?.length) {
    throw new Error(result.userErrors.map((e) => e.message).join("; "));
  }
}

function validateProductForPush(product) {
  if (product.status !== "enriched") {
    return "Product is not enriched.";
  }
  if (!product.variants?.length) {
    return "Product has no variants.";
  }
  if (!product.handle) {
    return "Product handle is missing.";
  }
  if (!product.title) {
    return "Product title is missing.";
  }
  const images = catalogProductImages(product);
  if (!images.length) {
    return "Product has no images.";
  }
  for (const img of images) {
    if (!img.path || !fs.existsSync(img.path)) {
      return `Image file missing: ${img.path || "(unknown)"}`;
    }
  }
  return null;
}

function buildPreviewPlan(product, handleExists) {
  const images = catalogProductImages(product);
  const firstImage = images[0];
  const firstFilename = firstImage?.filename || path.basename(firstImage?.path || "");
  const validationError = validateProductForPush(product);
  const seoWarning =
    product.seoStatus !== "fixed"
      ? "SEO fixes not applied yet — consider running Fix SEO first."
      : null;

  let status = "ready";
  let error = null;
  if (validationError) {
    status = "error";
    error = validationError;
  } else if (handleExists) {
    status = "error";
    error = `Handle "${product.handle}" already exists on Shopify.`;
  }

  return {
    changeId: `shopify|${product.productId}`,
    resourceType: "catalog-product",
    resourceId: product.productId,
    resourceTitle: product.title,
    field: "Create product",
    current: "—",
    proposed: product.handle,
    displayCurrent: "Not on Shopify",
    displayProposed: `${product.title} · ${product.variants.length} variants · ${images.length} images`,
    mutation: "catalogShopifyCreate",
    catalogInput: { productId: product.productId },
    previewMeta: {
      handle: product.handle,
      variantCount: product.variants.length,
      imageCount: images.length,
      seoTitle: product.seoTitle || "",
      firstImageFilename: firstFilename,
      seoWarning,
      status,
      error,
    },
    compliance: null,
    skip: status === "error",
    error,
  };
}

async function buildPreviewPlans(productIds) {
  const credentials = getShopifyCredentials();
  if (!credentials.storeDomain || !credentials.accessToken) {
    throw new Error("Shopify is not connected. Configure store credentials in Settings.");
  }

  const store = loadCatalogStore();
  const plans = [];
  for (const productId of productIds) {
    const product = getProduct(productId, store);
    if (!product) {
      plans.push({
        changeId: `shopify|${productId}`,
        resourceType: "catalog-product",
        resourceId: productId,
        resourceTitle: productId,
        field: "Create product",
        current: "—",
        proposed: "—",
        mutation: "catalogShopifyCreate",
        catalogInput: { productId },
        previewMeta: { status: "error", error: "Product not found." },
        skip: true,
        error: "Product not found.",
      });
      continue;
    }
    let handleExists = false;
    if (product.handle) {
      const existing = await productExistsByHandle(
        credentials.storeDomain,
        credentials.accessToken,
        product.handle
      );
      handleExists = Boolean(existing);
    }
    plans.push(buildPreviewPlan(product, handleExists));
  }
  return plans;
}

async function pushSingleProduct(product, credentials, locationId) {
  const validationError = validateProductForPush(product);
  if (validationError) {
    throw new Error(validationError);
  }
  const existing = await productExistsByHandle(
    credentials.storeDomain,
    credentials.accessToken,
    product.handle
  );
  if (existing) {
    throw new Error(`Handle "${product.handle}" already exists on Shopify.`);
  }

  const images = catalogProductImages(product);
  const uploads = [];
  for (const img of images) {
    const upload = await stagedUploadFile(
      credentials.storeDomain,
      credentials.accessToken,
      img.path
    );
    upload.alt = img.alt || "";
    uploads.push(upload);
  }

  const created = await createProduct(credentials.storeDomain, credentials.accessToken, product);
  await createVariants(
    credentials.storeDomain,
    credentials.accessToken,
    created.id,
    product.variants,
    locationId
  );
  await attachMedia(credentials.storeDomain, credentials.accessToken, created.id, uploads);
  const metafields = buildMetafields(product);
  if (metafields.length) {
    await setMetafields(credentials.storeDomain, credentials.accessToken, created.id, metafields);
  }

  return {
    shopifyProductId: created.id,
    shopifyHandle: created.handle,
  };
}

async function runPushJob(productIds) {
  const credentials = getShopifyCredentials();
  if (!credentials.storeDomain || !credentials.accessToken) {
    throw new Error("Shopify is not connected.");
  }
  const locationId = await getPrimaryLocationId(credentials.storeDomain, credentials.accessToken);
  const store = loadCatalogStore();
  const total = productIds.length;
  let done = 0;
  const errors = [];
  const succeeded = [];

  pushJob = {
    status: "running",
    total,
    done: 0,
    errors: [],
    startedAt: new Date().toISOString(),
  };

  const queue = [...productIds];
  const workers = Array.from({ length: Math.min(PUSH_CONCURRENCY, queue.length) }, async () => {
    while (queue.length) {
      const productId = queue.shift();
      const product = getProduct(productId, store);
      if (!product) {
        errors.push({ productId, message: "Product not found." });
        done += 1;
        pushJob.done = done;
        continue;
      }
      try {
        const result = await pushSingleProduct(product, credentials, locationId);
        const now = new Date().toISOString();
        store.products[productId] = {
          ...store.products[productId],
          shopifyProductId: result.shopifyProductId,
          shopifyStatus: "created",
          shopifySyncedAt: now,
          shopifyError: null,
        };
        succeeded.push({ productId, ...result });
      } catch (error) {
        const message = error.message || "Push failed.";
        store.products[productId] = {
          ...store.products[productId],
          shopifyStatus: "error",
          shopifyError: message,
        };
        errors.push({ productId, resourceTitle: product.title, message });
      }
      done += 1;
      pushJob.done = done;
      pushJob.errors = errors;
    }
  });

  await Promise.all(workers);
  saveCatalogStore(store);
  pushJob = {
    status: "done",
    total,
    done,
    errors,
    succeeded,
    finishedAt: new Date().toISOString(),
  };
  return pushJob;
}

function getPushStatus() {
  return pushJob || { status: "idle", total: 0, done: 0, errors: [] };
}

async function pushProducts(productIds) {
  if (pushJob?.status === "running") {
    throw new Error("A Shopify push is already running.");
  }
  return runPushJob(productIds);
}

module.exports = {
  buildPreviewPlans,
  pushProducts,
  getPushStatus,
  validateProductForPush,
};
