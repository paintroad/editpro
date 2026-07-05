window.EditProPreviewModal = {
  init() {
    this.modal = document.getElementById("previewModal");
    this.body = document.getElementById("previewModalBody");
    this.titleEl = document.getElementById("previewModalTitle");
    this.countEl = document.getElementById("previewModalCount");
    this.complianceSummaryEl = document.getElementById("previewComplianceSummary");
    this.actionBtn = document.getElementById("previewModalActionBtn");
    this.progressWrap = document.getElementById("previewModalProgress");
    this.progressBar = document.getElementById("previewModalProgressBar");
    this.messageEl = document.getElementById("previewModalMessage");
    this.viewErrorsBtn = document.getElementById("previewModalViewErrorsBtn");
    this.errorListEl = document.getElementById("previewModalErrorList");

    this.changes = [];
    this.selectedIds = new Set();
    this.mode = "sync";
    this.onComplete = null;
    this.logEntryId = null;
    this.lastSyncErrors = [];
    this.errorsExpanded = false;

    document.getElementById("previewModalClose")?.addEventListener("click", () => this.close());
    this.modal?.querySelector(".modal-backdrop")?.addEventListener("click", () => this.close());
    this.actionBtn?.addEventListener("click", () => this.runAction());
    this.viewErrorsBtn?.addEventListener("click", () => this.toggleErrorList());

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
      this.renderComplianceSummary();
    });
  },

  clearSyncErrors() {
    this.lastSyncErrors = [];
    this.errorsExpanded = false;
    if (this.viewErrorsBtn) {
      this.viewErrorsBtn.hidden = true;
      this.viewErrorsBtn.textContent = "View errors";
    }
    if (this.errorListEl) {
      this.errorListEl.hidden = true;
      this.errorListEl.innerHTML = "";
    }
  },

  renderErrorList() {
    if (!this.errorListEl) {
      return;
    }
    this.errorListEl.innerHTML = this.lastSyncErrors
      .map((err) => {
        const resource = EditProUtils.escapeHtml(err.resourceTitle || "Unknown");
        const field = EditProUtils.escapeHtml(err.field || "Field");
        const message = EditProUtils.escapeHtml(err.message || "Unknown error");
        return `<li><strong>${resource}</strong> — ${field}: ${message}</li>`;
      })
      .join("");
  },

  showSyncErrors(errors) {
    this.lastSyncErrors = errors;
    this.errorsExpanded = false;
    this.renderErrorList();
    if (this.viewErrorsBtn) {
      this.viewErrorsBtn.hidden = errors.length === 0;
      this.viewErrorsBtn.textContent = "View errors";
    }
    if (this.errorListEl) {
      this.errorListEl.hidden = true;
    }
  },

  toggleErrorList() {
    if (!this.lastSyncErrors.length) {
      return;
    }
    this.errorsExpanded = !this.errorsExpanded;
    if (this.errorListEl) {
      this.errorListEl.hidden = !this.errorsExpanded;
    }
    if (this.viewErrorsBtn) {
      this.viewErrorsBtn.textContent = this.errorsExpanded ? "Hide errors" : "View errors";
    }
  },

  lookupResource(change) {
    const storeData = window.EditProLive?.getStoreData?.() || {};
    if (change.resourceType === "product") {
      return storeData.products?.find((item) => item.id === change.resourceId) || null;
    }
    if (change.resourceType === "collection") {
      return storeData.collections?.find((item) => item.id === change.resourceId) || null;
    }
    return storeData.articles?.find((item) => item.id === change.resourceId) || null;
  },

  annotateCompliance() {
    for (const change of this.changes) {
      const resource = this.lookupResource(change);
      change.compliance = EditProCatalogQuality.evaluateProposedChange(change, resource);
    }
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
    this.annotateCompliance();
    this.titleEl.textContent = title;
    EditProUtils.hideMessage(this.messageEl);
    this.clearSyncErrors();
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

  renderComplianceCell(change) {
    const compliance = change.compliance;
    if (!compliance?.applicable) {
      return `<td class="preview-compliance-cell"><span class="compliance-badge compliance-na">Not audited</span></td>`;
    }
    const status = compliance.status || (compliance.pass ? "pass" : "fail");
    const badgeClass =
      status === "pass" ? "compliance-pass" : status === "warn" ? "compliance-warn" : "compliance-fail";
    const label =
      status === "pass" ? "Compliant" : status === "warn" ? "Warning" : "Non-compliant";
    const hint = compliance.hint
      ? `<div class="preview-compliance-hint">${EditProUtils.escapeHtml(compliance.hint)}</div>`
      : "";
    return `<td class="preview-compliance-cell"><span class="compliance-badge ${badgeClass}">${label}</span>${hint}</td>`;
  },

  renderRow(change) {
    const checked = this.selectedIds.has(change.changeId);
    const usage = change.fileUsage || [];
    const usageHtml = EditProFileUsage.formatUsage(usage);
    const sharedBadge = EditProFileUsage.isShared(usage)
      ? ' <span class="badge badge-warning">Shared</span>'
      : "";
    const compliance = change.compliance;
    let rowClass = "preview-row--na";
    if (compliance?.applicable) {
      const status = compliance.status || (compliance.pass ? "pass" : "fail");
      rowClass =
        status === "pass"
          ? "preview-row--pass"
          : status === "warn"
            ? "preview-row--warn"
            : "preview-row--fail";
    }
    const checkCell =
      this.mode === "view"
        ? ""
        : `<td class="col-check"><input type="checkbox" data-preview-change-id="${EditProUtils.escapeHtml(change.changeId)}" ${checked ? "checked" : ""} /></td>`;

    return `<tr class="${rowClass}">
      ${checkCell}
      <td>${EditProUtils.escapeHtml(change.resourceType)}</td>
      <td>${EditProUtils.escapeHtml(change.resourceTitle)}</td>
      <td>${EditProUtils.escapeHtml(change.field)}</td>
      <td class="preview-old">${EditProUtils.escapeHtml(change.displayCurrent ?? change.current ?? change.oldValue ?? "—")}</td>
      <td class="arrow">→</td>
      <td class="preview-new">${EditProUtils.escapeHtml(change.displayProposed ?? change.proposed ?? change.newValue ?? "—")}</td>
      ${this.renderComplianceCell(change)}
      <td>${EditProUtils.escapeHtml(usageHtml)}${sharedBadge}</td>
    </tr>`;
  },

  renderComplianceSummary() {
    if (!this.complianceSummaryEl) {
      return;
    }

    const selected = this.getSelectedChanges();
    const applicable = selected.filter((change) => change.compliance?.applicable);

    if (!applicable.length) {
      this.complianceSummaryEl.hidden = true;
      this.complianceSummaryEl.innerHTML = "";
      return;
    }

    const passCount = applicable.filter((change) => change.compliance.status === "pass").length;
    const warnCount = applicable.filter((change) => change.compliance.status === "warn").length;
    const failCount = applicable.filter((change) => change.compliance.status === "fail").length;
    const groups = new Map();

    for (const change of applicable) {
      const label = change.compliance.ruleLabel;
      if (!groups.has(label)) {
        groups.set(label, { pass: 0, warn: 0, fail: 0 });
      }
      const group = groups.get(label);
      const status = change.compliance.status;
      if (status === "pass") {
        group.pass += 1;
      } else if (status === "warn") {
        group.warn += 1;
      } else {
        group.fail += 1;
      }
    }

    const chips = [...groups.entries()]
      .map(([label, counts]) => {
        const parts = [];
        if (counts.fail) {
          parts.push(`${counts.fail} non-compliant`);
        }
        if (counts.warn) {
          parts.push(`${counts.warn} warning${counts.warn === 1 ? "" : "s"}`);
        }
        if (counts.pass) {
          parts.push(`${counts.pass} compliant`);
        }
        const chipClass = counts.fail
          ? "preview-summary-chip preview-summary-chip--warn"
          : counts.warn
            ? "preview-summary-chip preview-summary-chip--amber"
            : "preview-summary-chip preview-summary-chip--ok";
        return `<span class="${chipClass}">${EditProUtils.escapeHtml(label)}: ${parts.join(", ")}</span>`;
      })
      .join("");

    const compliantTotal = passCount + warnCount;
    const warnSuffix = warnCount ? ` (${warnCount} with warnings)` : "";
    this.complianceSummaryEl.innerHTML = `<p class="preview-summary-total">${compliantTotal} of ${applicable.length} selected edit${applicable.length === 1 ? "" : "s"} will be compliant${warnSuffix}${failCount ? ` · ${failCount} non-compliant` : ""}</p><div class="preview-summary-chips">${chips}</div>`;
    this.complianceSummaryEl.hidden = false;
  },

  render() {
    const colSpan = this.mode === "view" ? 8 : 9;
    if (this.changes.length === 0) {
      this.body.innerHTML = `<tr class="empty-row"><td colspan="${colSpan}">No changes to preview.</td></tr>`;
    } else {
      this.body.innerHTML = this.changes.map((c) => this.renderRow(c)).join("");
    }
    this.updateCount();
    this.updateActionButton();
    this.renderComplianceSummary();
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
    this.clearSyncErrors();
    this.actionBtn.disabled = true;
    this.progressWrap.hidden = false;
    this.progressBar.style.width = "0%";

    const merged = EditProMutations.mergeFileUpdates(selected);
    const { errors, succeeded } = await EditProMutations.runChanges(merged, {
      onProgress: (done, total) => {
        this.progressBar.style.width = `${Math.round((done / total) * 100)}%`;
      },
    });

    for (const err of errors) {
      console.error(`${verb} failed:`, err);
    }

    this.progressWrap.hidden = true;
    this.progressBar.style.width = "0%";
    this.actionBtn.disabled = false;

    const failed = errors.length;

    if (failed) {
      EditProUtils.showMessage(
        this.messageEl,
        `${verb.charAt(0).toUpperCase() + verb.slice(1)} finished with ${failed} error${failed === 1 ? "" : "s"}. Re-fetch store to verify.`,
        "warning"
      );
      this.showSyncErrors(errors);
      if (succeeded.length && typeof this.onComplete === "function") {
        await this.onComplete({
          failed,
          succeeded,
          count: selected.length,
          mode: this.mode,
        });
      }
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
        await this.onComplete({
          failed: 0,
          succeeded,
          count: selected.length,
          mode: this.mode,
        });
      }

      setTimeout(() => this.close(), 800);
    }
  },
};
