(function initRoomMapModule() {
  const coverageEl = document.getElementById("roomMapCoverage");
  const statusBadge = document.getElementById("roomMapStatusBadge");
  const ollamaHostInput = document.getElementById("roomMapOllamaHost");
  const ollamaModelInput = document.getElementById("roomMapOllamaModel");
  const saveOllamaBtn = document.getElementById("roomMapSaveOllamaBtn");
  const mapBtn = document.getElementById("roomMapScanBtn");
  const searchInput = document.getElementById("roomMapSearch");
  const unmappedOnlyToggle = document.getElementById("roomMapUnmappedOnly");
  const sortSelect = document.getElementById("roomMapSort");
  const tableBody = document.getElementById("roomMapTableBody");
  const messageEl = document.getElementById("roomMapMessage");
  const emptyEl = document.getElementById("roomMapEmpty");
  const tableWrap = document.getElementById("roomMapTableWrap");
  const scanOverlay = document.getElementById("roomMapScanOverlay");
  const scanProgressEl = document.getElementById("roomMapScanProgress");
  const ollamaStatusBadge = document.getElementById("roomMapOllamaStatusBadge");
  const ollamaStatusText = document.getElementById("roomMapOllamaStatusText");
  const ollamaRefreshBtn = document.getElementById("roomMapOllamaRefreshBtn");
  const ollamaStartBtn = document.getElementById("roomMapOllamaStartBtn");
  const ollamaStopBtn = document.getElementById("roomMapOllamaStopBtn");

  let scanning = false;
  let summary = null;
  let ollamaStatus = null;
  let ollamaPollTimer = null;

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

  function getOllamaHost() {
    return ollamaHostInput?.value.trim() || window.EditProSettings?.roomDetection?.ollamaHost || "http://localhost:11434";
  }

  function renderOllamaStatus(status) {
    ollamaStatus = status;
    if (!ollamaStatusBadge || !ollamaStatusText) {
      return;
    }

    if (!status) {
      ollamaStatusBadge.textContent = "Checking…";
      ollamaStatusBadge.className = "room-map-ollama-pill room-map-ollama-pill--checking";
      ollamaStatusText.textContent = "Checking Ollama status…";
      return;
    }

    if (!status.installed) {
      ollamaStatusBadge.textContent = "Not installed";
      ollamaStatusBadge.className = "room-map-ollama-pill room-map-ollama-pill--missing";
      ollamaStatusText.textContent =
        "Ollama was not found on this machine. Install from ollama.com/download, then click Start Ollama.";
    } else if (status.running) {
      ollamaStatusBadge.textContent = "Running";
      ollamaStatusBadge.className = "room-map-ollama-pill room-map-ollama-pill--running";
      const modelHint = status.models?.length
        ? `Models: ${status.models.slice(0, 4).join(", ")}${status.models.length > 4 ? "…" : ""}`
        : "No models pulled yet — run ollama pull gemma3:4b";
      ollamaStatusText.textContent = `Connected to ${status.host}. ${modelHint}`;
    } else {
      ollamaStatusBadge.textContent = "Stopped";
      ollamaStatusBadge.className = "room-map-ollama-pill room-map-ollama-pill--stopped";
      ollamaStatusText.textContent = status.error
        ? `Not reachable at ${status.host}. ${status.error}`
        : `Not running at ${status.host}. Click Start Ollama to launch it.`;
    }

    if (ollamaStartBtn) {
      ollamaStartBtn.disabled = scanning || !status.installed || status.running;
    }
    if (ollamaStopBtn) {
      ollamaStopBtn.disabled = scanning || !status.running;
    }
    if (mapBtn && summary) {
      mapBtn.disabled = scanning || !hasCatalog() || summary.unmapped === 0 || !status.running;
    }
  }

  async function refreshOllamaStatus() {
    try {
      const host = encodeURIComponent(getOllamaHost());
      const status = await EditProUtils.apiGet(`/api/ollama/status?host=${host}`);
      renderOllamaStatus(status);
      return status;
    } catch (error) {
      renderOllamaStatus({
        running: false,
        installed: false,
        host: getOllamaHost(),
        error: error.message,
      });
      return null;
    }
  }

  async function startOllamaService() {
    EditProUtils.hideMessage(messageEl);
    if (ollamaStartBtn) {
      ollamaStartBtn.disabled = true;
      ollamaStartBtn.textContent = "Starting…";
    }
    try {
      const result = await EditProUtils.apiPost("/api/ollama/start", { host: getOllamaHost() });
      renderOllamaStatus(result);
      EditProUtils.showMessage(messageEl, result.message || "Ollama started.", "success");
    } catch (error) {
      EditProUtils.showMessage(messageEl, error.message, "error");
      await refreshOllamaStatus();
    } finally {
      if (ollamaStartBtn) {
        ollamaStartBtn.textContent = "Start Ollama";
      }
    }
  }

  async function stopOllamaService() {
    EditProUtils.hideMessage(messageEl);
    if (ollamaStopBtn) {
      ollamaStopBtn.disabled = true;
      ollamaStopBtn.textContent = "Stopping…";
    }
    try {
      const result = await EditProUtils.apiPost("/api/ollama/stop", { host: getOllamaHost() });
      renderOllamaStatus({ ...ollamaStatus, running: false, installed: ollamaStatus?.installed });
      EditProUtils.showMessage(messageEl, result.message || "Ollama stopped.", "success");
      await refreshOllamaStatus();
    } catch (error) {
      EditProUtils.showMessage(messageEl, error.message, "error");
      await refreshOllamaStatus();
    } finally {
      if (ollamaStopBtn) {
        ollamaStopBtn.textContent = "Stop Ollama";
      }
    }
  }

  function startOllamaPolling() {
    stopOllamaPolling();
    ollamaPollTimer = setInterval(() => {
      if (window.EditProShell?.getActiveModule?.() === "roommap" && !scanning) {
        refreshOllamaStatus();
      }
    }, 10000);
  }

  function stopOllamaPolling() {
    if (ollamaPollTimer) {
      clearInterval(ollamaPollTimer);
      ollamaPollTimer = null;
    }
  }

  function applyOllamaFields() {
    const rd = window.EditProSettings?.roomDetection || {};
    if (ollamaHostInput) {
      ollamaHostInput.value = rd.ollamaHost || "http://localhost:11434";
    }
    if (ollamaModelInput) {
      ollamaModelInput.value = rd.ollamaModel || "gemma3:4b";
    }
  }

  async function saveOllamaSettings() {
    EditProUtils.hideMessage(messageEl);
    saveOllamaBtn.disabled = true;
    saveOllamaBtn.textContent = "Saving…";
    try {
      const data = await EditProUtils.apiPost("/api/settings", {
        shopify: { storeDomain: window.EditProSettings?.storeDomain || "", accessToken: "" },
        rules: window.EditProSettings?.rules,
        descriptionPhrases: window.EditProSettings?.descriptionPhrases,
        roomDetection: {
          ollamaHost: ollamaHostInput?.value.trim() || "http://localhost:11434",
          ollamaModel: ollamaModelInput?.value.trim() || "gemma3:4b",
        },
      });
      window.EditProSettings = window.EditProSettings || {};
      window.EditProSettings.roomDetection = data.roomDetection;
      EditProUtils.showMessage(messageEl, "Ollama settings saved.", "success");
    } catch (error) {
      EditProUtils.showMessage(messageEl, error.message, "error");
    } finally {
      saveOllamaBtn.disabled = false;
      saveOllamaBtn.textContent = "Save Ollama settings";
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
    if (unmappedOnlyToggle?.checked) {
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

  function renderTable() {
    if (!tableBody) {
      return;
    }
    const rows = getFilteredRows();
    if (!rows.length) {
      tableBody.innerHTML =
        '<tr class="empty-row"><td colspan="5">No images match your filters.</td></tr>';
      return;
    }
    tableBody.innerHTML = rows
      .map((row) => {
        const roomLabel = row.mapped
          ? EditProImageRoomMap.roomToTitleCase(row.room)
          : "—";
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
      })
      .join("");
  }

  function renderCoverage() {
    if (!summary) {
      return;
    }
    if (coverageEl) {
      coverageEl.textContent = `${summary.mapped} / ${summary.total} images mapped`;
    }
    if (statusBadge) {
      statusBadge.textContent = summary.complete ? "Complete" : "Incomplete";
      statusBadge.className = `badge room-map-status-badge ${
        summary.complete ? "room-map-status-badge--complete" : "room-map-status-badge--incomplete"
      }`;
    }
    if (mapBtn) {
      const ollamaOk = ollamaStatus?.running;
      mapBtn.disabled = scanning || !hasCatalog() || summary.unmapped === 0 || !ollamaOk;
      mapBtn.textContent =
        summary.unmapped > 0
          ? `Map unmapped images (${summary.unmapped})`
          : "All images mapped";
    }
  }

  async function refresh() {
    applyOllamaFields();
    await refreshOllamaStatus();
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
      renderTable();
    } catch (error) {
      EditProUtils.showMessage(messageEl, error.message, "error");
    }
  }

  function setScanning(active, text) {
    scanning = active;
    if (scanOverlay) {
      scanOverlay.hidden = !active;
    }
    if (scanProgressEl && text) {
      scanProgressEl.textContent = text;
    }
    if (mapBtn) {
      mapBtn.disabled = active || !summary || summary.unmapped === 0;
    }
  }

  async function runScan() {
    if (scanning || !hasCatalog()) {
      return;
    }
    const status = await refreshOllamaStatus();
    if (!status?.running) {
      EditProUtils.showMessage(messageEl, "Start Ollama before mapping images.", "warning");
      return;
    }
    EditProUtils.hideMessage(messageEl);
    setScanning(true, "Starting room detection…");
    try {
      await saveOllamaSettings();
      const result = await EditProImageRoomMap.scanUnmapped(getStoreData(), (progress) => {
        if (scanProgressEl) {
          scanProgressEl.textContent = `Mapping room ${progress.current} of ${progress.total}…`;
        }
      });
      EditProUtils.showMessage(
        messageEl,
        `Mapped ${result.mapped} image${result.mapped === 1 ? "" : "s"}. ${result.skipped} already mapped.`,
        "success"
      );
      await refresh();
    } catch (error) {
      EditProUtils.showMessage(messageEl, error.message, "error");
    } finally {
      setScanning(false);
    }
  }

  saveOllamaBtn?.addEventListener("click", saveOllamaSettings);
  ollamaRefreshBtn?.addEventListener("click", refreshOllamaStatus);
  ollamaStartBtn?.addEventListener("click", startOllamaService);
  ollamaStopBtn?.addEventListener("click", stopOllamaService);
  mapBtn?.addEventListener("click", runScan);
  searchInput?.addEventListener("input", renderTable);
  unmappedOnlyToggle?.addEventListener("change", renderTable);
  sortSelect?.addEventListener("change", renderTable);

  document.addEventListener("editpro:catalog-updated", refresh);
  document.addEventListener("editpro:settings-loaded", refresh);
  document.addEventListener("editpro:module-changed", (e) => {
    if (e.detail?.moduleId === "roommap") {
      refresh();
      startOllamaPolling();
    } else {
      stopOllamaPolling();
    }
  });

  startOllamaPolling();
  refresh();
})();
