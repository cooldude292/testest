/* ─── Lumen Desktop — Electron preload (context bridge) ── */
"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  openFile: (opts) => ipcRenderer.invoke("dialog:openFile", opts),
  saveFile: (opts) => ipcRenderer.invoke("dialog:saveFile", opts),
  saveBuffer: (opts) => ipcRenderer.invoke("dialog:saveBuffer", opts),
  getVersion: () => ipcRenderer.invoke("app:getVersion"),
  showInFolder: (path) => ipcRenderer.invoke("app:showItemInFolder", path),
  platform: process.platform,
});
