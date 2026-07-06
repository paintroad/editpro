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

function resolveOrientationFrameDir(rootPath, orientation) {
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

function listFramesForOrientation(rootPath, orientation) {
  const frameDir = resolveOrientationFrameDir(rootPath, orientation);
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
    });
  }

  if (!frames.length) {
    throw new Error(
      `No valid frame templates in ${path.basename(frameDir)}. Use names like "2. Hall.jpg".`
    );
  }

  frames.sort((a, b) => a.outputIndex - b.outputIndex);
  return { frames, skipped, frameDir };
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

  const folderName = path.basename(normalizedPath).toLowerCase();
  const directOrientation = Object.entries(ORIENTATION_FOLDER_NAMES).find(
    ([, name]) => name.toLowerCase() === folderName
  );

  if (directOrientation) {
    const [key] = directOrientation;
    try {
      const { frames } = listFramesForOrientation(normalizedPath, key);
      summary[key] = frames.length;
    } catch (error) {
      summary.errors.push(error.message);
    }
    return summary;
  }

  for (const [key, name] of Object.entries(ORIENTATION_FOLDER_NAMES)) {
    try {
      const { frames } = listFramesForOrientation(normalizedPath, key);
      summary[key] = frames.length;
    } catch (error) {
      summary.errors.push(`${name}: ${error.message}`);
    }
  }
  return summary;
}

function validateFrameTemplatesForProducts(rootPath, products) {
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
    try {
      const { frames, frameDir } = listFramesForOrientation(normalizedPath, orientation);
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

module.exports = {
  ORIENTATION_FOLDER_NAMES,
  normalizeFrameTemplatesPath,
  parseFrameTemplateFilename,
  resolveOrientationFrameDir,
  listFramesForOrientation,
  summarizeFrameTemplates,
  validateFrameTemplatesForProducts,
};
