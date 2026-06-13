window.EditProPreviewModal = {
  init() {
    this.modal = document.getElementById("previewModal");
    this.body = document.getElementById("previewModalBody");
    this.titleEl = document.getElementById("previewModalTitle");
    this.countEl = document.getElementById("previewModalCount");
    this.actionBtn = document.getElementById("previewModalActionBtn");
    this.progressWrap = document.getElementById("previewModalProgress");
    this.progressBar = document.getElementById("previewModalProgressBar");
    this.messageEl = document.getElementById("previewModalMessage");

    this.changes = [];
    this.selectedIds = new Set();
    this.mode = "sync";
    this.onComplete = null;
    this.logEntryId = null;

    document.getElementById("previewModalClose")?.addEventListener("click", () => this.close());
    this.modal?.querySelector(".modal-backdrop")?.addEventListener("click", () => this.close());
    this.actionBtn?.addEventListener("click", () => this.runAction());

    document.getElementById("previewSelectAllBtn")?.addEventListener("click", () => {
      this.selectedIds = new Set(this.changes.map((c) => c.changeId));
      this.render();
    });
    document.getElementById("previewClearBtn")?.addEventListener("click", () => {
      this.selectedIds = new Set();
      this.render();
    });

    this.body?.addEventListener("change", (e) => {
      const cb = e.target.closest("[data-preview-change-id]");
      if (!cb) {
        return;
      }
      if (cb.checked) {
        this.selectedIds.add(cb.dataset.previewChangeId);
      } else {
        this.selectedIds.delete(cb.dataset.previewChangeId);
      }
      this.updateActionButton();
      this.updateCount();
    });
  },

  open({ title, changes, mode = "sync", logEntryId = null, onComplete = null }) {
    if (!this.modal) {
      return;
    }
    this.mode = mode;
    this.logEntryId = logEntryId;
    this.onComplete = onComplete;
    this.changes = changes.map((c) => ({ ...c }));
    this.selectedIds = new Set(this.changes.map((c) => c.changeId));
    this.titleEl.textContent = title;
    EditProUtils.hideMessage(this.messageEl);
    this.progressWrap.hidden = true;
    this.progressBar.style.width = "0%";
    this.render();
    this.modal.hidden = false;
    document.body.classList.add("modal-open");
  },

  close() {
    if (!this.modal || this.modal.hidden) {
      return;
    }
    this.modal.hidden = true;
    this.resetModalOpenClass();
  },

  resetModalOpenClass() {
    const anyOpen = [
      "previewModal",
      "syncLogModal",
      "settingsModal",
      "connectionModal",
      "detailModal",
      "imageModal",
    ].some((id) => document.getElementById(id)?.hidden === false);
    if (!anyOpen) {
      document.body.classList.remove("modal-open");
    }
  },

  getSelectedChanges() {
    return this.changes.filter((c) => this.selectedIds.has(c.changeId));
  },

  renderRow(change) {
    const checked = this.selectedIds.has(change.changeId);
    const usage = change.fileUsage || [];
    const usageHtml = EditProFileUsage.formatUsage(usage);
    const sharedBadge = EditProFileUsage.isShared(usage)
      ? ' <span class="badge badge-warning">Shared</span>'
      : "";
    const checkCell =
      this.mode === "view"
        ? ""
        : `<td class="col-check"><input type="checkbox" data-preview-change-id="${EditProUtils.escapeHtml(change.changeId)}" ${checked ? "checked" : ""} /></td>`;

    return `<tr>
      ${checkCell}
      <td>${EditProUtils.escapeHtml(change.resourceType)}</td>
      <td>${EditProUtils.escapeHtml(change.resourceTitle)}</td>
      <td>${EditProUtils.escapeHtml(change.field)}</td>
      <td class="preview-old">${EditProUtils.escapeHtml(change.displayCurrent ?? change.current ?? change.oldValue ?? "—")}</td>
      <td class="arrow">→</td>
      <td class="preview-new">${EditProUtils.escapeHtml(change.displayProposed ?? change.proposed ?? change.newValue ?? "—")}</td>
      <td>${EditProUtils.escapeHtml(usageHtml)}${sharedBadge}</td>
    </tr>`;
  },

  render() {
    const colSpan = this.mode === "view" ? 7 : 8;
    if (this.changes.length === 0) {
      this.body.innerHTML = `<tr class="empty-row"><td colspan="${colSpan}">No changes to preview.</td></tr>`;
    } else {
      this.body.innerHTML = this.changes.map((c) => this.renderRow(c)).join("");
    }
    this.updateCount();
    this.updateActionButton();
    const toolbar = document.getElementById("previewModalToolbar");
    if (toolbar) {
      toolbar.hidden = this.mode === "view";
    }
  },

  updateCount() {
    if (this.countEl) {
      if (this.mode === "view") {
        this.countEl.textContent = `${this.changes.length} change${this.changes.length === 1 ? "" : "s"}`;
      } else {
        this.countEl.textContent = `${this.selectedIds.size} of ${this.changes.length} selected`;
      }
    }
  },

  updateActionButton() {
    if (!this.actionBtn) {
      return;
    }
    if (this.mode === "view") {
      this.actionBtn.hidden = true;
      return;
    }
    this.actionBtn.hidden = false;
    const count = this.selectedIds.size;
    if (this.mode === "revert") {
      this.actionBtn.textContent = count > 0 ? `Revert ${count} change${count === 1 ? "" : "s"}` : "Revert changes";
      this.actionBtn.className = "btn btn-danger";
    } else {
      this.actionBtn.textContent = count > 0 ? `Sync ${count} change${count === 1 ? "" : "s"} to Shopify` : "Sync to Shopify";
      this.actionBtn.className = "btn btn-primary";
    }
    this.actionBtn.disabled = count === 0;
  },

  async runAction() {
    const selected = this.getSelectedChanges();
    if (selected.length === 0) {
      return;
    }

    const verb = this.mode === "revert" ? "revert" : "sync";
    if (
      !window.confirm(
        `${this.mode === "revert" ? "Revert" : "Sync"} ${selected.length} change${selected.length === 1 ? "" : "s"} to Shopify?`
      )
    ) {
      return;
    }

    EditProUtils.hideMessage(this.messageEl);
    this.actionBtn.disabled = true;
    this.progressWrap.hidden = false;

    const merged = EditProMutations.mergeFileUpdates(selected);
    let done = 0;
    let failed = 0;

    for (const change of merged) {
      try {
        await EditProMutations.runMutation(change);
      } catch (error) {
        failed += 1;
        console.error(`${verb} failed:`, error);
      }
      done += 1;
      this.progressBar.style.width = `${Math.round((done / merged.length) * 100)}%`;
      await EditProUtils.sleep(500);
    }

    this.progressWrap.hidden = true;
    this.progressBar.style.width = "0%";
    this.actionBtn.disabled = false;

    if (failed) {
      EditProUtils.showMessage(
        this.messageEl,
        `${verb.charAt(0).toUpperCase() + verb.slice(1)} finished with ${failed} error${failed === 1 ? "" : "s"}. Re-fetch store to verify.`,
        "warning"
      );
    } else {
      EditProUtils.showMessage(
        this.messageEl,
        this.mode === "revert"
          ? "Selected changes reverted on Shopify."
          : "Selected changes synced to Shopify.",
        "success"
      );

      if (this.mode === "sync") {
        await EditProSyncLog.recordSync(selected);
      } else if (this.mode === "revert" && this.logEntryId) {
        await EditProSyncLog.markReverted(this.logEntryId, selected.length);
      }

      if (typeof this.onComplete === "function") {
        await this.onComplete({ failed, count: selected.length, mode: this.mode });
      }

      setTimeout(() => this.close(), failed ? 0 : 800);
    }
  },
};
