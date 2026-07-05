const { spawn, execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

let managedChild = null;

function resolveOllamaBinary() {
  const candidates = [
    process.env.OLLAMA_BINARY,
    path.join(process.env.LOCALAPPDATA || "", "Programs", "Ollama", "ollama.exe"),
    path.join(process.env.ProgramFiles || "", "Ollama", "ollama.exe"),
    "ollama",
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (candidate === "ollama") {
      return candidate;
    }
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function assertLocalHost(host) {
  let parsed;
  try {
    parsed = new URL(host);
  } catch {
    throw new Error("Invalid Ollama host URL.");
  }
  const allowed = new Set(["localhost", "127.0.0.1", "::1"]);
  if (!allowed.has(parsed.hostname)) {
    throw new Error("Start and stop are only allowed for local Ollama hosts.");
  }
}

function normalizeHost(host) {
  return String(host || "http://localhost:11434").replace(/\/$/, "");
}

async function checkStatus(host = "http://localhost:11434") {
  const base = normalizeHost(host);
  const binary = resolveOllamaBinary();
  try {
    const response = await fetch(`${base}/api/tags`, {
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) {
      return {
        running: false,
        host: base,
        installed: Boolean(binary),
        binary: binary || null,
        error: `HTTP ${response.status}`,
      };
    }
    const data = await response.json();
    const models = (data.models || []).map((m) => m.name || m.model).filter(Boolean);
    return {
      running: true,
      host: base,
      installed: Boolean(binary),
      binary: binary || null,
      models,
      managed: Boolean(managedChild),
    };
  } catch (error) {
    return {
      running: false,
      host: base,
      installed: Boolean(binary),
      binary: binary || null,
      error: error.message || "Cannot reach Ollama",
    };
  }
}

async function waitForRunning(host, attempts = 30, delayMs = 500) {
  for (let i = 0; i < attempts; i++) {
    const status = await checkStatus(host);
    if (status.running) {
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error("Ollama did not become ready in time. Check that it is installed.");
}

async function startOllama(host = "http://localhost:11434") {
  const base = normalizeHost(host);
  assertLocalHost(base);

  const current = await checkStatus(base);
  if (current.running) {
    return { ...current, message: "Ollama is already running." };
  }

  const binary = resolveOllamaBinary();
  if (!binary) {
    throw new Error(
      "Ollama is not installed. Download it from https://ollama.com/download and restart EditPro."
    );
  }

  if (process.platform === "win32") {
    try {
      spawn(binary, ["serve"], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      }).unref();
    } catch {
      spawn("cmd.exe", ["/c", "start", "", binary], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      }).unref();
    }
  } else {
    const child = spawn(binary, ["serve"], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    managedChild = child;
  }

  const status = await waitForRunning(base);
  return { ...status, message: "Ollama started." };
}

async function stopOllama(host = "http://localhost:11434") {
  const base = normalizeHost(host);
  assertLocalHost(base);

  const current = await checkStatus(base);
  if (!current.running) {
    managedChild = null;
    return { running: false, message: "Ollama is not running." };
  }

  if (process.platform === "win32") {
    try {
      await execFileAsync("taskkill", ["/IM", "ollama.exe", "/F"]);
    } catch (error) {
      if (!/not found|no tasks/i.test(error.message || "")) {
        throw new Error(error.message || "Failed to stop Ollama.");
      }
    }
    try {
      await execFileAsync("taskkill", ["/IM", "ollama app.exe", "/F"]);
    } catch {
      // optional tray app process name on some installs
    }
  } else if (managedChild?.pid) {
    try {
      process.kill(managedChild.pid);
    } catch {
      // ignore
    }
    managedChild = null;
  } else {
    try {
      await execFileAsync("pkill", ["-f", "ollama serve"]);
    } catch {
      // ignore if nothing to kill
    }
  }

  managedChild = null;
  return { running: false, message: "Ollama stopped." };
}

module.exports = {
  resolveOllamaBinary,
  checkStatus,
  startOllama,
  stopOllama,
};
