window.EditProCatalogQuality = {
  ISSUES: {
    shortFilename: "Short filename",
    shortAlt: "Short/missing alt",
    emptySeoTitle: "Empty SEO title",
    emptySeoDescription: "Empty SEO description",
    emptyTags: "Empty tags",
  },

  MIN_LEN: 15,

  isShort(value) {
    return String(value || "").trim().length < this.MIN_LEN;
  },

  isEmpty(value) {
    return !String(value || "").trim();
  },

  getImageFilename(img) {
    return EditProUtils.filenameFromUrl(img?.image?.url || img?.url || "");
  },

  productImages(product) {
    return product.media?.nodes || [];
  },

  getProductIssues(product) {
    const issues = [];
    const images = this.productImages(product);

    if (images.length === 0) {
      issues.push("shortFilename", "shortAlt");
    } else {
      if (images.some((img) => this.isShort(this.getImageFilename(img)))) {
        issues.push("shortFilename");
      }
      if (images.some((img) => this.isEmpty(img.alt) || this.isShort(img.alt))) {
        issues.push("shortAlt");
      }
    }

    if (this.isEmpty(product.seo?.title)) {
      issues.push("emptySeoTitle");
    }
    if (this.isEmpty(product.seo?.description)) {
      issues.push("emptySeoDescription");
    }
    if (!product.tags?.length) {
      issues.push("emptyTags");
    }
    return issues;
  },

  getCollectionIssues(collection) {
    const issues = [];
    const img = collection.image;

    if (!img?.url) {
      issues.push("shortFilename", "shortAlt");
    } else {
      if (this.isShort(this.getImageFilename(img))) {
        issues.push("shortFilename");
      }
      if (this.isEmpty(img.alt) || this.isShort(img.alt)) {
        issues.push("shortAlt");
      }
    }

    if (this.isEmpty(collection.seo?.title)) {
      issues.push("emptySeoTitle");
    }
    if (this.isEmpty(collection.seo?.description)) {
      issues.push("emptySeoDescription");
    }
    return issues;
  },

  getArticleIssues(article) {
    const issues = [];
    const img = article.image;

    if (!img?.url) {
      issues.push("shortFilename", "shortAlt");
    } else {
      if (this.isShort(this.getImageFilename(img))) {
        issues.push("shortFilename");
      }
      if (this.isEmpty(img.alt) || this.isShort(img.alt)) {
        issues.push("shortAlt");
      }
    }

    if (this.isEmpty(article.seo?.title)) {
      issues.push("emptySeoTitle");
    }
    if (this.isEmpty(article.seo?.description)) {
      issues.push("emptySeoDescription");
    }
    if (!article.tags?.length) {
      issues.push("emptyTags");
    }
    return issues;
  },

  getIssues(resourceType, resource) {
    if (resourceType === "product") {
      return this.getProductIssues(resource);
    }
    if (resourceType === "collection") {
      return this.getCollectionIssues(resource);
    }
    return this.getArticleIssues(resource);
  },

  matchesQualityFilter(resourceType, resource, selectedIssues) {
    if (!selectedIssues || selectedIssues.size === 0) {
      return true;
    }
    const issues = this.getIssues(resourceType, resource);
    for (const key of selectedIssues) {
      if (issues.includes(key)) {
        return true;
      }
    }
    return false;
  },

  chipsForTab(tab) {
    const all = Object.keys(this.ISSUES);
    if (tab === "collections") {
      return all.filter((k) => k !== "emptyTags");
    }
    return all;
  },
};
