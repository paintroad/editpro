const fs = require("fs");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { STYLE_TAGS } = require("./collection-tag-allowlist");
const { scrubText, isClean } = require("./brand-guard");
const { collectionTagsFrom, withParents } = require("./catalog-collections");

const PREP_DIR = path.join(os.homedir(), ".editpro", "pipeline-prep");
const DB_PATH = path.join(PREP_DIR, "catalog.db");
const CACHE_PATH = path.join(PREP_DIR, "reference-listings.json");
const CACHE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const SOURCES = [
  { key: "a", host: "www.theatrang.com" },
  { key: "n", host: "www.nakhrro.com" },
];
const ART_HINT = /paint|art|print|canvas|pichwai|gond|madhubani|warli|thangka|mughal|tanjore/i;
const NOT_ART = /plate|ceramic|mirror|clock|cushion|tray|coaster|lamp|candle|vase|rug|bookmark|magnet|gift card/i;
const ART_FORMS = [
  "pichwai", "gond", "madhubani", "warli", "pattachitra", "kalighat", "thangka", "mughal",
  "ragamala", "tanjore", "kalamkari", "phad", "shiva", "krishna", "hanuman", "ganesha",
  "buddha", "lotus", "tree of life", "vintage", "botanical", "ramayana", "ravi varma",
];
/** Prep folder names shown to the model in readable form. */
const FOLDER_LABELS = { rrv: "Raja Ravi Varma", warli_art: "Warli art", hanuman: "Hanuman and Ramayana" };
/** Sub-labels and sister stores that appear in reference copy; stripped before the model sees it. */
const REFERENCE_NOISE = /\s*[|\-–]*\s*\b(arts of india|vastu artworks?|online framing)\b/gi;
const BOILERPLATE_MIN = 10;

/** Prep categories (and folder names) mapped to the store's style collection tags. */
const CATEGORY_STYLE_TAGS = [
  [/pichwai/i, ["Pichwai", "Indian Art"]],
  [/gond/i, ["Gond", "Indian Folk Art"]],
  [/madhubani/i, ["Madhubani", "Indian Folk Art"]],
  [/warli/i, ["Warli Art", "Indian Folk Art"]],
  [/patt?a?chitra/i, ["Pattachitra", "Indian Folk Art"]],
  [/shiva/i, ["Shiva", "Lord Shiva", "Devotional"]],
  [/krishna/i, ["Krishna", "Lord Krishna", "Devotional"]],
  [/radha/i, ["Radha"]],
  [/ganesha/i, ["Ganesha", "Lord Ganesha", "Devotional"]],
  [/^hanuman$/i, ["Devotional", "Hindu Gods"]],
  [/mughal/i, ["Mughal Art", "Indian Art"]],
  [/ragmala|ragamala/i, ["Ragamala", "Indian Art"]],
  [/thangka/i, ["Thangka", "Indian Art"]],
  [/vastu/i, ["Vastu"]],
  [/^rrv$/i, ["Raja Ravi Verma", "Indian Art"]],
  [/vintage/i, ["Vintage Indian Art", "Indian Art"]],
  [/lotus/i, ["Lotus"]],
  [/tree of life/i, ["Tree of Life"]],
  [/music|dance/i, ["Music and Dance"]],
  [/botanical/i, ["Flowers"]],
  [/animal|bird/i, ["Animal"]],
];

let listings = null;
let loading = null;

function plain(html, max = 700) {
  const text = String(html || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
  const clean = scrubText(text)
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => !sentence.match(REFERENCE_NOISE))
    .join(" ");
  return clean.length > max ? `${clean.slice(0, max).replace(/\s+\S*$/, "")}…` : clean;
}

function cleanList(values) {
  return (values || []).map((value) => String(value || "").trim()).filter((value) => value && isClean(value));
}

function stemOf(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, "")
    .replace(/^copy-of-/, "");
}

async function fetchStore(host) {
  const products = [];
  for (let page = 1; page < 60; page += 1) {
    const response = await fetch(`https://${host}/products.json?limit=250&page=${page}`, {
      headers: { "user-agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error(`Reference listings unavailable (${response.status}).`);
    const data = await response.json();
    if (!data.products?.length) break;
    products.push(...data.products);
  }
  return products;
}

function compact(product) {
  return {
    handle: product.handle,
    title: scrubText(product.title).replace(REFERENCE_NOISE, "").replace(/[\s|\-–]+$/, "").trim(),
    type: scrubText(product.product_type),
    tags: cleanList(product.tags),
    description: plain(product.body_html),
    images: (product.images || []).map((image) =>
      stemOf(decodeURIComponent(String(image.src || "").split("?")[0].split("/").pop()))
    ),
  };
}

async function refreshListings() {
  const next = { fetchedAt: new Date().toISOString(), sources: {} };
  for (const source of SOURCES) {
    next.sources[source.key] = (await fetchStore(source.host)).map(compact);
  }
  fs.mkdirSync(PREP_DIR, { recursive: true });
  fs.writeFileSync(CACHE_PATH, JSON.stringify(next));
  return next;
}

async function loadListings() {
  if (listings) return listings;
  if (loading) return loading;
  loading = (async () => {
    let cached = null;
    try {
      cached = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
    } catch {
      cached = null;
    }
    const fresh = cached && Date.now() - Date.parse(cached.fetchedAt) < CACHE_MAX_AGE_MS;
    if (!fresh) {
      try {
        cached = await refreshListings();
      } catch (error) {
        if (!cached) throw error;
      }
    }
    listings = cached;
    for (const rows of Object.values(listings.sources)) {
      const openings = new Map();
      for (const row of rows) {
        const key = row.description.slice(0, 80);
        openings.set(key, (openings.get(key) || 0) + 1);
      }
      for (const row of rows) {
        if (openings.get(row.description.slice(0, 80)) >= BOILERPLATE_MIN) row.description = "";
        const words = row.title.split(/\s+/).filter((word) => /[a-z]{2}/i.test(word));
        row.isArt =
          words.length >= 3 &&
          ART_HINT.test(`${row.type} ${row.title} ${row.tags.join(" ")}`) &&
          !NOT_ART.test(`${row.type} ${row.title} ${row.tags.join(" ")}`);
      }
    }
    return listings;
  })().finally(() => {
    loading = null;
  });
  return loading;
}

function openDb() {
  if (!fs.existsSync(DB_PATH)) return null;
  const db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA busy_timeout = 10000;");
  const columns = new Set(db.prepare("PRAGMA table_info(images)").all().map((column) => column.name));
  if (!columns.has("product_id")) db.exec("ALTER TABLE images ADD COLUMN product_id TEXT");
  return db;
}

function prepRow(productId) {
  const db = openDb();
  if (!db) return null;
  try {
    return db.prepare("SELECT * FROM images WHERE product_id = ?").get(String(productId)) || null;
  } finally {
    db.close();
  }
}

/** Record the product number and renamed files against the prep row. */
function linkPrepRow(prepName, productId, files) {
  const db = openDb();
  if (!db) return false;
  try {
    const result = db
      .prepare(
        "UPDATE images SET product_id = ?, file = ?, upscaled_file = ?, updated_at = ? WHERE lower(name) = lower(?)"
      )
      .run(String(productId), files.optimised, files.printable, new Date().toISOString().slice(0, 19), prepName);
    return result.changes > 0;
  } finally {
    db.close();
  }
}

function categoriesOf(row) {
  try {
    return JSON.parse(row?.categories || "[]").filter((value) => value && value !== "Paintings" && value !== "Others");
  } catch {
    return [];
  }
}

function styleTagsFor(row) {
  const keys = [...categoriesOf(row), row?.brand || ""].filter(Boolean);
  const out = [];
  for (const key of keys) {
    for (const [pattern, tags] of CATEGORY_STYLE_TAGS) {
      if (!pattern.test(key)) continue;
      for (const tag of tags) if (STYLE_TAGS.includes(tag) && !out.includes(tag)) out.push(tag);
    }
  }
  return out;
}

function findMatch(data, row) {
  const source = SOURCES.find((entry) => entry.host.includes(String(row?.brand || "").toLowerCase()));
  const stem = stemOf(row?.source_file);
  if (!source || !stem) return null;
  const rows = data.sources[source.key] || [];
  return rows.find((item) => item.handle === stem) || rows.find((item) => item.images.includes(stem)) || null;
}

function folderLabel(row) {
  const brand = String(row?.brand || "");
  if (!brand || /atrang|nakh+r+o+|pinterest/i.test(brand)) return "";
  return FOLDER_LABELS[brand.toLowerCase()] || brand.replace(/_/g, " ");
}

function artFormOf(row) {
  const text = `${categoriesOf(row).join(" ")} ${row?.brand || ""} ${folderLabel(row)}`.toLowerCase();
  return ART_FORMS.find((form) => text.includes(form)) || null;
}

function examplesFor(data, form, limit, skipHandle) {
  const pool = Object.values(data.sources).flat().filter((item) => item.isArt && item.handle !== skipHandle);
  const matches = form
    ? pool.filter((item) => `${item.title} ${item.tags.join(" ")}`.toLowerCase().includes(form))
    : [];
  return matches.slice(0, limit);
}

function patternTitles(data) {
  const pool = Object.values(data.sources).flat().filter((item) => item.isArt);
  const out = [];
  for (const form of ART_FORMS) {
    const hit = pool.find((item) => item.title.toLowerCase().includes(form) && !out.includes(item.title));
    if (hit) out.push(hit.title);
  }
  return out;
}

/** Everything the enrichment prompt should know about a painting beyond the image itself. */
async function referenceFor(productId) {
  return referenceForRow(prepRow(productId));
}

async function referenceForRow(row) {
  let data = null;
  try {
    data = await loadListings();
  } catch {
    data = null;
  }
  const match = data && row ? findMatch(data, row) : null;
  const form = artFormOf(row);
  const examples = data ? examplesFor(data, form, match ? 2 : 4, match?.handle) : [];
  return {
    categories: categoriesOf(row),
    folder: folderLabel(row),
    styleTags: withParents([...styleTagsFor(row), ...collectionTagsFrom(row?.collection_tags)]),
    match,
    examples,
    patterns: data && !match && !examples.length ? patternTitles(data) : [],
  };
}

module.exports = {
  CACHE_PATH,
  DB_PATH,
  loadListings,
  refreshListings,
  referenceFor,
  referenceForRow,
  prepRow,
  linkPrepRow,
  styleTagsFor,
};
