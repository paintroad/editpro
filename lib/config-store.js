const fs = require("fs");
const path = require("path");
const os = require("os");
const { DEFAULT_DESCRIPTION_PHRASES } = require("./default-description-phrases");
const { DEFAULT_ROOM_FALLBACKS } = require("./default-room-fallbacks");
const { DEFAULT_CATALOG_PATH, DEFAULT_CATALOG_BUILDER_PATH } = require("./catalog-paths");

const CONFIG_DIR = path.join(os.homedir(), ".editpro");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

const DEFAULT_RULES = {
  product: {
    imageFilename: "{{handle}}-{{image.index}}",
    imageAlt: "{{title}} {{productType}}",
    seoTitle: "{{title}}",
    seoDescription: "{{description}}",
    tags: "{{tags}}",
    newTags: "",
  },
  collection: {
    imageFilename: "{{handle}}",
    imageAlt: "{{title}}",
    seoTitle: "{{title}}",
    seoDescription: "{{description}}",
  },
  article: {
    imageFilename: "{{handle}}",
    imageAlt: "{{title}}",
    seoTitle: "{{title}}",
    seoDescription: "{{description}}",
    tags: "{{tags}}",
    newTags: "",
  },
};

function mergeRules(raw, base) {
  const merged = structuredClone(base);
  for (const type of Object.keys(DEFAULT_RULES)) {
    merged[type] = { ...merged[type], ...(raw?.[type] || {}) };
  }
  return merged;
}

const DEFAULT_ROOM_DETECTION = {
  openaiModel: "gpt-4o",
  openaiDetail: "low",
  openaiConcurrency: 8,
  scanDelayMs: 0,
  imageMaxWidth: 512,
  maxCacheMb: 500,
  saveBatchSize: 5,
  memoryMinFreeMb: 1500,
  memoryResumeMinFreeMb: 2500,
  nodeHeapMaxMb: 512,
  pauseDurationMs: 120000,
  requestTimeoutMs: 90000,
};

function defaultConfig() {
  return {
    shopify: {
      storeDomain: "",
      accessToken: "",
    },
    rules: structuredClone(DEFAULT_RULES),
    descriptionPhrases: [...DEFAULT_DESCRIPTION_PHRASES],
    roomFallbacks: [...DEFAULT_ROOM_FALLBACKS],
    roomDetection: { ...DEFAULT_ROOM_DETECTION },
    shopName: "",
  };
}

function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

function loadConfig() {
  ensureConfigDir();
  if (!fs.existsSync(CONFIG_PATH)) {
    return defaultConfig();
  }
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    const base = defaultConfig();
    const descriptionPhrases = Array.isArray(raw.descriptionPhrases) && raw.descriptionPhrases.length
      ? raw.descriptionPhrases
      : base.descriptionPhrases;
    const roomFallbacks = Array.isArray(raw.roomFallbacks) && raw.roomFallbacks.length
      ? raw.roomFallbacks
      : base.roomFallbacks;
    return {
      shopify: { ...base.shopify, ...(raw.shopify || {}) },
      rules: mergeRules(raw.rules, base.rules),
      descriptionPhrases,
      roomFallbacks,
      roomDetection: { ...base.roomDetection, ...(raw.roomDetection || {}) },
      shopName: raw.shopName || "",
    };
  } catch {
    return defaultConfig();
  }
}

function sanitizeRoomDetection(incoming, current = {}) {
  if (!incoming || typeof incoming !== "object") {
    return { ...current };
  }
  const {
    hasOpenAiApiKey: _hasKey,
    openaiApiKeyMasked: _masked,
    ...persistable
  } = incoming;
  const next = { ...current, ...persistable };
  if (incoming.openaiApiKey && String(incoming.openaiApiKey).trim()) {
    next.openaiApiKey = String(incoming.openaiApiKey).trim();
  }
  delete next.hasOpenAiApiKey;
  delete next.openaiApiKeyMasked;
  return next;
}

function saveConfig(config) {
  ensureConfigDir();
  const current = loadConfig();
  const storeDomainRaw = config.shopify?.storeDomain;
  const next = {
    shopify: {
      storeDomain:
        storeDomainRaw && String(storeDomainRaw).trim()
          ? String(storeDomainRaw).trim()
          : current.shopify.storeDomain,
      accessToken:
        config.shopify?.accessToken && config.shopify.accessToken.trim()
          ? config.shopify.accessToken.trim()
          : current.shopify.accessToken,
    },
    rules: config.rules ? mergeRules(config.rules, current.rules) : current.rules,
    descriptionPhrases: Array.isArray(config.descriptionPhrases)
      ? config.descriptionPhrases
      : current.descriptionPhrases,
    roomFallbacks: Array.isArray(config.roomFallbacks)
      ? config.roomFallbacks
      : current.roomFallbacks,
    roomDetection: config.roomDetection
      ? sanitizeRoomDetection(config.roomDetection, current.roomDetection)
      : current.roomDetection,
    shopName: config.shopName ?? current.shopName,
  };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), "utf8");
  return next;
}

function maskToken(token) {
  if (!token) {
    return "";
  }
  if (token.length <= 4) {
    return "****";
  }
  return `••••${token.slice(-4)}`;
}

function getOpenAiApiKey() {
  const config = loadConfig();
  return (config.roomDetection?.openaiApiKey || process.env.OPENAI_API_KEY || "").trim();
}

function getPublicSettings() {
  const config = loadConfig();
  const apiKey = getOpenAiApiKey();
  const { openaiApiKey, ...roomDetectionPublic } = config.roomDetection || {};
  return {
    shopify: {
      storeDomain: config.shopify.storeDomain,
      accessTokenMasked: maskToken(config.shopify.accessToken),
      hasToken: Boolean(config.shopify.accessToken),
    },
    rules: config.rules,
    descriptionPhrases: config.descriptionPhrases,
    roomFallbacks: config.roomFallbacks,
    roomDetection: {
      ...roomDetectionPublic,
      hasOpenAiApiKey: Boolean(apiKey),
      openaiApiKeyMasked: maskToken(apiKey),
    },
    shopName: config.shopName,
    defaultCatalogPath: DEFAULT_CATALOG_PATH,
    defaultCatalogBuilderPath: DEFAULT_CATALOG_BUILDER_PATH,
    configPath: CONFIG_PATH,
  };
}

function getShopifyCredentials() {
  const config = loadConfig();
  const storeDomain = (config.shopify.storeDomain || "")
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");
  return {
    storeDomain,
    accessToken: config.shopify.accessToken,
    shopName: config.shopName,
  };
}

module.exports = {
  CONFIG_PATH,
  DEFAULT_RULES,
  DEFAULT_ROOM_DETECTION,
  loadConfig,
  saveConfig,
  getPublicSettings,
  getShopifyCredentials,
  getOpenAiApiKey,
  maskToken,
};
