window.EditProFileUsage = {
  buildIndex(storeData) {
    const byFileId = new Map();
    const byUrl = new Map();

    const addRef = (key, ref, urlKey) => {
      if (!key) {
        return;
      }
      if (!byFileId.has(key)) {
        byFileId.set(key, []);
      }
      const list = byFileId.get(key);
      if (!list.some((r) => r.type === ref.type && r.id === ref.id)) {
        list.push(ref);
      }
      if (urlKey) {
        if (!byUrl.has(urlKey)) {
          byUrl.set(urlKey, []);
        }
        const urlList = byUrl.get(urlKey);
        if (!urlList.some((r) => r.type === ref.type && r.id === ref.id)) {
          urlList.push(ref);
        }
      }
    };

    for (const product of storeData.products || []) {
      (product.media?.nodes || []).forEach((image, index) => {
        const fileId = image?.id;
        const url = image?.image?.url;
        if (!fileId) {
          return;
        }
        addRef(
          fileId,
          { type: "product", id: product.id, title: product.title, detail: `Image ${index + 1}` },
          url ? EditProUtils.filenameFromUrl(url) : null
        );
      });
    }

    for (const collection of storeData.collections || []) {
      if (!collection.image?.url && !collection.image?.id) {
        continue;
      }
      const ref = { type: "collection", id: collection.id, title: collection.title, detail: "Featured image" };
      if (collection.image.id) {
        addRef(collection.image.id, ref, collection.image.url);
      }
      if (collection.image.url) {
        const urlKey = collection.image.url.split("?")[0];
        if (!byUrl.has(urlKey)) {
          byUrl.set(urlKey, []);
        }
        if (!byUrl.get(urlKey).some((r) => r.id === collection.id)) {
          byUrl.get(urlKey).push(ref);
        }
      }
    }

    for (const article of storeData.articles || []) {
      if (!article.image?.url && !article.image?.id) {
        continue;
      }
      const ref = {
        type: "article",
        id: article.id,
        title: article.title,
        detail: article.blog?.title ? `Blog: ${article.blog.title}` : "Featured image",
      };
      if (article.image.id) {
        addRef(article.image.id, ref, article.image.url);
      }
      if (article.image.url) {
        const urlKey = article.image.url.split("?")[0];
        if (!byUrl.has(urlKey)) {
          byUrl.set(urlKey, []);
        }
        if (!byUrl.get(urlKey).some((r) => r.id === article.id)) {
          byUrl.get(urlKey).push(ref);
        }
      }
    }

    return { byFileId, byUrl };
  },

  getUsage(index, fileId, url) {
    if (!index) {
      return [];
    }
    if (fileId && index.byFileId.has(fileId)) {
      return [...index.byFileId.get(fileId)];
    }
    if (url) {
      const urlKey = url.split("?")[0];
      return index.byUrl.get(urlKey) ? [...index.byUrl.get(urlKey)] : [];
    }
    return [];
  },

  formatUsage(refs) {
    if (!refs?.length) {
      return "—";
    }
    return refs
      .map((r) => {
        const label = r.type.charAt(0).toUpperCase() + r.type.slice(1);
        return r.detail ? `${label}: ${r.title} (${r.detail})` : `${label}: ${r.title}`;
      })
      .join("; ");
  },

  isShared(refs) {
    return (refs?.length || 0) > 1;
  },
};
