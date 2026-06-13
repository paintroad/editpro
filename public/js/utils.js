window.EditProUtils = {
  escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  },

  getBasePath() {
    const base = document.querySelector("base");
    if (!base?.href) {
      return "";
    }
    return new URL(base.href).pathname.replace(/\/$/, "");
  },

  apiUrl(url) {
    if (!url.startsWith("/")) {
      return url;
    }
    return `${this.getBasePath()}${url}`;
  },

  async apiGet(url) {
    const response = await fetch(this.apiUrl(url));
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Request failed.");
    }
    return data;
  },

  async apiPost(url, body, options = {}) {
    const response = await fetch(this.apiUrl(url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: options.signal,
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Request failed.");
    }
    return data;
  },

  async apiPatch(url, body) {
    const response = await fetch(this.apiUrl(url), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Request failed.");
    }
    return data;
  },

  showMessage(el, text, type = "error") {
    if (!el) {
      return;
    }
    el.textContent = text;
    el.classList.remove("error", "success", "warning", "hidden");
    el.classList.add(type);
  },

  hideMessage(el) {
    if (!el) {
      return;
    }
    el.textContent = "";
    el.classList.remove("error", "success", "warning");
    el.classList.add("hidden");
  },

  stripHtml(html) {
    const tmp = document.createElement("div");
    tmp.innerHTML = html || "";
    return (tmp.textContent || tmp.innerText || "").trim();
  },

  truncate(text, max = 160) {
    const value = String(text || "").trim();
    if (value.length <= max) {
      return value;
    }
    return `${value.slice(0, max - 1)}…`;
  },

  truncateCell(text, max = 40) {
    const value = String(text || "").trim() || "—";
    return `<span class="cell-ellipsis" title="${this.escapeHtml(value)}">${this.escapeHtml(this.truncate(value, max))}</span>`;
  },

  renderExpandableText(text, maxLen, key) {
    const value = String(text || "").trim() || "—";
    if (value === "—" || value.length <= maxLen) {
      return `<span class="expand-text">${this.escapeHtml(value)}</span>`;
    }
    const short = this.escapeHtml(value.slice(0, maxLen));
    const full = this.escapeHtml(value);
    return `<span class="expand-text" data-expand-id="${this.escapeHtml(key)}">
      <span class="expand-short">${short}…</span>
      <span class="expand-full" hidden>${full}</span>
      <button type="button" class="btn-expand" data-expand-toggle="${this.escapeHtml(key)}">Read more</button>
    </span>`;
  },

  getFirstImageUrl(resource, type) {
    if (type === "product") {
      const node = resource.media?.nodes?.[0];
      return node?.image?.url || node?.url || "";
    }
    return resource.image?.url || "";
  },

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  },

  filenameFromUrl(url) {
    if (!url) {
      return "";
    }
    try {
      const pathname = new URL(url).pathname;
      const segment = pathname.split("/").filter(Boolean).pop() || "";
      return decodeURIComponent(segment);
    } catch {
      const segment = String(url).split("?")[0].split("/").pop() || "";
      return decodeURIComponent(segment);
    }
  },

  isAccessDeniedError(message) {
    return /access denied/i.test(String(message || ""));
  },

  matchesSearch(query, ...fields) {
    const q = String(query || "").trim().toLowerCase();
    if (!q) {
      return true;
    }
    return fields.some((f) => String(f ?? "").toLowerCase().includes(q));
  },

  sortByKey(items, getter, direction = "asc") {
    const sorted = [...items].sort((a, b) => {
      const av = String(getter(a) ?? "").toLowerCase();
      const bv = String(getter(b) ?? "").toLowerCase();
      if (av < bv) {
        return direction === "asc" ? -1 : 1;
      }
      if (av > bv) {
        return direction === "asc" ? 1 : -1;
      }
      return 0;
    });
    return sorted;
  },

  sortByNumber(items, getter, direction = "asc") {
    const sorted = [...items].sort((a, b) => {
      const av = Number(getter(a)) || 0;
      const bv = Number(getter(b)) || 0;
      return direction === "asc" ? av - bv : bv - av;
    });
    return sorted;
  },

  uniqueTags(products) {
    const tags = new Set();
    for (const product of products || []) {
      for (const tag of product.tags || []) {
        tags.add(tag);
      }
    }
    return [...tags].sort((a, b) => a.localeCompare(b));
  },

  uniqueProductTypes(products) {
    const types = new Set();
    for (const product of products || []) {
      if (product.productType) {
        types.add(product.productType);
      }
    }
    return [...types].sort((a, b) => a.localeCompare(b));
  },
};
