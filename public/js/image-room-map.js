window.EditProImageRoomMap = {
  mappings: {},
  loaded: false,

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

  getRoom(fileId) {
    return this.mappings[fileId]?.room || "";
  },

  getSummary(storeData) {
    const images = this.enumerateCatalogImages(storeData);
    const rows = images.map((img) => ({
      ...img,
      room: this.getRoom(img.fileId),
      mapped: Boolean(this.mappings[img.fileId]),
    }));
    const mapped = rows.filter((r) => r.mapped).length;
    const total = rows.length;
    return {
      total,
      mapped,
      unmapped: total - mapped,
      complete: total > 0 && mapped === total,
      rows,
    };
  },

  async fetchSummary(storeData) {
    const data = await EditProUtils.apiPost("/api/image-room-map/summary", { storeData });
    if (data.rows) {
      for (const row of data.rows) {
        if (row.mapped && row.room) {
          this.mappings[row.fileId] = { ...row, room: row.room };
        }
      }
    }
    return data;
  },

  async scanUnmapped(storeData, onProgress) {
    await this.loadMappings();
    const images = this.enumerateCatalogImages(storeData);
    const unmapped = images.filter((img) => !this.mappings[img.fileId]);
    if (!unmapped.length) {
      return { mapped: 0, skipped: images.length };
    }

    const response = await fetch(EditProUtils.apiUrl("/api/image-room-map/scan"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ images }),
    });

    const contentType = response.headers.get("content-type") || "";
    if (!response.ok) {
      let message = `Room mapping failed (${response.status}).`;
      try {
        const data = await response.json();
        message = data.error || message;
      } catch {
        // ignore
      }
      throw new Error(message);
    }

    if (!contentType.includes("application/x-ndjson")) {
      throw new Error("Unexpected scan response — restart the EditPro server.");
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("Streaming not supported in this browser.");
    }

    const decoder = new TextDecoder();
    let buffer = "";
    let result = { mapped: 0, skipped: 0 };

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }
        const message = JSON.parse(line);
        if (message.event === "progress") {
          if (message.fileId && message.room) {
            this.mappings[message.fileId] = { fileId: message.fileId, room: message.room };
          }
          onProgress?.(message);
        } else if (message.event === "done") {
          result = { mapped: message.mapped || 0, skipped: message.skipped || 0 };
        } else if (message.event === "error") {
          throw new Error(message.error || "Room mapping failed.");
        }
      }
    }

    await this.loadMappings();
    return result;
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
  document.addEventListener("editpro:settings-loaded", refresh);
  document.addEventListener("DOMContentLoaded", refresh);
})();
