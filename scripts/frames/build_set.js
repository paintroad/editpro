// Build a frame set folder from generated room images: correct each frame to the exact
// painting shape, copy the black base frame, and record window quads in frame-quads.json.
//   node scripts/frames/build_set.js <setFolderName> <orientation> "<Room Label>=<image>" ...
// Rooms are numbered 2, 3, ... in the order given. Fails if any room cannot be corrected.
// An image of "@<set>/<file>" copies a room already built in another new set, with its quad.
// Markers before the image ("canvas:", "edge:", "god:", "nongod:", "thin:", "cover:") are explained below.
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { loadSettings } = require("../../lib/catalog-pipeline");
const { newSetsDir } = require("./paths");

const QUADS = path.join(__dirname, "..", "frame-quads.json");
const BASE_SOURCE = { portrait: "Portrait", landscape: "Landscape", square: "Square" };

function fitFrame(orientation, src, dst) {
  const out = execFileSync("python", [path.join(__dirname, "fit_frame.py"), orientation, src, dst], { encoding: "utf8" });
  return JSON.parse(out.trim().split("\n").pop());
}

const [setName, orientation, ...rooms] = process.argv.slice(2);
if (!setName || !BASE_SOURCE[orientation] || !rooms.length) {
  console.error('usage: build_set.js <setFolderName> <orientation> "<Room Label>=<image>" ...');
  process.exit(1);
}
if (!setName.toLowerCase().startsWith(`${orientation} `)) {
  console.error(`set name must start with "${orientation} "`);
  process.exit(1);
}

const root = loadSettings().frameTemplatesPath;
const dir = path.join(newSetsDir(), setName);
fs.mkdirSync(newSetsDir(), { recursive: true });
const staging = path.join(require("os").tmpdir(), "editpro-frame-staging", setName);
fs.rmSync(staging, { recursive: true, force: true });
fs.mkdirSync(staging, { recursive: true });

const quads = JSON.parse(fs.readFileSync(QUADS, "utf8"));
const entries = {};
const shape = orientation[0].toUpperCase() + orientation.slice(1);
const baseName = `1. Base ${shape} Black.png`;
fs.copyFileSync(path.join(root, BASE_SOURCE[orientation], baseName), path.join(staging, baseName));
entries[baseName] = quads.quads[BASE_SOURCE[orientation]][baseName];

let failed = false;
rooms.forEach((spec, i) => {
  const [label, rawSrc] = spec.split("=");
  const file = `${i + 2}. ${label.trim()}.jpg`;
  // Markers before the image, e.g. "god:edge:<image>". "canvas" is a frameless stretched canvas
  // and "edge" a frame without a mat (the painting runs right to the edge); "god" rooms are used
  // only for god paintings and "nongod" rooms replace them for every other painting. A matted
  // room's mat is narrowed to a thin strip ("thin", one per set) or covered by the painting
  // ("cover"). Every room may grow over plain wall when its frame looks small, and mouldings
  // are thinned to 4% of the painting's shorter side (frames we sell are not thicker).
  let src = rawSrc.trim();
  const marks = new Set();
  for (let m; (m = src.match(/^(canvas|edge|god|nongod|thin|cover):/)); src = src.slice(m[0].length)) marks.add(m[1]);
  const markMeta = {
    grow: true,
    ...(marks.has("canvas") || marks.has("god") ? {} : { mouldingMax: 0.04 }),
    ...(marks.has("canvas") ? { canvas: true } : {}),
    ...(marks.has("edge") ? { edgeToEdge: true } : {}),
    ...(marks.has("thin") ? { mat: "thin" } : {}),
    ...(marks.has("cover") ? { mat: "cover" } : {}),
    ...(marks.has("god") ? { godOnly: true } : {}),
    ...(marks.has("nongod") ? { nonGod: true } : {}),
  };
  // "@<set>/<file>" reuses a room already corrected in another new set, with its quad.
  const reuse = src.trim().match(/^@(.+)\/([^/]+)$/);
  if (reuse) {
    const [, fromSet, fromFile] = reuse;
    const entry = quads.quads[fromSet]?.[fromFile];
    if (!entry) {
      console.log(file, `no quad for ${fromSet}/${fromFile}`);
      failed = true;
      return;
    }
    fs.copyFileSync(path.join(newSetsDir(), fromSet, fromFile), path.join(staging, file));
    entries[file] = { ...entry, meta: { ...entry.meta, ...markMeta, reusedFrom: `${fromSet}/${fromFile}` } };
    console.log(file, "reused", `${fromSet}/${fromFile}`);
    return;
  }
  const result = fitFrame(orientation, src.trim(), path.join(staging, file));
  console.log(file, JSON.stringify(result));
  if (!result.pass) {
    failed = true;
    return;
  }
  entries[file] = {
    points: result.quad,
    meta: {
      width: 1080,
      height: 1080,
      method: "fit-frame+1px",
      orientation: shape,
      stretchPct: result.stretchPct,
      ...markMeta,
    },
  };
});

if (failed) {
  console.error("Some rooms failed; set not installed. Staging kept at", staging);
  process.exit(1);
}
fs.rmSync(dir, { recursive: true, force: true });
fs.cpSync(staging, dir, { recursive: true });
fs.rmSync(staging, { recursive: true, force: true });
quads.quads[setName] = entries;
fs.writeFileSync(QUADS, JSON.stringify(quads, null, 2) + "\n");
console.log("installed", dir);
