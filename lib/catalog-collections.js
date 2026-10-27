/**
 * Collection tags for the Indian art catalog. `tag` is the exact product tag a smart collection
 * matches on; tags that already drive a live collection keep that collection's spelling.
 */
const COLLECTION_TAGS = [
  // Art forms
  { group: "Art form", tag: "Pichwai", hint: "Nathdwara temple paintings: Shrinathji, cows, lotus ponds, gopis, dense decorative borders" },
  { group: "Art form", tag: "Gond", hint: "Gond tribal art: animals, trees and birds filled with dots, dashes and line patterns" },
  { group: "Art form", tag: "Madhubani", hint: "Mithila/Madhubani: bold outlines, double lines, every space filled with pattern" },
  { group: "Art form", tag: "Warli Art", hint: "Warli tribal art: white stick figures, circles and triangles on earthy ground" },
  { group: "Art form", tag: "Pattachitra", hint: "Odisha/Bengal scroll painting: ornate borders, stylised figures, Jagannath, Krishna" },
  { group: "Art form", tag: "Kalighat", hint: "Kalighat pat: bold curved brush outlines, plain background, 19th-century Calcutta" },
  { group: "Art form", tag: "Kalamkari", hint: "Kalamkari: hand-drawn textile-style art in muted reds, ochres and black" },
  { group: "Art form", tag: "Phad", hint: "Rajasthani Phad scroll: flat bright figures narrating epics in panels" },
  { group: "Art form", tag: "Tanjore", hint: "Tanjore/Thanjavur: rich colours, gold leaf, deity in an arch" },
  { group: "Art form", tag: "Mughal Art", hint: "Mughal miniatures: court scenes, emperors, hunting, Mughal floral and bird studies" },
  { group: "Art form", tag: "Indian Miniature", hint: "Rajput, Pahari, Deccan or Company School miniatures that are not Mughal" },
  { group: "Art form", tag: "Ragamala", hint: "Ragamala series: miniatures personifying musical ragas" },
  { group: "Art form", tag: "Thangka", hint: "Tibetan/Himalayan Buddhist thangka" },
  { group: "Art form", tag: "Raja Ravi Verma", hint: "Oil paintings by or in the style of Raja Ravi Varma" },
  { group: "Art form", tag: "Vintage Indian Art", hint: "Antique Indian paintings, old prints, lithographs, calendar art, museum pieces" },
  // Subjects
  { group: "Subject", tag: "Shrinathji", hint: "Shrinathji, the Nathdwara form of Krishna with raised arm" },
  { group: "Subject", tag: "Lord Krishna", hint: "Krishna in any form" },
  { group: "Subject", tag: "Radha", hint: "Radha with Krishna" },
  { group: "Subject", tag: "Lord Ganesha", hint: "Ganesha" },
  { group: "Subject", tag: "Lord Shiva", hint: "Shiva, Shiva-Parvati, Nataraja, Shiva lingam" },
  { group: "Subject", tag: "Lord Hanuman", hint: "Hanuman" },
  { group: "Subject", tag: "Ramayana", hint: "Rama, Sita, Lakshmana or scenes from the Ramayana" },
  { group: "Subject", tag: "Hindu Goddess", hint: "Any goddess: Durga, Kali, Lakshmi, Saraswati, Parvati and others (add alongside the named goddess tag)" },
  { group: "Subject", tag: "Lakshmi", hint: "Goddess Lakshmi (often on a lotus, with gold coins or elephants)" },
  { group: "Subject", tag: "Durga", hint: "Goddess Durga (often on a lion or slaying Mahishasura)" },
  { group: "Subject", tag: "Kali", hint: "Goddess Kali" },
  { group: "Subject", tag: "Saraswati", hint: "Goddess Saraswati (with veena, swan)" },
  { group: "Subject", tag: "Lord Vishnu", hint: "Vishnu or his avatars other than Krishna and Rama (Narayana, Venkateshwara/Balaji, Jagannath)" },
  { group: "Subject", tag: "Lord Buddha", hint: "Buddha" },
  { group: "Subject", tag: "Music and Dance", hint: "Musicians, instruments or dancers as the main subject" },
  // Motifs
  { group: "Motif", tag: "Lotus", hint: "Lotus flowers or lotus ponds" },
  { group: "Motif", tag: "Tree of Life", hint: "A central tree of life / kalpavriksha" },
  { group: "Motif", tag: "Peacock", hint: "Peacocks" },
  { group: "Motif", tag: "Elephant", hint: "Elephants" },
  { group: "Motif", tag: "Cows", hint: "Cows, Kamdhenu, calves" },
  { group: "Motif", tag: "Horses", hint: "Horses" },
  { group: "Motif", tag: "Birds", hint: "Birds (other than peacocks) as the main subject" },
  { group: "Motif", tag: "Flowers", hint: "Flowers or floral studies as the main subject" },
  { group: "Motif", tag: "Fish", hint: "Fish" },
  { group: "Motif", tag: "Mandala", hint: "Mandala or circular sacred geometry" },
  // Contemporary
  { group: "Contemporary", tag: "Boho", hint: "Boho / mid-century style: earthy shapes, arches, vases, suns, minimal plants" },
  { group: "Contemporary", tag: "Animal", hint: "Contemporary or patchwork art with an animal or big cat as the main subject (not traditional Indian art)" },
  { group: "Contemporary", tag: "Travel", hint: "Places and journeys: towns, streets, trains, ships, desert or sea scenes" },
  { group: "Contemporary", tag: "Mediterranean", hint: "Moroccan or Mediterranean doors, arches, tiles, whitewashed or pastel villages" },
  // Use
  {
    group: "Use",
    tag: "Vastu",
    hint:
      "Add whenever one of these Vastu-recommended subjects is central: seven running horses, Kamdhenu or cows, elephant pairs, " +
      "lotus, tree of life, rising sun, flowing water, pairs of birds or swans. Never for artworks that depict a god, goddess or deity",
  },
];

const { productHasDeityTags } = require("./deity-bathroom");

const TAGS = new Set(COLLECTION_TAGS.map((row) => row.tag));

/** Broader live collections each tag also belongs to. */
const PARENT_TAGS = {
  Pichwai: ["Indian Art"],
  Gond: ["Indian Folk Art"],
  Madhubani: ["Indian Folk Art"],
  "Warli Art": ["Indian Folk Art"],
  Pattachitra: ["Indian Folk Art"],
  Kalighat: ["Indian Folk Art"],
  Kalamkari: ["Indian Folk Art"],
  Phad: ["Indian Folk Art"],
  Tanjore: ["Indian Art"],
  "Mughal Art": ["Indian Art"],
  "Indian Miniature": ["Indian Art"],
  Ragamala: ["Indian Art"],
  "Raja Ravi Verma": ["Indian Art"],
  "Vintage Indian Art": ["Indian Art"],
  Shrinathji: ["Lord Krishna", "Devotional"],
  Radha: ["Lord Krishna"],
  "Lord Krishna": ["Devotional"],
  "Lord Ganesha": ["Devotional"],
  "Lord Shiva": ["Devotional"],
  "Lord Hanuman": ["Devotional"],
  Ramayana: ["Devotional"],
  "Hindu Goddess": ["Devotional"],
  Lakshmi: ["Hindu Goddess", "Devotional"],
  Durga: ["Hindu Goddess", "Devotional"],
  Kali: ["Hindu Goddess", "Devotional"],
  Saraswati: ["Hindu Goddess", "Devotional"],
  "Lord Vishnu": ["Devotional"],
  "Lord Buddha": ["Devotional"],
};

function withParents(tags) {
  const out = [];
  for (const tag of tags) {
    for (const value of [tag, ...(PARENT_TAGS[tag] || []), ...(PARENT_TAGS[PARENT_TAGS[tag]?.[0]] || [])]) {
      if (!out.includes(value)) out.push(value);
    }
  }
  return withoutDeityVastu(out);
}

/** Vastu is for non-religious subjects only; any painting with a deity tag drops it. */
function withoutDeityVastu(tags) {
  if (!productHasDeityTags(tags)) return tags;
  return tags.filter((tag) => String(tag).toLowerCase() !== "vastu");
}

function collectionTagsFrom(value) {
  let list = value;
  if (typeof value === "string") {
    try {
      list = JSON.parse(value || "[]");
    } catch {
      list = [];
    }
  }
  return (Array.isArray(list) ? list : []).filter((tag) => TAGS.has(tag));
}

module.exports = { COLLECTION_TAGS, PARENT_TAGS, collectionTagsFrom, withParents, withoutDeityVastu };
