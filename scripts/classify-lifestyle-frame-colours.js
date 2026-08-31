/**
 * Batch-classify lifestyle frame colours into image-room-map.json.
 *
 * Prefers local generated catalog images; skips entries that already have frameColour
 * unless --force. Base-frame rows (source base-frame) are skipped.
 *
 * Usage:
 *   node scripts/classify-lifestyle-frame-colours.js
 *   node scripts/classify-lifestyle-frame-colours.js --limit=50
 *   node scripts/classify-lifestyle-frame-colours.js --force
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const { loadImageRoomMap } = require("../lib/image-room-store");
const { ensurePythonReady } = require("../lib/python-setup");

const GENERATED_ROOT =
  process.env.EDITPRO_GENERATED_CATALOG ||
  "C:\\Users\\divya\\Downloads\\_Generated Catalog Images";
const FRAMES_ROOT =
  process.env.EDITPRO_FRAME_REFERENCES || "C:\\Users\\divya\\Downloads\\_Frame References";

function parseArgs(argv) {
  let limit = null;
  let force = false;
  for (const arg of argv) {
    if (arg === "--force") force = true;
    if (arg.startsWith("--limit=")) {
      const n = Number(arg.slice("--limit=".length));
      if (Number.isFinite(n) && n >= 1) limit = Math.floor(n);
    }
  }
  return { limit, force };
}

function resolveLocalPath(entry) {
  if (entry.localPath && fs.existsSync(entry.localPath)) {
    return entry.localPath;
  }
  const filename = entry.filename || (entry.url || "").split("/").pop()?.split("?")[0];
  if (!filename) return null;
  const handle = entry.handle || "";
  const candidates = [
    path.join(GENERATED_ROOT, handle, filename),
    path.join(GENERATED_ROOT, String(entry.resourceTitle || ""), filename),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  if (!fs.existsSync(GENERATED_ROOT)) return null;
  for (const dir of fs.readdirSync(GENERATED_ROOT, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const p = path.join(GENERATED_ROOT, dir.name, filename);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function guessFrameSet(entry) {
  return entry.frameSet || "Portrait";
}

function guessTemplate(entry) {
  if (entry.frameTemplate) return entry.frameTemplate;
  const idx = Number(entry.imageIndex) || 0;
  if (idx <= 1) return "";
  return `${idx}. Unknown.jpg`;
}

(async () => {
  const { limit, force } = parseArgs(process.argv.slice(2));
  const env = await ensurePythonReady();

  const store = loadImageRoomMap();
  const items = [];
  for (const [mapKey, entry] of Object.entries(store.mappings || {})) {
    if (entry.source === "base-frame" || entry.source === "portrait") continue;
    if (!force && entry.frameColour) continue;
    const imagePath = resolveLocalPath(entry);
    if (!imagePath) continue;
    if (/_1_(black|white|wooden)\.jpg$/i.test(path.basename(imagePath))) continue;
    items.push({
      mapKey,
      imagePath,
      frameSet: guessFrameSet(entry),
      frameTemplate: guessTemplate(entry),
    });
  }

  if (limit) {
    items.splice(limit);
  }
  console.log(`Classifying ${items.length} lifestyle images…`);
  if (!items.length) {
    console.log("Nothing to classify (need local paths under Generated Catalog Images).");
    return;
  }

  const batchPath = path.join(os.tmpdir(), `editpro-frame-colour-${Date.now()}.json`);
  fs.writeFileSync(batchPath, JSON.stringify({ items }, null, 2), "utf8");

  const command = env?.pythonPath;
  const argsPrefix = env?.argsPrefix || [];
  if (!command) {
    throw new Error("Python not configured.");
  }

  const scriptPath = path.join(__dirname, "detect-frame-colour.py");
  const stdout = await new Promise((resolve, reject) => {
    const child = spawn(
      command,
      [
        ...argsPrefix,
        scriptPath,
        "--batch-json",
        batchPath,
        "--frames-root",
        FRAMES_ROOT,
        "--apply-map",
      ],
      { windowsHide: true, cwd: path.join(__dirname) }
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => {
      out += c.toString();
    });
    child.stderr.on("data", (c) => {
      err += c.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(err || out || `exit ${code}`));
      else resolve(out);
    });
  });

  console.log(stdout.trim());
})().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
