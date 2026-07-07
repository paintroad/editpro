const { shopifyGraphql } = require("../shopify-client");

const PAGE_SIZE = 250;

const SHOP_QUERY = `query {
  shop {
    name
    myshopifyDomain
    currencyCode
    primaryDomain { url host }
  }
}`;

const PRODUCTS_QUERY = `query Products($cursor: String, $query: String) {
  products(first: ${PAGE_SIZE}, after: $cursor, query: $query) {
    pageInfo { hasNextPage endCursor }
    nodes {
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
        }
      }
    }
  }
}`;

function shopifyQueryForFilter(productFilter) {
  switch (String(productFilter || "all").toLowerCase()) {
    case "live":
      return "status:active";
    case "drafts":
      return "status:draft";
    case "all":
    default:
      return null;
  }
}

async function fetchShopContext(storeDomain, accessToken) {
  const data = await shopifyGraphql(storeDomain, accessToken, SHOP_QUERY);
  const shop = data.shop || {};
  return {
    storeDomain: storeDomain || shop.myshopifyDomain || "",
    shopName: shop.name || "",
    currencyCode: shop.currencyCode || "USD",
    myshopifyDomain: shop.myshopifyDomain || "",
    primaryDomainHost: shop.primaryDomain?.host || "",
    primaryDomainUrl: shop.primaryDomain?.url || "",
  };
}

async function fetchProductsForExport(storeDomain, accessToken, { productFilter = "all" } = {}) {
  const ctx = await fetchShopContext(storeDomain, accessToken);
  const query = shopifyQueryForFilter(productFilter);
  const products = [];
  let cursor = null;
  let hasNext = true;

  while (hasNext) {
    const data = await shopifyGraphql(storeDomain, accessToken, PRODUCTS_QUERY, {
      cursor,
      query,
    });
    const page = data.products;
    products.push(...(page.nodes || []));
    hasNext = page.pageInfo?.hasNextPage;
    cursor = page.pageInfo?.endCursor;
  }

  return { products, ctx, productFilter };
}

module.exports = {
  fetchProductsForExport,
  fetchShopContext,
  shopifyQueryForFilter,
};
