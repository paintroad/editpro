/**
 * One-time: generate Black/White/Wooden base catalog images for live paintings.
 *
 * Usage:
 *   node scripts/generate-base-frame-catalog.js
 *   node scripts/generate-base-frame-catalog.js --limit=5
 *   node scripts/generate-base-frame-catalog.js --force
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const {
  listBaseFramesForOrientation,
  frameSetsForProducts,
} = require("../lib/frame-template-parser");
const { ensurePythonReady, runCompositorManifest } = require("../lib/python-setup");
const {
  createMutableStore,
  upsertInStore,
  flushStore,
} = require("../lib/image-room-store");

const PAINTINGS_ROOT =
  process.env.EDITPRO_LIVE_PAINTINGS || "C:\\Paintroad\\Files\\Print_Optimised_Live";
const FRAMES_ROOT =
  process.env.EDITPRO_FRAME_REFERENCES || "C:\\Users\\divya\\Downloads\\_Frame References";
const OUTPUT_ROOT =
  process.env.EDITPRO_GENERATED_CATALOG ||
  "C:\\Users\\divya\\Downloads\\_Generated Catalog Images";

const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp"]);

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

function collectPaintings(root) {
  if (!fs.existsSync(root)) {
    throw new Error(`Paintings folder not found: ${root}`);
  }
  const items = [];
  const entries = fs.readdirSync(root, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (!IMAGE_EXT.has(ext) || entry.name.startsWith(".")) continue;
      const stem = path.basename(entry.name, ext);
      items.push({
        productId: stem,
        paintingPath: path.join(root, entry.name),
        folderName: stem,
      });
      continue;
    }
    if (!entry.isDirectory() || entry.name.startsWith("_") || entry.name.startsWith(".")) {
      continue;
    }
    // Nested range folders or product folders
    const dirPath = path.join(root, entry.name);
    const nested = fs.readdirSync(dirPath, { withFileTypes: true });
    const portrait =
      nested.find((f) => f.isFile() && f.name.toLowerCase() === `${entry.name.toLowerCase()}_0.jpg`) ||
      nested.find((f) => f.isFile() && IMAGE_EXT.has(path.extname(f.name).toLowerCase()) && /_0\./i.test(f.name)) ||
      nested.find((f) => f.isFile() && IMAGE_EXT.has(path.extname(f.name).toLowerCase()));
    if (portrait && portrait.isFile()) {
      items.push({
        productId: entry.name,
        paintingPath: path.join(dirPath, portrait.name),
        folderName: path.basename(portrait.name, path.extname(portrait.name)),
      });
      continue;
    }
    // Range folder containing product subfolders
    for (const child of nested) {
      if (!child.isDirectory()) continue;
      const productDir = path.join(dirPath, child.name);
      const files = fs.readdirSync(productDir, { withFileTypes: true });
      const p0 =
        files.find((f) => f.isFile() && f.name.toLowerCase() === `${child.name.toLowerCase()}_0.jpg`) ||
        files.find((f) => f.isFile() && /_0\./i.test(f.name));
      if (!p0) continue;
      items.push({
        productId: child.name,
        paintingPath: path.join(productDir, p0.name),
        folderName: path.basename(p0.name, path.extname(p0.name)),
      });
    }
  }

  return items.sort((a, b) => a.productId.localeCompare(b.productId, undefined, { numeric: true }));
}

async function detectOrientations(products) {
  const env = await ensurePythonReady();
  const { spawn } = require("child_process");
  const command = env?.pythonPath;
  const argsPrefix = env?.argsPrefix || [];
  if (!command) {
    throw new Error("Python not configured.");
  }

  const listPath = path.join(os.tmpdir(), `editpro-orient-fast-${Date.now()}.json`);
  const scriptPath = path.join(os.tmpdir(), `editpro-orient-fast-${Date.now()}.py`);
  fs.writeFileSync(
    listPath,
    JSON.stringify(
      products.map((p) => ({ productId: p.productId, imagePath: p.paintingPath }))
    ),
    "utf8"
  );
  fs.writeFileSync(
    scriptPath,
    `
import json, sys, cv2
sys.path.insert(0, r${JSON.stringify(path.join(__dirname))})
from painting_orientation import orientation_from_aspect_ratio
items = json.load(open(sys.argv[1], encoding="utf-8"))
out = []
for e in items:
    path = e.get("imagePath") or ""
    pid = e.get("productId")
    im = cv2.imread(path, cv2.IMREAD_COLOR)
    if im is None:
        out.append({"productId": pid, "orientation": None, "error": "read failed"})
        continue
    h, w = im.shape[:2]
    aspect = (w / h) if h else 0
    out.append({
        "productId": pid,
        "orientation": orientation_from_aspect_ratio(aspect),
        "aspectRatio": round(aspect, 4),
    })
print(json.dumps({"results": out}))
`,
    "utf8"
  );

  const stdout = await new Promise((resolve, reject) => {
    const child = spawn(command, [...argsPrefix, scriptPath, listPath], {
      windowsHide: true,
      cwd: path.join(__dirname),
    });
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

  const parsed = JSON.parse(stdout.trim());
  const byId = new Map();
  for (const row of parsed.results || []) {
    byId.set(String(row.productId), row);
  }
  return byId;
}

function expectedBaseFiles(folderName) {
  return ["black", "white", "wooden"].map((c) => `${folderName}_1_${c}.jpg`);
}

function allBasesExist(outputDir, folderName) {
  return expectedBaseFiles(folderName).every((name) => fs.existsSync(path.join(outputDir, name)));
}

(async () => {
  const { limit, force } = parseArgs(process.argv.slice(2));
  console.log("Paintings:", PAINTINGS_ROOT);
  console.log("Frames:", FRAMES_ROOT);
  console.log("Output:", OUTPUT_ROOT);

  await ensurePythonReady();
  fs.mkdirSync(OUTPUT_ROOT, { recursive: true });

  let paintings = collectPaintings(PAINTINGS_ROOT);
  console.log(`Found ${paintings.length} paintings`);
  if (limit) {
    paintings = paintings.slice(0, limit);
    console.log(`Limited to ${paintings.length}`);
  }

  console.log("Detecting orientations…");
  const orientations = await detectOrientations(paintings);

  const defaults = frameSetsForProducts(
    FRAMES_ROOT,
    paintings.map((p) => ({
      orientation: orientations.get(p.productId)?.orientation || "portrait",
    }))
  ).defaults;

  const mapStore = createMutableStore();
  let created = 0;
  let skipped = 0;
  let errors = 0;

  for (let i = 0; i < paintings.length; i++) {
    const item = paintings[i];
    const orientRow = orientations.get(item.productId);
    const orientation = String(orientRow?.orientation || "").toLowerCase();
    if (!orientation) {
      console.log(`[${i + 1}/${paintings.length}] SKIP ${item.productId}: no orientation`);
      errors += 1;
      continue;
    }

    const outputDir = path.join(OUTPUT_ROOT, item.folderName);
    if (!force && allBasesExist(outputDir, item.folderName)) {
      skipped += 1;
      if ((i + 1) % 100 === 0) {
        console.log(`[${i + 1}/${paintings.length}] skipped existing…`);
      }
      // Still ensure map entries
      for (const colour of ["Black", "White", "Wooden"]) {
        const filename = `${item.folderName}_1_${colour.toLowerCase()}.jpg`;
        const localPath = path.join(outputDir, filename);
        upsertInStore(
          mapStore,
          {
            fileId: `local:catalog:${item.folderName}:${filename}`,
            handle: item.productId,
            resourceType: "product",
            resourceId: `local:product:${item.productId}`,
            resourceTitle: item.productId,
            imageIndex: 1,
            frameColour: colour,
            localPath,
            url: "",
          },
          {
            room: "none",
            source: "base-frame",
            frameColour: colour,
            localPath,
          }
        );
      }
      continue;
    }

    const frameSetName = defaults[orientation] || null;
    let bases;
    try {
      bases = listBaseFramesForOrientation(FRAMES_ROOT, orientation, frameSetName).frames;
    } catch (error) {
      console.log(`[${i + 1}/${paintings.length}] ERROR ${item.productId}: ${error.message}`);
      errors += 1;
      continue;
    }
    if (!bases.length) {
      console.log(`[${i + 1}/${paintings.length}] ERROR ${item.productId}: no base frames`);
      errors += 1;
      continue;
    }

    fs.mkdirSync(outputDir, { recursive: true });
    const frames = bases.map((frame) => ({
      framePath: frame.framePath,
      outputIndex: frame.outputIndex,
      room: "none",
      roomLabel: frame.roomLabel,
      frameTemplate: frame.frameTemplate,
      frameSet: frame.frameSet,
      frameColour: frame.frameColour,
      isBase: true,
      outputSuffix: frame.outputSuffix,
      orientation,
    }));

    const manifestPath = path.join(
      os.tmpdir(),
      `editpro-base-${item.productId}-${Date.now()}.json`
    );
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        paintingPath: item.paintingPath,
        frames,
        outputDir,
        outputBaseName: item.folderName,
        size: 1080,
        jpegQuality: 88,
      }),
      "utf8"
    );

    try {
      const compositor = runCompositorManifest(manifestPath);
      const result = await compositor.promise;
      const images = result.images || [];
      created += images.length;
      for (const img of images) {
        const colour = img.frameColour || null;
        upsertInStore(
          mapStore,
          {
            fileId: `local:catalog:${item.folderName}:${img.filename}`,
            handle: item.productId,
            resourceType: "product",
            resourceId: `local:product:${item.productId}`,
            resourceTitle: item.productId,
            imageIndex: img.index || 1,
            frameColour: colour,
            localPath: img.path,
            url: "",
          },
          {
            room: "none",
            source: "base-frame",
            frameColour: colour,
            localPath: img.path,
          }
        );
      }
      if (result.errors?.length) {
        errors += result.errors.length;
        console.log(
          `[${i + 1}/${paintings.length}] PARTIAL ${item.productId}: ${result.errors.map((e) => e.message).join("; ")}`
        );
      } else {
        console.log(
          `[${i + 1}/${paintings.length}] OK ${item.productId} (${orientation}) → ${images.length} bases`
        );
      }
    } catch (error) {
      errors += 1;
      console.log(`[${i + 1}/${paintings.length}] ERROR ${item.productId}: ${error.message}`);
    }

    if ((i + 1) % 25 === 0) {
      flushStore(mapStore);
    }
  }

  flushStore(mapStore);
  console.log(
    JSON.stringify(
      { paintings: paintings.length, created, skipped, errors, output: OUTPUT_ROOT },
      null,
      2
    )
  );
})().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
