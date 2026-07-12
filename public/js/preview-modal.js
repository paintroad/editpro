window.EditProPreviewModal = {
  FIELD_KEY_ORDER: ["seoTitle", "seoDescription", "tags", "imageAlt", "imageFilename"],

  init() {
    this.modal = document.getElementById("previewModal");
    this.body = document.getElementById("previewModalBody");
    this.titleEl = document.getElementById("previewModalTitle");
    this.countEl = document.getElementById("previewModalCount");
    this.complianceSummaryEl = document.getElementById("previewComplianceSummary");
    this.fieldFiltersEl = document.getElementById("previewFieldFilters");
    this.actionBtn = document.getElementById("previewModalActionBtn");
    this.progressWrap = document.getElementById("previewModalProgress");
    this.progressBar = document.getElementById("previewModalProgressBar");
    this.messageEl = document.getElementById("previewModalMessage");
    this.viewErrorsBtn = document.getElementById("previewModalViewErrorsBtn");
    this.errorListEl = document.getElementById("previewModalErrorList");
    this.selectAllBtn = document.getElementById("previewSelectAllBtn");
    this.clearBtn = document.getElementById("previewClearBtn");

    this.changes = [];
    this.selectedIds = new Set();
    this.enabledFieldKeys = new Set();
    this.allFieldKeys = [];
    this.mode = "sync";
    this.onComplete = null;
    this.logEntryId = null;
    this.lastSyncErrors = [];
    this.errorsExpanded = false;

    document.getElementById("previewModalClose")?.addEventListener("click", () => this.close());
    this.modal?.querySelector(".modal-backdrop")?.addEventListener("click", () => this.close());
    this.actionBtn?.addEventListener("click", () => this.runAction());
    this.viewErrorsBtn?.addEventListener("click", () => this.toggleErrorList());

    this.fieldFiltersEl?.addEventListener("change", (e) => {
      const cb = e.target.closest("[data-preview-field-key]");
      if (!cb) {
        return;
      }
      this.setFieldKeyEnabled(cb.dataset.previewFieldKey, cb.checked);
    });

    document.getElementById("previewSelectAllBtn")?.addEventListener("click", () => {
      for (const change of this.getVisibleChanges()) {
        this.selectedIds.add(change.changeId);
      }
      this.render();
    });
    document.getElementById("previewClearBtn")?.addEventListener("click", () => {
      for (const change of this.getVisibleChanges()) {
        this.selectedIds.delete(change.changeId);
      }
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

  ensureChangeFieldKeys() {
    for (const change of this.changes) {
      if (!change.fieldKey) {
        change.fieldKey = EditProRules.changeFieldKey(change);
      }
    }
  },

  collectFieldKeys() {
    const present = new Set();
    for (const change of this.changes) {
      if (change.fieldKey) {
        present.add(change.fieldKey);
      }
    }
    return this.FIELD_KEY_ORDER.filter((key) => present.has(key));
  },

  fieldKeyLabel(key) {
    return EditProRules.CHANGE_FIELD_KEYS?.[key] || key;
  },

  getVisibleChanges() {
    if (this.mode !== "sync") {
      return this.changes;
    }
    return this.changes.filter((change) => change.fieldKey && this.enabledFieldKeys.has(change.fieldKey));
  },

  setFieldKeyEnabled(fieldKey, enabled) {
    const matching = this.changes.filter((change) => change.fieldKey === fieldKey);
    if (enabled) {
      this.enabledFieldKeys.add(fieldKey);
      for (const change of matching) {
        this.selectedIds.add(change.changeId);
      }
    } else {
      this.enabledFieldKeys.delete(fieldKey);
      for (const change of matching) {
        this.selectedIds.delete(change.changeId);
      }
    }
    this.render();
  },

  renderFieldFilters() {
    if (!this.fieldFiltersEl) {
      return;
    }
    const showFilters = this.mode === "sync" && this.allFieldKeys.length > 0;
    this.fieldFiltersEl.hidden = !showFilters;
    if (!showFilters) {
      this.fieldFiltersEl.innerHTML = "";
      return;
    }
    this.fieldFiltersEl.innerHTML = this.allFieldKeys
      .map((key) => {
        const checked = this.enabledFieldKeys.has(key);
        const label = EditProUtils.escapeHtml(this.fieldKeyLabel(key));
        return `<label class="preview-field-filter">
          <input type="checkbox" data-preview-field-key="${EditProUtils.escapeHtml(key)}" ${checked ? "checked" : ""} />
          ${label}
        </label>`;
      })
      .join("");
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
    this.errorsExpanded = errors.length > 0;
    this.renderErrorList();
    if (this.viewErrorsBtn) {
      this.viewErrorsBtn.hidden = errors.length === 0;
      this.viewErrorsBtn.textContent = this.errorsExpanded ? "Hide errors" : "View errors";
    }
    if (this.errorListEl) {
      this.errorListEl.hidden = !this.errorsExpanded;
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
    if (this.mode === "catalog-shopify") {
      for (const change of this.changes) {
        if (change.error || change.skip) {
          change.compliance = {
            applicable: true,
            status: "fail",
            pass: false,
            ruleKey: "ready",
            ruleLabel: "Ready to push",
            hint: change.error || "Cannot create this product.",
          };
          continue;
        }
        const seoTitle = change.previewMeta?.seoTitle || "";
        const seoResult = EditProCatalogQuality.evaluateProposedValue(
          "seoTitle",
          seoTitle,
          "product",
          null,
          null
        );
        const warnHints = [
          change.previewMeta?.missingImagesWarning,
          change.previewMeta?.seoWarning,
        ].filter(Boolean);
        if (warnHints.length) {
          change.compliance = {
            applicable: true,
            status: "warn",
            pass: true,
            ruleKey: warnHints.length > 1 ? "ready" : change.previewMeta?.seoWarning ? "seoTitle" : "ready",
            ruleLabel: warnHints.length > 1 ? "Ready to push" : EditProCatalogQuality.ISSUES.seoTitle,
            hint: warnHints.join(" "),
          };
        } else {
          change.compliance = {
            applicable: true,
            status: seoResult.status,
            pass: seoResult.status === "pass",
            ruleKey: "seoTitle",
            ruleLabel: EditProCatalogQuality.ISSUES.seoTitle,
            hint: seoResult.status === "pass" ? null : seoResult.hint,
          };
        }
      }
      return;
    }

    for (const change of this.changes) {
      change.compliance = EditProCatalogQuality.evaluateProposedChange(change, null);
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
    this.ensureChangeFieldKeys();
    this.allFieldKeys = this.collectFieldKeys();
    this.enabledFieldKeys = new Set(this.allFieldKeys);
    this.selectedIds = new Set(this.changes.map((c) => c.changeId));
    if (this.mode === "catalog-shopify") {
      for (const change of this.changes) {
        if (change.skip) {
          this.selectedIds.delete(change.changeId);
        }
      }
    }
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
    const selected = this.getVisibleChanges().filter((change) => this.selectedIds.has(change.changeId));
    if (this.mode === "catalog-shopify") {
      return selected.filter((change) => !change.skip);
    }
    return selected;
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
    const visibleChanges = this.getVisibleChanges();
    const colSpan = this.mode === "view" ? 8 : 9;
    this.renderFieldFilters();
    if (visibleChanges.length === 0) {
      const message =
        this.changes.length === 0
          ? "No changes to preview."
          : "No changes match the selected fields.";
      this.body.innerHTML = `<tr class="empty-row"><td colspan="${colSpan}">${message}</td></tr>`;
    } else {
      this.body.innerHTML = visibleChanges.map((change) => this.renderRow(change)).join("");
    }
    this.updateCount();
    this.updateActionButton();
    this.renderComplianceSummary();
    const showSelectionActions = this.mode !== "view";
    if (this.selectAllBtn) {
      this.selectAllBtn.hidden = !showSelectionActions;
    }
    if (this.clearBtn) {
      this.clearBtn.hidden = !showSelectionActions;
    }
  },

  updateCount() {
    if (!this.countEl) {
      return;
    }
    if (this.mode === "view") {
      this.countEl.textContent = `${this.changes.length} change${this.changes.length === 1 ? "" : "s"}`;
      return;
    }
    const visible = this.getVisibleChanges();
    const selectedCount = visible.filter((change) => this.selectedIds.has(change.changeId)).length;
    this.countEl.textContent = `${selectedCount} of ${visible.length} selected`;
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
    const count = this.getSelectedChanges().length;
    if (this.mode === "revert") {
      this.actionBtn.textContent = count > 0 ? `Revert ${count} change${count === 1 ? "" : "s"}` : "Revert changes";
      this.actionBtn.className = "btn btn-danger";
    } else if (this.mode === "catalog-seo") {
      this.actionBtn.textContent =
        count > 0 ? `Apply fixes (${count})` : "Apply fixes";
      this.actionBtn.className = "btn btn-primary";
    } else if (this.mode === "catalog-shopify") {
      this.actionBtn.textContent =
        count > 0 ? `Create on Shopify (${count})` : "Create on Shopify";
      this.actionBtn.className = "btn btn-primary";
    } else {
      this.actionBtn.textContent =
        count > 0 ? `Sync ${count} change${count === 1 ? "" : "s"} to Shopify` : "Sync to Shopify";
      this.actionBtn.className = "btn btn-primary";
    }
    this.actionBtn.disabled = count === 0;
  },

  async runCatalogSeoAction(selected) {
    if (
      !window.confirm(`Apply ${selected.length} SEO fix${selected.length === 1 ? "" : "es"} to catalog products?`)
    ) {
      return;
    }

    EditProUtils.hideMessage(this.messageEl);
    this.clearSyncErrors();
    this.actionBtn.disabled = true;
    this.progressWrap.hidden = false;
    this.progressBar.style.width = "50%";

    try {
      const result = await EditProUtils.apiPost("/api/catalog/fix-seo/apply", { changes: selected });
      this.progressBar.style.width = "100%";
      const failed = result.errors?.length || 0;
      if (failed) {
        EditProUtils.showMessage(
          this.messageEl,
          `Apply finished with ${failed} error${failed === 1 ? "" : "s"}.`,
          "warning"
        );
        this.showSyncErrors(
          (result.errors || []).map((err) => ({
            resourceTitle: err.resourceTitle,
            field: err.field,
            message: err.message,
          }))
        );
      } else {
        EditProUtils.showMessage(this.messageEl, "SEO fixes applied to catalog products.", "success");
        if (typeof this.onComplete === "function") {
          await this.onComplete({ failed: 0, succeeded: result.succeeded || [], count: selected.length });
        }
        setTimeout(() => this.close(), 800);
      }
    } catch (error) {
      EditProUtils.showMessage(this.messageEl, error.message || "Failed to apply SEO fixes.", "error");
    } finally {
      this.progressWrap.hidden = true;
      this.progressBar.style.width = "0%";
      this.actionBtn.disabled = false;
    }
  },

  async runCatalogShopifyAction(selected) {
    if (
      !window.confirm(
        `Create ${selected.length} product${selected.length === 1 ? "" : "s"} on Shopify? Existing handles will be skipped.`
      )
    ) {
      return;
    }

    EditProUtils.hideMessage(this.messageEl);
    this.clearSyncErrors();
    this.actionBtn.disabled = true;
    this.progressWrap.hidden = false;
    this.progressBar.style.width = "0%";

    const productIds = selected.map((change) => change.catalogInput?.productId).filter(Boolean);
    const pollTimer = setInterval(async () => {
      try {
        const status = await EditProUtils.apiGet("/api/catalog/shopify/status");
        if (status?.total > 0) {
          this.progressBar.style.width = `${Math.round((status.done / status.total) * 100)}%`;
        }
      } catch {
        // ignore polling errors
      }
    }, 500);

    try {
      const result = await EditProUtils.apiPost("/api/catalog/shopify/push", { productIds });
      clearInterval(pollTimer);
      this.progressBar.style.width = "100%";
      const failed = result.errors?.length || 0;
      if (failed) {
        EditProUtils.showMessage(
          this.messageEl,
          `Push finished with ${failed} error${failed === 1 ? "" : "s"}.`,
          "warning"
        );
        this.showSyncErrors(
          (result.errors || []).map((err) => ({
            resourceTitle: err.resourceTitle || err.productId,
            field: "Create product",
            message: err.message,
          }))
        );
        if (typeof this.onComplete === "function") {
          await this.onComplete({ failed, succeeded: result.succeeded || [], count: selected.length });
        }
      } else {
        EditProUtils.showMessage(this.messageEl, "Products created on Shopify.", "success");
        if (typeof this.onComplete === "function") {
          await this.onComplete({ failed: 0, succeeded: result.succeeded || [], count: selected.length });
        }
        setTimeout(() => this.close(), 800);
      }
    } catch (error) {
      clearInterval(pollTimer);
      EditProUtils.showMessage(this.messageEl, error.message || "Failed to push to Shopify.", "error");
    } finally {
      this.progressWrap.hidden = true;
      this.progressBar.style.width = "0%";
      this.actionBtn.disabled = false;
    }
  },

  async runAction() {
    const selected = this.getSelectedChanges();
    if (selected.length === 0) {
      return;
    }

    if (this.mode === "catalog-seo") {
      await this.runCatalogSeoAction(selected);
      return;
    }

    if (this.mode === "catalog-shopify") {
      await this.runCatalogShopifyAction(selected);
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
