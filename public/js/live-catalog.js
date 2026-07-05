window.EditProLiveCatalog = {
  PAGE_SIZE: 100,

  init() {
    this.storeData = { products: [], collections: [], articles: [], blogs: [] };
    this.fileUsageIndex = null;
    this.activeTab = "products";
    this.page = { products: 1, collections: 1, articles: 1 };
    this.filters = {
      products: {
        search: "",
        tag: "",
        productType: "",
        collectionId: "",
        sort: "title-asc",
        qualityIssues: new Set(),
      },
      collections: {
        search: "",
        type: "",
        sort: "title-asc",
        qualityIssues: new Set(),
      },
      articles: {
        search: "",
        blogId: "",
        sort: "title-asc",
        qualityIssues: new Set(),
      },
    };
    this.selectedProductIds = new Set();
    this.selectedCollectionIds = new Set();
    this.selectedArticleIds = new Set();
    this.showSelectAllBar = false;
    this.filterSelectAllActive = false;

    this.bindEvents();
    this.render();
  },

  bindEvents() {
    document.querySelectorAll("[data-live-tab]").forEach((btn) => {
      btn.addEventListener("click", () => {
        this.activeTab = btn.dataset.liveTab;
        document.querySelectorAll("[data-live-tab]").forEach((b) => {
          b.classList.toggle("active", b.dataset.liveTab === this.activeTab);
        });
        this.resetSelectAllBarState();
        this.render();
        document.dispatchEvent(new CustomEvent("editpro:catalog-updated"));
      });
    });

    document.getElementById("catalogFilterBar")?.addEventListener("input", (e) => {
      this.handleFilterChange(e.target);
    });
    document.getElementById("catalogFilterBar")?.addEventListener("change", (e) => {
      this.handleFilterChange(e.target);
    });
    document.getElementById("catalogFilterBar")?.addEventListener("click", (e) => {
      const chip = e.target.closest("[data-quality-issue]");
      if (chip) {
        this.toggleQualityIssue(chip.dataset.qualityIssue);
      }
    });

    document.getElementById("clearSelectionBtn")?.addEventListener("click", () => {
      this.clearSelection();
    });

    document.getElementById("catalogPrevBtn")?.addEventListener("click", () => {
      this.page[this.activeTab] = Math.max(1, this.page[this.activeTab] - 1);
      this.renderList();
    });
    document.getElementById("catalogNextBtn")?.addEventListener("click", () => {
      this.page[this.activeTab] += 1;
      this.renderList();
    });

    document.getElementById("catalogSelectAllFilterBtn")?.addEventListener("click", () => {
      this.selectAllForFilter();
    });

    document.getElementById("catalogList")?.addEventListener("change", (e) => {
      if (e.target.id === "selectAllVisibleCheckbox") {
        e.stopPropagation();
        this.selectVisible(e.target.checked);
        return;
      }
      const cb = e.target.closest("[data-select-id]");
      if (!cb) {
        return;
      }
      e.stopPropagation();
      this.toggleSelection(cb.dataset.resourceType, cb.dataset.selectId, cb.checked);
      this.renderList();
      document.dispatchEvent(new CustomEvent("editpro:catalog-updated"));
    });

    document.getElementById("catalogList")?.addEventListener("click", (e) => {
      const expandBtn = e.target.closest("[data-expand-toggle]");
      if (expandBtn) {
        e.stopPropagation();
        const wrap = expandBtn.closest("[data-expand-id]");
        if (!wrap) {
          return;
        }
        const expanded = wrap.dataset.expanded === "true";
        wrap.dataset.expanded = expanded ? "false" : "true";
        wrap.querySelector(".expand-short")?.toggleAttribute("hidden", !expanded);
        wrap.querySelector(".expand-full")?.toggleAttribute("hidden", expanded);
        expandBtn.textContent = expanded ? "Read more" : "Show less";
        const row = expandBtn.closest("tr.catalog-item");
        row?.classList.toggle("catalog-item--expanded", !expanded);
        return;
      }

      const thumb = e.target.closest("[data-image-type]");
      if (thumb) {
        e.stopPropagation();
        const resource = this.findResource(thumb.dataset.imageType, thumb.dataset.imageId);
        if (resource) {
          EditProImageModal.open({ type: thumb.dataset.imageType, resource });
        }
        return;
      }

      if (e.target.closest('input[type="checkbox"]') || e.target.closest(".catalog-item-check")) {
        return;
      }

      const item = e.target.closest("[data-detail-type]");
      if (item) {
        const resource = this.findResource(item.dataset.detailType, item.dataset.detailId);
        if (resource) {
          EditProDetailModal.open({ type: item.dataset.detailType, resource });
        }
      }
    });
  },

  findResource(type, id) {
    if (type === "product") {
      return (this.storeData.products || []).find((p) => p.id === id);
    }
    if (type === "collection") {
      return (this.storeData.collections || []).find((c) => c.id === id);
    }
    return (this.storeData.articles || []).find((a) => a.id === id);
  },

  handleFilterChange(el) {
    const key = el.dataset.filterKey;
    if (!key) {
      return;
    }
    this.filters[this.activeTab][key] = el.value;
    this.page[this.activeTab] = 1;
    this.resetSelectAllBarState();
    this.renderList();
  },

  toggleQualityIssue(issue) {
    const set = this.filters[this.activeTab].qualityIssues;
    if (set.has(issue)) {
      set.delete(issue);
    } else {
      set.add(issue);
    }
    this.page[this.activeTab] = 1;
    this.resetSelectAllBarState();
    this.renderFilterBar();
    this.renderList();
  },

  applyRuleFilter(tab, ruleKey) {
    const validTabs = ["products", "collections", "articles"];
    if (!validTabs.includes(tab)) {
      return;
    }

    this.activeTab = tab;
    document.querySelectorAll("[data-live-tab]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.liveTab === tab);
    });

    for (const tabId of validTabs) {
      this.filters[tabId].qualityIssues = new Set();
    }
    if (ruleKey) {
      this.filters[tab].qualityIssues.add(ruleKey);
    }
    this.page[tab] = 1;
    this.resetSelectAllBarState();
    this.render();
    document.dispatchEvent(new CustomEvent("editpro:catalog-updated"));
  },

  renderScoreBadge(type, item) {
    const score = EditProCatalogQuality.scoreResource(type, item);
    const scoreClass = EditProCatalogQuality.scoreBadgeClass(score);
    return `<span class="score-badge ${scoreClass}">${score}</span>`;
  },

  setStoreData(storeData, fileUsageIndex) {
    this.storeData = storeData;
    this.fileUsageIndex = fileUsageIndex;
    EditProDetailModal.setFileUsageIndex(fileUsageIndex);
    EditProImageModal.setFileUsageIndex(fileUsageIndex);
    this.page = { products: 1, collections: 1, articles: 1 };
    this.updateTabCounts();
    this.render();
  },

  updateTabCounts() {
    const map = {
      tabCountProducts: this.storeData.products?.length || 0,
      tabCountCollections: this.storeData.collections?.length || 0,
      tabCountArticles: this.storeData.articles?.length || 0,
    };
    for (const [id, count] of Object.entries(map)) {
      const el = document.getElementById(id);
      if (el) {
        el.textContent = String(count);
      }
    }
  },

  resetSelection() {
    this.selectedProductIds = new Set();
    this.selectedCollectionIds = new Set();
    this.selectedArticleIds = new Set();
  },

  clearSelection() {
    this.resetSelection();
    this.resetSelectAllBarState();
    this.renderList();
    document.dispatchEvent(new CustomEvent("editpro:catalog-updated"));
  },

  resetSelectAllBarState() {
    this.showSelectAllBar = false;
    this.filterSelectAllActive = false;
  },

  getActiveTabSelectionSet() {
    if (this.activeTab === "products") {
      return this.selectedProductIds;
    }
    if (this.activeTab === "collections") {
      return this.selectedCollectionIds;
    }
    return this.selectedArticleIds;
  },

  clearActiveTabSelection() {
    this.getActiveTabSelectionSet().clear();
    this.resetSelectAllBarState();
  },

  isItemSelected(type, id) {
    if (type === "product") {
      return this.selectedProductIds.has(id);
    }
    if (type === "collection") {
      return this.selectedCollectionIds.has(id);
    }
    return this.selectedArticleIds.has(id);
  },

  getSelection() {
    return {
      productIds: new Set(this.selectedProductIds),
      collectionIds: new Set(this.selectedCollectionIds),
      articleIds: new Set(this.selectedArticleIds),
    };
  },

  getTotalSelected() {
    return (
      this.selectedProductIds.size +
      this.selectedCollectionIds.size +
      this.selectedArticleIds.size
    );
  },

  toggleSelection(type, id, checked) {
    const map = {
      product: this.selectedProductIds,
      collection: this.selectedCollectionIds,
      article: this.selectedArticleIds,
    };
    if (checked) {
      map[type]?.add(id);
    } else {
      map[type]?.delete(id);
      if (this.filterSelectAllActive) {
        this.filterSelectAllActive = false;
        this.showSelectAllBar = false;
      }
    }
  },

  selectAllForFilter() {
    const items = this.getFilteredItems();
    const set = this.getActiveTabSelectionSet();
    for (const item of items) {
      set.add(item.id);
    }
    this.filterSelectAllActive = true;
    this.showSelectAllBar = true;
    this.renderList();
    document.dispatchEvent(new CustomEvent("editpro:catalog-updated"));
  },

  selectVisible(checked) {
    if (!checked) {
      this.clearActiveTabSelection();
      this.renderList();
      document.dispatchEvent(new CustomEvent("editpro:catalog-updated"));
      return;
    }

    const { items } = this.getVisiblePage();
    for (const item of items) {
      this.toggleSelection(item._resourceType, item.id, true);
    }

    const filteredItems = this.getFilteredItems();
    if (filteredItems.length > items.length) {
      this.showSelectAllBar = true;
      this.filterSelectAllActive = false;
    } else {
      this.resetSelectAllBarState();
    }

    this.renderList();
    document.dispatchEvent(new CustomEvent("editpro:catalog-updated"));
  },

  renderQualityChips() {
    const f = this.filters[this.activeTab];
    return EditProCatalogQuality.chipsForTab(this.activeTab)
      .map((key) => {
        const active = f.qualityIssues.has(key) ? " active" : "";
        return `<button type="button" class="filter-chip${active}" data-quality-issue="${EditProUtils.escapeHtml(key)}">${EditProUtils.escapeHtml(EditProCatalogQuality.ISSUES[key])}</button>`;
      })
      .join("");
  },

  renderFilterBar() {
    const bar = document.getElementById("catalogFilterBar");
    if (!bar) {
      return;
    }

    const f = this.filters[this.activeTab];
    let tabFilters = "";

    if (this.activeTab === "products") {
      const tags = EditProUtils.uniqueTags(this.storeData.products);
      const types = EditProUtils.uniqueProductTypes(this.storeData.products);
      const cols = [...(this.storeData.collections || [])].sort((a, b) =>
        a.title.localeCompare(b.title)
      );
      tabFilters = `
        <input type="text" class="filter-search" data-filter-key="search" placeholder="Search…" value="${EditProUtils.escapeHtml(f.search)}" />
        <select data-filter-key="tag">
          <option value="">All tags</option>
          ${tags.map((t) => `<option value="${EditProUtils.escapeHtml(t)}" ${f.tag === t ? "selected" : ""}>${EditProUtils.escapeHtml(t)}</option>`).join("")}
        </select>
        <select data-filter-key="productType">
          <option value="">All types</option>
          ${types.map((t) => `<option value="${EditProUtils.escapeHtml(t)}" ${f.productType === t ? "selected" : ""}>${EditProUtils.escapeHtml(t)}</option>`).join("")}
        </select>
        <select data-filter-key="collectionId">
          <option value="">All collections</option>
          ${cols.map((c) => `<option value="${EditProUtils.escapeHtml(c.id)}" ${f.collectionId === c.id ? "selected" : ""}>${EditProUtils.escapeHtml(c.title)}</option>`).join("")}
        </select>
        <select data-filter-key="sort">
          <option value="title-asc" ${f.sort === "title-asc" ? "selected" : ""}>Title A–Z</option>
          <option value="title-desc" ${f.sort === "title-desc" ? "selected" : ""}>Title Z–A</option>
          <option value="type-asc" ${f.sort === "type-asc" ? "selected" : ""}>Type A–Z</option>
          <option value="tags-asc" ${f.sort === "tags-asc" ? "selected" : ""}>Tags A–Z</option>
        </select>`;
    } else if (this.activeTab === "collections") {
      tabFilters = `
        <input type="text" class="filter-search" data-filter-key="search" placeholder="Search…" value="${EditProUtils.escapeHtml(f.search)}" />
        <select data-filter-key="type">
          <option value="">All types</option>
          <option value="custom" ${f.type === "custom" ? "selected" : ""}>Custom</option>
          <option value="smart" ${f.type === "smart" ? "selected" : ""}>Smart</option>
        </select>
        <select data-filter-key="sort">
          <option value="title-asc" ${f.sort === "title-asc" ? "selected" : ""}>Title A–Z</option>
          <option value="title-desc" ${f.sort === "title-desc" ? "selected" : ""}>Title Z–A</option>
          <option value="type-asc" ${f.sort === "type-asc" ? "selected" : ""}>Type A–Z</option>
          <option value="count-desc" ${f.sort === "count-desc" ? "selected" : ""}>Most products</option>
        </select>`;
    } else {
      const blogs = this.storeData.blogs || [];
      tabFilters = `
        <input type="text" class="filter-search" data-filter-key="search" placeholder="Search…" value="${EditProUtils.escapeHtml(f.search)}" />
        <select data-filter-key="blogId">
          <option value="">All blogs</option>
          ${blogs.map((b) => `<option value="${EditProUtils.escapeHtml(b.id)}" ${f.blogId === b.id ? "selected" : ""}>${EditProUtils.escapeHtml(b.title)}</option>`).join("")}
        </select>
        <select data-filter-key="sort">
          <option value="title-asc" ${f.sort === "title-asc" ? "selected" : ""}>Title A–Z</option>
          <option value="title-desc" ${f.sort === "title-desc" ? "selected" : ""}>Title Z–A</option>
          <option value="blog-asc" ${f.sort === "blog-asc" ? "selected" : ""}>Blog A–Z</option>
        </select>`;
    }

    bar.innerHTML = `${tabFilters}<span class="filter-divider"></span>${this.renderQualityChips()}`;
  },

  filterProducts() {
    const f = this.filters.products;
    return (this.storeData.products || []).filter((p) => {
      if (
        !EditProUtils.matchesSearch(f.search, p.title, p.handle, p.productType, ...(p.tags || []))
      ) {
        return false;
      }
      if (f.tag && !(p.tags || []).includes(f.tag)) {
        return false;
      }
      if (f.productType && p.productType !== f.productType) {
        return false;
      }
      if (f.collectionId) {
        const inColl = (p.collections?.nodes || []).some((c) => c.id === f.collectionId);
        if (!inColl) {
          return false;
        }
      }
      return EditProCatalogQuality.matchesQualityFilter("product", p, f.qualityIssues);
    });
  },

  filterCollections() {
    const f = this.filters.collections;
    return (this.storeData.collections || []).filter((c) => {
      if (!EditProUtils.matchesSearch(f.search, c.title, c.handle)) {
        return false;
      }
      if (f.type && c.collectionType !== f.type) {
        return false;
      }
      return EditProCatalogQuality.matchesQualityFilter("collection", c, f.qualityIssues);
    });
  },

  filterArticles() {
    const f = this.filters.articles;
    return (this.storeData.articles || []).filter((a) => {
      if (!EditProUtils.matchesSearch(f.search, a.title, a.handle, ...(a.tags || []))) {
        return false;
      }
      if (f.blogId && a.blog?.id !== f.blogId) {
        return false;
      }
      return EditProCatalogQuality.matchesQualityFilter("article", a, f.qualityIssues);
    });
  },

  sortItems(items, tab) {
    const f = this.filters[tab];
    const [key, dir] = (f.sort || "title-asc").split("-");
    const direction = dir === "desc" ? "desc" : "asc";

    if (tab === "products") {
      if (key === "type") {
        return EditProUtils.sortByKey(items, (p) => p.productType, direction);
      }
      if (key === "tags") {
        return EditProUtils.sortByKey(items, (p) => (p.tags || []).join(", "), direction);
      }
      return EditProUtils.sortByKey(items, (p) => p.title, direction);
    }
    if (tab === "collections") {
      if (key === "type") {
        return EditProUtils.sortByKey(items, (c) => c.collectionType, direction);
      }
      if (key === "count") {
        return EditProUtils.sortByNumber(items, (c) => c.productCount, direction);
      }
      return EditProUtils.sortByKey(items, (c) => c.title, direction);
    }
    if (key === "blog") {
      return EditProUtils.sortByKey(items, (a) => a.blog?.title || "", direction);
    }
    return EditProUtils.sortByKey(items, (a) => a.title, direction);
  },

  getFilteredItems(tab = this.activeTab) {
    let items = [];
    if (tab === "products") {
      items = this.sortItems(this.filterProducts(), "products").map((p) => ({
        ...p,
        _resourceType: "product",
      }));
    } else if (tab === "collections") {
      items = this.sortItems(this.filterCollections(), "collections").map((c) => ({
        ...c,
        _resourceType: "collection",
      }));
    } else {
      items = this.sortItems(this.filterArticles(), "articles").map((a) => ({
        ...a,
        _resourceType: "article",
      }));
    }
    return items;
  },

  getVisiblePage() {
    const items = this.getFilteredItems();
    const total = items.length;
    const totalPages = Math.max(1, Math.ceil(total / this.PAGE_SIZE));
    const page = Math.min(this.page[this.activeTab], totalPages);
    this.page[this.activeTab] = page;
    const start = (page - 1) * this.PAGE_SIZE;
    return { items: items.slice(start, start + this.PAGE_SIZE), total, page, totalPages };
  },

  renderThumb(type, resource) {
    const url = EditProUtils.getFirstImageUrl(resource, type);
    if (url) {
      return `<button type="button" class="catalog-item-thumb" data-image-type="${EditProUtils.escapeHtml(type)}" data-image-id="${EditProUtils.escapeHtml(resource.id)}" aria-label="View images">
        <img src="${EditProUtils.escapeHtml(url)}" alt="" loading="lazy" />
      </button>`;
    }
    return `<button type="button" class="catalog-item-thumb catalog-item-thumb--empty" data-image-type="${EditProUtils.escapeHtml(type)}" data-image-id="${EditProUtils.escapeHtml(resource.id)}" aria-label="View images">
      <span>No image</span>
    </button>`;
  },

  getImageCount(type, item) {
    if (type === "product") {
      return item.media?.nodes?.length || 0;
    }
    return item.image?.url ? 1 : 0;
  },

  updateSelectAllCheckbox() {
    const cb = document.getElementById("selectAllVisibleCheckbox");
    if (!cb) {
      return;
    }

    const { items } = this.getVisiblePage();
    if (items.length === 0) {
      cb.checked = false;
      cb.indeterminate = false;
      return;
    }

    const filteredItems = this.getFilteredItems();
    const set = this.getActiveTabSelectionSet();
    const allFilteredSelected =
      filteredItems.length > 0 && filteredItems.every((item) => set.has(item.id));

    let selectedCount = 0;
    for (const item of items) {
      if (this.isItemSelected(item._resourceType, item.id)) {
        selectedCount += 1;
      }
    }

    if (this.filterSelectAllActive && allFilteredSelected) {
      cb.checked = true;
      cb.indeterminate = false;
      return;
    }

    cb.checked = selectedCount === items.length;
    cb.indeterminate = selectedCount > 0 && selectedCount < items.length;
  },

  renderSelectAllBar() {
    const bar = document.getElementById("catalogSelectAllBar");
    const text = document.getElementById("catalogSelectAllBarText");
    const btn = document.getElementById("catalogSelectAllFilterBtn");
    if (!bar || !text || !btn) {
      return;
    }

    const filteredItems = this.getFilteredItems();
    const filteredTotal = filteredItems.length;
    const { items: visibleItems } = this.getVisiblePage();

    if (filteredTotal === 0) {
      bar.hidden = true;
      return;
    }

    if (this.filterSelectAllActive) {
      const set = this.getActiveTabSelectionSet();
      const allSelected = filteredItems.every((item) => set.has(item.id));
      if (allSelected) {
        bar.hidden = false;
        text.textContent = `All ${filteredTotal} items for this filter are selected.`;
        btn.hidden = true;
        return;
      }
      this.filterSelectAllActive = false;
    }

    if (!this.showSelectAllBar || filteredTotal <= visibleItems.length) {
      bar.hidden = true;
      return;
    }

    const allVisibleSelected = visibleItems.every((item) =>
      this.isItemSelected(item._resourceType, item.id)
    );
    if (!allVisibleSelected) {
      bar.hidden = true;
      this.showSelectAllBar = false;
      return;
    }

    bar.hidden = false;
    btn.hidden = false;
    text.textContent = `All ${visibleItems.length} items on this page are selected.`;
    btn.textContent = `Select all ${filteredTotal} items for this filter`;
  },

  renderListHeader() {
    if (this.activeTab === "products") {
      return `<thead><tr>
        <th class="col-check"><label class="catalog-item-check"><input type="checkbox" id="selectAllVisibleCheckbox" aria-label="Select all visible" /></label></th>
        <th class="col-image">Image</th>
        <th class="col-title">Product Name</th>
        <th class="col-score">Score</th>
        <th class="col-images">Images</th>
        <th class="col-seo-title">SEO title</th>
        <th class="col-seo">SEO description</th>
        <th class="col-tags">Tags</th>
      </tr></thead>`;
    }
    if (this.activeTab === "collections") {
      return `<thead><tr>
        <th class="col-check"><label class="catalog-item-check"><input type="checkbox" id="selectAllVisibleCheckbox" aria-label="Select all visible" /></label></th>
        <th class="col-image">Image</th>
        <th class="col-title">Collection Name</th>
        <th class="col-score">Score</th>
        <th class="col-images">Images</th>
        <th class="col-seo-title">SEO title</th>
        <th class="col-seo">SEO description</th>
        <th class="col-meta">Details</th>
      </tr></thead>`;
    }
    return `<thead><tr>
      <th class="col-check"><label class="catalog-item-check"><input type="checkbox" id="selectAllVisibleCheckbox" aria-label="Select all visible" /></label></th>
      <th class="col-image">Image</th>
      <th class="col-title">Blog Title</th>
      <th class="col-score">Score</th>
      <th class="col-images">Images</th>
      <th class="col-seo-title">SEO title</th>
      <th class="col-seo">SEO description</th>
      <th class="col-tags">Tags</th>
      <th class="col-meta">Blog</th>
    </tr></thead>`;
  },

  renderCatalogRow(item) {
    const type = item._resourceType;
    const selected =
      type === "product"
        ? this.selectedProductIds.has(item.id)
        : type === "collection"
          ? this.selectedCollectionIds.has(item.id)
          : this.selectedArticleIds.has(item.id);
    const seoTitle = item.seo?.title || "—";
    const seoDesc = item.seo?.description || "—";
    const tagsText = (item.tags || []).join(", ") || "—";
    const imageCount = this.getImageCount(type, item);
    const tagsCell =
      type !== "collection"
        ? `<td class="col-tags">${EditProUtils.renderExpandableText(tagsText, 60, `${item.id}-tags`)}</td>`
        : "";
    let metaCell = "";

    if (type === "collection") {
      const details = `${item.collectionType || "custom"} · ${item.productCount ?? 0} products`;
      metaCell = `<td class="col-meta meta">${EditProUtils.escapeHtml(details)}</td>`;
    } else if (type === "article") {
      metaCell = `<td class="col-meta meta">${EditProUtils.escapeHtml(item.blog?.title || "—")}</td>`;
    }

    return `<tr class="catalog-item${selected ? " catalog-item--selected" : ""}" data-detail-type="${EditProUtils.escapeHtml(type)}" data-detail-id="${EditProUtils.escapeHtml(item.id)}" role="button" tabindex="0">
      <td class="col-check">
        <label class="catalog-item-check">
          <input type="checkbox" data-select-id="${EditProUtils.escapeHtml(item.id)}" data-resource-type="${EditProUtils.escapeHtml(type)}" ${selected ? "checked" : ""} />
        </label>
      </td>
      <td class="col-image">${this.renderThumb(type, item)}</td>
      <td class="col-title">${EditProUtils.escapeHtml(item.title)}</td>
      <td class="col-score">${this.renderScoreBadge(type, item)}</td>
      <td class="col-images">${imageCount}</td>
      <td class="col-seo-title">${EditProUtils.truncateCell(seoTitle, 40)}</td>
      <td class="col-seo">${EditProUtils.truncateCell(seoDesc, 80)}</td>
      ${tagsCell}
      ${metaCell}
    </tr>`;
  },

  renderList() {
    const list = document.getElementById("catalogList");
    if (!list) {
      return;
    }

    const hasData =
      (this.storeData.products?.length || 0) +
        (this.storeData.collections?.length || 0) +
        (this.storeData.articles?.length || 0) >
      0;

    if (!hasData) {
      list.innerHTML =
        '<div class="catalog-empty">Fetch your store to browse products, collections, and blog articles.</div>';
      this.updatePagination(0, 1, 1);
      this.renderSelectAllBar();
      return;
    }

    const { items, total, page, totalPages } = this.getVisiblePage();

    if (items.length === 0) {
      list.innerHTML = '<div class="catalog-empty">No items match your filters.</div>';
    } else {
      list.innerHTML = `<table class="catalog-table" data-tab="${this.activeTab}">
        ${this.renderListHeader()}
        <tbody>${items.map((item) => this.renderCatalogRow(item)).join("")}</tbody>
      </table>`;
    }

    this.updatePagination(total, page, totalPages);
    this.updateSelectAllCheckbox();
    this.renderSelectAllBar();
  },

  render() {
    this.renderFilterBar();
    this.renderList();
  },

  updatePagination(total, page, totalPages) {
    const pagination = document.getElementById("catalogPagination");
    const info = document.getElementById("catalogPageInfo");
    const prev = document.getElementById("catalogPrevBtn");
    const next = document.getElementById("catalogNextBtn");

    if (total === 0) {
      if (pagination) {
        pagination.hidden = true;
      }
      if (info) {
        info.textContent = "";
      }
      if (prev) {
        prev.disabled = true;
      }
      if (next) {
        next.disabled = true;
      }
      return;
    }

    if (pagination) {
      pagination.hidden = false;
    }
    if (info) {
      info.textContent = `${(page - 1) * this.PAGE_SIZE + 1}–${Math.min(page * this.PAGE_SIZE, total)} of ${total}`;
    }
    if (prev) {
      prev.disabled = page <= 1;
    }
    if (next) {
      next.disabled = page >= totalPages;
    }
  },
};
