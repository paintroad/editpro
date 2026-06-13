window.EditProShopify = {
  async graphql(query, variables = {}, options = {}) {
    return EditProUtils.apiPost("/api/shopify/graphql", { query, variables }, options);
  },

  async testConnection() {
    return EditProUtils.apiPost("/api/shopify/test", {});
  },

  async fetchAllProducts(onProgress, signal) {
    const products = [];
    let cursor = null;
    let hasNext = true;

    try {
      while (hasNext) {
        if (signal?.aborted) {
          return products;
        }

        const data = await this.graphql(
          `query Products($cursor: String) {
          products(first: 50, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id title handle tags productType vendor descriptionHtml
              seo { title description }
              collections(first: 50) {
                nodes { id title }
              }
              media(first: 50) {
                nodes {
                  ... on MediaImage {
                    id alt
                    image { url }
                  }
                }
              }
            }
          }
        }`,
          { cursor },
          { signal }
        );

        const page = data.products;
        products.push(...page.nodes);
        hasNext = page.pageInfo.hasNextPage;
        cursor = page.pageInfo.endCursor;
        if (onProgress) {
          onProgress({ type: "products", count: products.length });
        }
      }
    } catch (error) {
      if (error.name === "AbortError") {
        return products;
      }
      throw error;
    }

    return products;
  },

  async fetchAllCollections(onProgress, signal) {
    const collections = [];
    let cursor = null;
    let hasNext = true;

    try {
      while (hasNext) {
        if (signal?.aborted) {
          return collections;
        }

        const data = await this.graphql(
          `query Collections($cursor: String) {
          collections(first: 50, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id title handle descriptionHtml
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
        }`,
          { cursor },
          { signal }
        );

        const page = data.collections;
        collections.push(...page.nodes.map((c) => this.normalizeCollection(c)));
        hasNext = page.pageInfo.hasNextPage;
        cursor = page.pageInfo.endCursor;
        if (onProgress) {
          onProgress({ type: "collections", count: collections.length });
        }
      }
    } catch (error) {
      if (error.name === "AbortError") {
        return collections;
      }
      throw error;
    }

    return collections;
  },

  async fetchAllArticles(onProgress, signal) {
    const articles = [];
    let cursor = null;
    let hasNext = true;

    try {
      while (hasNext) {
        if (signal?.aborted) {
          return articles;
        }

        const data = await this.graphql(
          `query Articles($cursor: String) {
          articles(first: 50, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id title handle tags
              body
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
        }`,
          { cursor },
          { signal }
        );

        const page = data.articles;
        articles.push(...page.nodes.map((article) => this.normalizeArticle(article)));
        hasNext = page.pageInfo.hasNextPage;
        cursor = page.pageInfo.endCursor;
        if (onProgress) {
          onProgress({ type: "articles", count: articles.length });
        }
      }
    } catch (error) {
      if (error.name === "AbortError") {
        return articles;
      }
      throw error;
    }

    return articles;
  },

  normalizeCollection(collection) {
    collection.collectionType = collection.ruleSet ? "smart" : "custom";
    collection.productCount = collection.productsCount?.count ?? 0;
    delete collection.ruleSet;
    delete collection.productsCount;
    return collection;
  },

  normalizeArticle(article) {
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
  },

  extractBlogs(articles) {
    const map = new Map();
    for (const article of articles || []) {
      if (article.blog?.id) {
        map.set(article.blog.id, { id: article.blog.id, title: article.blog.title });
      }
    }
    return [...map.values()].sort((a, b) => a.title.localeCompare(b.title));
  },
};
