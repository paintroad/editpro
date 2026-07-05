window.EditProCatalogQuality = {
  ISSUES: {
    filename: "Filename",
    altText: "Alt text",
    title: "Title",
    descriptionLength: "Description",
    descriptionParagraphs: "Description paragraphs",
    seoTitle: "SEO title",
    seoDescription: "SEO description",
  },

  THRESHOLDS: {
    seoTitleMax: 60,
    seoTitleWarnMin: 30,
    seoDescriptionMax: 160,
    altTextWarnMax: 125,
    titleMax: 100,
    titleWarnMin: 25,
    descriptionWarnMinWords: 50,
    descriptionParagraphsFailMinWords: 80,
    descriptionParagraphsWarnMinWords: 40,
  },

  RULE_WEIGHTS: {
    descriptionLength: 20,
    seoTitle: 18,
    title: 15,
    altText: 15,
    seoDescription: 12,
    descriptionParagraphs: 10,
    filename: 10,
  },

  ruleKeys() {
    return Object.keys(this.RULE_WEIGHTS);
  },

  mergeStatuses(results) {
    const list = results || [];
    if (!list.length) {
      return { status: "fail", hint: "No data" };
    }
    const fail = list.find((item) => item.status === "fail");
    if (fail) {
      return fail;
    }
    const warn = list.find((item) => item.status === "warn");
    if (warn) {
      return warn;
    }
    return { status: "pass", hint: null };
  },

  scoreResource(resourceType, resource) {
    let passedWeight = 0;
    for (const key of this.ruleKeys()) {
      const { status } = this.evaluateRule(resourceType, resource, key);
      if (status !== "fail") {
        passedWeight += this.RULE_WEIGHTS[key];
      }
    }
    return Math.round(passedWeight);
  },

  scoreBadgeClass(score) {
    if (score >= 80) {
      return "score-good";
    }
    if (score >= 60) {
      return "score-fair";
    }
    return "score-poor";
  },

  scoreCategory(resourceType, resources) {
    const list = resources || [];
    if (!list.length) {
      return 0;
    }
    const total = list.reduce(
      (sum, resource) => sum + this.scoreResource(resourceType, resource),
      0
    );
    return Math.round(total / list.length);
  },

  countFailures(resourceType, resources) {
    const failures = {};
    for (const key of this.ruleKeys()) {
      failures[key] = 0;
    }
    for (const resource of resources || []) {
      for (const key of this.getIssues(resourceType, resource)) {
        if (failures[key] != null) {
          failures[key] += 1;
        }
      }
    }
    return failures;
  },

  countWarnings(resourceType, resources) {
    const warnings = {};
    for (const key of this.ruleKeys()) {
      warnings[key] = 0;
    }
    for (const resource of resources || []) {
      for (const key of this.getWarnings(resourceType, resource)) {
        if (warnings[key] != null) {
          warnings[key] += 1;
        }
      }
    }
    return warnings;
  },

  auditSummary(storeData) {
    const products = storeData?.products || [];
    const collections = storeData?.collections || [];
    const articles = storeData?.articles || [];

    const productScore = this.scoreCategory("product", products);
    const collectionScore = this.scoreCategory("collection", collections);
    const articleScore = this.scoreCategory("article", articles);

    const categoryScores = [];
    if (products.length) {
      categoryScores.push(productScore);
    }
    if (collections.length) {
      categoryScores.push(collectionScore);
    }
    if (articles.length) {
      categoryScores.push(articleScore);
    }

    const siteScore = categoryScores.length
      ? Math.round(categoryScores.reduce((a, b) => a + b, 0) / categoryScores.length)
      : 0;

    return {
      siteScore,
      products: {
        score: productScore,
        total: products.length,
        failures: this.countFailures("product", products),
        warnings: this.countWarnings("product", products),
      },
      collections: {
        score: collectionScore,
        total: collections.length,
        failures: this.countFailures("collection", collections),
        warnings: this.countWarnings("collection", collections),
      },
      articles: {
        score: articleScore,
        total: articles.length,
        failures: this.countFailures("article", articles),
        warnings: this.countWarnings("article", articles),
      },
    };
  },

  getRulesForType(resourceType) {
    const rules = window.EditProSettings?.rules;
    if (!rules) {
      return null;
    }
    if (resourceType === "product") {
      return rules.product;
    }
    if (resourceType === "collection") {
      return rules.collection;
    }
    return rules.article;
  },

  getShopName() {
    return window.EditProSettings?.shopName || "";
  },

  getImageFilename(img) {
    return EditProUtils.filenameFromUrl(img?.image?.url || img?.url || "");
  },

  filenameHasUnderscores(filename) {
    const base = String(filename || "").split(".")[0];
    return base.includes("_");
  },

  expectedFilename(resourceType, resource, image, imageIndex, rules, shopName, randomContext) {
    if (!rules?.imageFilename) {
      return null;
    }
    if (EditProRules.templateHasRandomTokens(rules.imageFilename) && !randomContext) {
      return null;
    }
    const currentFilename = this.getImageFilename(image);
    let ctx;
    if (resourceType === "product") {
      ctx = EditProRules.productContext(resource, shopName, image, imageIndex);
    } else if (resourceType === "collection") {
      ctx = EditProRules.collectionContext(resource, shopName);
    } else {
      ctx = EditProRules.articleContext(resource, shopName);
    }
    if (randomContext) {
      ctx = EditProRules.mergeContext(ctx, randomContext);
    }
    return EditProRules.sanitizeFilename(
      EditProRules.applyTemplate(rules.imageFilename, ctx),
      currentFilename
    );
  },

  evaluateFilenameImage(resourceType, resource, image, imageIndex) {
    const actual = this.getImageFilename(image);
    if (!actual) {
      return { status: "fail", hint: "Missing filename" };
    }
    if (this.filenameHasUnderscores(actual)) {
      return { status: "fail", hint: "Use hyphens instead of underscores" };
    }
    const rules = this.getRulesForType(resourceType);
    const expected = this.expectedFilename(
      resourceType,
      resource,
      image,
      imageIndex,
      rules,
      this.getShopName()
    );
    if (expected && actual.toLowerCase() !== expected.toLowerCase()) {
      return {
        status: "fail",
        hint: `Does not match expected pattern (expected "${expected}")`,
      };
    }
    return { status: "pass", hint: null };
  },

  filenamePasses(resourceType, resource, image, imageIndex) {
    return this.evaluateFilenameImage(resourceType, resource, image, imageIndex).status !== "fail";
  },

  evaluateAltText(alt) {
    const len = String(alt || "").trim().length;
    if (!len) {
      return { status: "fail", hint: "Alt text missing" };
    }
    if (len > this.THRESHOLDS.altTextWarnMax) {
      return {
        status: "warn",
        hint: `${len} chars (keep under ${this.THRESHOLDS.altTextWarnMax})`,
      };
    }
    return { status: "pass", hint: null };
  },

  altTextPasses(alt) {
    return this.evaluateAltText(alt).status !== "fail";
  },

  evaluateTitle(title) {
    const len = String(title || "").trim().length;
    if (!len) {
      return { status: "fail", hint: "Title missing" };
    }
    if (len > this.THRESHOLDS.titleMax) {
      return { status: "fail", hint: `${len} chars (max ${this.THRESHOLDS.titleMax})` };
    }
    if (len < this.THRESHOLDS.titleWarnMin) {
      return {
        status: "warn",
        hint: `${len} chars (under ${this.THRESHOLDS.titleWarnMin} may be too short)`,
      };
    }
    return { status: "pass", hint: null };
  },

  titlePasses(title) {
    return this.evaluateTitle(title).status !== "fail";
  },

  evaluateSeoTitle(seoTitle) {
    const len = String(seoTitle || "").trim().length;
    if (len > this.THRESHOLDS.seoTitleMax) {
      return {
        status: "fail",
        hint: `${len} chars (max ${this.THRESHOLDS.seoTitleMax} — Google may truncate)`,
      };
    }
    if (len > 0 && len < this.THRESHOLDS.seoTitleWarnMin) {
      return {
        status: "warn",
        hint: `${len} chars (under ${this.THRESHOLDS.seoTitleWarnMin} may be weak in search results)`,
      };
    }
    return { status: "pass", hint: null };
  },

  seoTitlePasses(seoTitle) {
    return this.evaluateSeoTitle(seoTitle).status !== "fail";
  },

  evaluateSeoDescription(seoDescription) {
    const len = String(seoDescription || "").trim().length;
    if (len > this.THRESHOLDS.seoDescriptionMax) {
      return {
        status: "fail",
        hint: `${len} chars (max ${this.THRESHOLDS.seoDescriptionMax} — Google may truncate)`,
      };
    }
    if (!len) {
      return { status: "warn", hint: "Empty — add a meta description for better CTR" };
    }
    return { status: "pass", hint: null };
  },

  seoDescriptionPasses(seoDescription) {
    return this.evaluateSeoDescription(seoDescription).status !== "fail";
  },

  getBodyDescription(resourceType, resource) {
    if (resourceType === "article") {
      return resource.summary || "";
    }
    return resource.descriptionHtml || "";
  },

  evaluateDescriptionLength(resourceType, resource) {
    const body = this.getBodyDescription(resourceType, resource);
    const trimmed = String(body || "").trim();
    if (!trimmed) {
      return { status: "pass", hint: null };
    }
    const words = EditProUtils.wordCount(body);
    if (words < this.THRESHOLDS.descriptionWarnMinWords) {
      return {
        status: "warn",
        hint: `${words} words (consider expanding beyond ${this.THRESHOLDS.descriptionWarnMinWords} for more detail)`,
      };
    }
    return { status: "pass", hint: null };
  },

  descriptionLengthPasses() {
    return true;
  },

  evaluateDescriptionParagraphs(resourceType, resource) {
    const body = this.getBodyDescription(resourceType, resource);
    const words = EditProUtils.wordCount(body);
    if (words < this.THRESHOLDS.descriptionParagraphsWarnMinWords) {
      return { status: "pass", hint: null };
    }
    if (EditProUtils.hasParagraphStructure(body)) {
      return { status: "pass", hint: null };
    }
    if (words >= this.THRESHOLDS.descriptionParagraphsFailMinWords) {
      return { status: "fail", hint: "Long description lacks paragraph or list structure" };
    }
    return {
      status: "warn",
      hint: "Consider breaking description into paragraphs or bullet points",
    };
  },

  descriptionParagraphsPass(resourceType, resource) {
    return this.evaluateDescriptionParagraphs(resourceType, resource).status !== "fail";
  },

  productImages(product) {
    return product.media?.nodes || [];
  },

  evaluateFilenameRule(resourceType, resource) {
    if (resourceType === "product") {
      const images = this.productImages(resource);
      if (!images.length) {
        return { status: "fail", hint: "No images" };
      }
      return this.mergeStatuses(
        images.map((img, index) =>
          this.evaluateFilenameImage(resourceType, resource, img, index + 1)
        )
      );
    }
    const img = resource.image;
    if (!img?.url && !img?.id) {
      return { status: "fail", hint: "No images" };
    }
    return this.evaluateFilenameImage(resourceType, resource, img, 1);
  },

  evaluateAltTextRule(resourceType, resource) {
    if (resourceType === "product") {
      const images = this.productImages(resource);
      if (!images.length) {
        return { status: "fail", hint: "No images" };
      }
      return this.mergeStatuses(images.map((img) => this.evaluateAltText(img.alt)));
    }
    const img = resource.image;
    if (!img?.url && !img?.id) {
      return { status: "fail", hint: "No images" };
    }
    return this.evaluateAltText(img.alt);
  },

  evaluateRule(resourceType, resource, ruleKey) {
    switch (ruleKey) {
      case "filename":
        return this.evaluateFilenameRule(resourceType, resource);
      case "altText":
        return this.evaluateAltTextRule(resourceType, resource);
      case "title":
        return this.evaluateTitle(resource.title);
      case "descriptionLength":
        return this.evaluateDescriptionLength(resourceType, resource);
      case "descriptionParagraphs":
        return this.evaluateDescriptionParagraphs(resourceType, resource);
      case "seoTitle":
        return this.evaluateSeoTitle(resource.seo?.title);
      case "seoDescription":
        return this.evaluateSeoDescription(resource.seo?.description);
      default:
        return { status: "pass", hint: null };
    }
  },

  getIssues(resourceType, resource) {
    const issues = [];
    for (const key of this.ruleKeys()) {
      if (this.evaluateRule(resourceType, resource, key).status === "fail") {
        issues.push(key);
      }
    }
    return issues;
  },

  getWarnings(resourceType, resource) {
    const warnings = [];
    for (const key of this.ruleKeys()) {
      if (this.evaluateRule(resourceType, resource, key).status === "warn") {
        warnings.push(key);
      }
    }
    return warnings;
  },

  resourceImages(resourceType, resource) {
    if (resourceType === "product") {
      return this.productImages(resource);
    }
    if (resource.image?.url || resource.image?.id) {
      return [resource.image];
    }
    return [];
  },

  getImageCompliance(resourceType, resource, image, imageIndex) {
    const filename = this.evaluateFilenameImage(resourceType, resource, image, imageIndex);
    const altText = this.evaluateAltText(image.alt);
    return {
      filename: {
        status: filename.status,
        pass: filename.status === "pass",
        hint: filename.status === "pass" ? null : filename.hint,
      },
      altText: {
        status: altText.status,
        pass: altText.status === "pass",
        hint: altText.status === "pass" ? null : altText.hint,
      },
    };
  },

  getFilenameHintForImage(resourceType, resource, image, imageIndex) {
    return this.evaluateFilenameImage(resourceType, resource, image, imageIndex).hint;
  },

  getAltHintForImage(image) {
    const result = this.evaluateAltText(image?.alt);
    return result.status === "pass" ? null : result.hint;
  },

  getRuleHint(resourceType, resource, ruleKey) {
    const { status, hint } = this.evaluateRule(resourceType, resource, ruleKey);
    if (status === "pass") {
      return null;
    }
    return hint;
  },

  getComplianceReport(resourceType, resource) {
    return this.ruleKeys().map((key) => {
      const { status, hint } = this.evaluateRule(resourceType, resource, key);
      return {
        key,
        label: this.ISSUES[key],
        status,
        pass: status === "pass",
        hint: status === "pass" ? null : hint,
        weight: this.RULE_WEIGHTS[key],
      };
    });
  },

  mapChangeFieldToRule(field) {
    const name = String(field || "");
    if (name === "SEO title") {
      return "seoTitle";
    }
    if (name === "SEO description") {
      return "seoDescription";
    }
    if (name === "Tags") {
      return null;
    }
    if (/alt/i.test(name)) {
      return "altText";
    }
    if (/filename/i.test(name)) {
      return "filename";
    }
    return null;
  },

  findImageForChange(change, resource) {
    const resourceType = change.resourceType;
    if (change.fileInput?.id) {
      if (resourceType === "product") {
        const images = this.productImages(resource);
        const index = images.findIndex((img) => img.id === change.fileInput.id);
        if (index >= 0) {
          return { image: images[index], imageIndex: index + 1 };
        }
      } else if (resource.image?.id === change.fileInput.id) {
        return { image: resource.image, imageIndex: 1 };
      }
    }

    const match = String(change.field || "").match(/Image (\d+)/i);
    if (match && resourceType === "product") {
      const index = parseInt(match[1], 10) - 1;
      const images = this.productImages(resource);
      if (images[index]) {
        return { image: images[index], imageIndex: index + 1 };
      }
    }

    if (resourceType !== "product" && resource.image) {
      return { image: resource.image, imageIndex: 1 };
    }

    return null;
  },

  imageWithProposedFilename(image, proposedFilename) {
    const url = image?.image?.url || image?.url || "";
    if (!url) {
      return {
        ...image,
        image: { ...(image?.image || {}), url: proposedFilename },
        url: proposedFilename,
      };
    }
    try {
      const parsed = new URL(url);
      const parts = parsed.pathname.split("/");
      parts[parts.length - 1] = proposedFilename;
      parsed.pathname = parts.join("/");
      const nextUrl = parsed.toString();
      return {
        ...image,
        image: { ...(image?.image || {}), url: nextUrl },
        url: nextUrl,
      };
    } catch {
      return {
        ...image,
        image: { ...(image?.image || {}), url: proposedFilename },
        url: proposedFilename,
      };
    }
  },

  evaluateProposedValue(ruleKey, proposed, resourceType, resource, imageInfo) {
    if (ruleKey === "seoTitle") {
      return this.evaluateSeoTitle(proposed);
    }
    if (ruleKey === "seoDescription") {
      return this.evaluateSeoDescription(proposed);
    }
    if (ruleKey === "altText") {
      return this.evaluateAltText(proposed);
    }
    if (ruleKey === "filename") {
      if (!imageInfo || !proposed) {
        return { status: "fail", hint: "Missing image or filename" };
      }
      const imageClone = this.imageWithProposedFilename(imageInfo.image, proposed);
      return this.evaluateFilenameImage(
        resourceType,
        resource,
        imageClone,
        imageInfo.imageIndex
      );
    }
    return { status: "pass", hint: null };
  },

  evaluateProposedChange(change, resource) {
    const ruleKey = this.mapChangeFieldToRule(change.field);
    if (!ruleKey) {
      return {
        applicable: false,
        status: null,
        pass: null,
        ruleKey: null,
        ruleLabel: null,
        hint: null,
      };
    }

    const proposed = change.proposed ?? change.displayProposed ?? change.newValue ?? "";
    const imageInfo =
      ruleKey === "filename" && resource
        ? this.findImageForChange(change, resource)
        : null;
    const { status, hint } = this.evaluateProposedValue(
      ruleKey,
      proposed,
      change.resourceType,
      resource,
      imageInfo
    );

    return {
      applicable: true,
      status,
      pass: status === "pass",
      ruleKey,
      ruleLabel: this.ISSUES[ruleKey],
      hint: status === "pass" ? null : hint,
    };
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

  chipsForTab(_tab) {
    return Object.keys(this.ISSUES);
  },
};
