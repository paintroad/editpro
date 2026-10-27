(function initArtworkPipeline() {
  const STATE_LABELS = {
    idle: "Idle",
    running: "Registering",
    done: "Done",
    error: "Error",
  };
  const STAGE_LABELS = {
    new: "New in Raw",
    raw: "Waiting for AI",
    review: "In review",
    feedback: "Feedback given",
    oriented: "Final",
    upscaled: "Upscaled",
    rejected: "Rejected",
    missing: "Missing",
  };
  const STAGE_CLASSES = {
    new: "room-map-status--unmapped",
    raw: "room-map-status--unmapped",
    review: "room-map-status--unmapped",
    feedback: "room-map-status--error",
    oriented: "room-map-status--mapped",
    upscaled: "room-map-status--mapped",
    rejected: "room-map-status--error",
    missing: "room-map-status--error",
  };
  const REVIEW_STAGES = new Set(["review", "feedback"]);
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

  const state = { status: null, list: null, search: "", timer: null, loaded: false };
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
    els.approveShown = $("artworkApproveShownBtn");
    els.message = $("artworkMessage");
    els.input = $("artworkInput");
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
    return status?.state === "running";
  }

  // ------------------------------------------------------------ filters ----

  function makeDropdown(key, options) {
    const el = $(FILTER_IDS[key]);
    if (!el) return;
    const previous = dropdowns[key]?.getValues();
    dropdowns[key]?.destroy();
    const values = previous ? [...previous].filter((value) => options.some((option) => option.value === value)) : [];
    dropdowns[key] = new MultiselectDropdown(el, { placeholder: "All", options, values, onChange: renderTable });
  }

  function buildFilters() {
    const rows = state.list?.rows || [];
    const unique = (values) =>
      [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const present = new Set(rows.map((row) => row.stage));
    makeDropdown(
      "stage",
      Object.entries(STAGE_LABELS)
        .filter(([value]) => present.has(value) || !["rejected", "missing"].includes(value))
        .map(([value, label]) => ({ value, label }))
    );
    makeDropdown("brand", unique(rows.map((row) => row.brand || "(none)")).map((value) => ({ value, label: value })));
    makeDropdown(
      "category",
      unique(rows.flatMap((row) => (row.categories.length ? row.categories : ["(none)"]))).map((value) => ({ value, label: value }))
    );
    makeDropdown("orientation", [
      { value: "landscape", label: "Landscape" },
      { value: "portrait", label: "Portrait" },
      { value: "square", label: "Square" },
    ]);
    makeDropdown("ratio", unique(rows.map((row) => row.ratioLabel)).map((value) => ({ value, label: value })));
    makeDropdown("right", [
      { value: "yes", label: "Yes (4:3, 3:4 or square)" },
      { value: "no", label: "No" },
    ]);
    makeDropdown("deviation", DEVIATION_BUCKETS.map(({ value, label }) => ({ value, label })));
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
      if (query && !`${row.name} ${row.sourceFile} ${row.categories.join(" ")} ${row.note}`.toLowerCase().includes(query)) return false;
      if (stages.size && !stages.has(row.stage)) return false;
      if (brands.size && !brands.has(row.brand || "(none)")) return false;
      if (categories.size && !(row.categories.length ? row.categories : ["(none)"]).some((c) => categories.has(c))) return false;
      if (orientations.size && !orientations.has(row.orientation)) return false;
      if (ratios.size && !ratios.has(row.ratioLabel)) return false;
      if (right.size && !right.has(row.rightRatio ? "yes" : "no")) return false;
      if (deviations.length && !deviations.some((bucket) => row.width && bucket.test(row))) return false;
      return true;
    });
  }

  // ------------------------------------------------------------- render ----

  function apiUrl(route, key, extra = {}) {
    return EditProUtils.apiUrl(`/api/artwork/${route}?${new URLSearchParams({ key, ...extra })}`);
  }

  function thumb(key, version, href) {
    if (!key) return "—";
    const img = `<img class="room-map-thumb artwork-thumb" src="${esc(apiUrl("thumb", key, { w: "160", v: String(version || "") }))}" alt="" loading="lazy" />`;
    return `<a href="${esc(apiUrl("file", href || key))}" target="_blank" rel="noopener" title="Open full size">${img}</a>`;
  }

  function stageCell(row) {
    const cls = STAGE_CLASSES[row.stage] || "room-map-status--unmapped";
    const note = row.note && row.stage !== "feedback" ? `<div class="meta">${esc(row.note)}</div>` : "";
    return `<span class="room-map-status ${cls}">${esc(STAGE_LABELS[row.stage] || row.stage)}</span>${note}`;
  }

  function reviewCell(row) {
    if (!REVIEW_STAGES.has(row.stage)) return "—";
    const name = esc(row.name);
    const previous = row.lastFeedback ? `<div class="meta">Earlier feedback: ${esc(row.lastFeedback)}</div>` : "";
    return `<div class="artwork-review" data-review-for="${name}">
        <div class="artwork-review-actions">
          <button type="button" class="btn btn-primary btn-sm" data-action="approve">Approve</button>
          <button type="button" class="btn btn-secondary btn-sm" data-action="reject">Reject</button>
        </div>
        <textarea class="artwork-review-note" rows="2" placeholder="Feedback for a redo…">${esc(row.stage === "feedback" ? row.note : "")}</textarea>
        <button type="button" class="btn btn-secondary btn-sm" data-action="feedback">${row.stage === "feedback" ? "Update feedback" : "Send feedback"}</button>
        ${previous}
      </div>`;
  }

  function sizeCell(row) {
    if (!row.width) return "—";
    const lines = [];
    if (row.upscaledWidth) lines.push(`<div class="meta">upscaled ${row.upscaledWidth}×${row.upscaledHeight}</div>`);
    if (row.sourceWidth && (row.sourceWidth !== row.width || row.sourceHeight !== row.height)) {
      lines.push(`<div class="meta">original ${row.sourceWidth}×${row.sourceHeight}</div>`);
    }
    return `${row.width}×${row.height}${lines.join("")}`;
  }

  function deviationCell(row) {
    if (!row.width || row.rightRatio || row.deviation == null) return "—";
    const sign = row.deviation > 0 ? "+" : "−";
    return `${sign}${Math.abs(row.deviation).toFixed(1)}% <span class="meta">(${row.deviation > 0 ? "longer" : "squarer"})</span>`;
  }

  function capitalize(value) {
    return value ? value.charAt(0).toUpperCase() + value.slice(1) : "—";
  }

  function stageSummary(rows) {
    const counts = {};
    for (const row of rows) counts[row.stage] = (counts[row.stage] || 0) + 1;
    return Object.keys(STAGE_LABELS)
      .filter((stage) => counts[stage])
      .map((stage) => `${counts[stage]} ${STAGE_LABELS[stage].toLowerCase()}`)
      .join(" · ");
  }

  function renderTable() {
    if (!els.body) return;
    const all = state.list?.rows || [];
    const rows = filteredRows();
    if (els.countBadge) els.countBadge.textContent = `${all.length} images`;
    if (els.counts) {
      const unlinked = state.list?.unlinkedUpscaled ? ` · ${state.list.unlinkedUpscaled} upscaled files not matched to a name` : "";
      els.counts.textContent = all.length ? `Showing ${rows.length} of ${all.length} · ${stageSummary(all)}${unlinked}` : "";
    }
    if (!all.length) {
      els.body.innerHTML = `<tr class="empty-row"><td colspan="13">${
        state.list ? "No images yet. Add images to Raw/<Brand>/<Category…>." : "Enter the catalog folder and click Refresh."
      }</td></tr>`;
      return;
    }
    if (!rows.length) {
      els.body.innerHTML = '<tr class="empty-row"><td colspan="13">No images match these filters.</td></tr>';
      return;
    }
    els.body.innerHTML = rows
      .map(
        (row) => `<tr>
          <td class="catalog-col-thumb">${thumb(row.original, row.originalVersion)}</td>
          <td class="catalog-col-thumb">${thumb(row.key, row.thumbVersion, row.compare || row.key)}</td>
          <td class="artwork-name">${row.name ? esc(row.name) : "—"}</td>
          <td>${stageCell(row)}</td>
          <td>${reviewCell(row)}</td>
          <td>${esc(row.brand || "—")}</td>
          <td>${row.categories.length ? esc(row.categories.join(" › ")) : "—"}</td>
          <td class="artwork-file" title="${esc(row.sourceFile)}">${esc(row.sourceFile || "—")}</td>
          <td>${sizeCell(row)}</td>
          <td>${esc(capitalize(row.orientation))}</td>
          <td>${row.width ? `${esc(row.ratioLabel)} <span class="meta">(${row.ratio})</span>` : "—"}</td>
          <td>${row.width ? (row.rightRatio ? "Yes" : "No") : "—"}</td>
          <td>${deviationCell(row)}</td>
        </tr>`
      )
      .join("");
  }

  function renderStatus() {
    const status = state.status || {};
    const running = isRunning(status);
    if (els.badge) els.badge.textContent = STATE_LABELS[status.state] || "Idle";
    if (els.start) els.start.disabled = running;
    const pct = status.total ? Math.min(100, Math.round((status.processed / status.total) * 100)) : 0;
    if (els.bar) els.bar.style.width = `${running || status.state === "done" ? pct : 0}%`;
    if (els.meta && running) els.meta.textContent = `${status.processed || 0} of ${status.total || 0} new Raw images named.`;
  }

  // ---------------------------------------------------------------- api ----

  async function loadList({ quiet } = {}) {
    const input = els.input?.value.trim() || "";
    if (!input) {
      if (!quiet) showMessage("Enter the catalog folder path.", "error");
      return;
    }
    try {
      state.list = await EditProUtils.apiGet(`/api/artwork/list?input=${encodeURIComponent(input)}`);
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
      const data = await EditProUtils.apiGet("/api/artwork");
      const wasRunning = isRunning(state.status);
      state.status = data;
      renderStatus();
      if (data.state === "error" && data.error) showMessage(data.error, "error");
      if (wasRunning && !isRunning(data)) {
        if (data.state === "done") {
          const count = data.counts?.done || 0;
          showMessage(count ? `${count} new image${count === 1 ? "" : "s"} named and ready for AI.` : "No new images in Raw.", "success");
        }
        loadList({ quiet: true });
      }
      clearTimeout(state.timer);
      state.timer = isRunning(data) ? setTimeout(poll, 1500) : null;
      return data;
    } catch (error) {
      showMessage(error.message || String(error), "error");
      return null;
    }
  }

  async function register() {
    const input = els.input?.value.trim() || "";
    if (!input) {
      showMessage("Enter the catalog folder path.", "error");
      return;
    }
    showMessage("");
    try {
      state.status = await EditProUtils.apiPost("/api/artwork/register", { input });
      renderStatus();
      poll();
    } catch (error) {
      showMessage(error.message || String(error), "error");
    }
  }

  async function review(names, action, note) {
    try {
      const { done } = await EditProUtils.apiPost("/api/artwork/review", { names, action, note });
      const verb = { approve: "approved and moved to Oriented", reject: "rejected", feedback: "sent back with feedback" }[action];
      showMessage(`${done.length} image${done.length === 1 ? "" : "s"} ${verb}.`, "success");
      await loadList({ quiet: true });
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
    }
    loadList({ quiet: !state.list });
  }

  function bind() {
    cacheEls();
    buildFilters();
    els.start?.addEventListener("click", register);
    els.refresh?.addEventListener("click", () => loadList());
    els.approveShown?.addEventListener("click", () => {
      const names = filteredRows()
        .filter((row) => row.stage === "review")
        .map((row) => row.name);
      if (!names.length) {
        showMessage("No shown images are waiting for review.", "error");
        return;
      }
      if (window.confirm(`Approve ${names.length} image${names.length === 1 ? "" : "s"} and move them to Oriented?`)) {
        review(names, "approve");
      }
    });
    els.body?.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-action]");
      const box = button?.closest("[data-review-for]");
      if (!box) return;
      const name = box.dataset.reviewFor;
      const action = button.dataset.action;
      const note = box.querySelector(".artwork-review-note")?.value || "";
      if (action === "reject" && !window.confirm(`Reject ${name}? It won't be carried forward.`)) return;
      review([name], action, note);
    });
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

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bind);
  else bind();
})();
