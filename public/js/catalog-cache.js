window.EditProCatalogCache = {
  DB_NAME: "editpro-catalog",
  DB_VERSION: 1,
  STORE_NAME: "catalog",
  CACHE_KEY: "current",

  open() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.DB_NAME, this.DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(this.STORE_NAME)) {
          db.createObjectStore(this.STORE_NAME);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  },

  slimStoreData(storeData) {
    const slimProducts = (storeData.products || []).map((product) => {
      const { descriptionHtml, ...rest } = product;
      return rest;
    });
    const slimCollections = (storeData.collections || []).map((collection) => {
      const { descriptionHtml, ...rest } = collection;
      return rest;
    });
    return {
      products: slimProducts,
      collections: slimCollections,
      articles: storeData.articles || [],
      blogs: storeData.blogs || [],
    };
  },

  async save(storeData, meta = {}) {
    const db = await this.open();
    const payload = {
      storeData: this.slimStoreData(storeData),
      meta: {
        complete: meta.complete !== false,
        fetchedAt: meta.fetchedAt || new Date().toISOString(),
        expectedCounts: meta.expectedCounts || {
          products: storeData.products?.length || 0,
          collections: storeData.collections?.length || 0,
          articles: storeData.articles?.length || 0,
        },
      },
    };
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.STORE_NAME, "readwrite");
      tx.objectStore(this.STORE_NAME).put(payload, this.CACHE_KEY);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  },

  async load() {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.STORE_NAME, "readonly");
      const request = tx.objectStore(this.STORE_NAME).get(this.CACHE_KEY);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  },

  async clear() {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.STORE_NAME, "readwrite");
      tx.objectStore(this.STORE_NAME).delete(this.CACHE_KEY);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  },
};
