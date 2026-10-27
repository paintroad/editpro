(function initIndexCutout() {
  const state = {
    rows: [],
    loaded: false,
    loading: false,
    filter: "all",
    search: "",
    page: 1,
    selected: new Set(),
    outputDir: "",
  };

  const els = {};

  function $(id) {
    return document.getElementById(id);
  }

  function cacheEls() {
    els.message = $("cutoutMessage");
    els.meta = $("cutoutStatusMeta");
    els.badge = $("cutoutCountBadge");
    els.refresh = $("cutoutRefreshBtn");
    els.convert = $("cutoutConvertBtn");
    els.upload = $("cutoutUploadBtn");
    els.search = $("cutoutSearch");
    els.filter = $("cutoutFilter");
    els.selection = $("cutoutSelectionMeta");
    els.empty = $("cutoutEmpty");
    els.body = $("cutoutTableBody");
    els.selectVisible = $("cutoutSelectVisible");
    els.pagination = $("cutoutPagination");
    els.prevBtn = $("cutoutPrevBtn");
    els.nextBtn = $("cutoutNextBtn");
    els.pageInfo = $("cutoutPageInfo");
  }

  const PAGE_SIZE = 500;

  function showMessage(text, type) {
    if (!els.message) return;
    els.message.textContent = text || "";
    els.message.classList.toggle("hidden", !text);
    els.message.classList.toggle("error", type === "error");
    els.message.classList.toggle("success", type === "success");
  }

  function isDone(status) {
    return status === "uploaded";
  }

  function filteredRows() {
    const query = state.search.trim().toLowerCase();
    return state.rows.filter((row) => {
      if (state.filter === "pending" && isDone(row.status)) return false;
      if (state.filter === "done" && !isDone(row.status)) return false;
      if (!query) return true;
      return (
        String(row.productId).toLowerCase().includes(query) ||
        String(row.title || "").toLowerCase().includes(query)
      );
    });
  }

  function updateSelectionMeta() {
    const count = state.selected.size;
    if (els.selection) els.selection.textContent = `${count} selected`;
    const busy = state.loading;
    if (els.convert) els.convert.disabled = busy || count === 0;
    if (els.upload) els.upload.disabled = busy || count === 0;
  }

  function pageOf(rows) {
    const total = rows.length;
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const page = Math.min(Math.max(state.page, 1), totalPages);
    state.page = page;
    const start = (page - 1) * PAGE_SIZE;
    return {
      rows: rows.slice(start, start + PAGE_SIZE),
      total,
      page,
      totalPages,
      start,
    };
  }

  function render() {
    const matched = filteredRows();
    const page = pageOf(matched);
    if (els.empty) els.empty.hidden = page.total > 0;
    if (els.pagination) els.pagination.hidden = page.total === 0;
    if (els.pageInfo) {
      const from = page.total ? page.start + 1 : 0;
      const to = page.total ? page.start + page.rows.length : 0;
      els.pageInfo.textContent = page.total
        ? `${from}–${to} of ${page.total}`
        : "";
    }
    if (els.prevBtn) els.prevBtn.disabled = page.page <= 1;
    if (els.nextBtn) els.nextBtn.disabled = page.page >= page.totalPages;
    if (!els.body) return;
    els.body.innerHTML = page.rows
      .map((row) => {
        const checked = state.selected.has(row.productId) ? "checked" : "";
        const source = row.sourcePath ? "Found" : "Missing";
        return `<tr>
          <td><input type="checkbox" class="cutout-check" data-product-id="${EditProUtils.escapeHtml(row.productId)}" ${checked} /></td>
          <td>${EditProUtils.escapeHtml(row.productId)}</td>
          <td>${EditProUtils.escapeHtml(row.title || "")}</td>
          <td>${EditProUtils.escapeHtml(row.status)}${row.error ? ` — ${EditProUtils.escapeHtml(row.error)}` : ""}</td>
          <td>${source}</td>
        </tr>`;
      })
      .join("");
    if (els.selectVisible) {
      const selectedVisible = page.rows.filter((row) => state.selected.has(row.productId)).length;
      els.selectVisible.checked = page.rows.length > 0 && selectedVisible === page.rows.length;
      els.selectVisible.indeterminate = selectedVisible > 0 && selectedVisible < page.rows.length;
    }
    updateSelectionMeta();
  }

  function applyPayload(data) {
    state.rows = data.rows || [];
    state.outputDir = data.outputDir || "";
    state.loaded = true;
    const counts = data.counts || {};
    if (els.badge) {
      els.badge.textContent = `${state.rows.length} products`;
    }
    if (els.meta) {
      els.meta.textContent = `${counts.pending || 0} pending · ${counts.done || 0} done · ${counts.missing || 0} missing source. PNGs: ${state.outputDir}`;
    }
    render();
  }

  async function refresh() {
    if (state.loading) return;
    state.loading = true;
    updateSelectionMeta();
    showMessage("");
    try {
      const data = await EditProUtils.apiGet("/api/index-cutout");
      applyPayload(data);
    } catch (error) {
      showMessage(error.message || String(error), "error");
    } finally {
      state.loading = false;
      updateSelectionMeta();
    }
  }

  async function runAction(url, label) {
    const productIds = Array.from(state.selected);
    if (!productIds.length) {
      showMessage("Select at least one product.", "error");
      return;
    }
    state.loading = true;
    updateSelectionMeta();
    showMessage(`${label} ${productIds.length} product${productIds.length === 1 ? "" : "s"}…`);
    try {
      const data = await EditProUtils.apiPost(url, { productIds });
      applyPayload(data);
      const failed = (data.results || []).filter((row) => row.status === "error");
      if (failed.length) {
        showMessage(
          `${label} finished with ${failed.length} error${failed.length === 1 ? "" : "s"}. ${failed[0].error || ""}`,
          "error"
        );
      } else {
        showMessage(`${label} finished for ${productIds.length} product${productIds.length === 1 ? "" : "s"}.`, "success");
      }
    } catch (error) {
      showMessage(error.message || String(error), "error");
    } finally {
      state.loading = false;
      updateSelectionMeta();
    }
  }

  function bind() {
    cacheEls();
    els.refresh?.addEventListener("click", () => {
      refresh();
    });
    els.convert?.addEventListener("click", () => {
      runAction("/api/index-cutout/convert", "Convert");
    });
    els.upload?.addEventListener("click", () => {
      const count = state.selected.size;
      if (!count) return;
      if (
        !window.confirm(
          `Upload ${count} transparent PNG${count === 1 ? "" : "s"} to Shopify? Each new image becomes the first product image and the old JPG is deleted.`
        )
      ) {
        return;
      }
      runAction("/api/index-cutout/upload", "Upload");
    });
    els.search?.addEventListener("input", () => {
      state.search = els.search.value || "";
      state.page = 1;
      render();
    });
    els.filter?.addEventListener("change", () => {
      state.filter = els.filter.value || "all";
      state.page = 1;
      render();
    });
    els.prevBtn?.addEventListener("click", () => {
      state.page -= 1;
      render();
    });
    els.nextBtn?.addEventListener("click", () => {
      state.page += 1;
      render();
    });
    els.selectVisible?.addEventListener("change", () => {
      const rows = pageOf(filteredRows()).rows;
      if (els.selectVisible.checked) {
        for (const row of rows) state.selected.add(row.productId);
      } else {
        for (const row of rows) state.selected.delete(row.productId);
      }
      render();
    });
    els.body?.addEventListener("change", (event) => {
      const box = event.target.closest(".cutout-check");
      if (!box) return;
      const id = box.dataset.productId;
      if (box.checked) state.selected.add(id);
      else state.selected.delete(id);
      updateSelectionMeta();
      const rows = pageOf(filteredRows()).rows;
      const selectedVisible = rows.filter((row) => state.selected.has(row.productId)).length;
      if (els.selectVisible) {
        els.selectVisible.checked = rows.length > 0 && selectedVisible === rows.length;
        els.selectVisible.indeterminate = selectedVisible > 0 && selectedVisible < rows.length;
      }
    });
    document.addEventListener("editpro:module-changed", (event) => {
      if (event.detail?.moduleId === "cutout" && !state.loaded) refresh();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bind);
  } else {
    bind();
  }
})();
