const fs = require("fs");
const path = require("path");
const os = require("os");
const { shopifyGraphql } = require("./shopify-client");
const { getShopifyCredentials } = require("./config-store");
const {
  loadArtistsStore,
  saveArtistsStore,
  getArtist,
  upsertArtist,
  stripImagesFromHtml,
  portraitPathForSlug,
} = require("./artists-store");
const {
  resolveArtistNationality,
  ensureCountryOnShopify,
  getCachedCountry,
} = require("./artists-countries");

const METAOBJECT_TYPE = "artists";
const LINK_REPORT_PATH = path.join(
  os.homedir(),
  ".editpro",
  "artists-link-report.json"
);

function mimeTypeForPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "image/jpeg";
}

/** Convert simple HTML to Shopify rich_text_field JSON (no images). */
function htmlToShopifyRichText(html) {
  const cleaned = stripImagesFromHtml(html);
  if (!cleaned) {
    return JSON.stringify({
      type: "root",
      children: [{ type: "paragraph", children: [{ type: "text", value: "" }] }],
    });
  }

  const children = [];
  const blockRe = /<(p|ul|ol)(\s[^>]*)?>([\s\S]*?)<\/\1>/gi;
  let match;
  let found = false;
  while ((match = blockRe.exec(cleaned)) !== null) {
    found = true;
    const tag = match[1].toLowerCase();
    const inner = match[3];
    if (tag === "p") {
      children.push({
        type: "paragraph",
        children: inlineToRichNodes(inner),
      });
    } else if (tag === "ul" || tag === "ol") {
      const listItems = [];
      const liRe = /<li(\s[^>]*)?>([\s\S]*?)<\/li>/gi;
      let li;
      while ((li = liRe.exec(inner)) !== null) {
        listItems.push({
          type: "list-item",
          children: inlineToRichNodes(li[2]),
        });
      }
      if (listItems.length) {
        children.push({
          type: "list",
          listType: tag === "ol" ? "ordered" : "unordered",
          children: listItems,
        });
      }
    }
  }

  if (!found) {
    const plain = cleaned
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .trim();
    for (const para of plain.split(/\n{2,}/)) {
      const value = para.replace(/\n/g, " ").trim();
      if (!value) continue;
      children.push({
        type: "paragraph",
        children: [{ type: "text", value }],
      });
    }
  }

  if (!children.length) {
    children.push({
      type: "paragraph",
      children: [{ type: "text", value: "" }],
    });
  }

  return JSON.stringify({ type: "root", children });
}

function decodeEntities(text) {
  return String(text || "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function inlineToRichNodes(html) {
  const nodes = [];
  const tokenRe =
    /<(strong|b|em|i)(\s[^>]*)?>([\s\S]*?)<\/\1>|([^<]+)/gi;
  let m;
  while ((m = tokenRe.exec(String(html || ""))) !== null) {
    if (m[1]) {
      const tag = m[1].toLowerCase();
      const value = decodeEntities(m[3].replace(/<[^>]+>/g, "")).trim();
      if (!value) continue;
      const node = { type: "text", value };
      if (tag === "strong" || tag === "b") node.bold = true;
      if (tag === "em" || tag === "i") node.italic = true;
      nodes.push(node);
    } else if (m[4]) {
      const value = decodeEntities(m[4]);
      if (!value) continue;
      nodes.push({ type: "text", value });
    }
  }
  if (!nodes.length) {
    nodes.push({ type: "text", value: decodeEntities(String(html || "").replace(/<[^>]+>/g, "")) });
  }
  return nodes;
}

async function stagedUploadFileResource(storeDomain, accessToken, localPath) {
  const filename = path.basename(localPath);
  const mimeType = mimeTypeForPath(localPath);
  const data = await shopifyGraphql(
    storeDomain,
    accessToken,
    `mutation StagedUploadsCreate($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets { url resourceUrl parameters { name value } }
        userErrors { field message }
      }
    }`,
    {
      input: [
        {
          filename,
          mimeType,
          resource: "FILE",
          httpMethod: "POST",
        },
      ],
    }
  );
  const result = data.stagedUploadsCreate;
  if (result.userErrors?.length) {
    throw new Error(result.userErrors.map((e) => e.message).join("; "));
  }
  const target = result.stagedTargets?.[0];
  if (!target?.url || !target.resourceUrl) {
    throw new Error("Staged upload target missing.");
  }

  const fileBuffer = fs.readFileSync(localPath);
  const form = new FormData();
  for (const param of target.parameters || []) {
    form.append(param.name, param.value);
  }
  form.append("file", new Blob([fileBuffer], { type: mimeType }), filename);
  const uploadResponse = await fetch(target.url, { method: "POST", body: form });
  if (!uploadResponse.ok) {
    const text = await uploadResponse.text().catch(() => "");
    throw new Error(
      `Staged upload failed (${uploadResponse.status}): ${text.slice(0, 200)}`
    );
  }
  return { resourceUrl: target.resourceUrl, filename };
}

async function fileCreate(storeDomain, accessToken, resourceUrl, filename, alt) {
  const data = await shopifyGraphql(
    storeDomain,
    accessToken,
    `mutation FileCreate($files: [FileCreateInput!]!) {
      fileCreate(files: $files) {
        files {
          id
          fileStatus
          ... on MediaImage {
            id
            image { url }
          }
        }
        userErrors { field message code }
      }
    }`,
    {
      files: [
        {
          originalSource: resourceUrl,
          filename,
          contentType: "IMAGE",
          alt: alt || filename,
        },
      ],
    }
  );
  const errors = data.fileCreate?.userErrors || [];
  if (errors.length) {
    throw new Error(errors.map((e) => e.message).join("; "));
  }
  return data.fileCreate?.files?.[0] || null;
}

async function waitForFileReady(storeDomain, accessToken, fileId, attempts = 12) {
  for (let i = 0; i < attempts; i += 1) {
    const data = await shopifyGraphql(
      storeDomain,
      accessToken,
      `query($id: ID!) {
        node(id: $id) {
          ... on File { fileStatus }
          ... on MediaImage { id fileStatus }
        }
      }`,
      { id: fileId }
    );
    const status = data.node?.fileStatus;
    if (status === "READY") return;
    if (status === "FAILED") {
      throw new Error(`Shopify file processing failed for ${fileId}`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function upsertArtistMetaobject(storeDomain, accessToken, artist, fileId) {
  const fields = [
    { key: "name", value: artist.name },
    {
      key: "biography",
      value: htmlToShopifyRichText(artist.biographyHtml || ""),
    },
    { key: "website", value: artist.wikipediaUrl || "" },
    { key: "status", value: "true" },
  ];
  if (fileId) {
    fields.push({ key: "image", value: fileId });
  }
  const countryId = artist.shopifyCountryId || null;
  if (countryId) {
    fields.push({ key: "country", value: countryId });
  }

  const data = await shopifyGraphql(
    storeDomain,
    accessToken,
    `mutation Upsert($handle: MetaobjectHandleInput!, $metaobject: MetaobjectUpsertInput!) {
      metaobjectUpsert(handle: $handle, metaobject: $metaobject) {
        metaobject { id handle }
        userErrors { field message code }
      }
    }`,
    {
      handle: { type: METAOBJECT_TYPE, handle: artist.id },
      metaobject: {
        fields,
        capabilities: { publishable: { status: "ACTIVE" } },
      },
    }
  );

  const errors = data.metaobjectUpsert?.userErrors || [];
  if (errors.length) {
    // Retry without publishable capability if unsupported
    if (errors.some((e) => /capability|publish/i.test(e.message || ""))) {
      const retry = await shopifyGraphql(
        storeDomain,
        accessToken,
        `mutation Upsert($handle: MetaobjectHandleInput!, $metaobject: MetaobjectUpsertInput!) {
          metaobjectUpsert(handle: $handle, metaobject: $metaobject) {
            metaobject { id handle }
            userErrors { field message code }
          }
        }`,
        {
          handle: { type: METAOBJECT_TYPE, handle: artist.id },
          metaobject: { fields },
        }
      );
      const retryErrors = retry.metaobjectUpsert?.userErrors || [];
      if (retryErrors.length) {
        throw new Error(retryErrors.map((e) => e.message).join("; "));
      }
      return retry.metaobjectUpsert.metaobject;
    }
    throw new Error(errors.map((e) => e.message).join("; "));
  }
  return data.metaobjectUpsert.metaobject;
}

async function pushArtistToShopify(artistId) {
  const { storeDomain, accessToken } = getShopifyCredentials();
  const store = loadArtistsStore();
  const artist = getArtist(store, artistId);
  if (!artist) throw new Error(`Artist not found: ${artistId}`);
  if (artist.enrichStatus !== "enriched" && !artist.biographyHtml) {
    throw new Error(`Artist ${artist.name} is not enriched yet.`);
  }

  try {
    if (!Array.isArray(store.countries)) store.countries = [];
    let working = { ...artist };
    try {
      const nationality = await resolveArtistNationality(working);
      working = {
        ...working,
        nationality: nationality.countryName,
        countryIso2: nationality.iso2,
        countryHandle: nationality.countryHandle,
      };
      const country = await ensureCountryOnShopify(store, nationality, {
        apply: true,
      });
      working.shopifyCountryId = country.shopifyMetaobjectId;
    } catch (natErr) {
      console.warn(
        `Country ensure failed for ${artist.id}:`,
        natErr.message || natErr
      );
    }
    // Always attach country GID from cache when missing (avoids untagged nationality on push)
    if (!working.shopifyCountryId && working.countryHandle) {
      const cached = getCachedCountry(store, working.countryHandle);
      if (cached?.shopifyMetaobjectId) {
        working.shopifyCountryId = cached.shopifyMetaobjectId;
      }
    }

    let fileId = working.shopifyImageFileId || null;
    const localImage =
      (working.imageLocalPath && fs.existsSync(working.imageLocalPath)
        ? working.imageLocalPath
        : null) ||
      (fs.existsSync(portraitPathForSlug(working.id))
        ? portraitPathForSlug(working.id)
        : null);

    if (localImage) {
      const staged = await stagedUploadFileResource(
        storeDomain,
        accessToken,
        localImage
      );
      const created = await fileCreate(
        storeDomain,
        accessToken,
        staged.resourceUrl,
        `artist-${working.id}${path.extname(localImage) || ".jpg"}`,
        working.name
      );
      fileId = created?.id || fileId;
      if (fileId) {
        await waitForFileReady(storeDomain, accessToken, fileId);
      }
    }

    const metaobject = await upsertArtistMetaobject(
      storeDomain,
      accessToken,
      working,
      fileId
    );

    const updated = {
      ...working,
      shopifyMetaobjectId: metaobject.id,
      shopifyImageFileId: fileId,
      shopifyStatus: "created",
      pushedAt: new Date().toISOString(),
      error: null,
      imageLocalPath: localImage || working.imageLocalPath,
    };
    upsertArtist(store, updated);
    saveArtistsStore(store);
    return updated;
  } catch (error) {
    const failed = {
      ...artist,
      shopifyStatus: "error",
      error: error.message || String(error),
    };
    upsertArtist(store, failed);
    saveArtistsStore(store);
    throw error;
  }
}

async function pushArtistsToShopify(ids) {
  const results = { ok: [], errors: [] };
  for (const id of ids) {
    try {
      const artist = await pushArtistToShopify(id);
      results.ok.push({
        id,
        name: artist.name,
        metaobjectId: artist.shopifyMetaobjectId,
      });
    } catch (error) {
      results.errors.push({ id, error: error.message || String(error) });
    }
  }
  return { ...results, store: loadArtistsStore() };
}

async function findProductBySkuPrefix(storeDomain, accessToken, skuId) {
  const data = await shopifyGraphql(
    storeDomain,
    accessToken,
    `query ProductBySkuPrefix($query: String!) {
      productVariants(first: 5, query: $query) {
        nodes {
          sku
          product { id title handle }
        }
      }
    }`,
    { query: `sku:${skuId}*` }
  );
  const nodes = data.productVariants?.nodes || [];
  const prefix = `${skuId}-`;
  for (const node of nodes) {
    const sku = String(node?.sku || "");
    if (
      sku === String(skuId) ||
      sku.startsWith(prefix) ||
      sku.startsWith(`${skuId}_`)
    ) {
      return node.product;
    }
  }
  const first = nodes[0];
  if (first?.product?.id && String(first.sku || "").startsWith(String(skuId))) {
    return first.product;
  }
  return null;
}

async function setProductArtist(storeDomain, accessToken, productId, metaobjectId) {
  const data = await shopifyGraphql(
    storeDomain,
    accessToken,
    `mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id }
        userErrors { field message }
      }
    }`,
    {
      metafields: [
        {
          ownerId: productId,
          namespace: "custom",
          key: "artist",
          type: "metaobject_reference",
          value: metaobjectId,
        },
      ],
    }
  );
  const errors = data.metafieldsSet?.userErrors || [];
  if (errors.length) {
    throw new Error(errors.map((e) => e.message).join("; "));
  }
}

async function linkArtistProducts(artistId, options = {}) {
  const { storeDomain, accessToken } = getShopifyCredentials();
  const store = loadArtistsStore();
  const artist = getArtist(store, artistId);
  if (!artist) throw new Error(`Artist not found: ${artistId}`);
  if (!artist.shopifyMetaobjectId) {
    throw new Error(`Artist ${artist.name} is not on Shopify yet.`);
  }

  const productIds = Array.isArray(options.productIds)
    ? options.productIds
    : artist.productIds || [];
  const limit =
    options.limit != null ? Number(options.limit) : productIds.length;
  const targets = productIds.slice(0, Math.max(0, limit));

  const linked = [];
  const missing = [];
  const errors = [];

  for (const productId of targets) {
    try {
      const product = await findProductBySkuPrefix(
        storeDomain,
        accessToken,
        productId
      );
      if (!product?.id) {
        missing.push(productId);
        continue;
      }
      await setProductArtist(
        storeDomain,
        accessToken,
        product.id,
        artist.shopifyMetaobjectId
      );
      linked.push({
        localProductId: productId,
        shopifyProductId: product.id,
        handle: product.handle,
      });
    } catch (error) {
      errors.push({
        localProductId: productId,
        error: error.message || String(error),
      });
    }
    await new Promise((r) => setTimeout(r, 80));
  }

  const updated = {
    ...artist,
    linkedProductCount: linked.length,
    linkedAt: new Date().toISOString(),
  };
  upsertArtist(store, updated);
  saveArtistsStore(store);

  return {
    generatedAt: new Date().toISOString(),
    artistId,
    artistName: artist.name,
    metaobjectId: artist.shopifyMetaobjectId,
    targetCount: targets.length,
    linkedCount: linked.length,
    missingCount: missing.length,
    errorCount: errors.length,
    linked,
    missing,
    errors,
  };
}

async function linkArtistsProducts(ids, options = {}) {
  const results = { reports: [], errors: [] };
  for (const id of ids) {
    try {
      results.reports.push(await linkArtistProducts(id, options));
    } catch (error) {
      results.errors.push({ id, error: error.message || String(error) });
    }
  }

  const cumulative = {
    generatedAt: new Date().toISOString(),
    artistCount: ids.length,
    totals: {
      linked: results.reports.reduce((s, r) => s + (r.linkedCount || 0), 0),
      missing: results.reports.reduce((s, r) => s + (r.missingCount || 0), 0),
      errors: results.reports.reduce((s, r) => s + (r.errorCount || 0), 0),
      artistErrors: results.errors.length,
    },
    byArtist: results.reports.map((r) => ({
      artistId: r.artistId,
      artistName: r.artistName,
      metaobjectId: r.metaobjectId,
      targetCount: r.targetCount,
      linkedCount: r.linkedCount,
      missingCount: r.missingCount,
      errorCount: r.errorCount,
    })),
    reports: results.reports,
    errors: results.errors,
  };
  fs.writeFileSync(LINK_REPORT_PATH, JSON.stringify(cumulative, null, 2), "utf8");

  return { ...results, cumulative, store: loadArtistsStore() };
}

module.exports = {
  htmlToShopifyRichText,
  pushArtistToShopify,
  pushArtistsToShopify,
  linkArtistProducts,
  linkArtistsProducts,
  findProductBySkuPrefix,
  METAOBJECT_TYPE,
  LINK_REPORT_PATH,
};
