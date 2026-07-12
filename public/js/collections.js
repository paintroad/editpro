(function initCollectionsModule() {
  const STORAGE_KEY = "editpro-collections-root-path";

  const rootPathInput = document.getElementById("collectionsRootPath");
  const usePathBtn = document.getElementById("collectionsUsePathBtn");
  const addToShopifyBtn = document.getElementById("collectionsAddToShopifyBtn");
  const addNewCollectionsBtn = document.getElementById("collectionsAddNewCollectionsBtn");
  const metaEl = document.getElementById("collectionsMeta");
  const countBadge = document.getElementById("collectionsCountBadge");
  const messageEl = document.getElementById("collectionsMessage");
  const emptyEl = document.getElementById("collectionsEmpty");
  const searchInput = document.getElementById("collectionsSearch");
  const scanOverlay = document.getElementById("collectionsScanOverlay");
  const shopifyOverlay = document.getElementById("collectionsShopifyOverlay");
  const shopifyOverlayStatus = document.getElementById("collectionsShopifyOverlayStatus");
  const previewModal = document.getElementById("collectionsTagPreviewModal");
  const previewBody = document.getElementById("collectionsTagPreviewBody");
  const previewSummary = document.getElementById("collectionsTagPreviewSummary");
  const previewCount = document.getElementById("collectionsTagPreviewCount");
  const previewApplyBtn = document.getElementById("collectionsTagPreviewApply");
  const previewCloseBtn = document.getElementById("collectionsTagPreviewClose");
  const previewCancelBtn = document.getElementById("collectionsTagPreviewCancel");
  const createPreviewModal = document.getElementById("collectionsCreatePreviewModal");
  const createPreviewBody = document.getElementById("collectionsCreatePreviewBody");
  const createPreviewSummary = document.getElementById("collectionsCreatePreviewSummary");
  const createPreviewCount = document.getElementById("collectionsCreatePreviewCount");
  const createPreviewApplyBtn = document.getElementById("collectionsCreatePreviewApply");
  const createPreviewCloseBtn = document.getElementById("collectionsCreatePreviewClose");
  const createPreviewCancelBtn = document.getElementById("collectionsCreatePreviewCancel");
  const createPreviewMessageEl = document.getElementById("collectionsCreatePreviewMessage");
  const createPreviewMessageTextEl = createPreviewMessageEl?.querySelector(".message-text");
  const createPreviewErrorListEl = document.getElementById("collectionsCreatePreviewErrorList");
  const createPreviewViewErrorsBtn = document.getElementById("collectionsCreatePreviewViewErrorsBtn");
  const sidebarList = document.getElementById("collectionsSidebarList");
  const gridHeader = document.getElementById("collectionsGridHeader");
  const productGrid = document.getElementById("collectionsProductGrid");

  let rootPath = "";
  let images = [];
  let tagOptions = [];
  let scannedAt = null;
  let scanning = false;
  let shopifyWorking = false;
  let searchQuery = "";
  let activeCollection = "";
  const selectedCollections = new Set();
  let liveCollections = {};
  let lastCreatePreviewErrors = [];
  let createPreviewErrorsExpanded = false;
  let lastCreatePreviewPlans = [];

  function isCollectionLive(name) {
    return Boolean(liveCollections[String(name)]);
  }

  function getSelectedCollections() {
    return [...selectedCollections];
  }

  function getSelectedNewCollections() {
    return getSelectedCollections();
  }

  function loadRootPath() {
    try {
      rootPath = localStorage.getItem(STORAGE_KEY) || "";
    } catch {
      rootPath = "";
    }
    if (rootPathInput) {
      rootPathInput.value = rootPath;
    }
    updateMeta();
  }

  function saveRootPath() {
    try {
      localStorage.setItem(STORAGE_KEY, rootPath);
    } catch {
      // ignore
    }
  }

  function formatScannedAt(iso) {
    if (!iso) {
      return "";
    }
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return iso;
    }
  }

  function updateMeta() {
    if (!metaEl) {
      return;
    }
    if (!rootPath) {
      metaEl.textContent = "Enter a folder path to list collections and products.";
      return;
    }
    const parts = [`Using: ${rootPath}`];
    if (scannedAt) {
      parts.push(`Last scanned: ${formatScannedAt(scannedAt)}`);
    }
    metaEl.textContent = parts.join(" · ");
  }

  function setScanning(active) {
    scanning = active;
    if (scanOverlay) {
      scanOverlay.hidden = !active;
    }
    updateButtons();
  }

  function setShopifyWorking(active, statusText) {
    shopifyWorking = active;
    if (shopifyOverlay) {
      shopifyOverlay.hidden = !active;
    }
    if (shopifyOverlayStatus && statusText) {
      shopifyOverlayStatus.textContent = statusText;
    }
    updateButtons();
  }

  function updateButtons() {
    const hasData = images.length > 0;
    if (usePathBtn) {
      usePathBtn.disabled = scanning || shopifyWorking;
    }
    if (addToShopifyBtn) {
      addToShopifyBtn.disabled = scanning || shopifyWorking || !hasData || selectedCollections.size === 0;
    }
    if (addNewCollectionsBtn) {
      addNewCollectionsBtn.disabled =
        scanning || shopifyWorking || !hasData || selectedCollections.size === 0;
    }
  }

  function renderSelectAllRow(collectionCount) {
    const names = [...buildCollectionIndex().keys()];
    const selectedCount = names.filter((name) => selectedCollections.has(name)).length;
    const allSelected = collectionCount > 0 && selectedCount === collectionCount;
    const disabled = scanning || shopifyWorking || collectionCount === 0;

    return `
      <li class="collections-sidebar-item collections-sidebar-item--select-all">
        <div class="collections-sidebar-row">
          <input
            type="checkbox"
            id="collectionsSelectAllCheck"
            class="collections-sidebar-check"
            data-collection-check-all
            ${allSelected ? "checked" : ""}
            ${disabled ? "disabled" : ""}
            aria-label="Select all collections"
          />
          <span class="collections-sidebar-name">All Collections</span>
        </div>
      </li>`;
  }

  function syncSelectAllCheckbox() {
    const selectAllCheck = document.getElementById("collectionsSelectAllCheck");
    if (!selectAllCheck) {
      return;
    }
    const names = [...buildCollectionIndex().keys()];
    const selectedCount = names.filter((name) => selectedCollections.has(name)).length;
    selectAllCheck.checked = names.length > 0 && selectedCount === names.length;
    selectAllCheck.indeterminate = selectedCount > 0 && selectedCount < names.length;
    selectAllCheck.disabled = scanning || shopifyWorking || names.length === 0;
  }

  function setAllCollectionsSelected(selected) {
    const names = [...buildCollectionIndex().keys()];
    if (!names.length) {
      return;
    }
    if (selected) {
      for (const name of names) {
        selectedCollections.add(name);
      }
    } else {
      selectedCollections.clear();
    }
    renderSidebar();
    updateButtons();
  }

  function imageUrl(relativePath) {
    const params = new URLSearchParams({
      root: rootPath,
      rel: relativePath,
      w: "360",
    });
    return EditProUtils.apiUrl(`/api/collections/image?${params.toString()}`);
  }

  function getRelevantImages() {
    return images.filter((image) => image.relevance === "relevant");
  }

  function buildCollectionIndex() {
    const index = new Map();
    for (const tag of tagOptions) {
      index.set(tag, []);
    }
    for (const image of getRelevantImages()) {
      for (const tag of image.tags || []) {
        if (!index.has(tag)) {
          index.set(tag, []);
        }
        index.get(tag).push(image);
      }
    }
    return index;
  }

  function getProductsForCollection(collectionName) {
    const query = searchQuery.trim().toLowerCase();
    return getRelevantImages().filter((image) => {
      if (!(image.tags || []).includes(collectionName)) {
        return false;
      }
      if (query && !String(image.id || image.filename || "").toLowerCase().includes(query)) {
        return false;
      }
      return true;
    });
  }

  function applyScanResult(result) {
    rootPath = result.rootPath || rootPath;
    images = Array.isArray(result.images) ? result.images : [];
    tagOptions = Array.isArray(result.tagOptions) ? result.tagOptions : [];
    scannedAt = result.scannedAt || null;
    selectedCollections.clear();

    const collectionNames = [...buildCollectionIndex().keys()].sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: "base" })
    );
    if (!activeCollection || !collectionNames.includes(activeCollection)) {
      activeCollection = collectionNames[0] || "";
    }

    if (rootPathInput) {
      rootPathInput.value = rootPath;
    }
    saveRootPath();
    updateMeta();
    render();
  }

  async function loadLiveStatus() {
    if (!rootPath) {
      liveCollections = {};
      return;
    }
    try {
      const params = new URLSearchParams({ rootPath });
      const result = await EditProUtils.apiGet(`/api/collections/shopify/live-status?${params.toString()}`);
      liveCollections = result?.live && typeof result.live === "object" ? result.live : {};
    } catch {
      liveCollections = {};
    }
    renderSidebar();
    updateButtons();
  }

  async function loadCachedData() {
    if (!rootPath) {
      return;
    }
    try {
      const params = new URLSearchParams({ rootPath });
      const result = await EditProUtils.apiGet(`/api/collections/data?${params.toString()}`);
      if (result?.cached) {
        applyScanResult(result);
      }
    } catch {
      // ignore cache load failures
    }
    await loadLiveStatus();
  }

  function renderCounts() {
    const relevant = getRelevantImages();
    if (countBadge) {
      const label = relevant.length === 1 ? "product" : "products";
      countBadge.textContent = `${relevant.length} ${label}`;
    }
  }

  function renderSidebar() {
    if (!sidebarList) {
      return;
    }

    const collectionIndex = buildCollectionIndex();
    const collections = [...collectionIndex.entries()].sort((a, b) =>
      a[0].localeCompare(b[0], undefined, { sensitivity: "base" })
    );

    if (!collections.length) {
      sidebarList.innerHTML = "";
      if (emptyEl) {
        emptyEl.hidden = false;
        emptyEl.textContent = "No collections found. Scan a folder with subfolders.";
      }
      return;
    }

    if (emptyEl) {
      emptyEl.hidden = true;
    }

    sidebarList.innerHTML =
      renderSelectAllRow(collections.length) +
      collections
      .map(([name, items]) => {
        const isActive = name === activeCollection;
        const isChecked = selectedCollections.has(name);
        const liveBadge = isCollectionLive(name)
          ? '<span class="collections-live-badge" title="Live on Shopify">Live</span>'
          : "";
        return `
          <li class="collections-sidebar-item${isActive ? " active" : ""}" data-collection="${EditProUtils.escapeHtml(name)}">
            <div class="collections-sidebar-row">
              <input
                type="checkbox"
                class="collections-sidebar-check"
                data-collection-check="${EditProUtils.escapeHtml(name)}"
                ${isChecked ? "checked" : ""}
                aria-label="Select ${EditProUtils.escapeHtml(name)}"
              />
              <button type="button" class="collections-sidebar-name" data-collection-select="${EditProUtils.escapeHtml(name)}">
                ${EditProUtils.escapeHtml(name)}
              </button>
              ${liveBadge}
              <span class="collections-sidebar-count">${items.length}</span>
            </div>
          </li>`;
      })
      .join("");
    syncSelectAllCheckbox();
  }

  function renderProductGrid() {
    if (!productGrid || !gridHeader) {
      return;
    }

    if (!activeCollection) {
      gridHeader.textContent = "Select a collection";
      productGrid.innerHTML = '<div class="collections-grid-empty">Select a collection on the left to view products.</div>';
      return;
    }

    const products = getProductsForCollection(activeCollection);
    gridHeader.textContent = `${activeCollection} — ${products.length} product${products.length === 1 ? "" : "s"}`;

    if (!products.length) {
      productGrid.innerHTML = '<div class="collections-grid-empty">No products match the current search.</div>';
      return;
    }

    productGrid.innerHTML = products
      .map((image) => {
        const filename = image.id || image.filename || "";
        const alt = EditProUtils.escapeHtml(filename || "Product");
        return `
          <div class="collections-grid-cell">
            <img
              class="collections-grid-thumb"
              src="${EditProUtils.escapeHtml(imageUrl(image.relativePath))}"
              alt="${alt}"
              loading="lazy"
            />
            <div class="collections-grid-filename" title="${alt}">${alt}</div>
          </div>`;
      })
      .join("");
  }

  function render() {
    renderCounts();
    renderSidebar();
    renderProductGrid();
    updateButtons();
  }

  async function scanPath() {
    const nextPath = String(rootPathInput?.value || "").trim();
    if (!nextPath) {
      EditProUtils.showMessage(messageEl, "Enter a folder path first.", "warning");
      return;
    }

    EditProUtils.hideMessage(messageEl);
    setScanning(true);
    try {
      const result = await EditProUtils.apiPost("/api/collections/scan", { rootPath: nextPath });
      applyScanResult(result);

      const relevantCount = getRelevantImages().length;
      if (!relevantCount) {
        EditProUtils.showMessage(messageEl, "No relevant product images found in this folder.", "warning");
      } else {
        EditProUtils.showMessage(
          messageEl,
          `Found ${relevantCount} product${relevantCount === 1 ? "" : "s"} across ${tagOptions.length} collection${tagOptions.length === 1 ? "" : "s"}.`,
          "success"
        );
      }
      await loadLiveStatus();
    } catch (error) {
      images = [];
      tagOptions = [];
      scannedAt = null;
      activeCollection = "";
      selectedCollections.clear();
      render();
      updateMeta();
      EditProUtils.showMessage(messageEl, error.message || "Failed to scan folder.", "error");
    } finally {
      setScanning(false);
    }
  }

  function formatTagList(tags) {
    if (!Array.isArray(tags) || !tags.length) {
      return "—";
    }
    return tags.join(", ");
  }

  function statusRowClass(status) {
    if (status === "ready") {
      return "preview-row--pass";
    }
    if (status === "skip") {
      return "preview-row--warn";
    }
    return "preview-row--fail";
  }

  function statusLabel(status) {
    if (status === "ready") {
      return "Ready";
    }
    if (status === "skip") {
      return "Skip";
    }
    return "Missing";
  }

  function openPreviewModal() {
    if (previewModal) {
      previewModal.hidden = false;
      document.body.classList.add("modal-open");
    }
  }

  function closePreviewModal() {
    if (previewModal) {
      previewModal.hidden = true;
      document.body.classList.remove("modal-open");
    }
  }

  function renderPreviewModal(result) {
    const summary = result.summary || {};
    const changes = Array.isArray(result.changes) ? result.changes : [];
    const ready = summary.ready || 0;

    if (previewCount) {
      previewCount.textContent = `${summary.productsTargeted || changes.length} product${summary.productsTargeted === 1 ? "" : "s"}`;
    }
    if (previewSummary) {
      previewSummary.textContent = `${ready} ready to update · ${summary.skip || 0} already tagged · ${summary.missing || 0} not found on Shopify`;
    }
    if (previewApplyBtn) {
      previewApplyBtn.disabled = ready === 0;
      previewApplyBtn.textContent = ready ? `Apply tags (${ready})` : "Apply tags";
    }
    if (!previewBody) {
      return;
    }

    previewBody.innerHTML = changes
      .map((change) => {
        const rowClass = statusRowClass(change.status);
        return `
          <tr class="${rowClass}">
            <td>${EditProUtils.escapeHtml(change.productId || "")}</td>
            <td>${EditProUtils.escapeHtml(change.handle || "—")}</td>
            <td>${EditProUtils.escapeHtml(change.resolveSource || "—")}</td>
            <td class="preview-new">${EditProUtils.escapeHtml(formatTagList(change.tagsToAdd))}</td>
            <td class="preview-old">${EditProUtils.escapeHtml(formatTagList(change.currentTags))}</td>
            <td>${EditProUtils.escapeHtml(statusLabel(change.status))}</td>
          </tr>`;
      })
      .join("");
  }

  async function previewAddToShopify() {
    if (!selectedCollections.size) {
      EditProUtils.showMessage(messageEl, "Select at least one collection.", "warning");
      return;
    }
    if (!rootPath) {
      EditProUtils.showMessage(messageEl, "Scan a folder first.", "warning");
      return;
    }

    EditProUtils.hideMessage(messageEl);
    setShopifyWorking(true, "Building tag preview…");
    try {
      const result = await EditProUtils.apiPost("/api/collections/shopify/preview-tags", {
        rootPath,
        collections: [...selectedCollections],
      });
      renderPreviewModal(result);
      openPreviewModal();
    } catch (error) {
      EditProUtils.showMessage(messageEl, error.message || "Failed to preview tags.", "error");
    } finally {
      setShopifyWorking(false);
    }
  }

  async function applyTagsToShopify() {
    if (!selectedCollections.size || !rootPath) {
      return;
    }

    closePreviewModal();
    setShopifyWorking(true, "Updating product tags on Shopify…");
    try {
      const result = await EditProUtils.apiPost("/api/collections/shopify/add-tags", {
        rootPath,
        collections: [...selectedCollections],
      });
      const errorCount = result.errors?.length || 0;
      const parts = [
        `Updated ${result.updated || 0} product${result.updated === 1 ? "" : "s"}`,
        result.skipped ? `${result.skipped} skipped` : "",
        errorCount ? `${errorCount} error${errorCount === 1 ? "" : "s"}` : "",
      ].filter(Boolean);
      EditProUtils.showMessage(messageEl, parts.join(" · "), errorCount ? "warning" : "success");
    } catch (error) {
      EditProUtils.showMessage(messageEl, error.message || "Failed to add tags on Shopify.", "error");
    } finally {
      setShopifyWorking(false);
    }
  }

  function createStatusLabel(plan) {
    const status = typeof plan === "string" ? plan : plan?.status;
    const reason = typeof plan === "object" ? plan?.reason : "";
    if (status === "ready-create") {
      return "Create";
    }
    if (status === "ready-update") {
      return "Update";
    }
    if (status === "skip") {
      return reason ? `Up to date — ${reason}` : "Up to date";
    }
    if (status === "blocked") {
      return reason ? `Blocked — ${reason}` : "Blocked";
    }
    if (status === "created") {
      return "Created";
    }
    if (status === "updated") {
      return "Updated";
    }
    if (status === "error") {
      return reason ? `Error — ${reason}` : "Error";
    }
    if (status === "skipped") {
      return reason ? `Skipped — ${reason}` : "Skipped";
    }
    return status || "—";
  }

  function clearCreatePreviewErrors() {
    lastCreatePreviewErrors = [];
    createPreviewErrorsExpanded = false;
    if (createPreviewViewErrorsBtn) {
      createPreviewViewErrorsBtn.hidden = true;
      createPreviewViewErrorsBtn.textContent = "View errors";
    }
    if (createPreviewErrorListEl) {
      createPreviewErrorListEl.hidden = true;
      createPreviewErrorListEl.innerHTML = "";
    }
    if (createPreviewMessageEl) {
      createPreviewMessageEl.classList.add("hidden");
    }
    if (createPreviewMessageTextEl) {
      createPreviewMessageTextEl.textContent = "";
    }
  }

  function renderCreatePreviewErrorList() {
    if (!createPreviewErrorListEl) {
      return;
    }
    createPreviewErrorListEl.innerHTML = lastCreatePreviewErrors
      .map((err) => {
        const name = EditProUtils.escapeHtml(err.collectionName || "Unknown");
        const message = EditProUtils.escapeHtml(err.message || "Unknown error");
        return `<li><strong>${name}</strong> — ${message}</li>`;
      })
      .join("");
  }

  function showCreatePreviewErrors(errors, messageText, tone = "warning") {
    lastCreatePreviewErrors = Array.isArray(errors) ? errors : [];
    createPreviewErrorsExpanded = lastCreatePreviewErrors.length > 0;
    renderCreatePreviewErrorList();
    if (createPreviewViewErrorsBtn) {
      createPreviewViewErrorsBtn.hidden = lastCreatePreviewErrors.length === 0;
      createPreviewViewErrorsBtn.textContent = createPreviewErrorsExpanded
        ? "Hide errors"
        : "View errors";
    }
    if (createPreviewErrorListEl) {
      createPreviewErrorListEl.hidden = !createPreviewErrorsExpanded;
    }
    if (createPreviewMessageEl && createPreviewMessageTextEl && messageText) {
      createPreviewMessageEl.classList.remove("hidden");
      createPreviewMessageEl.classList.remove("message-success", "message-warning", "message-error");
      createPreviewMessageEl.classList.add(
        tone === "error" ? "message-error" : tone === "success" ? "message-success" : "message-warning"
      );
      createPreviewMessageTextEl.textContent = messageText;
    }
  }

  function toggleCreatePreviewErrorList() {
    if (!lastCreatePreviewErrors.length) {
      return;
    }
    createPreviewErrorsExpanded = !createPreviewErrorsExpanded;
    if (createPreviewErrorListEl) {
      createPreviewErrorListEl.hidden = !createPreviewErrorsExpanded;
    }
    if (createPreviewViewErrorsBtn) {
      createPreviewViewErrorsBtn.textContent = createPreviewErrorsExpanded
        ? "Hide errors"
        : "View errors";
    }
  }

  function blockedPreviewErrors(plans) {
    return (plans || [])
      .filter((plan) => plan.status === "blocked")
      .map((plan) => ({
        collectionName: plan.collectionName,
        message: plan.reason || "Collection is blocked.",
      }));
  }

  function syncErrorsFromResult(result) {
    return (result?.errors || []).map((err) => ({
      collectionName: err.collectionName,
      message: err.message || "Failed to sync collection.",
    }));
  }

  function applyResultStatusClass(status) {
    if (status === "created" || status === "updated") {
      return "preview-row--pass";
    }
    if (status === "skipped") {
      return "preview-row--warn";
    }
    return "preview-row--fail";
  }

  function renderCreatePreviewPlansTable(plans) {
    if (!createPreviewBody) {
      return;
    }
    createPreviewBody.innerHTML = (plans || [])
      .map((plan) => {
        const rowClass = plan.resultStatus
          ? applyResultStatusClass(plan.resultStatus)
          : createPreviewRowClass(plan.status);
        const displayStatus = plan.resultStatus
          ? { status: plan.resultStatus, reason: plan.resultMessage || plan.reason }
          : plan;
        return `
          <tr class="${rowClass}">
            <td>${EditProUtils.escapeHtml(plan.collectionName || "")}</td>
            <td>${EditProUtils.escapeHtml(plan.handle || "—")}</td>
            <td>${EditProUtils.escapeHtml(formatImageSource(plan))}</td>
            <td>${EditProUtils.escapeHtml(truncateText(plan.descriptionPlain))}</td>
            <td>${EditProUtils.escapeHtml(plan.seoTitle || "—")}</td>
            <td>${EditProUtils.escapeHtml(truncateText(plan.seoDescription, 80))}</td>
            <td>${EditProUtils.escapeHtml(plan.imageAlt || "—")}</td>
            <td>${EditProUtils.escapeHtml(plan.imageFilename || "—")}</td>
            <td>${EditProUtils.escapeHtml(createStatusLabel(displayStatus))}</td>
          </tr>`;
      })
      .join("");
  }

  function truncateText(value, max = 120) {
    const text = String(value || "").trim();
    if (text.length <= max) {
      return text || "—";
    }
    return `${text.slice(0, max - 1)}…`;
  }

  function openCreatePreviewModal() {
    if (createPreviewModal) {
      createPreviewModal.hidden = false;
      document.body.classList.add("modal-open");
    }
  }

  function closeCreatePreviewModal() {
    if (createPreviewModal) {
      createPreviewModal.hidden = true;
      document.body.classList.remove("modal-open");
    }
    clearCreatePreviewErrors();
  }

  function createPreviewRowClass(status) {
    if (status === "ready-create" || status === "ready-update") {
      return "preview-row--pass";
    }
    if (status === "skip") {
      return "preview-row--warn";
    }
    return "preview-row--fail";
  }

  function formatImageSource(plan) {
    if (!plan.imageSource) {
      return plan.reason || "—";
    }
    const label = plan.imageSource.usedFallback ? "fallback (catalog)" : "portrait (catalog)";
    return `${plan.imageSource.productId} · ${label}`;
  }

  function renderCreatePreviewModal(result) {
    const summary = result.summary || {};
    const plans = Array.isArray(result.plans) ? result.plans : [];
    const actionable = summary.actionable || summary.ready || 0;
    lastCreatePreviewPlans = plans;

    if (createPreviewCount) {
      createPreviewCount.textContent = `${plans.length} collection${plans.length === 1 ? "" : "s"}`;
    }
    if (createPreviewSummary) {
      createPreviewSummary.textContent =
        `${summary.create || 0} to create · ${summary.update || 0} to update · ${summary.skip || 0} up to date · ${summary.blocked || 0} blocked. Run Add to Shopify first so products are tagged before collections go live.`;
    }
    if (createPreviewApplyBtn) {
      createPreviewApplyBtn.disabled = actionable === 0;
      createPreviewApplyBtn.textContent = actionable
        ? `Update on Shopify (${actionable})`
        : "Update on Shopify";
    }

    clearCreatePreviewErrors();
    renderCreatePreviewPlansTable(plans);

    const blockedErrors = blockedPreviewErrors(plans);
    if (blockedErrors.length) {
      showCreatePreviewErrors(
        blockedErrors,
        `${blockedErrors.length} collection${blockedErrors.length === 1 ? "" : "s"} blocked during preview.`,
        "warning"
      );
    }
  }

  function renderCreatePreviewApplyResult(result) {
    const summary = result.summary || {};
    const resultByName = new Map((result.results || []).map((row) => [row.collectionName, row]));
    const plans = lastCreatePreviewPlans.map((plan) => {
      const row = resultByName.get(plan.collectionName);
      if (!row) {
        return plan;
      }
      return {
        ...plan,
        resultStatus: row.status,
        resultMessage: row.message || "",
      };
    });
    lastCreatePreviewPlans = plans;
    renderCreatePreviewPlansTable(plans);

    if (createPreviewApplyBtn) {
      createPreviewApplyBtn.disabled = true;
      createPreviewApplyBtn.textContent = "Update on Shopify";
    }

    const syncErrors = syncErrorsFromResult(result);
    const errorCount = syncErrors.length;
    const parts = [
      result.created ? `Created ${result.created}` : "",
      result.updated ? `Updated ${result.updated}` : "",
      result.skipped ? `${result.skipped} skipped` : "",
      errorCount ? `${errorCount} error${errorCount === 1 ? "" : "s"}` : "",
    ].filter(Boolean);
    const messageText = parts.join(" · ");
    const tone = errorCount ? "warning" : "success";
    showCreatePreviewErrors(syncErrors, messageText, tone);

    return { messageText, errorCount, firstError: syncErrors[0]?.message || "" };
  }

  async function previewAddNewCollections() {
    const targets = getSelectedCollections();
    if (!targets.length) {
      EditProUtils.showMessage(messageEl, "Select at least one collection.", "warning");
      return;
    }
    if (!rootPath) {
      EditProUtils.showMessage(messageEl, "Scan a folder first.", "warning");
      return;
    }

    EditProUtils.hideMessage(messageEl);
    setShopifyWorking(true, "Building collection previews…");
    try {
      const result = await EditProUtils.apiPost("/api/collections/shopify/preview-create", {
        rootPath,
        collections: targets,
      });
      renderCreatePreviewModal(result);
      openCreatePreviewModal();
    } catch (error) {
      EditProUtils.showMessage(messageEl, error.message || "Failed to preview collections.", "error");
    } finally {
      setShopifyWorking(false);
    }
  }

  async function applyCreateCollections() {
    const targets = getSelectedCollections();
    if (!targets.length || !rootPath) {
      return;
    }

    setShopifyWorking(true, "Updating collections on Shopify…");
    try {
      const result = await EditProUtils.apiPost("/api/collections/shopify/create-collections", {
        rootPath,
        collections: targets,
      });
      await loadLiveStatus();
      const { messageText, errorCount, firstError } = renderCreatePreviewApplyResult(result);
      const toastMessage = firstError ? `${messageText} — ${firstError}` : messageText;
      EditProUtils.showMessage(messageEl, toastMessage, errorCount ? "warning" : "success");
      openCreatePreviewModal();
    } catch (error) {
      showCreatePreviewErrors(
        [{ collectionName: "Sync", message: error.message || "Failed to update collections." }],
        error.message || "Failed to update collections.",
        "error"
      );
      openCreatePreviewModal();
      EditProUtils.showMessage(messageEl, error.message || "Failed to update collections.", "error");
    } finally {
      setShopifyWorking(false);
    }
  }

  async function addNewCollections() {
    await previewAddNewCollections();
  }

  async function addToShopify() {
    await previewAddToShopify();
  }

    sidebarList?.addEventListener("click", (event) => {
    const selectAll = event.target.closest("[data-collection-check-all]");
    if (selectAll) {
      event.stopPropagation();
      setAllCollectionsSelected(selectAll.checked);
      return;
    }

    const check = event.target.closest("[data-collection-check]");
    if (check) {
      event.stopPropagation();
      const name = check.getAttribute("data-collection-check");
      if (!name) {
        return;
      }
      if (check.checked) {
        selectedCollections.add(name);
      } else {
        selectedCollections.delete(name);
      }
      syncSelectAllCheckbox();
      updateButtons();
      return;
    }

    const selectBtn = event.target.closest("[data-collection-select]");
    if (selectBtn) {
      const name = selectBtn.getAttribute("data-collection-select");
      if (!name) {
        return;
      }
      activeCollection = name;
      render();
    }
  });

  usePathBtn?.addEventListener("click", () => {
    scanPath();
  });

  addToShopifyBtn?.addEventListener("click", () => {
    addToShopify();
  });

  addNewCollectionsBtn?.addEventListener("click", () => {
    addNewCollections();
  });

  previewApplyBtn?.addEventListener("click", () => {
    applyTagsToShopify();
  });

  createPreviewApplyBtn?.addEventListener("click", () => {
    applyCreateCollections();
  });

  createPreviewViewErrorsBtn?.addEventListener("click", () => {
    toggleCreatePreviewErrorList();
  });

  previewCloseBtn?.addEventListener("click", closePreviewModal);
  previewCancelBtn?.addEventListener("click", closePreviewModal);
  previewModal?.querySelector("[data-collections-tag-preview-close]")?.addEventListener("click", closePreviewModal);

  createPreviewCloseBtn?.addEventListener("click", closeCreatePreviewModal);
  createPreviewCancelBtn?.addEventListener("click", closeCreatePreviewModal);
  createPreviewModal
    ?.querySelector("[data-collections-create-preview-close]")
    ?.addEventListener("click", closeCreatePreviewModal);

  rootPathInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      scanPath();
    }
  });

  searchInput?.addEventListener("input", () => {
    searchQuery = searchInput.value || "";
    renderProductGrid();
  });

  async function init() {
    loadRootPath();
    render();
    await loadCachedData();
  }

  init();
})();
