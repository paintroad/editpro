window.EditProRules = {
  applyTemplate(template, context) {
    if (!template) {
      return "";
    }
    return String(template).replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_match, key) => {
      const value = context[key];
      return value == null ? "" : String(value);
    }).replace(/\s+/g, " ").trim();
  },

  tagTokens(tags) {
    const arr = Array.isArray(tags) ? tags : [];
    return {
      tags: arr.join(", "),
      tag1: arr[0] || "",
      tag2: arr[1] || "",
      tag3: arr[2] || "",
    };
  },

  imageNumberTokens(imageIndex) {
    if (imageIndex > 0) {
      return {
        "image.index": String(imageIndex),
        incrementing_number: String(imageIndex),
      };
    }
    return {
      "image.index": "",
      incrementing_number: "",
    };
  },

  productContext(product, shopName, image, imageIndex) {
    const description = EditProUtils.stripHtml(product.descriptionHtml);
    const title = product.title || "";
    const productType = product.productType || "";
    return {
      title,
      handle: product.handle || "",
      productType,
      shopName: shopName || "",
      ...this.tagTokens(product.tags),
      description,
      description160: EditProUtils.truncate(description, 160),
      product_name: title,
      product_type: productType,
      product_vendor: product.vendor || "",
      shop_name: shopName || "",
      ...this.imageNumberTokens(imageIndex),
      "image.alt": image?.alt || "",
      "image.filename": EditProUtils.filenameFromUrl(image?.image?.url) || "",
    };
  },

  collectionContext(collection, shopName) {
    const description = EditProUtils.stripHtml(collection.descriptionHtml);
    return {
      title: collection.title || "",
      handle: collection.handle || "",
      description,
      description160: EditProUtils.truncate(description, 160),
      shopName: shopName || "",
      shop_name: shopName || "",
      ...this.imageNumberTokens(1),
      "image.alt": collection.image?.alt || "",
      "image.filename": EditProUtils.filenameFromUrl(collection.image?.url) || "",
    };
  },

  articleContext(article, shopName) {
    const description = EditProUtils.stripHtml(article.summary || article.body);
    return {
      title: article.title || "",
      handle: article.handle || "",
      ...this.tagTokens(article.tags),
      description,
      description160: EditProUtils.truncate(description, 160),
      shopName: shopName || "",
      shop_name: shopName || "",
      ...this.imageNumberTokens(1),
      "image.alt": article.image?.alt || "",
      "image.filename": EditProUtils.filenameFromUrl(article.image?.url) || "",
    };
  },

  ensureExtension(filename, currentFilename) {
    if (!filename) {
      return filename;
    }
    const currentExt = currentFilename && currentFilename.includes(".")
      ? currentFilename.slice(currentFilename.lastIndexOf("."))
      : "";
    if (!currentExt) {
      return filename;
    }
    if (filename.toLowerCase().endsWith(currentExt.toLowerCase())) {
      return filename;
    }
    return `${filename}${currentExt}`;
  },

  articleSeoMetafield(key, value, existingId) {
    if (existingId) {
      return { id: existingId, value };
    }
    return {
      namespace: "global",
      key,
      type: "single_line_text_field",
      value,
    };
  },

  makeChangeId(change) {
    return `${change.resourceId}|${change.field}|${change.mutation}`;
  },

  annotateChange(change, fileUsageIndex) {
    const annotated = { ...change, changeId: this.makeChangeId(change) };
    if (change.mutation === "fileUpdate" && change.fileInput?.id) {
      annotated.fileId = change.fileInput.id;
      annotated.fileUsage = EditProFileUsage.getUsage(fileUsageIndex, change.fileInput.id);
    }
    return annotated;
  },

  buildProductChanges(product, rules, shopName) {
    const changes = [];
    const base = this.productContext(product, shopName, null, 0);

    const seoTitle = this.applyTemplate(rules.seoTitle, base);
    const seoDescription = this.applyTemplate(rules.seoDescription, base);
    const tags = this.applyTemplate(rules.tags, base);

    if ((product.seo?.title || "") !== seoTitle) {
      changes.push({
        resourceType: "product",
        resourceId: product.id,
        resourceTitle: product.title,
        field: "SEO title",
        current: product.seo?.title || "",
        proposed: seoTitle,
        mutation: "productUpdate",
        input: { id: product.id, seo: { title: seoTitle, description: product.seo?.description || "" } },
      });
    }

    if ((product.seo?.description || "") !== seoDescription) {
      changes.push({
        resourceType: "product",
        resourceId: product.id,
        resourceTitle: product.title,
        field: "SEO description",
        current: product.seo?.description || "",
        proposed: seoDescription,
        mutation: "productUpdate",
        input: { id: product.id, seo: { title: product.seo?.title || seoTitle, description: seoDescription } },
      });
    }

    const currentTags = Array.isArray(product.tags) ? product.tags.join(", ") : "";
    if (currentTags !== tags && rules.tags) {
      const tagList = tags.split(",").map((t) => t.trim()).filter(Boolean);
      changes.push({
        resourceType: "product",
        resourceId: product.id,
        resourceTitle: product.title,
        field: "Tags",
        current: currentTags,
        proposed: tags,
        mutation: "productUpdate",
        input: { id: product.id, tags: tagList },
      });
    }

    (product.media?.nodes || []).forEach((image, index) => {
      const fileId = image?.id;
      if (!fileId) {
        return;
      }
      const currentFilename = EditProUtils.filenameFromUrl(image.image?.url);
      const ctx = this.productContext(product, shopName, image, index + 1);
      const alt = this.applyTemplate(rules.imageAlt, ctx);
      const filename = this.ensureExtension(
        this.applyTemplate(rules.imageFilename, ctx),
        currentFilename
      );

      if ((image.alt || "") !== alt) {
        changes.push({
          resourceType: "product",
          resourceId: product.id,
          resourceTitle: product.title,
          field: `Image ${index + 1} alt`,
          current: image.alt || "",
          proposed: alt,
          mutation: "fileUpdate",
          fileInput: { id: fileId, alt },
        });
      }

      if (filename && (currentFilename || "") !== filename) {
        changes.push({
          resourceType: "product",
          resourceId: product.id,
          resourceTitle: product.title,
          field: `Image ${index + 1} filename`,
          current: currentFilename || "",
          proposed: filename,
          mutation: "fileUpdate",
          fileInput: { id: fileId, filename },
        });
      }
    });

    return changes;
  },

  buildCollectionChanges(collection, rules, shopName) {
    const changes = [];
    const ctx = this.collectionContext(collection, shopName);
    const seoTitle = this.applyTemplate(rules.seoTitle, ctx);
    const seoDescription = this.applyTemplate(rules.seoDescription, ctx);

    if ((collection.seo?.title || "") !== seoTitle) {
      changes.push({
        resourceType: "collection",
        resourceId: collection.id,
        resourceTitle: collection.title,
        field: "SEO title",
        current: collection.seo?.title || "",
        proposed: seoTitle,
        mutation: "collectionUpdate",
        input: { id: collection.id, seo: { title: seoTitle, description: collection.seo?.description || "" } },
      });
    }

    if ((collection.seo?.description || "") !== seoDescription) {
      changes.push({
        resourceType: "collection",
        resourceId: collection.id,
        resourceTitle: collection.title,
        field: "SEO description",
        current: collection.seo?.description || "",
        proposed: seoDescription,
        mutation: "collectionUpdate",
        input: { id: collection.id, seo: { title: collection.seo?.title || seoTitle, description: seoDescription } },
      });
    }

    const fileId = collection.image?.id;
    if (fileId) {
      const currentFilename = EditProUtils.filenameFromUrl(collection.image?.url);
      const alt = this.applyTemplate(rules.imageAlt, ctx);
      const filename = this.ensureExtension(
        this.applyTemplate(rules.imageFilename, ctx),
        currentFilename
      );

      if ((collection.image.alt || "") !== alt) {
        changes.push({
          resourceType: "collection",
          resourceId: collection.id,
          resourceTitle: collection.title,
          field: "Image alt",
          current: collection.image.alt || "",
          proposed: alt,
          mutation: "fileUpdate",
          fileInput: { id: fileId, alt },
        });
      }

      if (filename && (currentFilename || "") !== filename) {
        changes.push({
          resourceType: "collection",
          resourceId: collection.id,
          resourceTitle: collection.title,
          field: "Image filename",
          current: currentFilename || "",
          proposed: filename,
          mutation: "fileUpdate",
          fileInput: { id: fileId, filename },
        });
      }
    }

    return changes;
  },

  buildArticleChanges(article, rules, shopName) {
    const changes = [];
    const ctx = this.articleContext(article, shopName);
    const seoTitle = this.applyTemplate(rules.seoTitle, ctx);
    const seoDescription = this.applyTemplate(rules.seoDescription, ctx);
    const tags = this.applyTemplate(rules.tags, ctx);

    if ((article.seo?.title || "") !== seoTitle) {
      changes.push({
        resourceType: "article",
        resourceId: article.id,
        resourceTitle: article.title,
        field: "SEO title",
        current: article.seo?.title || "",
        proposed: seoTitle,
        mutation: "articleUpdate",
        input: {
          id: article.id,
          metafields: [
            this.articleSeoMetafield("title_tag", seoTitle, article.seo?.titleMetafieldId),
          ],
        },
      });
    }

    if ((article.seo?.description || "") !== seoDescription) {
      changes.push({
        resourceType: "article",
        resourceId: article.id,
        resourceTitle: article.title,
        field: "SEO description",
        current: article.seo?.description || "",
        proposed: seoDescription,
        mutation: "articleUpdate",
        input: {
          id: article.id,
          metafields: [
            this.articleSeoMetafield(
              "description_tag",
              seoDescription,
              article.seo?.descriptionMetafieldId
            ),
          ],
        },
      });
    }

    const currentTags = Array.isArray(article.tags) ? article.tags.join(", ") : "";
    if (currentTags !== tags && rules.tags) {
      const tagList = tags.split(",").map((t) => t.trim()).filter(Boolean);
      changes.push({
        resourceType: "article",
        resourceId: article.id,
        resourceTitle: article.title,
        field: "Tags",
        current: currentTags,
        proposed: tags,
        mutation: "articleUpdateTags",
        input: { id: article.id, tags: tagList },
      });
    }

    const fileId = article.image?.id;
    if (fileId) {
      const currentFilename = EditProUtils.filenameFromUrl(article.image?.url);
      const alt = this.applyTemplate(rules.imageAlt, ctx);
      const filename = this.ensureExtension(
        this.applyTemplate(rules.imageFilename, ctx),
        currentFilename
      );

      if ((article.image.alt || "") !== alt) {
        changes.push({
          resourceType: "article",
          resourceId: article.id,
          resourceTitle: article.title,
          field: "Image alt",
          current: article.image.alt || "",
          proposed: alt,
          mutation: "fileUpdate",
          fileInput: { id: fileId, alt },
        });
      }

      if (filename && (currentFilename || "") !== filename) {
        changes.push({
          resourceType: "article",
          resourceId: article.id,
          resourceTitle: article.title,
          field: "Image filename",
          current: currentFilename || "",
          proposed: filename,
          mutation: "fileUpdate",
          fileInput: { id: fileId, filename },
        });
      }
    }

    return changes;
  },

  mergeProductUpdates(changes) {
    const merged = [];
    const productMap = new Map();

    for (const change of changes) {
      if (change.mutation === "fileUpdate") {
        merged.push(change);
        continue;
      }
      if (change.mutation !== "productUpdate") {
        merged.push(change);
        continue;
      }
      const key = change.resourceId;
      if (!productMap.has(key)) {
        productMap.set(key, { ...change, input: { ...change.input } });
      } else {
        const existing = productMap.get(key);
        existing.input = { ...existing.input, ...change.input };
        if (existing.input.seo && change.input.seo) {
          existing.input.seo = { ...existing.input.seo, ...change.input.seo };
        }
        existing.field = "Product fields";
        existing.proposed = "Multiple updates";
      }
    }

    merged.push(...productMap.values());
    return merged;
  },

  mergeCollectionUpdates(changes) {
    const merged = [];
    const map = new Map();
    for (const change of changes) {
      if (change.mutation === "fileUpdate") {
        merged.push(change);
        continue;
      }
      const key = change.resourceId;
      if (!map.has(key)) {
        map.set(key, { ...change, input: { ...change.input } });
      } else {
        const existing = map.get(key);
        existing.input = { ...existing.input, ...change.input };
        if (existing.input.seo && change.input.seo) {
          existing.input.seo = { ...existing.input.seo, ...change.input.seo };
        }
      }
    }
    merged.push(...map.values());
    return merged;
  },

  mergeArticleUpdates(changes) {
    const merged = [];
    const map = new Map();
    for (const change of changes) {
      if (change.mutation === "fileUpdate") {
        merged.push(change);
        continue;
      }
      const key = `${change.resourceId}:${change.mutation}`;
      if (!map.has(key)) {
        map.set(key, { ...change, input: { ...change.input } });
      } else if (change.mutation === "articleUpdate") {
        const existing = map.get(key);
        existing.input = { ...existing.input, ...change.input };
        if (existing.input.metafields && change.input.metafields) {
          existing.input.metafields = [
            ...existing.input.metafields,
            ...change.input.metafields,
          ];
        }
      }
    }
    merged.push(...map.values());
    return merged;
  },

  buildAllChanges(storeData, rules, shopName, selection = {}, fileUsageIndex = null) {
    const changes = [];
    const productIds = selection.productIds;
    const collectionIds = selection.collectionIds;
    const articleIds = selection.articleIds;

    for (const product of storeData.products || []) {
      if (productIds && !productIds.has(product.id)) {
        continue;
      }
      changes.push(...this.buildProductChanges(product, rules.product, shopName));
    }
    for (const collection of storeData.collections || []) {
      if (collectionIds && !collectionIds.has(collection.id)) {
        continue;
      }
      changes.push(...this.buildCollectionChanges(collection, rules.collection, shopName));
    }
    for (const article of storeData.articles || []) {
      if (articleIds && !articleIds.has(article.id)) {
        continue;
      }
      changes.push(...this.buildArticleChanges(article, rules.article, shopName));
    }
    return changes.map((c) => this.annotateChange(c, fileUsageIndex));
  },
};
