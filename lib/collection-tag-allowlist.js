/**
 * Exact Shopify smart-collection tag conditions.
 * Style tags may be combined. At least one room tag is required.
 * Named-artist collections are intentionally absent, except Raja Ravi Verma from the Indian art set.
 */
const { COLLECTION_TAGS } = require("./catalog-collections");

const ROOM_TAGS = [
  "bedroom",
  "Living Room",
  "Dining Room",
  "Study Room",
  "bathroom",
  "entrance",
  "kitchen",
  "kids",
  "Kids Nursery",
  "baby",
];

const STYLE_TAGS = [
  "Maximalist",
  "Contemporary",
  "Women Illustrations",
  "Woman",
  "dynamic woman",
  "indian woman",
  "young woman",
  "woman lounging",
  "energy of women",
  "women",
  "dynamic women",
  "lion and woman",
  "Indianwoman",
  "abstract",
  "random",
  "brush strokes",
  "monochrome",
  "Botanical Prints",
  "botanical",
  "pop",
  "pop art",
  "pop art.",
  "pop culture",
  "indian",
  "bauhaus",
  "astrology",
  "sun sign",
  "Cocktail",
  "dog",
  "dog art",
  "dog lover",
  "cat",
  "cat lover",
  "cat art",
  "cat illustration",
  "motivational",
  "motivational art",
  "Motivational poster",
  "motivational quote",
  "motivation",
  "quotes",
  "love",
  "romantic",
  "vacation",
  "beach",
  "Coast",
  "mountain",
  "Animal",
  "Astronaut",
  "Autumn",
  "Boho",
  "Cowgirl",
  "Devotional",
  "Hindu god",
  "Hindu Gods",
  "hanuman",
  "Lord Hanuman",
  "Krishna",
  "Lord Krishna",
  "Shiva",
  "Lord Shiva",
  "Buddha",
  "Lord Buddha",
  "Lord Ganesha",
  "Ganesha",
  "Lakshmi",
  "Gond",
  "Greek",
  "Indian Art",
  "Indian Folk Art",
  "Intricate Patterns",
  "Kitchen Prints",
  "Madhubani",
  "Indian Botanical Art",
  "Maximalist Art",
  "Natural Vintage",
  "Pichwai",
  "Travel",
  "Radha",
  ...COLLECTION_TAGS.map((row) => row.tag),
].filter((tag, index, all) => all.indexOf(tag) === index);

function allowSet(tags) {
  return new Set(tags);
}

function filterAllowedTags(values, allowed) {
  const set = allowed instanceof Set ? allowed : allowSet(allowed);
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const tag = String(value || "").trim();
    if (!tag || !set.has(tag) || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
}

module.exports = {
  ROOM_TAGS,
  STYLE_TAGS,
  filterAllowedTags,
};
