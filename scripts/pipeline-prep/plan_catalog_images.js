// Plan how each live product's new catalog images reach Shopify while keeping image URLs.
// Read-only: no renders, no Shopify calls. Inputs: set-assignments.json (set per painting),
// live-products.json (number -> product) and live-media.json (snapshot_live_media.js).
//
// Per new image, in order of preference:
//   keep     - an old image of the same product already has this exact file name: replace its
//              content in place (same URL).
//   keep-room- an old image's file name names the same room (another position or a synonym such
//              as "dining" for Dining Room): replace in place, URL unchanged.
//   keep-base- the black-frame base image (position 1) replaces the old base in place.
//   new      - no old URL fits: upload under the EditPro name and attach to the product.
// Old gallery images left over are detached from the product (fileUpdate referencesToRemove) and
// stay in Shopify Files. Shared images (features-*.jpg) are not touched.
// Alt text follows the EditPro rule "{{description100}} for {{room}}" with the true room, which is
// what the theme's Shop by Room reads.
//
//   node scripts/pipeline-prep/plan_catalog_images.js [--generic]
//     --generic also keeps URLs whose room word is a filler ("home", "space", "nook" ...).
// Writes ~/.editpro/pipeline-prep/catalog-image-plan.json and Downloads\_Catalog\Catalog Image Plan.csv.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { roomName, sameRoom, slug } = require("./room_names");

const HOME = path.join(os.homedir(), ".editpro");
const SETS_ROOT = "C:\\Users\\divya\\Downloads\\_Frames\\_New Lifestyle Sets";
const OUT = path.join(HOME, "pipeline-prep", "catalog-image-plan.json");
const CSV = "C:\\Users\\divya\\Downloads\\_Catalog\\Catalog Image Plan.csv";
const GENERIC = new Set(["house", "home", "space", "place", "area", "abode", "sweet-home", "lovely-house", "room",
  "interior", "decor", "studio", "gallery", "nook", "retreat", "haven", "dwelling", "residence", "loft", "sanctuary"]);
const OURS = /^(.*)-canvas-painting-for-(.+)-(\d+)\.(jpg|jpeg|png)$/i;

const useGeneric = process.argv.includes("--generic");
const assignments = JSON.parse(fs.readFileSync(path.join(HOME, "lifestyle-sets", "set-assignments.json"), "utf8")).paintings;
const liveProducts = JSON.parse(fs.readFileSync(path.join(HOME, "pipeline-prep", "live-products.json"), "utf8"));
const liveMedia = JSON.parse(fs.readFileSync(path.join(HOME, "pipeline-prep", "live-media.json"), "utf8")).products;
const byNumber = new Map((Array.isArray(liveProducts) ? liveProducts : Object.values(liveProducts)).map((p) => [String(p.number), p]));

const allNames = new Set();
for (const p of Object.values(liveMedia)) for (const m of p.media) if (m.filename) allNames.add(m.filename.toLowerCase());

const setRooms = new Map();
function roomsOf(set) {
  if (setRooms.has(set)) return setRooms.get(set);
  const rooms = [];
  for (const f of fs.readdirSync(path.join(SETS_ROOT, set))) {
    const m = f.match(/^(\d+)\.\s*(.+)\.(jpg|png)$/i);
    if (!m) continue;
    const base = /^base\b/i.test(m[2]);
    if (base && !/black/i.test(m[2])) continue;
    rooms.push({ index: Number(m[1]), label: m[2], base, ext: base ? ".png" : ".jpg", ...(base ? { room: null } : roomName(set, m[2])) });
  }
  rooms.sort((a, b) => a.index - b.index);
  setRooms.set(set, rooms);
  return rooms;
}

const plan = [];
const totals = { products: 0, notLive: 0, images: 0, keep: 0, "keep-room": 0, "keep-base": 0, "keep-generic": 0, new: 0, detach: 0 };
const csv = [["number", "product", "position", "set room", "room", "action", "file name", "old file name"].join(",")];
const q = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;

for (const [number, a] of Object.entries(assignments)) {
  const lp = byNumber.get(String(number));
  const live = lp && liveMedia[lp.id];
  if (!live) { totals.notLive++; continue; }
  totals.products++;
  const titleSlug = slug(live.title);
  const old = live.media
    .map((m) => ({ ...m, parts: m.filename && m.filename.match(OURS) }))
    .filter((m) => m.parts)
    .map((m) => ({ id: m.id, filename: m.filename, word: m.parts[2].toLowerCase(), index: Number(m.parts[3]), ext: path.extname(m.filename).toLowerCase(), position: m.position }));
  const unused = new Set(old);
  const images = [];
  const take = (pred) => {
    const hit = [...unused].find(pred);
    if (hit) unused.delete(hit);
    return hit;
  };

  for (const r of roomsOf(a.set)) {
    const img = { position: r.index, setRoom: r.label, room: r.room };
    if (r.base) {
      const hit = take((o) => o.index === 1 && o.ext === ".png");
      if (hit) Object.assign(img, { action: "keep-base", filename: hit.filename, mediaId: hit.id });
    } else {
      const want = `${titleSlug}-canvas-painting-for-${slug(r.room)}-${r.index}${r.ext}`;
      let hit = take((o) => o.filename.toLowerCase() === want);
      if (hit) Object.assign(img, { action: "keep", filename: hit.filename, mediaId: hit.id });
      if (!hit) {
        hit = take((o) => o.ext === r.ext && sameRoom(o.word, r.room));
        if (hit) Object.assign(img, { action: "keep-room", filename: hit.filename, mediaId: hit.id });
      }
      if (!hit && useGeneric) {
        hit = take((o) => o.ext === r.ext && GENERIC.has(o.word));
        if (hit) Object.assign(img, { action: "keep-generic", filename: hit.filename, mediaId: hit.id });
      }
    }
    images.push(img);
  }
  for (const img of images.filter((i) => !i.action)) {
    const r = { room: img.room, index: img.position, ext: img.room ? ".jpg" : ".png" };
    const word = img.room ? slug(r.room) : "wall";
    let name = `${titleSlug}-canvas-painting-for-${word}-${r.index}${r.ext}`;
    for (let n = 2; allNames.has(name.toLowerCase()); n++) name = `${titleSlug}-canvas-painting-for-${word}-${r.index}-${n}${r.ext}`;
    allNames.add(name.toLowerCase());
    Object.assign(img, { action: "new", filename: name });
  }
  const detach = [...unused].map((o) => ({ mediaId: o.id, filename: o.filename }));

  for (const img of images) {
    totals.images++;
    totals[img.action]++;
    csv.push([number, q(live.title), img.position, q(img.setRoom), q(img.room || "(base)"), img.action, q(img.filename), ""].join(","));
  }
  for (const d of detach) {
    totals.detach++;
    csv.push([number, q(live.title), "", "", "", "detach", "", q(d.filename)].join(","));
  }
  plan.push({ number, productId: lp.id, title: live.title, set: a.set, images, detach });
}

fs.writeFileSync(OUT, JSON.stringify({ createdAt: new Date().toISOString(), generic: useGeneric, totals, plan }, null, 1));
fs.writeFileSync(CSV, csv.join("\n"));
console.log(JSON.stringify(totals, null, 1));
console.log("->", OUT, "\n->", CSV);
