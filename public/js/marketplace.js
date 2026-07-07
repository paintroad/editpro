(function initMarketplaceModule() {
  const STORAGE_PREFIX = "editpro-marketplace-sample-";
  const DOWNLOAD_PATH_KEY = "editpro-marketplace-download-path";
  const SHOPIFY_FILTER_KEY = "editpro-marketplace-shopify-filter";

  const cardsEl = document.getElementById("marketplaceCards");
  const messageEl = document.getElementById("marketplaceMessage");
  const productCountBadge = document.getElementById("marketplaceProductCountBadge");
  const statsMeta = document.getElementById("marketplaceStatsMeta");
  const sourceNote = document.getElementById("marketplaceSourceNote");
  const sourceInputs = document.querySelectorAll('input[name="marketplaceSource"]');
  const shopifyFilterWrap = document.getElementById("marketplaceShopifyFilterWrap");
  const shopifyFilterSelect = document.getElementById("marketplaceShopifyFilter");
  const downloadPathInput = document.getElementById("marketplaceDownloadPath");
  const downloadPathBtn = document.getElementById("marketplaceDownloadPathBtn");
  const downloadPathMeta = document.getElementById("marketplaceDownloadPathMeta");

  let marketplaces = [];
  let currentSource = "shopify";
  let loading = false;

  function loadDownloadPath() {
    try {
      return localStorage.getItem(DOWNLOAD_PATH_KEY) || "";
    } catch {
      return "";
    }
  }

  function saveDownloadPath(value) {
    try {
      if (value) {
        localStorage.setItem(DOWNLOAD_PATH_KEY, value);
      } else {
        localStorage.removeItem(DOWNLOAD_PATH_KEY);
      }
    } catch {
      // ignore
    }
  }

  function getDownloadPath() {
    return downloadPathInput?.value?.trim() || loadDownloadPath();
  }

  function updateDownloadPathMeta() {
    if (!downloadPathMeta) {
      return;
    }
    const value = getDownloadPath();
    downloadPathMeta.textContent = value
      ? `Exports will be saved to: ${value}`
      : "Leave blank to keep exports in the app's default location. Applies to all marketplaces.";
  }

  function getSelectedSource() {
    const checked = document.querySelector('input[name="marketplaceSource"]:checked');
    return checked?.value || "shopify";
  }

  function loadShopifyFilter() {
    try {
      return localStorage.getItem(SHOPIFY_FILTER_KEY) || "live";
    } catch {
      return "live";
    }
  }

  function saveShopifyFilter(value) {
    try {
      localStorage.setItem(SHOPIFY_FILTER_KEY, value);
    } catch {
      // ignore
    }
  }

  function getShopifyProductFilter() {
    return shopifyFilterSelect?.value || loadShopifyFilter();
  }

  function updateShopifyFilterVisibility() {
    const isShopify = getSelectedSource() === "shopify";
    if (shopifyFilterWrap) {
      shopifyFilterWrap.hidden = !isShopify;
    }
  }

  function shopifyFilterLabel(filter) {
    switch (filter) {
      case "live":
        return "live Shopify products";
      case "drafts":
        return "Shopify drafts";
      case "all":
      default:
        return "all Shopify products";
    }
  }

  function buildRequestPayload(marketplaceId, samplePath) {
    const payload = {
      marketplaceId,
      samplePath,
      source: currentSource,
    };
    if (currentSource === "shopify") {
      payload.shopifyProductFilter = getShopifyProductFilter();
    }
    return payload;
  }

  function saveSamplePath(marketplaceId, value) {
    try {
      localStorage.setItem(`${STORAGE_PREFIX}${marketplaceId}`, value);
    } catch {
      // ignore
    }
  }

  function loadSamplePath(marketplaceId, fallback = "") {
    try {
      return localStorage.getItem(`${STORAGE_PREFIX}${marketplaceId}`) || fallback;
    } catch {
      return fallback;
    }
  }

  function updateSourceNote() {
    if (!sourceNote) {
      return;
    }
    if (currentSource === "catalog") {
      sourceNote.textContent =
        "Catalog Builder includes variant pricing and metafields, but image URL columns stay blank unless products were pushed to Shopify.";
    } else {
      sourceNote.textContent =
        "Shopify live includes public image URLs and variant pricing from your connected store.";
    }
  }

  function renderCards() {
    if (!cardsEl) {
      return;
    }

    if (!marketplaces.length) {
      cardsEl.innerHTML = '<p class="catalog-empty">Loading marketplaces…</p>';
      return;
    }

    cardsEl.innerHTML = marketplaces
      .map((marketplace) => {
        const samplePath = loadSamplePath(marketplace.id, marketplace.defaultSamplePath || "");
        return `
          <section class="card marketplace-card" data-marketplace-id="${EditProUtils.escapeHtml(marketplace.id)}">
            <div class="marketplace-card-header">
              <div>
                <h2>${EditProUtils.escapeHtml(marketplace.name)}</h2>
                <p class="meta">${EditProUtils.escapeHtml(marketplace.notes || "")}</p>
              </div>
              <span class="badge">${EditProUtils.escapeHtml(String(marketplace.format || "").toUpperCase())}</span>
            </div>
            <label class="field field-wide">
              <span>Sample template path</span>
              <div class="folder-row">
                <input
                  type="text"
                  class="marketplace-sample-input"
                  data-marketplace-id="${EditProUtils.escapeHtml(marketplace.id)}"
                  value="${EditProUtils.escapeHtml(samplePath)}"
                  placeholder="Paste full path to ${EditProUtils.escapeHtml(marketplace.defaultSampleName || "sample file")}"
                />
                <button type="button" class="btn btn-secondary marketplace-use-path-btn" data-marketplace-id="${EditProUtils.escapeHtml(marketplace.id)}">
                  Use path
                </button>
              </div>
            </label>
            <div class="marketplace-card-actions">
              <button type="button" class="btn btn-secondary btn-sm marketplace-inspect-btn" data-marketplace-id="${EditProUtils.escapeHtml(marketplace.id)}">
                Preview columns
              </button>
              <button type="button" class="btn btn-primary btn-sm marketplace-export-btn" data-marketplace-id="${EditProUtils.escapeHtml(marketplace.id)}">
                Export
              </button>
              <a
                class="btn btn-secondary btn-sm square-download-link marketplace-download-link disabled"
                data-marketplace-id="${EditProUtils.escapeHtml(marketplace.id)}"
                href="#"
                hidden
              >
                Download
              </a>
            </div>
            <p class="meta marketplace-card-status" data-marketplace-id="${EditProUtils.escapeHtml(marketplace.id)}"></p>
          </section>`;
      })
      .join("");
  }

  function getCardElements(marketplaceId) {
    return {
      input: cardsEl?.querySelector(`.marketplace-sample-input[data-marketplace-id="${marketplaceId}"]`),
      status: cardsEl?.querySelector(`.marketplace-card-status[data-marketplace-id="${marketplaceId}"]`),
      download: cardsEl?.querySelector(`.marketplace-download-link[data-marketplace-id="${marketplaceId}"]`),
      exportBtn: cardsEl?.querySelector(`.marketplace-export-btn[data-marketplace-id="${marketplaceId}"]`),
      inspectBtn: cardsEl?.querySelector(`.marketplace-inspect-btn[data-marketplace-id="${marketplaceId}"]`),
      usePathBtn: cardsEl?.querySelector(`.marketplace-use-path-btn[data-marketplace-id="${marketplaceId}"]`),
    };
  }

  function setCardBusy(marketplaceId, busy) {
    const els = getCardElements(marketplaceId);
    if (els.exportBtn) {
      els.exportBtn.disabled = busy || loading;
    }
    if (els.inspectBtn) {
      els.inspectBtn.disabled = busy || loading;
    }
    if (els.usePathBtn) {
      els.usePathBtn.disabled = busy || loading;
    }
  }

  function setDownloadLink(marketplaceId, downloadPath) {
    const els = getCardElements(marketplaceId);
    if (!els.download) {
      return;
    }
    if (downloadPath) {
      els.download.href = EditProUtils.apiUrl(downloadPath);
      els.download.hidden = false;
      els.download.classList.remove("disabled");
      els.download.setAttribute("aria-disabled", "false");
    } else {
      els.download.href = "#";
      els.download.hidden = true;
      els.download.classList.add("disabled");
      els.download.setAttribute("aria-disabled", "true");
    }
  }

  function setCardStatus(marketplaceId, text) {
    const els = getCardElements(marketplaceId);
    if (els.status) {
      els.status.textContent = text || "";
    }
  }

  function excludedProductsNote(result) {
    if (!result?.excludedCount) {
      return "";
    }
    const handles = (result.excludedProducts || []).map((p) => p.handle).join(", ");
    const label = result.excludedCount === 1 ? "product" : "products";
    return ` ${result.excludedCount} ${label} excluded${handles ? ` (${handles})` : ""}.`;
  }

  function getSamplePathForMarketplace(marketplaceId) {
    const els = getCardElements(marketplaceId);
    return els.input?.value?.trim() || loadSamplePath(marketplaceId);
  }

  async function refreshSummary() {
    currentSource = getSelectedSource();
    updateSourceNote();
    updateShopifyFilterVisibility();

    try {
      const inspectResults = await Promise.all(
        marketplaces.map((marketplace) =>
          EditProUtils.apiPost(
            "/api/marketplace/inspect",
            buildRequestPayload(marketplace.id, getSamplePathForMarketplace(marketplace.id))
          ).catch(() => null)
        )
      );

      const first = inspectResults.find(Boolean);
      if (first && productCountBadge) {
        productCountBadge.textContent = `${first.productCount} products`;
      }
      if (first && statsMeta) {
        const sourceLabel =
          currentSource === "shopify"
            ? shopifyFilterLabel(first.shopifyProductFilter || getShopifyProductFilter())
            : "Catalog Builder";
        statsMeta.textContent = `${first.variantCount} variant rows available from ${sourceLabel}.`;
      }
      if (first?.warnings?.length && messageEl) {
        EditProUtils.showMessage(messageEl, first.warnings.join(" "), "warning");
      } else {
        EditProUtils.hideMessage(messageEl);
      }
    } catch (error) {
      if (statsMeta) {
        statsMeta.textContent = error.message || "Unable to load marketplace summary.";
      }
    }
  }

  async function loadMarketplaces() {
    const data = await EditProUtils.apiGet("/api/marketplace/list");
    marketplaces = data.marketplaces || [];
    renderCards();
    await refreshSummary();
  }

  async function inspectMarketplace(marketplaceId) {
    const samplePath = getSamplePathForMarketplace(marketplaceId);
    if (!samplePath) {
      EditProUtils.showMessage(messageEl, "Enter a sample template path first.", "error");
      return;
    }

    setCardBusy(marketplaceId, true);
    try {
      const result = await EditProUtils.apiPost(
        "/api/marketplace/inspect",
        buildRequestPayload(marketplaceId, samplePath)
      );
      const preview = (result.headers || []).slice(0, 8).join(", ");
      setCardStatus(
        marketplaceId,
        `${result.columnCount} columns detected. Data starts at row ${result.dataStartRow}. Preview: ${preview}${result.headers?.length > 8 ? "…" : ""}${excludedProductsNote(result)}`
      );
      if (productCountBadge) {
        productCountBadge.textContent = `${result.productCount} products`;
      }
      if (statsMeta) {
        const sourceLabel =
          currentSource === "shopify"
            ? shopifyFilterLabel(result.shopifyProductFilter || getShopifyProductFilter())
            : "Catalog Builder";
        statsMeta.textContent = `${result.variantCount} variant rows available from ${sourceLabel}.`;
      }
      if (result.warnings?.length) {
        EditProUtils.showMessage(messageEl, result.warnings.join(" "), "warning");
      }
    } catch (error) {
      setCardStatus(marketplaceId, error.message || "Preview failed.");
      EditProUtils.showMessage(messageEl, error.message || "Preview failed.", "error");
    } finally {
      setCardBusy(marketplaceId, false);
    }
  }

  async function exportMarketplace(marketplaceId) {
    const samplePath = getSamplePathForMarketplace(marketplaceId);
    if (!samplePath) {
      EditProUtils.showMessage(messageEl, "Enter a sample template path first.", "error");
      return;
    }

    loading = true;
    setCardBusy(marketplaceId, true);
    EditProUtils.hideMessage(messageEl);

    try {
      const result = await EditProUtils.apiPost("/api/marketplace/export", {
        ...buildRequestPayload(marketplaceId, samplePath),
        outputDir: getDownloadPath(),
      });
      const partLabel = result.partCount === 1 ? "1 file" : `${result.partCount} files`;
      const savedInfo = result.savedDir ? ` Saved to ${result.savedDir}.` : "";
      setCardStatus(
        marketplaceId,
        `Exported ${result.variantCount} rows from ${result.productCount} products into ${partLabel}.${savedInfo}${excludedProductsNote(result)} ${result.notes || ""}`.trim()
      );
      EditProUtils.showMessage(
        messageEl,
        `${result.name} export ready (${partLabel}).${savedInfo}${excludedProductsNote(result)}`,
        "success"
      );
      if (result.warnings?.length) {
        setTimeout(() => {
          EditProUtils.showMessage(messageEl, result.warnings.join(" "), "warning");
        }, 1200);
      }
    } catch (error) {
      setCardStatus(marketplaceId, error.message || "Export failed.");
      EditProUtils.showMessage(messageEl, error.message || "Export failed.", "error");
    } finally {
      loading = false;
      setCardBusy(marketplaceId, false);
    }
  }

  function applySamplePath(marketplaceId) {
    const els = getCardElements(marketplaceId);
    const value = els.input?.value?.trim();
    if (!value) {
      EditProUtils.showMessage(messageEl, "Enter a sample template path.", "error");
      return;
    }
    saveSamplePath(marketplaceId, value);
    setCardStatus(marketplaceId, "Sample path saved.");
    EditProUtils.hideMessage(messageEl);
    refreshSummary();
  }

  cardsEl?.addEventListener("click", (event) => {
    const exportBtn = event.target.closest(".marketplace-export-btn");
    if (exportBtn) {
      exportMarketplace(exportBtn.dataset.marketplaceId);
      return;
    }

    const inspectBtn = event.target.closest(".marketplace-inspect-btn");
    if (inspectBtn) {
      inspectMarketplace(inspectBtn.dataset.marketplaceId);
      return;
    }

    const usePathBtn = event.target.closest(".marketplace-use-path-btn");
    if (usePathBtn) {
      applySamplePath(usePathBtn.dataset.marketplaceId);
      return;
    }

    const downloadLink = event.target.closest(".marketplace-download-link");
    if (downloadLink?.classList.contains("disabled") || downloadLink?.hidden) {
      event.preventDefault();
    }
  });

  sourceInputs.forEach((input) => {
    input.addEventListener("change", () => {
      currentSource = getSelectedSource();
      updateSourceNote();
      updateShopifyFilterVisibility();
      refreshSummary();
    });
  });

  shopifyFilterSelect?.addEventListener("change", () => {
    saveShopifyFilter(getShopifyProductFilter());
    refreshSummary();
  });

  if (shopifyFilterSelect) {
    shopifyFilterSelect.value = loadShopifyFilter();
  }
  updateShopifyFilterVisibility();

  function applyDownloadPath() {
    const value = downloadPathInput?.value?.trim() || "";
    saveDownloadPath(value);
    updateDownloadPathMeta();
    EditProUtils.showMessage(
      messageEl,
      value ? "Default download folder saved." : "Download folder reset to app default.",
      "success"
    );
  }

  downloadPathBtn?.addEventListener("click", applyDownloadPath);
  downloadPathInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      applyDownloadPath();
    }
  });

  if (downloadPathInput) {
    downloadPathInput.value = loadDownloadPath();
  }
  updateDownloadPathMeta();

  document.addEventListener("editpro:module-changed", (event) => {
    if (event.detail?.moduleId === "marketplace") {
      loadMarketplaces();
    }
  });

  if (window.EditProShell?.getActiveModule?.() === "marketplace") {
    loadMarketplaces();
  }
})();
