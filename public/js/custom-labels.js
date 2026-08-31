(function initCustomLabels() {
  const NAMESPACE = "mm-google-shopping";
  const LABEL_KEYS = [
    "custom_label_0",
    "custom_label_1",
    "custom_label_2",
    "custom_label_3",
    "custom_label_4",
  ];
  const METAFIELD_TYPE = "single_line_text_field";
  const PAGE_SIZE = 50;
  const FETCH_PAGE = 25;
  const WRITE_BATCH = 25;

  const state = {
    products: [],
    loaded: false,
    loading: false,
    page: 1,
    search: "",
    filter: "all",
    collectionId: "",
    includeVariants: false,
    selectedProductIds: new Set(),
    selectedVariantIds: new Set(),
    expandedProductIds: new Set(),
  };

  const els = {};

  function $(id) {
    return document.getElementById(id);
  }

  function cacheEls() {
    els.message = $("labelsMessage");
    els.statusMeta = $("labelsStatusMeta");
    els.countBadge = $("labelsProductCountBadge");
    els.refreshBtn = $("labelsRefreshBtn");
    els.includeVariants = $("labelsIncludeVariants");
    els.selectAllVariantsWrap = $("labelsSelectAllVariantsWrap");
    els.selectAllVariants = $("labelsSelectAllVariants");
    els.bulkKey = $("labelsBulkKey");
    els.bulkValue = $("labelsBulkValue");
    els.bulkApplyBtn = $("labelsBulkApplyBtn");
    els.bulkClearBtn = $("labelsBulkClearBtn");
    els.selectionMeta = $("labelsSelectionMeta");
    els.search = $("labelsSearch");
    els.filter = $("labelsFilter");
    els.collectionFilter = $("labelsCollectionFilter");
    els.selectVisible = $("labelsSelectVisible");
    els.pagination = $("labelsPagination");
    els.prevBtn = $("labelsPrevBtn");
    els.nextBtn = $("labelsNextBtn");
    els.pageInfo = $("labelsPageInfo");
    els.empty = $("labelsEmpty");
    els.tbody = $("labelsTableBody");
  }

  function showMessage(text, type = "info") {
    if (!els.message) return;
    els.message.textContent = text || "";
    els.message.classList.toggle("hidden", !text);
    els.message.classList.toggle("error", type === "error");
    els.message.classList.toggle("success", type === "success");
  }

  function emptyLabels() {
    return Object.fromEntries(LABEL_KEYS.map((k) => [k, ""]));
  }

  function labelsFromMetafields(list) {
    const out = emptyLabels();
    const nodes = Array.isArray(list) ? list : list?.nodes || [];
    for (const mf of nodes) {
      if (!mf?.key) continue;
      if (LABEL_KEYS.includes(mf.key)) {
        out[mf.key] = mf.value || "";
      }
    }
    return out;
  }

  function productHasAnyLabel(product) {
    return LABEL_KEYS.some((k) => String(product.labels?.[k] || "").trim());
  }

  function getFilteredProducts() {
    const q = state.search.trim().toLowerCase();
    const collectionId = state.collectionId;
    return state.products.filter((p) => {
      if (state.filter === "has-label" && !productHasAnyLabel(p)) return false;
      if (state.filter === "empty" && productHasAnyLabel(p)) return false;
      if (collectionId) {
        const inColl = (p.collections || []).some((c) => c.id === collectionId);
        if (!inColl) return false;
      }
      if (!q) return true;
      return (
        String(p.title || "").toLowerCase().includes(q) ||
        String(p.handle || "").toLowerCase().includes(q)
      );
    });
  }

  function rebuildCollectionFilterOptions() {
    if (!els.collectionFilter) return;
    const prev = state.collectionId || els.collectionFilter.value || "";
    const byId = new Map();
    for (const product of state.products) {
      for (const c of product.collections || []) {
        if (!c?.id || byId.has(c.id)) continue;
        byId.set(c.id, c.title || c.id);
      }
    }
    const options = Array.from(byId.entries()).sort((a, b) =>
      String(a[1]).localeCompare(String(b[1]), undefined, { sensitivity: "base" })
    );
    const parts = [`<option value="">All collections</option>`];
    for (const [id, title] of options) {
      parts.push(
        `<option value="${EditProUtils.escapeHtml(id)}">${EditProUtils.escapeHtml(title)}</option>`
      );
    }
    els.collectionFilter.innerHTML = parts.join("");
    if (prev && byId.has(prev)) {
      els.collectionFilter.value = prev;
      state.collectionId = prev;
    } else {
      els.collectionFilter.value = "";
      state.collectionId = "";
    }
  }

  function getVisiblePage() {
    const items = getFilteredProducts();
    const total = items.length;
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE) || 1);
    state.page = Math.min(Math.max(1, state.page), totalPages);
    const start = (state.page - 1) * PAGE_SIZE;
    return {
      items: items.slice(start, start + PAGE_SIZE),
      total,
      page: state.page,
      totalPages,
    };
  }

  function readRowLabels(rowEl) {
    const labels = emptyLabels();
    for (const key of LABEL_KEYS) {
      const input = rowEl.querySelector(`input[data-label-key="${key}"]`);
      labels[key] = input ? String(input.value || "") : "";
    }
    return labels;
  }

  function updateSelectionMeta() {
    const pCount = state.selectedProductIds.size;
    const vCount = state.selectedVariantIds.size;
    let text = `${pCount} product${pCount === 1 ? "" : "s"} selected`;
    if (state.includeVariants) {
      text += ` · ${vCount} variant${vCount === 1 ? "" : "s"} selected`;
    }
    if (els.selectionMeta) els.selectionMeta.textContent = text;

    const scope =
      document.querySelector('input[name="labelsScope"]:checked')?.value ||
      "product";
    const canApply =
      scope === "product"
        ? pCount > 0
        : state.includeVariants && vCount > 0;
    const disabled = !canApply || state.loading;
    if (els.bulkApplyBtn) els.bulkApplyBtn.disabled = disabled;
    if (els.bulkClearBtn) els.bulkClearBtn.disabled = disabled;
  }

  function syncIncludeVariantsUi() {
    state.includeVariants = Boolean(els.includeVariants?.checked);
    if (els.selectAllVariantsWrap) {
      els.selectAllVariantsWrap.hidden = !state.includeVariants;
    }
    if (!state.includeVariants) {
      state.selectedVariantIds.clear();
      if (els.selectAllVariants) els.selectAllVariants.checked = false;
    }
    renderTable();
    updateSelectionMeta();
  }

  function selectAllVariantsForSelectedProducts(checked) {
    if (!checked) {
      state.selectedVariantIds.clear();
      renderTable();
      updateSelectionMeta();
      return;
    }
    for (const product of state.products) {
      if (!state.selectedProductIds.has(product.id)) continue;
      for (const variant of product.variants || []) {
        state.selectedVariantIds.add(variant.id);
      }
      state.expandedProductIds.add(product.id);
    }
    renderTable();
    updateSelectionMeta();
  }

  async function fetchAllProducts() {
    const products = [];
    let cursor = null;
    let hasNext = true;
    let page = 0;

    const query = `query LabelsProducts($cursor: String) {
      products(first: ${FETCH_PAGE}, after: $cursor, query: "status:active") {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          title
          handle
          media(first: 1) { nodes { ... on MediaImage { image { url } } } }
          collections(first: 25) { nodes { id title } }
          metafields(first: 10, namespace: "${NAMESPACE}") { nodes { key value } }
          variants(first: 100) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id
              title
              sku
              price
              metafields(first: 10, namespace: "${NAMESPACE}") { nodes { key value } }
            }
          }
        }
      }
    }`;

    while (hasNext) {
      page += 1;
      if (els.statusMeta) {
        els.statusMeta.textContent = `Loading products… page ${page} (${products.length} so far)`;
      }
      const data = await EditProShopify.graphql(query, { cursor });
      const conn = data.products;
      for (const node of conn?.nodes || []) {
        const variants = [];
        for (const v of node.variants?.nodes || []) {
          variants.push({
            id: v.id,
            title: v.title || "",
            sku: v.sku || "",
            price: v.price || "",
            labels: labelsFromMetafields(v.metafields),
          });
        }
        // Paginate remaining variants if needed
        let vHasNext = Boolean(node.variants?.pageInfo?.hasNextPage);
        let vCursor = node.variants?.pageInfo?.endCursor || null;
        while (vHasNext) {
          const more = await EditProShopify.graphql(
            `query MoreVariants($id: ID!, $cursor: String) {
              product(id: $id) {
                variants(first: 100, after: $cursor) {
                  pageInfo { hasNextPage endCursor }
                  nodes {
                    id title sku price
                    metafields(first: 10, namespace: "${NAMESPACE}") { nodes { key value } }
                  }
                }
              }
            }`,
            { id: node.id, cursor: vCursor }
          );
          const vPage = more.product?.variants;
          for (const v of vPage?.nodes || []) {
            variants.push({
              id: v.id,
              title: v.title || "",
              sku: v.sku || "",
              price: v.price || "",
              labels: labelsFromMetafields(v.metafields),
            });
          }
          vHasNext = Boolean(vPage?.pageInfo?.hasNextPage);
          vCursor = vPage?.pageInfo?.endCursor || null;
        }

        products.push({
          id: node.id,
          title: node.title || "",
          handle: node.handle || "",
          imageUrl: EditProUtils.getFirstImageUrl(node, "product"),
          collections: (node.collections?.nodes || []).map((c) => ({
            id: c.id,
            title: c.title || "",
          })),
          labels: labelsFromMetafields(node.metafields),
          variants,
        });
      }
      hasNext = Boolean(conn?.pageInfo?.hasNextPage);
      cursor = conn?.pageInfo?.endCursor || null;
    }

    return products;
  }

  async function refresh() {
    if (state.loading) return;
    state.loading = true;
    showMessage("");
    if (els.refreshBtn) els.refreshBtn.disabled = true;
    try {
      state.products = await fetchAllProducts();
      state.loaded = true;
      state.page = 1;
      state.selectedProductIds.clear();
      state.selectedVariantIds.clear();
      state.expandedProductIds.clear();
      rebuildCollectionFilterOptions();
      if (els.countBadge) {
        els.countBadge.textContent = `${state.products.length} products`;
      }
      if (els.statusMeta) {
        els.statusMeta.textContent = `Loaded ${state.products.length} live products with Google Shopping labels.`;
      }
      renderTable();
      updateSelectionMeta();
      showMessage(`Loaded ${state.products.length} products.`, "success");
    } catch (error) {
      showMessage(error.message || String(error), "error");
      if (els.statusMeta) {
        els.statusMeta.textContent = "Failed to load products.";
      }
    } finally {
      state.loading = false;
      if (els.refreshBtn) els.refreshBtn.disabled = false;
    }
  }

  function labelInputsHtml(labels, ownerType, ownerId) {
    return LABEL_KEYS.map((key, idx) => {
      const val = EditProUtils.escapeHtml(labels?.[key] || "");
      return `<td class="labels-col-input"><input type="text" class="labels-input" data-label-key="${key}" data-owner-type="${ownerType}" data-owner-id="${EditProUtils.escapeHtml(ownerId)}" value="${val}" placeholder="${idx}" title="${key}" /></td>`;
    }).join("");
  }

  function renderTable() {
    if (!els.tbody) return;
    const { items, total, page, totalPages } = getVisiblePage();

    if (els.pagination) {
      els.pagination.hidden = total === 0;
    }
    if (els.pageInfo) {
      els.pageInfo.textContent = total
        ? `Page ${page} / ${totalPages} · ${total} products`
        : "";
    }
    if (els.prevBtn) els.prevBtn.disabled = page <= 1;
    if (els.nextBtn) els.nextBtn.disabled = page >= totalPages;

    if (!state.loaded) {
      els.tbody.innerHTML = "";
      if (els.empty) {
        els.empty.hidden = false;
        els.empty.textContent =
          "Click “Refresh from Shopify” to load live products and labels.";
      }
      if (els.selectVisible) {
        els.selectVisible.checked = false;
        els.selectVisible.indeterminate = false;
      }
      return;
    }

    if (!items.length) {
      els.tbody.innerHTML = "";
      if (els.empty) {
        els.empty.hidden = false;
        els.empty.textContent = "No products match this filter.";
      }
      if (els.selectVisible) {
        els.selectVisible.checked = false;
        els.selectVisible.indeterminate = false;
      }
      return;
    }
    if (els.empty) els.empty.hidden = true;

    const rows = [];
    for (const product of items) {
      const checked = state.selectedProductIds.has(product.id);
      const expanded =
        state.expandedProductIds.has(product.id) ||
        (state.includeVariants && checked);
      const escId = EditProUtils.escapeHtml(product.id);
      rows.push(`
        <tr class="labels-product-row" data-product-id="${escId}">
          <td class="labels-col-check">
            <input type="checkbox" class="labels-product-check" data-product-id="${escId}" ${checked ? "checked" : ""} />
          </td>
          <td class="labels-col-expand">
            <button type="button" class="labels-expand-btn" data-product-id="${escId}" aria-expanded="${expanded}">${expanded ? "▾" : "▸"}</button>
          </td>
          <td class="labels-col-title">
            <div class="labels-product-cell">
              ${
                product.imageUrl
                  ? `<img class="labels-thumb" src="${EditProUtils.escapeHtml(product.imageUrl)}" alt="" loading="lazy" />`
                  : `<span class="labels-thumb labels-thumb--empty"></span>`
              }
              <div class="labels-product-text">
                <strong>${EditProUtils.escapeHtml(product.title)}</strong>
                <div class="meta">${EditProUtils.escapeHtml(product.handle)} · ${(product.variants || []).length} variants</div>
              </div>
            </div>
          </td>
          <td class="labels-col-sku meta">—</td>
          ${labelInputsHtml(product.labels, "product", product.id)}
          <td class="labels-col-save">
            <button type="button" class="btn btn-secondary btn-sm labels-save-btn" data-owner-type="product" data-owner-id="${escId}">Save</button>
          </td>
        </tr>
      `);

      if (expanded) {
        for (const variant of product.variants || []) {
          const vChecked = state.selectedVariantIds.has(variant.id);
          const escVid = EditProUtils.escapeHtml(variant.id);
          rows.push(`
            <tr class="labels-variant-row" data-product-id="${escId}" data-variant-id="${escVid}">
              <td class="labels-col-check">
                ${
                  state.includeVariants
                    ? `<input type="checkbox" class="labels-variant-check" data-variant-id="${escVid}" data-product-id="${escId}" ${vChecked ? "checked" : ""} />`
                    : ""
                }
              </td>
              <td></td>
              <td class="labels-col-title labels-variant-title">${EditProUtils.escapeHtml(variant.title || "Default")}</td>
              <td class="labels-col-sku meta">${EditProUtils.escapeHtml(variant.sku || "")}${variant.price ? ` · ₹${EditProUtils.escapeHtml(variant.price)}` : ""}</td>
              ${labelInputsHtml(variant.labels, "variant", variant.id)}
              <td class="labels-col-save">
                <button type="button" class="btn btn-secondary btn-sm labels-save-btn" data-owner-type="variant" data-owner-id="${escVid}">Save</button>
              </td>
            </tr>
          `);
        }
      }
    }
    els.tbody.innerHTML = rows.join("");

    if (els.selectVisible) {
      const selectedCount = items.filter((p) =>
        state.selectedProductIds.has(p.id)
      ).length;
      const allVisibleSelected =
        items.length > 0 && selectedCount === items.length;
      els.selectVisible.checked = allVisibleSelected;
      els.selectVisible.indeterminate =
        selectedCount > 0 && selectedCount < items.length;
    }
  }

  async function metafieldsSet(entries) {
    if (!entries.length) return 0;
    let written = 0;
    for (let i = 0; i < entries.length; i += WRITE_BATCH) {
      const chunk = entries.slice(i, i + WRITE_BATCH);
      const data = await EditProShopify.graphql(
        `mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) {
            metafields { id namespace key value }
            userErrors { field message }
          }
        }`,
        {
          metafields: chunk.map((e) => ({
            ownerId: e.ownerId,
            namespace: NAMESPACE,
            key: e.key,
            type: METAFIELD_TYPE,
            value: e.value,
          })),
        }
      );
      const errors = data.metafieldsSet?.userErrors || [];
      if (errors.length) {
        throw new Error(errors.map((e) => e.message).join("; "));
      }
      written += data.metafieldsSet?.metafields?.length || 0;
    }
    return written;
  }

  async function metafieldsDelete(entries) {
    if (!entries.length) return 0;
    let deleted = 0;
    for (let i = 0; i < entries.length; i += WRITE_BATCH) {
      const chunk = entries.slice(i, i + WRITE_BATCH);
      const data = await EditProShopify.graphql(
        `mutation MetafieldsDelete($metafields: [MetafieldIdentifierInput!]!) {
          metafieldsDelete(metafields: $metafields) {
            deletedMetafields { key namespace ownerId }
            userErrors { field message }
          }
        }`,
        {
          metafields: chunk.map((e) => ({
            ownerId: e.ownerId,
            namespace: NAMESPACE,
            key: e.key,
          })),
        }
      );
      const errors = data.metafieldsDelete?.userErrors || [];
      if (errors.length) {
        throw new Error(errors.map((e) => e.message).join("; "));
      }
      const rows = data.metafieldsDelete?.deletedMetafields || [];
      deleted += rows.filter(Boolean).length;
    }
    return deleted;
  }

  function resolveBulkOwnerIds(scope) {
    if (scope === "product") {
      return Array.from(state.selectedProductIds);
    }
    if (!state.includeVariants) {
      showMessage("Turn on “Include variants” to edit variant labels.", "error");
      return null;
    }
    return Array.from(state.selectedVariantIds);
  }

  function findOwner(ownerType, ownerId) {
    if (ownerType === "product") {
      return state.products.find((p) => p.id === ownerId) || null;
    }
    for (const product of state.products) {
      const variant = (product.variants || []).find((v) => v.id === ownerId);
      if (variant) return variant;
    }
    return null;
  }

  async function saveOwnerLabels(ownerType, ownerId, labels) {
    const entries = LABEL_KEYS.map((key) => ({
      ownerId,
      key,
      value: String(labels[key] ?? ""),
    }));
    await metafieldsSet(entries);
    const owner = findOwner(ownerType, ownerId);
    if (owner) {
      owner.labels = { ...emptyLabels(), ...labels };
    }
  }

  async function saveRow(btn) {
    const ownerType = btn.dataset.ownerType;
    const ownerId = btn.dataset.ownerId;
    const row = btn.closest("tr");
    if (!row || !ownerType || !ownerId) return;
    const labels = readRowLabels(row);
    btn.disabled = true;
    try {
      await saveOwnerLabels(ownerType, ownerId, labels);
      showMessage(
        `Saved ${ownerType === "product" ? "product" : "variant"} labels.`,
        "success"
      );
    } catch (error) {
      showMessage(error.message || String(error), "error");
    } finally {
      btn.disabled = false;
    }
  }

  async function bulkApply() {
    const scope =
      document.querySelector('input[name="labelsScope"]:checked')?.value ||
      "product";
    const key = els.bulkKey?.value || "custom_label_0";
    const value = String(els.bulkValue?.value ?? "");

    const ownerIds = resolveBulkOwnerIds(scope);
    if (!ownerIds) return;
    if (!ownerIds.length) {
      showMessage("Select at least one target.", "error");
      return;
    }

    if (els.bulkApplyBtn) els.bulkApplyBtn.disabled = true;
    if (els.bulkClearBtn) els.bulkClearBtn.disabled = true;
    showMessage(`Applying ${key} to ${ownerIds.length} ${scope}(s)…`);
    try {
      const entries = ownerIds.map((ownerId) => ({ ownerId, key, value }));
      const written = await metafieldsSet(entries);
      for (const ownerId of ownerIds) {
        const owner = findOwner(scope, ownerId);
        if (owner) {
          owner.labels = { ...(owner.labels || emptyLabels()), [key]: value };
        }
      }
      renderTable();
      showMessage(
        `Updated ${written} metafield(s) on ${ownerIds.length} ${scope}(s).`,
        "success"
      );
    } catch (error) {
      showMessage(error.message || String(error), "error");
    } finally {
      updateSelectionMeta();
    }
  }

  async function bulkClear() {
    const scope =
      document.querySelector('input[name="labelsScope"]:checked')?.value ||
      "product";
    const key = els.bulkKey?.value || "custom_label_0";

    const ownerIds = resolveBulkOwnerIds(scope);
    if (!ownerIds) return;
    if (!ownerIds.length) {
      showMessage("Select at least one target.", "error");
      return;
    }

    const ok = window.confirm(
      `Clear ${key} on ${ownerIds.length} ${scope}(s)? This deletes the metafield on Shopify.`
    );
    if (!ok) return;

    if (els.bulkApplyBtn) els.bulkApplyBtn.disabled = true;
    if (els.bulkClearBtn) els.bulkClearBtn.disabled = true;
    showMessage(`Clearing ${key} on ${ownerIds.length} ${scope}(s)…`);
    try {
      const entries = ownerIds.map((ownerId) => ({ ownerId, key }));
      const deleted = await metafieldsDelete(entries);
      for (const ownerId of ownerIds) {
        const owner = findOwner(scope, ownerId);
        if (owner) {
          owner.labels = { ...(owner.labels || emptyLabels()), [key]: "" };
        }
      }
      renderTable();
      showMessage(
        `Cleared ${key} on ${ownerIds.length} ${scope}(s) (${deleted} metafield(s) deleted).`,
        "success"
      );
    } catch (error) {
      showMessage(error.message || String(error), "error");
    } finally {
      updateSelectionMeta();
    }
  }

  function bindEvents() {
    els.refreshBtn?.addEventListener("click", () => refresh());
    els.search?.addEventListener("input", () => {
      state.search = els.search.value || "";
      state.page = 1;
      renderTable();
    });
    els.filter?.addEventListener("change", () => {
      state.filter = els.filter.value || "all";
      state.page = 1;
      renderTable();
    });
    els.collectionFilter?.addEventListener("change", () => {
      state.collectionId = els.collectionFilter.value || "";
      state.page = 1;
      renderTable();
    });
    els.prevBtn?.addEventListener("click", () => {
      state.page -= 1;
      renderTable();
    });
    els.nextBtn?.addEventListener("click", () => {
      state.page += 1;
      renderTable();
    });
    els.includeVariants?.addEventListener("change", syncIncludeVariantsUi);
    els.selectAllVariants?.addEventListener("change", () => {
      selectAllVariantsForSelectedProducts(Boolean(els.selectAllVariants.checked));
    });
    els.selectVisible?.addEventListener("change", () => {
      const { items } = getVisiblePage();
      const checked = Boolean(els.selectVisible.checked);
      for (const product of items) {
        if (checked) state.selectedProductIds.add(product.id);
        else {
          state.selectedProductIds.delete(product.id);
          for (const v of product.variants || []) {
            state.selectedVariantIds.delete(v.id);
          }
        }
      }
      renderTable();
      updateSelectionMeta();
    });
    document.querySelectorAll('input[name="labelsScope"]').forEach((radio) => {
      radio.addEventListener("change", updateSelectionMeta);
    });
    els.bulkApplyBtn?.addEventListener("click", () => bulkApply());
    els.bulkClearBtn?.addEventListener("click", () => bulkClear());

    els.tbody?.addEventListener("click", (event) => {
      const expandBtn = event.target.closest(".labels-expand-btn");
      if (expandBtn) {
        const id = expandBtn.dataset.productId;
        if (state.expandedProductIds.has(id)) {
          state.expandedProductIds.delete(id);
        } else {
          state.expandedProductIds.add(id);
        }
        renderTable();
        return;
      }
      const saveBtn = event.target.closest(".labels-save-btn");
      if (saveBtn) {
        saveRow(saveBtn);
      }
    });

    els.tbody?.addEventListener("change", (event) => {
      const productCheck = event.target.closest(".labels-product-check");
      if (productCheck) {
        const id = productCheck.dataset.productId;
        if (productCheck.checked) state.selectedProductIds.add(id);
        else {
          state.selectedProductIds.delete(id);
          const product = state.products.find((p) => p.id === id);
          for (const v of product?.variants || []) {
            state.selectedVariantIds.delete(v.id);
          }
        }
        updateSelectionMeta();
        if (state.includeVariants) renderTable();
        return;
      }
      const variantCheck = event.target.closest(".labels-variant-check");
      if (variantCheck) {
        const id = variantCheck.dataset.variantId;
        if (variantCheck.checked) state.selectedVariantIds.add(id);
        else state.selectedVariantIds.delete(id);
        updateSelectionMeta();
      }
    });
  }

  async function onModuleActivated() {
    if (!state.loaded && !state.loading) {
      await refresh();
    } else {
      renderTable();
      updateSelectionMeta();
    }
  }

  function init() {
    cacheEls();
    if (!els.tbody) return;
    bindEvents();
    syncIncludeVariantsUi();
    renderTable();
    updateSelectionMeta();

    document.addEventListener("editpro:module-changed", (event) => {
      if (event.detail?.moduleId === "labels") {
        onModuleActivated();
      }
    });

    try {
      if (sessionStorage.getItem("editpro-module") === "labels") {
        onModuleActivated();
      }
    } catch {
      // ignore
    }
  }

  window.EditProCustomLabels = {
    refresh,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
