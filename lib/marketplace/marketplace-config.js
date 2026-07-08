const fs = require("fs");
const path = require("path");
const os = require("os");

const BRAND = "Paintroad";
const AMAZON_BRAND = "Generic";
const MANUFACTURER = "WonderSparkle Private Limited";
const HSN_ARTWORK = "49119100";
const FLIPKART_TAX_CODE = "GST_18";
const DEFAULT_STOCK = 100;
const COUNTRY_OF_ORIGIN = "IN";
const DEFAULT_WEIGHT_KG = 0.5;

const PARTY_NAME = "Paintroad";
const PARTY_ADDRESS = "CB-87, First Floor, Ring Rd, Naraina, New Delhi, Delhi 110028";
const PARTY_DETAILS_LINE = `${PARTY_NAME}, ${PARTY_ADDRESS}`;

const FLIPKART_SHIPPING_PROVIDER = "Seller";
const FLIPKART_PROCUREMENT_TYPE = "Instock";
const FLIPKART_PROCUREMENT_SLA = 1;
const FLIPKART_HANDLING_FEES = { local: 0, zonal: 0, national: 0 };

/** Paintings browse node from Amazon template Browse Data sheet. */
const AMAZON_BROWSE_NODE = "3749951031";
const AMAZON_RECORD_ACTION = "Create or Replace (Full Update)";
const AMAZON_HANDLING_DAYS = 2;
const AMAZON_PACKAGE_DIM_UNIT = "Centimetres";
const AMAZON_PACKAGE_WEIGHT_UNIT = "Grams";
const AMAZON_ITEM_TYPE_NAME = "Painting";
const AMAZON_SHIPPING_TEMPLATE = "Migrated Template";
const AMAZON_UNIT_COUNT = 1;
const AMAZON_UNIT_COUNT_TYPE = "Count";
const AMAZON_EXTERNAL_PRODUCT_ENTITY = "HSN Code";
/** Amazon India PTC for 18% GST (IGST/CGST+SGST). */
const AMAZON_PRODUCT_TAX_CODE = "A_GEN_STANDARD";
const AMAZON_VARIATION_THEME = "BASE_MATERIAL/COLOR/PRINT_MEDIA_TYPE/SIZE";
/** Stored for reference; WALL_ART template has no UNSPSC column. */
const UNSPSC_ARTWORK = "60121013";

const PINTEREST_GENDER = "unisex";
const PINTEREST_AGE_GROUP = "adult";
const PINTEREST_SHIPPING = "IN:::0.00 INR";

const IMAGE_ROOM_PATH = path.join(os.homedir(), ".editpro", "image-room-map.json");

/**
 * Package dimensions (cm) keyed by painting size in inches. Order-insensitive.
 * Length x Breadth x Height.
 */
const PACKAGE_DIMS = [
  { sizes: ["8x10", "10x10"], length: 12, breadth: 14, height: 2.4 },
  { sizes: ["11x14", "12x12"], length: 15, breadth: 19, height: 2.4 },
  { sizes: ["16x20", "18x18"], length: 20, breadth: 24, height: 2.4 },
  { sizes: ["18x24", "24x24"], length: 25, breadth: 28, height: 2.4 },
  { sizes: ["24x36"], length: 28, breadth: 40, height: 3.2 },
  { sizes: ["36x36"], length: 40, breadth: 40, height: 3.2 },
];

function sizeKey(a, b) {
  return `${a}x${b}`;
}

function packageDimsForSize(widthInch, heightInch) {
  const w = Number(widthInch);
  const h = Number(heightInch);
  if (!w || !h) {
    return null;
  }
  const keys = new Set([sizeKey(w, h), sizeKey(h, w)]);
  for (const entry of PACKAGE_DIMS) {
    if (entry.sizes.some((s) => keys.has(s))) {
      return { length: entry.length, breadth: entry.breadth, height: entry.height };
    }
  }
  return null;
}

function weightToKg(value, unit) {
  const raw = Number(value);
  if (!raw || Number.isNaN(raw)) {
    return null;
  }
  switch (String(unit || "").toUpperCase()) {
    case "GRAMS":
    case "G":
      return raw / 1000;
    case "KILOGRAMS":
    case "KG":
      return raw;
    case "OUNCES":
    case "OZ":
      return raw * 0.0283495;
    case "POUNDS":
    case "LB":
    case "LBS":
      return raw * 0.453592;
    default:
      return raw;
  }
}

const AMAZON_ROOM_MAP = {
  "living room": "Living Room",
  bedroom: "Bedroom",
  "dining room": "Dining Room",
  kitchen: "Kitchen",
  office: "Home Office",
  bathroom: "Bathroom",
  nursery: "Nursery",
  entryway: "Hallway",
  hallway: "Hallway",
  outdoor: "Lounge",
  classroom: "Classroom",
  "guest room": "Guest Room",
  "family room": "Family Room",
  "game room": "Game Room",
  library: "Library",
  lounge: "Lounge",
  playroom: "Playroom",
  "study room": "Study Room",
  "kids room": "Kids Room",
  "home office": "Home Office",
  "home theater": "Home Theater",
  "laundry room": "Laundry Room",
  "dressing room": "Dressing Room",
  dormitory: "Dormitory",
  "meeting room": "Meeting Room",
};

const DEFAULT_ROOM = "Living Room";
const AMAZON_MAX_ROOM_TYPES = 5;

function isMeaningfulRoom(room) {
  const r = String(room || "").trim().toLowerCase();
  return r && r !== "none" && r !== "other";
}

function mapRoomToAmazon(room) {
  const key = String(room || "").trim().toLowerCase();
  if (!key) {
    return null;
  }
  if (AMAZON_ROOM_MAP[key]) {
    return AMAZON_ROOM_MAP[key];
  }
  const titled = key
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
  return AMAZON_ROOM_MAP[titled.toLowerCase()] || null;
}

/**
 * Reads the image room map once and returns Map<handle, amazonRoomType>.
 * Chooses the room from the lowest image index that has a meaningful value.
 */
function loadRoomByHandle() {
  const roomsByHandle = loadRoomsByHandle();
  const result = new Map();
  for (const [handle, rooms] of roomsByHandle.entries()) {
    result.set(handle, rooms[0] || DEFAULT_ROOM);
  }
  return result;
}

/**
 * Returns Map<handle, string[]> with up to 5 distinct Amazon room types
 * from all lifestyle images mapped for that product.
 */
function loadRoomsByHandle() {
  const result = new Map();
  let store;
  try {
    store = JSON.parse(fs.readFileSync(IMAGE_ROOM_PATH, "utf8"));
  } catch {
    return result;
  }
  const mappings = store?.mappings || {};
  const byHandle = new Map();
  for (const [key, entry] of Object.entries(mappings)) {
    if (!key.startsWith("product:")) {
      continue;
    }
    const parts = key.split(":");
    const handle = parts[1];
    const index = Number(parts[2]) || 1;
    if (!handle || !isMeaningfulRoom(entry?.room)) {
      continue;
    }
    if (!byHandle.has(handle)) {
      byHandle.set(handle, []);
    }
    byHandle.get(handle).push({
      index,
      room: String(entry.room).trim().toLowerCase(),
    });
  }
  for (const [handle, entries] of byHandle.entries()) {
    entries.sort((a, b) => a.index - b.index);
    const seen = new Set();
    const rooms = [];
    for (const { room } of entries) {
      const mapped = mapRoomToAmazon(room);
      if (!mapped || seen.has(mapped)) {
        continue;
      }
      seen.add(mapped);
      rooms.push(mapped);
      if (rooms.length >= AMAZON_MAX_ROOM_TYPES) {
        break;
      }
    }
    if (rooms.length) {
      result.set(handle, rooms);
    }
  }
  return result;
}

/**
 * Rewrites a Shopify CDN image URL to be served under the store's primary domain.
 * https://cdn.shopify.com/s/files/1/AAAA/BBBB/files/x.jpg -> https://host/cdn/shop/files/x.jpg
 */
function toStoreDomainImageUrl(url, host) {
  const src = String(url || "");
  const domain = String(host || "").replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (!src || !domain) {
    return src;
  }
  return src.replace(
    /https?:\/\/cdn\.shopify\.com\/s\/files\/\d+(?:\/\d+)+\//,
    `https://${domain}/cdn/shop/`
  );
}

module.exports = {
  BRAND,
  AMAZON_BRAND,
  MANUFACTURER,
  HSN_ARTWORK,
  FLIPKART_TAX_CODE,
  DEFAULT_STOCK,
  COUNTRY_OF_ORIGIN,
  DEFAULT_WEIGHT_KG,
  PARTY_NAME,
  PARTY_ADDRESS,
  PARTY_DETAILS_LINE,
  FLIPKART_SHIPPING_PROVIDER,
  FLIPKART_PROCUREMENT_TYPE,
  FLIPKART_PROCUREMENT_SLA,
  FLIPKART_HANDLING_FEES,
  AMAZON_BROWSE_NODE,
  AMAZON_RECORD_ACTION,
  AMAZON_HANDLING_DAYS,
  AMAZON_PACKAGE_DIM_UNIT,
  AMAZON_PACKAGE_WEIGHT_UNIT,
  AMAZON_ITEM_TYPE_NAME,
  AMAZON_SHIPPING_TEMPLATE,
  AMAZON_UNIT_COUNT,
  AMAZON_UNIT_COUNT_TYPE,
  AMAZON_EXTERNAL_PRODUCT_ENTITY,
  AMAZON_PRODUCT_TAX_CODE,
  AMAZON_VARIATION_THEME,
  UNSPSC_ARTWORK,
  PINTEREST_GENDER,
  PINTEREST_AGE_GROUP,
  PINTEREST_SHIPPING,
  DEFAULT_ROOM,
  packageDimsForSize,
  weightToKg,
  loadRoomByHandle,
  loadRoomsByHandle,
  toStoreDomainImageUrl,
};
