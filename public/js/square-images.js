(function initSquareImagesModule() {
  const STORAGE_KEY = "editpro-square-catalog-path";

  const catalogPathInput = document.getElementById("squareCatalogPath");
  const catalogMeta = document.getElementById("squareCatalogMeta");
  const usePathBtn = document.getElementById("squareUsePathBtn");
  const runScanBtn = document.getElementById("squareRunScanBtn");
  const downloadLink = document.getElementById("squareDownloadLink");
  const countBadge = document.getElementById("squareCountBadge");
  const lastScannedEl = document.getElementById("squareLastScanned");
  const resultsBody = document.getElementById("squareResultsBody");
  const messageEl = document.getElementById("squareMessage");
  const scanOverlay = document.getElementById("squareScanOverlay");

  let catalogPath = EditProUtils.getDefaultCatalogPath();
  let scanning = false;

  function loadCatalogPath() {
    try {
      let stored = localStorage.getItem(STORAGE_KEY);
      if (EditProUtils.isLegacyCatalogPath(stored)) {
        localStorage.removeItem(STORAGE_KEY);
        stored = null;
      }
      catalogPath = stored || EditProUtils.getDefaultCatalogPath();
    } catch {
      catalogPath = EditProUtils.getDefaultCatalogPath();
    }
    if (catalogPathInput) {
      catalogPathInput.value = catalogPath;
    }
    updateCatalogMeta();
  }

  function saveCatalogPath() {
    try {
      localStorage.setItem(STORAGE_KEY, catalogPath);
    } catch {
      // ignore
    }
  }

  function updateCatalogMeta() {
    if (!catalogMeta) {
      return;
    }
    catalogMeta.textContent = `Using: ${catalogPath}`;
  }

  function formatScannedAt(iso) {
    if (!iso) {
      return "No scan yet.";
    }
    try {
      return `Last scanned: ${new Date(iso).toLocaleString()}`;
    } catch {
      return `Last scanned: ${iso}`;
    }
  }

  function setScanning(active) {
    scanning = active;
    if (scanOverlay) {
      scanOverlay.hidden = !active;
    }
    if (runScanBtn) {
      runScanBtn.disabled = active;
    }
    if (usePathBtn) {
      usePathBtn.disabled = active;
    }
  }

  function updateDownloadLink(available) {
    if (!downloadLink) {
      return;
    }
    if (available) {
      downloadLink.href = EditProUtils.apiUrl("/api/square-images/download");
      downloadLink.hidden = false;
      downloadLink.classList.remove("disabled");
      downloadLink.setAttribute("aria-disabled", "false");
    } else {
      downloadLink.href = "#";
      downloadLink.hidden = true;
      downloadLink.classList.add("disabled");
      downloadLink.setAttribute("aria-disabled", "true");
    }
  }

  function renderResults(data) {
    const products = [...(data?.squareProducts || [])].sort((a, b) =>
      String(a.productId).localeCompare(String(b.productId), undefined, { numeric: true }),
    );

    if (countBadge) {
      countBadge.textContent = `${data?.squareCount ?? products.length} square`;
    }
    if (lastScannedEl) {
      lastScannedEl.textContent = formatScannedAt(data?.scannedAt);
    }
    updateDownloadLink(Boolean(data?.excelAvailable));

    if (!resultsBody) {
      return;
    }

    if (!products.length) {
      resultsBody.innerHTML = `
        <tr class="empty-row">
          <td colspan="3">${data?.scannedAt ? "No square paintings found in the last scan." : "Run a scan to list product folders with square paintings."}</td>
        </tr>`;
      return;
    }

    resultsBody.innerHTML = products
      .map(
        (item, index) => `
        <tr>
          <td>${index + 1}</td>
          <td>${EditProUtils.escapeHtml(item.productId)}</td>
          <td>${item.aspectRatio != null ? EditProUtils.escapeHtml(String(item.aspectRatio)) : "—"}</td>
        </tr>`,
      )
      .join("");
  }

  async function loadResults() {
    try {
      const data = await EditProUtils.apiGet("/api/square-images");
      renderResults(data);
    } catch (error) {
      EditProUtils.showMessage(messageEl, error.message || "Failed to load results.", "error");
    }
  }

  function applyCatalogPath() {
    const value = catalogPathInput?.value?.trim();
    if (!value) {
      EditProUtils.showMessage(messageEl, "Enter a catalog folder path.", "error");
      return;
    }
    catalogPath = value;
    saveCatalogPath();
    updateCatalogMeta();
    EditProUtils.hideMessage(messageEl);
    EditProUtils.showMessage(messageEl, "Catalog path updated.", "success");
  }

  async function runScan() {
    if (scanning) {
      return;
    }
    const pathValue = catalogPathInput?.value?.trim() || catalogPath;
    if (!pathValue) {
      EditProUtils.showMessage(messageEl, "Enter a catalog folder path.", "error");
      return;
    }

    catalogPath = pathValue;
    saveCatalogPath();
    updateCatalogMeta();
    EditProUtils.hideMessage(messageEl);
    setScanning(true);

    try {
      const data = await EditProUtils.apiPost("/api/square-images/scan", {
        catalogPath: pathValue,
      });
      renderResults(data);
      EditProUtils.showMessage(
        messageEl,
        `Scan complete: ${data.squareCount} square of ${data.total} products.`,
        "success",
      );
    } catch (error) {
      EditProUtils.showMessage(messageEl, error.message || "Scan failed.", "error");
    } finally {
      setScanning(false);
    }
  }

  usePathBtn?.addEventListener("click", applyCatalogPath);
  catalogPathInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      applyCatalogPath();
    }
  });
  runScanBtn?.addEventListener("click", runScan);

  downloadLink?.addEventListener("click", (event) => {
    if (downloadLink.classList.contains("disabled") || downloadLink.hidden) {
      event.preventDefault();
    }
  });

  document.addEventListener("editpro:module-changed", (event) => {
    if (event.detail?.moduleId === "square") {
      loadResults();
    }
  });
  document.addEventListener("editpro:settings-loaded", () => {
    if (!localStorage.getItem(STORAGE_KEY)) {
      catalogPath = EditProUtils.getDefaultCatalogPath();
      if (catalogPathInput) {
        catalogPathInput.value = catalogPath;
      }
      updateCatalogMeta();
    }
  });

  loadCatalogPath();
  if (window.EditProShell?.getActiveModule?.() === "square") {
    loadResults();
  }
})();
