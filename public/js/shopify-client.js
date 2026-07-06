window.EditProShopify = {
  async graphql(query, variables = {}, options = {}) {
    return EditProUtils.apiPost("/api/shopify/graphql", { query, variables }, options);
  },

  async testConnection() {
    return EditProUtils.apiPost("/api/shopify/test", {});
  },

  async refreshShopName() {
    const result = await this.testConnection();
    return result.shop?.name || "";
  },

  async fetchCatalogCounts() {
    return EditProUtils.apiPost("/api/shopify/catalog-counts", {});
  },

  async fetchCatalogStream(onProgress, signal, onPage) {
    const response = await fetch(EditProUtils.apiUrl("/api/shopify/catalog"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      signal,
    });

    const contentType = response.headers.get("content-type") || "";

    if (!response.ok) {
      let message = `Catalog fetch failed (${response.status}).`;
      if (contentType.includes("application/json")) {
        try {
          const data = await response.json();
          message = data.error || message;
        } catch {
          // ignore
        }
      } else if (response.status === 404) {
        message = "Catalog API not found — restart the EditPro server and hard-refresh the page.";
      }
      throw new Error(message);
    }

    if (!contentType.includes("application/x-ndjson")) {
      throw new Error("Unexpected catalog response — restart the EditPro server and hard-refresh the page.");
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("Streaming not supported in this browser.");
    }

    const decoder = new TextDecoder();
    let buffer = "";
    const catalog = {
      products: [],
      collections: [],
      articles: [],
      blogs: [],
      warning: null,
      complete: true,
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }
        const message = JSON.parse(line);
        if (message.event === "progress" && onProgress) {
          onProgress({
            products: message.products || 0,
            collections: message.collections || 0,
            articles: message.articles || 0,
          });
        } else if (message.event === "page") {
          const items = message.items || [];
          if (message.type === "products") {
            catalog.products.push(...items);
          } else if (message.type === "collections") {
            catalog.collections.push(...items);
          } else if (message.type === "articles") {
            catalog.articles.push(...items);
          }
          if (onPage) {
            onPage({
              type: message.type,
              items,
              count: message.count || 0,
            });
          }
        } else if (message.event === "done") {
          catalog.complete = message.complete !== false;
          catalog.warning = message.warning || null;
        } else if (message.event === "error") {
          throw new Error(message.error || "Catalog fetch failed.");
        }
      }
    }

    if (buffer.trim()) {
      const message = JSON.parse(buffer);
      if (message.event === "done") {
        catalog.complete = message.complete !== false;
        catalog.warning = message.warning || null;
      } else if (message.event === "error") {
        throw new Error(message.error || "Catalog fetch failed.");
      }
    }

    catalog.blogs = this.extractBlogs(catalog.articles);

    if (!catalog.products.length && !catalog.collections.length && !catalog.articles.length) {
      throw new Error("Catalog fetch ended without data.");
    }

    return catalog;
  },

  async fetchCatalogFallback(onProgress, signal, onPage) {
    const partial = { products: [], collections: [], articles: [] };

    const fetchAll = async (type, query, key, normalize) => {
      let cursor = null;
      let hasNext = true;
      while (hasNext) {
        if (signal?.aborted) {
          return partial[type];
        }
        const data = await this.graphql(query, { cursor }, { signal });
        const page = data[key];
        const nodes = normalize ? page.nodes.map(normalize) : page.nodes;
        partial[type].push(...nodes);
        hasNext = page.pageInfo.hasNextPage;
        cursor = page.pageInfo.endCursor;
        if (onProgress) {
          onProgress({
            products: partial.products.length,
            collections: partial.collections.length,
            articles: partial.articles.length,
          });
        }
        if (onPage) {
          onPage({ type, items: nodes, count: partial[type].length });
        }
      }
      return partial[type];
    };

    const productsQuery = `query Products($cursor: String) {
      products(first: 250, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id title handle tags productType vendor
          seo { title description }
          collections(first: 25) { nodes { id } }
          media(first: 25) {
            nodes { ... on MediaImage { id alt image { url } } }
          }
        }
      }
    }`;

    const collectionsQuery = `query Collections($cursor: String) {
      collections(first: 250, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id title handle
          seo { title description }
          ruleSet { appliedDisjunctively rules { column relation condition } }
          productsCount { count }
          image { id alt: altText url }
        }
      }
    }`;

    const articlesQuery = `query Articles($cursor: String) {
      articles(first: 250, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id title handle tags summary
          blog { id title }
          metafields(first: 10, namespace: "global") { nodes { id key value } }
          image { id alt: altText url }
        }
      }
    }`;

    let articlesWarning = null;
    const articlesPromise = fetchAll("articles", articlesQuery, "articles", (a) =>
      this.normalizeArticle(a)
    ).catch((error) => {
      if (EditProUtils.isAccessDeniedError(error.message)) {
        articlesWarning =
          "Blog articles were skipped because your API token is missing read_content and write_content scopes.";
        return [];
      }
      throw error;
    });

    await Promise.all([
      fetchAll("products", productsQuery, "products"),
      fetchAll("collections", collectionsQuery, "collections", (c) => this.normalizeCollection(c)),
      articlesPromise,
    ]);

    return {
      products: partial.products,
      collections: partial.collections,
      articles: partial.articles,
      blogs: this.extractBlogs(partial.articles),
      warning: articlesWarning,
      complete: !signal?.aborted,
    };
  },

  async fetchDescriptionFields(productIds = [], collectionIds = []) {
    const descriptions = { products: new Map(), collections: new Map() };
    const allIds = [...productIds, ...collectionIds];
    if (!allIds.length) {
      return descriptions;
    }

    const chunkSize = 250;
    for (let i = 0; i < allIds.length; i += chunkSize) {
      const chunk = allIds.slice(i, i + chunkSize);
      const data = await this.graphql(
        `query ResourceDescriptions($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on Product {
              id
              descriptionHtml
            }
            ... on Collection {
              id
              descriptionHtml
            }
          }
        }`,
        { ids: chunk }
      );

      for (const node of data.nodes || []) {
        if (!node?.id || node.descriptionHtml == null) {
          continue;
        }
        if (productIds.includes(node.id)) {
          descriptions.products.set(node.id, node.descriptionHtml);
        } else if (collectionIds.includes(node.id)) {
          descriptions.collections.set(node.id, node.descriptionHtml);
        }
      }
    }

    return descriptions;
  },

  async fetchAllDescriptions(productIds = [], collectionIds = []) {
    return this.fetchDescriptionFields(productIds, collectionIds);
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
