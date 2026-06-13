const fs = require("fs");
const path = require("path");
const os = require("os");

const CONFIG_DIR = path.join(os.homedir(), ".editpro");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

const DEFAULT_RULES = {
  product: {
    imageFilename: "{{handle}}-{{image.index}}",
    imageAlt: "{{title}} {{productType}}",
    seoTitle: "{{title}}",
    seoDescription: "{{description}}",
    tags: "{{tags}}",
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
  },
};

function defaultConfig() {
  return {
    shopify: {
      storeDomain: "",
      accessToken: "",
    },
    rules: structuredClone(DEFAULT_RULES),
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
    return {
      shopify: { ...base.shopify, ...(raw.shopify || {}) },
      rules: { ...base.rules, ...(raw.rules || {}) },
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
  loadConfig,
  saveConfig,
  getPublicSettings,
  getShopifyCredentials,
  maskToken,
};
