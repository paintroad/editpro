const fs = require("fs");
const path = require("path");
const { shopifyGraphql } = require("./shopify-client");
const { getShopifyCredentials } = require("./config-store");
const { loadCatalogStore, getProduct, saveCatalogStore } = require("./catalog-products-store");
const { catalogProductImages } = require("./catalog-seo-fix");
const {
  PRODUCT_DEFAULTS,
  DEFAULT_METAFIELDS,
  PRODUCT_MATERIAL,
  MATERIAL_CANVAS,
  MATERIAL_PAPER,
  frameDisplayLabel,
  normalizeFrame,
  isStretchedFrame,
  isPaperMaterial,
} = require("./catalog-variant-templates");
const {
  METAOBJECT_TYPES,
  createMetaobjectResolver,
} = require("./shopify-metaobject-resolver");
const { stagedUploadFile } = require("./shopify-staged-upload");

const PUSH_CONCURRENCY = 3;
let pushJob = null;
let publicationCache = null;

function weightUnitToShopify(unit) {
  const u = String(unit || "").toLowerCase();
  if (u === "g" || u === "grams") {
    return "GRAMS";
  }
  if (u === "kg" || u === "kilograms") {
    return "KILOGRAMS";
  }
  return "GRAMS";
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

function buildProductTags(product) {
  const tags = new Set(Array.isArray(product.tags) ? product.tags : []);
  if (product.shape) {
    tags.add(String(product.shape).toLowerCase());
  }
  if (product.orientation) {
    tags.add(String(product.orientation).toLowerCase());
  }
  return [...tags];
}

async function resolveLinkedMaps(variants, resolver) {
  const frames = uniqueOptionValues(variants, "exportFrame").map((frame) =>
    frameDisplayLabel(frame)
  );
  const frameIds = await resolver.resolveIds(METAOBJECT_TYPES.frameStyle, frames);

  const frameByLabel = new Map();
  for (const label of frames) {
    const id = await resolver.resolveId(METAOBJECT_TYPES.frameStyle, label);
    if (id) {
      frameByLabel.set(label, id);
      frameByLabel.set(normalizeFrame(label), id);
    }
  }

  if (frameIds.length !== frames.length) {
    throw new Error(
      `Could not resolve all Frame style metaobjects (${frameIds.length}/${frames.length}).`
    );
  }

  const paperId = await resolver.resolveId(METAOBJECT_TYPES.material, MATERIAL_PAPER);
  const canvasId = await resolver.resolveId(METAOBJECT_TYPES.material, MATERIAL_CANVAS);
  if (!paperId || !canvasId) {
    throw new Error("Could not resolve Canvas / Fine Art Paper material metaobjects.");
  }
  const materialByLabel = new Map([
    [MATERIAL_PAPER, paperId],
    [MATERIAL_CANVAS, canvasId],
  ]);

  return {
    frames,
    frameIds,
    frameByLabel,
    materialIds: [paperId, canvasId],
    materialByLabel,
  };
}

const SIZE_RANK = ["XS", "S", "M", "L", "XL"];

function orderedSizes(variants) {
  const sizes = uniqueOptionValues(variants, "size");
  return sizes.sort((a, b) => {
    const rank = (label) => {
      const index = SIZE_RANK.findIndex((code) => String(label).startsWith(`${code} `));
      return index < 0 ? 99 : index;
    };
    return rank(a) - rank(b);
  });
}

function buildSizeOnlyProductOptions(variants) {
  const sizes = orderedSizes(variants);
  if (!sizes.length) {
    return [];
  }
  return [{ name: "Size", values: sizes.map((name) => ({ name })) }];
}

function buildLinkedOptionCreateInputs(linked) {
  // GIDs must live on linkedMetafield.values — not option.values.linkedMetafieldValue
  // (that combo triggers DUPLICATED_OPTION_VALUE / CANNOT_COMBINE on 2025-01).
  return [
    {
      name: "Frame",
      linkedMetafield: {
        namespace: "shopify",
        key: "frame-style",
        values: linked.frameIds,
      },
    },
  ];
}

function buildPlainProductOptions(variants) {
  const sizes = uniqueOptionValues(variants, "size");
  const frames = uniqueOptionValues(variants, "exportFrame").map((frame) =>
    frameDisplayLabel(frame)
  );
  const options = [];
  if (sizes.length) {
    options.push({ name: "Size", values: sizes.map((name) => ({ name })) });
  }
  if (frames.length) {
    options.push({ name: "Frame", values: frames.map((name) => ({ name })) });
  }
  return options;
}

async function buildMetafields(product, resolver) {
  const mf = product.metafields || {};
  const entries = [];
  const searchBoosts = String(mf.searchProductBoosts || "").trim();

  const colorLabels = [
    ...(Array.isArray(mf.color) ? mf.color : []),
    ...(Array.isArray(product.colors) ? product.colors : []),
  ];
  const themeLabels = Array.isArray(mf.theme) ? mf.theme : [];
  const artworkLabels = Array.isArray(mf.artworkFrameMaterial)
    ? mf.artworkFrameMaterial
    : DEFAULT_METAFIELDS.artworkFrameMaterial;
  const frameLabels = Array.isArray(mf.frameStyle)
    ? mf.frameStyle.map((value) => frameDisplayLabel(value))
    : DEFAULT_METAFIELDS.frameStyle;

  const colorIds = await resolver.resolveIds(METAOBJECT_TYPES.colorPattern, colorLabels);
  const themeIds = await resolver.resolveIds(METAOBJECT_TYPES.theme, themeLabels);
  const artworkIds = await resolver.resolveIds(
    METAOBJECT_TYPES.artworkFrameMaterial,
    artworkLabels
  );
  const frameIds = await resolver.resolveIds(METAOBJECT_TYPES.frameStyle, frameLabels);

  // Category Orientation is shopify.orientation → Vertical / Horizontal / Square.
  const orientationLabels = [];
  const shapeKey = String(product.shape || "")
    .trim()
    .toLowerCase();
  const orientationKey = String(product.orientation || "")
    .trim()
    .toLowerCase();
  if (shapeKey === "square" || orientationKey === "square") {
    orientationLabels.push("Square");
  } else if (orientationKey === "landscape" || orientationKey === "horizontal") {
    orientationLabels.push("Horizontal");
  } else if (orientationKey === "portrait" || orientationKey === "vertical") {
    orientationLabels.push("Vertical");
  }
  const orientationIds = orientationLabels.length
    ? await resolver.resolveIds(METAOBJECT_TYPES.orientation, orientationLabels)
    : [];

  if (colorIds.length) {
    entries.push({
      namespace: "shopify",
      key: "color-pattern",
      type: "list.metaobject_reference",
      value: JSON.stringify(colorIds),
    });
  }
  if (themeIds.length) {
    entries.push({
      namespace: "shopify",
      key: "theme",
      type: "list.metaobject_reference",
      value: JSON.stringify(themeIds),
    });
  }
  if (artworkIds.length) {
    entries.push({
      namespace: "shopify",
      key: "artwork-frame-material",
      type: "list.metaobject_reference",
      value: JSON.stringify(artworkIds),
    });
  }
  if (frameIds.length) {
    entries.push({
      namespace: "shopify",
      key: "frame-style",
      type: "list.metaobject_reference",
      value: JSON.stringify(frameIds),
    });
  }
  // Material is owned by the linked Material option. Setting the metafield separately is rejected.
  if (orientationIds.length) {
    entries.push({
      namespace: "shopify",
      key: "orientation",
      type: "list.metaobject_reference",
      value: JSON.stringify(orientationIds),
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
  if (product.shape) {
    entries.push({
      namespace: "custom",
      key: "shape",
      type: "single_line_text_field",
      value: String(product.shape),
    });
  }
  return entries;
}

async function getWarehouses(storeDomain, accessToken) {
  const data = await shopifyGraphql(
    storeDomain,
    accessToken,
    `query { locations(first: 25, includeInactive: true) { nodes { id name isActive } } }`
  );
  const nodes = data.locations?.nodes || [];
  const findBy = (needles) =>
    nodes.find((node) => {
      const name = String(node.name || "").toLowerCase();
      return needles.some((needle) => name.includes(needle));
    });
  const nariana = findBy(["naraina", "nariana"]);
  const mayapuri = findBy(["mayapuri"]);
  if (!nariana) {
    throw new Error("Nariana warehouse location not found.");
  }
  if (!mayapuri) {
    throw new Error("Mayapuri warehouse location not found.");
  }
  return { nariana, mayapuri };
}

function locationIdForVariant(variant, locations) {
  if (variant.warehouse === "mayapuri" || variant.warehouse === "nariana") {
    return locations[variant.warehouse].id;
  }
  const frameKey = normalizeFrame(variant.frame || variant.exportFrame);
  if (isStretchedFrame(frameKey) && !isPaperMaterial(variant.material)) {
    return locations.mayapuri.id;
  }
  return locations.nariana.id;
}

async function resolvePublicationIds(storeDomain, accessToken, channelNames) {
  if (!publicationCache) {
    const data = await shopifyGraphql(
      storeDomain,
      accessToken,
      `query { publications(first: 50) { nodes { id name } } }`
    );
    publicationCache = {};
    for (const pub of data.publications?.nodes || []) {
      publicationCache[pub.name] = pub.id;
    }
  }
  const names = channelNames?.length ? channelNames : PRODUCT_DEFAULTS.salesChannels;
  const matched = [];
  const missing = [];
  for (const name of names) {
    const id = publicationCache[name];
    if (id) {
      matched.push({ name, id });
    } else {
      missing.push(name);
    }
  }
  if (!matched.length) {
    throw new Error(
      `No matching sales channel publications found on Shopify. Missing: ${names.join(", ")}`
    );
  }
  if (missing.length) {
    console.warn(`[shopify-push] Unresolved sales channels: ${missing.join(", ")}`);
  }
  console.log(`[shopify-push] Publishing to: ${matched.map((row) => row.name).join(", ")}`);
  return matched.map((row) => row.id);
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

async function createProduct(storeDomain, accessToken, product, productOptions) {
  const tags = buildProductTags(product);
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
        vendor: product.vendor || PRODUCT_DEFAULTS.vendor,
        productType: product.productType || PRODUCT_DEFAULTS.productType,
        category: product.productCategoryId || PRODUCT_DEFAULTS.productCategoryId,
        templateSuffix: product.templateSuffix || PRODUCT_DEFAULTS.templateSuffix,
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

async function createLinkedOptions(storeDomain, accessToken, productId, linked) {
  const data = await shopifyGraphql(
    storeDomain,
    accessToken,
    `mutation ProductOptionsCreate($productId: ID!, $options: [OptionCreateInput!]!) {
      productOptionsCreate(productId: $productId, options: $options) {
        product {
          id
          options {
            id
            name
            linkedMetafield { namespace key }
            optionValues { id name linkedMetafieldValue }
          }
        }
        userErrors { field message }
      }
    }`,
    {
      productId,
      options: buildLinkedOptionCreateInputs(linked),
    }
  );
  const result = data.productOptionsCreate;
  if (result.userErrors?.length) {
    throw new Error(result.userErrors.map((e) => e.message).join("; "));
  }
  return result.product;
}

function buildOptionValueIdMaps(options) {
  const sizeByName = new Map();
  const materialByName = new Map();
  const frameByMetaobjectId = new Map();
  const frameByName = new Map();

  for (const option of options || []) {
    const name = String(option.name || "").toLowerCase();
    for (const value of option.optionValues || []) {
      if (name === "size") {
        sizeByName.set(value.name, value.id);
      } else if (name === "material") {
        materialByName.set(value.name, value.id);
      } else if (name === "frame") {
        if (value.linkedMetafieldValue) {
          frameByMetaobjectId.set(value.linkedMetafieldValue, value.id);
        }
        frameByName.set(value.name, value.id);
      }
    }
  }

  return {
    sizeByName,
    materialByName,
    frameByMetaobjectId,
    frameByName,
  };
}

function buildInventoryItemInput(variant) {
  const input = {
    sku: variant.sku,
    tracked: variant.tracked !== false,
    requiresShipping: variant.requiresShipping !== false,
  };
  if (variant.weight != null && variant.weight !== "") {
    input.measurement = {
      weight: {
        value: Number(variant.weight),
        unit: weightUnitToShopify(variant.weightUnit),
      },
    };
  }
  return input;
}

function resolveVariantOptionValues(variant, linked, useLinked, optionValueIds) {
  const sizeValue = { optionName: "Size", name: variant.size };
  const frameLabel = frameDisplayLabel(variant.exportFrame || variant.frame);

  const materialLabel = variant.material || MATERIAL_CANVAS;
  if (!useLinked || !optionValueIds) {
    return [
      { optionName: "Material", name: materialLabel },
      sizeValue,
      { optionName: "Frame", name: frameLabel },
    ].filter((row) => row.name);
  }

  // productVariantsBulkCreate rejects name/linkedMetafieldValue for linked options;
  // pass ProductOptionValue IDs instead.
  const materialId = optionValueIds.materialByName.get(materialLabel);
  const sizeId = optionValueIds.sizeByName.get(variant.size);
  const frameGid =
    linked.frameByLabel.get(frameLabel) || linked.frameByLabel.get(normalizeFrame(frameLabel));
  const frameId =
    (frameGid && optionValueIds.frameByMetaobjectId.get(frameGid)) ||
    optionValueIds.frameByName.get(frameLabel);

  if (!materialId) {
    throw new Error(`Missing Material option value id for "${materialLabel}"`);
  }
  if (!sizeId) {
    throw new Error(`Missing Size option value id for "${variant.size}"`);
  }
  if (!frameId) {
    throw new Error(`Missing Frame option value id for "${frameLabel}"`);
  }

  return [
    { optionName: "Material", id: materialId },
    { optionName: "Size", id: sizeId },
    { optionName: "Frame", id: frameId },
  ];
}

async function createVariants(
  storeDomain,
  accessToken,
  productId,
  variants,
  locations,
  linked,
  useLinked,
  optionValueIds
) {
  const bulkVariants = variants.map((variant) => ({
    price: String(variant.price ?? ""),
    compareAtPrice: variant.compareAtPrice != null ? String(variant.compareAtPrice) : null,
    optionValues: resolveVariantOptionValues(variant, linked, useLinked, optionValueIds),
    inventoryItem: buildInventoryItemInput(variant),
    inventoryQuantities: [
      {
        availableQuantity: Number(variant.inventoryQty) || PRODUCT_DEFAULTS.inventoryQty,
        locationId: locationIdForVariant(variant, locations),
      },
    ],
    inventoryPolicy:
      variant.inventoryPolicy === "deny" || variant.inventoryPolicy === "DENY"
        ? "DENY"
        : "CONTINUE",
    taxable: variant.taxable !== false,
  }));

  const data = await shopifyGraphql(
    storeDomain,
    accessToken,
    `mutation ProductVariantsBulkCreate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkCreate(productId: $productId, strategy: REMOVE_STANDALONE_VARIANT, variants: $variants) {
        productVariants {
          id
          sku
          inventoryItem { id }
        }
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

async function updateInventoryItems(storeDomain, accessToken, variants, createdVariants) {
  const bySku = new Map();
  for (const row of createdVariants || []) {
    if (row.sku && row.inventoryItem?.id) {
      bySku.set(String(row.sku), row.inventoryItem.id);
    }
  }

  for (const variant of variants) {
    const inventoryItemId = bySku.get(variant.sku);
    if (!inventoryItemId) {
      continue;
    }
    const input = {
      tracked: variant.tracked !== false,
      requiresShipping: variant.requiresShipping !== false,
      countryCodeOfOrigin: variant.countryOfOrigin || PRODUCT_DEFAULTS.countryOfOrigin,
    };
    if (variant.cost != null && variant.cost !== "") {
      input.cost = Number(variant.cost);
    }
    if (variant.weight != null && variant.weight !== "") {
      input.measurement = {
        weight: {
          value: Number(variant.weight),
          unit: weightUnitToShopify(variant.weightUnit),
        },
      };
    }

    const data = await shopifyGraphql(
      storeDomain,
      accessToken,
      `mutation InventoryItemUpdate($id: ID!, $input: InventoryItemInput!) {
        inventoryItemUpdate(id: $id, input: $input) {
          inventoryItem { id }
          userErrors { field message }
        }
      }`,
      { id: inventoryItemId, input }
    );
    const result = data.inventoryItemUpdate;
    if (result.userErrors?.length) {
      throw new Error(result.userErrors.map((e) => e.message).join("; "));
    }
  }
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

async function publishProduct(storeDomain, accessToken, productId, salesChannels) {
  const publicationIds = await resolvePublicationIds(storeDomain, accessToken, salesChannels);
  const data = await shopifyGraphql(
    storeDomain,
    accessToken,
    `mutation PublishablePublish($id: ID!, $input: [PublicationInput!]!) {
      publishablePublish(id: $id, input: $input) {
        publishable { availablePublicationsCount { count } }
        userErrors { field message }
      }
    }`,
    {
      id: productId,
      input: publicationIds.map((publicationId) => ({ publicationId })),
    }
  );
  const result = data.publishablePublish;
  if (result.userErrors?.length) {
    throw new Error(result.userErrors.map((e) => e.message).join("; "));
  }
}

function resolvePushImages(product) {
  const all = catalogProductImages(product);
  const existing = [];
  const missing = [];
  for (const img of all) {
    if (img.path && fs.existsSync(img.path)) {
      existing.push(img);
      continue;
    }
    missing.push({
      path: img.path || null,
      filename: img.filename || path.basename(img.path || "") || "(unknown)",
      index: img.index ?? img.lifestyleListIndex,
    });
  }
  return { all, existing, missing };
}

function validateProductForPush(product, resolved) {
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
  const { all, existing } = resolved || resolvePushImages(product);
  if (!all.length) {
    return "Product has no images.";
  }
  if (!existing.length) {
    return "All image files are missing on disk.";
  }
  return null;
}

function buildMissingImagesWarning(missing, existing, all) {
  if (!missing.length) {
    return null;
  }
  const noun = missing.length === 1 ? "image file" : "image files";
  return `${missing.length} ${noun} missing on disk — will upload ${existing.length} of ${all.length}.`;
}

function buildPreviewPlan(product, handleExists) {
  const { all, existing, missing } = resolvePushImages(product);
  const firstImage = existing[0] || all[0];
  const firstFilename = firstImage?.filename || path.basename(firstImage?.path || "");
  const validationError = validateProductForPush(product, { all, existing, missing });
  const seoWarning =
    product.seoStatus !== "fixed"
      ? "SEO fixes not applied yet — consider running Fix SEO first."
      : null;
  const missingImagesWarning = buildMissingImagesWarning(missing, existing, all);

  let status = "ready";
  let error = null;
  if (validationError) {
    status = "error";
    error = validationError;
  } else if (handleExists) {
    status = "error";
    error = `Handle "${product.handle}" already exists on Shopify.`;
  }

  const imageLabel =
    missing.length > 0
      ? `${existing.length} of ${all.length} images`
      : `${existing.length} images`;

  return {
    changeId: `shopify|${product.productId}`,
    resourceType: "catalog-product",
    resourceId: product.productId,
    resourceTitle: product.title,
    field: "Create product",
    current: "—",
    proposed: product.handle,
    displayCurrent: "Not on Shopify",
    displayProposed: `${product.title} · ${product.variants.length} variants · ${imageLabel}`,
    mutation: "catalogShopifyCreate",
    catalogInput: { productId: product.productId },
    previewMeta: {
      handle: product.handle,
      variantCount: product.variants.length,
      imageCount: existing.length,
      imageCountTotal: all.length,
      seoTitle: product.seoTitle || "",
      firstImageFilename: firstFilename,
      seoWarning,
      missingImagesWarning,
      missingImages: missing.map((row) => row.filename),
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

async function createMaterialOption(storeDomain, accessToken, productId, linked) {
  const data = await shopifyGraphql(
    storeDomain,
    accessToken,
    `mutation ProductOptionsCreate($productId: ID!, $options: [OptionCreateInput!]!) {
      productOptionsCreate(productId: $productId, options: $options) {
        product { id }
        userErrors { field message }
      }
    }`,
    {
      productId,
      options: [
        {
          name: "Material",
          position: 1,
          linkedMetafield: {
            namespace: "shopify",
            key: "material",
            values: linked.materialIds,
          },
        },
      ],
    }
  );
  const result = data.productOptionsCreate;
  if (result.userErrors?.length) {
    throw new Error(result.userErrors.map((e) => e.message).join("; "));
  }
  return result.product;
}

async function createProductWithLinkedOptions(storeDomain, accessToken, product, linked) {
  // Size on create, then linked Material and Frame.
  const sizesOnly = buildSizeOnlyProductOptions(product.variants || []);
  const created = await createProduct(storeDomain, accessToken, product, sizesOnly);
  try {
    await createMaterialOption(storeDomain, accessToken, created.id, linked);
    const withOptions = await createLinkedOptions(storeDomain, accessToken, created.id, linked);
    const optionValueIds = buildOptionValueIdMaps(withOptions?.options || []);
    return { created, useLinked: true, optionValueIds };
  } catch (error) {
    const message = String(error.message || error);
    console.warn(
      `[shopify-push] Linked options failed (${message}); falling back to plain Frame text options`
    );
    const plain = buildPlainProductOptions(product.variants || []).filter(
      (opt) => opt.name === "Frame"
    );
    if (!plain.length) {
      throw error;
    }
    const data = await shopifyGraphql(
      storeDomain,
      accessToken,
      `mutation ProductOptionsCreate($productId: ID!, $options: [OptionCreateInput!]!) {
        productOptionsCreate(productId: $productId, options: $options) {
          product { id }
          userErrors { field message }
        }
      }`,
      { productId: created.id, options: plain }
    );
    const result = data.productOptionsCreate;
    if (result.userErrors?.length) {
      throw new Error(
        `${message}; plain fallback also failed: ${result.userErrors.map((e) => e.message).join("; ")}`
      );
    }
    return { created, useLinked: false, optionValueIds: null };
  }
}

async function reorderStorefrontOptions(storeDomain, accessToken, productId, variants) {
  const materials = [MATERIAL_PAPER, MATERIAL_CANVAS].filter((name) =>
    (variants || []).some((variant) => variant.material === name)
  );
  const sizes = orderedSizes(variants || []);
  const frames = uniqueOptionValues(variants || [], "exportFrame").map((frame) =>
    frameDisplayLabel(frame)
  );
  const options = [];
  if (materials.length) {
    options.push({ name: "Material", values: materials.map((name) => ({ name })) });
  }
  if (sizes.length) {
    options.push({ name: "Size", values: sizes.map((name) => ({ name })) });
  }
  if (frames.length) {
    options.push({ name: "Frame", values: frames.map((name) => ({ name })) });
  }
  if (!options.length) {
    return;
  }
  const data = await shopifyGraphql(
    storeDomain,
    accessToken,
    `mutation ProductOptionsReorder($productId: ID!, $options: [OptionReorderInput!]!) {
      productOptionsReorder(productId: $productId, options: $options) {
        userErrors { field message }
      }
    }`,
    { productId, options }
  );
  const errors = data.productOptionsReorder?.userErrors || [];
  if (errors.length) {
    throw new Error(errors.map((error) => error.message).join("; "));
  }
}

async function pushSingleProduct(product, credentials, locations, resolver) {
  const resolved = resolvePushImages(product);
  const validationError = validateProductForPush(product, resolved);
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

  if (resolved.missing.length) {
    console.warn(
      `[shopify-push] Missing image files for ${product.handle}:`,
      resolved.missing.map((row) => row.filename || row.path).slice(0, 8)
    );
  }

  const linked = await resolveLinkedMaps(product.variants || [], resolver);

  const uploads = [];
  for (const img of resolved.existing) {
    const upload = await stagedUploadFile(
      credentials.storeDomain,
      credentials.accessToken,
      img.path
    );
    upload.alt = img.alt || "";
    uploads.push(upload);
  }

  const { created, useLinked, optionValueIds } = await createProductWithLinkedOptions(
    credentials.storeDomain,
    credentials.accessToken,
    product,
    linked
  );
  const createdVariants = await createVariants(
    credentials.storeDomain,
    credentials.accessToken,
    created.id,
    product.variants,
    locations,
    linked,
    useLinked,
    optionValueIds
  );
  await updateInventoryItems(
    credentials.storeDomain,
    credentials.accessToken,
    product.variants,
    createdVariants
  );
  try {
    await reorderStorefrontOptions(
      credentials.storeDomain,
      credentials.accessToken,
      created.id,
      product.variants
    );
  } catch (error) {
    console.warn(
      `[shopify-push] Option order skipped for ${product.handle}: ${error.message || error}`
    );
  }
  await attachMedia(credentials.storeDomain, credentials.accessToken, created.id, uploads);

  try {
    const metafields = await buildMetafields(product, resolver);
    if (metafields.length) {
      try {
        await setMetafields(
          credentials.storeDomain,
          credentials.accessToken,
          created.id,
          metafields
        );
      } catch (error) {
        const withoutCustom = metafields.filter((mf) => mf.namespace !== "custom");
        if (withoutCustom.length && withoutCustom.length !== metafields.length) {
          await setMetafields(
            credentials.storeDomain,
            credentials.accessToken,
            created.id,
            withoutCustom
          );
        } else {
          console.warn(
            `[shopify-push] Metafields skipped for ${product.handle}: ${error.message || error}`
          );
        }
      }
    }
    const warnings = resolver.getWarnings();
    if (warnings.length) {
      console.warn(
        `[shopify-push] Metaobject warnings for ${product.handle}:`,
        warnings.slice(0, 8)
      );
    }
  } catch (error) {
    console.warn(
      `[shopify-push] Metafield build/set failed for ${product.handle}: ${error.message || error}`
    );
  }

  await publishProduct(
    credentials.storeDomain,
    credentials.accessToken,
    created.id,
    product.salesChannels
  );

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
  publicationCache = null;
  const locations = await getWarehouses(credentials.storeDomain, credentials.accessToken);
  const resolver = createMetaobjectResolver(
    shopifyGraphql,
    credentials.storeDomain,
    credentials.accessToken
  );
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
        resolver.clearWarnings();
        const result = await pushSingleProduct(product, credentials, locations, resolver);
        const now = new Date().toISOString();
        store.products[productId] = {
          ...store.products[productId],
          shopifyProductId: result.shopifyProductId,
          shopifyHandle: result.shopifyHandle,
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
