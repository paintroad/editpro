(function initSeoAuditModule() {
  const emptyEl = document.getElementById("auditEmpty");
  const dashboardEl = document.getElementById("auditDashboard");
  const siteScoreEl = document.getElementById("auditSiteScore");
  const siteScoreRingEl = document.getElementById("auditSiteScoreRing");
  const productsSection = document.getElementById("auditProducts");
  const collectionsSection = document.getElementById("auditCollections");
  const articlesSection = document.getElementById("auditArticles");
  const runAuditBtn = document.getElementById("runAuditBtn");

  function hasStoreData(storeData) {
    return (
      (storeData?.products?.length || 0) +
        (storeData?.collections?.length || 0) +
        (storeData?.articles?.length || 0) >
      0
    );
  }

  function updateRunAuditBtn(storeData) {
    if (!runAuditBtn) {
      return;
    }
    const data = storeData || window.EditProLive?.getStoreData?.() || {};
    runAuditBtn.disabled =
      !window.EditProSettings?.connected || !hasStoreData(data);
  }

  function renderFailureGrid(tab, failures) {
    return EditProCatalogQuality.ruleKeys()
      .map((key) => {
        const count = failures[key] || 0;
        const label = EditProCatalogQuality.ISSUES[key];
        return `<button type="button" class="audit-failure-btn" data-audit-tab="${EditProUtils.escapeHtml(tab)}" data-audit-rule="${EditProUtils.escapeHtml(key)}" ${count === 0 ? "disabled" : ""}>
          <span class="audit-failure-count">${count}</span>
          <span class="audit-failure-label">${EditProUtils.escapeHtml(label)}</span>
        </button>`;
      })
      .join("");
  }

  function renderWarningGrid(warnings) {
    const items = EditProCatalogQuality.ruleKeys()
      .map((key) => {
        const count = warnings[key] || 0;
        if (!count) {
          return "";
        }
        const label = EditProCatalogQuality.ISSUES[key];
        return `<div class="audit-warning-btn">
          <span class="audit-warning-count">${count}</span>
          <span class="audit-warning-label">${EditProUtils.escapeHtml(label)}</span>
        </div>`;
      })
      .filter(Boolean)
      .join("");
    if (!items) {
      return "";
    }
    return `<p class="meta audit-warnings-heading">Warnings (score not affected)</p>
      <div class="audit-warnings-grid">${items}</div>`;
  }

  function renderCategorySection(sectionEl, title, tab, category) {
    if (!sectionEl) {
      return;
    }
    const scoreClass = EditProCatalogQuality.scoreBadgeClass(category.score);
    const warningsHtml = renderWarningGrid(category.warnings || {});
    sectionEl.innerHTML = `
      <div class="audit-category-header">
        <div>
          <h2>${EditProUtils.escapeHtml(title)}</h2>
          <p class="meta">${category.total} item${category.total === 1 ? "" : "s"} audited</p>
        </div>
        <div class="audit-category-score">
          <span class="score-badge score-badge-lg ${scoreClass}">${category.score}</span>
          <span class="audit-score-suffix">/ 100</span>
        </div>
      </div>
      <p class="meta audit-failures-heading">Non-compliant by rule — click to review in SEO Engine</p>
      <div class="audit-failures-grid">${renderFailureGrid(tab, category.failures)}</div>
      ${warningsHtml}
    `;
  }

  function render() {
    if (!emptyEl || !dashboardEl) {
      return;
    }

    const storeData = window.EditProLive?.getStoreData?.() || {
      products: [],
      collections: [],
      articles: [],
    };

    updateRunAuditBtn(storeData);

    if (!window.EditProSettings?.connected) {
      emptyEl.hidden = false;
      dashboardEl.hidden = true;
      emptyEl.textContent =
        "Connect your store using the button above to run an SEO audit.";
      return;
    }

    if (!hasStoreData(storeData)) {
      emptyEl.hidden = false;
      dashboardEl.hidden = true;
      emptyEl.textContent =
        "No catalog data yet. Use Fetch Products above to load your store.";
      return;
    }

    const summary = EditProCatalogQuality.auditSummary(storeData);
    emptyEl.hidden = true;
    dashboardEl.hidden = false;

    if (siteScoreEl) {
      siteScoreEl.textContent = String(summary.siteScore);
      siteScoreEl.className = `audit-site-score ${EditProCatalogQuality.scoreBadgeClass(summary.siteScore)}`;
    }
    if (siteScoreRingEl) {
      siteScoreRingEl.style.setProperty("--audit-score", String(summary.siteScore));
      siteScoreRingEl.className = `audit-score-ring ${EditProCatalogQuality.scoreBadgeClass(summary.siteScore)}`;
    }

    renderCategorySection(productsSection, "Product score", "products", summary.products);
    renderCategorySection(
      collectionsSection,
      "Collection score",
      "collections",
      summary.collections
    );
    renderCategorySection(articlesSection, "Blogs score", "articles", summary.articles);
  }

  runAuditBtn?.addEventListener("click", () => {
    render();
  });

  dashboardEl?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-audit-tab][data-audit-rule]");
    if (!btn || btn.disabled) {
      return;
    }
    window.EditProShell?.openSeoFilter(btn.dataset.auditTab, btn.dataset.auditRule);
  });

  document.addEventListener("editpro:catalog-updated", render);
  document.addEventListener("editpro:settings-loaded", render);
  document.addEventListener("editpro:module-changed", (e) => {
    if (e.detail?.moduleId === "audit") {
      render();
    }
  });

  window.EditProSeoAudit = { render };
  render();
})();
