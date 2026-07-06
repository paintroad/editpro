(function initCatalogShopifyPush() {
  const shopifyBtn = document.getElementById("catalogShopifyBtn");

  async function openShopifyPreview() {
    const productIds = window.EditProCatalog?.getSelectedShopifyProductIds?.() || [];
    if (!productIds.length) {
      window.EditProCatalog?.showMessage?.(
        "Select enriched products with lifestyle images to add to Shopify.",
        "warning"
      );
      return;
    }

    const rows = window.EditProCatalog?.getProducts?.() || [];
    const notFixed = productIds.filter((id) => {
      const row = rows.find((p) => p.productId === id);
      return row && row.seoStatus !== "fixed";
    });
    if (notFixed.length) {
      const proceed = window.confirm(
        `${notFixed.length} selected product${notFixed.length === 1 ? "" : "s"} have not had Fix SEO applied yet. Continue anyway?`
      );
      if (!proceed) {
        return;
      }
    }

    const preview = await EditProUtils.apiPost("/api/catalog/shopify/preview", { productIds });
    const changes = preview.changes || [];
    if (!changes.length) {
      window.EditProCatalog?.showMessage?.("No products to push.", "warning");
      return;
    }

    EditProPreviewModal.open({
      mode: "catalog-shopify",
      title: "Add to Shopify preview",
      changes,
      onComplete: async () => {
        await window.EditProCatalog?.refreshProducts?.();
      },
    });
  }

  shopifyBtn?.addEventListener("click", async () => {
    shopifyBtn.disabled = true;
    try {
      await openShopifyPreview();
    } catch (error) {
      window.EditProCatalog?.showMessage?.(
        error.message || "Failed to build Shopify preview.",
        "error"
      );
    } finally {
      shopifyBtn.disabled = false;
    }
  });
})();
