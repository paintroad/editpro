// Install a generated set from ~/.editpro/lifestyle-sets/staging/<set>/ ("NN_<Room Label>.png" files)
// through build_set.js. Markers are given per room in file order (edge, canvas, thin, cover, or - for none; thin installs as none).
//   node scripts/frames/install_staged.js "<Set Name>" <orientation> edge,canvas,edge,thin,...
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const [setName, orientation, markerList] = process.argv.slice(2);
const dir = path.join(os.homedir(), ".editpro", "lifestyle-sets", "staging", setName);
const files = fs.readdirSync(dir).filter((f) => /^\d+_.+\.(png|jpe?g)$/i.test(f)).sort();
const markers = (markerList || "").split(",").map((m) => m.trim());
if (markers.length !== files.length) {
  console.error(`${files.length} rooms but ${markers.length} markers:\n${files.join("\n")}`);
  process.exit(1);
}
const rooms = files.map((f, i) => {
  const label = f.replace(/^\d+_/, "").replace(/\.[^.]+$/, "");
  // Generated mats are already hairline; build_set's "thin" would narrow them again and repaint the
  // window, which leaves a fake light streak, so those rooms keep the grey panel as the art area.
  const mark = markers[i] && !["-", "thin"].includes(markers[i]) ? `${markers[i]}:` : "";
  return `${label}=${mark}${path.join(dir, f)}`;
});
execFileSync("node", [path.join(__dirname, "build_set.js"), setName, orientation, ...rooms], { stdio: "inherit" });
