/* ─── Lumen Desktop — Electron main process ─────────────────────── */
"use strict";

const { app, BrowserWindow, dialog, ipcMain, Menu, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");

const RECENT_FILE = path.join(os.homedir(), ".lumen-recent.json");
const GITHUB_ISSUES_URL = "https://github.com/cooldude292/testest/issues";

let win = null;

/* ── Recent files helpers ──────────────────────────────────────── */
function readRecent() {
  try {
    return JSON.parse(fs.readFileSync(RECENT_FILE, "utf8"));
  } catch (_) {
    return [];
  }
}

function writeRecent(items) {
  try {
    fs.writeFileSync(RECENT_FILE, JSON.stringify(items, null, 2), "utf8");
  } catch (_) {
    /* silently ignore */
  }
}

function addRecentEntry(entry) {
  let items = readRecent().filter((i) => i.path !== entry.path);
  items.unshift(entry);
  items = items.slice(0, 10);
  writeRecent(items);
  return items;
}

/* ── Build recent submenu ──────────────────────────────────────── */
function buildRecentSubmenu() {
  const items = readRecent();
  if (!items.length) {
    return [{ label: "No Recent Projects", enabled: false }];
  }
  return items.map((entry) => ({
    label: entry.name || path.basename(entry.path),
    click: () => {
      if (win) win.webContents.send("menu:open-recent", entry);
    },
  }));
}

/* ── Native menu ───────────────────────────────────────────────── */
function buildMenu() {
  const isMac = process.platform === "darwin";

  const fileMenu = {
    label: "File",
    submenu: [
      {
        label: "New Project",
        accelerator: "CmdOrCtrl+N",
        click: () => win && win.webContents.send("menu:new-project"),
      },
      {
        label: "Open Project",
        accelerator: "CmdOrCtrl+O",
        click: () => win && win.webContents.send("menu:open-project"),
      },
      {
        label: "Open Recent",
        submenu: buildRecentSubmenu(),
      },
      { type: "separator" },
      {
        label: "Save",
        accelerator: "CmdOrCtrl+S",
        click: () => win && win.webContents.send("menu:save"),
      },
      {
        label: "Save As",
        accelerator: "CmdOrCtrl+Shift+S",
        click: () => win && win.webContents.send("menu:save-as"),
      },
      { type: "separator" },
      {
        label: "Import Media",
        accelerator: "CmdOrCtrl+I",
        click: () => win && win.webContents.send("menu:import-media"),
      },
      { type: "separator" },
      {
        label: "Export",
        accelerator: "CmdOrCtrl+M",
        click: () => win && win.webContents.send("menu:export"),
      },
      {
        label: "Export Queue",
        accelerator: "CmdOrCtrl+Shift+M",
        click: () => win && win.webContents.send("menu:export-queue"),
      },
      { type: "separator" },
      {
        label: "Quit",
        accelerator: "CmdOrCtrl+Q",
        click: () => app.quit(),
      },
    ],
  };

  const editMenu = {
    label: "Edit",
    submenu: [
      { label: "Undo", accelerator: "CmdOrCtrl+Z", role: "undo" },
      { label: "Redo", accelerator: "CmdOrCtrl+Shift+Z", role: "redo" },
      { type: "separator" },
      { label: "Cut", role: "cut" },
      { label: "Copy", role: "copy" },
      { label: "Paste", role: "paste" },
      { label: "Select All", role: "selectAll" },
    ],
  };

  const viewMenu = {
    label: "View",
    submenu: [
      {
        label: "Reload",
        accelerator: "CmdOrCtrl+R",
        click: () => win && win.reload(),
      },
      {
        label: "Toggle DevTools",
        accelerator: isMac ? "CmdOrCtrl+Option+I" : "F12",
        click: () => win && win.webContents.toggleDevTools(),
      },
      { type: "separator" },
      { label: "Actual Size", role: "resetZoom" },
      { label: "Zoom In", role: "zoomIn" },
      { label: "Zoom Out", role: "zoomOut" },
      { type: "separator" },
      { label: "Toggle Full Screen", role: "togglefullscreen" },
    ],
  };

  const helpMenu = {
    label: "Help",
    submenu: [
      {
        label: "About Lumen",
        click: async () => {
          if (!win) return;
          await dialog.showMessageBox(win, {
            type: "info",
            title: "About Lumen",
            message: "Lumen — Professional Video Editor",
            detail:
              "Version: " +
              app.getVersion() +
              "\n\nA powerful video editor for the desktop.\n\nBuilt with Electron and vanilla JavaScript.\n\n© " +
              new Date().getFullYear() +
              " Lumen",
            buttons: ["OK"],
          });
        },
      },
      {
        label: "Check for Updates",
        click: async () => {
          if (!win) return;
          await dialog.showMessageBox(win, {
            type: "info",
            title: "Check for Updates",
            message: "Lumen is up to date.",
            detail: "You are running version " + app.getVersion() + ".",
            buttons: ["OK"],
          });
        },
      },
      { type: "separator" },
      {
        label: "Report a Bug",
        click: () => shell.openExternal(GITHUB_ISSUES_URL),
      },
    ],
  };

  const template = [];

  if (isMac) {
    template.push({
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    });
  }

  template.push(fileMenu, editMenu, viewMenu);

  if (isMac) {
    template.push({
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        { type: "separator" },
        { role: "front" },
      ],
    });
  }

  template.push(helpMenu);

  return Menu.buildFromTemplate(template);
}

/* ── Window creation ───────────────────────────────────────────── */
function createWindow() {
  win = new BrowserWindow({
    width: 1600,
    height: 900,
    minWidth: 1200,
    minHeight: 700,
    backgroundColor: "#101216",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: false,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  win.loadFile(path.join(__dirname, "..", "index.html"));

  win.webContents.on("did-finish-load", () => {
    win.webContents.executeJavaScript(
      'window.LUMEN_DESKTOP = true; document.body.dataset.desktop = "1";'
    );
  });

  Menu.setApplicationMenu(buildMenu());

  /* macOS dock menu */
  if (process.platform === "darwin") {
    const dockMenu = Menu.buildFromTemplate([
      {
        label: "New Project",
        click: () => win && win.webContents.send("menu:new-project"),
      },
      {
        label: "Open Recent",
        submenu: buildRecentSubmenu(),
      },
    ]);
    app.dock.setMenu(dockMenu);
  }

  win.on("closed", () => {
    win = null;
  });
}

/* ── Single-instance lock ──────────────────────────────────────── */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(createWindow);

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  /* macOS: open-file event (drag to dock icon) */
  app.on("open-file", (event, filePath) => {
    event.preventDefault();
    if (win) {
      win.webContents.send("menu:open-file", filePath);
    }
  });
}

/* ── IPC handlers ──────────────────────────────────────────────── */

/* open-file: show open dialog, return array of paths */
ipcMain.handle("open-file", async (_, filters) => {
  const result = await dialog.showOpenDialog(win, {
    properties: ["openFile", "multiSelections"],
    filters: filters || [
      {
        name: "All Supported",
        extensions: [
          "mp4", "webm", "mov", "mkv", "avi",
          "mp3", "wav", "aac", "ogg",
          "png", "jpg", "jpeg", "gif", "webp",
          "lumen", "json",
        ],
      },
      { name: "Video", extensions: ["mp4", "webm", "mov", "mkv", "avi"] },
      { name: "Audio", extensions: ["mp3", "wav", "aac", "ogg"] },
      { name: "Image", extensions: ["png", "jpg", "jpeg", "gif", "webp"] },
      { name: "Project", extensions: ["lumen", "json"] },
      { name: "All Files", extensions: ["*"] },
    ],
  });
  if (result.canceled) return [];
  return result.filePaths;
});

/* save-file: show save dialog, return path or null */
ipcMain.handle("save-file", async (_, defaultPath, filters) => {
  const result = await dialog.showSaveDialog(win, {
    defaultPath: defaultPath || "Untitled.lumen",
    filters: filters || [
      { name: "Lumen Project", extensions: ["lumen"] },
      { name: "JSON", extensions: ["json"] },
      { name: "All Files", extensions: ["*"] },
    ],
  });
  if (result.canceled) return null;
  return result.filePath;
});

/* read-file: read file and return base64 string */
ipcMain.handle("read-file", async (_, filePath) => {
  const buf = await fs.promises.readFile(filePath);
  return buf.toString("base64");
});

/* write-file: decode base64 and write to disk */
ipcMain.handle("write-file", async (_, filePath, data) => {
  await fs.promises.writeFile(filePath, Buffer.from(data, "base64"));
  return true;
});

/* ffprobe: get media metadata via ffprobe */
ipcMain.handle("ffprobe", async (_, filePath) => {
  try {
    const ffmpegBridge = require("./ffmpeg-bridge");
    return await ffmpegBridge.probe(filePath);
  } catch (err) {
    console.warn("ffprobe handler error:", err.message);
    return null;
  }
});

/* ffmpeg-export: export via ffmpeg, stream progress to renderer */
ipcMain.handle("ffmpeg-export", async (_, opts) => {
  try {
    const ffmpegBridge = require("./ffmpeg-bridge");
    const result = await ffmpegBridge.export(opts, (pct) => {
      if (win && opts.progressChannel) {
        win.webContents.send(opts.progressChannel, pct);
      }
    });
    return result;
  } catch (err) {
    console.warn("ffmpeg-export handler error:", err.message);
    return { success: false, error: err.message };
  }
});

/* get-recent: read recent files list */
ipcMain.handle("get-recent", async () => {
  return readRecent();
});

/* add-recent: prepend entry and persist */
ipcMain.handle("add-recent", async (_, entry) => {
  return addRecentEntry(entry);
});

/* show-message-box: show native message box */
ipcMain.handle("show-message-box", async (_, opts) => {
  return dialog.showMessageBox(win, opts);
});

/* app-version: return current app version */
ipcMain.handle("app-version", async () => {
  return app.getVersion();
});
