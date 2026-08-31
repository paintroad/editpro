const { shopifyGraphql } = require("../shopify-client");
const { fetchShopContext } = require("./shopify-export-fetcher");

const PAGE_SIZE = 250;
const STOREFRONT_PAGE_SIZE = 250;
const HYDRATE_BATCH_SIZE = 50;

const PRODUCT_FIELDS = `
  id
  title
  handle
  status
  descriptionHtml
  tags
  productType
  vendor
  seo { title description }
  media(first: 10) {
    nodes {
      ... on MediaImage {
        id
        alt
        image { url }
      }
    }
  }
  variants(first: 100) {
    nodes {
      id
      sku
      barcode
      price
      compareAtPrice
      inventoryQuantity
      selectedOptions { name value }
      inventoryItem { measurement { weight { value unit } } }
    }
  }
`;

const COLLECTIONS_LIST_QUERY = `query Collections($cursor: String) {
  collections(first: ${PAGE_SIZE}, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      handle
      title
      productsCount { count }
    }
  }
}`;

const COLLECTION_PRODUCTS_QUERY = `query CollectionProducts($handle: String!, $cursor: String) {
  collectionByHandle(handle: $handle) {
    id
    handle
    title
    products(first: ${PAGE_SIZE}, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        ${PRODUCT_FIELDS}
      }
    }
  }
}`;

const NODES_PRODUCTS_QUERY = `query NodesProducts($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on Product {
      ${PRODUCT_FIELDS}
    }
  }
}`;

function normalizeHost(hostOrUrl) {
  return String(hostOrUrl || "")
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "")
    .trim();
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "EditProMarketplace/1.0",
    },
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  return { ok: response.ok, status: response.status, payload };
}

async function listAdminCollections(storeDomain, accessToken) {
  const collections = [];
  let cursor = null;
  let hasNext = true;

  while (hasNext) {
    const data = await shopifyGraphql(storeDomain, accessToken, COLLECTIONS_LIST_QUERY, {
      cursor,
    });
    const page = data.collections;
    for (const node of page.nodes || []) {
      collections.push({
        id: node.id,
        handle: node.handle,
        title: node.title,
        productsCount: node.productsCount?.count ?? 0,
        source: "admin",
      });
    }
    hasNext = page.pageInfo?.hasNextPage;
    cursor = page.pageInfo?.endCursor;
  }

  return collections;
}

async function listStorefrontCollections(primaryDomainHost) {
  const host = normalizeHost(primaryDomainHost);
  if (!host) {
    return [];
  }

  const collections = [];
  let page = 1;

  while (page <= 50) {
    const url = `https://${host}/collections.json?limit=${STOREFRONT_PAGE_SIZE}&page=${page}`;
    const { ok, status, payload } = await fetchJson(url);
    if (!ok || !payload) {
      if (page === 1) {
        throw new Error(`Storefront collections.json failed (${status || "network"}).`);
      }
      break;
    }
    const nodes = payload.collections || [];
    if (!nodes.length) {
      break;
    }
    for (const node of nodes) {
      const handle = String(node.handle || "").trim();
      if (!handle) {
        continue;
      }
      collections.push({
        id: node.id != null ? `gid://shopify/Collection/${node.id}` : "",
        handle,
        title: node.title || handle,
        productsCount: Number(node.products_count || 0),
        source: "storefront",
      });
    }
    if (nodes.length < STOREFRONT_PAGE_SIZE) {
      break;
    }
    page += 1;
  }

  return collections;
}

function mergeCollectionsByHandle(adminCollections, storefrontCollections) {
  const byHandle = new Map();

  for (const entry of adminCollections) {
    const handle = String(entry.handle || "").trim();
    if (!handle) {
      continue;
    }
    byHandle.set(handle, { ...entry, handle, source: "admin" });
  }

  for (const entry of storefrontCollections) {
    const handle = String(entry.handle || "").trim();
    if (!handle) {
      continue;
    }
    const existing = byHandle.get(handle);
    if (!existing) {
      byHandle.set(handle, { ...entry, handle, source: "storefront" });
      continue;
    }
    const adminCount = Number(existing.productsCount || 0);
    const storefrontCount = Number(entry.productsCount || 0);
    byHandle.set(handle, {
      ...existing,
      title: entry.title || existing.title,
      productsCount: Math.max(adminCount, storefrontCount),
      id: existing.id || entry.id,
      source: "admin",
    });
  }

  return [...byHandle.values()].sort((a, b) =>
    String(a.title || "").localeCompare(String(b.title || ""))
  );
}

async function listCollectionsForExport(storeDomain, accessToken) {
  const ctx = await fetchShopContext(storeDomain, accessToken);
  const host = ctx.primaryDomainHost || storeDomain;
  const adminCollections = await listAdminCollections(storeDomain, accessToken);

  let storefrontCollections = [];
  try {
    storefrontCollections = await listStorefrontCollections(host);
  } catch {
    storefrontCollections = [];
  }

  return mergeCollectionsByHandle(adminCollections, storefrontCollections);
}

async function fetchProductsForCollectionHandle(storeDomain, accessToken, handle) {
  const products = [];
  let cursor = null;
  let hasNext = true;
  let collectionMeta = null;

  while (hasNext) {
    const data = await shopifyGraphql(storeDomain, accessToken, COLLECTION_PRODUCTS_QUERY, {
      handle,
      cursor,
    });
    const collection = data.collectionByHandle;
    if (!collection) {
      return { products: [], missing: true, collection: null, via: "admin" };
    }
    if (!collectionMeta) {
      collectionMeta = {
        id: collection.id,
        handle: collection.handle,
        title: collection.title,
        source: "admin",
      };
    }
    products.push(...(collection.products?.nodes || []));
    hasNext = collection.products?.pageInfo?.hasNextPage;
    cursor = collection.products?.pageInfo?.endCursor;
  }

  return { products, missing: false, collection: collectionMeta, via: "admin" };
}

async function listStorefrontCollectionProductIds(primaryDomainHost, handle) {
  const host = normalizeHost(primaryDomainHost);
  if (!host || !handle) {
    return { productIds: [], collection: null, missing: true };
  }

  const metaRes = await fetchJson(`https://${host}/collections/${encodeURIComponent(handle)}.json`);
  if (!metaRes.ok || !metaRes.payload?.collection) {
    return { productIds: [], collection: null, missing: true };
  }

  const meta = metaRes.payload.collection;
  const expected = Number(meta.products_count || 0);
  const productIds = [];
  const seen = new Set();
  let page = 1;

  while (page <= 200) {
    const url = `https://${host}/collections/${encodeURIComponent(handle)}/products.json?limit=${STOREFRONT_PAGE_SIZE}&page=${page}`;
    const { ok, payload } = await fetchJson(url);
    if (!ok || !payload) {
      break;
    }
    const products = payload.products || [];
    if (!products.length) {
      break;
    }
    for (const product of products) {
      const id = product?.id;
      if (id == null || seen.has(id)) {
        continue;
      }
      seen.add(id);
      productIds.push(id);
    }
    if (products.length < STOREFRONT_PAGE_SIZE) {
      break;
    }
    if (expected > 0 && productIds.length >= expected) {
      break;
    }
    page += 1;
  }

  return {
    productIds,
    missing: false,
    collection: {
      id: meta.id != null ? `gid://shopify/Collection/${meta.id}` : "",
      handle: meta.handle || handle,
      title: meta.title || handle,
      productsCount: expected || productIds.length,
      source: "storefront",
    },
  };
}

async function hydrateProductsByIds(storeDomain, accessToken, numericIds) {
  const products = [];
  for (let i = 0; i < numericIds.length; i += HYDRATE_BATCH_SIZE) {
    const chunk = numericIds.slice(i, i + HYDRATE_BATCH_SIZE);
    const ids = chunk.map((id) => `gid://shopify/Product/${id}`);
    const data = await shopifyGraphql(storeDomain, accessToken, NODES_PRODUCTS_QUERY, { ids });
    for (const node of data.nodes || []) {
      if (node?.id) {
        products.push(node);
      }
    }
  }
  return products;
}

async function fetchProductsForCollectionHandleWithFallback(
  storeDomain,
  accessToken,
  handle,
  primaryDomainHost
) {
  const adminResult = await fetchProductsForCollectionHandle(storeDomain, accessToken, handle);
  if (!adminResult.missing) {
    return adminResult;
  }

  const storefront = await listStorefrontCollectionProductIds(primaryDomainHost, handle);
  if (storefront.missing) {
    return { products: [], missing: true, collection: null, via: "storefront" };
  }

  const products = await hydrateProductsByIds(storeDomain, accessToken, storefront.productIds);
  return {
    products,
    missing: false,
    collection: storefront.collection,
    via: "storefront",
  };
}

async function fetchProductsByCollectionHandles(storeDomain, accessToken, collectionHandles = []) {
  const handles = [
    ...new Set(
      (Array.isArray(collectionHandles) ? collectionHandles : [])
        .map((h) => String(h || "").trim())
        .filter(Boolean)
    ),
  ];

  if (!handles.length) {
    throw new Error("Select at least one collection to export.");
  }

  const ctx = await fetchShopContext(storeDomain, accessToken);
  const host = ctx.primaryDomainHost || storeDomain;
  const byId = new Map();
  const warnings = [];
  const loadedCollections = [];

  for (const handle of handles) {
    const { products, missing, collection, via } = await fetchProductsForCollectionHandleWithFallback(
      storeDomain,
      accessToken,
      handle,
      host
    );
    if (missing) {
      warnings.push(`Collection not found: ${handle}`);
      continue;
    }
    if (via === "storefront") {
      warnings.push(
        `Loaded "${collection?.title || handle}" via storefront fallback (${products.length} products).`
      );
    }
    if (collection) {
      loadedCollections.push(collection);
    }
    for (const product of products) {
      const key = product.id || product.handle;
      if (!key || byId.has(key)) {
        continue;
      }
      byId.set(key, product);
    }
  }

  return {
    products: [...byId.values()],
    ctx,
    collectionHandles: handles,
    loadedCollections,
    warnings,
  };
}

module.exports = {
  listCollectionsForExport,
  fetchProductsByCollectionHandles,
  mergeCollectionsByHandle,
  listStorefrontCollections,
};
