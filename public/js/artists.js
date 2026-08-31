(function initArtistsModule() {
  const state = {
    artists: [],
    stats: null,
    selectedIds: new Set(),
    editingId: null,
    busy: false,
  };

  const els = {};

  function $(id) {
    return document.getElementById(id);
  }

  function cacheEls() {
    els.message = $("artistsMessage");
    els.statusMeta = $("artistsStatusMeta");
    els.countBadge = $("artistsCountBadge");
    els.scanBtn = $("artistsScanBtn");
    els.refreshBtn = $("artistsRefreshBtn");
    els.selectAll = $("artistsSelectAll");
    els.enrichBtn = $("artistsEnrichBtn");
    els.shopifyBtn = $("artistsShopifyBtn");
    els.linkBtn = $("artistsLinkBtn");
    els.selectionMeta = $("artistsSelectionMeta");
    els.empty = $("artistsEmpty");
    els.tbody = $("artistsTableBody");
    els.bioModal = $("artistBioModal");
    els.bioTitle = $("artistBioModalTitle");
    els.bioHint = $("artistBioModalHint");
    els.bioEditor = $("artistBioEditor");
    els.bioModalMessage = $("artistBioModalMessage");
    els.bioClose = $("artistBioModalClose");
    els.bioCancel = $("artistBioCancelBtn");
    els.bioSave = $("artistBioSaveBtn");
  }

  function showMessage(text, type = "success") {
    if (!els.message) return;
    if (!text) {
      EditProUtils.hideMessage(els.message);
      return;
    }
    EditProUtils.showMessage(els.message, text, type);
  }

  function stripImagesClient(html) {
    return String(html || "")
      .replace(/<img\b[^>]*>/gi, "")
      .replace(/<figure\b[^>]*>[\s\S]*?<\/figure>/gi, "")
      .trim();
  }

  function plainPreview(html) {
    const plain = String(html || "")
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<\/p>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!plain) return "—";
    return plain.length > 90 ? `${plain.slice(0, 89)}…` : plain;
  }

  function statusBadge(kind, status) {
    const s = status || "pending";
    return `<span class="artists-status artists-status--${EditProUtils.escapeHtml(s)}">${EditProUtils.escapeHtml(s)}</span>`;
  }

  function pendingPushHint(artist) {
    if (
      artist.shopifyStatus === "created" &&
      artist.biographyEditedAt &&
      artist.pushedAt &&
      artist.biographyEditedAt > artist.pushedAt
    ) {
      return `<span class="artists-pending-push" title="Local bio edits not pushed yet">pending push</span>`;
    }
    return "";
  }

  function applyStore(payload) {
    const store = payload.store || payload;
    state.artists = store.artists || [];
    state.stats = payload.stats || null;
    render();
  }

  function updateStatsMeta() {
    const s = state.stats;
    if (els.countBadge) {
      els.countBadge.textContent = `${state.artists.length} artists`;
    }
    if (els.statusMeta) {
      if (!state.artists.length) {
        els.statusMeta.textContent =
          "Scan Famous Painters folders to load artists.";
      } else if (s) {
        els.statusMeta.textContent = `${s.enriched} enriched · ${s.onShopify} on Shopify · ${s.pendingShopify} pending Shopify`;
      } else {
        els.statusMeta.textContent = `${state.artists.length} artists loaded.`;
      }
    }
  }

  function updateSelectionUi() {
    const n = state.selectedIds.size;
    if (els.selectionMeta) {
      els.selectionMeta.textContent = `${n} selected`;
    }
    if (els.enrichBtn) els.enrichBtn.disabled = state.busy || n === 0;
    if (els.shopifyBtn) els.shopifyBtn.disabled = state.busy || n === 0;
    if (els.linkBtn) els.linkBtn.disabled = state.busy || n === 0;
    if (els.selectAll) {
      const allSelected =
        state.artists.length > 0 &&
        state.artists.every((a) => state.selectedIds.has(a.id));
      const some =
        state.selectedIds.size > 0 && !allSelected;
      els.selectAll.checked = allSelected;
      els.selectAll.indeterminate = some;
    }
  }

  function render() {
    updateStatsMeta();
    updateSelectionUi();
    if (!els.tbody) return;

    if (!state.artists.length) {
      els.tbody.innerHTML = "";
      if (els.empty) {
        els.empty.hidden = false;
        els.empty.textContent =
          "No artists yet. Click “Scan folders” to load from Famous Painters.";
      }
      return;
    }
    if (els.empty) els.empty.hidden = true;

    const bust = Date.now();
    els.tbody.innerHTML = state.artists
      .map((artist) => {
        const checked = state.selectedIds.has(artist.id) ? "checked" : "";
        const hasImage =
          Boolean(artist.imageLocalPath) ||
          artist.enrichStatus === "enriched" ||
          artist.shopifyStatus === "created";
        const thumb = hasImage
          ? `<img class="artists-thumb" src="${EditProUtils.apiUrl(`/api/artists/${encodeURIComponent(artist.id)}/image`)}?t=${bust}" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'artists-thumb-empty',textContent:'—'}))" />`
          : `<span class="artists-thumb-empty">—</span>`;
        const wiki = artist.wikipediaUrl
          ? `<a href="${EditProUtils.escapeHtml(artist.wikipediaUrl)}" target="_blank" rel="noopener">Wiki</a>`
          : "—";
        return `<tr data-artist-id="${EditProUtils.escapeHtml(artist.id)}">
          <td class="artists-col-check">
            <input type="checkbox" class="artists-row-check" data-artist-id="${EditProUtils.escapeHtml(artist.id)}" ${checked} />
          </td>
          <td class="artists-col-thumb">${thumb}</td>
          <td>
            <strong>${EditProUtils.escapeHtml(artist.name)}</strong>
            <div class="meta">${EditProUtils.escapeHtml(artist.folderName || "")}</div>
          </td>
          <td>${EditProUtils.escapeHtml(artist.nationality || "—")}</td>
          <td>${(artist.productIds || []).length}</td>
          <td>${statusBadge("enrich", artist.enrichStatus)}${artist.enrichStatus === "error" && artist.error ? `<div class="meta">${EditProUtils.escapeHtml(artist.error)}</div>` : ""}</td>
          <td>${statusBadge("shopify", artist.shopifyStatus)}${pendingPushHint(artist)}</td>
          <td class="artists-col-bio">
            <span class="artists-bio-preview">${EditProUtils.escapeHtml(plainPreview(artist.biographyHtml))}</span>
            <button type="button" class="artists-bio-edit-btn" data-artist-id="${EditProUtils.escapeHtml(artist.id)}" title="Edit biography" aria-label="Edit biography">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>
            </button>
          </td>
          <td>${wiki}</td>
        </tr>`;
      })
      .join("");
  }

  async function loadStore() {
    const data = await EditProUtils.apiGet("/api/artists");
    applyStore(data);
  }

  async function scan() {
    if (state.busy) return;
    state.busy = true;
    showMessage("");
    try {
      const data = await EditProUtils.apiPost("/api/artists/scan", {});
      state.selectedIds.clear();
      applyStore(data);
      showMessage(`Scanned ${state.artists.length} artists from Famous Painters.`, "success");
    } catch (error) {
      showMessage(error.message || "Scan failed.", "error");
    } finally {
      state.busy = false;
      updateSelectionUi();
    }
  }

  async function enrichSelected() {
    const ids = [...state.selectedIds];
    if (!ids.length || state.busy) return;
    state.busy = true;
    updateSelectionUi();
    showMessage(`Enriching ${ids.length} artist(s)…`, "warning");
    try {
      const data = await EditProUtils.apiPost("/api/artists/enrich", { ids });
      applyStore(data);
      showMessage(
        `Enriched ${data.ok?.length || 0}. Errors: ${data.errors?.length || 0}.`,
        data.errors?.length ? "warning" : "success"
      );
    } catch (error) {
      showMessage(error.message || "Enrich failed.", "error");
      try {
        await loadStore();
      } catch {
        /* ignore */
      }
    } finally {
      state.busy = false;
      updateSelectionUi();
    }
  }

  async function pushSelected() {
    const ids = [...state.selectedIds];
    if (!ids.length || state.busy) return;
    state.busy = true;
    updateSelectionUi();
    showMessage(`Pushing ${ids.length} artist(s) to Shopify…`, "warning");
    try {
      const data = await EditProUtils.apiPost("/api/artists/shopify-push", {
        ids,
      });
      applyStore(data);
      showMessage(
        `On Shopify: ${data.ok?.length || 0}. Errors: ${data.errors?.length || 0}.`,
        data.errors?.length ? "warning" : "success"
      );
    } catch (error) {
      showMessage(error.message || "Shopify push failed.", "error");
      try {
        await loadStore();
      } catch {
        /* ignore */
      }
    } finally {
      state.busy = false;
      updateSelectionUi();
    }
  }

  async function linkSelected() {
    const ids = [...state.selectedIds];
    if (!ids.length || state.busy) return;
    state.busy = true;
    updateSelectionUi();
    showMessage(`Linking products for ${ids.length} artist(s)…`, "warning");
    try {
      const data = await EditProUtils.apiPost("/api/artists/link-products", {
        ids,
      });
      applyStore(data);
      const linked = (data.reports || []).reduce(
        (sum, r) => sum + (r.linkedCount || 0),
        0
      );
      const missing = (data.reports || []).reduce(
        (sum, r) => sum + (r.missingCount || 0),
        0
      );
      showMessage(
        `Linked ${linked} products. Missing ${missing}. Errors: ${data.errors?.length || 0}.`,
        data.errors?.length || missing ? "warning" : "success"
      );
    } catch (error) {
      showMessage(error.message || "Link failed.", "error");
    } finally {
      state.busy = false;
      updateSelectionUi();
    }
  }

  function openBioModal(artistId) {
    const artist = state.artists.find((a) => a.id === artistId);
    if (!artist || !els.bioModal || !els.bioEditor) return;
    state.editingId = artistId;
    if (els.bioTitle) {
      els.bioTitle.textContent = `Edit biography — ${artist.name}`;
    }
    if (els.bioHint) {
      const pending =
        artist.shopifyStatus === "created" &&
        artist.biographyEditedAt &&
        artist.pushedAt &&
        artist.biographyEditedAt > artist.pushedAt;
      els.bioHint.textContent = pending
        ? "History and work only — no images. Local edits pending Shopify push."
        : "History and body of work only — no images in the biography.";
    }
    els.bioEditor.innerHTML = artist.biographyHtml || "<p></p>";
    if (els.bioModalMessage) {
      EditProUtils.hideMessage(els.bioModalMessage);
    }
    els.bioModal.hidden = false;
    document.body.classList.add("modal-open");
    els.bioEditor.focus();
  }

  function closeBioModal() {
    if (els.bioModal) els.bioModal.hidden = true;
    document.body.classList.remove("modal-open");
    state.editingId = null;
  }

  async function saveBioModal() {
    if (!state.editingId || !els.bioEditor) return;
    const biographyHtml = stripImagesClient(els.bioEditor.innerHTML);
    try {
      const data = await EditProUtils.apiPut(
        `/api/artists/${encodeURIComponent(state.editingId)}`,
        { biographyHtml }
      );
      applyStore(data);
      closeBioModal();
      showMessage("Biography saved locally.", "success");
    } catch (error) {
      if (els.bioModalMessage) {
        EditProUtils.showMessage(
          els.bioModalMessage,
          error.message || "Save failed.",
          "error"
        );
      }
    }
  }

  function bindEvents() {
    els.scanBtn?.addEventListener("click", scan);
    els.refreshBtn?.addEventListener("click", () => {
      loadStore().catch((e) => showMessage(e.message, "error"));
    });
    els.enrichBtn?.addEventListener("click", enrichSelected);
    els.shopifyBtn?.addEventListener("click", pushSelected);
    els.linkBtn?.addEventListener("click", linkSelected);

    els.selectAll?.addEventListener("change", () => {
      const checked = Boolean(els.selectAll.checked);
      state.selectedIds.clear();
      if (checked) {
        for (const a of state.artists) state.selectedIds.add(a.id);
      }
      render();
    });

    els.tbody?.addEventListener("change", (event) => {
      const check = event.target.closest(".artists-row-check");
      if (!check) return;
      const id = check.dataset.artistId;
      if (check.checked) state.selectedIds.add(id);
      else state.selectedIds.delete(id);
      updateSelectionUi();
    });

    els.tbody?.addEventListener("click", (event) => {
      const btn = event.target.closest(".artists-bio-edit-btn");
      if (btn) {
        openBioModal(btn.dataset.artistId);
      }
    });

    els.bioClose?.addEventListener("click", closeBioModal);
    els.bioCancel?.addEventListener("click", closeBioModal);
    els.bioSave?.addEventListener("click", saveBioModal);
    els.bioModal
      ?.querySelector(".modal-backdrop")
      ?.addEventListener("click", closeBioModal);

    els.bioModal?.querySelectorAll("[data-bio-cmd]").forEach((btn) => {
      btn.addEventListener("mousedown", (e) => e.preventDefault());
      btn.addEventListener("click", () => {
        const cmd = btn.getAttribute("data-bio-cmd");
        const value = btn.getAttribute("data-bio-value");
        if (cmd === "formatBlock" && value) {
          document.execCommand("formatBlock", false, value);
        } else {
          document.execCommand(cmd, false, null);
        }
        els.bioEditor?.focus();
      });
    });

    document.addEventListener("editpro:module-changed", (event) => {
      if (event.detail?.moduleId === "artists") {
        loadStore().catch(() => {});
      }
    });

    if (sessionStorage.getItem("editpro-module") === "artists") {
      loadStore().catch(() => {});
    }
  }

  function init() {
    cacheEls();
    if (!els.tbody) return;
    bindEvents();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  window.EditProArtists = {
    refresh: loadStore,
    scan,
  };
})();
