// CodeToVideo desktop shell (Electron). A thin UI over scripts/demo-pipeline.ts — all logic stays in the pipeline.
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, safeStorage } = require("electron");
const path = require("path");
const fs = require("fs");
const { spawn: rawSpawn } = require("child_process");

// Every child process is spawned hidden (windowsHide) so no console window ever appears on Windows.
const spawn = (cmd, args, opts = {}) => rawSpawn(cmd, args, { windowsHide: true, ...opts });

const ROOT = path.resolve(__dirname, "..");
const TS_NODE = path.join(ROOT, "node_modules", "ts-node", "dist", "bin.js");
const SESSIONS = path.join(ROOT, "out", "sessions");
const settingsFile = () => path.join(app.getPath("userData"), "settings.json");

let win = null;
let child = null;

function createWindow() {
  Menu.setApplicationMenu(null);
  win = new BrowserWindow({
    width: 1040,
    height: 760,
    minWidth: 820,
    minHeight: 600,
    title: "CodeToVideo",
    backgroundColor: "#0e1116",
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false },
  });
  win.loadFile(path.join(__dirname, "index.html"));
}

app.whenReady().then(createWindow);
app.on("window-all-closed", () => {
  stopRun();
  app.quit();
});

function latestSession() {
  if (!fs.existsSync(SESSIONS)) return null;
  const dirs = fs
    .readdirSync(SESSIONS)
    .map((n) => path.join(SESSIONS, n))
    .filter((d) => fs.existsSync(path.join(d, "manifest.json")))
    .sort((a, b) => fs.statSync(path.join(b, "manifest.json")).mtimeMs - fs.statSync(path.join(a, "manifest.json")).mtimeMs);
  return dirs[0] || null;
}

function stopRun() {
  if (!child) return;
  try {
    if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
    else process.kill(-child.pid, "SIGTERM");
  } catch {
    try { child.kill(); } catch { /* ignore */ }
  }
  child = null;
}

// The API key is encrypted with the OS keychain (DPAPI / Keychain / libsecret) when available.
ipcMain.handle("settings:load", () => {
  try {
    const s = JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
    if (s.apiKeyEnc && safeStorage.isEncryptionAvailable()) {
      try { s.apiKey = safeStorage.decryptString(Buffer.from(s.apiKeyEnc, "base64")); } catch { s.apiKey = ""; }
    }
    delete s.apiKeyEnc;
    return s;
  } catch {
    return {};
  }
});
ipcMain.handle("settings:save", (_e, incoming) => {
  try {
    const s = { ...incoming };
    if (s.apiKey && safeStorage.isEncryptionAvailable()) {
      s.apiKeyEnc = safeStorage.encryptString(String(s.apiKey)).toString("base64");
      delete s.apiKey;
    }
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2), "utf8");
  } catch { /* ignore */ }
});

ipcMain.handle("dialog:pick", async (_e, kind) => {
  const props = { folder: ["openDirectory"], file: ["openFile"], files: ["openFile", "multiSelections"] }[kind] || ["openFile"];
  const r = await dialog.showOpenDialog(win, { properties: props });
  return r.canceled ? [] : r.filePaths;
});

ipcMain.handle("ollama:models", async (_e, baseUrl) => {
  try {
    const root = String(baseUrl || "http://localhost:11434").replace(/\/v1\/?$/, "").replace(/\/+$/, "");
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 2000);
    const res = await fetch(`${root}/api/tags`, { signal: ctl.signal });
    clearTimeout(t);
    const data = await res.json();
    return (data.models || []).map((m) => m.name);
  } catch {
    return [];
  }
});

ipcMain.handle("session:get", () => {
  const dir = latestSession();
  if (!dir) return null;
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
    return {
      dir,
      id: m.id,
      videoTitle: m.videoTitle,
      outPath: fs.existsSync(path.join(dir, "final.mp4")) ? path.join(dir, "final.mp4") : m.outPath,
      scenes: m.scenes.map((s) => ({ id: s.id, index: s.index, title: s.title, caption: s.caption, durationSec: s.durationSec })),
      mtime: fs.statSync(path.join(dir, "manifest.json")).mtimeMs,
    };
  } catch {
    return null;
  }
});

ipcMain.handle("shell:reveal", (_e, p) => { if (p && fs.existsSync(p)) shell.showItemInFolder(p); });
ipcMain.handle("run:stop", () => stopRun());

ipcMain.handle("run:start", (_e, req) => {
  if (child) return { ok: false, error: "A job is already running." };
  const c = req.cfg || {};
  const args = [TS_NODE, "scripts/demo-pipeline.ts"];
  const add = (k, v) => { if (v !== undefined && v !== null && String(v).trim() !== "") args.push(k, String(v)); };

  add("--model", c.model);
  add("--base-url", c.baseUrl);
  add("--quality", c.quality);
  add("--format", c.format);
  add("--backdrop", c.backdrop);

  if (req.mode === "create") {
    if (c.url && c.url.trim()) add("--url", c.url.trim());
    else add("--file", c.file);
    for (const u of c.uploads || []) add("--upload", u);
    add("--theme", c.theme || "auto");
    add("--prompt", c.prompt);
  } else {
    const dir = latestSession();
    if (!dir) return { ok: false, error: "No saved session yet — generate a video first." };
    add("--project-dir", dir);
    if (req.mode === "edit") {
      add("--edit-scene", c.editScene);
      add("--edit-prompt", c.editPrompt);
    } else {
      args.push("--re-render-only");
    }
  }

  // Run the pipeline under real node.exe (not electron.exe). With windowsHide the process gets a console WITHOUT a
  // window, and every grandchild (python, npm, ffmpeg, chromium helpers …) inherits that invisible console instead of
  // opening its own visible one. electron.exe is a GUI process without a console, so its children would each flash one.
  const nodeBin = process.env.npm_node_execpath || "node";
  const env = { ...process.env, FORCE_COLOR: "0" };
  delete env.ELECTRON_RUN_AS_NODE;
  if (c.apiKey) env.LLM_API_KEY = c.apiKey; // passed via env, never on the command line

  const send = (line) => win && !win.isDestroyed() && win.webContents.send("run:log", line);
  send(`> ${req.mode}  (model ${c.model || "default"})\n`);
  child = spawn(nodeBin, args, { cwd: ROOT, env, windowsHide: true, detached: process.platform !== "win32" });
  const onData = (buf) => send(buf.toString().replace(/\x1b\[[0-9;]*[A-Za-z]/g, ""));
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.on("error", (err) => send(`Failed to start: ${err.message}\n`));
  child.on("exit", (code) => {
    child = null;
    const dir = latestSession();
    let out = path.join(ROOT, "out", "demo.mp4");
    try { out = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")).outPath || out; } catch { /* ignore */ }
    if (dir && fs.existsSync(path.join(dir, "final.mp4"))) out = path.join(dir, "final.mp4");
    if (win && !win.isDestroyed()) win.webContents.send("run:done", { code, outPath: out });
  });
  return { ok: true };
});
