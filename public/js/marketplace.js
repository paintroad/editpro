(function initMarketplaceModule() {
  const STORAGE_PREFIX = "editpro-marketplace-sample-";
  const DOWNLOAD_PATH_KEY = "editpro-marketplace-download-path";
  const SHOPIFY_FILTER_KEY = "editpro-marketplace-shopify-filter";
  const COLLECTIONS_KEY = "editpro-marketplace-collection-handles";

  const cardsEl = document.getElementById("marketplaceCards");
  const messageEl = document.getElementById("marketplaceMessage");
  const productCountBadge = document.getElementById("marketplaceProductCountBadge");
  const statsMeta = document.getElementById("marketplaceStatsMeta");
  const sourceNote = document.getElementById("marketplaceSourceNote");
  const sourceInputs = document.querySelectorAll('input[name="marketplaceSource"]');
  const shopifyFilterWrap = document.getElementById("marketplaceShopifyFilterWrap");
  const shopifyFilterSelect = document.getElementById("marketplaceShopifyFilter");
  const collectionsWrap = document.getElementById("marketplaceCollectionsWrap");
  const collectionsDropdownEl = document.getElementById("marketplaceCollectionsDropdown");
  const collectionsEmptyEl = document.getElementById("marketplaceCollectionsEmpty");
  const collectionsSelectedBadge = document.getElementById("marketplaceCollectionsSelectedBadge");
  const googleSection = document.getElementById("marketplaceGoogleSection");
  const googleInspectBtn = document.getElementById("marketplaceGoogleInspectBtn");
  const googleExportBtn = document.getElementById("marketplaceGoogleExportBtn");
  const googleDownloadLink = document.getElementById("marketplaceGoogleDownloadLink");
  const googleStatusEl = document.getElementById("marketplaceGoogleStatus");
  const downloadPathInput = document.getElementById("marketplaceDownloadPath");
  const downloadPathBtn = document.getElementById("marketplaceDownloadPathBtn");
  const downloadPathMeta = document.getElementById("marketplaceDownloadPathMeta");

  let marketplaces = [];
  let currentSource = "shopify";
  let loading = false;
  let collections = [];
  let collectionsLoaded = false;
  let selectedCollectionHandles = new Set(loadSelectedCollectionHandles());
  let collectionsDropdown = null;

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

  function loadSelectedCollectionHandles() {
    try {
      const raw = localStorage.getItem(COLLECTIONS_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.map((h) => String(h || "").trim()).filter(Boolean) : [];
    } catch {
      return [];
    }
  }

  function saveSelectedCollectionHandles() {
    try {
      localStorage.setItem(COLLECTIONS_KEY, JSON.stringify([...selectedCollectionHandles]));
    } catch {
      // ignore
    }
  }

  function getSelectedCollectionHandles() {
    return [...selectedCollectionHandles];
  }

  function updateSourceVisibility() {
    const source = getSelectedSource();
    if (shopifyFilterWrap) {
      shopifyFilterWrap.hidden = source !== "shopify";
    }
    if (collectionsWrap) {
      collectionsWrap.hidden = source !== "collections";
    }
    if (googleSection) {
      googleSection.hidden = source !== "collections";
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

  function sourceLabel(result) {
    if (currentSource === "shopify") {
      return shopifyFilterLabel(result?.shopifyProductFilter || getShopifyProductFilter());
    }
    if (currentSource === "collections") {
      const count = getSelectedCollectionHandles().length;
      return count === 1 ? "1 selected collection" : `${count} selected collections`;
    }
    return "Catalog Builder";
  }

  function marketplaceUsesSample(marketplace) {
    return Boolean(marketplace?.defaultSampleName ?? marketplace?.usesSampleTemplate);
  }

  function buildRequestPayload(marketplaceId, samplePath) {
    const payload = {
      marketplaceId,
      source: currentSource,
    };
    if (samplePath) {
      payload.samplePath = samplePath;
    }
    if (currentSource === "shopify") {
      payload.shopifyProductFilter = getShopifyProductFilter();
    }
    if (currentSource === "collections") {
      payload.collectionHandles = getSelectedCollectionHandles();
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
    } else if (currentSource === "collections") {
      sourceNote.textContent =
        "Select one or more Shopify collections below, then use the Google Shopping section to preview or export a Merchant Center CSV. Amazon, Flipkart, and Pinterest below also use the same selection.";
    } else {
      sourceNote.textContent =
        "Shopify live includes public image URLs and variant pricing from your connected store.";
    }
  }

  function updateCollectionsSelectedBadge() {
    if (!collectionsSelectedBadge) {
      return;
    }
    const count = selectedCollectionHandles.size;
    collectionsSelectedBadge.textContent = `${count} selected`;
  }

  function syncCollectionsDropdown() {
    if (!collectionsDropdownEl || typeof MultiselectDropdown !== "function") {
      return;
    }

    const options = collections.map((collection) => ({
      value: collection.handle,
      label: `${collection.title || collection.handle} (${Number(collection.productsCount || 0)})${
        collection.source === "storefront" ? " · storefront" : ""
      }`,
    }));

    if (collectionsDropdown) {
      collectionsDropdown.destroy();
      collectionsDropdown = null;
    }

    collectionsDropdown = new MultiselectDropdown(collectionsDropdownEl, {
      placeholder: collections.length ? "Select collections…" : "No collections available",
      options,
      values: [...selectedCollectionHandles],
      onChange: (valuesSet) => {
        selectedCollectionHandles = new Set(valuesSet || []);
        saveSelectedCollectionHandles();
        updateCollectionsSelectedBadge();
        updateGoogleSectionBusyState();
        updateAllCardBusyState();
        refreshSummary();
      },
    });

    updateCollectionsSelectedBadge();
  }

  async function loadCollections({ force = false } = {}) {
    if (collectionsLoaded && !force) {
      return;
    }
    try {
      const data = await EditProUtils.apiGet("/api/marketplace/collections");
      collections = data.collections || [];
      collectionsLoaded = true;
      const valid = new Set(collections.map((c) => c.handle));
      selectedCollectionHandles = new Set(
        [...selectedCollectionHandles].filter((handle) => valid.has(handle))
      );
      saveSelectedCollectionHandles();
      if (collectionsEmptyEl) {
        collectionsEmptyEl.hidden = collections.length > 0;
        collectionsEmptyEl.textContent = collections.length
          ? ""
          : "No collections found on the connected Shopify store.";
      }
      syncCollectionsDropdown();
    } catch (error) {
      collections = [];
      collectionsLoaded = false;
      if (collectionsEmptyEl) {
        collectionsEmptyEl.hidden = false;
        collectionsEmptyEl.textContent = error.message || "Failed to load collections.";
      }
      if (sourceNote && currentSource === "collections") {
        sourceNote.textContent = error.message || "Failed to load Shopify collections.";
      }
      syncCollectionsDropdown();
      updateCollectionsSelectedBadge();
    }
  }

  function cardsToRender() {
    if (currentSource === "collections") {
      return marketplaces.filter((marketplace) => marketplace.id !== "google");
    }
    return marketplaces;
  }

  function renderCards() {
    if (!cardsEl) {
      return;
    }

    const visible = cardsToRender();

    if (!marketplaces.length) {
      cardsEl.innerHTML = '<p class="catalog-empty">Loading marketplaces…</p>';
      return;
    }

    if (!visible.length) {
      cardsEl.innerHTML = "";
      return;
    }

    cardsEl.innerHTML = visible
      .map((marketplace) => {
        const usesSample = marketplaceUsesSample(marketplace);
        const samplePath = loadSamplePath(marketplace.id, marketplace.defaultSamplePath || "");
        const sampleBlock = usesSample
          ? `
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
            </label>`
          : `<p class="meta">Uses fixed Google Merchant Center columns — no sample template needed.</p>`;

        return `
          <section class="card marketplace-card" data-marketplace-id="${EditProUtils.escapeHtml(marketplace.id)}">
            <div class="marketplace-card-header">
              <div>
                <h2>${EditProUtils.escapeHtml(marketplace.name)}</h2>
                <p class="meta">${EditProUtils.escapeHtml(marketplace.notes || "")}</p>
              </div>
              <span class="badge">${EditProUtils.escapeHtml(String(marketplace.format || "").toUpperCase())}</span>
            </div>
            ${sampleBlock}
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

  function collectionsBlocked() {
    return currentSource === "collections" && !getSelectedCollectionHandles().length;
  }

  function setCardBusy(marketplaceId, busy) {
    const els = getCardElements(marketplaceId);
    const blocked = collectionsBlocked();
    if (els.exportBtn) {
      els.exportBtn.disabled = busy || loading || blocked;
    }
    if (els.inspectBtn) {
      els.inspectBtn.disabled = busy || loading || blocked;
    }
    if (els.usePathBtn) {
      els.usePathBtn.disabled = busy || loading;
    }
  }

  function updateGoogleSectionBusyState(busy = false) {
    const blocked = collectionsBlocked();
    if (googleInspectBtn) {
      googleInspectBtn.disabled = busy || loading || blocked;
    }
    if (googleExportBtn) {
      googleExportBtn.disabled = busy || loading || blocked;
    }
  }

  function updateAllCardBusyState() {
    for (const marketplace of cardsToRender()) {
      setCardBusy(marketplace.id, false);
    }
    updateGoogleSectionBusyState(false);
  }

  function setDownloadLink(marketplaceId, downloadPath) {
    const els = getCardElements(marketplaceId);
    const link = marketplaceId === "google" && currentSource === "collections"
      ? googleDownloadLink
      : els.download;
    if (!link) {
      return;
    }
    if (downloadPath) {
      link.href = EditProUtils.apiUrl(downloadPath);
      link.hidden = false;
      link.classList.remove("disabled");
      link.setAttribute("aria-disabled", "false");
    } else {
      link.href = "#";
      link.hidden = true;
      link.classList.add("disabled");
      link.setAttribute("aria-disabled", "true");
    }
  }

  function setCardStatus(marketplaceId, text) {
    if (marketplaceId === "google" && currentSource === "collections") {
      if (googleStatusEl) {
        googleStatusEl.textContent = text || "";
      }
      return;
    }
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
    const marketplace = marketplaces.find((item) => item.id === marketplaceId);
    if (marketplace && !marketplaceUsesSample(marketplace)) {
      return "";
    }
    const els = getCardElements(marketplaceId);
    return els.input?.value?.trim() || loadSamplePath(marketplaceId);
  }

  function ensureCollectionsReady() {
    if (currentSource !== "collections") {
      return true;
    }
    if (!getSelectedCollectionHandles().length) {
      EditProUtils.showMessage(messageEl, "Select at least one collection to export.", "error");
      return false;
    }
    return true;
  }

  async function refreshSummary() {
    currentSource = getSelectedSource();
    updateSourceNote();
    updateSourceVisibility();
    renderCards();
    updateAllCardBusyState();

    if (currentSource === "collections") {
      await loadCollections();
      if (!getSelectedCollectionHandles().length) {
        if (productCountBadge) {
          productCountBadge.textContent = "0 products";
        }
        if (statsMeta) {
          statsMeta.textContent = "Select one or more collections to load products.";
        }
        if (googleStatusEl) {
          googleStatusEl.textContent = "Select collections above to enable Preview and Export.";
        }
        return;
      }
    }

    try {
      const inspectTargets = cardsToRender();
      if (currentSource === "collections") {
        inspectTargets.unshift({ id: "google" });
      }

      const inspectResults = await Promise.all(
        inspectTargets.map((marketplace) =>
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
        statsMeta.textContent = `${first.variantCount} variant rows available from ${sourceLabel(first)}.`;
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
    if (!ensureCollectionsReady()) {
      return;
    }

    const marketplace = marketplaces.find((item) => item.id === marketplaceId) || { id: marketplaceId };
    const samplePath = getSamplePathForMarketplace(marketplaceId);
    if (marketplaceUsesSample(marketplace) && !samplePath) {
      EditProUtils.showMessage(messageEl, "Enter a sample template path first.", "error");
      return;
    }

    const isGoogleDedicated = marketplaceId === "google" && currentSource === "collections";
    if (isGoogleDedicated) {
      updateGoogleSectionBusyState(true);
    } else {
      setCardBusy(marketplaceId, true);
    }

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
        statsMeta.textContent = `${result.variantCount} variant rows available from ${sourceLabel(result)}.`;
      }
      if (result.warnings?.length) {
        EditProUtils.showMessage(messageEl, result.warnings.join(" "), "warning");
      }
    } catch (error) {
      setCardStatus(marketplaceId, error.message || "Preview failed.");
      EditProUtils.showMessage(messageEl, error.message || "Preview failed.", "error");
    } finally {
      if (isGoogleDedicated) {
        updateGoogleSectionBusyState(false);
      } else {
        setCardBusy(marketplaceId, false);
      }
    }
  }

  async function exportMarketplace(marketplaceId) {
    if (!ensureCollectionsReady()) {
      return;
    }

    const marketplace = marketplaces.find((item) => item.id === marketplaceId) || { id: marketplaceId };
    const samplePath = getSamplePathForMarketplace(marketplaceId);
    if (marketplaceUsesSample(marketplace) && !samplePath) {
      EditProUtils.showMessage(messageEl, "Enter a sample template path first.", "error");
      return;
    }

    const isGoogleDedicated = marketplaceId === "google" && currentSource === "collections";
    loading = true;
    if (isGoogleDedicated) {
      updateGoogleSectionBusyState(true);
    } else {
      setCardBusy(marketplaceId, true);
    }
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
      if (result.parts?.[0]?.fileName) {
        setDownloadLink(
          marketplaceId,
          `/api/marketplace/download/${encodeURIComponent(result.parts[0].fileName)}`
        );
      }
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
      if (isGoogleDedicated) {
        updateGoogleSectionBusyState(false);
      } else {
        setCardBusy(marketplaceId, false);
      }
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

  googleInspectBtn?.addEventListener("click", () => {
    inspectMarketplace("google");
  });

  googleExportBtn?.addEventListener("click", () => {
    exportMarketplace("google");
  });

  googleDownloadLink?.addEventListener("click", (event) => {
    if (googleDownloadLink.classList.contains("disabled") || googleDownloadLink.hidden) {
      event.preventDefault();
    }
  });

  sourceInputs.forEach((input) => {
    input.addEventListener("change", () => {
      currentSource = getSelectedSource();
      updateSourceNote();
      updateSourceVisibility();
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
  updateSourceVisibility();
  updateGoogleSectionBusyState(false);

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
