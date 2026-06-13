(function initLiveModule() {
  const storeNameLabel = document.getElementById("storeNameLabel");
  const storeActionBtn = document.getElementById("storeActionBtn");
  const fetchOverlay = document.getElementById("fetchOverlay");
  const fetchOverlayTitle = document.getElementById("fetchOverlayTitle");
  const fetchOverlayStats = document.getElementById("fetchOverlayStats");
  const fetchStopBtn = document.getElementById("fetchStopBtn");
  const applyRulesBtn = document.getElementById("applyRulesBtn");
  const liveMessage = document.getElementById("liveMessage");

  let storeData = { products: [], collections: [], articles: [], blogs: [] };
  let fileUsageIndex = null;
  let syncState = "disconnected";
  let fetchAbortController = null;

  function hasStoreData() {
    return (
      (storeData.products?.length || 0) +
        (storeData.collections?.length || 0) +
        (storeData.articles?.length || 0) >
      0
    );
  }

  function getStoreDisplayName() {
    const settings = window.EditProSettings || {};
    if (settings.shopName) {
      return settings.shopName;
    }
    if (settings.storeDomain) {
      return settings.storeDomain;
    }
    return "No store connected";
  }

  function resolveSyncState() {
    if (!window.EditProSettings?.connected) {
      return "disconnected";
    }
    if (hasStoreData()) {
      return "synced";
    }
    return "connected";
  }

  function updateStoreHeader() {
    if (syncState !== "fetching") {
      syncState = resolveSyncState();
    }

    if (storeNameLabel) {
      storeNameLabel.textContent =
        syncState === "disconnected" ? "No store connected" : getStoreDisplayName();
    }

    if (!storeActionBtn) {
      return;
    }

    storeActionBtn.disabled = syncState === "fetching";

    if (syncState === "disconnected") {
      storeActionBtn.textContent = "Connect Store";
      storeActionBtn.className = "btn btn-secondary btn-sm";
    } else if (syncState === "connected") {
      storeActionBtn.textContent = "Fetch Products";
      storeActionBtn.className = "btn btn-primary btn-sm";
    } else if (syncState === "synced") {
      storeActionBtn.textContent = "Refresh Store";
      storeActionBtn.className = "btn btn-primary btn-sm";
    } else if (syncState === "fetching") {
      storeActionBtn.textContent = "Fetching…";
      storeActionBtn.className = "btn btn-primary btn-sm";
    }
  }

  function showFetchOverlay(phase = "products") {
    if (fetchOverlay) {
      fetchOverlay.hidden = false;
    }
    updateFetchOverlayPhase(phase);
    updateFetchOverlayStats({ products: 0, collections: 0, articles: 0 });
  }

  function hideFetchOverlay() {
    if (fetchOverlay) {
      fetchOverlay.hidden = true;
    }
  }

  function updateFetchOverlayPhase(phase) {
    if (!fetchOverlayTitle) {
      return;
    }
    const labels = {
      products: "Fetching products",
      collections: "Fetching collections",
      articles: "Fetching blogs",
    };
    fetchOverlayTitle.textContent = labels[phase] || "Fetching store data";
  }

  function updateFetchOverlayStats(progress) {
    if (!fetchOverlayStats) {
      return;
    }
    let text = `${progress.products} products · ${progress.collections} collections`;
    if (progress.articles > 0) {
      text += ` · ${progress.articles} blogs`;
    }
    fetchOverlayStats.textContent = text;
  }

  function commitStoreData(partial, { partialFetch = false } = {}) {
    storeData = {
      products: partial.products || [],
      collections: partial.collections || [],
      articles: partial.articles || [],
      blogs: EditProShopify.extractBlogs(partial.articles || []),
    };
    fileUsageIndex = EditProFileUsage.buildIndex(storeData);
    EditProLiveCatalog.clearSelection();
    EditProLiveCatalog.setStoreData(storeData, fileUsageIndex);
    saveCache();
    updateApplyButton();
    syncState = hasStoreData() ? "synced" : "connected";

    if (partialFetch) {
      EditProUtils.showMessage(
        liveMessage,
        "Fetch stopped. Showing data fetched so far — use Refresh Store when ready.",
        "warning"
      );
    }
  }

  function stopFetch() {
    fetchAbortController?.abort();
  }

  function updateApplyButton() {
    if (!applyRulesBtn) {
      return;
    }
    const selected = EditProLiveCatalog.getTotalSelected();
    applyRulesBtn.disabled = selected === 0;
    applyRulesBtn.textContent =
      selected > 0 ? `Apply rules (${selected})` : "Apply rules";
  }

  function loadCache() {
    try {
      const raw = sessionStorage.getItem("editpro-store-cache");
      if (raw) {
        storeData = JSON.parse(raw);
        if (!storeData.blogs) {
          storeData.blogs = EditProShopify.extractBlogs(storeData.articles);
        }
        fileUsageIndex = EditProFileUsage.buildIndex(storeData);
        EditProLiveCatalog.setStoreData(storeData, fileUsageIndex);
        if (hasStoreData()) {
          syncState = "synced";
        }
        updateStoreHeader();
      }
    } catch {
      // ignore
    }
  }

  function saveCache() {
    try {
      sessionStorage.setItem("editpro-store-cache", JSON.stringify(storeData));
    } catch {
      // ignore
    }
  }

  async function fetchStore(options = {}) {
    const { silent = false, blocking = false } = options;

    if (!window.EditProSettings?.connected) {
      if (!silent) {
        EditProUtils.showMessage(
          liveMessage,
          "Connect your store first (click Connect Store).",
          "warning"
        );
        window.EditProShell?.openConnection();
      }
      return;
    }

    if (syncState === "fetching") {
      return;
    }

    if (!silent) {
      EditProUtils.hideMessage(liveMessage);
    }

    fetchAbortController?.abort();
    const controller = new AbortController();
    fetchAbortController = controller;
    const { signal } = controller;

    syncState = "fetching";
    updateStoreHeader();
    if (blocking) {
      showFetchOverlay("products");
    }

    const partial = { products: [], collections: [], articles: [] };
    const progress = { products: 0, collections: 0, articles: 0 };

    function updateProgress() {
      if (blocking) {
        updateFetchOverlayStats(progress);
      }
    }

    try {
      const warnings = [];

      partial.products = await EditProShopify.fetchAllProducts(({ count }) => {
        progress.products = count;
        updateProgress();
      }, signal);
      if (signal.aborted) {
        commitStoreData(partial, { partialFetch: true });
        return;
      }

      if (blocking) {
        updateFetchOverlayPhase("collections");
      }
      partial.collections = await EditProShopify.fetchAllCollections(({ count }) => {
        progress.collections = count;
        updateProgress();
      }, signal);
      if (signal.aborted) {
        commitStoreData(partial, { partialFetch: true });
        return;
      }

      if (blocking) {
        updateFetchOverlayPhase("articles");
      }
      try {
        partial.articles = await EditProShopify.fetchAllArticles(({ count }) => {
          progress.articles = count;
          updateProgress();
        }, signal);
        if (signal.aborted) {
          commitStoreData(partial, { partialFetch: true });
          return;
        }
        window.EditProSettings.contentAccess = true;
      } catch (error) {
        if (signal.aborted) {
          commitStoreData(partial, { partialFetch: true });
          return;
        }
        if (EditProUtils.isAccessDeniedError(error.message)) {
          partial.articles = [];
          window.EditProSettings.contentAccess = false;
          warnings.push(
            "Blog articles were skipped because your API token is missing read_content and write_content scopes."
          );
        } else {
          throw error;
        }
      }

      commitStoreData(partial);
      if (!silent) {
        if (warnings.length) {
          EditProUtils.showMessage(
            liveMessage,
            `Store data loaded. ${warnings.join(" ")} Add those scopes in Shopify Admin, then reinstall the app for a new token.`,
            "warning"
          );
        } else {
          EditProUtils.showMessage(liveMessage, "Store data loaded.", "success");
        }
      }
    } catch (error) {
      if (signal.aborted) {
        commitStoreData(partial, { partialFetch: true });
      } else if (!silent) {
        EditProUtils.showMessage(liveMessage, error.message, "error");
        if (hasStoreData() || partial.products.length || partial.collections.length) {
          commitStoreData(partial);
        }
      }
    } finally {
      if (fetchAbortController === controller) {
        fetchAbortController = null;
      }
      if (syncState === "fetching") {
        syncState = resolveSyncState();
      }
      hideFetchOverlay();
      updateStoreHeader();
    }
  }

  function applyRules() {
    const selection = EditProLiveCatalog.getSelection();
    const totalSelected =
      selection.productIds.size + selection.collectionIds.size + selection.articleIds.size;

    if (totalSelected === 0) {
      EditProUtils.showMessage(
        liveMessage,
        "Select at least one product, collection, or blog article.",
        "warning"
      );
      return;
    }

    const rules = window.EditProSettings?.rules;
    if (!rules) {
      EditProUtils.showMessage(liveMessage, "Save your rules in Settings first.", "warning");
      window.EditProShell?.openSettings();
      return;
    }

    const pendingChanges = EditProRules.buildAllChanges(
      storeData,
      rules,
      window.EditProSettings.shopName || "",
      selection,
      fileUsageIndex
    );

    if (pendingChanges.length === 0) {
      EditProUtils.showMessage(
        liveMessage,
        "No changes would be made with the current rules for the selected resources.",
        "warning"
      );
      return;
    }

    EditProUtils.hideMessage(liveMessage);
    EditProPreviewModal.open({
      title: "Preview changes",
      changes: pendingChanges.map((c) => ({
        ...c,
        displayCurrent: c.current,
        displayProposed: c.proposed,
      })),
      mode: "sync",
      onComplete: async () => {
        await fetchStore({ silent: true, blocking: true });
        EditProUtils.showMessage(liveMessage, "Changes synced. Store data refreshed.", "success");
      },
    });
  }

  function onSettingsUpdate() {
    updateStoreHeader();
  }

  function maybeAutoFetch() {
    if (
      EditProShell?.getActiveModule() === "live" &&
      window.EditProSettings?.connected &&
      syncState !== "fetching"
    ) {
      fetchStore({ silent: true, blocking: true });
    }
  }

  storeActionBtn?.addEventListener("click", () => {
    if (!window.EditProSettings?.connected) {
      window.EditProShell?.openConnection();
    } else {
      fetchStore({ blocking: true });
    }
  });
  fetchStopBtn?.addEventListener("click", stopFetch);
  applyRulesBtn?.addEventListener("click", applyRules);

  document.addEventListener("editpro:settings-loaded", () => {
    onSettingsUpdate();
    maybeAutoFetch();
  });
  document.addEventListener("editpro:settings-saved", onSettingsUpdate);
  document.addEventListener("editpro:catalog-updated", updateApplyButton);
  document.addEventListener("editpro:module-changed", (e) => {
    if (
      e.detail?.moduleId === "live" &&
      window.EditProSettings?.connected &&
      syncState !== "fetching"
    ) {
      fetchStore({ silent: true, blocking: true });
    }
  });

  window.EditProLive = {
    fetchStore,
    stopFetch,
    updateStoreHeader,
    getStoreData: () => storeData,
  };

  EditProLiveCatalog.init();
  loadCache();
  onSettingsUpdate();
  updateApplyButton();
  if (window.EditProSettings && EditProShell?.getActiveModule() === "live") {
    maybeAutoFetch();
  }
})();
