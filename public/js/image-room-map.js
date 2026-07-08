window.EditProImageRoomMap = {
  mappings: {},
  loaded: false,
  pollTimer: null,
  lastStatus: null,

  canonicalKey(img) {
    const handle = img.handle || img.resourceHandle || "";
    if (!handle) {
      return null;
    }
    if (img.resourceType === "product") {
      return `product:${handle}:${img.imageIndex}`;
    }
    return `${img.resourceType}:${handle}:1`;
  },

  fallbackGidKey(img) {
    if (!img.resourceId) {
      return null;
    }
    return `${img.resourceType}:${img.resourceId}:${img.imageIndex}`;
  },

  lookupKeys(img) {
    const keys = [];
    const primary = this.canonicalKey(img);
    if (primary) {
      keys.push(primary);
    }
    const gidKey = this.fallbackGidKey(img);
    if (gidKey && gidKey !== primary) {
      keys.push(gidKey);
    }
    if (img.fileId) {
      keys.push(img.fileId);
    }
    return keys;
  },

  findMappingEntry(img) {
    const keys = this.lookupKeys(img);
    for (const key of keys) {
      if (this.mappings[key]) {
        return { key, entry: this.mappings[key] };
      }
    }
    return null;
  },

  imageFromResource(resource, resourceType, imageIndex = 1) {
    const image =
      resourceType === "product"
        ? resource.media?.nodes?.[imageIndex - 1]
        : resource.image;
    return {
      fileId: image?.id || "",
      handle: resource.handle || "",
      resourceType,
      resourceId: resource.id || "",
      resourceTitle: resource.title || "",
      imageIndex,
      url: image?.image?.url || image?.url || "",
    };
  },

  isPortraitProductImage(img) {
    return img.resourceType === "product" && img.imageIndex === 1;
  },

  isNoneRoom(room) {
    const normalized = String(room || "").trim().toLowerCase();
    return !normalized || normalized === "none" || normalized === "null" || normalized === "other";
  },

  enumerateCatalogImages(storeData) {
    const images = [];
    for (const product of storeData?.products || []) {
      (product.media?.nodes || []).forEach((node, index) => {
        const fileId = node?.id;
        const url = node?.image?.url || node?.url || "";
        if (!fileId || !url) {
          return;
        }
        images.push({
          fileId,
          handle: product.handle || "",
          resourceType: "product",
          resourceId: product.id,
          resourceTitle: product.title || "",
          imageIndex: index + 1,
          url,
          alt: node.alt || "",
        });
      });
    }
    for (const collection of storeData?.collections || []) {
      const img = collection.image;
      const fileId = img?.id;
      const url = img?.url || "";
      if (fileId && url) {
        images.push({
          fileId,
          handle: collection.handle || "",
          resourceType: "collection",
          resourceId: collection.id,
          resourceTitle: collection.title || "",
          imageIndex: 1,
          url,
          alt: img.alt || "",
        });
      }
    }
    for (const article of storeData?.articles || []) {
      const img = article.image;
      const fileId = img?.id;
      const url = img?.url || "";
      if (fileId && url) {
        images.push({
          fileId,
          handle: article.handle || "",
          resourceType: "article",
          resourceId: article.id,
          resourceTitle: article.title || "",
          imageIndex: 1,
          url,
          alt: img.alt || "",
        });
      }
    }
    return images;
  },

  async loadMappings() {
    const data = await EditProUtils.apiGet("/api/image-room-map");
    this.mappings = data.mappings || {};
    this.loaded = true;
    return this.mappings;
  },

  async reconcile(storeData) {
    const data = await EditProUtils.apiPost("/api/image-room-map/reconcile", {
      storeData: storeData || {},
    });
    if (data.mappings) {
      this.mappings = data.mappings;
    } else {
      await this.loadMappings();
    }
    return data;
  },

  getRoomForImage(img) {
    return this.findMappingEntry(img)?.entry?.room || "";
  },

  getRoomForResource(resource, resourceType, imageIndex = 1) {
    return this.getRoomForImage(this.imageFromResource(resource, resourceType, imageIndex));
  },

  getRoom(fileId) {
    if (!fileId) {
      return "";
    }
    if (this.mappings[fileId]?.room) {
      return this.mappings[fileId].room;
    }
    for (const entry of Object.values(this.mappings)) {
      if (entry.fileId === fileId) {
        return entry.room || "";
      }
    }
    return "";
  },

  hasMappingForImage(img) {
    return Boolean(this.findMappingEntry(img));
  },

  getSummary(storeData) {
    const images = this.enumerateCatalogImages(storeData);
    const portraits = images.filter((img) => this.isPortraitProductImage(img)).length;
    const lifestyleImages = images.filter((img) => !this.isPortraitProductImage(img));
    const rows = lifestyleImages.map((img) => {
      const room = this.getRoomForImage(img);
      const hasMapping = this.hasMappingForImage(img);
      const mapped = hasMapping && !this.isNoneRoom(room);
      return {
        ...img,
        room,
        mapped,
        hasMapping,
      };
    });
    const lifestyleMapped = rows.filter((r) => r.mapped).length;
    const scannable = lifestyleImages.length;
    const unmapped = scannable - lifestyleMapped;
    return {
      total: images.length,
      portraits,
      scannable,
      lifestyleMapped,
      mapped: portraits + lifestyleMapped,
      unmapped,
      complete: scannable > 0 ? unmapped === 0 : portraits > 0,
      rows,
    };
  },

  isJobActive(status) {
    return status?.state === "running" || status?.state === "paused";
  },

  async getScanStatus() {
    return EditProUtils.apiGet("/api/image-room-map/scan/status");
  },

  async startBackgroundScan() {
    const status = await EditProUtils.apiPost("/api/image-room-map/scan/start", {});
    this.lastStatus = status;
    return status;
  },

  async stopBackgroundScan() {
    const status = await EditProUtils.apiPost("/api/image-room-map/scan/stop", {});
    this.lastStatus = status;
    return status;
  },

  stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  },

  applyStatusToMappings(status) {
    if (!status?.lastFileId || !status?.lastRoom) {
      return;
    }
    for (const key of Object.keys(this.mappings)) {
      if (this.mappings[key]?.fileId === status.lastFileId) {
        this.mappings[key] = {
          ...this.mappings[key],
          room: status.lastRoom,
        };
        return;
      }
    }
    this.mappings[status.lastFileId] = {
      fileId: status.lastFileId,
      room: status.lastRoom,
    };
  },

  startPolling(onUpdate, intervalMs = 2000) {
    this.stopPolling();
    let syncCounter = 0;
    this.pollTimer = setInterval(async () => {
      try {
        const status = await this.getScanStatus();
        this.lastStatus = status;
        this.applyStatusToMappings(status);
        syncCounter += 1;
        if (syncCounter % 5 === 0 || !this.isJobActive(status)) {
          await this.loadMappings();
        }
        onUpdate?.(status);
        if (!this.isJobActive(status) && status.state !== "idle") {
          this.stopPolling();
        }
      } catch {
        // ignore transient poll errors
      }
    }, intervalMs);
  },

  roomToTitleCase(room) {
    return String(room || "")
      .split(" ")
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
  },
};

(function initImageRoomMapLoader() {
  async function refresh() {
    try {
      await EditProImageRoomMap.loadMappings();
    } catch {
      // ignore until server ready
    }
  }

  async function reconcileFromCatalog() {
    const storeData = window.EditProLive?.getStoreData?.();
    if (!storeData?.products?.length && !storeData?.collections?.length) {
      return;
    }
    try {
      await EditProImageRoomMap.reconcile(storeData);
    } catch {
      // ignore until server ready
    }
  }

  document.addEventListener("editpro:settings-loaded", refresh);
  document.addEventListener("editpro:catalog-updated", reconcileFromCatalog);
  document.addEventListener("DOMContentLoaded", refresh);
})();
