window.EditProRules = {
  DEFAULT_ROOM_FALLBACKS: [
    "house",
    "home",
    "space",
    "place",
    "area",
    "abode",
    "sweet-home",
    "lovely-house",
    "room",
    "interior",
    "decor",
    "living-space",
    "bedroom",
    "kitchen",
    "office",
    "hallway",
    "studio",
    "gallery",
    "nook",
    "retreat",
    "haven",
    "dwelling",
    "residence",
    "loft",
    "sanctuary",
  ],

  CHANGE_FIELD_KEYS: {
    seoTitle: "SEO title",
    seoDescription: "SEO description",
    tags: "Tags",
    imageAlt: "Image alt text",
    imageFilename: "Image filename",
  },

  changeFieldKey(change) {
    const name = String(change?.field || "");
    if (name === "SEO title") {
      return "seoTitle";
    }
    if (name === "SEO description") {
      return "seoDescription";
    }
    if (name === "Tags") {
      return "tags";
    }
    if (/alt/i.test(name)) {
      return "imageAlt";
    }
    if (/filename/i.test(name)) {
      return "imageFilename";
    }
    return null;
  },

  getRoomFallbacks() {
    const list = window.EditProSettings?.roomFallbacks;
    return Array.isArray(list) && list.length ? list : this.DEFAULT_ROOM_FALLBACKS;
  },

  hashSeedKey(seedKey) {
    let hash = 0;
    const str = String(seedKey);
    for (let i = 0; i < str.length; i++) {
      hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
    }
    return hash;
  },

  templateUsesRoom(template) {
    return /\{\{\s*room\s*\}\}/.test(String(template || ""));
  },

  collectStoreFilenames(storeData) {
    const used = new Set();
    const add = (url) => {
      const name = EditProUtils.filenameFromUrl(url);
      if (name) {
        used.add(name.toLowerCase());
      }
    };
    for (const product of storeData?.products || []) {
      for (const node of product.media?.nodes || []) {
        add(node?.image?.url);
      }
    }
    for (const collection of storeData?.collections || []) {
      add(collection.image?.url);
    }
    for (const article of storeData?.articles || []) {
      add(article.image?.url);
    }
    return used;
  },

  appendSuffixBeforeExt(filename, suffix, currentFilename) {
    if (!filename || !suffix) {
      return filename;
    }
    const ext =
      currentFilename && currentFilename.includes(".")
        ? currentFilename.slice(currentFilename.lastIndexOf("."))
        : "";
    let base = filename;
    if (ext && base.toLowerCase().endsWith(ext.toLowerCase())) {
      base = base.slice(0, -ext.length);
    }
    return this.ensureExtension(`${base}-${suffix}`, currentFilename).toLowerCase();
  },

  isFilenameCollision(filename, usedFilenames, currentFilename) {
    const key = (filename || "").toLowerCase();
    if (!key) {
      return false;
    }
    const ownName = (currentFilename || "").toLowerCase();
    if (key === ownName) {
      return false;
    }
    return usedFilenames.has(key);
  },

  reserveFilename(filename, usedFilenames) {
    const key = (filename || "").toLowerCase();
    if (key) {
      usedFilenames.add(key);
    }
  },

  buildFilenameCandidates({
    template,
    buildContext,
    seedKey,
    currentFilename,
  }) {
    if (!template) {
      return [];
    }
    const fallbacks = this.getRoomFallbacks();
    const usesRoom = this.templateUsesRoom(template);

    const buildFilename = (roomOverride, suffixFallback) => {
      let ctx = buildContext();
      if (roomOverride != null) {
        ctx = { ...ctx, room: roomOverride };
      }
      let raw = this.applyTemplate(template, ctx);
      let filename = this.sanitizeFilename(raw, currentFilename);
      if (!usesRoom && suffixFallback) {
        const sanitized = this.sanitizeField(suffixFallback);
        if (sanitized) {
          filename = this.appendSuffixBeforeExt(filename, sanitized, currentFilename);
        }
      }
      return filename;
    };

    const candidates = [];
    const seen = new Set();
    const addCandidate = (name) => {
      const key = (name || "").toLowerCase();
      if (key && !seen.has(key)) {
        seen.add(key);
        candidates.push(name);
      }
    };

    addCandidate(buildFilename(null, null));
    const start = fallbacks.length ? this.hashSeedKey(seedKey) % fallbacks.length : 0;
    for (let i = 0; i < fallbacks.length; i++) {
      const fallback = fallbacks[(start + i) % fallbacks.length];
      addCandidate(usesRoom ? buildFilename(fallback, null) : buildFilename(null, fallback));
    }
    return candidates;
  },

  filenameChangeMeta({ template, buildContext, seedKey, currentFilename }) {
    return {
      filenameSeedKey: seedKey,
      filenameTemplate: template,
      filenameBuildContext: buildContext,
      filenameCurrent: currentFilename || "",
    };
  },

  resolveUniqueImageFilename({
    template,
    buildContext,
    seedKey,
    usedFilenames,
    currentFilename,
    reserve = true,
  }) {
    if (!template) {
      return "";
    }
    const candidates = this.buildFilenameCandidates({
      template,
      buildContext,
      seedKey,
      currentFilename,
    });

    for (const filename of candidates) {
      if (!this.isFilenameCollision(filename, usedFilenames, currentFilename)) {
        if (reserve) {
          this.reserveFilename(filename, usedFilenames);
        }
        return filename;
      }
    }

    const last = candidates[candidates.length - 1] || "";
    if (reserve && last) {
      this.reserveFilename(last, usedFilenames);
    }
    return last;
  },

  resolveRoom(fileId, seedKey, roomFallbackCache = {}, resource = null, resourceType = null, imageIndex = 1) {
    let mapped = "";
    if (resource && resourceType && window.EditProImageRoomMap?.getRoomForResource) {
      mapped = window.EditProImageRoomMap.getRoomForResource(resource, resourceType, imageIndex);
    }
    if (!mapped) {
      mapped = window.EditProImageRoomMap?.getRoom?.(fileId) || "";
    }
    if (mapped && !EditProImageRoomMap.isNoneRoom(mapped)) {
      return mapped;
    }
    if (!roomFallbackCache[seedKey]) {
      const fallbacks = this.getRoomFallbacks();
      const idx = fallbacks.length ? this.hashSeedKey(seedKey) % fallbacks.length : 0;
      roomFallbackCache[seedKey] = fallbacks[idx] || "";
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
      const nodeCount = resource.media?.nodes?.length || 0;
      for (let i = 0; i < nodeCount; i++) {
        const img = window.EditProImageRoomMap?.imageFromResource?.(resource, "product", i + 1);
        const mappedRoom = img ? window.EditProImageRoomMap.getRoomForImage(img) : "";
        if (mappedRoom && !EditProImageRoomMap.isNoneRoom(mappedRoom)) {
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
    const room = this.resolveRoom(fileId, `${product.id}:${idx}`, roomFallbackCache, product, "product", idx);
    return {
      title,
      handle: product.handle || "",
      productType,
      shopName: shopName || "",
      ...this.tagTokens(product.tags),
      description,
      description100: EditProUtils.truncate(description, 100),
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
    const room = this.resolveRoom(fileId, `${collection.id}:1`, roomFallbackCache, collection, "collection", 1);
    return {
      title,
      handle: collection.handle || "",
      collection_name: title,
      description,
      description100: EditProUtils.truncate(description, 100),
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
    const room = this.resolveRoom(fileId, `${article.id}:1`, roomFallbackCache, article, "article", 1);
    return {
      title,
      handle: article.handle || "",
      blog_name: title,
      blog_title: article.blog?.title || "",
      ...this.tagTokens(article.tags),
      description,
      description100: EditProUtils.truncate(description, 100),
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
    if (change.catalogInput?.imageIndex) {
      return `${change.resourceId}|${change.field}|${change.mutation}|${change.catalogInput.imageIndex}`;
    }
    return `${change.resourceId}|${change.field}|${change.mutation}`;
  },

  basenameFromPath(filePath) {
    if (!filePath) {
      return "";
    }
    const parts = String(filePath).split(/[/\\]/);
    return parts[parts.length - 1] || "";
  },

  catalogProductImages(product) {
    const images = [];
    if (product.sourceImage?.path) {
      images.push({
        ...product.sourceImage,
        catalogImageKind: "source",
        lifestyleListIndex: null,
      });
    }
    const lifestyle = [...(product.lifestyleImages || [])].sort(
      (a, b) => (a.index ?? 0) - (b.index ?? 0)
    );
    for (let i = 0; i < lifestyle.length; i++) {
      images.push({
        ...lifestyle[i],
        catalogImageKind: "lifestyle",
        lifestyleListIndex: i,
      });
    }
    return images.map((img, i) => ({ ...img, catalogGalleryIndex: i + 1 }));
  },

  collectCatalogFilenames(products) {
    const used = new Set();
    for (const product of products) {
      for (const img of this.catalogProductImages(product)) {
        const name = img.filename || this.basenameFromPath(img.path);
        if (name) {
          used.add(name.toLowerCase());
        }
      }
    }
    return used;
  },

  catalogResolveRoom(product, imageEntry, imageIndex, roomFallbackCache = {}) {
    const roomLabel = imageEntry?.roomLabel || imageEntry?.room || "";
    if (roomLabel && !(window.EditProImageRoomMap?.isNoneRoom?.(roomLabel))) {
      return roomLabel;
    }
    const seedKey = `${product.productId}:${imageIndex}`;
    if (!roomFallbackCache[seedKey]) {
      const fallbacks = this.getRoomFallbacks();
      const idx = fallbacks.length ? this.hashSeedKey(seedKey) % fallbacks.length : 0;
      roomFallbackCache[seedKey] = fallbacks[idx] || "";
    }
    return roomFallbackCache[seedKey];
  },

  catalogProductContext(product, imageEntry, imageIndex, shopName, roomFallbackCache = {}) {
    const description = EditProUtils.stripHtml(
      product.descriptionHtml || product.descriptionPlain || ""
    );
    const title = product.title || "";
    const productType = product.productType || "";
    const currentFilename = imageEntry?.filename || this.basenameFromPath(imageEntry?.path);
    const room = this.catalogResolveRoom(product, imageEntry, imageIndex, roomFallbackCache);
    return {
      title,
      handle: product.handle || "",
      productType,
      shopName: shopName || "",
      ...this.tagTokens(product.tags),
      description,
      description100: product.description100 || EditProUtils.truncate(description, 100),
      description160: product.description160 || EditProUtils.truncate(description, 160),
      product_name: title,
      product_type: productType,
      product_vendor: product.vendor || "",
      shop_name: shopName || "",
      room,
      ...this.imageNumberTokens(imageIndex),
      "image.alt": imageEntry?.alt || "",
      "image.filename": currentFilename || "",
    };
  },

  buildCatalogProductChanges(product, rules, shopName, descriptionPhrases, usedFilenames = null) {
    const changes = [];
    if (!rules) {
      return changes;
    }
    const phrases = descriptionPhrases ?? window.EditProSettings?.descriptionPhrases;
    const roomFallbackCache = {};
    const filenameRegistry = usedFilenames || new Set();
    const images = this.catalogProductImages(product);
    const random = {
      random_tag: this.pickRandom(product.tags),
      random_description: this.pickRandom(phrases),
    };
    const base = this.mergeContext(
      this.catalogProductContext(product, images[0] || {}, 0, shopName, roomFallbackCache),
      random
    );

    const seoTitle = this.applyTemplate(rules.seoTitle, base);
    const seoDescription = this.applyTemplate(rules.seoDescription, base);

    if ((product.seoTitle || "") !== seoTitle) {
      changes.push({
        resourceType: "catalog-product",
        resourceId: product.productId,
        resourceTitle: product.title,
        field: "SEO title",
        current: product.seoTitle || "",
        proposed: seoTitle,
        mutation: "catalogSeoUpdate",
        catalogInput: { productId: product.productId, field: "seoTitle", value: seoTitle },
      });
    }

    if ((product.seoDescription || "") !== seoDescription) {
      changes.push({
        resourceType: "catalog-product",
        resourceId: product.productId,
        resourceTitle: product.title,
        field: "SEO description",
        current: product.seoDescription || "",
        proposed: seoDescription,
        mutation: "catalogSeoUpdate",
        catalogInput: {
          productId: product.productId,
          field: "seoDescription",
          value: seoDescription,
        },
      });
    }

    for (const imageEntry of images) {
      const imageIndex = imageEntry.catalogGalleryIndex;
      const currentFilename = imageEntry.filename || this.basenameFromPath(imageEntry.path);
      const ctx = this.mergeContext(
        this.catalogProductContext(product, imageEntry, imageIndex, shopName, roomFallbackCache),
        random
      );
      const alt = this.applyTemplate(rules.imageAlt, ctx);
      const filename = this.resolveUniqueImageFilename({
        template: rules.imageFilename,
        buildContext: () => ctx,
        seedKey: `${product.productId}:${imageIndex}`,
        usedFilenames: filenameRegistry,
        currentFilename,
      });

      if ((imageEntry.alt || "") !== alt) {
        changes.push({
          resourceType: "catalog-product",
          resourceId: product.productId,
          resourceTitle: product.title,
          field: `Image ${imageIndex} alt`,
          current: imageEntry.alt || "",
          proposed: alt,
          mutation: "catalogImageAlt",
          catalogInput: {
            productId: product.productId,
            imageKind: imageEntry.catalogImageKind,
            lifestyleListIndex: imageEntry.lifestyleListIndex,
            imageIndex,
            value: alt,
          },
        });
      }

      if (filename && (currentFilename || "") !== filename) {
        const seedKey = `${product.productId}:${imageIndex}`;
        const dir = imageEntry.path
          ? String(imageEntry.path).replace(/[/\\][^/\\]+$/, "")
          : "";
        const sep = dir.includes("\\") ? "\\" : "/";
        changes.push({
          resourceType: "catalog-product",
          resourceId: product.productId,
          resourceTitle: product.title,
          field: `Image ${imageIndex} filename`,
          current: currentFilename || "",
          proposed: filename,
          mutation: "catalogFileRename",
          catalogInput: {
            productId: product.productId,
            imageKind: imageEntry.catalogImageKind,
            lifestyleListIndex: imageEntry.lifestyleListIndex,
            imageIndex,
            oldPath: imageEntry.path,
            newFilename: filename,
            newPath: dir ? `${dir}${sep}${filename}` : filename,
          },
          ...this.filenameChangeMeta({
            template: rules.imageFilename,
            buildContext: () => ctx,
            seedKey,
            currentFilename,
          }),
        });
      }
    }

    return changes;
  },

  buildCatalogSeoChanges(products, rules, shopName, descriptionPhrases) {
    const usedFilenames = this.collectCatalogFilenames(products);
    const changes = [];
    for (const product of products) {
      changes.push(
        ...this.buildCatalogProductChanges(
          product,
          rules,
          shopName,
          descriptionPhrases,
          usedFilenames
        )
      );
    }
    return changes.map((c) => this.annotateChange(c, null));
  },

  getRulesForType(resourceType) {
    const key =
      resourceType === "product"
        ? "product"
        : resourceType === "collection"
          ? "collection"
          : "article";
    return window.EditProSettings?.rules?.[key] || null;
  },

  buildRuleContext(resourceType, resource, shopName) {
    const roomFallbackCache = {};
    if (resourceType === "product") {
      return this.productContext(resource, shopName, null, 0, roomFallbackCache);
    }
    if (resourceType === "collection") {
      return this.collectionContext(resource, shopName, roomFallbackCache);
    }
    return this.articleContext(resource, shopName, roomFallbackCache);
  },

  expectedSeoTitle(resourceType, resource, shopName, rules) {
    const template = rules?.seoTitle;
    if (!template || this.templateHasRandomTokens(template)) {
      return null;
    }
    const ctx = this.buildRuleContext(resourceType, resource, shopName);
    return this.applyTemplate(template, ctx);
  },

  expectedSeoDescription(resourceType, resource, shopName, rules) {
    const template = rules?.seoDescription;
    if (!template || this.templateHasRandomTokens(template)) {
      return null;
    }
    const ctx = this.buildRuleContext(resourceType, resource, shopName);
    return this.applyTemplate(template, ctx);
  },

  buildImageFilenameContext(resourceType, resource, image, imageIndex, shopName, roomFallbackCache = {}) {
    if (resourceType === "product") {
      return this.productContext(resource, shopName, image, imageIndex, roomFallbackCache);
    }
    if (resourceType === "collection") {
      return this.collectionContext(resource, shopName, roomFallbackCache);
    }
    return this.articleContext(resource, shopName, roomFallbackCache);
  },

  expectedFilenameForImage(
    resourceType,
    resource,
    image,
    imageIndex,
    rules,
    shopName,
    usedFilenames,
    reserve = true
  ) {
    if (!rules?.imageFilename) {
      return null;
    }
    if (this.templateHasRandomTokens(rules.imageFilename)) {
      return null;
    }
    const url = image?.image?.url || image?.url;
    if (!url) {
      return null;
    }
    const currentFilename = EditProUtils.filenameFromUrl(url);
    const roomFallbackCache = {};
    const seedKey =
      resourceType === "product"
        ? `${resource.id}:${imageIndex}`
        : `${resource.id}:1`;
    const registry = usedFilenames || new Set();
    const filename = this.resolveUniqueImageFilename({
      template: rules.imageFilename,
      buildContext: () =>
        this.buildImageFilenameContext(
          resourceType,
          resource,
          image,
          imageIndex,
          shopName,
          roomFallbackCache
        ),
      seedKey,
      usedFilenames: registry,
      currentFilename,
      reserve,
    });
    return filename || null;
  },

  imageFilenameMatchesRule(
    resourceType,
    resource,
    image,
    imageIndex,
    rules,
    shopName,
    usedFilenames,
    reserve = false
  ) {
    const expected = this.expectedFilenameForImage(
      resourceType,
      resource,
      image,
      imageIndex,
      rules,
      shopName,
      usedFilenames,
      reserve
    );
    if (!expected) {
      return true;
    }
    const url = image?.image?.url || image?.url;
    const current = (EditProUtils.filenameFromUrl(url) || "").toLowerCase();
    return current === expected.toLowerCase();
  },

  VOLATILE_FILENAME_TOKEN:
    /\{\{\s*(room|image\.index|incrementing_number|random_tag|random_description)\s*\}\}/,

  filenamePrefixTemplate(template) {
    const value = String(template || "");
    const match = value.match(this.VOLATILE_FILENAME_TOKEN);
    if (!match || match.index == null) {
      return value;
    }
    return value.slice(0, match.index);
  },

  buildFilenamePrefix(prefixTemplate, ctx) {
    if (!prefixTemplate) {
      return "";
    }
    const raw = this.applyTemplate(prefixTemplate, ctx);
    let prefix = this.sanitizeField(raw);
    const trimmedTemplate = String(prefixTemplate).trimEnd();
    if (trimmedTemplate.endsWith("-") && prefix && !prefix.endsWith("-")) {
      prefix += "-";
    }
    return prefix.toLowerCase();
  },

  filenameBasename(filename) {
    const name = String(filename || "");
    if (!name) {
      return "";
    }
    const dot = name.lastIndexOf(".");
    return (dot > 0 ? name.slice(0, dot) : name).toLowerCase();
  },

  imageFilenameMatchesPrefix(resourceType, resource, image, imageIndex, rules, shopName) {
    if (!rules?.imageFilename || this.templateHasRandomTokens(rules.imageFilename)) {
      return true;
    }
    const prefixTemplate = this.filenamePrefixTemplate(rules.imageFilename);
    if (!prefixTemplate) {
      return true;
    }
    const url = image?.image?.url || image?.url;
    if (!url) {
      return true;
    }
    const ctx = this.buildImageFilenameContext(
      resourceType,
      resource,
      image,
      imageIndex,
      shopName,
      {}
    );
    const prefix = this.buildFilenamePrefix(prefixTemplate, ctx);
    if (!prefix) {
      return true;
    }
    const current = this.filenameBasename(EditProUtils.filenameFromUrl(url));
    return current.startsWith(prefix);
  },

  resourceHasFilenamePrefixMismatch(resourceType, resource, shopName) {
    const rules = this.getRulesForType(resourceType);
    if (!rules?.imageFilename) {
      return false;
    }

    if (resourceType === "product") {
      const images = resource.media?.nodes || [];
      if (!images.length) {
        return false;
      }
      for (let i = 0; i < images.length; i++) {
        const image = images[i];
        if (!image?.id) {
          continue;
        }
        if (
          !this.imageFilenameMatchesPrefix(
            "product",
            resource,
            image,
            i + 1,
            rules,
            shopName
          )
        ) {
          return true;
        }
      }
      return false;
    }

    const img = resource.image;
    if (!img?.url && !img?.id) {
      return false;
    }
    const type = resourceType === "collection" ? "collection" : "article";
    return !this.imageFilenameMatchesPrefix(type, resource, img, 1, rules, shopName);
  },

  resourceHasFilenameFormatMismatch(resourceType, resource, shopName, usedFilenames) {
    const rules = this.getRulesForType(resourceType);
    if (!rules?.imageFilename) {
      return false;
    }

    if (resourceType === "product") {
      const images = resource.media?.nodes || [];
      if (!images.length) {
        return false;
      }
      for (let i = 0; i < images.length; i++) {
        const image = images[i];
        if (!image?.id) {
          continue;
        }
        if (
          !this.imageFilenameMatchesRule(
            "product",
            resource,
            image,
            i + 1,
            rules,
            shopName,
            usedFilenames,
            false
          )
        ) {
          return true;
        }
      }
      return false;
    }

    const img = resource.image;
    if (!img?.url && !img?.id) {
      return false;
    }
    const type = resourceType === "collection" ? "collection" : "article";
    return !this.imageFilenameMatchesRule(
      type,
      resource,
      img,
      1,
      rules,
      shopName,
      usedFilenames,
      false
    );
  },

  annotateChange(change, fileUsageIndex) {
    const annotated = {
      ...change,
      changeId: this.makeChangeId(change),
      fieldKey: change.fieldKey || this.changeFieldKey(change),
    };
    if (change.mutation === "fileUpdate" && change.fileInput?.id) {
      annotated.fileId = change.fileInput.id;
      annotated.fileUsage = EditProFileUsage.getUsage(fileUsageIndex, change.fileInput.id);
    }
    return annotated;
  },

  buildProductChanges(product, rules, shopName, descriptionPhrases, usedFilenames = null) {
    const changes = [];
    const phrases = descriptionPhrases ?? window.EditProSettings?.descriptionPhrases;
    const roomFallbackCache = {};
    const filenameRegistry = usedFilenames || new Set();
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
        input: { id: product.id, seo: { title: seoTitle } },
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
        input: { id: product.id, seo: { description: seoDescription } },
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
      const filename = this.resolveUniqueImageFilename({
        template: rules.imageFilename,
        buildContext: () => ctx,
        seedKey: `${product.id}:${index + 1}`,
        usedFilenames: filenameRegistry,
        currentFilename,
      });

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
        const seedKey = `${product.id}:${index + 1}`;
        changes.push({
          resourceType: "product",
          resourceId: product.id,
          resourceTitle: product.title,
          field: `Image ${index + 1} filename`,
          current: currentFilename || "",
          proposed: filename,
          mutation: "fileUpdate",
          fileInput: { id: fileId, filename },
          ...this.filenameChangeMeta({
            template: rules.imageFilename,
            buildContext: () => ctx,
            seedKey,
            currentFilename,
          }),
        });
      }
    });

    return changes;
  },

  buildCollectionChanges(collection, rules, shopName, descriptionPhrases, usedFilenames = null) {
    const changes = [];
    const phrases = descriptionPhrases ?? window.EditProSettings?.descriptionPhrases;
    const roomFallbackCache = {};
    const filenameRegistry = usedFilenames || new Set();
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
        input: { id: collection.id, seo: { title: seoTitle } },
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
        input: { id: collection.id, seo: { description: seoDescription } },
      });
    }

    const fileId = collection.image?.id;
    if (fileId) {
      const currentFilename = EditProUtils.filenameFromUrl(collection.image?.url);
      const alt = this.applyTemplate(rules.imageAlt, ctx);
      const filename = this.resolveUniqueImageFilename({
        template: rules.imageFilename,
        buildContext: () => ctx,
        seedKey: `${collection.id}:1`,
        usedFilenames: filenameRegistry,
        currentFilename,
      });

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
        const seedKey = `${collection.id}:1`;
        changes.push({
          resourceType: "collection",
          resourceId: collection.id,
          resourceTitle: collection.title,
          field: "Image filename",
          current: currentFilename || "",
          proposed: filename,
          mutation: "fileUpdate",
          fileInput: { id: fileId, filename },
          ...this.filenameChangeMeta({
            template: rules.imageFilename,
            buildContext: () => ctx,
            seedKey,
            currentFilename,
          }),
        });
      }
    }

    return changes;
  },

  buildArticleChanges(article, rules, shopName, descriptionPhrases, usedFilenames = null) {
    const changes = [];
    const phrases = descriptionPhrases ?? window.EditProSettings?.descriptionPhrases;
    const roomFallbackCache = {};
    const filenameRegistry = usedFilenames || new Set();
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
      const filename = this.resolveUniqueImageFilename({
        template: rules.imageFilename,
        buildContext: () => ctx,
        seedKey: `${article.id}:1`,
        usedFilenames: filenameRegistry,
        currentFilename,
      });

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
        const seedKey = `${article.id}:1`;
        changes.push({
          resourceType: "article",
          resourceId: article.id,
          resourceTitle: article.title,
          field: "Image filename",
          current: currentFilename || "",
          proposed: filename,
          mutation: "fileUpdate",
          fileInput: { id: fileId, filename },
          ...this.filenameChangeMeta({
            template: rules.imageFilename,
            buildContext: () => ctx,
            seedKey,
            currentFilename,
          }),
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
    const usedFilenames = this.collectStoreFilenames(storeData);

    for (const product of storeData.products || []) {
      if (productIds && !productIds.has(product.id)) {
        continue;
      }
      changes.push(
        ...this.buildProductChanges(
          product,
          rules.product,
          shopName,
          descriptionPhrases,
          usedFilenames
        )
      );
    }
    for (const collection of storeData.collections || []) {
      if (collectionIds && !collectionIds.has(collection.id)) {
        continue;
      }
      changes.push(
        ...this.buildCollectionChanges(
          collection,
          rules.collection,
          shopName,
          descriptionPhrases,
          usedFilenames
        )
      );
    }
    for (const article of storeData.articles || []) {
      if (articleIds && !articleIds.has(article.id)) {
        continue;
      }
      changes.push(
        ...this.buildArticleChanges(
          article,
          rules.article,
          shopName,
          descriptionPhrases,
          usedFilenames
        )
      );
    }
    return changes.map((c) => this.annotateChange(c, fileUsageIndex));
  },
};
