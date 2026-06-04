const folderPathInput = document.getElementById("folderPath");
const folderMeta = document.getElementById("folderMeta");
const browseBtn = document.getElementById("browseBtn");
const applyPathBtn = document.getElementById("applyPathBtn");
const startNumberInput = document.getElementById("startNumber");
const gapInput = document.getElementById("gap");
const paddingInput = document.getElementById("padding");
const prefixInput = document.getElementById("prefix");
const suffixInput = document.getElementById("suffix");
const sortBySelect = document.getElementById("sortBy");
const previewBtn = document.getElementById("previewBtn");
const renameBtn = document.getElementById("renameBtn");
const previewBody = document.getElementById("previewBody");
const previewCount = document.getElementById("previewCount");
const messageEl = document.getElementById("message");

let currentFolder = null;
let currentDirHandle = null;
let currentFileEntries = [];
let currentPlan = [];

function hasActiveFolder() {
  return Boolean(currentFolder || currentDirHandle);
}

function getRenameOptions() {
  return {
    startNumber: Number(startNumberInput.value),
    gap: Number(gapInput.value),
    padding: Number(paddingInput.value),
    prefix: prefixInput.value,
    suffix: suffixInput.value,
    sortBy: sortBySelect.value,
  };
}

function getSettings() {
  return {
    folderPath: currentFolder,
    ...getRenameOptions(),
  };
}

function showMessage(text, type = "error") {
  messageEl.textContent = text;
  messageEl.className = `message ${type}`;
}

function hideMessage() {
  messageEl.className = "message hidden";
}

function updateControls() {
  const hasFolder = hasActiveFolder();
  previewBtn.disabled = !hasFolder;
  renameBtn.disabled = !hasFolder || currentPlan.length === 0;
}

function sortFiles(files, sortBy) {
  const sorted = [...files];
  switch (sortBy) {
    case "modified-asc":
      sorted.sort((a, b) => a.modified - b.modified);
      break;
    case "modified-desc":
      sorted.sort((a, b) => b.modified - a.modified);
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

function getExtension(fileName) {
  const dotIndex = fileName.lastIndexOf(".");
  return dotIndex > 0 ? fileName.slice(dotIndex) : "";
}

function buildRenamePlanFromFiles(files, options) {
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

  const sortedFiles = sortFiles(files, sortBy);
  const existingNames = new Set(files.map((file) => file.name.toLowerCase()));

  const plan = sortedFiles.map((file, index) => {
    const number = start + index * step;
    const padded =
      paddingDigits > 0 ? String(number).padStart(paddingDigits, "0") : String(number);
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
    if (existingNames.has(item.newName.toLowerCase())) {
      const alreadyPlanned = plan.some(
        (entry) => entry.oldName.toLowerCase() === item.newName.toLowerCase()
      );
      if (!alreadyPlanned) {
        throw new Error(`Target name already exists: ${item.newName}`);
      }
    }
  }

  return plan;
}

async function listFilesFromHandle(dirHandle) {
  const files = [];

  for await (const entry of dirHandle.values()) {
    if (entry.kind !== "file") {
      continue;
    }

    const file = await entry.getFile();
    files.push({
      name: entry.name,
      extension: getExtension(entry.name),
      modified: file.lastModified,
      handle: entry,
    });
  }

  return files;
}

async function executeRenameOnHandle(dirHandle, plan) {
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
      const handle = await dirHandle.getFileHandle(item.oldName);
      const tempName = `${tempPrefix}${i}${item.extension}`;
      await handle.move(tempName);
      tempMoves.push({ tempName, finalName: item.newName, oldName: item.oldName });
    }

    for (const move of tempMoves) {
      const handle = await dirHandle.getFileHandle(move.tempName);
      await handle.move(move.finalName);
    }

    return { renamed: toRename.length, skipped: plan.length - toRename.length };
  } catch (error) {
    for (const move of tempMoves) {
      try {
        const handle = await dirHandle.getFileHandle(move.tempName);
        await handle.move(move.oldName);
      } catch {
        // Best-effort rollback
      }
    }
    throw error;
  }
}

function renderPreview(plan) {
  currentPlan = plan;
  previewCount.textContent = `${plan.length} file${plan.length === 1 ? "" : "s"}`;

  if (plan.length === 0) {
    previewBody.innerHTML = `
      <tr class="empty-row">
        <td colspan="4">This folder has no files to rename.</td>
      </tr>
    `;
    updateControls();
    return;
  }

  previewBody.innerHTML = plan
    .map((item, index) => {
      const unchanged = item.oldName === item.newName;
      return `
        <tr class="${unchanged ? "unchanged" : ""}">
          <td>${index + 1}</td>
          <td>${escapeHtml(item.oldName)}</td>
          <td class="arrow">${unchanged ? "—" : "→"}</td>
          <td class="new-name">${escapeHtml(item.newName)}</td>
        </tr>
      `;
    })
    .join("");

  updateControls();
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function apiPost(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Request failed.");
  }
  return data;
}

function setFolderFromHandle(dirHandle, files) {
  currentDirHandle = dirHandle;
  currentFolder = null;
  currentFileEntries = files;
  folderPathInput.value = dirHandle.name;
  folderMeta.textContent = `${files.length} file${files.length === 1 ? "" : "s"} found in "${dirHandle.name}". Browse shows folder name only — use Use path for a full path.`;
  updateControls();
}

function setFolder(folderPath, fileCount) {
  currentFolder = folderPath;
  currentDirHandle = null;
  currentFileEntries = [];
  folderPathInput.value = folderPath;
  folderMeta.textContent = `${fileCount} file${fileCount === 1 ? "" : "s"} found in this folder.`;
  updateControls();
}

async function pickFolder() {
  if (!window.showDirectoryPicker) {
    showMessage(
      "Browse requires Edge or Chrome. Paste a folder path and click Use path.",
      "warning"
    );
    return;
  }

  hideMessage();
  browseBtn.disabled = true;
  browseBtn.textContent = "Opening…";

  try {
    const dirHandle = await window.showDirectoryPicker({ mode: "readwrite" });
    const files = await listFilesFromHandle(dirHandle);
    setFolderFromHandle(dirHandle, files);
    await refreshPreview();
  } catch (error) {
    if (error.name === "AbortError") {
      return;
    }
    showMessage(error.message, "error");
  } finally {
    browseBtn.disabled = false;
    browseBtn.textContent = "Browse…";
  }
}

async function applyFolderPath() {
  const folderPath = folderPathInput.value.trim();
  if (!folderPath) {
    showMessage("Enter a folder path first.", "warning");
    return;
  }

  hideMessage();
  applyPathBtn.disabled = true;
  applyPathBtn.textContent = "Loading…";

  try {
    const data = await apiPost("/api/set-folder", { folderPath });
    setFolder(data.folderPath, data.fileCount);
    await refreshPreview();
  } catch (error) {
    showMessage(error.message, "error");
  } finally {
    applyPathBtn.disabled = false;
    applyPathBtn.textContent = "Use path";
  }
}

async function refreshPreview() {
  if (!hasActiveFolder()) {
    return;
  }

  hideMessage();
  previewBtn.disabled = true;

  try {
    if (currentDirHandle) {
      const plan = buildRenamePlanFromFiles(currentFileEntries, getRenameOptions());
      renderPreview(plan);
    } else {
      const data = await apiPost("/api/preview", getSettings());
      renderPreview(data.plan);
    }
  } catch (error) {
    currentPlan = [];
    renderPreview([]);
    showMessage(error.message, "error");
  } finally {
    previewBtn.disabled = !hasActiveFolder();
  }
}

async function renameFiles() {
  if (!hasActiveFolder() || currentPlan.length === 0) {
    return;
  }

  const changes = currentPlan.filter((item) => item.oldName !== item.newName).length;
  if (changes === 0) {
    showMessage("All files already match the target names.", "warning");
    return;
  }

  const confirmed = window.confirm(
    `Rename ${changes} file${changes === 1 ? "" : "s"} in this folder?\n\nThis cannot be undone automatically.`
  );
  if (!confirmed) {
    return;
  }

  hideMessage();
  renameBtn.disabled = true;
  renameBtn.textContent = "Renaming…";

  try {
    if (currentDirHandle) {
      const result = await executeRenameOnHandle(currentDirHandle, currentPlan);
      const files = await listFilesFromHandle(currentDirHandle);
      setFolderFromHandle(currentDirHandle, files);
      const plan = buildRenamePlanFromFiles(files, getRenameOptions());
      renderPreview(plan);
      showMessage(
        `Successfully renamed ${result.renamed} file${result.renamed === 1 ? "" : "s"}${
          result.skipped ? ` (${result.skipped} unchanged).` : "."
        }`,
        "success"
      );
    } else {
      const data = await apiPost("/api/rename", getSettings());
      setFolder(currentFolder, data.files.length);
      renderPreview(data.plan);
      showMessage(
        `Successfully renamed ${data.renamed} file${data.renamed === 1 ? "" : "s"}${
          data.skipped ? ` (${data.skipped} unchanged).` : "."
        }`,
        "success"
      );
    }
  } catch (error) {
    showMessage(error.message, "error");
  } finally {
    renameBtn.textContent = "Rename files";
    updateControls();
  }
}

browseBtn.addEventListener("click", pickFolder);
applyPathBtn.addEventListener("click", applyFolderPath);
folderPathInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    applyFolderPath();
  }
});
previewBtn.addEventListener("click", refreshPreview);
renameBtn.addEventListener("click", renameFiles);

[startNumberInput, gapInput, paddingInput, prefixInput, suffixInput, sortBySelect].forEach((el) => {
  el.addEventListener("change", () => {
    if (hasActiveFolder()) {
      refreshPreview();
    }
  });
});

updateControls();
