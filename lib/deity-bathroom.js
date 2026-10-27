/**
 * Deity paintings must not get a bathroom lifestyle image.
 * A tag matches when it contains one of these words (goddess, Lord Hanuman, Lakshmi, …).
 */

const DEITY_NEEDLES = [
  "god",
  "lord",
  "hanuman",
  "krishna",
  "kishan",
  "radha",
  "shiva",
  "vishnu",
  "ganesh",
  "durga",
  "laxmi",
  "lakshmi",
  "buddha",
  "devotional",
  "hindu",
  "shrinath",
  "ramayana",
  "saraswati",
  "parvati",
  "jagannath",
];

function hasDeityText(value) {
  const text = String(value || "").toLowerCase();
  return DEITY_NEEDLES.some((needle) => text.includes(needle));
}

function productHasDeityTags(productOrTags) {
  const tags = Array.isArray(productOrTags) ? productOrTags : productOrTags?.tags;
  return (Array.isArray(tags) ? tags : []).some((tag) => hasDeityText(tag));
}

function isBathroomName(value) {
  return /bathroom/i.test(String(value || ""));
}

function isBathroomImageRecord(image) {
  if (!image) return false;
  return [image.filename, image.path, image.url, image.room, image.roomLabel, image.frameTemplate].some(
    (value) => isBathroomName(value)
  );
}

/**
 * Drop the bathroom room tag from a deity painting.
 * If that was the only room, keep Living Room so the product still has a room collection.
 */
function omitBathroomRoomForDeity(styleTags, roomTags, tags) {
  const style = Array.isArray(styleTags) ? styleTags : [];
  const rooms = Array.isArray(roomTags) ? roomTags : [];
  const all = Array.isArray(tags) ? tags : [];
  if (!productHasDeityTags([...style, ...all])) {
    return { styleTags: style, roomTags: rooms, tags: all };
  }
  const nextRooms = rooms.filter((tag) => !isBathroomName(tag));
  if (!nextRooms.length) {
    nextRooms.push("Living Room");
  }
  const nextTags = all.filter((tag) => !isBathroomName(tag));
  for (const tag of [...style, ...nextRooms]) {
    if (!nextTags.includes(tag)) nextTags.push(tag);
  }
  return { styleTags: style, roomTags: nextRooms, tags: nextTags };
}

module.exports = {
  DEITY_NEEDLES,
  hasDeityText,
  productHasDeityTags,
  isBathroomName,
  isBathroomImageRecord,
  omitBathroomRoomForDeity,
};
