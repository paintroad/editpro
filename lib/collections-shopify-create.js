const fs = require("fs");
const { shopifyGraphql } = require("./shopify-client");
const { getShopifyCredentials, loadConfig } = require("./config-store");
const { getProduct, loadCatalogStore, getPortraitImage } = require("./catalog-products-store");
const { getCachedScan } = require("./collections-store");
const { scanCollectionRoot } = require("./collections-scanner");
const { slugify } = require("./catalog-text-utils");
const { collectProductsForCollections } = require("./collections-shopify-tags");
const {
  ensureLiveCollectionsIndex,
  resolveLiveCollectionForFolder,
  findCollectionByHandle,
  findOrFetchCollectionByHandle,
  rememberLiveCollection,
  getExampleCollectionDescriptions,
  syncShopifyCollectionsIndex,
  buildLiveStatusMap,
} = require("./shopify-live-collections-index");
const {
  buildCollectionSeoAndImageFields,
  stripHtml,
  filenameFromUrl,
  resolveRoomForPortrait,
  pickRandom,
} = require("./collection-rules-apply");
const { generateCollectionDescription } = require("./collection-description-generator");
const { stagedUploadFile } = require("./shopify-staged-upload");

function getProductIdsForCollection(scan, collectionName) {
  const productMap = collectProductsForCollections(scan, [collectionName]);
  return [...productMap.keys()];
}

function isPortraitOrientation(product) {
  const orientation = String(product?.orientation || "").toLowerCase().trim();
  return orientation === "portrait" || orientation === "vertical";
}

function resolvePortraitProductForCollection({ scan, collectionName, catalogStore }) {
  const productIds = getProductIdsForCollection(scan, collectionName);
  let fallback = null;

  for (const productId of productIds) {
    const product = getProduct(productId, catalogStore);
    if (!product) {
      continue;
    }
    const portrait = getPortraitImage(product);
    if (!portrait?.path || !fs.existsSync(portrait.path)) {
      continue;
    }

    const candidate = {
      productId: String(productId),
      localImagePath: portrait.path,
      productHandle: product.shopifyHandle || product.handle || "",
      shopifyProductId: product.shopifyProductId || "",
      orientation: product.orientation || "",
      usedFallback: !isPortraitOrientation(product),
      source: "catalog-portrait",
    };

    if (isPortraitOrientation(product)) {
      return candidate;
    }
    if (!fallback) {
      fallback = candidate;
    }
  }

  return fallback;
}

function buildCollectionRuleSet(collectionName) {
  return {
    appliedDisjunctively: false,
    rules: [
      {
        column: "TAG",
        relation: "EQUALS",
        condition: collectionName,
      },
    ],
  };
}

function collectUsedHandles(collections = []) {
  const handles = new Set();
  for (const collection of collections) {
    if (collection.handle) {
      handles.add(String(collection.handle).toLowerCase());
    }
  }
  return handles;
}

function buildUniqueHandle(collectionName, usedHandles, preferredHandle = "") {
  const base = slugify(preferredHandle || collectionName) || "collection";
  if (!usedHandles.has(base.toLowerCase())) {
    return base;
  }
  for (let index = 2; index < 100; index += 1) {
    const candidate = `${base}-${index}`;
    if (!usedHandles.has(candidate.toLowerCase())) {
      return candidate;
    }
  }
  return `${base}-${Date.now()}`;
}

function normalizeText(value) {
  return stripHtml(value || "").replace(/\s+/g, " ").trim();
}

function planDiffersFromLive(plan, live) {
  if (!live) {
    return true;
  }

  const liveDesc = normalizeText(live.descriptionHtml || "");
  const planDesc = normalizeText(plan.descriptionHtml || "");
  const liveSeoTitle = String(live.seo?.title || "").trim();
  const liveSeoDesc = String(live.seo?.description || "").trim();
  const liveAlt = String(live.image?.alt || "").trim();
  const liveFilename = filenameFromUrl(live.image?.url || "").toLowerCase();
  const planFilename = String(plan.imageFilename || "").trim().toLowerCase();

  return (
    planDesc !== liveDesc ||
    String(plan.seoTitle || "").trim() !== liveSeoTitle ||
    String(plan.seoDescription || "").trim() !== liveSeoDesc ||
    String(plan.imageAlt || "").trim() !== liveAlt ||
    planFilename !== liveFilename
  );
}

function isHandleTakenError(message) {
  const text = String(message || "").toLowerCase();
  return text.includes("handle") && (text.includes("taken") || text.includes("already"));
}

function reclassifyPlanForExistingHandle(plan, existing) {
  if (!plan || plan.status !== "ready-create" || !existing?.id) {
    return plan;
  }
  const updated = {
    ...plan,
    status: "ready-update",
    handle: existing.handle || plan.handle,
    shopifyCollectionId: existing.id,
    live: {
      id: existing.id,
      handle: existing.handle || "",
      title: existing.title || "",
    },
  };
  if (!planDiffersFromLive(updated, existing)) {
    updated.status = "skip";
    updated.reason = "Already up to date.";
  }
  return updated;
}

async function resolvePlanForExistingHandle(plan, liveCollections, storeDomain, accessToken) {
  if (!plan || plan.status !== "ready-create" || !plan.handle) {
    return plan;
  }
  const existing = await findOrFetchCollectionByHandle(
    plan.handle,
    liveCollections,
    storeDomain,
    accessToken
  );
  return reclassifyPlanForExistingHandle(plan, existing);
}

function buildReadyPlan({
  collectionName,
  handle,
  descriptionPlain,
  descriptionHtml,
  localImagePath,
  imageSource,
  config,
  status,
  liveCollection = null,
}) {
  const rules = config.rules?.collection || {};
  const room = resolveRoomForPortrait({
    productId: imageSource?.productId,
    productHandle: imageSource?.productHandle,
    shopifyProductId: imageSource?.shopifyProductId,
  });
  const randomDescription = pickRandom(config.descriptionPhrases || []);

  const draftCollection = {
    title: collectionName,
    handle,
    descriptionHtml,
    localImagePath,
  };
  const seoFields = buildCollectionSeoAndImageFields({
    collection: draftCollection,
    rules,
    shopName: config.shopName || "",
    localImagePath,
    room,
    randomDescription,
  });

  const plan = {
    collectionName,
    status,
    title: collectionName,
    handle,
    descriptionPlain,
    descriptionHtml,
    seoTitle: seoFields.seoTitle,
    seoDescription: seoFields.seoDescription,
    imageFilename: seoFields.imageFilename,
    imageAlt: seoFields.imageAlt,
    localImagePath,
    imageSource,
    ruleSet: buildCollectionRuleSet(collectionName),
  };

  if (liveCollection) {
    plan.shopifyCollectionId = liveCollection.id;
    plan.live = {
      id: liveCollection.id,
      handle: liveCollection.handle || "",
      title: liveCollection.title || "",
    };
    if (!planDiffersFromLive(plan, liveCollection)) {
      plan.status = "skip";
      plan.reason = "Already up to date.";
    }
  }

  return plan;
}

async function generateCollectionPlan({
  collectionName,
  scan,
  liveCollections,
  usedHandles,
  examples,
  catalogStore,
  config,
}) {
  const liveMatch = resolveLiveCollectionForFolder(collectionName, liveCollections);
  const imageSource = resolvePortraitProductForCollection({
    scan,
    collectionName,
    catalogStore,
  });

  if (!imageSource) {
    return {
      collectionName,
      status: "blocked",
      reason: "No catalog reference image found in this collection.",
    };
  }

  let description;
  try {
    description = await generateCollectionDescription({
      collectionName,
      imagePath: imageSource.localImagePath,
      examples,
    });
  } catch (error) {
    return {
      collectionName,
      status: "blocked",
      reason: error.message || "Failed to generate collection description.",
    };
  }

  const handle = liveMatch?.handle
    ? liveMatch.handle
    : buildUniqueHandle(collectionName, usedHandles);
  if (!liveMatch) {
    usedHandles.add(handle.toLowerCase());
  }

  const initialStatus = liveMatch ? "ready-update" : "ready-create";

  const plan = buildReadyPlan({
    collectionName,
    handle,
    descriptionPlain: description.descriptionPlain,
    descriptionHtml: description.descriptionHtml,
    localImagePath: imageSource.localImagePath,
    imageSource,
    config,
    status: initialStatus,
    liveCollection: liveMatch || null,
  });

  const existingByHandle = !liveMatch ? findCollectionByHandle(handle, liveCollections) : null;
  return reclassifyPlanForExistingHandle(plan, existingByHandle || liveMatch);
}

async function buildCollectionPlans({ rootPath, collections, refreshLiveIndex = false }) {
  const credentials = getShopifyCredentials();
  if (!credentials.storeDomain || !credentials.accessToken) {
    throw new Error("Shopify is not connected.");
  }

  const collectionNames = Array.isArray(collections)
    ? collections.map((name) => String(name).trim()).filter(Boolean)
    : [];
  if (!collectionNames.length) {
    throw new Error("Select at least one collection.");
  }
  if (!rootPath || typeof rootPath !== "string") {
    throw new Error("Folder path is required.");
  }

  let scan = getCachedScan(rootPath);
  if (!scan) {
    scan = scanCollectionRoot(rootPath);
  }

  const liveStore = await ensureLiveCollectionsIndex({ refresh: refreshLiveIndex });
  const liveCollections = liveStore.collections || [];
  const usedHandles = collectUsedHandles(liveCollections);
  const examples = getExampleCollectionDescriptions(liveCollections, 5);
  const config = loadConfig();
  const catalogStore = loadCatalogStore();

  const plans = [];
  for (const collectionName of collectionNames) {
    const plan = await generateCollectionPlan({
      collectionName,
      scan,
      liveCollections,
      usedHandles,
      examples,
      catalogStore,
      config,
    });
    plans.push(plan);
  }

  const create = plans.filter((plan) => plan.status === "ready-create").length;
  const update = plans.filter((plan) => plan.status === "ready-update").length;
  const skip = plans.filter((plan) => plan.status === "skip").length;
  const blocked = plans.filter((plan) => plan.status === "blocked").length;
  const actionable = create + update;

  return {
    collections: collectionNames,
    summary: {
      create,
      update,
      skip,
      blocked,
      ready: actionable,
      actionable,
    },
    plans,
    liveCollections,
  };
}

function toPreviewPlan(plan) {
  return {
    collectionName: plan.collectionName,
    status: plan.status,
    reason: plan.reason,
    title: plan.title,
    handle: plan.handle,
    descriptionPlain: plan.descriptionPlain,
    seoTitle: plan.seoTitle,
    seoDescription: plan.seoDescription,
    imageAlt: plan.imageAlt,
    imageFilename: plan.imageFilename,
    imageSource: plan.imageSource
      ? {
          productId: plan.imageSource.productId,
          usedFallback: plan.imageSource.usedFallback,
          source: plan.imageSource.source,
        }
      : undefined,
  };
}

async function previewCollectionCreates({ rootPath, collections }) {
  const result = await buildCollectionPlans({ rootPath, collections, refreshLiveIndex: true });
  return {
    ...result,
    plans: result.plans.map(toPreviewPlan),
  };
}

async function createShopifyCollection(storeDomain, accessToken, plan) {
  const mutation = `mutation CollectionCreate($input: CollectionInput!) {
    collectionCreate(input: $input) {
      collection {
        id
        title
        handle
        image { id url altText }
      }
      userErrors { field message }
    }
  }`;
  const data = await shopifyGraphql(storeDomain, accessToken, mutation, {
    input: {
      title: plan.title,
      handle: plan.handle,
      descriptionHtml: plan.descriptionHtml,
      seo: {
        title: plan.seoTitle,
        description: plan.seoDescription,
      },
      ruleSet: plan.ruleSet,
    },
  });
  const result = data.collectionCreate;
  const errors = result?.userErrors || [];
  if (errors.length) {
    throw new Error(errors.map((error) => error.message).join("; "));
  }
  if (!result?.collection?.id) {
    throw new Error("Collection create returned no collection id.");
  }
  return result.collection;
}

async function updateCollectionFields(storeDomain, accessToken, collectionId, plan) {
  // Never send handle on update — preserve the existing Shopify handle.
  const mutation = `mutation CollectionUpdate($input: CollectionInput!) {
    collectionUpdate(input: $input) {
      collection {
        id
        title
        handle
        image { id url altText }
      }
      userErrors { field message }
    }
  }`;
  const data = await shopifyGraphql(storeDomain, accessToken, mutation, {
    input: {
      id: collectionId,
      descriptionHtml: plan.descriptionHtml,
      seo: {
        title: plan.seoTitle,
        description: plan.seoDescription,
      },
    },
  });
  const result = data.collectionUpdate;
  const errors = result?.userErrors || [];
  if (errors.length) {
    throw new Error(errors.map((error) => error.message).join("; "));
  }
  return result.collection;
}

async function updateCollectionImage(storeDomain, accessToken, collectionId, imageUrl, altText = "") {
  const mutation = `mutation CollectionUpdate($input: CollectionInput!) {
    collectionUpdate(input: $input) {
      collection {
        id
        image { id url altText }
      }
      userErrors { field message }
    }
  }`;
  const data = await shopifyGraphql(storeDomain, accessToken, mutation, {
    input: {
      id: collectionId,
      image: {
        src: imageUrl,
        ...(altText ? { altText } : {}),
      },
    },
  });
  const result = data.collectionUpdate;
  const errors = result?.userErrors || [];
  if (errors.length) {
    throw new Error(errors.map((error) => error.message).join("; "));
  }
  return result.collection;
}

async function attachPortraitImageToCollection(storeDomain, accessToken, collectionId, plan) {
  if (!plan.localImagePath || !fs.existsSync(plan.localImagePath)) {
    throw new Error("Portrait image file is missing.");
  }
  const upload = await stagedUploadFile(storeDomain, accessToken, plan.localImagePath);
  return updateCollectionImage(
    storeDomain,
    accessToken,
    collectionId,
    upload.resourceUrl,
    plan.imageAlt || ""
  );
}

async function createSingleCollectionOnShopify(storeDomain, accessToken, plan, liveCollections = []) {
  const resolvedPlan = await resolvePlanForExistingHandle(
    plan,
    liveCollections,
    storeDomain,
    accessToken
  );
  if (resolvedPlan.status === "ready-update") {
    return updateSingleCollectionOnShopify(storeDomain, accessToken, resolvedPlan);
  }

  try {
    const created = await createShopifyCollection(storeDomain, accessToken, resolvedPlan);
    await attachPortraitImageToCollection(storeDomain, accessToken, created.id, resolvedPlan);
    rememberLiveCollection(
      {
        id: created.id,
        handle: created.handle || resolvedPlan.handle,
        title: created.title || resolvedPlan.title,
      },
      liveCollections
    );
    return {
      id: created.id,
      handle: created.handle || resolvedPlan.handle,
      title: created.title || resolvedPlan.title,
      action: "create",
    };
  } catch (error) {
    if (!isHandleTakenError(error.message)) {
      throw error;
    }
    const existing = await findOrFetchCollectionByHandle(
      resolvedPlan.handle,
      liveCollections,
      storeDomain,
      accessToken
    );
    if (!existing?.id) {
      throw error;
    }
    const updatePlan = reclassifyPlanForExistingHandle(
      {
        ...resolvedPlan,
        status: "ready-create",
      },
      existing
    );
    return updateSingleCollectionOnShopify(storeDomain, accessToken, updatePlan);
  }
}

async function updateSingleCollectionOnShopify(storeDomain, accessToken, plan) {
  const collectionId = plan.shopifyCollectionId || plan.live?.id;
  if (!collectionId) {
    throw new Error("Missing Shopify collection id for update.");
  }
  await updateCollectionFields(storeDomain, accessToken, collectionId, plan);
  await attachPortraitImageToCollection(storeDomain, accessToken, collectionId, plan);
  return {
    id: collectionId,
    handle: plan.live?.handle || plan.handle,
    title: plan.title,
    action: "update",
  };
}

async function createCollectionsOnShopify({ rootPath, collections }) {
  const preview = await buildCollectionPlans({ rootPath, collections, refreshLiveIndex: true });
  const credentials = getShopifyCredentials();
  const liveCollections = preview.liveCollections || [];
  const errors = [];
  const results = [];
  let created = 0;
  let updated = 0;
  let skipped = 0;
  const syncedCollections = [];

  for (const plan of preview.plans) {
    let syncPlan = await resolvePlanForExistingHandle(
      plan,
      liveCollections,
      credentials.storeDomain,
      credentials.accessToken
    );

    if (syncPlan.status === "skip") {
      skipped += 1;
      results.push({
        collectionName: syncPlan.collectionName,
        status: "skipped",
        message: syncPlan.reason || "Already up to date.",
      });
      continue;
    }
    if (syncPlan.status !== "ready-create" && syncPlan.status !== "ready-update") {
      skipped += 1;
      const message = syncPlan.reason || "Collection is not ready to sync.";
      errors.push({
        collectionName: syncPlan.collectionName,
        message,
      });
      results.push({
        collectionName: syncPlan.collectionName,
        status: "error",
        message,
      });
      continue;
    }

    try {
      let result;
      if (syncPlan.status === "ready-create") {
        result = await createSingleCollectionOnShopify(
          credentials.storeDomain,
          credentials.accessToken,
          syncPlan,
          liveCollections
        );
        if (result.action === "update") {
          updated += 1;
          results.push({
            collectionName: syncPlan.collectionName,
            status: "updated",
            message: "Updated existing collection (handle already on Shopify).",
          });
        } else {
          created += 1;
          results.push({
            collectionName: syncPlan.collectionName,
            status: "created",
          });
        }
      } else {
        result = await updateSingleCollectionOnShopify(
          credentials.storeDomain,
          credentials.accessToken,
          syncPlan
        );
        updated += 1;
        rememberLiveCollection(
          {
            id: result.id,
            handle: result.handle,
            title: result.title,
          },
          liveCollections
        );
        results.push({
          collectionName: syncPlan.collectionName,
          status: "updated",
        });
      }
      syncedCollections.push(result);
    } catch (error) {
      skipped += 1;
      const message = error.message || "Failed to sync collection.";
      errors.push({
        collectionName: plan.collectionName,
        message,
      });
      results.push({
        collectionName: plan.collectionName,
        status: "error",
        message,
      });
    }
  }

  if (created > 0 || updated > 0) {
    await syncShopifyCollectionsIndex();
  }

  return {
    collections: preview.collections,
    created,
    updated,
    skipped,
    errors,
    results,
    summary: preview.summary,
    syncedCollections,
    createdCollections: syncedCollections,
  };
}

async function getCollectionsLiveStatus(rootPath) {
  if (!rootPath || typeof rootPath !== "string") {
    throw new Error("Folder path is required.");
  }

  const scan = getCachedScan(rootPath);
  const liveStore = await ensureLiveCollectionsIndex({ refresh: true });
  const collectionNames = scan?.tagOptions || [];
  const live = buildLiveStatusMap(collectionNames, liveStore.collections || []);

  return {
    syncedAt: liveStore.syncedAt,
    storeDomain: liveStore.storeDomain,
    live,
  };
}

module.exports = {
  previewCollectionCreates,
  createCollectionsOnShopify,
  getCollectionsLiveStatus,
  resolvePortraitProductForCollection,
  planDiffersFromLive,
};
