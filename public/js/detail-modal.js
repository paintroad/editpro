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

  renderImageList(images) {
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
        return `<div class="image-detail-row">
          <strong>Image ${i + 1}:</strong> ${EditProUtils.escapeHtml(filename || "—")}
          · alt: ${EditProUtils.escapeHtml(img.alt || "—")}${shared}
          <div class="image-usage meta">Used on: ${EditProUtils.escapeHtml(usageText)}</div>
        </div>`;
      })
      .join("");
  },

  open({ type, resource }) {
    if (!this.modal || !this.body) {
      return;
    }

    const labels = { product: "Product", collection: "Collection", article: "Blog article" };
    this.titleEl.textContent = `${labels[type] || type}: ${resource.title}`;

    let html = `<p><strong>Handle:</strong> ${EditProUtils.escapeHtml(resource.handle || "—")}</p>`;
    html += `<p><strong>SEO title:</strong> ${EditProUtils.escapeHtml(resource.seo?.title || "—")}</p>`;
    html += `<p><strong>SEO description:</strong> ${EditProUtils.escapeHtml(EditProUtils.truncate(resource.seo?.description, 200) || "—")}</p>`;

    if (type === "product") {
      html += `<p><strong>Product type:</strong> ${EditProUtils.escapeHtml(resource.productType || "—")}</p>`;
      html += `<p><strong>Tags:</strong> ${EditProUtils.escapeHtml((resource.tags || []).join(", ") || "—")}</p>`;
      html += `<p><strong>Collections:</strong> ${EditProUtils.escapeHtml((resource.collections?.nodes || []).map((c) => c.title).join(", ") || "—")}</p>`;
      html += `<div class="image-details">${this.renderImageList(resource.media?.nodes || [])}</div>`;
    } else if (type === "collection") {
      html += `<p><strong>Type:</strong> ${EditProUtils.escapeHtml(resource.collectionType || "custom")}</p>`;
      html += `<p><strong>Products:</strong> ${resource.productCount ?? 0}</p>`;
      if (resource.image?.url) {
        html += `<div class="image-details">${this.renderImageList([resource.image])}</div>`;
      }
    } else {
      html += `<p><strong>Blog:</strong> ${EditProUtils.escapeHtml(resource.blog?.title || "—")}</p>`;
      html += `<p><strong>Tags:</strong> ${EditProUtils.escapeHtml((resource.tags || []).join(", ") || "—")}</p>`;
      if (resource.image?.url) {
        html += `<div class="image-details">${this.renderImageList([resource.image])}</div>`;
      }
    }

    const issues = EditProCatalogQuality.getIssues(type, resource);
    if (issues.length) {
      html += `<p><strong>Quality flags:</strong> ${issues.map((k) => EditProUtils.escapeHtml(EditProCatalogQuality.ISSUES[k])).join(", ")}</p>`;
    }

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
