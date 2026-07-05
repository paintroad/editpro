window.EditProMutations = {
  mergeFileUpdates(changes) {
    const fileMap = new Map();
    const productMap = new Map();
    const collectionMap = new Map();
    const articleMap = new Map();
    const others = [];

    for (const change of changes) {
      if (change.mutation === "fileUpdate") {
        const id = change.fileInput.id;
        if (!fileMap.has(id)) {
          fileMap.set(id, { ...change, fileInput: { ...change.fileInput } });
        } else {
          fileMap.get(id).fileInput = {
            ...fileMap.get(id).fileInput,
            ...change.fileInput,
          };
        }
        continue;
      }

      if (change.mutation === "productUpdate") {
        const key = change.resourceId;
        if (!productMap.has(key)) {
          productMap.set(key, { ...change, input: { ...change.input } });
        } else {
          const existing = productMap.get(key);
          existing.input = { ...existing.input, ...change.input };
          if (existing.input.seo && change.input.seo) {
            existing.input.seo = { ...existing.input.seo, ...change.input.seo };
          }
        }
        continue;
      }

      if (change.mutation === "collectionUpdate") {
        const key = change.resourceId;
        if (!collectionMap.has(key)) {
          collectionMap.set(key, { ...change, input: { ...change.input } });
        } else {
          const existing = collectionMap.get(key);
          existing.input = { ...existing.input, ...change.input };
          if (existing.input.seo && change.input.seo) {
            existing.input.seo = { ...existing.input.seo, ...change.input.seo };
          }
        }
        continue;
      }

      if (change.mutation === "articleUpdate") {
        const key = change.resourceId;
        if (!articleMap.has(key)) {
          articleMap.set(key, { ...change, input: { ...change.input } });
        } else {
          const existing = articleMap.get(key);
          existing.input = { ...existing.input, ...change.input };
          if (existing.input.metafields && change.input.metafields) {
            existing.input.metafields = [
              ...existing.input.metafields,
              ...change.input.metafields,
            ];
          }
        }
        continue;
      }

      others.push(change);
    }

    return [
      ...others,
      ...productMap.values(),
      ...collectionMap.values(),
      ...articleMap.values(),
      ...fileMap.values(),
    ];
  },

  buildRevertChange(change) {
    const revertValue = change.current ?? change.oldValue ?? "";
    const liveValue = change.proposed ?? change.newValue ?? "";

    const reverted = {
      ...change,
      changeId: `revert|${change.changeId || change.resourceId}|${change.field}`,
      current: liveValue,
      proposed: revertValue,
      displayCurrent: liveValue,
      displayProposed: revertValue,
    };

    if (change.mutation === "fileUpdate") {
      reverted.fileInput = { id: change.fileInput.id };
      if (change.field.toLowerCase().includes("alt")) {
        reverted.fileInput.alt = revertValue;
      }
      if (change.field.toLowerCase().includes("filename")) {
        reverted.fileInput.filename = revertValue;
      }
      return reverted;
    }

    if (change.mutation === "productUpdate") {
      reverted.input = change.input
        ? structuredClone(change.input)
        : { id: change.resourceId };
      if (change.field === "SEO title") {
        reverted.input.seo = { ...(reverted.input.seo || {}), title: revertValue };
      } else if (change.field === "SEO description") {
        reverted.input.seo = { ...(reverted.input.seo || {}), description: revertValue };
      } else if (change.field === "Tags") {
        reverted.input.tags = revertValue
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean);
      }
      return reverted;
    }

    if (change.mutation === "collectionUpdate") {
      reverted.input = change.input
        ? structuredClone(change.input)
        : { id: change.resourceId };
      if (change.field === "SEO title") {
        reverted.input.seo = { ...(reverted.input.seo || {}), title: revertValue };
      } else if (change.field === "SEO description") {
        reverted.input.seo = { ...(reverted.input.seo || {}), description: revertValue };
      }
      return reverted;
    }

    if (change.mutation === "articleUpdate" || change.mutation === "articleUpdateTags") {
      reverted.input = { id: change.resourceId };
      if (change.field === "Tags" || change.mutation === "articleUpdateTags") {
        reverted.mutation = "articleUpdateTags";
        reverted.input.tags = revertValue
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean);
      } else if (change.field === "SEO title") {
        reverted.mutation = "articleUpdate";
        reverted.input.metafields = [
          EditProRules.articleSeoMetafield(
            "title_tag",
            revertValue,
            change.seoMetafieldIds?.title
          ),
        ];
      } else if (change.field === "SEO description") {
        reverted.mutation = "articleUpdate";
        reverted.input.metafields = [
          EditProRules.articleSeoMetafield(
            "description_tag",
            revertValue,
            change.seoMetafieldIds?.description
          ),
        ];
      }
      return reverted;
    }

    return reverted;
  },

  buildRevertChanges(changes) {
    return changes.map((c) => this.buildRevertChange(c));
  },

  serializeChange(change) {
    const serialized = {
      changeId: change.changeId,
      resourceType: change.resourceType,
      resourceId: change.resourceId,
      resourceTitle: change.resourceTitle,
      field: change.field,
      oldValue: change.current ?? "",
      newValue: change.proposed ?? "",
      current: change.current ?? "",
      proposed: change.proposed ?? "",
      mutation: change.mutation,
      input: change.input ? structuredClone(change.input) : undefined,
      fileInput: change.fileInput ? structuredClone(change.fileInput) : undefined,
    };

    if (change.mutation === "articleUpdate" && change.input?.metafields) {
      serialized.seoMetafieldIds = {};
      for (const mf of change.input.metafields) {
        if (mf.key === "title_tag" && mf.id) {
          serialized.seoMetafieldIds.title = mf.id;
        }
        if (mf.key === "description_tag" && mf.id) {
          serialized.seoMetafieldIds.description = mf.id;
        }
      }
    }

    return serialized;
  },

  FILE_BATCH_SIZE: 10,
  FILE_CONCURRENCY: 3,
  RESOURCE_CONCURRENCY: 4,

  isThrottleError(message) {
    const m = String(message || "").toLowerCase();
    return (
      m.includes("throttl") ||
      m.includes("rate limit") ||
      m.includes("too many request") ||
      m.includes("exceeded")
    );
  },

  async runMutation(change) {
    if (change.mutation === "fileUpdate") {
      const data = await EditProShopify.graphql(
        `mutation FileUpdate($files: [FileUpdateInput!]!) {
          fileUpdate(files: $files) {
            userErrors { field message }
          }
        }`,
        { files: [change.fileInput] }
      );
      const errors = data.fileUpdate?.userErrors || [];
      if (errors.length) {
        throw new Error(errors.map((e) => e.message).join("; "));
      }
      return;
    }

    if (change.mutation === "productUpdate") {
      const data = await EditProShopify.graphql(
        `mutation ProductUpdate($input: ProductInput!) {
          productUpdate(input: $input) {
            userErrors { field message }
          }
        }`,
        { input: change.input }
      );
      const errors = data.productUpdate?.userErrors || [];
      if (errors.length) {
        throw new Error(errors.map((e) => e.message).join("; "));
      }
      return;
    }

    if (change.mutation === "collectionUpdate") {
      const data = await EditProShopify.graphql(
        `mutation CollectionUpdate($input: CollectionInput!) {
          collectionUpdate(input: $input) {
            userErrors { field message }
          }
        }`,
        { input: change.input }
      );
      const errors = data.collectionUpdate?.userErrors || [];
      if (errors.length) {
        throw new Error(errors.map((e) => e.message).join("; "));
      }
      return;
    }

    if (change.mutation === "articleUpdate" || change.mutation === "articleUpdateTags") {
      const input = { ...change.input };
      const id = input.id;
      delete input.id;
      const data = await EditProShopify.graphql(
        `mutation ArticleUpdate($id: ID!, $article: ArticleUpdateInput!) {
          articleUpdate(id: $id, article: $article) {
            userErrors { field message }
          }
        }`,
        { id, article: input }
      );
      const errors = data.articleUpdate?.userErrors || [];
      if (errors.length) {
        throw new Error(errors.map((e) => e.message).join("; "));
      }
    }
  },

  async runMutationWithRetry(change) {
    try {
      await this.runMutation(change);
    } catch (error) {
      if (this.isThrottleError(error.message)) {
        await EditProUtils.sleep(1000);
        await this.runMutation(change);
        return;
      }
      throw error;
    }
  },

  parseFileErrorIndex(field) {
    if (!Array.isArray(field)) {
      return null;
    }
    const filesIdx = field.indexOf("files");
    if (filesIdx < 0 || field[filesIdx + 1] == null) {
      return null;
    }
    const idx = Number(field[filesIdx + 1]);
    return Number.isNaN(idx) ? null : idx;
  },

  async runFileUpdatesBatch(changes) {
    if (!changes.length) {
      return { errors: [], succeeded: [] };
    }

    const runOnce = async () => {
      const data = await EditProShopify.graphql(
        `mutation FileUpdate($files: [FileUpdateInput!]!) {
          fileUpdate(files: $files) {
            userErrors { field message }
          }
        }`,
        { files: changes.map((c) => c.fileInput) }
      );
      return data.fileUpdate?.userErrors || [];
    };

    let userErrors;
    try {
      userErrors = await runOnce();
    } catch (error) {
      if (this.isThrottleError(error.message)) {
        await EditProUtils.sleep(1000);
        try {
          userErrors = await runOnce();
        } catch (retryError) {
          const message = retryError.message || String(retryError);
          return {
            errors: changes.map((change) => ({
              resourceTitle: change.resourceTitle,
              field: change.field,
              message,
            })),
            succeeded: [],
          };
        }
      } else {
        const message = error.message || String(error);
        return {
          errors: changes.map((change) => ({
            resourceTitle: change.resourceTitle,
            field: change.field,
            message,
          })),
          succeeded: [],
        };
      }
    }

    if (!userErrors.length) {
      return { errors: [], succeeded: changes };
    }

    const messageByIndex = new Map();
    for (const err of userErrors) {
      const idx = this.parseFileErrorIndex(err.field);
      if (idx != null && changes[idx]) {
        const prev = messageByIndex.get(idx);
        messageByIndex.set(idx, prev ? `${prev}; ${err.message}` : err.message);
      }
    }

    if (messageByIndex.size === 0) {
      const message = userErrors.map((e) => e.message).join("; ");
      return {
        errors: changes.map((change) => ({
          resourceTitle: change.resourceTitle,
          field: change.field,
          message,
        })),
        succeeded: [],
      };
    }

    const errors = [];
    const succeeded = [];
    changes.forEach((change, index) => {
      if (messageByIndex.has(index)) {
        errors.push({
          resourceTitle: change.resourceTitle,
          field: change.field,
          message: messageByIndex.get(index),
        });
      } else {
        succeeded.push(change);
      }
    });
    return { errors, succeeded };
  },

  async mapPool(items, concurrency, worker) {
    if (!items.length) {
      return;
    }
    let next = 0;
    const run = async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        await worker(items[index], index);
      }
    };
    const poolSize = Math.min(concurrency, items.length);
    await Promise.all(Array.from({ length: poolSize }, () => run()));
  },

  chunkArray(items, size) {
    const chunks = [];
    for (let i = 0; i < items.length; i += size) {
      chunks.push(items.slice(i, i + size));
    }
    return chunks;
  },

  async runChanges(changes, { onProgress } = {}) {
    const fileChanges = changes.filter((c) => c.mutation === "fileUpdate");
    const otherChanges = changes.filter((c) => c.mutation !== "fileUpdate");
    const fileChunks = this.chunkArray(fileChanges, this.FILE_BATCH_SIZE);
    const totalUnits = otherChanges.length + fileChunks.length;
    let done = 0;
    const errors = [];
    const succeeded = [];

    const tick = () => {
      done += 1;
      onProgress?.(done, Math.max(totalUnits, 1));
    };

    await Promise.all([
      this.mapPool(otherChanges, this.RESOURCE_CONCURRENCY, async (change) => {
        try {
          await this.runMutationWithRetry(change);
          succeeded.push(change);
        } catch (error) {
          errors.push({
            resourceTitle: change.resourceTitle,
            field: change.field,
            message: error.message || String(error),
          });
        }
        tick();
      }),
      this.mapPool(fileChunks, this.FILE_CONCURRENCY, async (chunk) => {
        const result = await this.runFileUpdatesBatch(chunk);
        errors.push(...result.errors);
        succeeded.push(...result.succeeded);
        tick();
      }),
    ]);

    if (totalUnits === 0) {
      onProgress?.(1, 1);
    }

    return { errors, succeeded };
  },
};
