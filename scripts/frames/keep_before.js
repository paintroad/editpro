// Keep a "before" copy of lifestyle-set rooms ahead of a rework round, for the set review page:
// the room image, its sample renders and its frame-quads entry go to
// ~/.editpro/lifestyle-sets/before/<set>/. A room already kept is left alone, so the copy
// always shows what the reviewer last saw.
//   node scripts/frames/keep_before.js "<set>/<room file>" ...
const fs = require("fs");
const os = require("os");
const path = require("path");
const { newSetsDir } = require("./paths");

const BEFORE = path.join(os.homedir(), ".editpro", "lifestyle-sets", "before");
const quads = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "frame-quads.json"), "utf8")).quads;

let kept = 0;
for (const key of process.argv.slice(2)) {
  const i = key.indexOf("/");
  const set = key.slice(0, i);
  const file = key.slice(i + 1);
  const dir = path.join(BEFORE, set);
  if (fs.existsSync(path.join(dir, file))) continue;
  const src = path.join(newSetsDir(), set);
  fs.mkdirSync(path.join(dir, "Samples"), { recursive: true });
  fs.copyFileSync(path.join(src, file), path.join(dir, file));
  const stem = file.replace(/\.[^.]+$/, "");
  const samples = path.join(src, "Samples");
  if (fs.existsSync(samples)) {
    for (const s of fs.readdirSync(samples)) {
      if (s.replace(/\.[^.]+$/, "").endsWith(` - ${stem}`)) fs.copyFileSync(path.join(samples, s), path.join(dir, "Samples", s));
    }
  }
  const qfile = path.join(dir, "quads.json");
  const q = fs.existsSync(qfile) ? JSON.parse(fs.readFileSync(qfile, "utf8")) : {};
  q[file] = quads[set]?.[file] || null;
  fs.writeFileSync(qfile, JSON.stringify(q, null, 1));
  kept++;
}
console.log("kept", kept);
