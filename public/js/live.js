(function initLiveModule() {
  const storeNameLabel = document.getElementById("storeNameLabel");
  const storeActionBtn = document.getElementById("storeActionBtn");
  const fetchOverlay = document.getElementById("fetchOverlay");
  const fetchOverlayTitle = document.getElementById("fetchOverlayTitle");
  const fetchStopBtn = document.getElementById("fetchStopBtn");
  const applyRulesBtn = document.getElementById("applyRulesBtn");
  const liveMessage = document.getElementById("liveMessage");

  let storeData = { products: [], collections: [], articles: [], blogs: [] };
  let cacheMeta = null;
  let fileUsageIndex = null;
  let syncState = "disconnected";
  let fetchAbortController = null;
  let indexBuildIdle = null;
  let expectedCounts = null;

  function hasStoreData() {
    return (
      (storeData.products?.length || 0) +
        (storeData.collections?.length || 0) +
        (storeData.articles?.length || 0) >
      0
    );
  }

  function applyShopName(shopName) {
    if (!shopName || !window.EditProSettings) {
      return;
    }
    window.EditProSettings.shopName = shopName;
    document.dispatchEvent(
      new CustomEvent("editpro:shop-name-updated", { detail: { shopName } })
    );
  }

  async function refreshShopNameFromShopify() {
    try {
      const shopName = await EditProShopify.refreshShopName();
      applyShopName(shopName);
      return shopName;
    } catch {
      return window.EditProSettings?.shopName || "";
    }
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

  function showFetchOverlay(title = "Fetching store data") {
    if (fetchOverlay) {
      fetchOverlay.hidden = false;
    }
    if (fetchOverlayTitle) {
      fetchOverlayTitle.textContent = title;
    }
  }

  function hideFetchOverlay() {
    if (fetchOverlay) {
      fetchOverlay.hidden = true;
    }
    expectedCounts = null;
  }

  function scheduleIndexBuild() {
    if (indexBuildIdle != null) {
      cancelIdleCallback(indexBuildIdle);
    }
    indexBuildIdle = requestIdleCallback(() => {
      fileUsageIndex = EditProFileUsage.buildIndex(storeData);
      EditProLiveCatalog.setStoreData(storeData, fileUsageIndex);
      indexBuildIdle = null;
    });
  }

  function commitStoreData(partial, options = {}) {
    const {
      partialFetch = false,
      skipCache = false,
      skipIndex = false,
      complete = !partialFetch,
      expectedCounts: counts = null,
    } = options;

    storeData = {
      products: partial.products || [],
      collections: partial.collections || [],
      articles: partial.articles || [],
      blogs: partial.blogs || EditProShopify.extractBlogs(partial.articles || []),
    };

    if (!skipIndex) {
      scheduleIndexBuild();
      EditProLiveCatalog.clearSelection();
      EditProLiveCatalog.setStoreData(storeData, fileUsageIndex);
    } else {
      EditProLiveCatalog.setStoreData(storeData, fileUsageIndex);
    }

    document.dispatchEvent(new CustomEvent("editpro:catalog-updated"));

    if (!skipCache) {
      saveCache({ complete, expectedCounts: counts });
    }

    updateApplyButton();
    syncState = hasStoreData() ? "synced" : "connected";

    if (partialFetch) {
      EditProUtils.showMessage(
        liveMessage,
        "Fetch stopped. Showing data fetched so far — use Refresh Store when ready.",
        "warning"
      );
    }

    if (!skipCache && hasStoreData()) {
      enrichDescriptionsInBackground();
    }
  }

  async function enrichDescriptionsInBackground() {
    if (!window.EditProSettings?.connected) {
      return;
    }

    const productIds = (storeData.products || []).map((p) => p.id);
    const collectionIds = (storeData.collections || []).map((c) => c.id);
    if (!productIds.length && !collectionIds.length) {
      return;
    }

    try {
      const descriptions = await EditProShopify.fetchAllDescriptions(
        productIds,
        collectionIds
      );

      for (const product of storeData.products || []) {
        if (descriptions.products.has(product.id)) {
          product.descriptionHtml = descriptions.products.get(product.id);
        }
      }
      for (const collection of storeData.collections || []) {
        if (descriptions.collections.has(collection.id)) {
          collection.descriptionHtml = descriptions.collections.get(collection.id);
        }
      }

      EditProLiveCatalog.setStoreData(storeData, fileUsageIndex);
      document.dispatchEvent(new CustomEvent("editpro:catalog-updated"));
    } catch {
      // Description filters may be incomplete until next refresh
    }
  }

  function stopFetch() {
    fetchAbortController?.abort();
  }

  function replaceFilenameInUrl(url, filename) {
    if (!url || !filename) {
      return url;
    }
    try {
      const parsed = new URL(url);
      const parts = parsed.pathname.split("/");
      parts[parts.length - 1] = filename;
      parsed.pathname = parts.join("/");
      return parsed.toString();
    } catch {
      return url;
    }
  }

  function applyFileInputToMedia(media, fileInput) {
    if (!media || !fileInput) {
      return;
    }
    if (fileInput.alt != null) {
      media.alt = fileInput.alt;
    }
    if (fileInput.filename && media.image) {
      media.image.url = replaceFilenameInUrl(media.image.url, fileInput.filename);
    }
  }

  function applyFileInputToImage(image, fileInput) {
    if (!image || !fileInput) {
      return;
    }
    if (fileInput.alt != null) {
      image.alt = fileInput.alt;
    }
    if (fileInput.filename && image.url) {
      image.url = replaceFilenameInUrl(image.url, fileInput.filename);
    }
  }

  function applyFileUpdatesLocally(fileInputsById) {
    if (!fileInputsById.size) {
      return;
    }

    for (const product of storeData.products || []) {
      for (const media of product.media?.nodes || []) {
        const fileInput = fileInputsById.get(media.id);
        if (fileInput) {
          applyFileInputToMedia(media, fileInput);
        }
      }
    }

    for (const collection of storeData.collections || []) {
      const fileInput = fileInputsById.get(collection.image?.id);
      if (fileInput) {
        applyFileInputToImage(collection.image, fileInput);
      }
    }

    for (const article of storeData.articles || []) {
      const fileInput = fileInputsById.get(article.image?.id);
      if (fileInput) {
        applyFileInputToImage(article.image, fileInput);
      }
    }
  }

  function applyOptimisticChanges(changes) {
    if (!changes?.length) {
      return;
    }

    const fileInputsById = new Map();

    for (const change of changes) {
      if (change.mutation === "productUpdate") {
        const product = storeData.products?.find((p) => p.id === change.resourceId);
        if (!product) {
          continue;
        }
        if (change.input?.seo) {
          product.seo = { ...(product.seo || {}), ...change.input.seo };
        }
        if (change.input?.tags) {
          product.tags = change.input.tags;
        }
      } else if (change.mutation === "collectionUpdate") {
        const collection = storeData.collections?.find((c) => c.id === change.resourceId);
        if (!collection) {
          continue;
        }
        if (change.input?.seo) {
          collection.seo = { ...(collection.seo || {}), ...change.input.seo };
        }
      } else if (
        change.mutation === "articleUpdate" ||
        change.mutation === "articleUpdateTags"
      ) {
        const article = storeData.articles?.find((a) => a.id === change.resourceId);
        if (!article) {
          continue;
        }
        if (change.input?.tags) {
          article.tags = change.input.tags;
        }
        if (change.input?.metafields) {
          article.seo = { ...(article.seo || {}) };
          for (const mf of change.input.metafields) {
            if (mf.key === "title_tag") {
              article.seo.title = mf.value || "";
              if (mf.id) {
                article.seo.titleMetafieldId = mf.id;
              }
            }
            if (mf.key === "description_tag") {
              article.seo.description = mf.value || "";
              if (mf.id) {
                article.seo.descriptionMetafieldId = mf.id;
              }
            }
          }
        }
      } else if (change.mutation === "fileUpdate" && change.fileInput?.id) {
        const existing = fileInputsById.get(change.fileInput.id) || { id: change.fileInput.id };
        fileInputsById.set(change.fileInput.id, { ...existing, ...change.fileInput });
      }
    }

    applyFileUpdatesLocally(fileInputsById);

    fileUsageIndex = EditProFileUsage.buildIndex(storeData);
    EditProLiveCatalog.setStoreData(storeData, fileUsageIndex);
    saveCache({ complete: cacheMeta?.complete !== false });
    updateApplyButton();
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

  function isAuditModuleActive() {
    return EditProShell?.getActiveModule() === "audit";
  }

  function applyCacheToUi() {
    fileUsageIndex = EditProFileUsage.buildIndex(storeData);
    EditProLiveCatalog.setStoreData(storeData, fileUsageIndex);
    if (hasStoreData()) {
      syncState = "synced";
    }
    updateStoreHeader();
    document.dispatchEvent(new CustomEvent("editpro:catalog-updated"));
  }

  async function loadCache() {
    try {
      const cached = await EditProCatalogCache.load();
      if (cached?.storeData) {
        storeData = cached.storeData;
        cacheMeta = cached.meta || null;
        if (!storeData.blogs) {
          storeData.blogs = EditProShopify.extractBlogs(storeData.articles);
        }
        applyCacheToUi();
        if (window.EditProSettings?.connected) {
          enrichDescriptionsInBackground();
        }
        return;
      }
    } catch {
      // fall through to sessionStorage migration
    }

    try {
      const raw = sessionStorage.getItem("editpro-store-cache");
      if (raw) {
        storeData = JSON.parse(raw);
        cacheMeta = { complete: false };
        if (!storeData.blogs) {
          storeData.blogs = EditProShopify.extractBlogs(storeData.articles);
        }
        applyCacheToUi();
        sessionStorage.removeItem("editpro-store-cache");
        if (window.EditProSettings?.connected) {
          enrichDescriptionsInBackground();
        }
      }
    } catch {
      // ignore
    }
  }

  async function saveCache(meta = {}) {
    const payload = {
      complete: meta.complete !== false,
      expectedCounts: meta.expectedCounts || {
        products: storeData.products?.length || 0,
        collections: storeData.collections?.length || 0,
        articles: storeData.articles?.length || 0,
      },
    };

    if (meta.complete === false) {
      return;
    }

    try {
      await EditProCatalogCache.save(storeData, payload);
      cacheMeta = {
        complete: true,
        fetchedAt: new Date().toISOString(),
        expectedCounts: payload.expectedCounts,
      };
    } catch {
      EditProUtils.showMessage(
        liveMessage,
        "Catalog loaded but could not be saved for offline reload. Use Refresh Store after restarting the browser.",
        "warning"
      );
    }
  }

  function ensureCatalogLoaded() {
    if (!window.EditProSettings?.connected || syncState === "fetching") {
      return;
    }
    if (hasStoreData()) {
      return;
    }
    fetchStore({ silent: true, blocking: true, overlayTitle: "Fetching store data" });
  }

  async function refetchAfterShopifySync() {
    await fetchStore({
      silent: true,
      blocking: true,
      overlayTitle: "Refreshing store data",
    });
  }

  async function fetchStore(options = {}) {
    const { silent = false, blocking = false, overlayTitle = "Fetching store data" } = options;

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

    await refreshShopNameFromShopify();

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
      showFetchOverlay(overlayTitle);
    }

    const partial = { products: [], collections: [], articles: [], blogs: [] };

    function applyIncrementalPage(page) {
      if (page.type === "products") {
        partial.products.push(...page.items);
      } else if (page.type === "collections") {
        partial.collections.push(...page.items);
      } else if (page.type === "articles") {
        partial.articles.push(...page.items);
      }
      partial.blogs = EditProShopify.extractBlogs(partial.articles);
      commitStoreData(partial, { skipCache: true, skipIndex: true });
    }

    try {
      try {
        expectedCounts = await EditProShopify.fetchCatalogCounts();
      } catch {
        expectedCounts = null;
      }

      let catalog;
      try {
        catalog = await EditProShopify.fetchCatalogStream(
          () => {},
          signal,
          applyIncrementalPage
        );
      } catch (streamError) {
        if (signal.aborted || streamError.name === "AbortError") {
          throw streamError;
        }
        catalog = await EditProShopify.fetchCatalogFallback(
          () => {},
          signal,
          applyIncrementalPage
        );
      }

      if (signal.aborted) {
        commitStoreData(partial, { partialFetch: true, skipCache: true });
        return;
      }

      partial.products = catalog.products || [];
      partial.collections = catalog.collections || [];
      partial.articles = catalog.articles || [];
      partial.blogs = catalog.blogs || EditProShopify.extractBlogs(partial.articles);

      if (catalog.warning) {
        if (window.EditProSettings) {
          window.EditProSettings.contentAccess = false;
        }
      } else if (partial.articles.length > 0 && window.EditProSettings) {
        window.EditProSettings.contentAccess = true;
      }

      const counts = expectedCounts || {
        products: partial.products.length,
        collections: partial.collections.length,
        articles: partial.articles.length,
      };

      commitStoreData(partial, {
        complete: catalog.complete !== false,
        expectedCounts: counts,
      });

      if (!silent) {
        if (catalog.warning) {
          EditProUtils.showMessage(
            liveMessage,
            `Store data loaded. ${catalog.warning} Add those scopes in Shopify Admin, then reinstall the app for a new token.`,
            "warning"
          );
        } else {
          EditProUtils.showMessage(liveMessage, "Store data loaded.", "success");
        }
      }
    } catch (error) {
      if (signal.aborted || error.name === "AbortError") {
        if (partial.products.length || partial.collections.length || partial.articles.length) {
          commitStoreData(partial, { partialFetch: true, skipCache: true });
        }
      } else if (!silent) {
        EditProUtils.showMessage(liveMessage, error.message, "error");
      } else if (hasStoreData()) {
        applyCacheToUi();
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

  async function enrichSelectedDescriptions(selection) {
    const productIds = [...selection.productIds];
    const collectionIds = [...selection.collectionIds];
    if (!productIds.length && !collectionIds.length) {
      return;
    }

    const descriptions = await EditProShopify.fetchDescriptionFields(
      productIds,
      collectionIds
    );

    for (const product of storeData.products || []) {
      if (descriptions.products.has(product.id)) {
        product.descriptionHtml = descriptions.products.get(product.id);
      }
    }
    for (const collection of storeData.collections || []) {
      if (descriptions.collections.has(collection.id)) {
        collection.descriptionHtml = descriptions.collections.get(collection.id);
      }
    }
  }

  async function applyRules() {
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

    applyRulesBtn.disabled = true;
    const previousLabel = applyRulesBtn.textContent;
    applyRulesBtn.textContent = "Loading descriptions…";

    try {
      await enrichSelectedDescriptions(selection);
    } catch (error) {
      applyRulesBtn.disabled = false;
      applyRulesBtn.textContent = previousLabel;
      EditProUtils.showMessage(
        liveMessage,
        error.message || "Failed to load product descriptions.",
        "error"
      );
      return;
    }

    applyRulesBtn.textContent = previousLabel;
    updateApplyButton();

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
      onComplete: async ({ succeeded, failed }) => {
        if (succeeded.length) {
          await refetchAfterShopifySync();
        }
        if (failed) {
          EditProUtils.showMessage(
            liveMessage,
            "Some changes synced. Store data is being refreshed.",
            "warning"
          );
        } else if (succeeded.length) {
          EditProUtils.showMessage(liveMessage, "Changes synced. Store data refreshed.", "success");
        }
      },
    });
  }

  function onSettingsUpdate() {
    updateStoreHeader();
  }

  storeActionBtn?.addEventListener("click", () => {
    if (!window.EditProSettings?.connected) {
      window.EditProShell?.openConnection();
    } else {
      fetchStore({ blocking: true });
    }
  });
  fetchStopBtn?.addEventListener("click", stopFetch);
  applyRulesBtn?.addEventListener("click", () => {
    applyRules();
  });

  document.addEventListener("editpro:settings-loaded", () => {
    onSettingsUpdate();
    if (isAuditModuleActive()) {
      ensureCatalogLoaded();
    }
  });
  document.addEventListener("editpro:shop-name-updated", () => updateStoreHeader());
  document.addEventListener("editpro:settings-saved", onSettingsUpdate);
  document.addEventListener("editpro:catalog-updated", updateApplyButton);
  document.addEventListener("editpro:module-changed", (e) => {
    if (e.detail?.moduleId === "audit") {
      ensureCatalogLoaded();
    }
  });

  window.EditProLive = {
    fetchStore,
    stopFetch,
    refetchAfterShopifySync,
    updateStoreHeader,
    applyOptimisticChanges,
    getStoreData: () => storeData,
    hasStoreData,
  };

  async function boot() {
    EditProLiveCatalog.init();
    await loadCache();
    onSettingsUpdate();
    updateApplyButton();
    if (isAuditModuleActive()) {
      ensureCatalogLoaded();
    }
  }

  boot();
})();
