(function initSaleModule() {
  const state = {
    items: [],
    discountMin: 5,
    discountMax: 15,
    selectedIds: new Set(),
    busy: false,
    loaded: false,
  };

  const els = {};

  function $(id) {
    return document.getElementById(id);
  }

  function cacheEls() {
    els.message = $("saleMessage");
    els.statusMeta = $("saleStatusMeta");
    els.countBadge = $("saleCountBadge");
    els.minInput = $("saleDiscountMin");
    els.maxInput = $("saleDiscountMax");
    els.minRange = $("saleDiscountMinRange");
    els.maxRange = $("saleDiscountMaxRange");
    els.discountLabel = $("saleDiscountLabel");
    els.refreshBtn = $("saleRefreshBtn");
    els.revertBtn = $("saleRevertBtn");
    els.selectAll = $("saleSelectAll");
    els.selectionMeta = $("saleSelectionMeta");
    els.empty = $("saleEmpty");
    els.tableWrap = $("saleTableWrap");
    els.tbody = $("saleTableBody");
    els.overlay = $("saleOverlay");
    els.overlayTitle = $("saleOverlayTitle");
    els.overlayStatus = $("saleOverlayStatus");
  }

  function showMessage(text, type = "success") {
    if (!els.message) return;
    if (!text) {
      EditProUtils.hideMessage(els.message);
      return;
    }
    EditProUtils.showMessage(els.message, text, type);
  }

  function formatInr(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "—";
    return `₹${Math.round(n).toLocaleString("en-IN")}`;
  }

  function syncDiscountControls(from) {
    let min = Number(els.minInput?.value ?? state.discountMin);
    let max = Number(els.maxInput?.value ?? state.discountMax);
    if (from === "minRange") min = Number(els.minRange.value);
    if (from === "maxRange") max = Number(els.maxRange.value);
    if (from === "minInput") min = Number(els.minInput.value);
    if (from === "maxInput") max = Number(els.maxInput.value);

    if (Number.isNaN(min)) min = 5;
    if (Number.isNaN(max)) max = 15;
    min = Math.max(1, Math.min(90, Math.round(min)));
    max = Math.max(1, Math.min(90, Math.round(max)));
    if (min > max) {
      if (from === "minInput" || from === "minRange") max = min;
      else min = max;
    }

    state.discountMin = min;
    state.discountMax = max;
    if (els.minInput) els.minInput.value = String(min);
    if (els.maxInput) els.maxInput.value = String(max);
    if (els.minRange) els.minRange.value = String(min);
    if (els.maxRange) els.maxRange.value = String(max);
    if (els.discountLabel) {
      els.discountLabel.textContent = `${min}–${max}%`;
    }
  }

  function setBusy(busy, title, status) {
    state.busy = busy;
    if (els.overlay) els.overlay.hidden = !busy;
    if (els.overlayTitle && title) els.overlayTitle.textContent = title;
    if (els.overlayStatus && status) els.overlayStatus.textContent = status;
    if (els.refreshBtn) els.refreshBtn.disabled = busy;
    if (els.revertBtn) {
      els.revertBtn.disabled = busy || state.selectedIds.size === 0;
    }
    [els.minInput, els.maxInput, els.minRange, els.maxRange].forEach((el) => {
      if (el) el.disabled = busy;
    });
  }

  function applyPayload(payload) {
    state.items = Array.isArray(payload.items) ? payload.items : [];
    if (payload.discountMin != null) state.discountMin = Number(payload.discountMin);
    if (payload.discountMax != null) state.discountMax = Number(payload.discountMax);
    if (els.minInput) els.minInput.value = String(state.discountMin);
    if (els.maxInput) els.maxInput.value = String(state.discountMax);
    syncDiscountControls();
    const keep = new Set(state.items.map((i) => i.variantId));
    state.selectedIds = new Set(
      [...state.selectedIds].filter((id) => keep.has(id))
    );
    render();
  }

  function updateSelectionMeta() {
    const n = state.selectedIds.size;
    if (els.selectionMeta) {
      els.selectionMeta.textContent = `${n} selected`;
    }
    if (els.revertBtn) {
      els.revertBtn.disabled = state.busy || n === 0;
    }
    if (els.selectAll) {
      els.selectAll.checked =
        state.items.length > 0 && state.selectedIds.size === state.items.length;
      els.selectAll.indeterminate =
        state.selectedIds.size > 0 &&
        state.selectedIds.size < state.items.length;
    }
  }

  function render() {
    if (els.countBadge) {
      els.countBadge.textContent = `${state.items.length} on sale`;
    }
    if (els.statusMeta) {
      if (!state.items.length) {
        els.statusMeta.textContent =
          "Click Refresh to pick up to 200 L 24\"x36\" Canvas Black/White variants.";
      } else {
        els.statusMeta.textContent = `Discount range ${state.discountMin}–${state.discountMax}% · L 24"x36" Canvas · Black/White frame`;
      }
    }

    const hasItems = state.items.length > 0;
    if (els.empty) {
      els.empty.hidden = hasItems;
      if (!hasItems) {
        els.empty.textContent =
          "No products on sale yet. Adjust the discount range and click Refresh.";
      }
    }
    if (els.tableWrap) els.tableWrap.hidden = !hasItems;

    if (!els.tbody) return;
    if (!hasItems) {
      els.tbody.innerHTML = "";
      updateSelectionMeta();
      return;
    }

    els.tbody.innerHTML = state.items
      .map((item) => {
        const checked = state.selectedIds.has(item.variantId) ? "checked" : "";
        const thumb = item.imageUrl
          ? `<img class="sale-thumb" src="${EditProUtils.escapeHtml(item.imageUrl)}" alt="" loading="lazy" />`
          : `<span class="sale-thumb sale-thumb--empty"></span>`;
        const productCell = `
          <div class="sale-product-cell">
            <strong>${EditProUtils.escapeHtml(item.title || "Untitled")}</strong>
            <span class="meta">${EditProUtils.escapeHtml(item.handle || "")}</span>
          </div>`;
        const variantCell = `${EditProUtils.escapeHtml(item.size || "")}<br/><span class="meta">${EditProUtils.escapeHtml(item.material || "")} · ${EditProUtils.escapeHtml(item.frame || "")}</span>`;
        return `<tr data-variant-id="${EditProUtils.escapeHtml(item.variantId)}">
          <td class="sale-col-check"><input type="checkbox" class="sale-row-check" data-variant-id="${EditProUtils.escapeHtml(item.variantId)}" ${checked} /></td>
          <td class="sale-col-thumb">${thumb}</td>
          <td>${productCell}</td>
          <td>${EditProUtils.escapeHtml(item.collection || "—")}</td>
          <td>${variantCell}</td>
          <td>${formatInr(item.listPrice)}</td>
          <td><strong>${formatInr(item.salePrice)}</strong></td>
          <td><span class="sale-discount-badge">${EditProUtils.escapeHtml(String(item.discountPercent))}%</span></td>
        </tr>`;
      })
      .join("");

    updateSelectionMeta();
  }

  async function loadSession() {
    try {
      const data = await EditProUtils.apiGet("/api/sale");
      applyPayload(data);
      state.loaded = true;
    } catch (error) {
      showMessage(error.message || "Failed to load sale session.", "error");
    }
  }

  async function persistSettings() {
    syncDiscountControls();
    try {
      await EditProUtils.apiPut("/api/sale/settings", {
        discountMin: state.discountMin,
        discountMax: state.discountMax,
      });
    } catch {
      // non-blocking
    }
  }

  async function onRefresh() {
    if (state.busy) return;
    syncDiscountControls();
    setBusy(
      true,
      "Refreshing sale…",
      "Reverting current prices and selecting new products…"
    );
    showMessage("");
    try {
      const data = await EditProUtils.apiPost("/api/sale/refresh", {
        discountMin: state.discountMin,
        discountMax: state.discountMax,
      });
      state.selectedIds.clear();
      applyPayload(data);
      const errCount =
        (data.applyErrors?.length || 0) + (data.revertErrors?.length || 0);
      showMessage(
        errCount
          ? `Sale refreshed with ${data.count} products (${errCount} Shopify warnings).`
          : `Sale refreshed: ${data.count} products on discount.`,
        errCount ? "error" : "success"
      );
    } catch (error) {
      showMessage(error.message || "Refresh failed.", "error");
      await loadSession();
    } finally {
      setBusy(false);
    }
  }

  async function onRevert() {
    if (state.busy || !state.selectedIds.size) return;
    const variantIds = [...state.selectedIds];
    setBusy(true, "Reverting prices…", `Restoring ${variantIds.length} variant(s)…`);
    showMessage("");
    try {
      const data = await EditProUtils.apiPost("/api/sale/revert", { variantIds });
      state.selectedIds.clear();
      applyPayload(data);
      showMessage(
        `Reverted ${data.reverted || variantIds.length} product(s) to original price.`,
        "success"
      );
    } catch (error) {
      showMessage(error.message || "Revert failed.", "error");
      await loadSession();
    } finally {
      setBusy(false);
    }
  }

  function bindEvents() {
    els.refreshBtn?.addEventListener("click", () => onRefresh());
    els.revertBtn?.addEventListener("click", () => onRevert());

    ["minInput", "maxInput", "minRange", "maxRange"].forEach((key) => {
      const el = els[key];
      if (!el) return;
      el.addEventListener("input", () => {
        const map = {
          minInput: "minInput",
          maxInput: "maxInput",
          minRange: "minRange",
          maxRange: "maxRange",
        };
        syncDiscountControls(map[key]);
      });
      el.addEventListener("change", () => persistSettings());
    });

    els.selectAll?.addEventListener("change", () => {
      if (els.selectAll.checked) {
        state.items.forEach((i) => state.selectedIds.add(i.variantId));
      } else {
        state.selectedIds.clear();
      }
      render();
    });

    els.tbody?.addEventListener("change", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement)) return;
      if (!target.classList.contains("sale-row-check")) return;
      const id = target.dataset.variantId;
      if (!id) return;
      if (target.checked) state.selectedIds.add(id);
      else state.selectedIds.delete(id);
      updateSelectionMeta();
    });
  }

  function init() {
    cacheEls();
    if (!els.refreshBtn) return;
    bindEvents();
    syncDiscountControls();
    document.addEventListener("editpro:module-changed", (event) => {
      if (event.detail?.moduleId === "sale") {
        loadSession().catch(() => {});
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  window.EditProSale = {
    reload: loadSession,
  };
})();
