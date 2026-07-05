window.EditProRules = {
  ROOM_FALLBACKS: [
    "house",
    "home",
    "space",
    "place",
    "area",
    "abode",
    "sweet home",
    "lovely house",
    "room",
  ],

  resolveRoom(fileId, seedKey, roomFallbackCache = {}) {
    const mapped = window.EditProImageRoomMap?.getRoom?.(fileId);
    if (mapped) {
      return mapped;
    }
    if (!roomFallbackCache[seedKey]) {
      roomFallbackCache[seedKey] = this.pickRandom(this.ROOM_FALLBACKS);
    }
    return roomFallbackCache[seedKey];
  },

  computeTagList(resourceType, resource, rules, ctx, roomFallbackCache) {
    let tagList;
    if (rules.tags) {
      tagList = this.applyTemplate(rules.tags, ctx)
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
    } else {
      tagList = [...(resource.tags || [])];
    }

    if (rules.newTags) {
      const added = this.applyTemplate(rules.newTags, ctx)
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      for (const tag of added) {
        if (!tagList.some((existing) => existing.toLowerCase() === tag.toLowerCase())) {
          tagList.push(tag);
        }
      }
    }

    if (resourceType === "product") {
      const rooms = new Set();
      for (const img of resource.media?.nodes || []) {
        const mappedRoom = window.EditProImageRoomMap?.getRoom?.(img.id);
        if (mappedRoom) {
          rooms.add(window.EditProImageRoomMap.roomToTitleCase(mappedRoom));
        }
      }
      for (const roomTag of rooms) {
        if (!tagList.some((t) => t.toLowerCase() === roomTag.toLowerCase())) {
          tagList.push(roomTag);
        }
      }
    }

    return tagList;
  },

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

  pickRandom(arr) {
    if (!Array.isArray(arr) || arr.length === 0) {
      return "";
    }
    return arr[Math.floor(Math.random() * arr.length)];
  },

  randomContext(resourceType, resource, descriptionPhrases) {
    const phrases = Array.isArray(descriptionPhrases) ? descriptionPhrases : [];
    const tags = resourceType === "collection"
      ? []
      : (Array.isArray(resource?.tags) ? resource.tags : []);
    return {
      random_tag: this.pickRandom(tags),
      random_description: this.pickRandom(phrases),
    };
  },

  mergeContext(base, extra) {
    return { ...base, ...extra };
  },

  templateHasRandomTokens(template) {
    return /\{\{\s*random_(tag|description)\s*\}\}/.test(String(template || ""));
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

  productContext(product, shopName, image, imageIndex, roomFallbackCache = {}) {
    const description = EditProUtils.stripHtml(product.descriptionHtml);
    const title = product.title || "";
    const productType = product.productType || "";
    const fileId = image?.id || product.media?.nodes?.[0]?.id || "";
    const idx = imageIndex > 0 ? imageIndex : 1;
    const room = this.resolveRoom(fileId, `${product.id}:${idx}`, roomFallbackCache);
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
      room,
      ...this.imageNumberTokens(imageIndex),
      "image.alt": image?.alt || "",
      "image.filename": EditProUtils.filenameFromUrl(image?.image?.url) || "",
    };
  },

  collectionContext(collection, shopName, roomFallbackCache = {}) {
    const description = EditProUtils.stripHtml(collection.descriptionHtml);
    const title = collection.title || "";
    const fileId = collection.image?.id || "";
    const room = this.resolveRoom(fileId, `${collection.id}:1`, roomFallbackCache);
    return {
      title,
      handle: collection.handle || "",
      collection_name: title,
      description,
      description160: EditProUtils.truncate(description, 160),
      shopName: shopName || "",
      shop_name: shopName || "",
      room,
      ...this.imageNumberTokens(1),
      "image.alt": collection.image?.alt || "",
      "image.filename": EditProUtils.filenameFromUrl(collection.image?.url) || "",
    };
  },

  articleContext(article, shopName, roomFallbackCache = {}) {
    const description = EditProUtils.stripHtml(article.summary);
    const title = article.title || "";
    const fileId = article.image?.id || "";
    const room = this.resolveRoom(fileId, `${article.id}:1`, roomFallbackCache);
    return {
      title,
      handle: article.handle || "",
      blog_name: title,
      blog_title: article.blog?.title || "",
      ...this.tagTokens(article.tags),
      description,
      description160: EditProUtils.truncate(description, 160),
      shopName: shopName || "",
      shop_name: shopName || "",
      room,
      ...this.imageNumberTokens(1),
      "image.alt": article.image?.alt || "",
      "image.filename": EditProUtils.filenameFromUrl(article.image?.url) || "",
    };
  },

  /**
   * Spaces → hyphens; strip symbols unsafe for filenames; lowercase.
   * Keeps letters, digits, hyphen, underscore, and period.
   */
  sanitizeField(value) {
    if (!value) {
      return "";
    }
    return String(value)
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9._-]/g, "")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "");
  },

  sanitizeFilename(value, currentFilename) {
    const sanitized = this.sanitizeField(value);
    return this.ensureExtension(sanitized, currentFilename).toLowerCase();
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

  buildProductChanges(product, rules, shopName, descriptionPhrases) {
    const changes = [];
    const phrases = descriptionPhrases ?? window.EditProSettings?.descriptionPhrases;
    const roomFallbackCache = {};
    const random = this.randomContext("product", product, phrases);
    const base = this.mergeContext(
      this.productContext(product, shopName, null, 0, roomFallbackCache),
      random
    );

    const seoTitle = this.applyTemplate(rules.seoTitle, base);
    const seoDescription = this.applyTemplate(rules.seoDescription, base);
    const tagList = this.computeTagList("product", product, rules, base, roomFallbackCache);
    const tags = tagList.join(", ");

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
    if (currentTags !== tags) {
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
      const ctx = this.mergeContext(
        this.productContext(product, shopName, image, index + 1, roomFallbackCache),
        random
      );
      const alt = this.applyTemplate(rules.imageAlt, ctx);
      const filename = this.sanitizeFilename(
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

  buildCollectionChanges(collection, rules, shopName, descriptionPhrases) {
    const changes = [];
    const phrases = descriptionPhrases ?? window.EditProSettings?.descriptionPhrases;
    const roomFallbackCache = {};
    const random = this.randomContext("collection", collection, phrases);
    const ctx = this.mergeContext(
      this.collectionContext(collection, shopName, roomFallbackCache),
      random
    );
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
      const filename = this.sanitizeFilename(
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

  buildArticleChanges(article, rules, shopName, descriptionPhrases) {
    const changes = [];
    const phrases = descriptionPhrases ?? window.EditProSettings?.descriptionPhrases;
    const roomFallbackCache = {};
    const random = this.randomContext("article", article, phrases);
    const ctx = this.mergeContext(
      this.articleContext(article, shopName, roomFallbackCache),
      random
    );
    const seoTitle = this.applyTemplate(rules.seoTitle, ctx);
    const seoDescription = this.applyTemplate(rules.seoDescription, ctx);
    const tagList = this.computeTagList("article", article, rules, ctx, roomFallbackCache);
    const tags = tagList.join(", ");

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
    if (currentTags !== tags) {
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
      const filename = this.sanitizeFilename(
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
    const descriptionPhrases = window.EditProSettings?.descriptionPhrases;

    for (const product of storeData.products || []) {
      if (productIds && !productIds.has(product.id)) {
        continue;
      }
      changes.push(
        ...this.buildProductChanges(product, rules.product, shopName, descriptionPhrases)
      );
    }
    for (const collection of storeData.collections || []) {
      if (collectionIds && !collectionIds.has(collection.id)) {
        continue;
      }
      changes.push(
        ...this.buildCollectionChanges(collection, rules.collection, shopName, descriptionPhrases)
      );
    }
    for (const article of storeData.articles || []) {
      if (articleIds && !articleIds.has(article.id)) {
        continue;
      }
      changes.push(
        ...this.buildArticleChanges(article, rules.article, shopName, descriptionPhrases)
      );
    }
    return changes.map((c) => this.annotateChange(c, fileUsageIndex));
  },
};
