(function initShell() {
  const MODULE_KEY = "editpro-module";

  const railModules = document.querySelectorAll(".rail-module[data-module]");
  const seoSharedChrome = document.getElementById("seoSharedChrome");
  const runAuditBtn = document.getElementById("runAuditBtn");
  const applyRulesBtn = document.getElementById("applyRulesBtn");
  const moduleAudit = document.getElementById("module-audit");
  const moduleLocal = document.getElementById("module-local");
  const moduleLive = document.getElementById("module-live");
  const moduleSquare = document.getElementById("module-square");
  const moduleRoommap = document.getElementById("module-roommap");
  const connectionModal = document.getElementById("connectionModal");
  const settingsModal = document.getElementById("settingsModal");

  function activateModule(moduleId) {
    railModules.forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.module === moduleId);
    });
    if (moduleAudit) {
      moduleAudit.hidden = moduleId !== "audit";
    }
    if (moduleLocal) {
      moduleLocal.hidden = moduleId !== "local";
    }
    if (moduleLive) {
      moduleLive.hidden = moduleId !== "live";
    }
    if (moduleSquare) {
      moduleSquare.hidden = moduleId !== "square";
    }
    if (moduleRoommap) {
      moduleRoommap.hidden = moduleId !== "roommap";
    }
    const isSeoModule = moduleId === "audit" || moduleId === "live";
    if (seoSharedChrome) {
      seoSharedChrome.hidden = !isSeoModule;
    }
    if (runAuditBtn) {
      runAuditBtn.hidden = moduleId !== "audit";
    }
    if (applyRulesBtn) {
      applyRulesBtn.hidden = moduleId !== "live";
    }
    try {
      sessionStorage.setItem(MODULE_KEY, moduleId);
    } catch {
      // ignore
    }
    document.dispatchEvent(new CustomEvent("editpro:module-changed", { detail: { moduleId } }));
  }

  railModules.forEach((btn) => {
    btn.addEventListener("click", () => activateModule(btn.dataset.module));
  });

  function openModal(modal) {
    if (!modal) {
      return;
    }
    modal.hidden = false;
    document.body.classList.add("modal-open");
  }

  function closeModal(modal) {
    if (!modal) {
      return;
    }
    modal.hidden = true;
    if (typeof EditProPreviewModal?.resetModalOpenClass === "function") {
      EditProPreviewModal.resetModalOpenClass();
    } else {
      document.body.classList.remove("modal-open");
    }
  }

  function openConnectionModal() {
    openModal(connectionModal);
  }

  function closeConnectionModal() {
    closeModal(connectionModal);
  }

  function openSettingsModal() {
    openModal(settingsModal);
  }

  function closeSettingsModal() {
    closeModal(settingsModal);
  }

  function activateRulesTab(tabId) {
    document.querySelectorAll("[data-rules-tab]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.rulesTab === tabId);
    });
    const panels = {
      product: document.getElementById("rulesPanelProduct"),
      collection: document.getElementById("rulesPanelCollection"),
      article: document.getElementById("rulesPanelArticle"),
    };
    for (const [key, panel] of Object.entries(panels)) {
      if (panel) {
        panel.hidden = key !== tabId;
      }
    }
  }

  function openSeoFilter(tab, ruleKey) {
    activateModule("live");
    if (typeof EditProLiveCatalog?.applyRuleFilter === "function") {
      EditProLiveCatalog.applyRuleFilter(tab, ruleKey);
    }
  }

  document.getElementById("openSettingsBtn")?.addEventListener("click", openSettingsModal);

  document.getElementById("connectionModalClose")?.addEventListener("click", closeConnectionModal);
  connectionModal?.querySelector(".modal-backdrop")?.addEventListener("click", closeConnectionModal);

  document.getElementById("settingsModalClose")?.addEventListener("click", closeSettingsModal);
  settingsModal?.querySelector(".modal-backdrop")?.addEventListener("click", closeSettingsModal);

  document.querySelectorAll("[data-rules-tab]").forEach((btn) => {
    btn.addEventListener("click", () => activateRulesTab(btn.dataset.rulesTab));
  });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") {
      return;
    }
    if (connectionModal && !connectionModal.hidden) {
      closeConnectionModal();
    }
    if (settingsModal && !settingsModal.hidden) {
      closeSettingsModal();
    }
    if (document.getElementById("previewModal")?.hidden === false) {
      EditProPreviewModal.close();
    }
    if (document.getElementById("syncLogModal")?.hidden === false) {
      EditProSyncLog.close();
    }
    if (document.getElementById("imageModal")?.hidden === false) {
      EditProImageModal.close();
    }
    if (document.getElementById("detailModal")?.hidden === false) {
      EditProDetailModal.close();
    }
  });

  window.EditProShell = {
    openSettings: openSettingsModal,
    closeSettings: closeSettingsModal,
    openConnection: openConnectionModal,
    closeConnection: closeConnectionModal,
    openSeoFilter,
    getActiveModule: () => {
      try {
        return sessionStorage.getItem(MODULE_KEY) || "audit";
      } catch {
        return "audit";
      }
    },
  };

  EditProDetailModal.init();
  EditProImageModal.init();
  EditProPreviewModal.init();
  EditProSyncLog.init();
  activateRulesTab("product");

  let initialModule = "audit";
  try {
    initialModule = sessionStorage.getItem(MODULE_KEY) || "audit";
  } catch {
    // ignore
  }
  activateModule(initialModule);
})();
