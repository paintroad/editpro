const fs = require("fs");
const path = require("path");
const os = require("os");

const CONFIG_DIR = path.join(os.homedir(), ".editpro");
const PACKAGE_MAP_PATH = path.join(CONFIG_DIR, "shipping-package-map.json");

/** Frame size (in) → outer box L×W×H (cm). Source: Frame_and_Box_Sizes Master Overview. */
const FRAME_BOX_CM = {
  "8x10": { length: 30.5, width: 25.4, height: 4.4 },
  "10x10": { length: 30.5, width: 30.5, height: 4.4 },
  "11x14": { length: 40.6, width: 33.0, height: 4.4 },
  "12x12": { length: 35.6, width: 35.6, height: 4.4 },
  "16x20": { length: 55.9, width: 45.7, height: 4.4 },
  "18x18": { length: 50.8, width: 50.8, height: 4.4 },
  "18x24": { length: 66.0, width: 50.8, height: 4.4 },
  "24x24": { length: 66.0, width: 66.0, height: 4.4 },
  "24x36": { length: 96.5, width: 66.0, height: 4.4 },
  "36x36": { length: 96.5, width: 96.5, height: 4.4 },
};

const SIZE_OPTION_RE =
  /(\d+(?:\.\d+)?)\s*"?\s*[x×]\s*"?\s*(\d+(?:\.\d+)?)/i;

function normalizeSizeKey(a, b) {
  const n1 = Number(a);
  const n2 = Number(b);
  if (!n1 || !n2 || Number.isNaN(n1) || Number.isNaN(n2)) {
    return null;
  }
  // Prefer known catalog orientation (smaller×larger for rects like 8x10).
  const direct = `${n1}x${n2}`;
  const swapped = `${n2}x${n1}`;
  if (FRAME_BOX_CM[direct]) return direct;
  if (FRAME_BOX_CM[swapped]) return swapped;
  return direct;
}

/**
 * Parse Size option values like `XS - 10"x10"` or `M - 16"x20"`.
 * @returns {string|null} key e.g. `10x10`
 */
function sizeKeyFromOptionValue(value) {
  const text = String(value || "");
  const match = text.match(SIZE_OPTION_RE);
  if (!match) return null;
  return normalizeSizeKey(match[1], match[2]);
}

function optionValue(selectedOptions, name) {
  const target = String(name || "").toLowerCase();
  const hit = (selectedOptions || []).find(
    (opt) => String(opt?.name || "").toLowerCase() === target
  );
  return hit ? String(hit.value || "") : "";
}

function loadShippingPackageMap(mapPath = PACKAGE_MAP_PATH) {
  if (!fs.existsSync(mapPath)) {
    throw new Error(`Shipping package map not found: ${mapPath}`);
  }
  const raw = JSON.parse(fs.readFileSync(mapPath, "utf8"));
  const out = {};
  for (const [key, gid] of Object.entries(raw || {})) {
    const k = String(key).trim();
    const id = String(gid || "").trim();
    if (!k || !id) continue;
    out[k] = id.startsWith("gid://")
      ? id
      : `gid://shopify/ShippingPackageV2/${id}`;
  }
  const missing = Object.keys(FRAME_BOX_CM).filter((k) => !out[k]);
  if (missing.length) {
    throw new Error(
      `shipping-package-map.json missing keys: ${missing.join(", ")}`
    );
  }
  return out;
}

function packageGidForSizeKey(sizeKey, packageMap) {
  if (!sizeKey || !packageMap) return null;
  return packageMap[sizeKey] || null;
}

module.exports = {
  CONFIG_DIR,
  PACKAGE_MAP_PATH,
  FRAME_BOX_CM,
  sizeKeyFromOptionValue,
  optionValue,
  normalizeSizeKey,
  loadShippingPackageMap,
  packageGidForSizeKey,
};
