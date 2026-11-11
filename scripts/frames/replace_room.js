// Replace one room of an installed new-style set with a reworked image, or change its markers.
// The image is corrected by fit_frame.py and written over the room file; its frame-quads entry
// gets the new quad and the markers' meta (same markers as build_set.js), plus "scale=<0..1>"
// to shrink the frame (relative to its grown size). Run keep_before.js first.
//   node scripts/frames/replace_room.js "<set>" "<room file>" <image|-> [edge|canvas|cover|thin|mat|scale=0.8 ...]
// "-" keeps the current image and quad and only changes the meta; "mat" keeps a generated mat.
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { newSetsDir } = require("./paths");

const QUADS = path.join(__dirname, "..", "frame-quads.json");
const ORIENT = /^(portrait|landscape|square|wide|tall)\b/i;

const [setName, file, src, ...marks] = process.argv.slice(2);
const orientation = (setName.match(ORIENT) || [])[1]?.toLowerCase();
if (!orientation || !file || !src) {
  console.error('usage: replace_room.js "<set>" "<room file>" <image|-> [markers...]');
  process.exit(1);
}
const quads = JSON.parse(fs.readFileSync(QUADS, "utf8"));
const entry = quads.quads[setName]?.[file];
if (!entry) {
  console.error(`no quad for ${setName}/${file}`);
  process.exit(1);
}
const set = new Set(marks.filter((m) => !m.startsWith("scale=")));
const scale = Number((marks.find((m) => m.startsWith("scale=")) || "").slice(6)) || null;
const dst = path.join(newSetsDir(), setName, file);

let points = entry.points;
let fit = {};
if (src !== "-") {
  const tmp = path.join(require("os").tmpdir(), `replace_room_${process.pid}.jpg`);
  const out = execFileSync("python", [path.join(__dirname, "fit_frame.py"), orientation, src, tmp], { encoding: "utf8" });
  const result = JSON.parse(out.trim().split("\n").pop());
  if (!result.pass) {
    console.error(`${setName}/${file}: fit_frame failed (${result.reason})`);
    process.exit(1);
  }
  fs.copyFileSync(tmp, dst);
  fs.rmSync(tmp, { force: true });
  points = result.quad;
  fit = { method: "fit-frame+1px", stretchPct: result.stretchPct };
}
entry.points = points;
const reworked = new Date().toISOString().slice(0, 10);
if (src === "-" && !set.size) {
  const { scale: _s, ...meta } = entry.meta;
  entry.meta = { ...meta, ...(scale ? { scale } : {}), reworked };
} else {
  entry.meta = {
    width: 1080,
    height: 1080,
    ...(src === "-" ? { method: entry.meta.method, stretchPct: entry.meta.stretchPct } : fit),
    orientation: entry.meta.orientation,
    grow: true,
    ...(set.has("canvas") ? { canvas: true } : { mouldingMax: 0.04 }),
    ...(set.has("edge") ? { edgeToEdge: true } : {}),
    ...(set.has("thin") ? { mat: "thin" } : {}),
    ...(set.has("cover") ? { mat: "cover" } : {}),
    ...(set.has("mat") ? { thinMat: true } : {}),
    ...(scale ? { scale } : {}),
    ...(entry.meta.godOnly ? { godOnly: true } : {}),
    ...(entry.meta.nonGod ? { nonGod: true } : {}),
    ...(src === "-" && entry.meta.rim ? { rim: entry.meta.rim } : {}),
    reworked,
  };
}
fs.writeFileSync(QUADS, JSON.stringify(quads, null, 2) + "\n");
console.log(`${setName}/${file}`, JSON.stringify(entry.meta));
