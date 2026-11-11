#!/usr/bin/env node
/**
 * Proposes one lifestyle set for every approved painting and writes ~/.editpro/lifestyle-sets/set-assignments.json.
 *
 *   node scripts/frames/assign_sets.js
 *
 * 1. Shape decides the pool: 3:4 portrait, 4:3 landscape, 1:1 square sets; 16:9 Wide and 9:16 Tall Statement sets.
 * 2. Theme (from tags, Shopify collections and title): Kids collection > classical music (an instrument in the title;
 *    deity art with an instrument may take classical music or devotional sets) > Devotional > Bathroom > Kids (title)
 *    > modern Music > Motivational > Kitchen > Traditional > Balcony > Modern. Dance alone is not music.
 *    A theme with no set of that shape falls back to Modern. Study sets share the Motivational and Modern pools.
 * 3. Designer fit: within the theme each set is scored on subject/style keywords (35%), contrast with its wall (25%),
 *    colours picked up by its cushions and decor (20%), warmth (10%) and calm/bold mood (10%). Room palettes come
 *    from room_palettes.py (room-palettes.json); painting colours are read from the image (painting-colours.json).
 * 4. Fit first: the best set wins; sets within 5% of the best share by load; twin interiors split evenly. Sparse sets
 *    may take a well-fitting painting from a neighbouring theme. Sets over CROWDED are reported for sibling sets.
 * Catalog Creation Plan: Downloads\_Catalog\Catalog Creation Plan - Set Assignment Rules.md. No paid calls.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const sharp = require("sharp");
const { isGodPainting } = require("../../lib/lifestyle-style");

const HOME = path.join(os.homedir(), ".editpro");
const PREP = path.join(HOME, "pipeline-prep");
const LS = path.join(HOME, "lifestyle-sets");
const SETS_ROOT = "C:\\Users\\divya\\Downloads\\_Frames\\_New Lifestyle Sets";
const OUT = path.join(LS, "set-assignments.json");
const COLOUR_CACHE = path.join(LS, "painting-colours.json");
const PALETTES = path.join(LS, "room-palettes.json");
const REPORT = path.join(LS, "set-assignment-report.json");
const NEAR_TIE = 0.95;
// Best designer-fit score below which a painting suits no set of its theme well (about the lowest 7%).
const WEAK_FIT = 0.4;
const CROWDED = 80;
const SPARSE = 5;
const SPARSE_FILL = 8;
const SPARSE_FIT = 0.95;
const WEIGHTS = { style: 0.35, wall: 0.25, accent: 0.2, warmth: 0.1, mood: 0.1 };
// Near-identical interiors split their paintings evenly.
const TWINS = [
  ["Portrait Modern 10 - Classic Originals", "Portrait Modern 11 - Classic Originals Two"],
  ["Portrait Modern 2 - Japandi Calm", "Portrait Contemporary 2 - Japandi"],
  ["Tall Statement 1 - Warm Boho Foyer", "Tall Statement 2 - Warm Boho Passage"],
  ["Square Mixed 1 - Modern Boho", "Square Modern 2 - Modern Boho"],
  ["Portrait Bathroom 1 - Everyday Home", "Portrait Bathroom 2 - Bright Modern"],
];
// Themes a sparse set (by class) may take paintings from, besides its own theme.
const BORROW_FROM = { music: ["modern"], kitchen: ["modern", "balcony"], balcony: ["modern"], kids: ["modern"], study: ["modern", "motivational"] };
// A painting from another theme needs a title subject that belongs in the borrowing room, not just a style word.
const BORROW_SUBJECT = {
  music: /\b(jazz|blues|rock|concert|records?|vinyl|neon|city|night\w*)\b/i,
  kitchen: /\b(fruits?|lemons?|oranges?|coffee|tea|botanical\w*|flowers?|floral|herbs?|citrus|still life|sunflowers?)\b/i,
  balcony: /\b(botanical\w*|floral|flowers?|birds?|leaf|leaves|plants?|palms?|tropical|sail\w*|coastal|beach|ocean)\b/i,
  kids: /\b(space|astronaut|rocket|planets?|moon|stars?|galaxy|animals?)\b/i,
  study: /\b(maps?|books?|library|typewriter|globe)\b/i,
};

const readJson = (f, d) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : d);

const SET_NAME = /^(portrait|landscape|square|wide|tall)\s+(modern|kitchen|kids|motivational|bathroom|music|balcony|study|statement|devotional|traditional|contemporary|mixed)\s+(\d+)\s*-\s*(.+)$/i;

// Theme pools per class. Older Contemporary sets join Modern; Mixed takes modern-friendly folk art and modern work.
const POOL = {
  devotional: ["devotional"],
  kids: ["kids"],
  motivational: ["motivational", "study"],
  kitchen: ["kitchen"],
  bathroom: ["bathroom"],
  music: ["music"],
  balcony: ["balcony"],
  traditional: ["traditional", "mixed"],
  modern: ["modern", "contemporary", "mixed", "study"],
  statement: ["statement"],
};

// Room words in tags ("Kitchen", "Nursery", "Kids Room") only suggest where a painting may hang, so Kids and
// Kitchen come from the Shopify collections or from the subject in the title and subject tags.
const THEME_RULES = [
  // Funny bathroom posters: the subject is the loo itself, not a "Bathroom" room tag.
  ["bathroom", { coll: /^(bathroom-humou?r|funny-bathroom-posters|toilet-humou?r)$/, text: /\b(toilet\w*|potty|poop\w*|flush\w*|loo|bathroom (?:signs?|humou?r|quotes?|rules|art|posters?|puns?)|wash your hands|bath rules|funny bums|the best seat|toilet paper)\b/i }],
  ["kids", { coll: /^(kids-nursery|baby-room|kids-room)$/, text: /\b(teddy|dino\w*|unicorn|bunny|bunnies|baby animals?|cartoon|alphabet|abc|nursery rhyme|for kids|kids art|playroom)\b/i }],
  ["motivational", { coll: /^motivational-quotes$/, text: /\b(motivational|inspirational quote|quotes?|typography|affirmation)\b/i }],
  ["kitchen", { coll: /^(kitchen|kitchen-prints|cocktails)$/, text: /\b(cocktails?|martini|margarita|coffee|espresso|food|fruits?|wine|tea time|teapot|cafe|bakery|bread|vegetables?|lemons?|spices?)\b/i }],
];
// Kids words are read from the title only: tags such as "playroom" and "cartoon" are room suggestions.
const TITLE_ONLY = new Set(["kids"]);
// A painting in a kids collection is baby/kids art whatever its subject ("Woodland Animal Orchestra" has a
// flute but belongs in a nursery), so that collection is read before every other theme.
const KIDS_COLL = /^(kids-nursery|baby-room|kids-room)$/;
// Music and Balcony read the title only: "Music" and "Floral" also appear as loose style tags. Music needs an
// instrument or musician in the title; the music-and-dance collection also holds dance scenes (Warli circles).
// Deity art with an instrument (Krishna with flute, Saraswati with veena) competes for classical music and devotional sets.
const MUSIC = { title: /\b(music\w*|musicians?|guitar\w*|piano|violin|cello|veena|sitar|tabla|flute|bansuri|drums?|drummers?|saxophone|jazz|vinyl|orchestra|singer|singing|harmonium|ragamala|ragini|taanpura|tanpura)\b/i };
const CLASSICAL_MUSIC = /\b(veena|sitar|tabla|flute|bansuri|harmonium|ragamala|ragini|taanpura|tanpura)\b/i;
const BALCONY = { coll: /^(floral-art|botanical-prints|bird-paintings)$/, title: /\b(botanical\w*|floral|flowers?|blossoms?|birds?|garden\w*|tropical|palms?|ferns?|monstera|succulents?|cactus|leaf|leaves|plants?|butterfl\w*)\b/i };
const DEVOTIONAL_COLL = /^(devotional|lord-[a-z-]+|goddess-[a-z-]+|shrinathji-paintings|radha-kishan|ramayana-paintings)$/;
const TRADITIONAL = /\b(pichwai|gond|madhubani|warli|pattachitra|kalighat|kalamkari|phad|tanjore|mughal|miniature|ragamala|thangka|raja ravi verma|raja-ravi-verma|vintage indian|vintage-indian-art|indian folk art|indian-folk-art|indian-art|indian art|kamdhenu|tree-of-life|kerala mural)\b/i;
const FOLK_MODERN = /\b(gond|warli|madhubani)\b/i;

// Interior descriptors: keywords in tags/collections/title, and the colour mood the room suits.
// L lightness 0-1, S saturation 0-1, W warmth -1 (cool) .. 1 (warm); hue: preferred main hues.
const STYLES = [
  [/classic originals/i, { kw: /\b(famous[- ]artists?|more-famous-painters|monet|van gogh|vincent-van-gogh|sargent|winslow|homer|klimt|picasso|renoir|degas|vermeer|rembrandt|turner|impressionis\w*|oil painting|old masters?|classic art|claude-monet|john-singer-sargent|gustav-klimt|mattise|matisse|hokusai|famous-artists-from-japan)\b/i, kwWeight: 4 } ],
  [/scandinavian|scandi/i, { kw: /\b(minimal\w*|line art|scandinavian|nordic|abstract|botanical|neutral)\b/i, L: 0.72, S: 0.2, W: 0 } ],
  [/warm boho|boho rattan|modern boho|boho/i, { kw: /\b(boho|bohemian|earthy|terracotta|tribal|african|rattan|abstract|botanical|desert)\b/i, L: 0.55, S: 0.4, W: 0.5, hue: ["orange", "brown", "yellow"] } ],
  [/japandi|japanese/i, { kw: /\b(japan\w*|zen|ink|wabi|kamisaka|sekka|ohara|koson|minimal\w*|calm|serene)\b/i, L: 0.6, S: 0.15, W: 0.1 } ],
  [/greige|marble|luxe/i, { kw: /\b(gold\w*|luxur\w*|elegant|abstract|marble|glam\w*|modern art)\b/i, L: 0.55, S: 0.2, W: 0.1, hue: ["grey", "yellow", "brown"] } ],
  [/mid-century|teak mustard/i, { kw: /\b(mid[- ]century|retro|bauhaus|geometric|vintage poster|vintage|travel poster)\b/i, L: 0.5, S: 0.5, W: 0.5, hue: ["orange", "yellow", "teal"] } ],
  [/coastal|ocean blue/i, { kw: /\b(beach\w*|coastal|ocean|sea|seascape|nautical|sail\w*|waves?|fish|whale|beach-vacation)\b/i, L: 0.65, S: 0.35, W: -0.5, hue: ["blue", "teal"] } ],
  [/industrial|monochrome|urban/i, { kw: /\b(monochrome|black and white|black-and-white|pop art|pop-art|banksy|street art|graffiti|urban|city|noir|sketch)\b/i, L: 0.4, S: 0.1, W: 0 } ],
  [/terracotta|mediterranean|goan|portuguese/i, { kw: /\b(mediterranean|moroccan|greek|travel|terracotta|azulejo|goa|portuguese|tiles?)\b/i, L: 0.55, S: 0.45, W: 0.6, hue: ["orange", "blue"] } ],
  [/pastel/i, { kw: /\b(pastel|pink|blush|floral|flowers?|soft|dreamy|whimsical)\b/i, L: 0.75, S: 0.3, W: 0.2, hue: ["pink", "purple"] } ],
  [/jewel|eclectic|rainbow|bold colour/i, { kw: /\b(maximalis\w*|vibrant|colou?rful|pop art|peacock|bold|eclectic|jewel)\b/i, L: 0.45, S: 0.65, W: 0.2 } ],
  [/sage|organic|jungle green/i, { kw: /\b(botanical\w*|leaf|leaves|plants?|nature|tropical|jungle|forest|trees?|green)\b/i, L: 0.55, S: 0.35, W: 0, hue: ["green"] } ],
  [/warm neutral|warm minimal|cream minimal|soft neutral|warm wood|white oak/i, { kw: /\b(neutral|minimal\w*|beige|cream|calm|abstract)\b/i, L: 0.65, S: 0.2, W: 0.3 } ],
  [/space navy/i, { kw: /\b(space|astronaut|rocket|planets?|stars?|galaxy|moon|cosmic|universe)\b/i, kwWeight: 4, L: 0.3, S: 0.4, W: -0.4, hue: ["blue", "purple"] } ],
  [/gym|wellness/i, { kw: /\b(gym|fitness|workout|sports?|yoga|run\w*|athlet\w*|wellness|strength)\b/i, kwWeight: 4, L: 0.4, S: 0.4, W: 0 } ],
  [/student|teen/i, { kw: /\b(student|study|success|hustle|dream|goals?|teen\w*|cool|neon)\b/i, L: 0.5, S: 0.55, W: 0 } ],
  [/kerala|tharavad/i, { kw: /\b(kerala|mural|kathakali|backwaters?|coconut|south indian|tanjore)\b/i, kwWeight: 4, L: 0.45, S: 0.5, W: 0.6 } ],
  [/mughal|courtyard/i, { kw: /\b(mughal|miniature|persian|ragamala|court|nawab|taj)\b/i, kwWeight: 4, L: 0.5, S: 0.45, W: 0.5 } ],
  [/rajasthani|palace|haveli/i, { kw: /\b(rajasthan\w*|palace|pichwai|phad|camel|royal|rajput|haveli)\b/i, kwWeight: 3, L: 0.45, S: 0.55, W: 0.6, hue: ["red", "orange", "yellow"] } ],
  [/chettinad|heritage bungalow/i, { kw: /\b(tanjore|vintage|heritage|raja ravi verma|raja-ravi-verma|classic)\b/i, kwWeight: 3, L: 0.45, S: 0.45, W: 0.5 } ],
  [/contemporary indian|modern boho/i, { kw: /\b(warli|gond|madhubani|folk\w*|tribal|village)\b/i, kwWeight: 3, L: 0.55, S: 0.35, W: 0.4 } ],
  [/indian luxe|contemporary indian|warm minimal indian/i, { kw: /\b(modern|contemporary|minimal\w*|abstract|lotus|gold\w*)\b/i, L: 0.6, S: 0.35, W: 0.4 } ],
  [/everyday home/i, { kw: /\b(minimal\w*|line art|sign|typography|black and white|simple)\b/i, L: 0.65, S: 0.25, W: 0.2 } ],
  [/bright modern/i, { kw: /\b(colou?rful|pop art|bold|retro|vibrant|cartoon|playful)\b/i, L: 0.55, S: 0.5, W: 0.2 } ],
  [/modern studio|vinyl listening|piano corner/i, { kw: /\b(jazz|guitar\w*|piano|vinyl|records?|saxophone|violin|cello|orchestra|musicians?|singer|drums?|poster|abstract)\b/i, kwWeight: 4, L: 0.45, S: 0.4, W: 0.2 } ],
  [/classical/i, { kw: /\b(krishna|radha|saraswati|veena|sitar|tabla|flute|bansuri|harmonium|ragamala|ragini|mughal|pichwai|miniature|kathak|dance|indian)\b/i, kwWeight: 4, L: 0.45, S: 0.5, W: 0.6, hue: ["orange", "red", "yellow"] } ],
  [/verandah|garden sit-out/i, { kw: /\b(tropical|palms?|monstera|jungle|leaf|leaves|birds?|parrots?|garden\w*|trees?|ferns?)\b/i, kwWeight: 2, L: 0.5, S: 0.4, W: 0, hue: ["green"] } ],
  [/sunroom/i, { kw: /\b(floral|flowers?|blossoms?|roses?|botanical\w*|pastel|soft|watercolou?r)\b/i, kwWeight: 2, L: 0.7, S: 0.3, W: 0.2, hue: ["pink", "green", "yellow"] } ],
  [/apartment balcony/i, { kw: /\b(botanical\w*|line art|minimal\w*|leaf|leaves|black and white|monochrome)\b/i, L: 0.5, S: 0.25, W: 0 } ],
  [/home office/i, { kw: /\b(typography|quotes?|motivational|success|maps?|books?|vintage map|globe)\b/i, kwWeight: 2, L: 0.5, S: 0.3, W: 0.3 } ],
  [/reading nook|library den/i, { kw: /\b(books?|reading|library|vintage|botanical illustration|maps?|scholar|typewriter|literature)\b/i, kwWeight: 3, L: 0.55, S: 0.3, W: 0.3 } ],
  [/work desk|student desk/i, { kw: /\b(quotes?|motivational|goals?|hustle|success|books?)\b/i, kwWeight: 2, L: 0.6, S: 0.3, W: 0.1 } ],
  [/foyer|passage|earthy contemporary/i, { kw: /\b(earthy|abstract|boho|landscape|panoram\w*)\b/i, L: 0.55, S: 0.35, W: 0.4 } ],
  [/earthy contemporary/i, { kw: /\b(urban|city|cityscapes?|street art|graffiti|skyscrapers?|architect\w*|contemporary|geometric|collage)\b/i, kwWeight: 2 } ],
  // Abstract and landscape are left to Wide 1 to 3; these two take the distinctly earthy panoramas.
  [/greige mushroom/i, { kw: /\b(neutral|muted|beige|sand|stone|dunes?|desert|calm|minimal\w*)\b/i, L: 0.6, S: 0.25, W: 0.2 } ],
  [/caramel olive/i, { kw: /\b(earthy|rustic|autumn|fields?|countryside|olive|wheat|harvest|farm\w*|village)\b/i, L: 0.45, S: 0.35, W: 0.5, hue: ["green", "brown"] } ],
  [/coastal (blue grey|powder blue|sage|sea glass|deep navy)/i, { kw: /\b(mountains?|himalaya\w*|lakes?|rivers?|sky|skies|clouds?|mist\w*|fog\w*|snow\w*|waterfalls?|seascape|sea|ocean|beach\w*|waves?|coastal)\b/i, kwWeight: 2, L: 0.6, S: 0.3, W: -0.5, hue: ["blue", "teal", "green"] } ],
  [/^heritage (lime wash|red oxide|deep teal|mustard ochre|teak panelled)/i, { kw: /\b(pichwai|tanjore|miniature|mughal|rajasthan\w*|ravi varma|raja-ravi-verma|krishna|radha|ganesh\w*|buddha|shiva|lakshmi|kerala|mural|kalamkari|pattachitra|phad|indian|heritage|temple|elephants?|peacocks?|lotus|royal|palace)\b/i, kwWeight: 4, L: 0.45, S: 0.5, W: 0.5, hue: ["red", "orange", "yellow", "teal"] } ],
];

function setsOnDisk() {
  return fs.readdirSync(SETS_ROOT)
    .map((name) => ({ name, m: name.match(SET_NAME) }))
    .filter(({ name, m }) => m && fs.statSync(path.join(SETS_ROOT, name)).isDirectory())
    .map(({ name, m }) => {
      const styles = STYLES.filter(([re]) => re.test(m[4])).map(([, s]) => s);
      return { name, shape: m[1].toLowerCase(), cls: m[2].toLowerCase(), number: Number(m[3]), interior: m[4], styles };
    });
}

const shapeOf = (r) => (r < 0.65 ? "tall" : r < 0.85 ? "portrait" : r < 1.15 ? "square" : r < 1.55 ? "landscape" : "wide");

function hueName(h, s, l) {
  if (s < 0.12) return l > 0.8 ? "white" : l < 0.2 ? "black" : "grey";
  if (h < 15 || h >= 345) return "red";
  if (h < 40) return l < 0.45 ? "brown" : "orange";
  if (h < 65) return "yellow";
  if (h < 160) return "green";
  if (h < 195) return "teal";
  if (h < 255) return "blue";
  if (h < 290) return "purple";
  return "pink";
}

// Hue families shared with room_palettes.py, and their place on the colour wheel.
const FAMILY_ANGLE = { red: 0, rust: 17, ochre: 31, mustard: 55, green: 115, teal: 180, blue: 225, purple: 270, pink: 317 };
const WARM = new Set(["red", "rust", "ochre", "mustard", "pink"]);
const familyOf = (h) => (h < 12 || h >= 345 ? "red" : h < 22 ? "rust" : h < 40 ? "ochre" : h < 70 ? "mustard" : h < 160 ? "green" : h < 200 ? "teal" : h < 250 ? "blue" : h < 290 ? "purple" : "pink");
const wheel = (a, b) => {
  const d = Math.abs(FAMILY_ANGLE[a] - FAMILY_ANGLE[b]) % 360;
  return d > 180 ? 360 - d : d;
};
const clamp = (x, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x));
const COLOUR_VERSION = 2;

async function measure(file) {
  const { data } = await sharp(file, { limitInputPixels: false }).resize(48, 48, { fit: "fill" }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let L = 0, S = 0, W = 0, n = 0;
  const hues = {}, fam = {};
  for (let i = 0; i < data.length; i += 3) {
    const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
    const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
    let h = 0;
    if (d) h = mx === r ? 60 * (((g - b) / d) % 6) : mx === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4);
    if (h < 0) h += 360;
    L += l; S += s; W += r - b; n++;
    const name = hueName(h, s, l);
    hues[name] = (hues[name] || 0) + 1;
    if (s > 0.38 && l > 0.2 && l < 0.8) fam[familyOf(h)] = (fam[familyOf(h)] || 0) + 1;
  }
  const top = Object.entries(hues).sort((a, b) => b[1] - a[1]).filter(([, c]) => c / n > 0.12).map(([k]) => k).slice(0, 3);
  // Percent of the painting's pixels that are vivid, per hue family (same measure as the room accents).
  const families = Object.fromEntries(Object.entries(fam).sort((a, b) => b[1] - a[1]).map(([k, c]) => [k, +((100 * c) / n).toFixed(1)]).filter(([, v]) => v >= 1));
  return { v: COLOUR_VERSION, L: +(L / n).toFixed(3), S: +(S / n).toFixed(3), W: +Math.max(-1, Math.min(1, (W / n) * 3)).toFixed(3), hues: top, families };
}

function themeOf(text, collections, tags, title) {
  const kidsColl = collections.find((c) => KIDS_COLL.test(c));
  if (kidsColl) return { theme: "kids", why: `collection ${kidsColl}` };
  const deity = isGodPainting(tags) || collections.some((c) => DEVOTIONAL_COLL.test(c));
  // Warli village scenes (dance circles, drummers) are folk art, not music rooms.
  const instrument = /\bwarli\b/i.test(title) ? null : title.match(MUSIC.title);
  if (instrument && (deity || CLASSICAL_MUSIC.test(title))) {
    return { theme: "music", why: `"${instrument[0].toLowerCase()}"${deity ? " (deity: classical music or devotional sets)" : ""}`, deity };
  }
  if (deity) return { theme: "devotional", why: "shows a deity / devotional collection" };
  for (const [theme, rule] of THEME_RULES) {
    const coll = collections.find((c) => rule.coll.test(c));
    if (coll) return { theme, why: `collection ${coll}` };
    const m = (TITLE_ONLY.has(theme) ? title : text).match(rule.text);
    if (m) return { theme, why: `"${m[0].toLowerCase()}"` };
    if (theme === "kids" && instrument) return { theme: "music", why: `"${instrument[0].toLowerCase()}"` };
  }
  const t = text.match(TRADITIONAL);
  if (t) return { theme: "traditional", why: `"${t[0].toLowerCase()}"`, folkModern: FOLK_MODERN.test(text) };
  const coll = collections.find((c) => BALCONY.coll.test(c));
  if (coll) return { theme: "balcony", why: `collection ${coll}` };
  const b = title.match(BALCONY.title);
  return b ? { theme: "balcony", why: `"${b[0].toLowerCase()}"` } : { theme: "modern", why: "contemporary art" };
}

function roomProfile(palette) {
  if (!palette) return null;
  const acc = palette.accents || {};
  const total = Object.values(acc).reduce((a, b) => a + b, 0);
  const warm = Object.entries(acc).filter(([k]) => WARM.has(k)).reduce((a, [, v]) => a + v, 0);
  const wallFam = palette.wallS > 0.15 ? familyOf(palette.wallHue) : null;
  const wallW = wallFam ? (WARM.has(wallFam) ? 0.3 : -0.3) : 0;
  return {
    wallL: palette.wallL,
    wallS: palette.wallS,
    wallFam,
    acc,
    total,
    cool: total - warm,
    warmth: clamp((total ? (warm - (total - warm)) / total : 0) * 0.7 + wallW, -1, 1),
  };
}

// Designer fit of a painting in a set, 0..1, with the parts that explain it.
function fitScore(set, p) {
  const c = p.colour;
  let style = 0, styleWhy = [], styleS, hueBonus = 0;
  for (const s of set.styles) {
    const hits = s.kw ? [...new Set((p.text.match(new RegExp(s.kw.source, "gi")) || []).map((x) => x.toLowerCase()))] : [];
    const v = clamp((Math.min(hits.length, 3) * (s.kwWeight || 1.5)) / 6);
    if (v > style) { style = v; styleWhy = hits.slice(0, 3); }
    if (s.S !== undefined && styleS === undefined) styleS = s.S;
    if (c && s.hue && c.hues.some((h) => s.hue.includes(h))) hueBonus = 0.2;
  }
  const room = set.room;
  if (!c || !room) return { score: WEIGHTS.style * style, why: styleWhy.join(", "), styleHit: style > 0 };

  const fams = Object.entries(c.families || {}).filter(([, v]) => v >= 3);
  const main = fams.length && fams[0][1] >= 5 ? fams[0][0] : null;

  // Wall contrast: lightness first; tone-on-tone needs a clear lightness gap; vivid art may sit on deep walls.
  const dL = Math.abs(c.L - room.wallL);
  // Enough contrast is enough: past a 0.2 lightness gap a darker wall is not better. The frame and mat
  // separate even a close-toned painting a little, so low contrast is weak rather than zero.
  let wall = 0.3 + 0.7 * clamp((dL - 0.05) / 0.15);
  if (main && main === room.wallFam && dL < 0.15) wall *= 0.4;
  if (room.wallL < 0.35 && c.S > 0.45) wall = Math.max(wall, 0.8);

  // Accents: a painting colour repeated in the cushions/decor, or set against them on the colour wheel.
  let accent, accentWhy = "";
  if (room.total < 3) {
    accent = c.S < 0.25 ? 0.6 : 0.3;
  } else {
    let echo = 0, echoFam = null;
    for (const [f] of fams) {
      const v = Math.min(room.acc[f] || 0, 8) / 8;
      if (v > echo) { echo = v; echoFam = f; }
    }
    const against = [...Object.entries(room.acc).filter(([, v]) => v >= 3).map(([k]) => k), ...(room.wallFam ? [room.wallFam] : [])];
    const compFam = fams.filter(([, v]) => v >= 5).map(([f]) => f).find((f) => against.some((a) => wheel(f, a) >= 150));
    const comp = compFam ? 0.75 : 0;
    const clash = main && c.S > 0.5 && echo < 0.2 && Object.entries(room.acc).some(([k, v]) => v >= 8 && wheel(main, k) >= 75 && wheel(main, k) <= 105) ? -0.3 : 0;
    accent = clamp(Math.max(echo, comp) + hueBonus + clash);
    accentWhy = echo >= comp && echo >= 0.4 ? `${echoFam} picked up by the room` : comp ? `${compFam} against ${against.find((a) => wheel(compFam, a) >= 150)}` : clash ? "colour clash" : "";
  }

  // Warmth: cool art in a warm room needs a cool accent or a complementary pairing.
  let warmth = 1 - Math.abs(c.W - room.warmth) / 2;
  if (c.W < 0 && (room.cool >= 2 || accent >= 0.75)) warmth = Math.max(warmth, 0.7);

  // Mood: calm rooms take calm art, bold rooms bold art; black-and-white art suits calm rooms.
  const targetS = styleS ?? clamp(0.15 + room.total / 80, 0.15, 0.6);
  let mood = clamp(1 - Math.abs(c.S - targetS) * 2.5);
  if (c.S < 0.08) mood = targetS <= 0.25 ? 1 : 0.3;

  const score = WEIGHTS.style * style + WEIGHTS.wall * wall + WEIGHTS.accent * accent + WEIGHTS.warmth * warmth + WEIGHTS.mood * mood;
  const why = [styleWhy.join(", "), dL >= 0.25 ? "stands out on the wall" : dL < 0.1 ? "low wall contrast" : "", accentWhy].filter(Boolean).join("; ");
  return { score: +score.toFixed(4), why, styleHit: style > 0, lowContrast: dL < 0.1 && !(room.wallL < 0.35 && c.S > 0.45) };
}

async function main() {
  const crop = readJson(path.join(PREP, "crop-review.json"), {});
  const final = readJson(path.join(PREP, "final-render.json"), {});
  const items = [...readJson(path.join(PREP, "crop-review-items.json"), []), ...readJson(path.join(PREP, "new-batch-items.json"), []),
    ...readJson(path.join(PREP, "pending-items.json"), [])];
  const itemByKey = new Map(items.map((i) => [i.key, i]));
  const catalog = readJson(path.join(HOME, "catalog-products.json"), { products: {} }).products;
  const live = {};
  for (const p of readJson(path.join(LS, "products.json"), [])) {
    const m = String(p.sku || "").match(/^(\d+)/);
    if (m) live[m[1]] = p;
  }
  const colours = readJson(COLOUR_CACHE, {});
  const palettes = readJson(PALETTES, null);
  if (!palettes) throw new Error(`No room palettes; run python scripts/frames/room_palettes.py first (${PALETTES})`);
  const sets = setsOnDisk();
  for (const s of sets) s.room = roomProfile(palettes[s.name]);
  const missing = sets.filter((s) => !s.room).map((s) => s.name);
  if (missing.length) console.warn(`no palette for ${missing.length} sets (run room_palettes.py): ${missing.join(", ")}`);
  const setByName = new Map(sets.map((s) => [s.name, s]));
  const twinOf = new Map(TWINS.flatMap(([a, b]) => [[a, b], [b, a]]));

  const paintings = [];
  for (const [key, review] of Object.entries(crop)) {
    if (review.status === "delete") continue;
    const item = itemByKey.get(key);
    if (!item) continue;
    const stem = item.file.replace(/\.[^.]+$/, "");
    const number = stem.replace(/[A-Z]+$/i, "");
    const px = final[key]?.printable_px;
    const ratio = px ? px[0] / px[1] : review.recipe?.target || item.target || item.w / item.h;
    const cat = catalog[number] || {}, lv = live[number] || {};
    const tags = [...(cat.tags || []), ...(lv.tags || [])];
    const collections = lv.collections || [];
    const title = cat.title || lv.title || "";
    const text = [title, ...tags, ...collections, ...(cat.colors || [])].join(" | ").toLowerCase();
    const image = final[key]?.optimised || item.path || path.join("C:\\Users\\divya\\Downloads\\_Existing Catalog Correction", item.folder, item.file);
    paintings.push({ key, stem, number, shape: shapeOf(ratio), title, tags, collections, text, image, hasData: tags.length > 0 });
  }

  let measured = 0;
  for (const p of paintings) {
    const sig = fs.existsSync(p.image) ? `${p.image}|${fs.statSync(p.image).mtimeMs}` : null;
    if (sig && (colours[p.stem]?.sig !== sig || colours[p.stem]?.v !== COLOUR_VERSION)) {
      try {
        colours[p.stem] = { sig, ...(await measure(p.image)) };
        if (++measured % 200 === 0) { fs.writeFileSync(COLOUR_CACHE, JSON.stringify(colours)); console.log(`colours ${measured}`); }
      } catch (e) { console.warn(`colour ${p.stem}: ${e.message}`); }
    }
    p.colour = colours[p.stem] || null;
  }
  fs.writeFileSync(COLOUR_CACHE, JSON.stringify(colours));

  // Candidate sets and designer-fit scores per painting.
  for (const p of paintings) {
    const t = p.shape === "wide" || p.shape === "tall" ? { theme: "statement", why: p.shape === "wide" ? "16:9" : "9:16" } : themeOf(p.text, p.collections, p.tags, p.title);
    const shapeSets = sets.filter((s) => s.shape === p.shape);
    let pool = shapeSets.filter((s) => POOL[t.theme].includes(s.cls));
    // Deities only in classical music rooms or devotional rooms.
    if (t.theme === "music" && t.deity) pool = shapeSets.filter((s) => (s.cls === "music" && /classical/i.test(s.interior)) || s.cls === "devotional");
    // Traditional work goes in Mixed sets only when it is modern-friendly folk art.
    if (t.theme === "traditional" && !t.folkModern && pool.some((s) => s.cls === "traditional")) pool = pool.filter((s) => s.cls !== "mixed");
    let theme = t.theme, themeWhy = t.why;
    if (!pool.length) {
      pool = shapeSets.filter((s) => POOL.modern.includes(s.cls));
      themeWhy = `${t.theme} (no ${p.shape} ${t.theme} set, so Modern)`;
      theme = "modern";
      p.fallback = true;
    }
    p.theme = theme;
    p.themeWhy = themeWhy;
    p.deity = Boolean(t.deity);
    const scored = new Map(pool.map((s) => [s.name, fitScore(s, p)]));
    for (const [name, f] of scored) {
      const twin = scored.get(twinOf.get(name));
      if (twin && twin.score > f.score) scored.set(name, { ...twin });
    }
    p.ranked = [...scored].map(([set, f]) => ({ set, ...f }))
      .sort((a, b) => b.score - a.score || a.set.localeCompare(b.set, undefined, { numeric: true }));
  }

  const load = new Map();
  const bump = (name, d) => load.set(name, (load.get(name) || 0) + d);
  // A painting you already approved keeps the set it was approved in.
  const previous = readJson(OUT, {}).paintings || {};
  const decisions = readJson(path.join(LS, "set-assign-review.json"), {});
  for (const p of paintings) {
    const d = decisions[p.stem];
    const kept = d?.status === "approved" && !d.set && previous[p.stem]?.set;
    const keepable = p.theme !== "kids" || p.ranked.some((r) => r.set === kept);
    if (kept && keepable && sets.some((s) => s.name === kept)) {
      p.pick = p.ranked.find((r) => r.set === kept) || { set: kept, score: 0, why: "" };
      p.kept = true;
      bump(kept, 1);
    }
  }
  // Fit first: the most decided paintings are placed first; sets within NEAR_TIE of the best share by load.
  const margin = (p) => (p.ranked.length > 1 ? p.ranked[0].score - p.ranked[1].score : 99);
  for (const p of [...paintings].filter((x) => !x.kept).sort((a, b) => margin(b) - margin(a) || a.stem.localeCompare(b.stem))) {
    const best = p.ranked[0].score;
    const near = p.ranked.filter((r) => r.score >= best * NEAR_TIE);
    const pick = near.sort((a, b) => (load.get(a.set) || 0) - (load.get(b.set) || 0) || b.score - a.score)[0];
    p.pick = pick;
    p.nearTie = pick.score < best;
    p.weakFit = best < WEAK_FIT;
    bump(pick.set, 1);
  }

  // Sparse sets may take a painting from a neighbouring theme that fits them genuinely well.
  const borrowed = [];
  for (const s of sets.filter((x) => (load.get(x.name) || 0) < SPARSE)) {
    const lenders = new Set([...(BORROW_FROM[s.cls] || []), ...Object.keys(POOL).filter((t) => POOL[t].includes(s.cls))]);
    const offers = paintings
      .filter((p) => !p.kept && p.shape === s.shape && lenders.has(p.theme) && !(p.theme === "music" && p.deity) && p.pick.set !== s.name && (load.get(p.pick.set) || 0) > SPARSE_FILL)
      .map((p) => ({ p, f: fitScore(s, p) }))
      .filter(({ p, f }) => f.styleHit && f.score >= p.pick.score * SPARSE_FIT)
      .filter(({ p }) => POOL[p.theme].includes(s.cls) || BORROW_SUBJECT[s.cls]?.test(p.title))
      .sort((a, b) => b.f.score / b.p.pick.score - a.f.score / a.p.pick.score);
    for (const { p, f } of offers) {
      if ((load.get(s.name) || 0) >= SPARSE_FILL) break;
      if ((load.get(p.pick.set) || 0) <= SPARSE_FILL) continue;
      bump(p.pick.set, -1);
      p.borrowedFrom = p.pick.set;
      p.pick = { set: s.name, ...f };
      bump(s.name, 1);
      borrowed.push(p.stem);
    }
  }

  const out = {};
  for (const p of paintings.sort((a, b) => a.stem.localeCompare(b.stem, undefined, { numeric: true }))) {
    const runner = p.ranked.find((r) => r.set !== p.pick.set);
    if (p.kept && previous[p.stem]) {
      out[p.stem] = { ...previous[p.stem], options: p.ranked.map((r) => r.set) };
      continue;
    }
    const flags = [
      p.weakFit && "weak fit in every set",
      p.borrowedFrom && `taken from ${p.borrowedFrom} (sparse set)`,
      p.fallback && "theme fallback",
      p.ranked.every((r) => r.lowContrast) && "low wall contrast everywhere",
    ].filter(Boolean);
    const style = p.pick.why ? ` · ${p.pick.why}` : "";
    out[p.stem] = {
      key: p.key,
      shape: p.shape,
      theme: p.theme,
      set: p.pick.set,
      score: p.pick.score,
      runnerUp: runner?.set || null,
      flags,
      reason: `${p.theme[0].toUpperCase() + p.theme.slice(1)}: ${p.themeWhy}${style}${flags.length ? ` · ${flags.join(" · ")}` : ""}${p.hasData ? "" : " · no tags, colours only"}`,
      title: p.title,
      image: p.image,
      options: p.ranked.map((r) => r.set),
    };
  }
  fs.mkdirSync(LS, { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), paintings: out }, null, 1));

  // Report: counts per set, crowded sets with what their paintings share, exceptions.
  const bySet = {};
  for (const [stem, v] of Object.entries(out)) (bySet[v.set] ||= []).push(stem);
  const crowded = Object.entries(bySet).filter(([, l]) => l.length > CROWDED).map(([name, list]) => {
    const cs = list.map((stem) => colours[stem]).filter(Boolean);
    const avg = (k) => +(cs.reduce((a, c) => a + c[k], 0) / Math.max(cs.length, 1)).toFixed(2);
    const fam = {};
    for (const c of cs) for (const [k, v] of Object.entries(c.families || {})) if (v >= 5) fam[k] = (fam[k] || 0) + 1;
    const light = cs.filter((c) => c.L > 0.6).length, dark = cs.filter((c) => c.L < 0.4).length;
    return {
      set: name,
      paintings: list.length,
      siblingsSuggested: Math.max(1, Math.round(list.length / 60) - 1),
      avgLightness: avg("L"),
      avgSaturation: avg("S"),
      lightShare: +(light / Math.max(cs.length, 1)).toFixed(2),
      darkShare: +(dark / Math.max(cs.length, 1)).toFixed(2),
      mainColours: Object.entries(fam).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, n]) => `${k} ${Math.round((100 * n) / cs.length)}%`),
      wall: setByName.get(name)?.room ? { lightness: setByName.get(name).room.wallL, colour: setByName.get(name).room.wallFam || "neutral" } : null,
    };
  });
  const exceptions = Object.entries(out).filter(([, v]) => v.flags?.length).map(([stem, v]) => ({ stem, set: v.set, flags: v.flags, title: v.title }));
  const counts = sets.map((s) => ({ set: s.name, theme: s.cls, shape: s.shape, paintings: bySet[s.name]?.length || 0 }));
  fs.writeFileSync(REPORT, JSON.stringify({ generatedAt: new Date().toISOString(), counts, crowded, exceptions, borrowed }, null, 1));

  const byTheme = {};
  for (const v of Object.values(out)) byTheme[`${v.shape} ${v.theme}`] = (byTheme[`${v.shape} ${v.theme}`] || 0) + 1;
  console.log(`${Object.keys(out).length} paintings, ${measured} newly measured -> ${OUT}`);
  console.log(byTheme);
  for (const c of counts) console.log(String(c.paintings).padStart(5), c.set);
  console.log(`crowded (> ${CROWDED}): ${crowded.length}; exceptions: ${exceptions.length}; taken by sparse sets: ${borrowed.length} -> ${REPORT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
