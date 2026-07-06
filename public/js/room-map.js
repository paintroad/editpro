(function initRoomMapModule() {
  const coverageEl = document.getElementById("roomMapCoverage");
  const scanStatusEl = document.getElementById("roomMapScanStatus");
  const statusBadge = document.getElementById("roomMapStatusBadge");
  const openAiModelInput = document.getElementById("roomMapOpenAiModel");
  const openAiKeyInput = document.getElementById("roomMapOpenAiKey");
  const openAiConcurrencyInput = document.getElementById("roomMapOpenAiConcurrency");
  const saveOpenAiBtn = document.getElementById("roomMapSaveOpenAiBtn");
  const mapBtn = document.getElementById("roomMapScanBtn");
  const searchInput = document.getElementById("roomMapSearch");
  const sortSelect = document.getElementById("roomMapSort");
  const filterBar = document.querySelector("#module-roommap .room-map-filter-bar");
  const paginationEl = document.getElementById("roomMapPagination");
  const pageInfoEl = document.getElementById("roomMapPageInfo");
  const prevBtn = document.getElementById("roomMapPrevBtn");
  const nextBtn = document.getElementById("roomMapNextBtn");
  const tableBody = document.getElementById("roomMapTableBody");
  const messageEl = document.getElementById("roomMapMessage");
  const emptyEl = document.getElementById("roomMapEmpty");
  const tableWrap = document.getElementById("roomMapTableWrap");
  const openAiStatusBadge = document.getElementById("roomMapOpenAiStatusBadge");
  const openAiStatusText = document.getElementById("roomMapOpenAiStatusText");

  let jobActive = false;
  let summary = null;
  let openAiConfigured = false;
  let renderTableTimer = null;
  const PAGE_SIZE = 50;
  let currentPage = 1;
  let mapFilter = "all";

  function getStoreData() {
    return window.EditProLive?.getStoreData?.() || {
      products: [],
      collections: [],
      articles: [],
    };
  }

  function hasCatalog() {
    const data = getStoreData();
    return (
      (data.products?.length || 0) +
        (data.collections?.length || 0) +
        (data.articles?.length || 0) >
      0
    );
  }

  function resourceTypeLabel(type) {
    if (type === "product") {
      return "Product";
    }
    if (type === "collection") {
      return "Collection";
    }
    return "Blog";
  }

  function formatNumber(n) {
    return Number(n || 0).toLocaleString();
  }

  function formatResumeCountdown(resumeAt) {
    if (!resumeAt) {
      return "";
    }
    const ms = new Date(resumeAt).getTime() - Date.now();
    if (ms <= 0) {
      return "soon";
    }
    const mins = Math.ceil(ms / 60000);
    return mins <= 1 ? "about 1 minute" : `about ${mins} minutes`;
  }

  function renderScanStatus(status) {
    if (!scanStatusEl) {
      return;
    }
    if (!status || !EditProImageRoomMap.isJobActive(status)) {
      if (status?.state === "done") {
        scanStatusEl.hidden = false;
        const portraitNote =
          status.portraits > 0 ? ` ${status.portraits} portrait${status.portraits === 1 ? "" : "s"} auto-mapped.` : "";
        scanStatusEl.textContent = `Finished — mapped ${status.mapped} lifestyle image${status.mapped === 1 ? "" : "s"}.${portraitNote}`;
        scanStatusEl.className = "meta room-map-scan-status room-map-scan-status--done";
        return;
      }
      if (status?.state === "stopped") {
        scanStatusEl.hidden = false;
        scanStatusEl.textContent = `Stopped — mapped ${status.mapped} of ${status.total}.`;
        scanStatusEl.className = "meta room-map-scan-status room-map-scan-status--stopped";
        return;
      }
      if (status?.state === "error") {
        scanStatusEl.hidden = false;
        scanStatusEl.textContent = status.error || "Room mapping failed.";
        scanStatusEl.className = "meta room-map-scan-status room-map-scan-status--error";
        return;
      }
      scanStatusEl.hidden = true;
      scanStatusEl.textContent = "";
      return;
    }

    scanStatusEl.hidden = false;
    if (status.state === "paused") {
      const when = formatResumeCountdown(status.resumeAt);
      scanStatusEl.textContent = `Paused (${status.pauseReason || "system load"}) — resumes in ${when}.`;
      scanStatusEl.className = "meta room-map-scan-status room-map-scan-status--paused";
      return;
    }

    const phase =
      status.phase === "catalog"
        ? "Loading catalog…"
        : `Mapping ${status.current} / ${status.total}${status.concurrency ? ` (${status.concurrency} parallel)` : ""}`;
    const detail =
      status.lastResourceTitle && status.lastRoom
        ? ` — ${EditProImageRoomMap.roomToTitleCase(status.lastRoom)} on ${status.lastResourceTitle}`
        : "";
    scanStatusEl.textContent = `${phase}${detail}`;
    scanStatusEl.className = "meta room-map-scan-status room-map-scan-status--running";
  }

  function renderOpenAiStatus(status) {
    openAiConfigured = Boolean(status?.configured);
    if (!openAiStatusBadge || !openAiStatusText) {
      return;
    }

    if (!status) {
      openAiStatusBadge.textContent = "Checking…";
      openAiStatusBadge.className = "room-map-openai-pill room-map-openai-pill--checking";
      openAiStatusText.textContent = "Checking API key…";
      updateMapButton();
      return;
    }

    if (status.configured) {
      openAiStatusBadge.textContent = "Configured";
      openAiStatusBadge.className = "room-map-openai-pill room-map-openai-pill--running";
      const masked = status.apiKeyMasked ? ` Key: ${status.apiKeyMasked}` : "";
      openAiStatusText.textContent = `OpenAI API key is ready.${masked}`;
    } else {
      openAiStatusBadge.textContent = "Missing key";
      openAiStatusBadge.className = "room-map-openai-pill room-map-openai-pill--missing";
      openAiStatusText.textContent =
        "Set OPENAI_API_KEY in the server environment or save a key below.";
    }
    updateMapButton();
  }

  function updateMapButton() {
    if (!mapBtn || !summary) {
      return;
    }
    if (jobActive) {
      mapBtn.disabled = false;
      mapBtn.textContent = "Stop mapping";
      mapBtn.classList.remove("btn-primary");
      mapBtn.classList.add("btn-secondary");
      return;
    }
    mapBtn.classList.add("btn-primary");
    mapBtn.classList.remove("btn-secondary");
    mapBtn.disabled = !hasCatalog() || summary.unmapped === 0 || !openAiConfigured;
    mapBtn.textContent =
      summary.unmapped > 0
        ? `Map unmapped images (${formatNumber(summary.unmapped)})`
        : "All lifestyle images mapped";
  }

  async function refreshOpenAiStatus() {
    const rd = window.EditProSettings?.roomDetection || {};
    const settingsFallback = {
      configured: Boolean(rd.hasOpenAiApiKey),
      apiKeyMasked: rd.openaiApiKeyMasked || "",
    };
    try {
      const status = await EditProUtils.apiGet("/api/openai/status");
      renderOpenAiStatus(status);
      return status;
    } catch (error) {
      if (settingsFallback.configured) {
        renderOpenAiStatus(settingsFallback);
        return settingsFallback;
      }
      renderOpenAiStatus({ configured: false, error: error.message });
      return null;
    }
  }

  function getShopifyStoreDomain() {
    return (
      window.EditProSettings?.storeDomain ||
      document.getElementById("storeDomain")?.value?.trim() ||
      ""
    );
  }

  function applyOpenAiFields() {
    const rd = window.EditProSettings?.roomDetection || {};
    if (openAiModelInput) {
      openAiModelInput.value = rd.openaiModel || "gpt-4o";
    }
    if (openAiConcurrencyInput) {
      openAiConcurrencyInput.value = String(rd.openaiConcurrency ?? 8);
    }
    if (openAiKeyInput) {
      openAiKeyInput.value = "";
      openAiKeyInput.placeholder = rd.hasOpenAiApiKey
        ? `Saved key: ${rd.openaiApiKeyMasked} (leave blank to keep)`
        : "sk-… (or set OPENAI_API_KEY env)";
    }
    if (rd.hasOpenAiApiKey) {
      renderOpenAiStatus({
        configured: true,
        apiKeyMasked: rd.openaiApiKeyMasked,
      });
    }
  }

  async function saveOpenAiSettings() {
    EditProUtils.hideMessage(messageEl);
    saveOpenAiBtn.disabled = true;
    saveOpenAiBtn.textContent = "Saving…";
    try {
      const roomDetection = {
        openaiModel: openAiModelInput?.value.trim() || "gpt-4o",
        openaiConcurrency: Math.min(
          32,
          Math.max(1, parseInt(openAiConcurrencyInput?.value, 10) || 8)
        ),
      };
      const keyValue = openAiKeyInput?.value.trim();
      if (keyValue) {
        roomDetection.openaiApiKey = keyValue;
      }
      const data = await EditProUtils.apiPost("/api/settings", {
        shopify: { storeDomain: getShopifyStoreDomain(), accessToken: "" },
        rules: window.EditProSettings?.rules,
        descriptionPhrases: window.EditProSettings?.descriptionPhrases,
        roomDetection,
      });
      window.EditProSettings = window.EditProSettings || {};
      window.EditProSettings.roomDetection = data.roomDetection;
      if (data.shopify?.storeDomain) {
        window.EditProSettings.storeDomain = data.shopify.storeDomain;
      }
      if (openAiKeyInput) {
        openAiKeyInput.value = "";
      }
      applyOpenAiFields();
      await refreshOpenAiStatus();
      EditProUtils.showMessage(messageEl, "OpenAI settings saved.", "success");
    } catch (error) {
      EditProUtils.showMessage(messageEl, error.message, "error");
    } finally {
      saveOpenAiBtn.disabled = false;
      saveOpenAiBtn.textContent = "Save";
    }
  }

  function getFilteredRows() {
    if (!summary?.rows) {
      return [];
    }
    let rows = [...summary.rows];
    const q = (searchInput?.value || "").trim().toLowerCase();
    if (q) {
      rows = rows.filter((r) => (r.resourceTitle || "").toLowerCase().includes(q));
    }
    if (mapFilter === "mapped") {
      rows = rows.filter((r) => r.mapped);
    } else if (mapFilter === "unmapped") {
      rows = rows.filter((r) => !r.mapped);
    }
    const sort = sortSelect?.value || "title-asc";
    rows.sort((a, b) => {
      if (sort === "room-asc") {
        return (a.room || "zzz").localeCompare(b.room || "zzz");
      }
      if (sort === "unmapped-first") {
        if (a.mapped !== b.mapped) {
          return a.mapped ? 1 : -1;
        }
      }
      return (a.resourceTitle || "").localeCompare(b.resourceTitle || "");
    });
    return rows;
  }

  function getVisiblePage() {
    const filtered = getFilteredRows();
    const total = filtered.length;
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const page = Math.min(Math.max(1, currentPage), totalPages);
    const start = (page - 1) * PAGE_SIZE;
    return {
      items: filtered.slice(start, start + PAGE_SIZE),
      total,
      page,
      totalPages,
    };
  }

  function updatePagination(total, page, totalPages) {
    if (!paginationEl) {
      return;
    }
    if (total === 0) {
      paginationEl.hidden = true;
      if (pageInfoEl) {
        pageInfoEl.textContent = "";
      }
      if (prevBtn) {
        prevBtn.disabled = true;
      }
      if (nextBtn) {
        nextBtn.disabled = true;
      }
      return;
    }
    paginationEl.hidden = false;
    if (pageInfoEl) {
      pageInfoEl.textContent = `${(page - 1) * PAGE_SIZE + 1}–${Math.min(page * PAGE_SIZE, total)} of ${total}`;
    }
    if (prevBtn) {
      prevBtn.disabled = page <= 1;
    }
    if (nextBtn) {
      nextBtn.disabled = page >= totalPages;
    }
  }

  function renderRowHtml(row) {
    const roomLabel = row.mapped ? EditProImageRoomMap.roomToTitleCase(row.room) : "—";
    const statusClass = row.mapped ? "room-map-status--mapped" : "room-map-status--unmapped";
    const statusText = row.mapped ? "Mapped" : "Unmapped";
    return `<tr>
      <td class="room-map-col-image">
        <img class="room-map-thumb" src="${EditProUtils.escapeHtml(row.url)}" alt="" loading="lazy" />
      </td>
      <td class="room-map-col-resource">
        <span class="room-map-resource-title">${EditProUtils.escapeHtml(row.resourceTitle)}</span>
        <span class="room-map-type-badge">${EditProUtils.escapeHtml(resourceTypeLabel(row.resourceType))}</span>
      </td>
      <td class="room-map-col-index">${row.imageIndex}</td>
      <td class="room-map-col-room">
        ${row.mapped ? `<span class="room-map-room-badge">${EditProUtils.escapeHtml(roomLabel)}</span>` : `<span class="room-map-room-empty">Unmapped</span>`}
      </td>
      <td class="room-map-col-status"><span class="room-map-status ${statusClass}">${statusText}</span></td>
    </tr>`;
  }

  function renderTableNow() {
    if (!tableBody) {
      return;
    }
    const { items, total, page, totalPages } = getVisiblePage();
    currentPage = page;
    updatePagination(total, page, totalPages);
    if (!items.length) {
      tableBody.innerHTML =
        '<tr class="empty-row"><td colspan="5">No images match your filters.</td></tr>';
      return;
    }
    tableBody.innerHTML = items.map(renderRowHtml).join("");
  }

  function renderTableThrottled() {
    if (renderTableTimer) {
      return;
    }
    renderTableTimer = setTimeout(() => {
      renderTableTimer = null;
      renderTableNow();
    }, 500);
  }

  function renderCoverage() {
    if (!summary) {
      return;
    }
    if (coverageEl) {
      const portraitNote =
        summary.portraits > 0
          ? ` · ${formatNumber(summary.portraits)} portrait${summary.portraits === 1 ? "" : "s"} auto`
          : "";
      coverageEl.textContent = `${formatNumber(summary.lifestyleMapped)} / ${formatNumber(summary.scannable)} lifestyle mapped${portraitNote}`;
    }
    if (statusBadge) {
      statusBadge.textContent = summary.complete ? "Complete" : "Incomplete";
      statusBadge.className = `badge room-map-status-badge ${
        summary.complete ? "room-map-status-badge--complete" : "room-map-status-badge--incomplete"
      }`;
    }
    updateMapButton();
  }

  function syncSummaryFromMappings() {
    summary = EditProImageRoomMap.getSummary(getStoreData());
    renderCoverage();
    renderTableThrottled();
  }

  function onScanStatusUpdate(status) {
    jobActive = EditProImageRoomMap.isJobActive(status);
    renderScanStatus(status);
    syncSummaryFromMappings();
    updateMapButton();

    if (status.state === "done") {
      jobActive = false;
      EditProImageRoomMap.stopPolling();
      const portraitNote =
        status.portraits > 0 ? ` ${status.portraits} portrait${status.portraits === 1 ? "" : "s"} auto-mapped.` : "";
      EditProUtils.showMessage(
        messageEl,
        `Mapped ${status.mapped} lifestyle image${status.mapped === 1 ? "" : "s"}. ${status.skipped || 0} already mapped.${portraitNote}`,
        "success"
      );
      updateMapButton();
    } else if (status.state === "error") {
      jobActive = false;
      EditProImageRoomMap.stopPolling();
      EditProUtils.showMessage(messageEl, status.error || "Room mapping failed.", "error");
      updateMapButton();
    } else if (status.state === "stopped") {
      jobActive = false;
      EditProImageRoomMap.stopPolling();
      EditProUtils.showMessage(messageEl, `Mapping stopped (${status.mapped} mapped).`, "warning");
      updateMapButton();
    }
  }

  async function resumePollingIfNeeded() {
    try {
      const status = await EditProImageRoomMap.getScanStatus();
      if (EditProImageRoomMap.isJobActive(status)) {
        jobActive = true;
        renderScanStatus(status);
        updateMapButton();
        EditProImageRoomMap.startPolling(onScanStatusUpdate);
      } else {
        renderScanStatus(status);
      }
    } catch {
      // ignore
    }
  }

  async function refresh() {
    applyOpenAiFields();
    await refreshOpenAiStatus();
    const connected = window.EditProSettings?.connected;
    const catalog = hasCatalog();

    if (!connected) {
      if (emptyEl) {
        emptyEl.hidden = false;
        emptyEl.textContent = "Connect your store in SEO Engine.";
      }
      if (tableWrap) {
        tableWrap.hidden = true;
      }
      if (mapBtn) {
        mapBtn.disabled = true;
      }
      return;
    }

    if (!catalog) {
      if (emptyEl) {
        emptyEl.hidden = false;
        emptyEl.textContent = "Fetch catalog data from SEO Engine first.";
      }
      if (tableWrap) {
        tableWrap.hidden = true;
      }
      if (mapBtn) {
        mapBtn.disabled = true;
      }
      return;
    }

    if (emptyEl) {
      emptyEl.hidden = true;
    }
    if (tableWrap) {
      tableWrap.hidden = false;
    }

    try {
      await EditProImageRoomMap.loadMappings();
      summary = EditProImageRoomMap.getSummary(getStoreData());
      renderCoverage();
      renderTableNow();
      await resumePollingIfNeeded();
    } catch (error) {
      EditProUtils.showMessage(messageEl, error.message, "error");
    }
  }

  async function startScan() {
    if (jobActive) {
      return;
    }
    const status = await refreshOpenAiStatus();
    if (!status?.configured) {
      EditProUtils.showMessage(messageEl, "Configure an OpenAI API key before mapping images.", "warning");
      return;
    }
    EditProUtils.hideMessage(messageEl);
    try {
      await saveOpenAiSettings();
      const result = await EditProImageRoomMap.startBackgroundScan();
      jobActive = EditProImageRoomMap.isJobActive(result);
      onScanStatusUpdate(result);
      EditProImageRoomMap.startPolling(onScanStatusUpdate);
    } catch (error) {
      EditProUtils.showMessage(messageEl, error.message, "error");
    }
  }

  async function stopScan() {
    try {
      const result = await EditProImageRoomMap.stopBackgroundScan();
      onScanStatusUpdate(result);
      await EditProImageRoomMap.loadMappings();
      syncSummaryFromMappings();
    } catch (error) {
      EditProUtils.showMessage(messageEl, error.message, "error");
    }
  }

  async function handleMapClick() {
    if (jobActive) {
      await stopScan();
    } else {
      await startScan();
    }
  }

  function resetPageAndRender() {
    currentPage = 1;
    renderTableNow();
  }

  function setMapFilter(nextFilter) {
    mapFilter = nextFilter;
    filterBar?.querySelectorAll("[data-map-filter]").forEach((chip) => {
      chip.classList.toggle("active", chip.dataset.mapFilter === nextFilter);
    });
    resetPageAndRender();
  }

  filterBar?.addEventListener("click", (e) => {
    const chip = e.target.closest("[data-map-filter]");
    if (!chip) {
      return;
    }
    setMapFilter(chip.dataset.mapFilter || "all");
  });

  prevBtn?.addEventListener("click", () => {
    if (currentPage > 1) {
      currentPage -= 1;
      renderTableNow();
    }
  });

  nextBtn?.addEventListener("click", () => {
    const { totalPages } = getVisiblePage();
    if (currentPage < totalPages) {
      currentPage += 1;
      renderTableNow();
    }
  });

  saveOpenAiBtn?.addEventListener("click", saveOpenAiSettings);
  mapBtn?.addEventListener("click", handleMapClick);
  searchInput?.addEventListener("input", resetPageAndRender);
  sortSelect?.addEventListener("change", resetPageAndRender);

  document.addEventListener("editpro:catalog-updated", refresh);
  document.addEventListener("editpro:settings-loaded", refresh);
  document.addEventListener("editpro:module-changed", (e) => {
    if (e.detail?.moduleId === "roommap") {
      refresh();
    } else {
      EditProImageRoomMap.stopPolling();
    }
  });
})();


