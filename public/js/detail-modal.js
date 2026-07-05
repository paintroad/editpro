window.EditProDetailModal = {
  init() {
    this.modal = document.getElementById("detailModal");
    this.body = document.getElementById("detailModalBody");
    this.titleEl = document.getElementById("detailModalTitle");
    this.fileUsageIndex = null;

    document.getElementById("detailModalClose")?.addEventListener("click", () => this.close());
    this.modal?.querySelector(".modal-backdrop")?.addEventListener("click", () => this.close());
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.modal && !this.modal.hidden) {
        this.close();
      }
    });
  },

  setFileUsageIndex(index) {
    this.fileUsageIndex = index;
  },

  renderComplianceBadge(status) {
    if (status === "warn") {
      return `<span class="compliance-badge compliance-warn">Warning</span>`;
    }
    if (status === "pass") {
      return `<span class="compliance-badge compliance-pass">Compliant</span>`;
    }
    return `<span class="compliance-badge compliance-fail">Non-compliant</span>`;
  },

  renderComplianceRow(rule, fieldValue) {
    const rowClass =
      rule.status === "pass"
        ? "detail-field--pass"
        : rule.status === "warn"
          ? "detail-field--warn"
          : "detail-field--fail";
    const hintHtml = rule.hint
      ? `<div class="compliance-hint">${EditProUtils.escapeHtml(rule.hint)}</div>`
      : "";
    const valueHtml = fieldValue
      ? `<div class="detail-field-value">${fieldValue}</div>`
      : "";
    return `<div class="detail-field-row ${rowClass}">
      <div class="detail-field-head">
        <span class="detail-field-label">${EditProUtils.escapeHtml(rule.label)}</span>
        ${this.renderComplianceBadge(rule.status)}
      </div>
      ${valueHtml}
      ${hintHtml}
    </div>`;
  },

  getFieldValueHtml(type, resource, ruleKey) {
    if (ruleKey === "title") {
      return EditProUtils.escapeHtml(resource.title || "—");
    }
    if (ruleKey === "descriptionLength" || ruleKey === "descriptionParagraphs") {
      const body = EditProCatalogQuality.getBodyDescription(type, resource);
      const words = EditProUtils.wordCount(body);
      if (!body.trim()) {
        return "—";
      }
      const preview = EditProUtils.escapeHtml(EditProUtils.truncate(EditProUtils.stripHtml(body), 200));
      return `${preview} <span class="meta">(${words} words)</span>`;
    }
    if (ruleKey === "seoTitle") {
      const value = resource.seo?.title || "—";
      const len = String(resource.seo?.title || "").trim().length;
      return len
        ? `${EditProUtils.escapeHtml(value)} <span class="meta">(${len} chars)</span>`
        : EditProUtils.escapeHtml(value);
    }
    if (ruleKey === "seoDescription") {
      const value = resource.seo?.description || "—";
      const len = String(resource.seo?.description || "").trim().length;
      return len
        ? `${EditProUtils.escapeHtml(EditProUtils.truncate(value, 200))} <span class="meta">(${len} chars)</span>`
        : EditProUtils.escapeHtml(value);
    }
    if (ruleKey === "filename" || ruleKey === "altText") {
      const images = EditProCatalogQuality.resourceImages(type, resource);
      if (!images.length) {
        return "No images";
      }
      return `${images.length} image${images.length === 1 ? "" : "s"} — see details below`;
    }
    return "";
  },

  renderImageComplianceLine(compliance, label) {
    const status = compliance.status || (compliance.pass ? "pass" : "fail");
    const cls =
      status === "pass" ? "compliance-pass" : status === "warn" ? "compliance-warn" : "compliance-fail";
    const statusLabel =
      status === "pass" ? "Compliant" : status === "warn" ? "Warning" : "Non-compliant";
    const hint = compliance.hint
      ? ` · ${EditProUtils.escapeHtml(compliance.hint)}`
      : "";
    return `<div class="image-compliance-line"><span class="image-compliance-label">${EditProUtils.escapeHtml(label)}:</span> <span class="compliance-badge ${cls}">${statusLabel}</span>${hint}</div>`;
  },

  renderImageList(images, resourceType, resource) {
    if (!images?.length) {
      return "<p class=\"meta\">No images</p>";
    }
    return images
      .map((img, i) => {
        const fileId = img.id;
        const filename = EditProUtils.filenameFromUrl(img.image?.url || img.url);
        const usage = EditProFileUsage.getUsage(this.fileUsageIndex, fileId, img.image?.url || img.url);
        const usageText = EditProFileUsage.formatUsage(usage);
        const shared = EditProFileUsage.isShared(usage)
          ? ' <span class="badge badge-warning">Shared</span>'
          : "";
        const compliance = EditProCatalogQuality.getImageCompliance(
          resourceType,
          resource,
          img,
          i + 1
        );
        return `<div class="image-detail-row">
          <strong>Image ${i + 1}:</strong> ${EditProUtils.escapeHtml(filename || "—")}${shared}
          <div class="meta">alt: ${EditProUtils.escapeHtml(img.alt || "—")}</div>
          ${this.renderImageComplianceLine(compliance.filename, "Filename")}
          ${this.renderImageComplianceLine(compliance.altText, "Alt text")}
          <div class="image-usage meta">Used on: ${EditProUtils.escapeHtml(usageText)}</div>
        </div>`;
      })
      .join("");
  },

  renderScoreHero(type, resource) {
    const score = EditProCatalogQuality.scoreResource(type, resource);
    const scoreClass = EditProCatalogQuality.scoreBadgeClass(score);
    return `<div class="detail-score-hero">
      <span class="score-badge score-badge-lg ${scoreClass}">${score}</span>
      <span class="detail-score-label">SEO score / 100</span>
    </div>`;
  },

  renderComplianceList(type, resource) {
    const report = EditProCatalogQuality.getComplianceReport(type, resource);
    const rows = report
      .map((rule) => this.renderComplianceRow(rule, this.getFieldValueHtml(type, resource, rule.key)))
      .join("");
    return `<div class="detail-compliance-list">${rows}</div>`;
  },

  renderMetaSection(type, resource) {
    let html = `<div class="detail-meta-section">
      <p class="detail-meta-line"><strong>Handle:</strong> ${EditProUtils.escapeHtml(resource.handle || "—")}</p>`;

    if (type === "product") {
      html += `<p class="detail-meta-line"><strong>Product type:</strong> ${EditProUtils.escapeHtml(resource.productType || "—")}</p>`;
      html += `<p class="detail-meta-line"><strong>Tags:</strong> ${EditProUtils.escapeHtml((resource.tags || []).join(", ") || "—")}</p>`;
      html += `<p class="detail-meta-line"><strong>Collections:</strong> ${EditProUtils.escapeHtml((resource.collections?.nodes || []).map((c) => c.title).join(", ") || "—")}</p>`;
    } else if (type === "collection") {
      html += `<p class="detail-meta-line"><strong>Type:</strong> ${EditProUtils.escapeHtml(resource.collectionType || "custom")}</p>`;
      html += `<p class="detail-meta-line"><strong>Products:</strong> ${resource.productCount ?? 0}</p>`;
    } else {
      html += `<p class="detail-meta-line"><strong>Blog:</strong> ${EditProUtils.escapeHtml(resource.blog?.title || "—")}</p>`;
      html += `<p class="detail-meta-line"><strong>Tags:</strong> ${EditProUtils.escapeHtml((resource.tags || []).join(", ") || "—")}</p>`;
    }

    html += "</div>";
    return html;
  },

  renderImagesSection(type, resource) {
    let images = [];
    if (type === "product") {
      images = resource.media?.nodes || [];
    } else if (resource.image?.url || resource.image?.id) {
      images = [resource.image];
    }
    if (!images.length) {
      return "";
    }
    return `<div class="detail-images-section">
      <h3 class="detail-section-title">Images</h3>
      <div class="image-details">${this.renderImageList(images, type, resource)}</div>
    </div>`;
  },

  open({ type, resource }) {
    if (!this.modal || !this.body) {
      return;
    }

    const labels = { product: "Product", collection: "Collection", article: "Blog article" };
    this.titleEl.textContent = `${labels[type] || type}: ${resource.title}`;

    let html = this.renderScoreHero(type, resource);
    html += this.renderComplianceList(type, resource);
    html += this.renderMetaSection(type, resource);
    html += this.renderImagesSection(type, resource);

    this.body.innerHTML = html;
    this.modal.hidden = false;
    document.body.classList.add("modal-open");
  },

  close() {
    if (!this.modal) {
      return;
    }
    this.modal.hidden = true;
    if (typeof EditProPreviewModal?.resetModalOpenClass === "function") {
      EditProPreviewModal.resetModalOpenClass();
    } else {
      const settingsOpen = document.getElementById("settingsModal")?.hidden === false;
      if (!settingsOpen) {
        document.body.classList.remove("modal-open");
      }
    }
  },
};
