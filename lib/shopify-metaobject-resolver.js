/**
 * Resolve Shopify taxonomy metaobject GIDs by handle / display label.
 */
const KNOWN_WARM_START = {
  "shopify--frame-style": {
    black: "gid://shopify/Metaobject/86961586325",
    "black-frame": "gid://shopify/Metaobject/86961586325",
    white: "gid://shopify/Metaobject/86961717397",
    wooden: "gid://shopify/Metaobject/86961782933",
    "stretched-canvas": "gid://shopify/Metaobject/86961881237",
    "stretched canvas": "gid://shopify/Metaobject/86961881237",
  },
  "shopify--material": {
    "fine-art-paper": "gid://shopify/Metaobject/232725610645",
    "fine art paper": "gid://shopify/Metaobject/232725610645",
    canvas: "gid://shopify/Metaobject/232064745621",
    paper: "gid://shopify/Metaobject/231957266581",
  },
  "shopify--artwork-frame-material": {
    wood: "gid://shopify/Metaobject/86962339989",
    plastic: "gid://shopify/Metaobject/105489498261",
  },
  "shopify--orientation": {
    vertical: "gid://shopify/Metaobject/231957201045",
    portrait: "gid://shopify/Metaobject/231957201045",
    horizontal: "gid://shopify/Metaobject/232725840021",
    landscape: "gid://shopify/Metaobject/232725840021",
    square: "gid://shopify/Metaobject/232725512341",
  },
};

const METAOBJECT_TYPES = {
  frameStyle: "shopify--frame-style",
  material: "shopify--material",
  artworkFrameMaterial: "shopify--artwork-frame-material",
  colorPattern: "shopify--color-pattern",
  theme: "shopify--theme",
  orientation: "shopify--orientation",
};

function normalizeLookupKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[_]+/g, "-")
    .replace(/\s+/g, "-");
}

function normalizeLooseKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
}

function createMetaobjectResolver(shopifyGraphql, storeDomain, accessToken) {
  const cacheByType = new Map();
  const warnings = [];

  async function loadType(type) {
    if (cacheByType.has(type)) {
      return cacheByType.get(type);
    }

    const byKey = new Map();
    const warm = KNOWN_WARM_START[type] || {};
    for (const [key, gid] of Object.entries(warm)) {
      byKey.set(normalizeLookupKey(key), gid);
      byKey.set(normalizeLooseKey(key), gid);
    }

    try {
      let cursor = null;
      let hasNext = true;
      while (hasNext) {
        const data = await shopifyGraphql(
          storeDomain,
          accessToken,
          `query($type: String!, $cursor: String) {
            metaobjects(type: $type, first: 100, after: $cursor) {
              pageInfo { hasNextPage endCursor }
              nodes {
                id
                handle
                displayName
                fields { key value }
              }
            }
          }`,
          { type, cursor }
        );
        const page = data.metaobjects;
        for (const node of page?.nodes || []) {
          const labelField = (node.fields || []).find((f) => f.key === "label")?.value;
          const aliases = [node.handle, node.displayName, labelField].filter(Boolean);
          for (const alias of aliases) {
            byKey.set(normalizeLookupKey(alias), node.id);
            byKey.set(normalizeLooseKey(alias), node.id);
          }
        }
        hasNext = Boolean(page?.pageInfo?.hasNextPage);
        cursor = page?.pageInfo?.endCursor || null;
      }
    } catch (error) {
      warnings.push(`Failed to load metaobjects for ${type}: ${error.message || error}`);
    }

    cacheByType.set(type, byKey);
    return byKey;
  }

  async function resolveId(type, label) {
    if (!label) {
      return null;
    }
    const map = await loadType(type);
    const candidates = [normalizeLookupKey(label), normalizeLooseKey(label)];
    for (const key of candidates) {
      if (map.has(key)) {
        return map.get(key);
      }
    }
    warnings.push(`No metaobject for ${type} / "${label}"`);
    return null;
  }

  async function resolveIds(type, labels) {
    const ids = [];
    const seen = new Set();
    for (const label of labels || []) {
      const id = await resolveId(type, label);
      if (id && !seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
    return ids;
  }

  function getWarnings() {
    return [...warnings];
  }

  function clearWarnings() {
    warnings.length = 0;
  }

  return {
    METAOBJECT_TYPES,
    resolveId,
    resolveIds,
    getWarnings,
    clearWarnings,
  };
}

module.exports = {
  METAOBJECT_TYPES,
  KNOWN_WARM_START,
  createMetaobjectResolver,
  normalizeLookupKey,
};
