/**
 * Parse room from Shopify SEO image filenames.
 * Example: soulful-serenity-canvas-painting-for-living-room-2.jpg → living room
 * Base paintings end with -1 and must not get a lifestyle room.
 */

const {
  ALLOWED_ROOMS,
  normalizeRoomLabel,
} = require("./room-detector");
const { isNoneRoom } = require("./room-utils");
const { DEFAULT_ROOM_FALLBACKS } = require("./default-room-fallbacks");

/** Generic SEO fillers that are not real rooms. */
const GENERIC_FILENAME_FILLERS = new Set(
  DEFAULT_ROOM_FALLBACKS.map((w) =>
    String(w)
      .toLowerCase()
      .replace(/-/g, " ")
      .trim()
  ).filter((w) => !ALLOWED_ROOMS.includes(w))
);

function basenameFromUrl(urlOrName) {
  const raw = String(urlOrName || "").trim();
  if (!raw) return "";
  const noQuery = raw.split("?")[0];
  const parts = noQuery.split("/");
  return parts[parts.length - 1] || "";
}

function stemFromBasename(basename) {
  const name = String(basename || "");
  const dot = name.lastIndexOf(".");
  return (dot > 0 ? name.slice(0, dot) : name).trim();
}

/** CDN/SEO base paintings: stem ends with -1 (e.g. …-for-place-1). */
function isBasePaintingFilename(urlOrName) {
  const stem = stemFromBasename(basenameFromUrl(urlOrName));
  return /-1$/.test(stem);
}

/**
 * Extract the SEO room slug after -for- (drop trailing -{n}).
 * e.g. …-for-living-room-2 → living room
 */
function extractForRoomSlug(stem) {
  const withIndex = String(stem || "").match(/-for-(.+)-(\d+)$/i);
  if (withIndex) {
    return withIndex[1].replace(/-/g, " ").trim().toLowerCase();
  }
  const bare = String(stem || "").match(/-for-(.+)$/i);
  if (bare) {
    return bare[1].replace(/-/g, " ").trim().toLowerCase();
  }
  return "";
}

function isGenericFillerLabel(label) {
  const cleaned = String(label || "")
    .toLowerCase()
    .replace(/-/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return GENERIC_FILENAME_FILLERS.has(cleaned);
}

/**
 * @returns {string} canonical room or "" if none / unusable
 */
function parseRoomFromFilename(urlOrName) {
  if (isBasePaintingFilename(urlOrName)) {
    return "";
  }
  const stem = stemFromBasename(basenameFromUrl(urlOrName));
  if (!stem) return "";

  const forSlug = extractForRoomSlug(stem);
  if (forSlug) {
    if (isGenericFillerLabel(forSlug)) {
      return "";
    }
    const room = normalizeRoomLabel(forSlug);
    if (isNoneRoom(room)) {
      return "";
    }
    return room;
  }

  const tokens = stem.toLowerCase().split(/-+/).filter(Boolean);
  if (tokens.length && /^\d+$/.test(tokens[tokens.length - 1])) {
    tokens.pop();
  }
  for (let i = 0; i < tokens.length; i++) {
    for (let len = 3; len >= 1; len--) {
      if (i + len > tokens.length) continue;
      const phrase = tokens.slice(i, i + len).join(" ");
      if (isGenericFillerLabel(phrase)) continue;
      const room = normalizeRoomLabel(phrase);
      if (!isNoneRoom(room) && ALLOWED_ROOMS.includes(room)) {
        return room;
      }
    }
  }
  return "";
}

module.exports = {
  basenameFromUrl,
  stemFromBasename,
  isBasePaintingFilename,
  extractForRoomSlug,
  parseRoomFromFilename,
  GENERIC_FILENAME_FILLERS,
};
