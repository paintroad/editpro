const express = require("express");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const {
  saveConfig,
  getPublicSettings,
  getShopifyCredentials,
} = require("./lib/config-store");
const {
  loadSyncLog,
  addSyncLogEntry,
  getSyncLogEntry,
  updateSyncLogEntry,
} = require("./lib/sync-log-store");
const { shopifyGraphql, testConnection } = require("./lib/shopify-client");

const app = express();
const PORT = process.env.PORT || 3847;
const BASE_PATH = (process.env.BASE_PATH || "/editpro").replace(/\/$/, "");
const PUBLIC_DIR = path.join(__dirname, "public");
const router = express.Router();

app.use(express.json({ limit: "2mb" }));

function listFilesInFolder(folderPath) {
  const entries = fs.readdirSync(folderPath, { withFileTypes: true });
  return entries
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
    return { oldName: file.name, newName, extension: file.extension };
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
      fs.renameSync(path.join(folderPath, item.oldName), path.join(folderPath, tempName));
      tempMoves.push({ tempPath: path.join(folderPath, tempName), finalName: item.newName });
    }
    for (const move of tempMoves) {
      fs.renameSync(move.tempPath, path.join(folderPath, move.finalName));
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

router.get("/api/settings", (_req, res) => {
  try {
    res.json(getPublicSettings());
  } catch (error) {
    res.status(500).json({ error: error.message || "Failed to load settings." });
  }
});

router.post("/api/settings", (req, res) => {
  try {
    saveConfig(req.body || {});
    res.json(getPublicSettings());
  } catch (error) {
    res.status(400).json({ error: error.message || "Failed to save settings." });
  }
});

router.post("/api/shopify/test", async (_req, res) => {
  try {
    const { storeDomain, accessToken } = getShopifyCredentials();
    const shop = await testConnection(storeDomain, accessToken);
    saveConfig({ shopName: shop.name });
    res.json({ shop });
  } catch (error) {
    res.status(400).json({ error: error.message || "Connection test failed." });
  }
});

router.post("/api/shopify/graphql", async (req, res) => {
  try {
    const { query, variables } = req.body || {};
    if (!query) {
      return res.status(400).json({ error: "GraphQL query is required." });
    }
    const { storeDomain, accessToken } = getShopifyCredentials();
    const data = await shopifyGraphql(storeDomain, accessToken, query, variables || {});
    res.json(data);
  } catch (error) {
    res.status(400).json({ error: error.message || "Shopify request failed." });
  }
});

router.get("/api/sync-log", (_req, res) => {
  try {
    res.json({ entries: loadSyncLog() });
  } catch (error) {
    res.status(500).json({ error: error.message || "Failed to load sync log." });
  }
});

router.post("/api/sync-log", (req, res) => {
  try {
    const entry = addSyncLogEntry(req.body || {});
    res.json({ entry });
  } catch (error) {
    res.status(400).json({ error: error.message || "Failed to save sync log entry." });
  }
});

router.patch("/api/sync-log/:id", (req, res) => {
  try {
    const entry = updateSyncLogEntry(req.params.id, req.body || {});
    if (!entry) {
      return res.status(404).json({ error: "Log entry not found." });
    }
    res.json({ entry });
  } catch (error) {
    res.status(400).json({ error: error.message || "Failed to update sync log entry." });
  }
});

router.get("/api/sync-log/:id", (req, res) => {
  try {
    const entry = getSyncLogEntry(req.params.id);
    if (!entry) {
      return res.status(404).json({ error: "Log entry not found." });
    }
    res.json({ entry });
  } catch (error) {
    res.status(500).json({ error: error.message || "Failed to load sync log entry." });
  }
});

router.post("/api/set-folder", (req, res) => {
  try {
    const { folderPath } = req.body;
    if (!folderPath || typeof folderPath !== "string") {
      return res.status(400).json({ error: "Folder path is required." });
    }
    const normalized = path.normalize(folderPath.trim());
    if (!fs.existsSync(normalized)) {
      return res.status(400).json({ error: "Folder does not exist." });
    }
    if (!fs.statSync(normalized).isDirectory()) {
      return res.status(400).json({ error: "Path is not a folder." });
    }
    const files = listFilesInFolder(normalized);
    res.json({ folderPath: normalized, fileCount: files.length, files });
  } catch (error) {
    res.status(500).json({ error: error.message || "Failed to read folder." });
  }
});

router.post("/api/preview", (req, res) => {
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

router.post("/api/rename", (req, res) => {
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

router.get("/api/health", (_req, res) => {
  res.json({ ok: true, basePath: BASE_PATH });
});

router.use(express.static(PUBLIC_DIR));
router.get("/", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

app.use(BASE_PATH, router);
app.get("/", (_req, res) => {
  res.redirect(`${BASE_PATH}/`);
});

app.listen(PORT, () => {
  const directUrl = `http://localhost:${PORT}${BASE_PATH}/`;
  const proxyUrl = `http://localhost${BASE_PATH}/`;
  console.log(`EditPro running at ${directUrl}`);
  console.log(`With port-80 proxy: ${proxyUrl}`);
  console.log("Press Ctrl+C to stop.");

  if (process.platform === "win32") {
    try {
      execFileSync("cmd", ["/c", "start", "", directUrl], { windowsHide: true });
    } catch {
      console.log(`Open ${directUrl} in your browser.`);
    }
  }
});
