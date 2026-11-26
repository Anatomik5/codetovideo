const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("ctv", {
  loadSettings: () => ipcRenderer.invoke("settings:load"),
  saveSettings: (s) => ipcRenderer.invoke("settings:save", s),
  pick: (kind) => ipcRenderer.invoke("dialog:pick", kind),
  ollamaModels: (baseUrl) => ipcRenderer.invoke("ollama:models", baseUrl),
  session: () => ipcRenderer.invoke("session:get"),
  run: (req) => ipcRenderer.invoke("run:start", req),
  stop: () => ipcRenderer.invoke("run:stop"),
  reveal: (p) => ipcRenderer.invoke("shell:reveal", p),
  exportSubtitles: (saveTo, format) => ipcRenderer.invoke("subtitles:export", saveTo, format),
  onLog: (cb) => ipcRenderer.on("run:log", (_e, line) => cb(line)),
  onDone: (cb) => ipcRenderer.on("run:done", (_e, info) => cb(info)),
});
