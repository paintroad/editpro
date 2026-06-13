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
};
