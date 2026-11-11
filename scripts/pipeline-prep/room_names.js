// The room a lifestyle-set image shows, as a plain room name for image file names and alt text
// ("Dining Sideboard" -> "Dining Room"). Labels that only describe a corner ("Plant Corner Wall",
// "Bench With Cushions") take the room of their set's theme.
//   roomName("Portrait Balcony 2 - Boho Terracotta Balcony", "Rattan Egg Chair Corner") -> "Balcony"

// Ordered: the first matching rule wins.
const RULES = [
  [/toilet|towel|bathroom|washbasin|vanity|shower|powder room/i, "Bathroom"],
  [/nursery|crib|changing area|play mat/i, "Nursery"],
  [/kids|bunk bed|toddler bed|dorm style|toy |play corner/i, "Kids Room"],
  [/bedroom|wardrobe/i, "Bedroom"],
  [/home temple/i, "Pooja Room"],
  [/kitchen|counter lean|coffee|pantry|breakfast|island seating|laundry/i, "Kitchen"],
  [/dining|banquette/i, "Dining Room"],
  [/balcony|veranda|sit-out|deck |deck$|porch|garden|outdoor|planter box/i, "Balcony"],
  [/sunroom/i, "Sunroom"],
  [/guitar|piano|harmonium|sitar|tabla|veena|tanpura|flute|cello|drum|keyboard|ukulele|riyaz|concert|vinyl|record|turntable|speaker|headphone|music/i, "Music Room"],
  [/gym|workout|cycling/i, "Home Gym"],
  [/yoga/i, "Yoga Room"],
  [/home office|office|credenza|dual monitor|computer desk|laptop desk|standing desk|work corner|home studio desk/i, "Home Office"],
  [/study|desk|library|exam prep/i, "Study"],
  [/reading|book |book$|window seat|tea and book/i, "Reading Nook"],
  [/hallway|passage|staircase/i, "Hallway"],
  [/entrance|foyer|lift lobby/i, "Entrance"],
  [/living|sitting|lounge|family room|sectional|sofa|divan|baithak|chesterfield|armchair|double height|courtyard hall|^hall$|floor cushion|floor lamp|between living/i, "Living Room"],
];

// Room for labels that name no room, by the set's theme (second word of the set name).
const THEME_ROOM = {
  balcony: "Balcony",
  kitchen: "Kitchen",
  study: "Study",
  music: "Music Room",
  kids: "Kids Room",
  bathroom: "Bathroom",
  devotional: "Living Room",
  motivational: "Study",
};

function setTheme(setName) {
  const m = String(setName).match(/^\w+\s+(\w+)/);
  return m ? m[1].toLowerCase() : "";
}

function roomName(setName, label) {
  const text = String(label || "").trim();
  for (const [re, room] of RULES) if (re.test(text)) return { room, how: "label" };
  return { room: THEME_ROOM[setTheme(setName)] || "Living Room", how: "set theme" };
}

const slug = (s) => String(s || "").toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "").replace(/-+/g, "-").replace(/^-|-$/g, "");

// File-name words that describe the same room, so an old URL may stay on a new image of that room.
const SAME_ROOM = [
  ["living-room", "living-space", "family-room", "sitting-area", "lounge"],
  ["dining-room", "dining"],
  ["bedroom", "master-bedroom"],
  ["study", "study-room"],
  ["home-office", "office"],
  ["entrance", "entryway", "foyer"],
  ["hallway"],
  ["kitchen"],
  ["bathroom"],
  ["balcony", "veranda", "verandah"],
  ["kids-room"],
  ["nursery"],
];
const GROUP = new Map(SAME_ROOM.flatMap((g, i) => g.map((w) => [w, i])));

function sameRoom(oldWord, newRoom) {
  const a = slug(oldWord);
  const b = slug(newRoom);
  if (a === b) return true;
  return GROUP.has(a) && GROUP.get(a) === GROUP.get(b);
}

module.exports = { roomName, sameRoom, slug, setTheme };
