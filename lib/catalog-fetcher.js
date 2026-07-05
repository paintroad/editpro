const { shopifyGraphql } = require("./shopify-client");

const PAGE_SIZE = 250;

const PRODUCTS_QUERY = `query Products($cursor: String) {
  products(first: ${PAGE_SIZE}, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id title handle tags productType vendor
      seo { title description }
      collections(first: 25) {
        nodes { id }
      }
      media(first: 25) {
        nodes {
          ... on MediaImage {
            id alt
            image { url }
          }
        }
      }
    }
  }
}`;

const COLLECTIONS_QUERY = `query Collections($cursor: String) {
  collections(first: ${PAGE_SIZE}, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id title handle
      seo { title description }
      ruleSet {
        appliedDisjunctively
        rules { column relation condition }
      }
      productsCount { count }
      image {
        id
        alt: altText
        url
      }
    }
  }
}`;

const ARTICLES_QUERY = `query Articles($cursor: String) {
  articles(first: ${PAGE_SIZE}, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id title handle tags
      summary
      blog { id title }
      metafields(first: 10, namespace: "global") {
        nodes {
          id
          key
          value
        }
      }
      image {
        id
        alt: altText
        url
      }
    }
  }
}`;

function normalizeCollection(collection) {
  collection.collectionType = collection.ruleSet ? "smart" : "custom";
  collection.productCount = collection.productsCount?.count ?? 0;
  delete collection.ruleSet;
  delete collection.productsCount;
  return collection;
}

function normalizeArticle(article) {
  const metafields = article.metafields?.nodes || [];
  const titleMf = metafields.find((m) => m.key === "title_tag");
  const descMf = metafields.find((m) => m.key === "description_tag");
  article.seo = {
    title: titleMf?.value || "",
    description: descMf?.value || "",
    titleMetafieldId: titleMf?.id || null,
    descriptionMetafieldId: descMf?.id || null,
  };
  delete article.metafields;
  return article;
}

function extractBlogs(articles) {
  const map = new Map();
  for (const article of articles || []) {
    if (article.blog?.id) {
      map.set(article.blog.id, { id: article.blog.id, title: article.blog.title });
    }
  }
  return [...map.values()].sort((a, b) => a.title.localeCompare(b.title));
}

async function fetchAllProducts(storeDomain, accessToken, { onPage, shouldAbort } = {}) {
  const products = [];
  let cursor = null;
  let hasNext = true;

  while (hasNext) {
    if (shouldAbort?.()) {
      return products;
    }

    const data = await shopifyGraphql(storeDomain, accessToken, PRODUCTS_QUERY, { cursor });
    const page = data.products;
    products.push(...page.nodes);
    hasNext = page.pageInfo.hasNextPage;
    cursor = page.pageInfo.endCursor;
    if (onPage) {
      onPage({ type: "products", items: page.nodes, count: products.length });
    }
  }

  return products;
}

async function fetchAllCollections(storeDomain, accessToken, { onPage, shouldAbort } = {}) {
  const collections = [];
  let cursor = null;
  let hasNext = true;

  while (hasNext) {
    if (shouldAbort?.()) {
      return collections;
    }

    const data = await shopifyGraphql(storeDomain, accessToken, COLLECTIONS_QUERY, { cursor });
    const page = data.collections;
    const nodes = page.nodes.map((c) => normalizeCollection(c));
    collections.push(...nodes);
    hasNext = page.pageInfo.hasNextPage;
    cursor = page.pageInfo.endCursor;
    if (onPage) {
      onPage({ type: "collections", items: nodes, count: collections.length });
    }
  }

  return collections;
}

async function fetchAllArticles(storeDomain, accessToken, { onPage, shouldAbort } = {}) {
  const articles = [];
  let cursor = null;
  let hasNext = true;

  while (hasNext) {
    if (shouldAbort?.()) {
      return articles;
    }

    const data = await shopifyGraphql(storeDomain, accessToken, ARTICLES_QUERY, { cursor });
    const page = data.articles;
    const nodes = page.nodes.map((a) => normalizeArticle(a));
    articles.push(...nodes);
    hasNext = page.pageInfo.hasNextPage;
    cursor = page.pageInfo.endCursor;
    if (onPage) {
      onPage({ type: "articles", items: nodes, count: articles.length });
    }
  }

  return articles;
}

async function fetchCatalogCounts(storeDomain, accessToken) {
  const data = await shopifyGraphql(
    storeDomain,
    accessToken,
    `query CatalogCounts {
      productsCount(limit: null) { count }
      collectionsCount(limit: null) { count }
    }`
  );

  return {
    products: data.productsCount?.count ?? 0,
    collections: data.collectionsCount?.count ?? 0,
    articles: null,
  };
}

async function fetchCatalog(storeDomain, accessToken, { onProgress, onPage, shouldAbort } = {}) {
  const counts = { products: 0, collections: 0, articles: 0 };
  let articlesWarning = null;

  const reportProgress = () => {
    if (onProgress) {
      onProgress({ ...counts });
    }
  };

  const productsPromise = fetchAllProducts(storeDomain, accessToken, {
    shouldAbort,
    onPage: ({ count, items }) => {
      counts.products = count;
      reportProgress();
      if (onPage) {
        onPage({ type: "products", items, count });
      }
    },
  });

  const collectionsPromise = fetchAllCollections(storeDomain, accessToken, {
    shouldAbort,
    onPage: ({ count, items }) => {
      counts.collections = count;
      reportProgress();
      if (onPage) {
        onPage({ type: "collections", items, count });
      }
    },
  });

  const articlesPromise = fetchAllArticles(storeDomain, accessToken, {
    shouldAbort,
    onPage: ({ count, items }) => {
      counts.articles = count;
      reportProgress();
      if (onPage) {
        onPage({ type: "articles", items, count });
      }
    },
  })
    .catch((error) => {
      const message = error.message || "";
      if (
        message.includes("Access denied") ||
        message.toLowerCase().includes("access") ||
        message.toLowerCase().includes("scope")
      ) {
        counts.articles = 0;
        articlesWarning =
          "Blog articles were skipped because your API token is missing read_content and write_content scopes.";
        reportProgress();
        return [];
      }
      throw error;
    });

  const [products, collections, articles] = await Promise.all([
    productsPromise,
    collectionsPromise,
    articlesPromise,
  ]);

  if (shouldAbort?.()) {
    return {
      products,
      collections,
      articles,
      blogs: extractBlogs(articles),
      warning: articlesWarning,
      complete: false,
    };
  }

  return {
    products,
    collections,
    articles,
    blogs: extractBlogs(articles),
    warning: articlesWarning,
    complete: true,
  };
}

module.exports = {
  fetchCatalog,
  fetchCatalogCounts,
  extractBlogs,
};
