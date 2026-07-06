const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn, spawnSync } = require("child_process");
const https = require("https");

const CONFIG_DIR = path.join(os.homedir(), ".editpro");
const PYTHON_ENV_PATH = path.join(CONFIG_DIR, "python-env.json");
const CACHE_DIR = path.join(CONFIG_DIR, "cache");
const REQUIREMENTS_PATH = path.join(__dirname, "..", "requirements-lifestyle.txt");
const PYTHON_INSTALLER_URL =
  "https://www.python.org/ftp/python/3.12.7/python-3.12.7-amd64.exe";

let setupInFlight = null;

function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

function loadPythonEnv() {
  ensureConfigDir();
  if (!fs.existsSync(PYTHON_ENV_PATH)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(PYTHON_ENV_PATH, "utf8"));
  } catch {
    return null;
  }
}

function savePythonEnv(data) {
  ensureConfigDir();
  fs.writeFileSync(PYTHON_ENV_PATH, JSON.stringify(data, null, 2), "utf8");
}

function runSync(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    windowsHide: true,
    ...options,
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim(),
    error: result.error,
  };
}

function parseVersion(output) {
  const match = String(output || "").match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    return null;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    text: match[0],
  };
}

function versionOk(version) {
  if (!version) {
    return false;
  }
  return version.major > 3 || (version.major === 3 && version.minor >= 10);
}

function tryPythonExecutable(command, argsPrefix = []) {
  const versionRun = runSync(command, [...argsPrefix, "--version"]);
  if (!versionRun.ok) {
    return null;
  }
  const version = parseVersion(versionRun.stdout || versionRun.stderr);
  if (!versionOk(version)) {
    return null;
  }
  return { command, argsPrefix, version: version.text };
}

function getSystemPath() {
  if (process.platform !== "win32") {
    return process.env.PATH || "";
  }
  const parts = [];
  try {
    const machine = runSync("powershell", [
      "-NoProfile",
      "-Command",
      "[Environment]::GetEnvironmentVariable('Path','Machine')",
    ]);
    if (machine.ok && machine.stdout) {
      parts.push(machine.stdout);
    }
    const user = runSync("powershell", [
      "-NoProfile",
      "-Command",
      "[Environment]::GetEnvironmentVariable('Path','User')",
    ]);
    if (user.ok && user.stdout) {
      parts.push(user.stdout);
    }
  } catch {
    // ignore
  }
  if (process.env.PATH) {
    parts.push(process.env.PATH);
  }
  return [...new Set(parts.join(";").split(";").filter(Boolean))].join(";");
}

function discoverWindowsPythonExecutables() {
  if (process.platform !== "win32") {
    return [];
  }
  const found = [];
  const localAppData = process.env.LOCALAPDATA || path.join(os.homedir(), "AppData", "Local");
  const pythonRoot = path.join(localAppData, "Programs", "Python");
  if (fs.existsSync(pythonRoot)) {
    for (const entry of fs.readdirSync(pythonRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const exe = path.join(pythonRoot, entry.name, "python.exe");
      if (fs.existsSync(exe)) {
        found.push(exe);
      }
    }
  }
  const launcher = path.join(localAppData, "Programs", "Python", "Launcher", "py.exe");
  if (fs.existsSync(launcher)) {
    found.push(launcher);
  }
  const wherePy = runSync("where.exe", ["py"], { env: { ...process.env, PATH: getSystemPath() } });
  if (wherePy.ok) {
    for (const line of wherePy.stdout.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed) {
        found.push(trimmed);
      }
    }
  }
  const wherePython = runSync("where.exe", ["python"], { env: { ...process.env, PATH: getSystemPath() } });
  if (wherePython.ok) {
    for (const line of wherePython.stdout.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.includes("WindowsApps")) {
        found.push(trimmed);
      }
    }
  }
  return [...new Set(found)];
}

function detectPython() {
  const cached = loadPythonEnv();
  if (cached?.pythonPath && fs.existsSync(cached.pythonPath)) {
    const direct = tryPythonExecutable(cached.pythonPath, cached.argsPrefix || []);
    if (direct) {
      return direct;
    }
  }

  const commandCandidates = [
    ["py", ["-3"]],
    ["python3", []],
    ["python", []],
  ];

  const env = { ...process.env, PATH: getSystemPath() };
  for (const [command, argsPrefix] of commandCandidates) {
    const versionRun = runSync(command, [...argsPrefix, "--version"], { env });
    if (!versionRun.ok) {
      continue;
    }
    const version = parseVersion(versionRun.stdout || versionRun.stderr);
    if (versionOk(version)) {
      return { command, argsPrefix, version: version.text };
    }
  }

  for (const exe of discoverWindowsPythonExecutables()) {
    const base = path.basename(exe).toLowerCase();
    if (base === "py.exe") {
      const found = tryPythonExecutable(exe, ["-3"]);
      if (found) {
        return found;
      }
      continue;
    }
    const found = tryPythonExecutable(exe, []);
    if (found) {
      return found;
    }
  }
  return null;
}

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    https
      .get(url, (response) => {
        if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          file.close();
          fs.unlink(destPath, () => {});
          downloadFile(response.headers.location, destPath).then(resolve).catch(reject);
          return;
        }
        if (response.statusCode !== 200) {
          file.close();
          fs.unlink(destPath, () => {});
          reject(new Error(`Download failed with status ${response.statusCode}`));
          return;
        }
        response.pipe(file);
        file.on("finish", () => {
          file.close(resolve);
        });
      })
      .on("error", (error) => {
        file.close();
        fs.unlink(destPath, () => {});
        reject(error);
      });
  });
}

async function installPythonWindows() {
  const winget = runSync("winget", [
    "install",
    "-e",
    "--id",
    "Python.Python.3.12",
    "--accept-package-agreements",
    "--accept-source-agreements",
  ]);
  if (winget.ok) {
    const detected = detectPython();
    if (detected) {
      return detected;
    }
  }

  const installerPath = path.join(CACHE_DIR, "python-3.12.7-amd64.exe");
  if (!fs.existsSync(installerPath)) {
    await downloadFile(PYTHON_INSTALLER_URL, installerPath);
  }

  const install = runSync(installerPath, [
    "/quiet",
    "InstallAllUsers=0",
    "PrependPath=1",
    "Include_pip=1",
  ], { timeout: 600000 });

  if (!install.ok) {
    throw new Error(
      install.stderr || install.stdout || "Python installer failed. Install Python 3.10+ manually."
    );
  }

  const detected = detectPython();
  if (!detected) {
    throw new Error("Python installed but not found on PATH. Restart the terminal or install manually.");
  }
  return detected;
}

async function ensurePythonInstalled() {
  let detected = detectPython();
  if (detected) {
    return detected;
  }

  if (process.platform === "win32") {
    detected = await installPythonWindows();
    return detected;
  }

  throw new Error("Python 3.10+ not found. Install Python and ensure it is on PATH.");
}

function pythonCommandArgs(pythonInfo) {
  return {
    command: pythonInfo.command,
    args: [...(pythonInfo.argsPrefix || [])],
  };
}

function checkPackages(pythonInfo) {
  const { command, args } = pythonCommandArgs(pythonInfo);
  const importCheck = runSync(command, [
    ...args,
    "-c",
    "import cv2, PIL, numpy; print('ok')",
  ]);
  return importCheck.ok;
}

function installPackages(pythonInfo) {
  if (!fs.existsSync(REQUIREMENTS_PATH)) {
    throw new Error(`Missing requirements file: ${REQUIREMENTS_PATH}`);
  }
  const { command, args } = pythonCommandArgs(pythonInfo);
  const pipInstall = runSync(command, [
    ...args,
    "-m",
    "pip",
    "install",
    "-r",
    REQUIREMENTS_PATH,
  ]);
  if (!pipInstall.ok) {
    throw new Error(pipInstall.stderr || pipInstall.stdout || "pip install failed.");
  }
  return checkPackages(pythonInfo);
}

function getScriptPath() {
  return path.join(__dirname, "..", "scripts", "generate-lifestyle-images.py");
}

function getOrientationScriptPath() {
  return path.join(__dirname, "..", "scripts", "detect-painting-orientation.py");
}

function getPreflightStatus() {
  const pythonInfo = detectPython();
  const packagesReady = pythonInfo ? checkPackages(pythonInfo) : false;
  return {
    pythonReady: Boolean(pythonInfo),
    pythonPath: pythonInfo ? [pythonInfo.command, ...(pythonInfo.argsPrefix || [])].join(" ") : null,
    pythonVersion: pythonInfo?.version || null,
    packagesReady,
    scriptPath: getScriptPath(),
    message: !pythonInfo
      ? "Python 3.10+ not found."
      : packagesReady
        ? "Ready."
        : "Python found; lifestyle packages not installed.",
  };
}

async function ensurePythonReady({ installIfMissing = true, installPackagesIfMissing = true } = {}) {
  let pythonInfo = detectPython();
  if (!pythonInfo && installIfMissing) {
    pythonInfo = await ensurePythonInstalled();
  }
  if (!pythonInfo) {
    throw new Error("Python 3.10+ is required for lifestyle image generation.");
  }

  let packagesReady = checkPackages(pythonInfo);
  if (!packagesReady && installPackagesIfMissing) {
    packagesReady = installPackages(pythonInfo);
  }
  if (!packagesReady) {
    throw new Error("Failed to install lifestyle Python packages (opencv-python-headless, Pillow, numpy).");
  }

  const env = {
    pythonPath: pythonInfo.command,
    argsPrefix: pythonInfo.argsPrefix || [],
    version: pythonInfo.version,
    packagesReady: true,
    updatedAt: new Date().toISOString(),
  };
  savePythonEnv(env);
  return env;
}

async function runSetup() {
  if (setupInFlight) {
    return setupInFlight;
  }
  setupInFlight = ensurePythonReady({ installIfMissing: true, installPackagesIfMissing: true })
    .then((env) => ({
      ...getPreflightStatus(),
      ok: true,
      pythonPath: [env.pythonPath, ...(env.argsPrefix || [])].join(" "),
      pythonVersion: env.version,
      packagesReady: true,
      message: "Python environment ready.",
    }))
    .catch((error) => ({
      ...getPreflightStatus(),
      ok: false,
      message: error.message || "Python setup failed.",
    }))
    .finally(() => {
      setupInFlight = null;
    });
  return setupInFlight;
}

function runCompositorManifest(manifestPath) {
  const env = loadPythonEnv();
  const pythonInfo = detectPython();
  const command = env?.pythonPath || pythonInfo?.command;
  const argsPrefix = env?.argsPrefix || pythonInfo?.argsPrefix || [];
  if (!command) {
    throw new Error("Python not configured.");
  }

  const scriptPath = getScriptPath();
  let child = null;
  const promise = new Promise((resolve, reject) => {
    child = spawn(command, [...argsPrefix, scriptPath, "--manifest", manifestPath], {
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (signal) {
        reject(new Error("Lifestyle compositor stopped."));
        return;
      }
      const text = stdout.trim() || stderr.trim();
      try {
        const parsed = JSON.parse(stdout.trim() || "{}");
        if (code !== 0 && parsed.error) {
          reject(new Error(parsed.error));
          return;
        }
        resolve(parsed);
      } catch {
        reject(new Error(text || `Python script failed with code ${code}`));
      }
    });
  });

  return {
    promise,
    kill() {
      if (child && !child.killed) {
        child.kill();
      }
    },
  };
}

function runOrientationManifest(manifestPath) {
  const env = loadPythonEnv();
  const pythonInfo = detectPython();
  const command = env?.pythonPath || pythonInfo?.command;
  const argsPrefix = env?.argsPrefix || pythonInfo?.argsPrefix || [];
  if (!command) {
    throw new Error("Python not configured.");
  }

  const scriptPath = getOrientationScriptPath();
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...argsPrefix, scriptPath, "--manifest", manifestPath], {
      windowsHide: true,
      cwd: path.join(__dirname, "..", "scripts"),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const text = stdout.trim() || stderr.trim();
      try {
        const parsed = JSON.parse(stdout.trim() || "{}");
        if (code !== 0 && parsed.error) {
          reject(new Error(parsed.error));
          return;
        }
        resolve(parsed);
      } catch {
        reject(new Error(text || `Python script failed with code ${code}`));
      }
    });
  });
}

module.exports = {
  getPreflightStatus,
  ensurePythonReady,
  runSetup,
  runCompositorManifest,
  runOrientationManifest,
  getScriptPath,
  getOrientationScriptPath,
};
