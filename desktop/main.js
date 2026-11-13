const { app, BrowserWindow, Menu, shell } = require("electron");
const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const ORIGIN = "http://localhost:3847";
const APP_URL = `${ORIGIN}/editpro/`;
const ICON = path.join(__dirname, "editpro.ico");
const LOG_DIR = path.join(__dirname, "logs");
const LOG_FILE = path.join(LOG_DIR, "server.log");
const PID_FILE = path.join(LOG_DIR, "server.pid");
const START_TIMEOUT_MS = 60 * 1000;

app.setAppUserModelId("com.paintroad.editpro");
if (!app.requestSingleInstanceLock()) app.quit();

let win = null;
/** Server we own and must stop on close; null when EditPro was already running from elsewhere. */
let serverPid = null;
let serverExited = false;
let quitting = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function serverUp() {
  return new Promise((resolve) => {
    const req = http.get(`${ORIGIN}/editpro/api/health`, (res) => {
      res.resume();
      resolve(res.statusCode < 500);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(4000, () => req.destroy());
  });
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function startServer() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const log = fs.createWriteStream(LOG_FILE, { flags: "w" });
  const env = { ...process.env };
  delete env.PORT;
  delete env.BASE_PATH;
  delete env.ELECTRON_RUN_AS_NODE;
  env.EDITPRO_DESKTOP = "1";
  const child = spawn("node", ["server.js"], { cwd: ROOT, env, windowsHide: true });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  serverPid = child.pid;
  serverExited = false;
  fs.writeFileSync(PID_FILE, String(child.pid));
  child.on("error", (err) => {
    serverExited = true;
    showStatus("error", `Could not start EditPro: ${err.message}`);
  });
  child.on("exit", (code) => {
    serverExited = true;
    if (!quitting) showStatus("error", `EditPro's server stopped (code ${code}).`);
  });
}

function stopServer() {
  if (!serverPid) return;
  try {
    execFileSync("taskkill", ["/T", "/F", "/PID", String(serverPid)], { stdio: "ignore", windowsHide: true });
  } catch {
    // Already gone.
  }
  serverPid = null;
  fs.rmSync(PID_FILE, { force: true });
}

function showStatus(kind, message) {
  if (!win || win.isDestroyed()) return;
  const query = { kind, message, log: LOG_FILE };
  win.loadFile(path.join(__dirname, "loading.html"), { query }).catch(() => undefined);
}

async function boot() {
  if (await serverUp()) {
    const pid = Number(fs.existsSync(PID_FILE) ? fs.readFileSync(PID_FILE, "utf8") : NaN);
    // A server left behind by an earlier app window that was killed is adopted, so closing stops it.
    if (pid && alive(pid)) serverPid = pid;
  } else {
    startServer();
    const started = Date.now();
    while (!(await serverUp())) {
      if (serverExited) return;
      if (Date.now() - started > START_TIMEOUT_MS) {
        return showStatus("error", "EditPro took too long to start.");
      }
      await sleep(700);
    }
  }
  await win.loadURL(APP_URL);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    title: "EditPro",
    icon: ICON,
    backgroundColor: "#111111",
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  win.maximize();
  win.once("ready-to-show", () => win.show());

  // EditPro's own pages (review tabs, previews) open in app windows; anything else goes to the browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(`${ORIGIN}/`)) {
      return { action: "allow", overrideBrowserWindowOptions: { icon: ICON, autoHideMenuBar: true, backgroundColor: "#111111" } };
    }
    void shell.openExternal(url);
    return { action: "deny" };
  });

  win.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    const key = input.key.toLowerCase();
    if (key === "f5" || (input.control && key === "r")) {
      win.webContents.reload();
      event.preventDefault();
    } else if (input.control && input.shift && key === "i") {
      win.webContents.toggleDevTools();
      event.preventDefault();
    } else if (input.alt && key === "arrowleft" && win.webContents.navigationHistory.canGoBack()) {
      win.webContents.navigationHistory.goBack();
      event.preventDefault();
    }
  });

  win.on("closed", () => {
    win = null;
    app.quit();
  });

  showStatus("starting", "Starting EditPro…");
  void boot().catch((err) => showStatus("error", err instanceof Error ? err.message : String(err)));
}

app.on("second-instance", () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

app.on("before-quit", () => {
  quitting = true;
  stopServer();
});

app.on("window-all-closed", () => app.quit());

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  createWindow();
});
