/* ─── Lumen Desktop — Electron preload (context bridge) ── */
"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  isDesktop: true,
  platform: process.platform,
  version: require("./package.json").version,

  openFile: (filters) => ipcRenderer.invoke("open-file", filters || []),

  saveFile: (defaultName, filters) =>
    ipcRenderer.invoke("save-file", defaultName, filters || []),

  readFile: (filePath) => ipcRenderer.invoke("read-file", filePath),

  writeFile: (filePath, data) =>
    ipcRenderer.invoke("write-file", filePath, data),

  ffprobe: (filePath) => ipcRenderer.invoke("ffprobe", filePath),

  ffmpegExport: (opts, onProgress) => {
    const ch = "ffmpeg-progress-" + Date.now() + "-" + Math.random();
    const handler = (_, pct) => onProgress && onProgress(pct);
    ipcRenderer.on(ch, handler);
    return ipcRenderer
      .invoke("ffmpeg-export", Object.assign({}, opts, { progressChannel: ch }))
      .finally(() => ipcRenderer.removeListener(ch, handler));
  },

  getRecentFiles: () => ipcRenderer.invoke("get-recent"),

  addRecentFile: (entry) => ipcRenderer.invoke("add-recent", entry),

  onMenu: (event, cb) => {
    const ch = "menu:" + event;
    ipcRenderer.on(ch, (_, ...args) => cb(...args));
  },

  showMessageBox: (opts) => ipcRenderer.invoke("show-message-box", opts),

  getVersion: () => ipcRenderer.invoke("app-version"),
});
