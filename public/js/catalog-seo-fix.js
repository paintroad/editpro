(function initCatalogSeoFix() {
  const fixSeoBtn = document.getElementById("catalogFixSeoBtn");

  async function openFixSeoPreview() {
    const productIds = window.EditProCatalog?.getSelectedSeoFixProductIds?.() || [];
    if (!productIds.length) {
      window.EditProCatalog?.showMessage?.(
        "Select enriched products with lifestyle images to fix SEO.",
        "warning"
      );
      return;
    }

    const preview = await EditProUtils.apiPost("/api/catalog/fix-seo/preview", { productIds });
    const changes = preview.changes || [];
    if (!changes.length) {
      window.EditProCatalog?.showMessage?.("No SEO changes needed for the selected products.", "success");
      return;
    }

    EditProPreviewModal.open({
      mode: "catalog-seo",
      title: "Fix SEO preview",
      changes,
      onComplete: async () => {
        await window.EditProCatalog?.refreshProducts?.();
      },
    });
  }

  fixSeoBtn?.addEventListener("click", async () => {
    fixSeoBtn.disabled = true;
    try {
      await openFixSeoPreview();
    } catch (error) {
      window.EditProCatalog?.showMessage?.(error.message || "Failed to build SEO preview.", "error");
    } finally {
      fixSeoBtn.disabled = false;
    }
  });
})();
