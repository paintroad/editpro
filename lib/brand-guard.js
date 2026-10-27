/**
 * Competitor names that must never reach the store, a feed, or any generated copy.
 * Matching is case-insensitive and catches the names inside handles, file names and URLs
 * (theatrang, atrangi, nakhro, nakhrroo, ...). Do not loosen or remove these.
 */
const BLOCKED_TERMS = [
  { name: "Atrang", pattern: /atrang/i },
  { name: "Nakhrro", pattern: /nakh+r+o+/i },
];

class BrandGuardError extends Error {
  constructor(hits, context) {
    const where = hits
      .slice(0, 5)
      .map((hit) => `${hit.term} in ${hit.path || "value"}`)
      .join("; ");
    super(`Blocked: competitor name found${context ? ` (${context})` : ""}: ${where}`);
    this.name = "BrandGuardError";
    this.code = "BRAND_GUARD";
    this.hits = hits;
  }
}

function termsIn(text) {
  const value = String(text ?? "");
  return BLOCKED_TERMS.filter((term) => term.pattern.test(value)).map((term) => term.name);
}

function findBlocked(value, at = "", hits = [], seen = new Set()) {
  if (value == null) return hits;
  if (typeof value === "string" || typeof value === "number") {
    for (const term of termsIn(value)) hits.push({ term, path: at });
    return hits;
  }
  if (typeof value !== "object" || seen.has(value)) return hits;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => findBlocked(item, `${at}[${index}]`, hits, seen));
    return hits;
  }
  for (const [key, item] of Object.entries(value)) {
    const next = at ? `${at}.${key}` : key;
    for (const term of termsIn(key)) hits.push({ term, path: next });
    findBlocked(item, next, hits, seen);
  }
  return hits;
}

function isClean(value) {
  return findBlocked(value).length === 0;
}

function assertClean(value, context = "") {
  const hits = findBlocked(value);
  if (hits.length) throw new BrandGuardError(hits, context);
  return value;
}

/** Drop every sentence that names a blocked brand. For reference text we read, never for output. */
function scrubText(text) {
  const sentences = String(text || "").split(/(?<=[.!?])\s+/);
  return sentences
    .filter((sentence) => !termsIn(sentence).length)
    .join(" ")
    .trim();
}

module.exports = {
  BLOCKED_TERMS,
  BrandGuardError,
  findBlocked,
  isClean,
  assertClean,
  scrubText,
};
