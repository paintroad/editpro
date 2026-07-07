const fs = require("fs");
const path = require("path");
const { normalizeRoomLabel } = require("./room-detector");

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

const ORIENTATION_FOLDER_NAMES = {
  portrait: "Portrait",
  landscape: "Landscape",
  square: "Square",
};

function isImageFile(name) {
  return IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase());
}

function normalizeFrameTemplatesPath(rawPath) {
  let value = String(rawPath || "").trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1).trim();
  }
  return value;
}

function orientationForFrameSetName(folderName) {
  const key = String(folderName || "").trim().toLowerCase();
  if (ORIENTATION_FOLDER_NAMES[key]) {
    return key;
  }
  for (const orientKey of Object.keys(ORIENTATION_FOLDER_NAMES)) {
    if (key.startsWith(`${orientKey} `)) {
      return orientKey;
    }
  }
  return null;
}

function countParseableFramesInDir(dirPath) {
  const files = fs
    .readdirSync(dirPath)
    .filter((name) => isImageFile(name) && !name.startsWith("."));
  let count = 0;
  for (const filename of files) {
    if (parseFrameTemplateFilename(filename)) {
      count += 1;
    }
  }
  return count;
}

function parseFrameTemplateFilename(filename) {
  const stem = path.basename(filename, path.extname(filename));
  const tokens = stem.split(/[.\s]+/).filter(Boolean);
  if (!tokens.length) {
    return null;
  }

  const index = parseInt(tokens[0], 10);
  if (!Number.isFinite(index) || index < 1) {
    return null;
  }

  const roomLabel = tokens.slice(1).join(" ").trim();
  if (!roomLabel) {
    return null;
  }

  return {
    index,
    roomLabel,
    room: normalizeRoomLabel(roomLabel),
  };
}

function listFrameSetFolders(rootPath) {
  const normalizedPath = normalizeFrameTemplatesPath(rootPath);
  if (!normalizedPath || !fs.existsSync(normalizedPath)) {
    return [];
  }
  const stat = fs.statSync(normalizedPath);
  if (!stat.isDirectory()) {
    return [];
  }

  const folderName = path.basename(normalizedPath);
  const directOrientation = orientationForFrameSetName(folderName);
  if (directOrientation && countParseableFramesInDir(normalizedPath) > 0) {
    return [{ name: folderName, orientation: directOrientation, path: normalizedPath }];
  }

  const entries = fs.readdirSync(normalizedPath, { withFileTypes: true });
  const sets = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith("_") || entry.name.startsWith(".")) {
      continue;
    }
    const orientation = orientationForFrameSetName(entry.name);
    if (!orientation) {
      continue;
    }
    const dirPath = path.join(normalizedPath, entry.name);
    const frameCount = countParseableFramesInDir(dirPath);
    if (frameCount > 0) {
      sets.push({ name: entry.name, orientation, path: dirPath, frameCount });
    }
  }
  return sets.sort((a, b) => {
    if (a.orientation !== b.orientation) {
      return a.orientation.localeCompare(b.orientation);
    }
    return a.name.localeCompare(b.name, undefined, { numeric: true });
  });
}

function listFrameSets(rootPath) {
  const result = { portrait: [], landscape: [], square: [] };
  for (const set of listFrameSetFolders(rootPath)) {
    if (result[set.orientation]) {
      result[set.orientation].push({
        name: set.name,
        frameCount: set.frameCount,
      });
    }
  }
  return result;
}

function resolveOrientationFrameDir(rootPath, orientation, frameSetName) {
  const key = String(orientation || "").toLowerCase().trim();
  const expectedName = ORIENTATION_FOLDER_NAMES[key];
  if (!expectedName) {
    throw new Error(`Unknown orientation "${orientation}". Expected portrait, landscape, or square.`);
  }
  const normalizedPath = normalizeFrameTemplatesPath(rootPath);
  if (!normalizedPath || !fs.existsSync(normalizedPath)) {
    throw new Error("Frame templates folder not found.");
  }
  const stat = fs.statSync(normalizedPath);
  if (!stat.isDirectory()) {
    throw new Error("Frame templates path must be a folder.");
  }

  if (frameSetName) {
    const setName = String(frameSetName).trim();
    const setPath = path.join(normalizedPath, setName);
    if (!fs.existsSync(setPath) || !fs.statSync(setPath).isDirectory()) {
      throw new Error(`Frame set folder "${setName}" not found under frame templates path.`);
    }
    const setOrientation = orientationForFrameSetName(setName);
    if (setOrientation !== key) {
      throw new Error(`Frame set "${setName}" is not valid for orientation ${orientation}.`);
    }
    if (countParseableFramesInDir(setPath) < 1) {
      throw new Error(`No valid frame templates in "${setName}".`);
    }
    return setPath;
  }

  const folderName = path.basename(normalizedPath);
  if (folderName.toLowerCase() === expectedName.toLowerCase() && countParseableFramesInDir(normalizedPath) > 0) {
    return normalizedPath;
  }

  const entries = fs.readdirSync(normalizedPath, { withFileTypes: true });
  const match = entries.find(
    (entry) => entry.isDirectory() && entry.name.toLowerCase() === expectedName.toLowerCase()
  );
  if (!match) {
    throw new Error(`Orientation folder "${expectedName}" not found under frame templates path.`);
  }
  return path.join(normalizedPath, match.name);
}

function listFramesForOrientation(rootPath, orientation, frameSetName) {
  const frameDir = resolveOrientationFrameDir(rootPath, orientation, frameSetName);
  const frameSet = path.basename(frameDir);
  const files = fs
    .readdirSync(frameDir)
    .filter((name) => isImageFile(name) && !name.startsWith("."))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  const frames = [];
  const skipped = [];
  const seenIndices = new Map();

  for (const filename of files) {
    const parsed = parseFrameTemplateFilename(filename);
    if (!parsed) {
      skipped.push({ filename, reason: "Could not parse index and room from filename." });
      continue;
    }

    if (seenIndices.has(parsed.index)) {
      throw new Error(
        `Duplicate frame index ${parsed.index} in ${path.basename(frameDir)} (${seenIndices.get(parsed.index)}, ${filename}).`
      );
    }
    seenIndices.set(parsed.index, filename);

    frames.push({
      framePath: path.join(frameDir, filename),
      outputIndex: parsed.index,
      room: parsed.room,
      roomLabel: parsed.roomLabel,
      frameTemplate: filename,
      frameSet,
    });
  }

  if (!frames.length) {
    throw new Error(
      `No valid frame templates in ${path.basename(frameDir)}. Use names like "2. Hall.jpg".`
    );
  }

  frames.sort((a, b) => a.outputIndex - b.outputIndex);
  return { frames, skipped, frameDir, frameSet };
}

function summarizeFrameTemplates(rootPath) {
  const normalizedPath = normalizeFrameTemplatesPath(rootPath);
  const summary = { portrait: 0, landscape: 0, square: 0, errors: [] };
  if (!normalizedPath || !fs.existsSync(normalizedPath)) {
    summary.errors.push("Frame templates folder not found.");
    return summary;
  }
  const stat = fs.statSync(normalizedPath);
  if (!stat.isDirectory()) {
    summary.errors.push("Frame templates path must be a folder.");
    return summary;
  }

  const sets = listFrameSets(normalizedPath);
  for (const [key, items] of Object.entries(sets)) {
    summary[key] = items.reduce((sum, item) => sum + (item.frameCount || 0), 0);
    if (!items.length) {
      const expectedName = ORIENTATION_FOLDER_NAMES[key];
      summary.errors.push(`${expectedName}: No frame set folders found.`);
    }
  }
  return summary;
}

function validateFrameTemplatesForProducts(rootPath, products, frameSets) {
  const normalizedPath = normalizeFrameTemplatesPath(rootPath);
  if (!normalizedPath || !fs.existsSync(normalizedPath)) {
    throw new Error("Frame templates folder not found.");
  }
  if (!fs.statSync(normalizedPath).isDirectory()) {
    throw new Error("Frame templates path must be a folder.");
  }

  const orientations = new Set();
  for (const product of products) {
    const orientation = String(product.orientation || "").trim().toLowerCase();
    if (!orientation) {
      throw new Error("Product orientation is required. Run orientation detection first.");
    }
    orientations.add(orientation);
  }

  for (const orientation of orientations) {
    const expectedName = ORIENTATION_FOLDER_NAMES[orientation] || orientation;
    const frameSetName = frameSets?.[orientation] || null;
    try {
      const { frames, frameDir } = listFramesForOrientation(normalizedPath, orientation, frameSetName);
      if (!frames.length) {
        throw new Error(
          `No frame templates found for ${orientation} in "${frameDir}". Expected files like "1. Null.jpg".`
        );
      }
    } catch (error) {
      throw new Error(
        `No frame templates found for ${orientation} in "${expectedName}" under ${normalizedPath}. Expected files like "1. Null.jpg". ${error.message}`
      );
    }
  }

  return normalizedPath;
}

function frameSetsForProducts(rootPath, products) {
  const normalizedPath = normalizeFrameTemplatesPath(rootPath);
  const allSets = listFrameSets(normalizedPath);
  const orientations = new Set();
  for (const product of products) {
    const orientation = String(product.orientation || "").trim().toLowerCase();
    if (orientation) {
      orientations.add(orientation);
    }
  }

  const byOrientation = {};
  const needsChoice = [];
  for (const orientation of orientations) {
    const sets = allSets[orientation] || [];
    byOrientation[orientation] = sets;
    if (sets.length > 1) {
      needsChoice.push(orientation);
    }
  }

  return {
    frameSets: byOrientation,
    needsChoice,
    defaults: Object.fromEntries(
      Object.entries(byOrientation).map(([orientation, sets]) => [
        orientation,
        sets[0]?.name || ORIENTATION_FOLDER_NAMES[orientation],
      ])
    ),
  };
}

module.exports = {
  ORIENTATION_FOLDER_NAMES,
  normalizeFrameTemplatesPath,
  orientationForFrameSetName,
  parseFrameTemplateFilename,
  listFrameSetFolders,
  listFrameSets,
  resolveOrientationFrameDir,
  listFramesForOrientation,
  summarizeFrameTemplates,
  validateFrameTemplatesForProducts,
  frameSetsForProducts,
};
