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
  // #region agent log
  fetch('http://127.0.0.1:7549/ingest/5d3de01a-a775-4a96-bbdd-c6abcd6ee00a',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'511b6d'},body:JSON.stringify({sessionId:'511b6d',hypothesisId:'link',location:'shopify-export-fetcher.js:69',message:'shop context domains',data:{argStoreDomain:storeDomain||null,myshopifyDomain:shop.myshopifyDomain||null,primaryDomainHost:shop.primaryDomain?.host||null,primaryDomainUrl:shop.primaryDomain?.url||null},timestamp:Date.now()})}).catch(()=>{});
  // #endregion
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

  // #region agent log
  fetch('http://127.0.0.1:7549/ingest/5d3de01a-a775-4a96-bbdd-c6abcd6ee00a',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'511b6d'},body:JSON.stringify({sessionId:'511b6d',hypothesisId:'A/B/C/D',location:'shopify-export-fetcher.js:88',message:'fetched products summary',data:{productFilter,totalProducts:products.length,firstProductTitle:products[0]?.title||null,firstProductMediaCount:(products[0]?.media?.nodes||[]).length,firstProductMediaSample:JSON.stringify((products[0]?.media?.nodes||[]).slice(0,1)),firstProductDescLen:(products[0]?.descriptionHtml||'').length,productsWithMedia:products.filter(p=>(p.media?.nodes||[]).some(n=>n?.image?.url)).length,productsWithDesc:products.filter(p=>(p.descriptionHtml||'').trim()).length},timestamp:Date.now()})}).catch(()=>{});
  // #endregion

  return { products, ctx, productFilter };
}

module.exports = {
  fetchProductsForExport,
  fetchShopContext,
  shopifyQueryForFilter,
};
