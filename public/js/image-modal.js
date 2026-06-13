window.EditProImageModal = {
  init() {
    this.modal = document.getElementById("imageModal");
    this.body = document.getElementById("imageModalBody");
    this.titleEl = document.getElementById("imageModalTitle");
    this.fileUsageIndex = null;

    document.getElementById("imageModalClose")?.addEventListener("click", () => this.close());
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

  getImages(type, resource) {
    if (type === "product") {
      return (resource.media?.nodes || []).map((node) => ({
        id: node.id,
        url: node.image?.url || node.url,
        alt: node.alt || "",
      }));
    }
    if (resource.image?.url) {
      return [
        {
          id: resource.image.id,
          url: resource.image.url,
          alt: resource.image.alt || "",
        },
      ];
    }
    return [];
  },

  open({ type, resource }) {
    if (!this.modal || !this.body) {
      return;
    }

    const labels = { product: "Product", collection: "Collection", article: "Blog article" };
    this.titleEl.textContent = `${labels[type] || type}: ${resource.title}`;

    const images = this.getImages(type, resource);
    if (images.length === 0) {
      this.body.innerHTML = '<p class="meta">No images for this resource.</p>';
    } else {
      this.body.innerHTML = `<div class="image-modal-grid">${images
        .map((img, i) => {
          const filename = EditProUtils.filenameFromUrl(img.url);
          const usage = EditProFileUsage.getUsage(this.fileUsageIndex, img.id, img.url);
          const shared = EditProFileUsage.isShared(usage)
            ? ' <span class="badge badge-warning">Shared</span>'
            : "";
          return `<div class="image-modal-card">
            <img src="${EditProUtils.escapeHtml(img.url)}" alt="" class="image-modal-preview" loading="lazy" />
            <div class="image-modal-meta">
              <strong>Image ${i + 1}</strong>
              <div class="meta"><span class="label">Filename:</span> ${EditProUtils.escapeHtml(filename || "—")}${shared}</div>
              <div class="meta"><span class="label">Alt text:</span> ${EditProUtils.escapeHtml(img.alt || "—")}</div>
              <div class="meta image-usage">Used on: ${EditProUtils.escapeHtml(EditProFileUsage.formatUsage(usage))}</div>
            </div>
          </div>`;
        })
        .join("")}</div>`;
    }

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
      document.body.classList.remove("modal-open");
    }
  },
};
