const fs = require("fs");
const path = require("path");
const os = require("os");
const { DEFAULT_DESCRIPTION_PHRASES } = require("./default-description-phrases");

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

const DEFAULT_ROOM_DETECTION = {
  ollamaHost: "http://localhost:11434",
  ollamaModel: "gemma3:4b",
};

function defaultConfig() {
  return {
    shopify: {
      storeDomain: "",
      accessToken: "",
    },
    rules: structuredClone(DEFAULT_RULES),
    descriptionPhrases: [...DEFAULT_DESCRIPTION_PHRASES],
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
    return {
      shopify: { ...base.shopify, ...(raw.shopify || {}) },
      rules: { ...base.rules, ...(raw.rules || {}) },
      descriptionPhrases,
      roomDetection: { ...base.roomDetection, ...(raw.roomDetection || {}) },
      shopName: raw.shopName || "",
    };
  } catch {
    return defaultConfig();
  }
}

function saveConfig(config) {
  ensureConfigDir();
  const current = loadConfig();
  const next = {
    shopify: {
      storeDomain: config.shopify?.storeDomain ?? current.shopify.storeDomain,
      accessToken:
        config.shopify?.accessToken && config.shopify.accessToken.trim()
          ? config.shopify.accessToken.trim()
          : current.shopify.accessToken,
    },
    rules: config.rules || current.rules,
    descriptionPhrases: Array.isArray(config.descriptionPhrases)
      ? config.descriptionPhrases
      : current.descriptionPhrases,
    roomDetection: config.roomDetection
      ? { ...current.roomDetection, ...config.roomDetection }
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

function getPublicSettings() {
  const config = loadConfig();
  return {
    shopify: {
      storeDomain: config.shopify.storeDomain,
      accessTokenMasked: maskToken(config.shopify.accessToken),
      hasToken: Boolean(config.shopify.accessToken),
    },
    rules: config.rules,
    descriptionPhrases: config.descriptionPhrases,
    roomDetection: config.roomDetection,
    shopName: config.shopName,
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
  maskToken,
};
