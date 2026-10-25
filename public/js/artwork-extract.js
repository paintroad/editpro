(function initArtworkExtract() {
  const STATE_LABELS = {
    idle: "Idle",
    running: "Running",
    stopping: "Stopping",
    stopped: "Stopped",
    done: "Done",
    error: "Error",
  };
  const STAGE_LABELS = {
    raw: "Raw",
    skipped: "Skipped",
    extracted: "Extracted (needs crop)",
    oriented: "Oriented",
    cropped: "Cropped",
    upscaled: "Upscaled",
    missing: "Missing",
  };
  const STAGE_CLASSES = {
    raw: "room-map-status--unmapped",
    skipped: "room-map-status--error",
    extracted: "room-map-status--unmapped",
    oriented: "room-map-status--mapped",
    cropped: "room-map-status--mapped",
    upscaled: "room-map-status--mapped",
    missing: "room-map-status--error",
  };
  const DEVIATION_BUCKETS = [
    { value: "within", label: "Right ratio (4:3, 3:4 or square)", test: (row) => row.rightRatio },
    { value: "10-20", label: "10–20% off", test: (row) => !row.rightRatio && Math.abs(row.deviation) <= 20 },
    { value: "20-35", label: "20–35% off", test: (row) => Math.abs(row.deviation) > 20 && Math.abs(row.deviation) <= 35 },
    { value: "35+", label: "Over 35% off", test: (row) => Math.abs(row.deviation) > 35 },
    { value: "squarer", label: "Squarer than 4:3", test: (row) => !row.rightRatio && row.deviation < 0 },
    { value: "longer", label: "Longer than 4:3", test: (row) => !row.rightRatio && row.deviation > 0 },
  ];
  const FILTER_IDS = {
    stage: "artworkFilterStage",
    brand: "artworkFilterBrand",
    category: "artworkFilterCategory",
    orientation: "artworkFilterOrientation",
    ratio: "artworkFilterRatio",
    right: "artworkFilterRight",
    deviation: "artworkFilterDeviation",
  };

  const state = {
    status: null,
    list: null,
    search: "",
    timer: null,
    lastListAt: 0,
    loaded: false,
  };
  const els = {};
  const dropdowns = {};

  function $(id) {
    return document.getElementById(id);
  }

  function esc(value) {
    return EditProUtils.escapeHtml(value == null ? "" : String(value));
  }

  function cacheEls() {
    els.countBadge = $("artworkCountBadge");
    els.badge = $("artworkStateBadge");
    els.meta = $("artworkStatusMeta");
    els.refresh = $("artworkRefreshBtn");
    els.start = $("artworkStartBtn");
    els.stop = $("artworkStopBtn");
    els.message = $("artworkMessage");
    els.input = $("artworkInput");
    els.brand = $("artworkBrand");
    els.overwrite = $("artworkOverwrite");
    els.bar = $("artworkProgressBar");
    els.search = $("artworkSearch");
    els.clear = $("artworkClearFilters");
    els.counts = $("artworkCounts");
    els.body = $("artworkTableBody");
  }

  function showMessage(text, type) {
    if (!els.message) return;
    els.message.textContent = text || "";
    els.message.classList.toggle("hidden", !text);
    els.message.classList.toggle("error", type === "error");
    els.message.classList.toggle("success", type === "success");
  }

  function isRunning(status) {
    return status?.state === "running" || status?.state === "stopping";
  }

  // ------------------------------------------------------------ filters ----

  function makeDropdown(key, options) {
    const el = $(FILTER_IDS[key]);
    if (!el) return;
    const previous = dropdowns[key]?.getValues();
    dropdowns[key]?.destroy();
    const values = previous ? [...previous].filter((value) => options.some((option) => option.value === value)) : [];
    dropdowns[key] = new MultiselectDropdown(el, {
      placeholder: "All",
      options,
      values,
      onChange: renderTable,
    });
  }

  function buildFilters() {
    const rows = state.list?.rows || [];
    const unique = (values) =>
      [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const present = new Set(rows.map((row) => row.stage));
    makeDropdown(
      "stage",
      Object.entries(STAGE_LABELS)
        .filter(([value]) => present.has(value) || !["skipped", "missing"].includes(value))
        .map(([value, label]) => ({ value, label }))
    );
    makeDropdown(
      "brand",
      unique(rows.map((row) => row.brand || "(none)")).map((value) => ({ value, label: value }))
    );
    makeDropdown(
      "category",
      unique(rows.flatMap((row) => (row.categories.length ? row.categories : ["(none)"]))).map((value) => ({
        value,
        label: value,
      }))
    );
    makeDropdown("orientation", [
      { value: "landscape", label: "Landscape" },
      { value: "portrait", label: "Portrait" },
      { value: "square", label: "Square" },
    ]);
    makeDropdown(
      "ratio",
      unique(rows.map((row) => row.ratioLabel)).map((value) => ({ value, label: value }))
    );
    makeDropdown("right", [
      { value: "yes", label: "Yes (4:3, 3:4 or square)" },
      { value: "no", label: "No" },
    ]);
    makeDropdown(
      "deviation",
      DEVIATION_BUCKETS.map(({ value, label }) => ({ value, label }))
    );
  }

  function selected(key) {
    return dropdowns[key]?.getValues() || new Set();
  }

  function filteredRows() {
    const query = state.search.trim().toLowerCase();
    const stages = selected("stage");
    const brands = selected("brand");
    const categories = selected("category");
    const orientations = selected("orientation");
    const ratios = selected("ratio");
    const right = selected("right");
    const deviations = DEVIATION_BUCKETS.filter((bucket) => selected("deviation").has(bucket.value));
    return (state.list?.rows || []).filter((row) => {
      if (query && !`${row.name} ${row.file} ${row.sourceFile} ${row.categories.join(" ")}`.toLowerCase().includes(query)) {
        return false;
      }
      if (stages.size && !stages.has(row.stage)) return false;
      if (brands.size && !brands.has(row.brand || "(none)")) return false;
      if (categories.size && !(row.categories.length ? row.categories : ["(none)"]).some((c) => categories.has(c))) {
        return false;
      }
      if (orientations.size && !orientations.has(row.orientation)) return false;
      if (ratios.size && !ratios.has(row.ratioLabel)) return false;
      if (right.size && !right.has(row.rightRatio ? "yes" : "no")) return false;
      if (deviations.length && !deviations.some((bucket) => row.width && bucket.test(row))) return false;
      return true;
    });
  }

  // ------------------------------------------------------------- render ----

  function thumbUrl(row) {
    const params = new URLSearchParams({ key: row.key, w: "160", v: String(row.thumbVersion || "") });
    return EditProUtils.apiUrl(`/api/artwork-extract/thumb?${params}`);
  }

  function stageCell(row) {
    const cls = STAGE_CLASSES[row.stage] || "room-map-status--unmapped";
    const note = row.reason ? `<div class="meta">${esc(row.reason)}</div>` : "";
    return `<span class="room-map-status ${cls}">${esc(STAGE_LABELS[row.stage] || row.stage)}</span>${note}`;
  }

  function sizeCell(row) {
    if (!row.width) return "—";
    const lines = [];
    if (row.upscaledWidth) lines.push(`<div class="meta">upscaled ${row.upscaledWidth}×${row.upscaledHeight}</div>`);
    if (row.sourceWidth) lines.push(`<div class="meta">from ${row.sourceWidth}×${row.sourceHeight}</div>`);
    return `${row.width}×${row.height}${lines.join("")}`;
  }

  function deviationCell(row) {
    if (!row.width || row.rightRatio || row.deviation == null) return "—";
    const sign = row.deviation > 0 ? "+" : "−";
    const hint = row.deviation > 0 ? "longer" : "squarer";
    return `${sign}${Math.abs(row.deviation).toFixed(1)}% <span class="meta">(${hint})</span>`;
  }

  function capitalize(value) {
    return value ? value.charAt(0).toUpperCase() + value.slice(1) : "—";
  }

  function stageSummary(rows) {
    const counts = {};
    for (const row of rows) counts[row.stage] = (counts[row.stage] || 0) + 1;
    return Object.keys(STAGE_LABELS)
      .filter((stage) => counts[stage])
      .map((stage) => `${counts[stage]} ${STAGE_LABELS[stage].replace(/ \(.*\)/, "").toLowerCase()}`)
      .join(" · ");
  }

  function renderTable() {
    if (!els.body) return;
    const all = state.list?.rows || [];
    const rows = filteredRows();
    if (els.countBadge) els.countBadge.textContent = `${all.length} images`;
    if (els.counts) {
      els.counts.textContent = all.length ? `Showing ${rows.length} of ${all.length} · ${stageSummary(all)}` : "";
    }
    if (!all.length) {
      els.body.innerHTML = `<tr class="empty-row"><td colspan="11">${
        state.list ? "No images yet. Add images to Raw/<Brand>/<Category…>." : "Enter the catalog folder and click Refresh."
      }</td></tr>`;
      return;
    }
    if (!rows.length) {
      els.body.innerHTML = '<tr class="empty-row"><td colspan="11">No images match these filters.</td></tr>';
      return;
    }
    els.body.innerHTML = rows
      .map((row) => {
        const unprocessed = row.stage === "raw" || row.stage === "skipped";
        const thumb = row.hasThumb
          ? `<img class="room-map-thumb artwork-thumb${unprocessed ? " artwork-thumb--source" : ""}" src="${esc(
              thumbUrl(row)
            )}" alt="" loading="lazy" />`
          : "—";
        return `<tr>
          <td class="catalog-col-thumb">${thumb}</td>
          <td class="artwork-name">${row.name ? esc(row.name) : "—"}</td>
          <td>${stageCell(row)}</td>
          <td>${esc(row.brand || "—")}</td>
          <td>${row.categories.length ? esc(row.categories.join(" › ")) : "—"}</td>
          <td class="artwork-file" title="${esc(row.sourceFile)}">${esc(row.sourceFile || "—")}</td>
          <td>${sizeCell(row)}</td>
          <td>${esc(capitalize(row.orientation))}</td>
          <td>${row.width ? `${esc(row.ratioLabel)} <span class="meta">(${row.ratio})</span>` : "—"}</td>
          <td>${row.width ? (row.rightRatio ? "Yes" : "No") : "—"}</td>
          <td>${deviationCell(row)}</td>
        </tr>`;
      })
      .join("");
  }

  function renderStatus() {
    const status = state.status || {};
    const running = isRunning(status);
    if (els.badge) els.badge.textContent = STATE_LABELS[status.state] || "Idle";
    if (els.start) els.start.disabled = running;
    if (els.stop) els.stop.disabled = !running;
    const pct = status.total ? Math.min(100, Math.round((status.processed / status.total) * 100)) : 0;
    if (els.bar) els.bar.style.width = `${running || status.state === "done" ? pct : 0}%`;
    if (els.meta && (running || status.state === "done")) {
      const counts = status.counts || {};
      els.meta.textContent = `${status.processed || 0} of ${status.total || 0} raw files · ${counts.done || 0} extracted · ${
        counts.skipped || 0
      } skipped.`;
    }
  }

  // ---------------------------------------------------------------- api ----

  async function loadList({ quiet } = {}) {
    const input = els.input?.value.trim() || "";
    if (!input) {
      if (!quiet) showMessage("Enter the catalog folder path.", "error");
      return;
    }
    try {
      const data = await EditProUtils.apiGet(`/api/artwork-extract/list?input=${encodeURIComponent(input)}`);
      state.list = data;
      state.lastListAt = Date.now();
      buildFilters();
      renderTable();
      renderStatus();
      if (!quiet) showMessage("");
    } catch (error) {
      if (!quiet) showMessage(error.message || String(error), "error");
    }
  }

  async function poll() {
    try {
      const data = await EditProUtils.apiGet("/api/artwork-extract");
      const wasRunning = isRunning(state.status);
      state.status = data;
      renderStatus();
      if (data.state === "error" && data.error) showMessage(data.error, "error");
      if (wasRunning && !isRunning(data)) {
        if (data.state === "done") {
          const counts = data.counts || {};
          showMessage(
            `Finished. ${counts.done || 0} extracted, ${counts.skipped || 0} skipped, ${
              counts.oriented_existing || 0
            } moved from Extracted to Oriented.`,
            "success"
          );
        }
        loadList({ quiet: true });
      } else if (isRunning(data) && Date.now() - state.lastListAt > 6000) {
        loadList({ quiet: true });
      }
      schedule(isRunning(data));
      return data;
    } catch (error) {
      showMessage(error.message || String(error), "error");
      schedule(false);
      return null;
    }
  }

  function schedule(running) {
    clearTimeout(state.timer);
    state.timer = running ? setTimeout(poll, 1500) : null;
  }

  async function start() {
    const input = els.input?.value.trim() || "";
    if (!input) {
      showMessage("Enter the catalog folder path.", "error");
      return;
    }
    showMessage("");
    try {
      state.status = await EditProUtils.apiPost("/api/artwork-extract/start", {
        input,
        brand: els.brand?.value || "auto",
        overwrite: Boolean(els.overwrite?.checked),
      });
      renderStatus();
      schedule(true);
    } catch (error) {
      showMessage(error.message || String(error), "error");
    }
  }

  async function stop() {
    try {
      state.status = await EditProUtils.apiPost("/api/artwork-extract/stop", {});
      renderStatus();
      schedule(true);
    } catch (error) {
      showMessage(error.message || String(error), "error");
    }
  }

  async function openModule() {
    const data = await poll();
    if (!state.loaded && data) {
      state.loaded = true;
      const settings = data.settings || {};
      if (els.input && !els.input.value.trim() && settings.input) els.input.value = settings.input;
      if (els.brand && settings.brand) els.brand.value = settings.brand;
    }
    loadList({ quiet: !state.list });
  }

  function bind() {
    cacheEls();
    buildFilters();
    els.start?.addEventListener("click", start);
    els.stop?.addEventListener("click", stop);
    els.refresh?.addEventListener("click", () => loadList());
    els.input?.addEventListener("change", () => {
      state.list = null;
      loadList();
    });
    els.search?.addEventListener("input", () => {
      state.search = els.search.value || "";
      renderTable();
    });
    els.clear?.addEventListener("click", () => {
      state.search = "";
      if (els.search) els.search.value = "";
      Object.values(dropdowns).forEach((dropdown) => dropdown.setValues([]));
      renderTable();
    });
    document.addEventListener("editpro:module-changed", (event) => {
      if (event.detail?.moduleId === "artwork") openModule();
    });
    if (window.EditProShell?.getActiveModule?.() === "artwork") openModule();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bind);
  } else {
    bind();
  }
})();
