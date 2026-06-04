const express = require("express");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const app = express();
const PORT = process.env.PORT || 3847;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

function listFilesInFolder(folderPath) {
  const entries = fs.readdirSync(folderPath, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const fullPath = path.join(folderPath, entry.name);
      const stat = fs.statSync(fullPath);
      return {
        name: entry.name,
        extension: path.extname(entry.name),
        size: stat.size,
        modified: stat.mtime.toISOString(),
      };
    });

  return files;
}

function sortFiles(files, sortBy) {
  const sorted = [...files];
  switch (sortBy) {
    case "modified-asc":
      sorted.sort((a, b) => new Date(a.modified) - new Date(b.modified));
      break;
    case "modified-desc":
      sorted.sort((a, b) => new Date(b.modified) - new Date(a.modified));
      break;
    case "name-desc":
      sorted.sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }));
      break;
    case "name-asc":
    default:
      sorted.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      break;
  }
  return sorted;
}

function buildRenamePlan(folderPath, options) {
  const {
    startNumber,
    gap = 1,
    padding = 0,
    prefix = "",
    suffix = "",
    sortBy = "name-asc",
  } = options;

  const start = Number(startNumber);
  if (!Number.isInteger(start) || start < 0) {
    throw new Error("Start number must be a non-negative integer.");
  }

  const step = Number(gap);
  if (!Number.isInteger(step) || step < 1) {
    throw new Error("Gap must be a positive integer.");
  }

  const paddingDigits = Number(padding);
  if (!Number.isInteger(paddingDigits) || paddingDigits < 0 || paddingDigits > 10) {
    throw new Error("Padding must be an integer between 0 and 10.");
  }

  const files = sortFiles(listFilesInFolder(folderPath), sortBy);
  const plan = files.map((file, index) => {
    const number = start + index * step;
    const padded = paddingDigits > 0
      ? String(number).padStart(paddingDigits, "0")
      : String(number);
    const newName = `${prefix}${padded}${suffix}${file.extension}`;

    return {
      oldName: file.name,
      newName,
      extension: file.extension,
    };
  });

  const newNames = new Set(plan.map((item) => item.newName.toLowerCase()));
  if (newNames.size !== plan.length) {
    throw new Error("Rename plan would create duplicate file names. Adjust your settings.");
  }

  for (const item of plan) {
    if (item.oldName.toLowerCase() === item.newName.toLowerCase()) {
      continue;
    }
    const targetPath = path.join(folderPath, item.newName);
    if (fs.existsSync(targetPath)) {
      const alreadyPlanned = plan.some(
        (p) => p.oldName.toLowerCase() === item.newName.toLowerCase()
      );
      if (!alreadyPlanned) {
        throw new Error(`Target name already exists: ${item.newName}`);
      }
    }
  }

  return plan;
}

function executeRename(folderPath, plan) {
  const toRename = plan.filter(
    (item) => item.oldName.toLowerCase() !== item.newName.toLowerCase()
  );

  if (toRename.length === 0) {
    return { renamed: 0, skipped: plan.length };
  }

  const tempPrefix = `.__renamer_${Date.now()}_`;
  const tempMoves = [];

  try {
    for (let i = 0; i < toRename.length; i++) {
      const item = toRename[i];
      const tempName = `${tempPrefix}${i}${item.extension}`;
      const fromPath = path.join(folderPath, item.oldName);
      const tempPath = path.join(folderPath, tempName);
      fs.renameSync(fromPath, tempPath);
      tempMoves.push({ tempPath, finalName: item.newName });
    }

    for (const move of tempMoves) {
      const finalPath = path.join(folderPath, move.finalName);
      fs.renameSync(move.tempPath, finalPath);
    }

    return { renamed: toRename.length, skipped: plan.length - toRename.length };
  } catch (error) {
    for (const move of tempMoves) {
      if (fs.existsSync(move.tempPath)) {
        const original = toRename[tempMoves.indexOf(move)];
        if (original) {
          try {
            fs.renameSync(move.tempPath, path.join(folderPath, original.oldName));
          } catch {
            // Best-effort rollback
          }
        }
      }
    }
    throw error;
  }
}

app.post("/api/set-folder", (req, res) => {
  try {
    const { folderPath } = req.body;
    if (!folderPath || typeof folderPath !== "string") {
      return res.status(400).json({ error: "Folder path is required." });
    }
    const normalized = path.normalize(folderPath.trim());
    if (!fs.existsSync(normalized)) {
      return res.status(400).json({ error: "Folder does not exist." });
    }
    const stat = fs.statSync(normalized);
    if (!stat.isDirectory()) {
      return res.status(400).json({ error: "Path is not a folder." });
    }
    const files = listFilesInFolder(normalized);
    res.json({ folderPath: normalized, fileCount: files.length, files });
  } catch (error) {
    res.status(500).json({ error: error.message || "Failed to read folder." });
  }
});

app.post("/api/preview", (req, res) => {
  try {
    const { folderPath, startNumber, gap, padding, prefix, suffix, sortBy } = req.body;
    if (!folderPath) {
      return res.status(400).json({ error: "Folder path is required." });
    }
    const plan = buildRenamePlan(folderPath, {
      startNumber,
      gap,
      padding,
      prefix,
      suffix,
      sortBy,
    });
    res.json({ plan, total: plan.length });
  } catch (error) {
    res.status(400).json({ error: error.message || "Failed to build preview." });
  }
});

app.post("/api/rename", (req, res) => {
  try {
    const { folderPath, startNumber, gap, padding, prefix, suffix, sortBy } = req.body;
    if (!folderPath) {
      return res.status(400).json({ error: "Folder path is required." });
    }
    const plan = buildRenamePlan(folderPath, {
      startNumber,
      gap,
      padding,
      prefix,
      suffix,
      sortBy,
    });
    const result = executeRename(folderPath, plan);
    const files = listFilesInFolder(folderPath);
    res.json({ ...result, files, plan });
  } catch (error) {
    res.status(400).json({ error: error.message || "Rename failed." });
  }
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`EditPro running at ${url}`);
  console.log("Press Ctrl+C to stop.");

  if (process.platform === "win32") {
    try {
      execFileSync("cmd", ["/c", "start", "", url], { windowsHide: true });
    } catch {
      console.log(`Open ${url} in your browser.`);
    }
  }
});
