// Which kind of lifestyle set a painting belongs in, from its tags.
// Set folders are named "<Orientation> <Class> <n> - <Interior>", e.g. "Portrait Devotional 1 - Haveli".
// Names end on a word boundary so "Kalighat" is not read as Kali.
const DEVOTIONAL = /\b(lord |(?:shrinathji|radha|hindu goddess|lakshmi|durga|kali|saraswati|ramayana|devotional|buddha|hanuman|hindu gods)\b)/i;
const TRADITIONAL = /\b(pichwai|gond|madhubani|warli|pattachitra|kalighat|kalamkari|phad|tanjore|mughal|miniature|ragamala|thangka|raja ravi verma|vintage indian|indian folk art|indian art)/i;
const FOLK_FOR_MODERN = /\b(gond|warli|madhubani)/i;
// A deity is depicted. Pichwai tagged Shrinathji nearly always shows him even when cows fill the
// scene, and Ramayana scenes show Ram; the rare cow-only Pichwai needs Enrich's depictsDeity.
const DEITY = /\b(lord |(?:hindu goddess|hindu gods|lakshmi|durga|kali|saraswati|radha|shrinathji|ramayana|hanuman)\b)/i;

const SET_CLASSES = ["Devotional", "Traditional", "Contemporary", "Mixed"];
// Catalog lifestyle sets, under the frame references folder.
const NEW_SETS_FOLDER = "_New Lifestyle Sets";

function styleClassForTags(tags) {
  const text = (Array.isArray(tags) ? tags : [tags]).filter(Boolean).join(" | ");
  if (DEVOTIONAL.test(text)) return "devotional";
  if (TRADITIONAL.test(text)) return "traditional";
  return "contemporary";
}

/** Set classes that suit a painting, best first. Mixed sets take contemporary work and modern-friendly folk art. */
function setClassesForTags(tags) {
  const text = (Array.isArray(tags) ? tags : [tags]).filter(Boolean).join(" | ");
  const style = styleClassForTags(tags);
  if (style === "devotional") return ["Devotional"];
  if (style === "traditional") return FOLK_FOR_MODERN.test(text) ? ["Traditional", "Mixed"] : ["Traditional"];
  return ["Contemporary", "Mixed"];
}

/**
 * Whether a painting shows a god, so it may use god-only rooms (the home temple). `depictsDeity`
 * from Enrich, when known, wins over the tags.
 */
function isGodPainting(tags, depictsDeity) {
  if (typeof depictsDeity === "boolean") return depictsDeity;
  const list = (Array.isArray(tags) ? tags : [tags]).filter(Boolean);
  return DEITY.test(list.join(" | "));
}

/**
 * Rooms of a set for one painting. A room whose frame-quads meta has `godOnly` is used only for god
 * paintings; one with `nonGod` takes its place for every other painting.
 */
function roomsForPainting(frames, metaFor, godPainting) {
  return frames.filter((frame) => {
    const meta = metaFor(frame) || {};
    if (meta.godOnly) return godPainting;
    if (meta.nonGod) return !godPainting;
    return true;
  });
}

function parseSetName(name) {
  const m = String(name || "").match(/^(portrait|landscape|square)\s+(devotional|traditional|contemporary|mixed)\s+(\d+)/i);
  if (!m) return null;
  const cap = (s) => s[0].toUpperCase() + s.slice(1).toLowerCase();
  return { orientation: m[1].toLowerCase(), setClass: cap(m[2]), number: Number(m[3]) };
}

function hashOf(text) {
  let h = 0;
  for (const ch of String(text)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
}

/**
 * The set a painting goes in: the first of its set classes that has a set of its orientation,
 * else Mixed, else any set of that orientation. Among equals, `seed` (the product id) spreads
 * paintings over the sets and keeps each painting in the same set on every run.
 */
function pickSetForPainting(setNames, orientation, tags, seed) {
  const ofShape = setNames
    .filter((name) => parseSetName(name)?.orientation === orientation)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const inClass = (cls) => ofShape.filter((name) => parseSetName(name).setClass === cls);
  for (const cls of [...setClassesForTags(tags), "Mixed"]) {
    const pool = inClass(cls);
    if (pool.length) return pool[hashOf(seed) % pool.length];
  }
  return ofShape.length ? ofShape[hashOf(seed) % ofShape.length] : null;
}

module.exports = {
  NEW_SETS_FOLDER,
  SET_CLASSES,
  styleClassForTags,
  setClassesForTags,
  isGodPainting,
  roomsForPainting,
  parseSetName,
  pickSetForPainting,
};
