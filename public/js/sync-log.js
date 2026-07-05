window.EditProSyncLog = {
  entries: [],

  init() {
    this.modal = document.getElementById("syncLogModal");
    this.listEl = document.getElementById("syncLogList");
    document.getElementById("syncLogModalClose")?.addEventListener("click", () => this.close());
    this.modal?.querySelector(".modal-backdrop")?.addEventListener("click", () => this.close());
    document.getElementById("openSyncLogBtn")?.addEventListener("click", () => this.open());

    this.listEl?.addEventListener("click", (e) => {
      const previewBtn = e.target.closest("[data-log-preview]");
      const revertBtn = e.target.closest("[data-log-revert]");
      if (previewBtn) {
        this.openEntryPreview(previewBtn.dataset.logPreview, "view");
      }
      if (revertBtn) {
        this.openEntryPreview(revertBtn.dataset.logRevert, "revert");
      }
    });

    this.load();
  },

  async load() {
    try {
      const data = await EditProUtils.apiGet("/api/sync-log");
      this.entries = data.entries || [];
    } catch {
      this.entries = [];
    }
  },

  open() {
    if (!this.modal) {
      return;
    }
    const dropdown = document.getElementById("userMenuDropdown");
    if (dropdown) {
      dropdown.hidden = true;
    }
    this.load().then(() => this.renderList());
    this.modal.hidden = false;
    document.body.classList.add("modal-open");
  },

  close() {
    if (!this.modal) {
      return;
    }
    this.modal.hidden = true;
    EditProPreviewModal.resetModalOpenClass();
  },

  formatTimestamp(iso) {
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return iso;
    }
  },

  statusLabel(entry) {
    if (entry.status === "reverted") {
      return "Reverted";
    }
    if (entry.status === "partial") {
      return "Partial";
    }
    return "Synced";
  },

  renderList() {
    if (!this.listEl) {
      return;
    }

    if (this.entries.length === 0) {
      this.listEl.innerHTML = '<p class="meta log-empty">No sync history yet. Apply rules and sync changes to build a log.</p>';
      return;
    }

    this.listEl.innerHTML = this.entries
      .map((entry) => {
        const statusClass =
          entry.status === "reverted"
            ? "badge-muted"
            : entry.status === "partial"
              ? "badge-warning"
              : "badge-success";
        const canRevert = entry.status === "synced" || entry.status === "partial";
        return `<div class="sync-log-entry" data-log-id="${EditProUtils.escapeHtml(entry.id)}">
          <div class="sync-log-entry-head">
            <div>
              <strong>${EditProUtils.escapeHtml(this.formatTimestamp(entry.timestamp))}</strong>
              <span class="badge ${statusClass}">${EditProUtils.escapeHtml(this.statusLabel(entry))}</span>
            </div>
            <div class="sync-log-entry-actions">
              <button type="button" class="btn btn-secondary btn-sm" data-log-preview="${EditProUtils.escapeHtml(entry.id)}">View details</button>
              ${canRevert ? `<button type="button" class="btn btn-danger btn-sm" data-log-revert="${EditProUtils.escapeHtml(entry.id)}">Revert</button>` : ""}
            </div>
          </div>
          <p class="meta sync-log-summary">${EditProUtils.escapeHtml(entry.summary || `${entry.changeCount} change${entry.changeCount === 1 ? "" : "s"}`)}</p>
          <div class="sync-log-fields">
            ${(entry.changes || [])
              .slice(0, 4)
              .map(
                (c) =>
                  `<div class="sync-log-field-row"><span class="sync-log-field-name">${EditProUtils.escapeHtml(c.resourceTitle)} · ${EditProUtils.escapeHtml(c.field)}</span><span class="sync-log-field-values">${EditProUtils.escapeHtml(EditProUtils.truncate(c.oldValue || "—", 40))} → ${EditProUtils.escapeHtml(EditProUtils.truncate(c.newValue || "—", 40))}</span></div>`
              )
              .join("")}
            ${(entry.changes || []).length > 4 ? `<p class="meta">+ ${entry.changes.length - 4} more…</p>` : ""}
          </div>
        </div>`;
      })
      .join("");
  },

  entryToPreviewChanges(entry, mode) {
    return (entry.changes || []).map((c) => {
      const base = {
        changeId: c.changeId || `${c.resourceId}|${c.field}`,
        resourceType: c.resourceType,
        resourceId: c.resourceId,
        resourceTitle: c.resourceTitle,
        field: c.field,
        mutation: c.mutation,
        input: c.input,
        fileInput: c.fileInput,
        seoMetafieldIds: c.seoMetafieldIds,
        current: c.oldValue ?? c.current ?? "",
        proposed: c.newValue ?? c.proposed ?? "",
        oldValue: c.oldValue ?? c.current ?? "",
        newValue: c.newValue ?? c.proposed ?? "",
      };
      if (mode === "revert") {
        return EditProMutations.buildRevertChange(base);
      }
      return {
        ...base,
        displayCurrent: base.current,
        displayProposed: base.proposed,
      };
    });
  },

  openEntryPreview(entryId, mode) {
    const entry = this.entries.find((e) => e.id === entryId);
    if (!entry) {
      return;
    }

    const changes = this.entryToPreviewChanges(entry, mode);
    this.close();

    EditProPreviewModal.open({
      title: mode === "revert" ? `Revert sync · ${this.formatTimestamp(entry.timestamp)}` : `Sync details · ${this.formatTimestamp(entry.timestamp)}`,
      changes,
      mode: mode === "revert" ? "revert" : "view",
      logEntryId: mode === "revert" ? entryId : null,
      onComplete: async () => {
        await this.load();
        this.renderList();
        if (window.EditProLive?.refetchAfterShopifySync) {
          await EditProLive.refetchAfterShopifySync();
        }
      },
    });
  },

  async recordSync(changes) {
    const serialized = changes.map((c) => EditProMutations.serializeChange(c));
    const resourceIds = new Set(serialized.map((c) => c.resourceId));
    const summary = `${serialized.length} change${serialized.length === 1 ? "" : "s"} across ${resourceIds.size} resource${resourceIds.size === 1 ? "" : "s"}`;

    try {
      const data = await EditProUtils.apiPost("/api/sync-log", {
        status: "synced",
        changeCount: serialized.length,
        resourceCount: resourceIds.size,
        summary,
        changes: serialized,
      });
      if (data.entry) {
        this.entries.unshift(data.entry);
      } else {
        await this.load();
      }
    } catch {
      await this.load();
    }
  },

  async markReverted(entryId, revertedCount) {
    const entry = this.entries.find((e) => e.id === entryId);
    const total = entry?.changes?.length || 0;
    const status = revertedCount >= total ? "reverted" : "partial";

    try {
      const data = await EditProUtils.apiPatch(`/api/sync-log/${entryId}`, {
        status,
        revertedAt: new Date().toISOString(),
        revertedCount,
      });
      if (data.entry) {
        const idx = this.entries.findIndex((e) => e.id === entryId);
        if (idx >= 0) {
          this.entries[idx] = data.entry;
        }
      }
    } catch {
      await this.load();
    }
  },
};
