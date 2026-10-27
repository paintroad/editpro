(function initPipelineModule() {
  const PAGE_SIZE = 50;
  const STAGE_LABELS = {
    detected: "Detected",
    imported: "Imported",
    oriented: "Oriented",
    enriched: "Enriched",
    catalog: "Catalog generated",
    seo: "SEO fixed",
    live: "Live",
    error: "Error",
  };

  const detectBtn = document.getElementById("pipelineDetectBtn");
  const processBtn = document.getElementById("pipelineProcessBtn");
  const inputPathEl = document.getElementById("pipelineInputPath");
  const framePathEl = document.getElementById("pipelineFramePath");
  const outputPathEl = document.getElementById("pipelineOutputPath");
  const countBadge = document.getElementById("pipelineCountBadge");
  const statsMeta = document.getElementById("pipelineStatsMeta");
  const messageEl = document.getElementById("pipelineMessage");
  const tableBody = document.getElementById("pipelineTableBody");
  const filterEl = document.getElementById("pipelineFilterStatus");
  const paginationEl = document.getElementById("pipelinePagination");
  const prevBtn = document.getElementById("pipelinePrevBtn");
  const nextBtn = document.getElementById("pipelineNextBtn");
  const pageInfoEl = document.getElementById("pipelinePageInfo");
  const overlay = document.getElementById("pipelineOverlay");
  const overlayTitle = document.getElementById("pipelineOverlayTitle");
  const overlayStatus = document.getElementById("pipelineOverlayStatus");
  const selectVisible = document.getElementById("pipelineSelectVisible");
  const selectAllBar = document.getElementById("pipelineSelectAllBar");
  const selectAllText = document.getElementById("pipelineSelectAllText");
  const selectAllBtn = document.getElementById("pipelineSelectAllBtn");

  if (!detectBtn || !tableBody || !filterEl) return;

  let items = [];
  let statusFilters = new Set();
  let selectedNames = new Set();
  let currentPage = 1;
  let pollTimer = null;
  let loaded = false;
  let running = false;

  const filterDropdown = new MultiselectDropdown(filterEl, {
    placeholder: "All",
    options: Object.entries(STAGE_LABELS).map(([value, label]) => ({ value, label })),
    onChange: (values) => {
      statusFilters = values;
      currentPage = 1;
      renderTable();
    },
  });

  function showMessage(text, type) {
    messageEl.textContent = text;
    messageEl.className = `message seo-toast ${type || "info"}`;
    messageEl.classList.remove("hidden");
  }

  function paths() {
    return {
      inputPath: inputPathEl.value.trim(),
      frameTemplatesPath: framePathEl.value.trim(),
      outputPath: outputPathEl.value.trim(),
    };
  }

  function applySettings(settings) {
    if (!settings) return;
    inputPathEl.value = settings.inputPath || "";
    framePathEl.value = settings.frameTemplatesPath || "";
    outputPathEl.value = settings.outputPath || "";
  }

  function canProcess(row) {
    return row.stage !== "live";
  }

  function filteredItems() {
    if (!statusFilters.size) return items;
    return items.filter((item) => statusFilters.has(item.stage));
  }

  function visiblePage() {
    const visible = filteredItems();
    const totalPages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
    if (currentPage > totalPages) currentPage = totalPages;
    const start = (currentPage - 1) * PAGE_SIZE;
    return {
      visible,
      page: visible.slice(start, start + PAGE_SIZE),
      totalPages,
      start,
    };
  }

  function selectedProcessable() {
    return items.filter((row) => selectedNames.has(row.fileName) && canProcess(row));
  }

  function detectedItems() {
    return items.filter((row) => row.stage === "detected");
  }

  function updateProcessButton() {
    const count = selectedProcessable().length;
    processBtn.disabled = running;
    processBtn.textContent = count ? `Process (${count})` : "Process";
  }

  function thumbUrl(row) {
    if (row.productId) {
      return EditProUtils.apiUrl(
        `/api/catalog/products/${encodeURIComponent(row.productId)}/image/0?w=96`
      );
    }
    return EditProUtils.apiUrl(
      `/api/pipeline/preview?file=${encodeURIComponent(row.fileName)}&w=96`
    );
  }

  function flag(on) {
    return on ? "Yes" : "No";
  }

  function statusClass(stage) {
    if (stage === "live" || stage === "seo" || stage === "catalog" || stage === "enriched") {
      return "room-map-status--mapped";
    }
    if (stage === "error") return "room-map-status--error";
    return "room-map-status--unmapped";
  }

  function renderSelectAllBar() {
    if (!selectAllBar || !selectAllText || !selectAllBtn) return;
    const selectable = filteredItems().filter(canProcess);
    const { page } = visiblePage();
    const pageSelectable = page.filter(canProcess);
    const allPageSelected =
      pageSelectable.length > 0 && pageSelectable.every((row) => selectedNames.has(row.fileName));
    if (!allPageSelected || selectable.length <= pageSelectable.length) {
      selectAllBar.hidden = true;
      return;
    }
    selectAllBar.hidden = false;
    selectAllText.textContent = `All ${pageSelectable.length} paintings on this page are selected.`;
    selectAllBtn.textContent = `Select all ${selectable.length} paintings`;
  }

  function updateHeaderCheckbox() {
    if (!selectVisible) return;
    const pageSelectable = visiblePage().page.filter(canProcess);
    if (!pageSelectable.length) {
      selectVisible.checked = false;
      selectVisible.indeterminate = false;
      selectVisible.disabled = true;
      return;
    }
    const selectedOnPage = pageSelectable.filter((row) => selectedNames.has(row.fileName)).length;
    selectVisible.disabled = running;
    selectVisible.checked = selectedOnPage === pageSelectable.length;
    selectVisible.indeterminate = selectedOnPage > 0 && selectedOnPage < pageSelectable.length;
  }

  function renderTable() {
    const { visible, page, totalPages } = visiblePage();

    if (paginationEl) {
      paginationEl.hidden = visible.length <= PAGE_SIZE;
      if (pageInfoEl) pageInfoEl.textContent = `${currentPage} / ${totalPages}`;
      if (prevBtn) prevBtn.disabled = currentPage <= 1;
      if (nextBtn) nextBtn.disabled = currentPage >= totalPages;
    }

    if (!items.length) {
      tableBody.innerHTML =
        '<tr class="empty-row"><td colspan="11">No paintings in this folder. Add files, then Detect.</td></tr>';
      renderSelectAllBar();
      updateHeaderCheckbox();
      updateProcessButton();
      return;
    }
    if (!visible.length) {
      tableBody.innerHTML =
        '<tr class="empty-row"><td colspan="11">No paintings match this filter.</td></tr>';
      renderSelectAllBar();
      updateHeaderCheckbox();
      updateProcessButton();
      return;
    }

    tableBody.innerHTML = page
      .map((row) => {
        const title = row.title || "—";
        const shopifyLabel =
          row.shopify === "live" ? "Live" : row.shopify === "error" ? "Error" : "Pending";
        const processable = canProcess(row);
        const checked = processable && selectedNames.has(row.fileName);
        const rowClass = checked ? "catalog-row catalog-row--selected" : "catalog-row";
        return `<tr class="${rowClass}">
          <td class="col-check">
            <label class="catalog-item-check">
              <input type="checkbox" class="pipeline-row-check" data-file="${EditProUtils.escapeHtml(row.fileName)}" ${checked ? "checked" : ""} ${processable && !running ? "" : "disabled"} aria-label="Select ${EditProUtils.escapeHtml(row.fileName)}" />
            </label>
          </td>
          <td class="catalog-col-thumb"><img class="room-map-thumb" src="${EditProUtils.escapeHtml(thumbUrl(row))}" alt="" loading="lazy" /></td>
          <td>${EditProUtils.escapeHtml(row.fileName)}</td>
          <td>${EditProUtils.escapeHtml(row.productId || "—")}</td>
          <td>${EditProUtils.escapeHtml(title)}</td>
          <td>${EditProUtils.escapeHtml(row.orientation || "—")}</td>
          <td>${flag(row.enriched)}</td>
          <td>${row.catalogGenerated ? EditProUtils.escapeHtml(String(row.catalogCount)) : "No"}</td>
          <td>${row.seoFixed ? "Fixed" : "Pending"}</td>
          <td>${shopifyLabel}</td>
          <td><span class="room-map-status ${statusClass(row.stage)}">${EditProUtils.escapeHtml(STAGE_LABELS[row.stage] || row.stage)}</span>${row.error ? `<div class="meta">${EditProUtils.escapeHtml(row.error)}</div>` : ""}</td>
        </tr>`;
      })
      .join("");

    tableBody.querySelectorAll(".pipeline-row-check").forEach((input) => {
      input.addEventListener("change", () => {
        if (input.checked) selectedNames.add(input.dataset.file);
        else selectedNames.delete(input.dataset.file);
        renderTable();
      });
    });
    renderSelectAllBar();
    updateHeaderCheckbox();
    updateProcessButton();
  }

  function renderSummary(data) {
    if (data.job) running = data.job.state === "running";
    items = data.items || [];
    const names = new Set(items.map((row) => row.fileName));
    selectedNames = new Set([...selectedNames].filter((name) => names.has(name) && canProcess(items.find((row) => row.fileName === name))));
    applySettings(data.settings);
    const counts = data.counts || {};
    const noun = counts.total === 1 ? "painting" : "paintings";
    if (countBadge) countBadge.textContent = `${counts.total || 0} ${noun}`;
    if (statsMeta) {
      const next = data.nextProductId ? `Next number ${data.nextProductId}.` : "";
      statsMeta.textContent = `${counts.detected || 0} detected, ${counts.live || 0} live. ${next}`.trim();
    }
    renderTable();
    if (data.job) applyJob(data.job);
  }

  function applyJob(status) {
    running = status?.state === "running";
    detectBtn.disabled = running;
    updateProcessButton();
    if (overlay) overlay.hidden = !running;
    if (running) {
      if (overlayTitle) overlayTitle.textContent = status.step || "Processing";
      if (overlayStatus) overlayStatus.textContent = status.message || "Working…";
      return;
    }
    if (status?.state === "error" && status.error) showMessage(status.error, "error");
    if (status?.state === "done" && status.message) showMessage(status.message, "success");
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(async () => {
      try {
        const status = await EditProUtils.apiGet("/api/pipeline/status");
        applyJob(status);
        if (status.state !== "running") {
          stopPolling();
          await refresh();
        }
      } catch (error) {
        stopPolling();
        showMessage(error.message, "error");
      }
    }, 1500);
  }

  async function refresh() {
    const data = await EditProUtils.apiGet("/api/pipeline");
    renderSummary(data);
    if (data.job?.state === "running") startPolling();
    return data;
  }

  detectBtn.addEventListener("click", async () => {
    detectBtn.disabled = true;
    try {
      const data = await EditProUtils.apiPost("/api/pipeline/detect", paths());
      currentPage = 1;
      renderSummary(data);
      const detected = data.counts?.detected || 0;
      showMessage(
        detected
          ? `${detected} new file${detected === 1 ? "" : "s"} ready to process.`
          : "No new files. Paintings already in the folder are listed with their status.",
        "success"
      );
    } catch (error) {
      showMessage(error.message, "error");
    } finally {
      if (!pollTimer) detectBtn.disabled = false;
    }
  });

  processBtn.addEventListener("click", async () => {
    processBtn.disabled = true;
    detectBtn.disabled = true;
    try {
      const selected = selectedProcessable();
      const targets = selected.length ? selected : detectedItems();
      const fileNames = targets.map((row) => row.fileName);
      if (!fileNames.length) {
        showMessage("No new paintings to process.", "info");
        detectBtn.disabled = false;
        updateProcessButton();
        return;
      }
      const status = await EditProUtils.apiPost("/api/pipeline/process", { ...paths(), fileNames });
      applyJob(status);
      showMessage(
        selected.length
          ? `Processing ${fileNames.length} selected painting${fileNames.length === 1 ? "" : "s"}.`
          : `Processing ${fileNames.length} new painting${fileNames.length === 1 ? "" : "s"}.`,
        "info"
      );
      startPolling();
    } catch (error) {
      showMessage(error.message, "error");
      detectBtn.disabled = false;
      updateProcessButton();
    }
  });

  selectVisible?.addEventListener("change", () => {
    const pageSelectable = visiblePage().page.filter(canProcess);
    for (const row of pageSelectable) {
      if (selectVisible.checked) selectedNames.add(row.fileName);
      else selectedNames.delete(row.fileName);
    }
    renderTable();
  });

  selectAllBtn?.addEventListener("click", () => {
    for (const row of filteredItems().filter(canProcess)) {
      selectedNames.add(row.fileName);
    }
    renderTable();
  });

  prevBtn?.addEventListener("click", () => {
    currentPage = Math.max(1, currentPage - 1);
    renderTable();
  });
  nextBtn?.addEventListener("click", () => {
    currentPage += 1;
    renderTable();
  });

  document.addEventListener("editpro:module-changed", (event) => {
    if (event.detail?.moduleId !== "pipeline" || loaded) return;
    loaded = true;
    refresh().catch((error) => showMessage(error.message, "error"));
  });

  if (window.EditProShell?.getActiveModule?.() === "pipeline") {
    loaded = true;
    refresh().catch((error) => showMessage(error.message, "error"));
  }
})();
