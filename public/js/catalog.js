(function initCatalogModule() {
  const STORAGE_KEY = "editpro-catalog-path";
  const FRAME_PATH_KEY = "editpro-catalog-frame-path";
  const LIFESTYLE_OUTPUT_KEY = "editpro-catalog-lifestyle-output-path";
  const PAGE_SIZE = 50;

  const pathInput = document.getElementById("catalogPathInput");
  const importBtn = document.getElementById("catalogImportBtn");
  const enrichBtn = document.getElementById("catalogEnrichBtn");
  const lifestyleBtn = document.getElementById("catalogLifestyleBtn");
  const fixSeoBtn = document.getElementById("catalogFixSeoBtn");
  const shopifyBtn = document.getElementById("catalogShopifyBtn");
  const orientationBtn = document.getElementById("catalogOrientationBtn");
  const framePathInput = document.getElementById("catalogFramePathInput");
  const framePathStatusEl = document.getElementById("catalogFramePathStatus");
  const lifestyleOutputInput = document.getElementById("catalogLifestyleOutputInput");
  const pythonAlertEl = document.getElementById("catalogPythonAlert");
  const pythonAlertTextEl = document.getElementById("catalogPythonAlertText");
  const filterOrientationEl = document.getElementById("catalogFilterOrientation");
  const filterShapeEl = document.getElementById("catalogFilterShape");
  const filterStatusEl = document.getElementById("catalogFilterStatus");
  const filterLifestyleEl = document.getElementById("catalogFilterLifestyle");
  const jobOverlayTitle = document.getElementById("catalogJobOverlayTitle");
  const exportLink = document.getElementById("catalogExportLink");
  const countBadge = document.getElementById("catalogCountBadge");
  const statsMeta = document.getElementById("catalogStatsMeta");
  const enrichStatusEl = document.getElementById("catalogEnrichStatus");
  const orientationStatusEl = document.getElementById("catalogOrientationStatus");
  const enrichOverlay = document.getElementById("catalogEnrichOverlay");
  const enrichOverlayStatus = document.getElementById("catalogEnrichOverlayStatus");
  const jobStopBtn = document.getElementById("catalogJobStopBtn");
  const tableBody = document.getElementById("catalogTableBody");
  const messageEl = document.getElementById("catalogMessage");
  const detailModal = document.getElementById("catalogDetailModal");
  const detailTitle = document.getElementById("catalogDetailTitle");
  const detailBody = document.getElementById("catalogDetailBody");
  const selectAllVisibleCheckbox = document.getElementById("catalogSelectAllVisibleCheckbox");
  const selectAllBar = document.getElementById("catalogBuilderSelectAllBar");
  const selectAllText = document.getElementById("catalogBuilderSelectAllText");
  const selectAllBtn = document.getElementById("catalogBuilderSelectAllBtn");
  const paginationEl = document.getElementById("catalogBuilderPagination");
  const prevBtn = document.getElementById("catalogBuilderPrevBtn");
  const nextBtn = document.getElementById("catalogBuilderNextBtn");
  const pageInfoEl = document.getElementById("catalogBuilderPageInfo");

  let catalogPath = EditProUtils.getDefaultCatalogBuilderPath();
  let frameTemplatesPath = "";
  let lifestyleOutputPath = "";
  let products = [];
  let lifestyleStats = null;
  let enrichPolling = null;
  let enrichStartedAt = null;
  let lifestylePolling = null;
  let activeOverlayJob = null;
  let orientationPolling = null;
  let openAiConfigured = false;
  let pythonReady = false;
  let pythonPackagesReady = false;
  let currentPage = 1;
  let selectedIds = new Set();
  let filterSelectAllActive = false;
  let showSelectAllBar = false;
  let orientationFilters = new Set();
  let shapeFilters = new Set();
  let statusFilters = new Set();
  let lifestyleFilters = new Set();

  function isEnrichEligible(row) {
    return row.status === "imported" || row.status === "error";
  }

  function isSeoFixEligible(row) {
    return row.status === "enriched" && (row.lifestyleImageCount || 0) > 0;
  }

  function isShopifyEligible(row) {
    return row.status === "enriched" && (row.lifestyleImageCount || 0) > 0;
  }

  function canSelect(row) {
    return Boolean(row.portraitPath);
  }

  function getEligibleProducts() {
    return products.filter(isEnrichEligible);
  }

  function getSelectableProducts() {
    return products.filter(canSelect);
  }

  function isSelected(productId) {
    return filterSelectAllActive || selectedIds.has(productId);
  }

  function pruneSelection() {
    const validIds = new Set(products.map((p) => p.productId));
    for (const id of selectedIds) {
      if (!validIds.has(id)) {
        selectedIds.delete(id);
      }
    }
    if (filterSelectAllActive) {
      const eligible = getEligibleProducts();
      if (!eligible.length) {
        filterSelectAllActive = false;
      }
    }
  }

  function getSelectedCount() {
    if (filterSelectAllActive) {
      return getSelectableProducts().length;
    }
    return selectedIds.size;
  }

  function readMultiselect(dropdown) {
    if (!dropdown) {
      return new Set();
    }
    return dropdown.getValues();
  }

  const filterDropdowns = {
    orientation: new MultiselectDropdown(filterOrientationEl, {
      placeholder: "Select",
      options: [
        { value: "not-set", label: "Not set" },
        { value: "square", label: "Square" },
        { value: "landscape", label: "Landscape" },
        { value: "portrait", label: "Portrait" },
      ],
      onChange: onFiltersChanged,
    }),
    shape: new MultiselectDropdown(filterShapeEl, {
      placeholder: "Select",
      options: [
        { value: "not-set", label: "Not set" },
        { value: "square", label: "Square" },
        { value: "rectangle", label: "Rectangle" },
      ],
      onChange: onFiltersChanged,
    }),
    status: new MultiselectDropdown(filterStatusEl, {
      placeholder: "Select",
      options: [
        { value: "imported", label: "Imported" },
        { value: "enriched", label: "Enriched" },
        { value: "error", label: "Error" },
      ],
      onChange: onFiltersChanged,
    }),
    lifestyle: new MultiselectDropdown(filterLifestyleEl, {
      placeholder: "Select",
      options: [
        { value: "has", label: "Has lifestyle" },
        { value: "none", label: "No lifestyle" },
      ],
      onChange: onFiltersChanged,
    }),
  };

  function matchesOrientationFilter(row) {
    if (!orientationFilters.size) {
      return true;
    }
    const orientation = String(row.orientation || "").toLowerCase().trim();
    if (!orientation) {
      return orientationFilters.has("not-set");
    }
    return orientationFilters.has(orientation);
  }

  function matchesShapeFilter(row) {
    if (!shapeFilters.size) {
      return true;
    }
    const shape = String(row.shape || "").toLowerCase().trim();
    if (!shape) {
      return shapeFilters.has("not-set");
    }
    return shapeFilters.has(shape);
  }

  function matchesStatusFilter(row) {
    if (!statusFilters.size) {
      return true;
    }
    const status = row.status || "imported";
    return statusFilters.has(status);
  }

  function matchesLifestyleFilter(row) {
    if (!lifestyleFilters.size) {
      return true;
    }
    const hasLifestyle = (row.lifestyleImageCount || 0) > 0;
    return (
      (hasLifestyle && lifestyleFilters.has("has")) ||
      (!hasLifestyle && lifestyleFilters.has("none"))
    );
  }

  function syncFilterStateFromUi() {
    orientationFilters = readMultiselect(filterDropdowns.orientation);
    shapeFilters = readMultiselect(filterDropdowns.shape);
    statusFilters = readMultiselect(filterDropdowns.status);
    lifestyleFilters = readMultiselect(filterDropdowns.lifestyle);
  }

  function getFilteredProducts() {
    return products.filter(
      (row) =>
        matchesOrientationFilter(row) &&
        matchesShapeFilter(row) &&
        matchesStatusFilter(row) &&
        matchesLifestyleFilter(row)
    );
  }

  function getVisiblePage() {
    const filtered = getFilteredProducts();
    const total = filtered.length;
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const page = Math.min(Math.max(1, currentPage), totalPages);
    const start = (page - 1) * PAGE_SIZE;
    return {
      items: filtered.slice(start, start + PAGE_SIZE),
      page,
      totalPages,
      total,
      start,
      filteredTotal: total,
      allTotal: products.length,
    };
  }

  function loadPaths() {
    try {
      let stored = localStorage.getItem(STORAGE_KEY);
      if (EditProUtils.isLegacyCatalogPath(stored)) {
        localStorage.removeItem(STORAGE_KEY);
        stored = null;
      }
      catalogPath = stored || EditProUtils.getDefaultCatalogBuilderPath();
      frameTemplatesPath = localStorage.getItem(FRAME_PATH_KEY) || "";
      lifestyleOutputPath = localStorage.getItem(LIFESTYLE_OUTPUT_KEY) || "";
    } catch {
      catalogPath = EditProUtils.getDefaultCatalogBuilderPath();
      frameTemplatesPath = "";
      lifestyleOutputPath = "";
    }
    if (pathInput) {
      pathInput.value = catalogPath;
    }
    if (framePathInput) {
      framePathInput.value = frameTemplatesPath;
    }
    if (lifestyleOutputInput) {
      lifestyleOutputInput.value = lifestyleOutputPath;
    }
    if (frameTemplatesPath) {
      validateFramePath();
    }
  }

  function saveAllPaths() {
    catalogPath = pathInput?.value?.trim() || catalogPath;
    frameTemplatesPath = framePathInput?.value?.trim() || "";
    lifestyleOutputPath = lifestyleOutputInput?.value?.trim() || "";
    try {
      localStorage.setItem(STORAGE_KEY, catalogPath);
      localStorage.setItem(FRAME_PATH_KEY, frameTemplatesPath);
      localStorage.setItem(LIFESTYLE_OUTPUT_KEY, lifestyleOutputPath);
    } catch {
      // ignore
    }
  }

  function saveFramePath() {
    frameTemplatesPath = framePathInput?.value?.trim() || "";
    try {
      localStorage.setItem(FRAME_PATH_KEY, frameTemplatesPath);
    } catch {
      // ignore
    }
    validateFramePath();
  }

  function renderFramePathStatus(summary) {
    if (!framePathStatusEl) {
      return;
    }
    if (!summary) {
      framePathStatusEl.hidden = true;
      framePathStatusEl.textContent = "";
      framePathStatusEl.className = "catalog-path-field-status meta";
      return;
    }
    const parts = [];
    if (summary.portrait) {
      parts.push(`Portrait: ${summary.portrait}`);
    }
    if (summary.landscape) {
      parts.push(`Landscape: ${summary.landscape}`);
    }
    if (summary.square) {
      parts.push(`Square: ${summary.square}`);
    }
    const total = (summary.portrait || 0) + (summary.landscape || 0) + (summary.square || 0);
    if (!total) {
      framePathStatusEl.textContent = summary.errors?.[0] || "No frame templates found.";
      framePathStatusEl.className = "catalog-path-field-status meta warning";
      framePathStatusEl.hidden = false;
      return;
    }
    framePathStatusEl.textContent = parts.join(" · ");
    framePathStatusEl.className = "catalog-path-field-status meta";
    framePathStatusEl.hidden = false;
  }

  async function validateFramePath() {
    const pathValue = framePathInput?.value?.trim() || "";
    if (!pathValue) {
      renderFramePathStatus(null);
      return;
    }
    try {
      const summary = await EditProUtils.apiPost("/api/catalog/lifestyle/validate-frames", {
        frameTemplatesPath: pathValue,
      });
      renderFramePathStatus(summary);
    } catch (error) {
      renderFramePathStatus({
        portrait: 0,
        landscape: 0,
        square: 0,
        errors: [error.message || "Could not validate frames."],
      });
    }
  }

  function saveLifestyleOutputPath() {
    lifestyleOutputPath = lifestyleOutputInput?.value?.trim() || "";
    try {
      localStorage.setItem(LIFESTYLE_OUTPUT_KEY, lifestyleOutputPath);
    } catch {
      // ignore
    }
  }

  function savePath() {
    catalogPath = pathInput?.value?.trim() || catalogPath;
    try {
      localStorage.setItem(STORAGE_KEY, catalogPath);
    } catch {
      // ignore
    }
  }

  function showMessage(text, type = "info") {
    if (!messageEl) {
      return;
    }
    messageEl.textContent = text;
    messageEl.className = `message seo-toast ${type}`;
    messageEl.classList.remove("hidden");
  }

  function hideMessage() {
    if (messageEl) {
      messageEl.classList.add("hidden");
    }
  }

  function thumbUrl(productId) {
    return EditProUtils.apiUrl(`/api/catalog/products/${encodeURIComponent(productId)}/image/0`);
  }

  function lifestyleThumbUrl(productId, index) {
    return EditProUtils.apiUrl(
      `/api/catalog/products/${encodeURIComponent(productId)}/lifestyle/${index}`
    );
  }

  function formatLifestyleLabel(row) {
    if (row.lifestyleStatus === "error") {
      return '<span class="room-map-status room-map-status--error">Error</span>';
    }
    const count = row.lifestyleImageCount || 0;
    if (!count) {
      return "—";
    }
    return `${count} image${count === 1 ? "" : "s"}`;
  }

  function formatShape(shape) {
    if (!shape) {
      return "—";
    }
    return shape.charAt(0).toUpperCase() + shape.slice(1);
  }

  function formatOrientation(orientation) {
    if (!orientation) {
      return "—";
    }
    return orientation.charAt(0).toUpperCase() + orientation.slice(1);
  }

  function statusLabel(status) {
    if (status === "enriched") {
      return "Enriched";
    }
    if (status === "error") {
      return "Error";
    }
    return "Imported";
  }

  function updateExportLink(hasEnriched) {
    if (!exportLink) {
      return;
    }
    if (hasEnriched) {
      exportLink.href = EditProUtils.apiUrl("/api/catalog/export");
      exportLink.hidden = false;
      exportLink.classList.remove("disabled");
    } else {
      exportLink.href = "#";
      exportLink.hidden = true;
      exportLink.classList.add("disabled");
    }
  }

  function updateButtons(jobActive) {
    const selectedCount = getSelectedCount();
    const enrichActive = Boolean(enrichPolling);
    const lifestyleActive = Boolean(lifestylePolling);
    const orientationActive = Boolean(orientationPolling);
    const busy = jobActive || enrichActive || lifestyleActive;
    if (importBtn) {
      importBtn.disabled = busy;
    }
    if (enrichBtn) {
      const enrichSelected = getSelectedEnrichEligibleCount();
      enrichBtn.disabled = busy || !enrichSelected || !openAiConfigured;
      enrichBtn.textContent =
        enrichSelected > 0
          ? `Generate with OpenAI (${enrichSelected})`
          : "Generate with OpenAI";
    }
    if (lifestyleBtn) {
      lifestyleBtn.disabled =
        busy || !selectedCount || !frameTemplatesPath || !lifestyleOutputPath || !pythonPackagesReady;
      lifestyleBtn.textContent =
        selectedCount > 0
          ? `Generate lifestyle images (${selectedCount})`
          : "Generate lifestyle images";
    }
    const seoFixSelected = getSelectedSeoFixEligibleCount();
    if (fixSeoBtn) {
      fixSeoBtn.disabled = busy || !seoFixSelected;
      fixSeoBtn.textContent =
        seoFixSelected > 0 ? `Fix SEO (${seoFixSelected})` : "Fix SEO";
    }
    const shopifySelected = getSelectedShopifyEligibleCount();
    if (shopifyBtn) {
      shopifyBtn.disabled = busy || !shopifySelected;
      shopifyBtn.textContent =
        shopifySelected > 0 ? `Add to Shopify (${shopifySelected})` : "Add to Shopify";
    }
    if (orientationBtn) {
      orientationBtn.disabled = orientationActive || !products.length || !pythonPackagesReady;
    }
  }

  function getSelectedSeoFixEligibleCount() {
    if (filterSelectAllActive) {
      return getSelectableProducts().filter(isSeoFixEligible).length;
    }
    return products.filter((p) => selectedIds.has(p.productId) && isSeoFixEligible(p)).length;
  }

  function getSelectedShopifyEligibleCount() {
    if (filterSelectAllActive) {
      return getSelectableProducts().filter(isShopifyEligible).length;
    }
    return products.filter((p) => selectedIds.has(p.productId) && isShopifyEligible(p)).length;
  }

  function getSelectedSeoFixProductIds() {
    if (filterSelectAllActive) {
      return getSelectableProducts().filter(isSeoFixEligible).map((p) => p.productId);
    }
    return products
      .filter((p) => selectedIds.has(p.productId) && isSeoFixEligible(p))
      .map((p) => p.productId);
  }

  function getSelectedShopifyProductIds() {
    if (filterSelectAllActive) {
      return getSelectableProducts().filter(isShopifyEligible).map((p) => p.productId);
    }
    return products
      .filter((p) => selectedIds.has(p.productId) && isShopifyEligible(p))
      .map((p) => p.productId);
  }

  function getSelectedEnrichEligibleCount() {
    if (filterSelectAllActive) {
      return getEligibleProducts().length;
    }
    return products.filter((p) => selectedIds.has(p.productId) && isEnrichEligible(p)).length;
  }

  function updatePythonAlert(message, ready) {
    if (!pythonAlertEl) {
      return;
    }
    if (ready) {
      pythonAlertEl.hidden = true;
      return;
    }
    if (pythonAlertTextEl) {
      pythonAlertTextEl.textContent = message;
    }
    pythonAlertEl.hidden = false;
  }

  function onFiltersChanged() {
    syncFilterStateFromUi();
    currentPage = 1;
    renderTable();
  }

  function renderPagination() {
    const { page, totalPages, total, start, items, allTotal } = getVisiblePage();
    if (!paginationEl) {
      return;
    }
    if (total <= PAGE_SIZE && allTotal <= PAGE_SIZE) {
      paginationEl.hidden = true;
      return;
    }
    paginationEl.hidden = false;
    if (pageInfoEl) {
      const end = Math.min(start + items.length, total);
      const suffix = total !== allTotal ? ` (filtered from ${allTotal})` : "";
      pageInfoEl.textContent = `${start + 1}–${end} of ${total}${suffix}`;
    }
    if (prevBtn) {
      prevBtn.disabled = page <= 1;
    }
    if (nextBtn) {
      nextBtn.disabled = page >= totalPages;
    }
  }

  function renderSelectAllBar() {
    if (!selectAllBar || !selectAllText || !selectAllBtn) {
      return;
    }

    const selectable = getSelectableProducts();
    const selectableTotal = selectable.length;
    const { items: visibleItems } = getVisiblePage();
    const visibleSelectable = visibleItems.filter(canSelect);

    if (selectableTotal === 0) {
      selectAllBar.hidden = true;
      return;
    }

    if (filterSelectAllActive) {
      const allSelected = selectable.every((p) => isSelected(p.productId));
      if (allSelected) {
        selectAllBar.hidden = false;
        selectAllText.textContent = `All ${selectableTotal} product${selectableTotal === 1 ? "" : "s"} are selected.`;
        selectAllBtn.hidden = true;
        return;
      }
      filterSelectAllActive = false;
    }

    if (!showSelectAllBar || selectableTotal <= visibleSelectable.length) {
      selectAllBar.hidden = true;
      return;
    }

    const allVisibleSelected =
      visibleSelectable.length > 0 &&
      visibleSelectable.every((p) => selectedIds.has(p.productId));

    if (!allVisibleSelected) {
      selectAllBar.hidden = true;
      showSelectAllBar = false;
      return;
    }

    selectAllBar.hidden = false;
    selectAllBtn.hidden = false;
    selectAllText.textContent = `All ${visibleSelectable.length} product${visibleSelectable.length === 1 ? "" : "s"} on this page are selected.`;
    selectAllBtn.textContent = `Select all ${selectableTotal} products`;
  }

  function updateHeaderCheckbox() {
    if (!selectAllVisibleCheckbox) {
      return;
    }
    const { items } = getVisiblePage();
    const selectableVisible = items.filter(canSelect);

    if (!selectableVisible.length) {
      selectAllVisibleCheckbox.checked = false;
      selectAllVisibleCheckbox.indeterminate = false;
      selectAllVisibleCheckbox.disabled = true;
      return;
    }

    selectAllVisibleCheckbox.disabled = false;

    if (filterSelectAllActive) {
      const allSelectable = getSelectableProducts();
      const allSelected = allSelectable.every((p) => isSelected(p.productId));
      selectAllVisibleCheckbox.checked = allSelected;
      selectAllVisibleCheckbox.indeterminate = false;
      return;
    }

    let selectedOnPage = 0;
    for (const row of selectableVisible) {
      if (selectedIds.has(row.productId)) {
        selectedOnPage += 1;
      }
    }

    selectAllVisibleCheckbox.checked = selectedOnPage === selectableVisible.length;
    selectAllVisibleCheckbox.indeterminate =
      selectedOnPage > 0 && selectedOnPage < selectableVisible.length;
  }

  function toggleVisibleSelection(checked) {
    const { items } = getVisiblePage();
    const selectableVisible = items.filter(canSelect);
    filterSelectAllActive = false;
    for (const row of selectableVisible) {
      if (checked) {
        selectedIds.add(row.productId);
      } else {
        selectedIds.delete(row.productId);
      }
    }
    showSelectAllBar = checked;
    renderTable();
    updateButtons(Boolean(enrichPolling || lifestylePolling || orientationPolling));
  }

  function toggleRowSelection(productId, checked) {
    filterSelectAllActive = false;
    if (checked) {
      selectedIds.add(productId);
    } else {
      selectedIds.delete(productId);
    }
    renderTable();
    updateButtons(Boolean(enrichPolling || lifestylePolling || orientationPolling));
  }

  function selectAllSelectable() {
    filterSelectAllActive = true;
    selectedIds.clear();
    showSelectAllBar = false;
    renderTable();
    updateButtons(Boolean(enrichPolling || lifestylePolling || orientationPolling));
  }

  function renderTable() {
    if (!tableBody) {
      return;
    }

    const { items, total, allTotal } = getVisiblePage();
    renderPagination();

    if (!allTotal) {
      tableBody.innerHTML =
        '<tr class="empty-row"><td colspan="10">Import a catalog folder to list products.</td></tr>';
      updateHeaderCheckbox();
      renderSelectAllBar();
      return;
    }

    if (!total) {
      tableBody.innerHTML =
        '<tr class="empty-row"><td colspan="10">No products match your filters.</td></tr>';
      updateHeaderCheckbox();
      renderSelectAllBar();
      return;
    }

    tableBody.innerHTML = items
      .map((row) => {
        const title = row.title || "—";
        const alt = row.description100 || "—";
        const selectable = canSelect(row);
        const checked = selectable && isSelected(row.productId);
        const statusClass =
          row.status === "enriched"
            ? "room-map-status--mapped"
            : row.status === "error"
              ? "room-map-status--error"
              : "room-map-status--unmapped";
        const rowClass = checked ? "catalog-row catalog-row--selected" : "catalog-row";
        return `<tr class="${rowClass}" data-product-id="${EditProUtils.escapeHtml(row.productId)}">
          <td class="col-check">
            <label class="catalog-item-check" onclick="event.stopPropagation()">
              <input type="checkbox" class="catalog-row-check" data-product-id="${EditProUtils.escapeHtml(row.productId)}" ${checked ? "checked" : ""} ${selectable ? "" : "disabled"} aria-label="Select ${EditProUtils.escapeHtml(row.productId)}" />
            </label>
          </td>
          <td class="catalog-col-thumb">
            <img class="room-map-thumb" src="${EditProUtils.escapeHtml(thumbUrl(row.productId))}" alt="" loading="lazy" />
          </td>
          <td>${EditProUtils.escapeHtml(row.productId)}</td>
          <td>${EditProUtils.escapeHtml(title)}</td>
          <td>${EditProUtils.escapeHtml(formatShape(row.shape))}</td>
          <td>${EditProUtils.escapeHtml(formatOrientation(row.orientation))}</td>
          <td>${row.tagCount || 0}</td>
          <td class="catalog-col-alt" title="${EditProUtils.escapeHtml(alt)}">${EditProUtils.escapeHtml(EditProUtils.truncate(alt, 50))}</td>
          <td class="catalog-col-lifestyle">${formatLifestyleLabel(row)}</td>
          <td><span class="room-map-status ${statusClass}">${statusLabel(row.status)}</span></td>
        </tr>`;
      })
      .join("");

    tableBody.querySelectorAll(".catalog-row").forEach((tr) => {
      tr.addEventListener("click", () => openDetail(tr.dataset.productId));
    });

    tableBody.querySelectorAll(".catalog-row-check").forEach((input) => {
      input.addEventListener("click", (event) => event.stopPropagation());
      input.addEventListener("change", (event) => {
        toggleRowSelection(event.target.dataset.productId, event.target.checked);
      });
    });

    updateHeaderCheckbox();
    renderSelectAllBar();
  }

  function renderSummary(data) {
    products = data?.products || [];
    pruneSelection();

    const total = data?.total ?? products.length;
    const enriched = data?.enriched ?? products.filter((p) => p.status === "enriched").length;
    const pending = data?.pending ?? products.filter((p) => p.status === "imported").length;
    const errors = data?.errors ?? products.filter((p) => p.status === "error").length;

    const { totalPages } = getVisiblePage();
    if (currentPage > totalPages) {
      currentPage = totalPages;
    }

    if (countBadge) {
      countBadge.textContent = `${total} product${total === 1 ? "" : "s"}`;
    }
    if (statsMeta) {
      const parts = [`${enriched} enriched`];
      if (pending) {
        parts.push(`${pending} pending`);
      }
      if (errors) {
        parts.push(`${errors} errors`);
      }
      const lifestyleTotal = lifestyleStats?.totalImages || 0;
      const lifestyleProducts = lifestyleStats?.productsWithImages || 0;
      if (lifestyleTotal > 0) {
        parts.push(
          `${lifestyleTotal} lifestyle image${lifestyleTotal === 1 ? "" : "s"} across ${lifestyleProducts} product${lifestyleProducts === 1 ? "" : "s"}`
        );
      }
      if (data?.lastImportAt) {
        parts.push(`imported ${new Date(data.lastImportAt).toLocaleString()}`);
      }
      statsMeta.textContent = parts.join(" · ");
    }
    lifestyleStats = data?.lifestyleStats || null;
    if (data?.lifestyleSettings?.frameTemplatesPath && !frameTemplatesPath) {
      frameTemplatesPath = data.lifestyleSettings.frameTemplatesPath;
      if (framePathInput) {
        framePathInput.value = frameTemplatesPath;
      }
      validateFramePath();
    }
    if (data?.lifestyleSettings?.outputPath && !lifestyleOutputPath) {
      lifestyleOutputPath = data.lifestyleSettings.outputPath;
      if (lifestyleOutputInput) {
        lifestyleOutputInput.value = lifestyleOutputPath;
      }
    }
    updateExportLink(enriched > 0);
    renderTable();
    updateButtons(Boolean(enrichPolling || lifestylePolling || orientationPolling));
  }

  async function refreshProducts() {
    const data = await EditProUtils.apiGet("/api/catalog/products");
    renderSummary(data);
    return data;
  }

  function renderOrientationStatus(status) {
    if (!orientationStatusEl) {
      return;
    }
    if (!status || status.state === "idle") {
      orientationStatusEl.hidden = true;
      return;
    }

    orientationStatusEl.hidden = false;
    if (status.state === "running") {
      orientationStatusEl.textContent = `Detecting orientation ${status.current} / ${status.total}${status.lastProductId ? ` — ${status.lastProductId}` : ""}`;
      orientationStatusEl.className = "meta room-map-scan-status";
    } else if (status.state === "done") {
      orientationStatusEl.textContent = `Orientation detection finished — ${status.processed} product${status.processed === 1 ? "" : "s"}${status.errors ? `, ${status.errors} error${status.errors === 1 ? "" : "s"}` : ""}.`;
      orientationStatusEl.className = "meta room-map-scan-status room-map-scan-status--done";
    } else if (status.state === "stopped") {
      orientationStatusEl.textContent = `Orientation detection stopped — ${status.processed} of ${status.total}.`;
      orientationStatusEl.className = "meta room-map-scan-status room-map-scan-status--stopped";
    } else if (status.state === "error") {
      orientationStatusEl.textContent = status.error || "Orientation detection failed.";
      orientationStatusEl.className = "meta room-map-scan-status room-map-scan-status--error";
    }
  }

  function stopOrientationPolling() {
    if (orientationPolling) {
      clearInterval(orientationPolling);
      orientationPolling = null;
    }
    updateButtons(false);
  }

  function startOrientationPolling() {
    stopOrientationPolling();
    orientationPolling = setInterval(async () => {
      try {
        const status = await EditProUtils.apiGet("/api/catalog/orientation/status");
        renderOrientationStatus(status);
        const data = await EditProUtils.apiGet("/api/catalog/products");
        products = data?.products || [];
        renderTable();
        if (status.state !== "running") {
          stopOrientationPolling();
          renderOrientationStatus(status);
        }
      } catch {
        stopOrientationPolling();
      }
    }, 2000);
  }

  async function checkOrientationJobOnLoad() {
    try {
      const status = await EditProUtils.apiGet("/api/catalog/orientation/status");
      renderOrientationStatus(status);
      if (status.state === "running") {
        startOrientationPolling();
      }
    } catch {
      // ignore
    }
  }

  async function refreshOpenAiStatus() {
    try {
      const data = await EditProUtils.apiGet("/api/openai/status");
      openAiConfigured = Boolean(data.configured);
    } catch {
      openAiConfigured = false;
    }
    updateButtons(Boolean(enrichPolling || lifestylePolling || orientationPolling));
  }

  async function setupPython({ silent = false } = {}) {
    try {
      let result = await EditProUtils.apiGet("/api/catalog/lifestyle/preflight");
      if (!result.packagesReady) {
        result = await EditProUtils.apiPost("/api/catalog/lifestyle/setup", {});
      }
      pythonReady = Boolean(result.pythonReady || result.ok);
      pythonPackagesReady = Boolean(result.packagesReady || result.ok);
      const message = `Python: ${result.message || (pythonPackagesReady ? "Ready" : "Setup required")}`;
      updatePythonAlert(message, pythonPackagesReady);
      if (!pythonPackagesReady && !silent) {
        showMessage(result.message || "Python setup incomplete.", "warning");
      }
    } catch (error) {
      pythonReady = false;
      pythonPackagesReady = false;
      updatePythonAlert(`Python: ${error.message || "Setup failed"}`, false);
      if (!silent) {
        showMessage(error.message || "Python setup failed.", "error");
      }
    }
    updateButtons(Boolean(enrichPolling || lifestylePolling || orientationPolling));
  }

  function updateOverlayStopButton({ visible = false, label = "Stop generation", disabled = false } = {}) {
    if (!jobStopBtn) {
      return;
    }
    jobStopBtn.hidden = !visible;
    jobStopBtn.textContent = label;
    jobStopBtn.disabled = disabled;
  }

  async function stopActiveOverlayJob() {
    if (!activeOverlayJob || jobStopBtn?.disabled) {
      return;
    }
    updateOverlayStopButton({
      visible: true,
      label: "Stopping…",
      disabled: true,
    });
    try {
      if (activeOverlayJob === "lifestyle") {
        await EditProUtils.apiPost("/api/catalog/lifestyle/stop", {});
      } else if (activeOverlayJob === "enrich") {
        await EditProUtils.apiPost("/api/catalog/enrich/stop", {});
      }
    } catch (error) {
      showMessage(error.message || "Failed to stop job.", "error");
      updateOverlayStopButton({
        visible: true,
        label: activeOverlayJob === "lifestyle" ? "Stop lifestyle generation" : "Stop enrichment",
        disabled: false,
      });
    }
  }

  function setJobOverlay(active, title, text) {
    if (enrichOverlay) {
      enrichOverlay.hidden = !active;
    }
    if (jobOverlayTitle && title) {
      jobOverlayTitle.textContent = title;
    }
    if (enrichOverlayStatus && text) {
      enrichOverlayStatus.textContent = text;
    }
    if (!active) {
      activeOverlayJob = null;
      updateOverlayStopButton({ visible: false });
    }
    updateButtons(active);
  }

  function setEnrichOverlay(active, text) {
    setJobOverlay(active, "Generating product data", text);
  }

  function renderLifestyleStatus(status) {
    const active = status?.state === "running";
    const avgKb = status?.avgBytesPerImage
      ? `${Math.round(status.avgBytesPerImage / 1024)} KB avg`
      : "";
    const overlayText = active
      ? `Product ${status.current} / ${status.total}${status.lastTitle ? ` — ${status.lastTitle}` : ""}`
      : status?.state === "done"
        ? `Done — ${status.productsProcessed} products, ${status.imagesCreated} images${avgKb ? `, ${avgKb}` : ""}`
        : "";
    setJobOverlay(active, "Generating lifestyle images", overlayText);
    if (active) {
      activeOverlayJob = "lifestyle";
      updateOverlayStopButton({
        visible: true,
        label: "Stop lifestyle generation",
        disabled: false,
      });
    }

    if (!status || status.state === "idle") {
      return;
    }
    if (status.state === "done") {
      showMessage(
        `Lifestyle generation finished — ${status.productsProcessed} product${status.productsProcessed === 1 ? "" : "s"}, ${status.imagesCreated} image${status.imagesCreated === 1 ? "" : "s"}${avgKb ? `, ${avgKb} per image` : ""}.`,
        status.errors ? "warning" : "success"
      );
    } else if (status.state === "error") {
      showMessage(status.error || "Lifestyle generation failed.", "error");
    } else if (status.state === "stopped") {
      showMessage("Lifestyle generation stopped.", "warning");
    }
  }

  function stopLifestylePolling() {
    if (lifestylePolling) {
      clearInterval(lifestylePolling);
      lifestylePolling = null;
    }
    if (!enrichPolling) {
      setJobOverlay(false);
    }
  }

  function startLifestylePolling() {
    stopLifestylePolling();
    lifestylePolling = setInterval(async () => {
      try {
        const status = await EditProUtils.apiGet("/api/catalog/lifestyle/status");
        renderLifestyleStatus(status);
        await refreshProducts();
        if (status.state !== "running") {
          stopLifestylePolling();
          updateButtons(false);
        }
      } catch {
        stopLifestylePolling();
        updateButtons(false);
      }
    }, 1500);
  }

  function formatEnrichEta(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) {
      return "";
    }
    if (seconds < 60) {
      return `~${Math.ceil(seconds)}s left`;
    }
    return `~${Math.ceil(seconds / 60)} min left`;
  }

  function getEnrichEtaText(status) {
    if (!enrichStartedAt || !status || status.current <= 0 || status.total <= status.current) {
      return "";
    }
    const elapsedSec = (Date.now() - enrichStartedAt) / 1000;
    const avgSec = elapsedSec / status.current;
    return formatEnrichEta(avgSec * (status.total - status.current));
  }

  function renderEnrichStatus(status) {
    if (!enrichStatusEl) {
      return;
    }
    const active = status?.state === "running" || status?.state === "paused";
    const etaText = status?.state === "running" ? getEnrichEtaText(status) : "";
    const overlayParts = [];
    if (status?.state === "running") {
      overlayParts.push(`${status.current} / ${status.total}`);
      if (etaText) {
        overlayParts.push(etaText);
      }
      if (status.lastTitle) {
        overlayParts.push(status.lastTitle);
      }
    } else if (status?.lastTitle) {
      overlayParts.push(`Last: ${status.lastTitle}`);
    } else {
      overlayParts.push("Calling OpenAI…");
    }
    setEnrichOverlay(active, overlayParts.join(" — "));
    if (active) {
      activeOverlayJob = "enrich";
      updateOverlayStopButton({
        visible: true,
        label: "Stop enrichment",
        disabled: false,
      });
    }

    if (!status || status.state === "idle") {
      enrichStatusEl.hidden = true;
      return;
    }

    enrichStatusEl.hidden = false;
    if (status.state === "running") {
      const etaPart = etaText ? ` — ${etaText}` : "";
      enrichStatusEl.textContent = `Generating ${status.current} / ${status.total} (${status.concurrency || 1} parallel)${etaPart}${status.lastTitle ? ` — ${status.lastTitle}` : ""}`;
      enrichStatusEl.className = "meta room-map-scan-status";
    } else if (status.state === "paused") {
      enrichStatusEl.textContent = `Paused — ${status.pauseReason || "system load"}`;
      enrichStatusEl.className = "meta room-map-scan-status room-map-scan-status--paused";
    } else if (status.state === "done") {
      enrichStatusEl.textContent = `Finished — enriched ${status.enriched} of ${status.total}.`;
      enrichStatusEl.className = "meta room-map-scan-status room-map-scan-status--done";
    } else if (status.state === "stopped") {
      enrichStatusEl.textContent = `Stopped — enriched ${status.enriched} of ${status.total}.`;
      enrichStatusEl.className = "meta room-map-scan-status room-map-scan-status--stopped";
    } else if (status.state === "error") {
      enrichStatusEl.textContent = status.error || "Enrichment failed.";
      enrichStatusEl.className = "meta room-map-scan-status room-map-scan-status--error";
    }
  }

  function stopEnrichPolling() {
    if (enrichPolling) {
      clearInterval(enrichPolling);
      enrichPolling = null;
    }
    enrichStartedAt = null;
    setEnrichOverlay(false);
  }

  function startEnrichPolling() {
    stopEnrichPolling();
    enrichStartedAt = Date.now();
    enrichPolling = setInterval(async () => {
      try {
        const status = await EditProUtils.apiGet("/api/catalog/enrich/status");
        renderEnrichStatus(status);
        await refreshProducts();
        if (status.state !== "running" && status.state !== "paused") {
          stopEnrichPolling();
          updateButtons(false);
        }
      } catch {
        stopEnrichPolling();
        updateButtons(false);
      }
    }, 2000);
  }

  function formatLifestyleCaption(img) {
    const indexPart = img.index != null ? `#${img.index}` : "";
    const roomPart = img.roomLabel || formatOrientation(img.room) || "";
    if (indexPart && roomPart) {
      return `${indexPart} · ${roomPart}`;
    }
    if (indexPart) {
      return indexPart;
    }
    if (roomPart) {
      return roomPart;
    }
    return img.filename || img.frameTemplate || "—";
  }

  async function openDetail(productId) {
    if (!detailModal || !detailBody || !detailTitle) {
      return;
    }
    try {
      const product = await EditProUtils.apiGet(
        `/api/catalog/products/${encodeURIComponent(productId)}`
      );
      detailTitle.textContent = product.title || `Product ${productId}`;
      const colors = (product.colors || []).join(", ") || "—";
      const tags = (product.tags || []).join(", ") || "—";
      const minPrice = product.variants?.length
        ? Math.min(...product.variants.map((v) => Number(v.price) || 0))
        : "—";
      const maxPrice = product.variants?.length
        ? Math.max(...product.variants.map((v) => Number(v.price) || 0))
        : "—";

      const lifestyleImages = [...(product.lifestyleImages || [])].sort(
        (a, b) => (a.index ?? 0) - (b.index ?? 0)
      );
      const lifestyleGallery = lifestyleImages.length
        ? `<div class="catalog-lifestyle-gallery">${lifestyleImages
            .map(
              (img) => `<figure class="catalog-lifestyle-figure">
              <img class="catalog-lifestyle-thumb" src="${EditProUtils.escapeHtml(lifestyleThumbUrl(product.productId, img.index))}" alt="${EditProUtils.escapeHtml(img.filename || "")}" loading="lazy" />
              <figcaption class="meta catalog-lifestyle-caption">${EditProUtils.escapeHtml(formatLifestyleCaption(img))}</figcaption>
            </figure>`
            )
            .join("")}</div>`
        : '<p class="meta">No lifestyle images yet. Select this product and click Generate lifestyle images.</p>';

      detailBody.innerHTML = `
        <p class="meta">ID ${EditProUtils.escapeHtml(product.productId)} · Shape ${EditProUtils.escapeHtml(formatShape(product.shape))} · Orientation ${EditProUtils.escapeHtml(formatOrientation(product.orientation))} · ${product.variants?.length || 0} variants · ₹${minPrice}–₹${maxPrice}</p>
        <h3 class="catalog-detail-section-title">Source painting (builder only)</h3>
        <img class="catalog-detail-source-thumb" src="${EditProUtils.escapeHtml(thumbUrl(product.productId))}" alt="Source painting" />
        <h3 class="catalog-detail-section-title">Lifestyle images (${lifestyleImages.length})</h3>
        ${product.lifestyleOutputFolder ? `<p class="meta"><strong>Output folder:</strong> ${EditProUtils.escapeHtml(product.lifestyleOutputFolder)}</p>` : ""}
        ${lifestyleGallery}
        ${product.lifestyleError ? `<p class="message warning">${EditProUtils.escapeHtml(product.lifestyleError)}</p>` : ""}
        <h3 class="catalog-detail-section-title">Product copy</h3>
        <p><strong>Description</strong></p>
        <p>${EditProUtils.escapeHtml(product.descriptionPlain || "—")}</p>
        <p class="meta"><strong>Alt (100):</strong> ${EditProUtils.escapeHtml(product.description100 || "—")}</p>
        <p class="meta"><strong>Colors:</strong> ${EditProUtils.escapeHtml(colors)}</p>
        <p class="meta"><strong>Tags:</strong> ${EditProUtils.escapeHtml(tags)}</p>
        <p class="meta"><strong>SEO title:</strong> ${EditProUtils.escapeHtml(product.seoTitle || "—")}</p>
        <p class="meta"><strong>SEO description:</strong> ${EditProUtils.escapeHtml(product.seoDescription || "—")}</p>
        ${product.error ? `<p class="message error">${EditProUtils.escapeHtml(product.error)}</p>` : ""}
      `;
      detailModal.hidden = false;
    } catch (error) {
      showMessage(error.message || "Failed to load product.", "error");
    }
  }

  function closeDetail() {
    if (detailModal) {
      detailModal.hidden = true;
    }
  }

  function getSelectedProductIds() {
    if (filterSelectAllActive) {
      return getSelectableProducts().map((p) => p.productId);
    }
    return [...selectedIds];
  }

  pathInput?.addEventListener("blur", savePath);
  framePathInput?.addEventListener("blur", saveFramePath);
  lifestyleOutputInput?.addEventListener("blur", saveLifestyleOutputPath);

  jobStopBtn?.addEventListener("click", () => {
    stopActiveOverlayJob();
  });

  if (lifestyleBtn) {
    lifestyleBtn.addEventListener("click", async () => {
      saveAllPaths();
      const productIds = getSelectedProductIds();
      if (!productIds.length) {
        showMessage("Select at least one product.", "warning");
        return;
      }
      if (!frameTemplatesPath || !lifestyleOutputPath) {
        showMessage("Set Frames and Export paths first.", "warning");
        return;
      }
      hideMessage();
      lifestyleBtn.disabled = true;
      try {
        if (!pythonPackagesReady) {
          await setupPython({ silent: true });
        }
        const status = await EditProUtils.apiPost("/api/catalog/lifestyle/start", {
          productIds,
          frameTemplatesPath,
          outputPath: lifestyleOutputPath,
        });
        renderLifestyleStatus(status);
        startLifestylePolling();
      } catch (error) {
        showMessage(error.message || "Failed to start lifestyle generation.", "error");
        lifestyleBtn.disabled = false;
        updateButtons(false);
      }
    });
  }

  if (orientationBtn) {
    orientationBtn.addEventListener("click", async () => {
      hideMessage();
      orientationBtn.disabled = true;
      try {
        if (!pythonPackagesReady) {
          await setupPython({ silent: true });
        }
        const productIds = getSelectedProductIds();
        const status = await EditProUtils.apiPost("/api/catalog/orientation/start", {
          productIds: productIds.length ? productIds : null,
        });
        renderOrientationStatus(status);
        startOrientationPolling();
      } catch (error) {
        showMessage(error.message || "Failed to start orientation detection.", "error");
        orientationBtn.disabled = false;
        updateButtons(false);
      }
    });
  }

  if (importBtn) {
    importBtn.addEventListener("click", async () => {
      saveAllPaths();
      hideMessage();
      importBtn.disabled = true;
      try {
        const data = await EditProUtils.apiPost("/api/catalog/import", { catalogPath });
        currentPage = 1;
        renderSummary(data);
        const skippedNote =
          data.skipped?.length > 0 ? ` · ${data.skipped.length} folder(s) skipped` : "";
        showMessage(
          `Imported ${data.imported} product(s) (${data.added} new, ${data.updated} updated)${skippedNote}.`,
          "success"
        );
        if (data.orientationProductIds?.length) {
          startOrientationPolling();
        }
      } catch (error) {
        showMessage(error.message || "Import failed.", "error");
      } finally {
        importBtn.disabled = false;
        updateButtons(Boolean(enrichPolling || lifestylePolling || orientationPolling));
      }
    });
  }

  if (enrichBtn) {
    enrichBtn.addEventListener("click", async () => {
      const productIds = getSelectedProductIds().filter((id) => {
        const row = products.find((p) => p.productId === id);
        return row && isEnrichEligible(row);
      });
      if (!productIds.length) {
        showMessage("Select at least one product to generate.", "warning");
        return;
      }
      hideMessage();
      enrichBtn.disabled = true;
      try {
        const status = await EditProUtils.apiPost("/api/catalog/enrich/start", { productIds });
        renderEnrichStatus(status);
        startEnrichPolling();
      } catch (error) {
        showMessage(error.message || "Failed to start enrichment.", "error");
        enrichBtn.disabled = false;
        updateButtons(false);
      }
    });
  }

  selectAllVisibleCheckbox?.addEventListener("change", (event) => {
    toggleVisibleSelection(event.target.checked);
  });

  selectAllBtn?.addEventListener("click", () => {
    selectAllSelectable();
  });

  prevBtn?.addEventListener("click", () => {
    if (currentPage > 1) {
      currentPage -= 1;
      renderTable();
    }
  });

  nextBtn?.addEventListener("click", () => {
    const { totalPages } = getVisiblePage();
    if (currentPage < totalPages) {
      currentPage += 1;
      renderTable();
    }
  });

  document.querySelectorAll("[data-catalog-detail-close]").forEach((el) => {
    el.addEventListener("click", closeDetail);
  });

  document.addEventListener("editpro:module-changed", (event) => {
    if (event.detail?.moduleId === "catalog") {
      refreshProducts().catch(() => {});
      refreshOpenAiStatus();
      setupPython({ silent: true });
      checkOrientationJobOnLoad();
    }
  });

  document.addEventListener("editpro:settings-loaded", () => {
    if (!localStorage.getItem(STORAGE_KEY)) {
      catalogPath = EditProUtils.getDefaultCatalogBuilderPath();
      if (pathInput) {
        pathInput.value = catalogPath;
      }
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeDetail();
    }
  });

  loadPaths();
  refreshOpenAiStatus();
  setupPython({ silent: true });
  refreshProducts()
    .catch(() => {})
    .finally(() => {
      checkOrientationJobOnLoad();
    });

  window.EditProCatalog = {
    getProducts: () => products,
    getProductRow: (productId) => products.find((p) => p.productId === productId) || null,
    getSelectedProductIds,
    getSelectedSeoFixProductIds,
    getSelectedShopifyProductIds,
    isSeoFixEligible,
    isShopifyEligible,
    refreshProducts,
    showMessage,
  };
})();
