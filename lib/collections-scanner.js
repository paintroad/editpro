const fs = require("fs");
const path = require("path");

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);

function isImageFile(name) {
  return IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase());
}

function deriveRelevance(filename) {
  const name = String(filename || "");
  if (/^\d{5}\.[a-z0-9]+$/i.test(name)) {
    return "relevant";
  }
  return "irrelevant";
}

function normalizeRootPath(rootPath) {
  const normalized = path.normalize(String(rootPath || "").trim());
  if (!normalized) {
    throw new Error("Folder path is required.");
  }
  if (!fs.existsSync(normalized)) {
    throw new Error("Folder does not exist.");
  }
  if (!fs.statSync(normalized).isDirectory()) {
    throw new Error("Path is not a folder.");
  }
  return path.resolve(normalized);
}

function toPosixRelative(root, absolutePath) {
  return path.relative(root, absolutePath).split(path.sep).join("/");
}

function tagsFromRelativePath(relativePath) {
  const dir = path.posix.dirname(relativePath.replace(/\\/g, "/"));
  if (!dir || dir === ".") {
    return [];
  }
  return dir.split("/").filter(Boolean);
}

function resolveUnderRoot(rootPath, relativePath) {
  const root = normalizeRootPath(rootPath);
  const safeRelative = String(relativePath || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");
  if (safeRelative.includes("..")) {
    throw new Error("Invalid relative path.");
  }
  const target = path.resolve(root, safeRelative);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error("Path escapes collection root.");
  }
  return target;
}

function walkImages(root, currentDir, images) {
  const entries = fs.readdirSync(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      walkImages(root, fullPath, images);
      continue;
    }
    if (!entry.isFile() || !isImageFile(entry.name)) {
      continue;
    }
    const relativePath = toPosixRelative(root, fullPath);
    const stat = fs.statSync(fullPath);
    images.push({
      id: entry.name,
      filename: entry.name,
      relativePath,
      tags: tagsFromRelativePath(relativePath),
      relevance: deriveRelevance(entry.name),
      size: stat.size,
      modified: stat.mtime.toISOString(),
    });
  }
}

function scanCollectionRoot(rootPath) {
  const root = normalizeRootPath(rootPath);
  const images = [];
  walkImages(root, root, images);
  images.sort((a, b) => {
    const pathCmp = a.relativePath.localeCompare(b.relativePath, undefined, { sensitivity: "base" });
    if (pathCmp !== 0) {
      return pathCmp;
    }
    return a.filename.localeCompare(b.filename, undefined, { sensitivity: "base" });
  });

  const tagSet = new Set();
  for (const image of images) {
    for (const tag of image.tags) {
      tagSet.add(tag);
    }
  }
  const tagOptions = [...tagSet].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));

  return {
    rootPath: root,
    images,
    total: images.length,
    tagOptions,
    scannedAt: new Date().toISOString(),
  };
}

module.exports = {
  scanCollectionRoot,
  resolveUnderRoot,
  isImageFile,
  deriveRelevance,
  normalizeRootPath,
};
