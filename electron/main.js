/* ─── Lumen Desktop — Electron main process ─────────────────────── */
"use strict";

const { app, BrowserWindow, dialog, ipcMain, Menu, shell } = require("electron");
const path = require("path");
const fs = require("fs");

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1680,
    height: 980,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: "#101216",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
      webSecurity: true,
    },
  });

  win.loadFile(path.join(__dirname, "..", "index.html"));
  win.setTitle("Lumen — Motion Studio");

  // Native application menu
  const menuTemplate = [
    {
      label: "File",
      submenu: [
        { label: "New Project", accelerator: "CmdOrCtrl+N", click: () => win.webContents.executeJavaScript("newProject(true)") },
        { label: "Open Project…", accelerator: "CmdOrCtrl+O", click: () => electronOpenProject() },
        { label: "Save Project…", accelerator: "CmdOrCtrl+S", click: () => win.webContents.executeJavaScript("saveProjectElectron()") },
        { type: "separator" },
        { label: "Export…", accelerator: "CmdOrCtrl+E", click: () => win.webContents.executeJavaScript("Exporter.open()") },
        { type: "separator" },
        process.platform !== "darwin" ? { label: "Quit", accelerator: "CmdOrCtrl+Q", click: () => app.quit() } : { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { label: "Undo", accelerator: "CmdOrCtrl+Z", click: () => win.webContents.executeJavaScript("History.undo()") },
        { label: "Redo", accelerator: "CmdOrCtrl+Shift+Z", click: () => win.webContents.executeJavaScript("History.redo()") },
        { type: "separator" },
        { role: "copy" }, { role: "paste" }, { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { label: "Fit Viewport", accelerator: "F", click: () => win.webContents.executeJavaScript("Viewport.fit()") },
        { label: "Toggle Guides", accelerator: "G", click: () => win.webContents.executeJavaScript("Viewport.toggleGuides()") },
        { type: "separator" },
        { label: "Reload", accelerator: "CmdOrCtrl+R", click: () => win.reload() },
        { role: "toggleDevTools" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Help",
      submenu: [
        { label: "Keyboard Shortcuts", click: () => win.webContents.executeJavaScript("showShortcuts()") },
        { type: "separator" },
        { label: "Report Issue on GitHub", click: () => shell.openExternal("https://github.com/cooldude292/testest/issues") },
      ],
    },
  ];

  if (process.platform === "darwin") {
    menuTemplate.unshift({ label: app.name, submenu: [{ role: "about" }, { type: "separator" }, { role: "quit" }] });
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate));
}

async function electronOpenProject() {
  const result = await dialog.showOpenDialog(win, {
    title: "Open Lumen Project",
    filters: [{ name: "Lumen Project", extensions: ["lumen", "json"] }],
    properties: ["openFile"],
  });
  if (result.canceled || !result.filePaths.length) return;
  const content = fs.readFileSync(result.filePaths[0], "utf8");
  win.webContents.executeJavaScript(`
    try {
      loadProjectJSON(${JSON.stringify(content)});
      document.getElementById("project-name").value = App.project.name;
      Viewport.fit(); Timeline.fit();
      toast("Project loaded");
    } catch(e) { toast("Could not open: " + e.message); }
  `);
}

/* IPC handlers */
ipcMain.handle("dialog:openFile", async (_, opts) => {
  const result = await dialog.showOpenDialog(win, opts || {
    filters: [{ name: "Lumen Project", extensions: ["lumen", "json"] }],
    properties: ["openFile"],
  });
  if (result.canceled) return null;
  const filePath = result.filePaths[0];
  return { filePath, content: fs.readFileSync(filePath, "utf8") };
});

ipcMain.handle("dialog:saveFile", async (_, { defaultPath, content }) => {
  const result = await dialog.showSaveDialog(win, {
    defaultPath,
    filters: [{ name: "Lumen Project", extensions: ["lumen"] }],
  });
  if (result.canceled) return null;
  fs.writeFileSync(result.filePath, content, "utf8");
  return result.filePath;
});

ipcMain.handle("dialog:saveBuffer", async (_, { defaultPath, buffer, filters }) => {
  const result = await dialog.showSaveDialog(win, {
    defaultPath,
    filters: filters || [{ name: "Video", extensions: ["mp4", "webm"] }],
  });
  if (result.canceled) return null;
  fs.writeFileSync(result.filePath, Buffer.from(buffer));
  return result.filePath;
});

ipcMain.handle("app:getVersion", () => app.getVersion());
ipcMain.handle("app:showItemInFolder", (_, filePath) => shell.showItemInFolder(filePath));

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
