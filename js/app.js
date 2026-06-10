/* ─── Lumen app shell v3: playback, shortcuts, palette, export, library ── */
"use strict";

/* ── playback ── */
const Playback = (() => {
  let lastTs = null;

  function loop(ts) {
    if (App.playing) {
      if (lastTs !== null) {
        const c = App.comp;
        let t = App.time + ((ts - lastTs) / 1000) * App.speed;
        const end = c.workEnd > c.workStart + 0.05 ? c.workEnd : c.duration;
        const start = c.workEnd > c.workStart + 0.05 ? c.workStart : 0;
        if (t >= end) {
          if (App.loop) t = start;
          else { t = end; App.setPlaying(false); Renderer.pauseAllVideos(); AudioEngine.pauseAll(); }
        }
        App.setTime(t, { playback: true });
        AudioEngine.sync();
        if (MotionSketch.isRecording()) MotionSketch.onFrame();
      }
      lastTs = ts;
    } else {
      lastTs = null;
    }
    requestAnimationFrame(loop);
  }

  function toggle() {
    if (MotionSketch.isRecording()) { MotionSketch.stop(); return; }
    App.setPlaying(!App.playing);
    if (!App.playing) { Renderer.pauseAllVideos(); AudioEngine.pauseAll(); }
    else AudioEngine.sync();
  }

  function step(frames) {
    App.setPlaying(false);
    Renderer.pauseAllVideos();
    AudioEngine.pauseAll();
    const fps = App.comp.fps;
    App.setTime(clamp(snapT(Math.round(App.time * fps + frames) / fps), 0, App.comp.duration));
  }

  requestAnimationFrame(loop);
  return { toggle, step };
})();

/* ── motion sketch: record mouse position to keyframes ── */
const MotionSketch = (() => {
  let recording = false, sketchLayer = null, lastPos = null;

  function start() {
    const sel = App.selectedLayer();
    if (!sel || sel.type === "audio") { toast("Select a layer first"); return; }
    App.commit();
    sketchLayer = sel;
    sketchLayer.props.position.anim = true;
    sketchLayer.props.position.keys = [];
    recording = true;
    App.setPlaying(true);
    toast("Motion sketch: move mouse over viewport · Space to stop");
  }

  function onFrame() {
    if (!recording || !lastPos || !sketchLayer) return;
    Layers.upsertKeyObj(sketchLayer.props.position, App.time, lastPos.slice(), "linear");
  }

  function recordPos(wx, wy) {
    if (!recording) return;
    lastPos = [Math.round(wx * 10) / 10, Math.round(wy * 10) / 10];
  }

  function stop() {
    if (!recording) return;
    recording = false;
    App.setPlaying(false);
    if (sketchLayer && sketchLayer.props.position.keys.length) {
      sketchLayer.props.position.keys.sort((a, b) => a.t - b.t);
      App.emit("project");
    }
    toast("Motion sketch complete");
    sketchLayer = null; lastPos = null;
  }

  return { start, stop, onFrame, recordPos, isRecording: () => recording };
})();

/* ── clipboard (layers, keyframes, effects) ── */
const UIClipboard = {
  layers: null, keys: null, effects: null,

  copyLayers() {
    const sel = App.selectedLayers();
    if (!sel.length) return;
    this.layers = JSON.stringify(sel);
    toast(`Copied ${sel.length} layer${sel.length > 1 ? "s" : ""}`);
  },
  pasteLayers() {
    if (!this.layers) return;
    App.commit();
    const arr = JSON.parse(this.layers);
    const idMap = {};
    arr.forEach(l => { idMap[l.id] = uid(); });
    arr.forEach(l => {
      l.id = idMap[l.id];
      if (l.parent && idMap[l.parent]) l.parent = idMap[l.parent];
      else l.parent = null;
      l.effects.forEach(fx => fx.id = uid());
      l.masks.forEach(m => m.id = uid());
      l.inPoint = clamp(l.inPoint, 0, App.comp.duration);
      l.outPoint = clamp(l.outPoint, l.inPoint + 0.05, App.comp.duration);
    });
    App.layers.unshift(...arr);
    App.selection = arr[0].id;
    App.selExtra = new Set(arr.slice(1).map(l => l.id));
    App.emit("project");
    App.emit("selection");
  },

  copyKeys(targets) {
    const list = targets || App.selectedKeys;
    if (!list.length) { toast("No keyframes selected"); return; }
    const t0 = Math.min(...list.map(s => s.key.t));
    this.keys = list.map(s => ({ p: s.p, dt: s.key.t - t0, v: cloneVal(s.key.v), ease: s.key.ease }));
    toast(`Copied ${list.length} keyframe${list.length > 1 ? "s" : ""}`);
  },
  pasteKeys() {
    if (!this.keys || !this.keys.length) { toast("Keyframe clipboard is empty"); return; }
    App.commit();
    this.keys.forEach(k => {
      if (!k.p.anim) k.p.anim = true;
      Layers.upsertKeyObj(k.p, App.time + k.dt, k.v, k.ease);
    });
    App.emit("project");
    toast("Keyframes pasted at playhead");
  },

  copyEffects() {
    const l = App.selectedLayer();
    if (!l || !l.effects.length) { toast("No effects to copy"); return; }
    this.effects = JSON.stringify(l.effects);
    toast(`Copied ${l.effects.length} effect${l.effects.length > 1 ? "s" : ""}`);
  },
  pasteEffects() {
    const l = App.selectedLayer();
    if (!l || !this.effects) return;
    App.commit();
    const arr = JSON.parse(this.effects);
    arr.forEach(fx => fx.id = uid());
    l.effects.push(...arr);
    App.emit("project");
    toast("Effects pasted");
  },
};

/* ── layer commands ── */
const UICommands = {
  flip(layer, axis) {
    App.commit();
    const s = cloneVal(evalProp(layer.props.scale, App.time));
    if (axis === "h") s[0] = -s[0]; else s[1] = -s[1];
    Layers.setProp(layer, "scale", s);
    App.emit("project");
  },
  resetTransform(layer) {
    App.commit();
    const c = App.comp;
    ["position", "scale", "rotation", "opacity", "anchor"].forEach(n => {
      const p = layer.props[n];
      p.anim = false; p.keys = []; p.loop = "none"; p.wiggle = null; p.expr = null; p.exprEnabled = false;
    });
    layer.props.position.value = [c.width / 2, c.height / 2];
    layer.props.scale.value = [100, 100];
    layer.props.rotation.value = 0;
    layer.props.opacity.value = 100;
    layer.props.anchor.value = [0, 0];
    App.emit("project");
  },
  fitLayerToComp(layer) {
    App.commit();
    const c = App.comp;
    const [w, h] = contentSize(layer);
    if (w > 0 && h > 0) {
      const s = Math.min(c.width / w, c.height / h) * 100;
      Layers.setProp(layer, "scale", [Math.round(s * 10) / 10, Math.round(s * 10) / 10]);
      Layers.setProp(layer, "position", [c.width / 2, c.height / 2]);
    }
    App.emit("project");
  },
  sequenceLayers() {
    const sel = App.selectedLayers();
    const list = sel.length > 1 ? sel : App.layers.slice();
    if (list.length < 2) { toast("Need at least two layers"); return; }
    App.commit();
    let cursor = 0;
    [...list].reverse().forEach(l => {
      const len = l.outPoint - l.inPoint;
      l.inPoint = snapT(clamp(cursor, 0, App.comp.duration - 0.05));
      l.outPoint = snapT(clamp(cursor + len, l.inPoint + 0.05, App.comp.duration));
      cursor += len;
    });
    App.emit("project");
    toast("Layers sequenced");
  },
  easyEaseSelected() {
    if (!App.selectedKeys.length) { toast("No keyframes selected"); return; }
    App.commit();
    App.selectedKeys.forEach(s => s.key.ease = "easeInOut");
    App.emit("project");
    toast("Easy ease applied");
  },
  reverseKeys() {
    const props = new Set(App.selectedKeys.map(s => s.p));
    if (!props.size) { toast("No keyframes selected"); return; }
    App.commit();
    props.forEach(p => {
      if (p.keys.length < 2) return;
      const t0 = p.keys[0].t, t1 = p.keys[p.keys.length - 1].t;
      p.keys.forEach(k => k.t = t1 - (k.t - t0));
      p.keys.sort((a, b) => a.t - b.t);
    });
    App.emit("project");
    toast("Keyframes reversed");
  },
  nudge(dx, dy) {
    const sel = App.selectedLayers().filter(l => !l.locked && l.type !== "audio");
    if (!sel.length) return false;
    App.commit();
    sel.forEach(l => {
      const p = cloneVal(evalProp(l.props.position, App.time));
      Layers.setProp(l, "position", [p[0] + dx, p[1] + dy]);
    });
    App.emit("project");
    return true;
  },
  nudgeScale(delta) {
    const sel = App.selectedLayers().filter(l => !l.locked && l.type !== "audio");
    if (!sel.length) return;
    App.commit();
    sel.forEach(l => {
      const s = cloneVal(evalProp(l.props.scale, App.time));
      Layers.setProp(l, "scale", [s[0] + delta, s[1] + delta]);
    });
    App.emit("project");
  },
  nudgeTime(frames) {
    const sel = App.selectedLayers().filter(l => !l.locked);
    if (!sel.length) return false;
    App.commit();
    const dt = frames / App.comp.fps;
    sel.forEach(l => {
      const len = l.outPoint - l.inPoint;
      l.inPoint = snapT(clamp(l.inPoint + dt, 0, App.comp.duration - len));
      l.outPoint = l.inPoint + len;
    });
    App.emit("project");
    return true;
  },
  trimToPlayhead(side) {
    const sel = App.selectedLayers().filter(l => !l.locked);
    if (!sel.length) return;
    App.commit();
    const t = snapT(App.time);
    sel.forEach(l => {
      if (side === "in" && t < l.outPoint) l.inPoint = t;
      if (side === "out" && t > l.inPoint) l.outPoint = t;
    });
    App.emit("project");
  },
  cycleBlend(dir) {
    const l = App.selectedLayer();
    if (!l) return;
    App.commit();
    const idx = BLEND_MODES.findIndex(([v]) => v === l.blend);
    const next = (idx + dir + BLEND_MODES.length) % BLEND_MODES.length;
    l.blend = BLEND_MODES[next][0];
    App.emit("project");
    toast(`Blend: ${BLEND_MODES[next][1]}`);
  },
  jumpKey(dir) {
    const l = App.selectedLayer();
    if (!l) return;
    let times = [];
    allAnimProps(l).forEach(({ p }) => { if (p.anim) times.push(...p.keys.map(k => k.t)); });
    times.push(...(App.comp.markers || []).map(m => m.t));
    times = [...new Set(times)].sort((a, b) => a - b);
    const t = App.time;
    const next = dir > 0 ? times.find(x => x > t + 1e-6) : [...times].reverse().find(x => x < t - 1e-6);
    if (next !== undefined) App.setTime(next);
  },
  jumpMarker(dir) {
    const ms = (App.comp.markers || []).map(m => m.t).sort((a, b) => a - b);
    const t = App.time;
    const next = dir > 0 ? ms.find(x => x > t + 1e-6) : [...ms].reverse().find(x => x < t - 1e-6);
    if (next !== undefined) App.setTime(next);
  },
  zoomToSelection() {
    const sel = App.selectedLayer();
    if (!sel) return;
    const [x, y] = evalProp(sel.props.position, App.time);
    Viewport.setZoom(Viewport.currentScale() * 1.5, undefined, undefined, x, y);
    toast("Zoomed to selection");
  },
  snapToGrid(enable) {
    App.snapToGrid = enable !== undefined ? enable : !App.snapToGrid;
    toast(App.snapToGrid ? "Snap to grid on" : "Snap to grid off");
  },
  deleteGuides() {
    App.commit();
    App.comp.guides = [];
    App.emit("project");
    toast("Guides cleared");
  },
};

/* ── LRU cache helper ── */
function makeLRU(maxSize) {
  const map = new Map();
  return {
    get(key) { if (!map.has(key)) return undefined; const v = map.get(key); map.delete(key); map.set(key, v); return v; },
    set(key, val) {
      if (map.has(key)) map.delete(key);
      else if (map.size >= maxSize) { const first = map.keys().next().value; map.delete(first); }
      map.set(key, val);
    },
    has(key) { return map.has(key); },
    delete(key) { map.delete(key); },
    get size() { return map.size; },
    values() { return map.values(); },
    forEach(fn) { map.forEach(fn); },
  };
}

/* ── IndexedDB project library ── */
const ProjectLibrary = (() => {
  let db = null;
  const DB_NAME = "lumen-v3";
  const STORE = "projects";

  async function openDB() {
    if (db) return db;
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = e => {
        const d = e.target.result;
        if (!d.objectStoreNames.contains(STORE))
          d.createObjectStore(STORE, { keyPath: "id" });
      };
      req.onsuccess = e => { db = e.target.result; resolve(db); };
      req.onerror = e => reject(e.target.error);
    });
  }

  async function list() {
    const d = await openDB();
    return new Promise((resolve, reject) => {
      const req = d.transaction(STORE, "readonly").objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = e => reject(e.target.error);
    });
  }

  async function save(name, overwriteId) {
    const d = await openDB();
    const entry = {
      id: overwriteId || uid(),
      name: name || App.project.name,
      savedAt: Date.now(),
      data: serializeProject(),
    };
    return new Promise((resolve, reject) => {
      const tx = d.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(entry);
      tx.oncomplete = () => resolve(entry);
      tx.onerror = e => reject(e.target.error);
    });
  }

  async function load(id) {
    const d = await openDB();
    return new Promise((resolve, reject) => {
      const req = d.transaction(STORE, "readonly").objectStore(STORE).get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = e => reject(e.target.error);
    });
  }

  async function remove(id) {
    const d = await openDB();
    return new Promise((resolve, reject) => {
      const tx = d.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = resolve;
      tx.onerror = e => reject(e.target.error);
    });
  }

  return { list, save, load, remove };
})();

function trackRecent(name, id) {
  try {
    const r = JSON.parse(localStorage.getItem("lumen-recent") || "[]");
    const updated = [{ name, id, at: Date.now() }, ...r.filter(x => x.id !== id)].slice(0, 10);
    localStorage.setItem("lumen-recent", JSON.stringify(updated));
  } catch(e) {}
}

/* ── Library modal ── */
const LibraryModal = (() => {
  let overlay, listEl, nameInput;

  async function refresh() {
    listEl.innerHTML = '<div class="empty-hint pad" style="padding:16px">Loading…</div>';
    try {
      const items = await ProjectLibrary.list();
      items.sort((a, b) => b.savedAt - a.savedAt);
      listEl.innerHTML = "";
      if (!items.length) {
        listEl.innerHTML = '<div class="empty-hint pad">No saved projects yet.<br>Type a name below and click Save.</div>';
        return;
      }
      const recents = (() => { try { return JSON.parse(localStorage.getItem("lumen-recent") || "[]").slice(0, 5); } catch(e) { return []; } })();
      if (recents.length) {
        const recentDiv = document.createElement("div");
        recentDiv.innerHTML = `<div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--text-3);margin-bottom:6px">Recent</div>`;
        recents.forEach(r => {
          const btn = document.createElement("div");
          btn.className = "lib-item";
          btn.style.cursor = "pointer";
          const ago = Math.round((Date.now() - r.at) / 60000);
          const agoStr = ago < 60 ? ago + "m ago" : Math.round(ago/60) + "h ago";
          btn.innerHTML = `<div class="lib-info"><div class="lib-name">${r.name}</div><div class="lib-date dim">${agoStr}</div></div>`;
          btn.addEventListener("click", async () => {
            const entry = await ProjectLibrary.load(r.id).catch(() => null);
            if (entry) { loadProjectJSON(entry.data); LibraryModal.close(); toast("Loaded: " + entry.name); }
            else toast("Project not found in library");
          });
          recentDiv.appendChild(btn);
        });
        listEl.appendChild(recentDiv);
      }
      items.forEach(p => {
        const row = document.createElement("div");
        row.className = "lib-item";
        const info = document.createElement("div");
        info.className = "lib-info";
        const nm = document.createElement("div");
        nm.className = "lib-name";
        nm.textContent = p.name;
        const dt = document.createElement("div");
        dt.className = "lib-date dim";
        dt.textContent = new Date(p.savedAt).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" });
        info.append(nm, dt);
        const acts = document.createElement("div");
        acts.className = "lib-actions";

        const loadBtn = document.createElement("button");
        loadBtn.className = "btn ghost sm";
        loadBtn.textContent = "Load";
        loadBtn.addEventListener("click", async () => {
          if (App.dirty && !confirm("Discard unsaved changes?")) return;
          try {
            const entry = await ProjectLibrary.load(p.id);
            if (!entry) { toast("Not found"); return; }
            loadProjectJSON(entry.data);
            trackRecent(p.name, p.id);
            document.getElementById("project-name").value = App.project.name;
            Viewport.fit(); Timeline.fit();
            toast("Loaded: " + entry.name);
            close();
          } catch (e) { toast("Error: " + e.message); }
        });

        const overBtn = document.createElement("button");
        overBtn.className = "btn ghost sm";
        overBtn.title = "Overwrite with current project";
        overBtn.textContent = "Overwrite";
        overBtn.addEventListener("click", async () => {
          if (!confirm(`Overwrite "${p.name}" with the current project?`)) return;
          try {
            await ProjectLibrary.save(p.name, p.id);
            toast("Overwritten: " + p.name);
            refresh();
          } catch (e) { toast("Error: " + e.message); }
        });

        const delBtn = document.createElement("button");
        delBtn.className = "btn ghost sm";
        delBtn.style.color = "var(--danger)";
        delBtn.textContent = "Delete";
        delBtn.addEventListener("click", async () => {
          if (!confirm(`Delete "${p.name}"?`)) return;
          await ProjectLibrary.remove(p.id);
          toast("Deleted");
          refresh();
        });

        acts.append(loadBtn, overBtn, delBtn);
        row.append(info, acts);
        listEl.appendChild(row);
      });
    } catch (e) {
      listEl.innerHTML = `<div class="empty-hint pad">Library unavailable: ${e.message}</div>`;
    }
  }

  function open() {
    nameInput.value = App.project.name;
    overlay.hidden = false;
    refresh();
  }
  function close() { overlay.hidden = true; }

  function init() {
    overlay = document.getElementById("library-overlay");
    listEl = document.getElementById("library-list");
    nameInput = document.getElementById("library-name-input");

    document.getElementById("library-close").addEventListener("click", close);
    overlay.addEventListener("pointerdown", e => { if (e.target === overlay) close(); });

    document.getElementById("library-save-btn").addEventListener("click", async () => {
      const name = nameInput.value.trim() || App.project.name;
      try {
        await ProjectLibrary.save(name);
        toast("Saved to library: " + name);
        refresh();
      } catch (e) { toast("Could not save: " + e.message); }
    });

    document.getElementById("btn-library").addEventListener("click", open);
  }

  return { init, open, close };
})();

/* ── minimal ZIP writer (store method) ── */
const Zip = (() => {
  const crcTable = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(data) {
    let c = 0xffffffff;
    for (let i = 0; i < data.length; i++) c = crcTable[(c ^ data[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  function build(entries) {
    const enc = new TextEncoder();
    const chunks = [], central = [];
    let offset = 0;
    entries.forEach(({ name, data }) => {
      const nameB = enc.encode(name);
      const crc = crc32(data);
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, data.length, true);
      local.setUint32(22, data.length, true);
      local.setUint16(26, nameB.length, true);
      chunks.push(new Uint8Array(local.buffer), nameB, data);
      const cd = new DataView(new ArrayBuffer(46));
      cd.setUint32(0, 0x02014b50, true);
      cd.setUint16(4, 20, true); cd.setUint16(6, 20, true);
      cd.setUint32(16, crc, true);
      cd.setUint32(20, data.length, true);
      cd.setUint32(24, data.length, true);
      cd.setUint16(28, nameB.length, true);
      cd.setUint32(42, offset, true);
      central.push(new Uint8Array(cd.buffer), nameB);
      offset += 30 + nameB.length + data.length;
    });
    let cdSize = 0;
    central.forEach(c => cdSize += c.length);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, entries.length, true);
    end.setUint16(10, entries.length, true);
    end.setUint32(12, cdSize, true);
    end.setUint32(16, offset, true);
    return new Blob([...chunks, ...central, new Uint8Array(end.buffer)], { type: "application/zip" });
  }
  return { build };
})();

/* ── Lottie exporter (basic shapes/text/transforms) ── */
const LottieExporter = (() => {
  function animK(p, comp) {
    const fps = comp.fps;
    if (!p.anim || !p.keys.length) {
      const v = p.value;
      return { a: 0, k: Array.isArray(v) ? v : [v] };
    }
    const ks = p.keys.map((k, i) => {
      const nxt = p.keys[i + 1];
      const s = Array.isArray(k.v) ? k.v : [k.v];
      const e = nxt ? (Array.isArray(nxt.v) ? nxt.v : [nxt.v]) : s;
      return { t: Math.round(k.t * fps), s, e, i: { x: [0.4], y: [0] }, o: { x: [0.6], y: [1] }, h: k.ease === "hold" ? 1 : 0 };
    });
    return { a: 1, k: ks };
  }

  function exportComp(comp) {
    const layers = comp.layers.filter(l => !["audio"].includes(l.type)).map((l, li) => {
      const ks = {
        p: animK(l.props.position, comp),
        s: animK(l.props.scale, comp),
        r: animK(l.props.rotation, comp),
        o: animK(l.props.opacity, comp),
        a: animK(l.props.anchor, comp),
      };
      const base = {
        nm: l.name, ind: li + 1,
        ip: Math.round(l.inPoint * comp.fps),
        op: Math.round(l.outPoint * comp.fps),
        st: 0, ks,
      };
      if (l.type === "solid") {
        return { ...base, ty: 1, sc: l.data.color || "#5e6ad2", sw: l.data.w || 100, sh: l.data.h || 100 };
      }
      if (l.type === "nullobj") {
        return { ...base, ty: 3 };
      }
      if (l.type === "text" && l.data) {
        return { ...base, ty: 5 };
      }
      if (l.type === "comp") {
        const ri = App.project.comps.findIndex(c => c.id === l.data.compId) + 1;
        return { ...base, ty: 0, refId: "comp_" + l.data.compId, w: comp.width, h: comp.height };
      }
      return { ...base, ty: 4 };
    });

    const assets = App.project.comps.filter(c => c.id !== comp.id).map(c => ({
      id: "comp_" + c.id, layers: [],
    }));

    return {
      v: "5.7.4", nm: comp.name,
      w: comp.width, h: comp.height,
      ip: 0, op: Math.round(comp.duration * comp.fps),
      fr: comp.fps,
      assets, layers,
    };
  }

  function exportCurrent() {
    const json = JSON.stringify(exportComp(App.comp), null, 2);
    const blob = new Blob([json], { type: "application/json" });
    Exporter.download(blob, App.project.name.replace(/\s+/g, "-") + "-lottie.json");
    toast("Lottie JSON exported");
  }

  return { exportCurrent };
})();

/* ── export ── */
const Exporter = (() => {
  let recording = false, recorder = null, cancelled = false;

  function open() {
    document.getElementById("export-overlay").hidden = false;
    document.getElementById("export-progress").hidden = true;
    document.getElementById("export-start").disabled = false;
  }
  function close() {
    if (recording) stop(true);
    cancelled = true;
    document.getElementById("export-overlay").hidden = true;
  }

  function getOpts() {
    return {
      format: document.getElementById("export-format").value,
      bitrate: parseInt(document.getElementById("export-quality").value, 10),
      scale: parseFloat(document.getElementById("export-scale").value),
      range: document.getElementById("export-range").value,
    };
  }
  function rangeBounds(opts) {
    const c = App.comp;
    if (opts.range === "work" && c.workEnd > c.workStart + 0.05) return [c.workStart, c.workEnd];
    return [0, c.duration];
  }

  function makeCanvas(scale) {
    const c = App.comp;
    const cv = document.createElement("canvas");
    cv.width = Math.max(2, Math.round(c.width * scale));
    cv.height = Math.max(2, Math.round(c.height * scale));
    return cv;
  }

  function exportPNG(opts) {
    const cv = makeCanvas(opts.scale);
    Renderer.draw(cv.getContext("2d"), App.time, { scale: opts.scale });
    cv.toBlob(blob => {
      download(blob, `${App.project.name.replace(/\s+/g, "-")}-${timecode(App.time).replace(/:/g, ".")}.png`);
      toast("Frame exported");
      close();
    }, "image/png");
  }

  async function exportPNGSeq(opts) {
    const c = App.comp;
    const [t0, t1] = rangeBounds(opts);
    const frames = Math.max(1, Math.round((t1 - t0) * c.fps));
    const cv = makeCanvas(opts.scale);
    const cctx = cv.getContext("2d");
    const fill = document.getElementById("export-progress-fill");
    const label = document.getElementById("export-progress-label");
    document.getElementById("export-progress").hidden = false;
    document.getElementById("export-start").disabled = true;
    cancelled = false;
    const entries = [];
    for (let f = 0; f < frames; f++) {
      if (cancelled) return;
      const t = t0 + f / c.fps;
      Renderer.draw(cctx, t, { scale: opts.scale });
      const blob = await new Promise(res => cv.toBlob(res, "image/png"));
      const buf = new Uint8Array(await blob.arrayBuffer());
      entries.push({ name: `frame_${String(f).padStart(4, "0")}.png`, data: buf });
      fill.style.width = ((f + 1) / frames) * 100 + "%";
      label.textContent = `Rendering frame ${f + 1} / ${frames}`;
      await new Promise(r => setTimeout(r, 0));
    }
    label.textContent = "Building ZIP…";
    const zip = Zip.build(entries);
    download(zip, `${App.project.name.replace(/\s+/g, "-")}-frames.zip`);
    toast(`Exported ${frames} frames`);
    close();
  }

  async function exportGIF(opts) {
    toast("GIF: exporting as PNG sequence (no native GIF encoder)");
    return exportPNGSeq(opts);
  }

  function exportWebM(opts) {
    if (typeof MediaRecorder === "undefined") {
      toast("MediaRecorder not supported in this browser");
      return;
    }
    const c = App.comp;
    const [t0, t1] = rangeBounds(opts);
    const cv = makeCanvas(opts.scale);
    const cctx = cv.getContext("2d");
    const stream = cv.captureStream(c.fps);

    let audioDest = null;
    const hasAudio = App.layers.some(l => l.type === "audio" && l.visible);
    if (hasAudio) {
      try {
        AudioEngine.ensure();
        audioDest = AudioEngine.ctx.createMediaStreamDestination();
        AudioEngine.masterGain.connect(audioDest);
        audioDest.stream.getAudioTracks().forEach(tr => stream.addTrack(tr));
      } catch (e) { audioDest = null; }
    }

    const mime = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"]
      .find(m => MediaRecorder.isTypeSupported(m)) || "video/webm";
    const chunks = [];
    recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: opts.bitrate });
    recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    recorder.onstop = () => {
      if (audioDest) { try { AudioEngine.masterGain.disconnect(audioDest); } catch (e) {} }
      AudioEngine.pauseAll();
      if (!recording) return;
      recording = false;
      const blob = new Blob(chunks, { type: "video/webm" });
      download(blob, `${App.project.name.replace(/\s+/g, "-")}.webm`);
      toast("Export complete");
      close();
    };

    App.setPlaying(false);
    Renderer.pauseAllVideos();
    recording = true;
    document.getElementById("export-progress").hidden = false;
    document.getElementById("export-start").disabled = true;

    const fill = document.getElementById("export-progress-fill");
    const label = document.getElementById("export-progress-label");
    const dur = t1 - t0;
    const start = performance.now();
    recorder.start(200);
    const wasPlaying = App.playing;
    App.playing = true;
    AudioEngine.sync();

    (function frame() {
      if (!recording) { App.playing = wasPlaying; return; }
      const t = (performance.now() - start) / 1000;
      if (t >= dur) {
        Renderer.draw(cctx, t1, { scale: opts.scale });
        label.textContent = "Encoding…";
        fill.style.width = "100%";
        App.playing = false;
        recorder.stop();
        return;
      }
      Renderer.draw(cctx, t0 + t, { scale: opts.scale });
      App.time = t0 + t;
      App.emit("time", { playback: true });
      AudioEngine.sync();
      fill.style.width = (t / dur) * 100 + "%";
      label.textContent = `Rendering… ${timecode(t0 + t)} / ${timecode(t1)}`;
      requestAnimationFrame(frame);
    })();
  }

  function stop(wasCancelled) {
    recording = false;
    App.playing = false;
    AudioEngine.pauseAll();
    if (recorder && recorder.state !== "inactive") recorder.stop();
    recorder = null;
    if (wasCancelled) toast("Export cancelled");
  }

  async function exportMP4(opts) {
    if (!window.VideoEncoder) {
      toast("WebCodecs not supported in this browser. Using WebM instead.");
      return exportWebM(opts);
    }
    const c = App.comp;
    const [t0, t1] = rangeBounds(opts);
    const frames = Math.max(1, Math.round((t1 - t0) * c.fps));
    const cv = makeCanvas(opts.scale);
    const cctx = cv.getContext("2d");
    const W = cv.width, H = cv.height;
    const fill = document.getElementById("export-progress-fill");
    const label = document.getElementById("export-progress-label");
    document.getElementById("export-progress").hidden = false;
    document.getElementById("export-start").disabled = true;
    cancelled = false;

    // Check if mp4-muxer is available
    if (typeof Muxer === "undefined" || !Muxer.Muxer) {
      toast("mp4-muxer not loaded. Using PNG sequence instead.");
      return exportPNGSeq(opts);
    }

    const muxer = new Muxer.Muxer({
      target: new Muxer.ArrayBufferTarget(),
      video: { codec: "avc", width: W, height: H },
      fastStart: "in-memory",
    });

    const encoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: e => { toast("Encode error: " + e.message); },
    });
    encoder.configure({
      codec: "avc1.42001f",
      width: W, height: H,
      bitrate: opts.bitrate || 8000000,
      framerate: c.fps,
    });

    for (let f = 0; f < frames; f++) {
      if (cancelled) { encoder.close(); return; }
      const t = t0 + f / c.fps;
      Renderer.draw(cctx, t, { scale: opts.scale });
      const frame = new VideoFrame(cv, { timestamp: Math.round(f * 1e6 / c.fps), duration: Math.round(1e6 / c.fps) });
      const keyFrame = f % Math.round(c.fps * 2) === 0;
      encoder.encode(frame, { keyFrame });
      frame.close();
      fill.style.width = ((f + 1) / frames) * 100 + "%";
      label.textContent = `Encoding frame ${f + 1} / ${frames}`;
      if (f % 4 === 0) await new Promise(r => setTimeout(r, 0));
    }

    await encoder.flush();
    encoder.close();
    muxer.finalize();
    const { buffer } = muxer.target;
    const blob = new Blob([buffer], { type: "video/mp4" });
    download(blob, `${App.project.name.replace(/\s+/g, "-")}.mp4`);
    toast("MP4 export complete");
    close();
  }

  function start() {
    const opts = getOpts();
    if (opts.format === "png") exportPNG(opts);
    else if (opts.format === "pngseq") exportPNGSeq(opts);
    else if (opts.format === "gif") exportGIF(opts);
    else if (opts.format === "mp4") exportMP4(opts);
    else exportWebM(opts);
  }

  async function copyFrameToClipboard() {
    try {
      const cv = makeCanvas(1);
      Renderer.draw(cv.getContext("2d"), App.time, { scale: 1 });
      const blob = await new Promise(res => cv.toBlob(res, "image/png"));
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      toast("Frame copied to clipboard");
    } catch (e) {
      toast("Clipboard not available");
    }
  }

  function download(blob, name) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  return { open, close, start, stop, download, copyFrameToClipboard };
})();

/* ── graph editor ── */
const GraphEditor = (() => {
  let prop = null, canvas, gctx;
  const PAD = { l: 44, r: 14, t: 14, b: 24 };

  function open(p, title) {
    if (!p.anim || !p.keys.length) { toast("Property has no keyframes"); return; }
    prop = p;
    document.getElementById("graph-overlay").hidden = false;
    document.getElementById("graph-title").textContent = title || "Graph editor";
    canvas = document.getElementById("graph-canvas");
    gctx = canvas.getContext("2d");
    render();
  }
  function close() {
    document.getElementById("graph-overlay").hidden = true;
    prop = null;
  }
  function isOpen() { return prop !== null; }

  function valueRange() {
    let lo = Infinity, hi = -Infinity;
    prop.keys.forEach(k => {
      const vs = Array.isArray(k.v) ? k.v : [k.v];
      vs.forEach(v => { lo = Math.min(lo, v); hi = Math.max(hi, v); });
    });
    if (!isFinite(lo)) { lo = 0; hi = 1; }
    if (hi - lo < 1e-6) { lo -= 1; hi += 1; }
    const pad = (hi - lo) * 0.15;
    return [lo - pad, hi + pad];
  }

  function xOf(t) { return PAD.l + (t / App.comp.duration) * (canvas.width - PAD.l - PAD.r); }
  function yOf(v, lo, hi) { return canvas.height - PAD.b - ((v - lo) / (hi - lo)) * (canvas.height - PAD.t - PAD.b); }
  function tOf(x) { return clamp(((x - PAD.l) / (canvas.width - PAD.l - PAD.r)) * App.comp.duration, 0, App.comp.duration); }
  function vOf(y, lo, hi) { return lo + ((canvas.height - PAD.b - y) / (canvas.height - PAD.t - PAD.b)) * (hi - lo); }

  function render() {
    if (!prop) return;
    const W = canvas.width, H = canvas.height;
    const [lo, hi] = valueRange();
    gctx.clearRect(0, 0, W, H);
    gctx.fillStyle = "#0f1011";
    gctx.fillRect(0, 0, W, H);

    gctx.strokeStyle = "#1b1d22";
    gctx.fillStyle = "#5e636e";
    gctx.font = "10px ui-monospace, monospace";
    gctx.lineWidth = 1;
    gctx.beginPath();
    for (let i = 0; i <= 5; i++) {
      const v = lo + ((hi - lo) * i) / 5;
      const y = yOf(v, lo, hi);
      gctx.moveTo(PAD.l, y); gctx.lineTo(W - PAD.r, y);
      gctx.fillText((Math.round(v * 10) / 10).toString(), 4, y + 3);
    }
    for (let s = 0; s <= App.comp.duration; s++) {
      const x = xOf(s);
      gctx.moveTo(x, PAD.t); gctx.lineTo(x, H - PAD.b);
      gctx.fillText(s + "s", x + 2, H - 8);
    }
    gctx.stroke();

    gctx.strokeStyle = "#7c89f0";
    gctx.beginPath();
    const px = xOf(App.time);
    gctx.moveTo(px, PAD.t); gctx.lineTo(px, H - PAD.b);
    gctx.stroke();

    const comps = Array.isArray(prop.keys[0].v) ? prop.keys[0].v.length : 1;
    const colors = ["#eb5757", "#4cb782", "#26b5ce"];
    for (let ci = 0; ci < comps; ci++) {
      gctx.strokeStyle = colors[ci % colors.length];
      gctx.lineWidth = 1.5;
      gctx.beginPath();
      const steps = 240;
      for (let i = 0; i <= steps; i++) {
        const t = (App.comp.duration * i) / steps;
        const v = rawEval(prop, t);
        const val = Array.isArray(v) ? v[ci] : v;
        const x = xOf(t), y = yOf(val, lo, hi);
        i === 0 ? gctx.moveTo(x, y) : gctx.lineTo(x, y);
      }
      gctx.stroke();
      prop.keys.forEach(k => {
        const val = Array.isArray(k.v) ? k.v[ci] : k.v;
        const x = xOf(k.t), y = yOf(val, lo, hi);
        gctx.fillStyle = "#0f1011";
        gctx.strokeStyle = colors[ci % colors.length];
        gctx.beginPath();
        gctx.rect(x - 4, y - 4, 8, 8);
        gctx.fill(); gctx.stroke();
      });
    }
  }

  function hitKey(mx, my) {
    if (!prop) return null;
    const [lo, hi] = valueRange();
    const comps = Array.isArray(prop.keys[0].v) ? prop.keys[0].v.length : 1;
    for (const k of prop.keys) {
      for (let ci = 0; ci < comps; ci++) {
        const val = Array.isArray(k.v) ? k.v[ci] : k.v;
        if (Math.abs(mx - xOf(k.t)) < 7 && Math.abs(my - yOf(val, lo, hi)) < 7)
          return { key: k, ci };
      }
    }
    return null;
  }

  function init() {
    canvas = document.getElementById("graph-canvas");
    gctx = canvas.getContext("2d");
    document.getElementById("graph-close").addEventListener("click", close);
    document.getElementById("graph-overlay").addEventListener("pointerdown", e => {
      if (e.target.id === "graph-overlay") close();
    });

    canvas.addEventListener("pointerdown", e => {
      if (!prop) return;
      const rect = canvas.getBoundingClientRect();
      const mx = (e.clientX - rect.left) * (canvas.width / rect.width);
      const my = (e.clientY - rect.top) * (canvas.height / rect.height);
      const hit = hitKey(mx, my);
      if (!hit) {
        App.setTime(snapT(tOf(mx)));
        render();
        return;
      }
      App.commit();
      const [lo, hi] = valueRange();
      startDrag(e, {
        move(ev) {
          const x = (ev.clientX - rect.left) * (canvas.width / rect.width);
          const y = (ev.clientY - rect.top) * (canvas.height / rect.height);
          hit.key.t = snapT(tOf(x));
          const nv = vOf(y, lo, hi);
          if (Array.isArray(hit.key.v)) hit.key.v[hit.ci] = Math.round(nv * 10) / 10;
          else hit.key.v = Math.round(nv * 10) / 10;
          render();
          App.emit("props");
        },
        up() {
          prop.keys.sort((a, b) => a.t - b.t);
          App.emit("project");
          render();
        },
      });
    });
    canvas.addEventListener("contextmenu", e => {
      e.preventDefault();
      if (!prop) return;
      const rect = canvas.getBoundingClientRect();
      const mx = (e.clientX - rect.left) * (canvas.width / rect.width);
      const my = (e.clientY - rect.top) * (canvas.height / rect.height);
      const hit = hitKey(mx, my);
      if (!hit) return;
      const items = Object.keys(EASE_LABELS).map(ease => ({
        label: EASE_LABELS[ease],
        checked: hit.key.ease === ease,
        run: () => { App.commit(); hit.key.ease = ease; App.emit("project"); render(); },
      }));
      showMenu(e.clientX, e.clientY, items);
    });

    App.on("time", () => { if (isOpen()) render(); });
    App.on("project", () => { if (isOpen() && prop && (!prop.anim || !prop.keys.length)) close(); else if (isOpen()) render(); });
  }

  return { init, open, close, isOpen };
})();

/* ── comp tabs ── */
const CompTabs = (() => {
  function render() {
    const host = document.getElementById("comp-tabs");
    host.innerHTML = "";
    App.project.comps.forEach(c => {
      const tab = document.createElement("button");
      tab.className = "comp-tab" + (c.id === App.project.activeCompId ? " active" : "");
      tab.textContent = c.name;
      tab.title = `${c.width}×${c.height} · ${c.fps}fps`;
      tab.addEventListener("click", () => App.setActiveComp(c.id));
      tab.addEventListener("dblclick", () => {
        const name = prompt("Composition name:", c.name);
        if (name) { App.commit(); c.name = name; render(); App.emit("project"); }
      });
      tab.addEventListener("contextmenu", e => {
        e.preventDefault();
        showMenu(e.clientX, e.clientY, [
          { label: "Rename…", run: () => { const n = prompt("Composition name:", c.name); if (n) { App.commit(); c.name = n; render(); App.emit("project"); } } },
          { label: "Duplicate comp", run: () => {
            App.commit();
            const copy = JSON.parse(JSON.stringify(c));
            copy.id = uid(); copy.name = c.name + " copy";
            copy.layers.forEach(l => { l.id = uid(); });
            App.project.comps.push(copy);
            render();
          } },
          { label: "Comp settings…", run: () => {
            const w = prompt("Width:", c.width); if (!w) return;
            const h = prompt("Height:", c.height); if (!h) return;
            App.commit(); c.width = parseInt(w) || c.width; c.height = parseInt(h) || c.height;
            App.emit("project"); Viewport.fit();
          } },
          "-",
          { label: "Delete comp", danger: true, run: () => {
            App.commit();
            if (!Comps.remove(c.id)) toast("Can't delete: comp is in use or is the last one");
          } },
        ]);
      });
      host.appendChild(tab);
    });
    const add = document.createElement("button");
    add.className = "comp-tab add";
    add.textContent = "+";
    add.title = "New composition";
    add.addEventListener("click", () => {
      App.commit();
      const src = App.comp;
      const c = Comps.create(null, src.width, src.height, src.fps, src.duration);
      App.setActiveComp(c.id);
    });
    host.appendChild(add);
  }
  function init() {
    App.on("comps", render);
    App.on("project", render);
  }
  return { init, render };
})();

/* ── command palette ── */
const Palette = (() => {
  let items = [], active = 0, filtered = [];

  function actions() {
    const sel = App.selectedLayer();
    const c = App.comp;
    const allEffects = Object.entries(EFFECTS).map(([k, v]) =>
      sel && { title: `Add effect: ${v.label}`, run: () => { App.commit(); Layers.addEffect(sel, k); } }
    ).filter(Boolean);

    return [
      // layers
      { title: "New text layer", hint: "T", run: () => { App.commit(); Layers.add(makeLayer("text")); } },
      { title: "New solid layer", run: () => { App.commit(); Layers.add(makeLayer("solid")); } },
      { title: "New shape layer", run: () => { App.commit(); Layers.add(makeLayer("shape")); } },
      { title: "New adjustment layer", run: () => { App.commit(); Layers.add(makeLayer("adjust")); } },
      { title: "New null object", run: () => { App.commit(); Layers.add(makeLayer("nullobj")); } },
      { title: "New composition", run: () => { App.commit(); const cc = Comps.create(); App.setActiveComp(cc.id); } },
      { title: "Import media…", run: () => document.getElementById("file-import").click() },
      { title: "Import font…", run: () => document.getElementById("file-font").click() },

      // playback
      { title: "Play / Pause", hint: "Space", run: () => Playback.toggle() },
      { title: "Toggle loop playback", run: () => { App.loop = !App.loop; toast(App.loop ? "Loop on" : "Loop off"); document.getElementById("btn-loop").classList.toggle("active", App.loop); } },
      { title: "Go to start", hint: "Home", run: () => App.setTime(0) },
      { title: "Go to end", hint: "End", run: () => App.setTime(c.duration) },

      // timeline
      { title: "Add marker at playhead", hint: "M", run: () => Timeline.addMarker() },
      { title: "Next marker", hint: "⇧.", run: () => UICommands.jumpMarker(1) },
      { title: "Previous marker", hint: "⇧,", run: () => UICommands.jumpMarker(-1) },
      { title: "Set work area start", hint: "B", run: () => { App.commit(); c.workStart = Math.min(snapT(App.time), c.workEnd - 0.1); Timeline.drawRuler(); } },
      { title: "Set work area end", hint: "N", run: () => { App.commit(); c.workEnd = Math.max(snapT(App.time), c.workStart + 0.1); Timeline.drawRuler(); } },

      // selection ops
      sel && { title: `Duplicate "${sel.name}"`, hint: "⌘D", run: () => { App.commit(); Layers.duplicate(sel.id); } },
      sel && { title: `Split "${sel.name}" at playhead`, run: () => { App.commit(); Layers.split(sel.id, snapT(App.time)); } },
      sel && { title: `Delete selected`, hint: "⌫", run: () => { App.commit(); Layers.removeMany(App.selectedIds()); } },
      sel && { title: "Precompose selection", run: () => { App.commit(); Comps.precompose(); } },
      sel && { title: "Center layer in comp", run: () => { App.commit(); Layers.setProp(sel, "position", [c.width / 2, c.height / 2]); App.emit("project"); } },
      sel && { title: "Fit layer to comp", run: () => UICommands.fitLayerToComp(sel) },
      sel && { title: "Flip horizontal", run: () => UICommands.flip(sel, "h") },
      sel && { title: "Flip vertical", run: () => UICommands.flip(sel, "v") },
      sel && { title: "Reset transform", run: () => UICommands.resetTransform(sel) },
      sel && { title: "Copy layers", hint: "⌘C", run: () => UIClipboard.copyLayers() },
      { title: "Paste layers", hint: "⌘V", run: () => UIClipboard.pasteLayers() },
      sel && { title: "Copy effects", run: () => UIClipboard.copyEffects() },
      sel && { title: "Paste effects", run: () => UIClipboard.pasteEffects() },
      { title: "Paste keyframes at playhead", run: () => UIClipboard.pasteKeys() },
      { title: "Easy ease selected keyframes", hint: "F9", run: () => UICommands.easyEaseSelected() },
      { title: "Reverse selected keyframes", run: () => UICommands.reverseKeys() },
      { title: "Sequence layers (stagger)", run: () => UICommands.sequenceLayers() },
      { title: "Select all layers", hint: "⌘A", run: () => selectAll() },

      // layer new features
      sel && { title: "Start motion sketch", run: () => MotionSketch.start() },
      sel && { title: "Enable time remap", run: () => { App.commit(); Layers.enableTimeRemap(sel); App.emit("project"); } },
      sel && { title: "Disable time remap", run: () => { App.commit(); Layers.disableTimeRemap(sel); App.emit("project"); } },
      sel && { title: "Toggle auto-orient to path", run: () => { App.commit(); sel.autoOrient = !sel.autoOrient; App.emit("project"); toast("Auto-orient: " + (sel.autoOrient ? "on" : "off")); } },
      sel && { title: "Toggle hold frame", run: () => { App.commit(); sel.holdFrame = !sel.holdFrame; App.emit("project"); toast("Hold frame: " + (sel.holdFrame ? "on" : "off")); } },
      sel && { title: "Toggle posterize time", run: () => { App.commit(); sel.posterizeTime = !sel.posterizeTime; App.emit("project"); toast("Posterize time: " + (sel.posterizeTime ? "on" : "off")); } },
      sel && { title: "Toggle collapse transform", run: () => { App.commit(); sel.collapseTransform = !sel.collapseTransform; App.emit("project"); toast("Collapse transform: " + (sel.collapseTransform ? "on" : "off")); } },
      sel && { title: "Add note to layer…", run: () => { const n = prompt("Layer note:", sel.notes || ""); if (n !== null) { App.commit(); sel.notes = n; App.emit("project"); } } },

      // comp
      { title: "Toggle comp motion blur", run: () => { App.commit(); c.motionBlur = !c.motionBlur; App.emit("project"); } },
      { title: "Toggle transparent background", run: () => { App.commit(); c.bgAlpha = !c.bgAlpha; App.emit("project"); } },
      { title: "Clear ruler guides", run: () => UICommands.deleteGuides() },
      { title: "Toggle snap to grid", run: () => UICommands.snapToGrid() },

      // view
      { title: "Fit viewport", hint: "F", run: () => Viewport.fit() },
      { title: "Fit timeline", run: () => Timeline.fit() },
      { title: "Toggle side panels", hint: "Tab", run: () => togglePanels() },

      // undo
      { title: "Undo", hint: "⌘Z", run: () => History.undo() },
      { title: "Redo", hint: "⇧⌘Z", run: () => History.redo() },

      // export
      { title: "Export…", run: () => Exporter.open() },
      { title: "Export Lottie JSON", run: () => LottieExporter.exportCurrent() },
      { title: "Copy frame to clipboard", run: () => Exporter.copyFrameToClipboard() },

      // project / library
      { title: "Save project (.lumen)", hint: "⌘S", run: saveProject },
      { title: "Open project…", hint: "⌘O", run: () => document.getElementById("file-open").click() },
      { title: "New project", run: () => newProject(true) },
      { title: "Save to project library", run: () => LibraryModal.open() },
      { title: "Load from project library", run: () => LibraryModal.open() },
      { title: "Load demo project", run: () => { newProject(false); buildDemo(); afterProjectLoad("Welcome to Lumen"); } },

      // help
      { title: "Keyboard shortcuts", hint: "?", run: () => showShortcuts() },
      { title: "Settings…", hint: "⚙", run: () => Settings.openModal() },

      // RAM preview
      { title: "Build RAM preview", run: () => RamPreview.build() },
      { title: "Clear RAM preview", run: () => { RamPreview.clear(); toast("RAM preview cleared"); } },

      // pen tool
      { title: "Toggle pen tool", hint: "P", run: () => typeof Viewport !== "undefined" && Viewport.togglePenTool() },

      // motion / stabilizer
      sel && sel.type === "video" && { title: "Warp stabilize this layer", run: () => WarpStabilizer.stabilize(sel) },
      sel && { title: "Track motion to layer…", run: () => {
        const vidL = App.layers.find(l => l.type === "video");
        if (!vidL) { toast("No video layer found"); return; }
        MotionTracker.track(vidL, sel);
      }},

      // script editor
      { title: "Open Script Editor", run: () => ScriptEditor.open() },

      // desktop
      { title: "Download desktop app (Electron)", run: () => downloadDesktopApp() },

      // dynamic: add any effect to selected layer
      ...allEffects,
    ].filter(Boolean);
  }

  function open() {
    items = actions();
    document.getElementById("palette-overlay").hidden = false;
    const input = document.getElementById("palette-input");
    input.value = "";
    input.focus();
    active = 0;
    render("");
  }
  function close() {
    document.getElementById("palette-overlay").hidden = true;
    document.getElementById("palette-input").blur();
  }
  function isOpen() { return !document.getElementById("palette-overlay").hidden; }

  function render(q) {
    const list = document.getElementById("palette-list");
    const needle = q.trim().toLowerCase();
    filtered = needle ? items.filter(it => it.title.toLowerCase().includes(needle)) : items;
    active = clamp(active, 0, Math.max(0, filtered.length - 1));
    list.innerHTML = "";
    if (!filtered.length) {
      list.innerHTML = `<div class="palette-empty">No matching commands</div>`;
      return;
    }
    filtered.slice(0, 60).forEach((it, i) => {
      const el = document.createElement("div");
      el.className = "palette-item" + (i === active ? " active" : "");
      el.innerHTML = `<span class="pi-title">${escapeHtml(it.title)}</span>` +
        (it.hint ? `<span class="pi-hint">${it.hint}</span>` : "");
      el.addEventListener("click", () => { close(); it.run(); });
      el.addEventListener("pointermove", () => { if (active !== i) { active = i; render(q); } });
      list.appendChild(el);
    });
    const act = list.children[active];
    if (act && act.scrollIntoView) act.scrollIntoView({ block: "nearest" });
  }

  function init() {
    const input = document.getElementById("palette-input");
    input.addEventListener("input", () => { active = 0; render(input.value); });
    input.addEventListener("keydown", e => {
      e.stopPropagation();
      if (e.key === "Escape") close();
      if (e.key === "ArrowDown") { e.preventDefault(); active++; render(input.value); }
      if (e.key === "ArrowUp") { e.preventDefault(); active--; render(input.value); }
      if (e.key === "Enter" && filtered[active]) { close(); filtered[active].run(); }
    });
    document.getElementById("palette-overlay").addEventListener("pointerdown", e => {
      if (e.target.id === "palette-overlay") close();
    });
    document.getElementById("btn-palette").addEventListener("click", open);
  }

  return { init, open, close, isOpen };
})();

/* ── Settings ── */
const Settings = (() => {
  const DEFAULTS = {
    defaultFPS: 30, defaultWidth: 1280, defaultHeight: 720,
    exportQuality: "high", autosaveInterval: 25,
    snapGrid: false, previewQuality: 1, theme: "dark",
    ramPreviewMaxFrames: 300, showTooltips: true,
    rendererQuality: "auto", audioSampleRate: 44100,
  };
  let data = { ...DEFAULTS };

  function load() {
    try { Object.assign(data, JSON.parse(localStorage.getItem("lumen.settings") || "{}")); } catch (e) {}
  }
  function save() {
    try { localStorage.setItem("lumen.settings", JSON.stringify(data)); } catch (e) {}
  }
  function get(key) { return data[key] ?? DEFAULTS[key]; }
  function set(key, value) { data[key] = value; save(); App.emit("settings"); }

  function openModal() {
    const ov = document.getElementById("settings-overlay");
    if (!ov) return;
    ov.hidden = false;
    const body = document.getElementById("settings-body");
    if (!body) return;
    body.innerHTML = "";

    const mk = (label, ctrl) => {
      const row = document.createElement("div");
      row.className = "form-row";
      const l = document.createElement("label");
      l.textContent = label;
      row.append(l, ctrl);
      return row;
    };
    const sel = (key, opts) => {
      const s = document.createElement("select");
      opts.forEach(([v, lab]) => { const o = document.createElement("option"); o.value = v; o.textContent = lab; s.appendChild(o); });
      s.value = String(get(key));
      s.addEventListener("change", () => set(key, s.options[s.selectedIndex].value));
      return s;
    };
    const num = (key, min, max, step) => {
      const i = document.createElement("input");
      i.type = "number"; i.value = get(key); i.min = min; i.max = max; i.step = step || 1;
      i.addEventListener("change", () => { const v = parseFloat(i.value); if (!isNaN(v)) set(key, clamp(v, min, max)); });
      i.addEventListener("keydown", e => e.stopPropagation());
      return i;
    };
    const chk = (key, label) => {
      const lab = document.createElement("label");
      lab.style.cssText = "display:flex;align-items:center;gap:6px";
      const c = document.createElement("input");
      c.type = "checkbox"; c.checked = !!get(key);
      c.addEventListener("change", () => set(key, c.checked));
      lab.append(c, document.createTextNode(label));
      return lab;
    };

    body.append(
      Object.assign(document.createElement("h4"), { textContent: "Composition Defaults", className: "settings-head" }),
      mk("Default FPS", sel("defaultFPS", [["24","24 fps"],["25","25 fps (PAL)"],["30","30 fps"],["60","60 fps"]])),
      mk("Default Size", sel("defaultWidth", [["1920","1920 (1080p)"],["1280","1280 (720p)"],["3840","3840 (4K)"],["1080","1080 (Square/Vertical)"]])),

      Object.assign(document.createElement("h4"), { textContent: "Export", className: "settings-head" }),
      mk("Export Quality", sel("exportQuality", [["high","High"],["medium","Medium"],["low","Low"]])),
      mk("Preview Quality", sel("previewQuality", [["1","Full"],["0.5","Half"],["0.25","Quarter"]])),
      mk("RAM Preview Max Frames", num("ramPreviewMaxFrames", 30, 1800, 30)),

      Object.assign(document.createElement("h4"), { textContent: "Interface", className: "settings-head" }),
      mk("Autosave Interval (s)", num("autosaveInterval", 0, 300, 5)),
      mk("", chk("showTooltips", "Show tooltips")),
      mk("", chk("snapGrid", "Snap to grid")),
    );

    // Performance section
    const perfHead = Object.assign(document.createElement("h4"), { textContent: "Performance", className: "settings-head" });
    body.appendChild(perfHead);

    const cachedAssets = typeof assetCache !== "undefined" ? assetCache.size : 0;
    const estMem = typeof assetCache !== "undefined" ? (cachedAssets * 2).toFixed(1) + " MB (est.)" : "N/A";

    const perfInfo = document.createElement("div");
    perfInfo.className = "form-row";
    perfInfo.style.cssText = "flex-direction:column;align-items:flex-start;gap:4px";
    perfInfo.innerHTML = `
      <div style="font-size:12px;color:var(--text-2)">Cached assets: <strong>${cachedAssets}</strong></div>
      <div style="font-size:12px;color:var(--text-2)">Est. memory: <strong>${estMem}</strong></div>`;
    body.appendChild(perfInfo);

    const clearCacheBtn = document.createElement("button");
    clearCacheBtn.className = "btn ghost sm";
    clearCacheBtn.textContent = "Clear Caches";
    clearCacheBtn.style.marginTop = "6px";
    clearCacheBtn.addEventListener("click", () => {
      if (typeof assetCache !== "undefined") assetCache.forEach((v, k) => assetCache.delete(k));
      RamPreview.clear();
      toast("Caches cleared");
      Settings.openModal(); // refresh display
    });
    body.appendChild(clearCacheBtn);
  }

  function closeModal() {
    const ov = document.getElementById("settings-overlay");
    if (ov) ov.hidden = true;
  }

  return { load, save, get, set, openModal, closeModal, data };
})();

/* ── MediaStore: persist video/audio blobs in IndexedDB ── */
const MediaStore = (() => {
  let db = null;
  const DB_NAME = "lumen-media-v1";
  const STORE = "blobs";

  async function openDB() {
    if (db) return db;
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = e => {
        const d = e.target.result;
        if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: "id" });
      };
      req.onsuccess = e => { db = e.target.result; resolve(db); };
      req.onerror = e => reject(e.target.error);
    });
  }

  async function put(assetId, blob, type) {
    const d = await openDB();
    return new Promise((resolve, reject) => {
      const tx = d.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put({ id: assetId, blob, type });
      tx.oncomplete = resolve; tx.onerror = e => reject(e.target.error);
    });
  }

  async function get(assetId) {
    const d = await openDB();
    return new Promise((resolve, reject) => {
      const req = d.transaction(STORE, "readonly").objectStore(STORE).get(assetId);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = e => reject(e.target.error);
    });
  }

  async function remove(assetId) {
    const d = await openDB();
    return new Promise((resolve, reject) => {
      const tx = d.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(assetId);
      tx.oncomplete = resolve; tx.onerror = e => reject(e.target.error);
    });
  }

  return { put, get, remove };
})();

/* ── RAM Preview: cache frames as ImageBitmaps for smooth playback ── */
const RamPreview = (() => {
  const cache = new Map();
  let building = false, cancelled = false;

  function clear() {
    cache.forEach(b => { try { b.close(); } catch(e){} });
    cache.clear();
    App.emit("ramprev");
  }

  async function build(onProgress) {
    if (building) { cancelled = true; await new Promise(r => setTimeout(r, 50)); }
    cancelled = false;
    building = true;
    clear();
    const c = App.comp;
    const maxFrames = Settings.get("ramPreviewMaxFrames");
    const t0 = c.workEnd > c.workStart + 0.05 ? c.workStart : 0;
    const t1 = c.workEnd > c.workStart + 0.05 ? c.workEnd : c.duration;
    const totalFrames = Math.min(maxFrames, Math.round((t1 - t0) * c.fps));
    const q = Settings.get("previewQuality");
    const cv = document.createElement("canvas");
    cv.width = Math.max(2, Math.round(c.width * q));
    cv.height = Math.max(2, Math.round(c.height * q));
    const cctx = cv.getContext("2d");

    for (let f = 0; f < totalFrames; f++) {
      if (cancelled) { building = false; return; }
      const t = t0 + f / c.fps;
      Renderer.draw(cctx, t, { scale: q, skipRam: true });
      try {
        const bm = await createImageBitmap(cv);
        cache.set(snapT(t), bm);
      } catch (e) { /* best-effort */ }
      if (onProgress) onProgress((f + 1) / totalFrames, f + 1, totalFrames);
      if (f % 4 === 0) await new Promise(r => setTimeout(r, 0));
    }
    building = false;
    toast(`RAM preview: ${cache.size} frames cached`);
    App.emit("ramprev");
  }

  function has(t) { return cache.has(snapT(t)); }
  function getFrame(t) { return cache.get(snapT(t)) || null; }
  function isBuilding() { return building; }
  function stop() { cancelled = true; }
  function size() { return cache.size; }

  return { build, clear, has, getFrame, isBuilding, stop, size };
})();

/* ── Motion Tracker: SSD-based 2D point tracking ── */
const MotionTracker = (() => {
  async function track(videoLayer, targetLayer) {
    const asset = Assets.find(videoLayer.data.assetId);
    if (!asset || !asset.el || asset.type !== "video") throw new Error("No video asset");
    const vid = asset.el;
    const c = App.comp;
    const t0 = videoLayer.inPoint, t1 = videoLayer.outPoint;
    const frames = Math.min(Math.round((t1 - t0) * c.fps), 300);
    if (frames < 2) throw new Error("Layer too short to track");

    const trackW = 60, trackH = 60;
    const scanW = 120, scanH = 120;
    const cv = document.createElement("canvas");
    cv.width = Math.max(scanW * 2, 320); cv.height = Math.max(scanH * 2, 240);
    const gctx = cv.getContext("2d", { willReadFrequently: true });

    let templateData = null, lastX = c.width / 2, lastY = c.height / 2;
    const keyframes = [];

    for (let f = 0; f < frames; f++) {
      const t = t0 + f / c.fps;
      const localT = mediaTime(videoLayer, t);
      await new Promise(res => {
        vid.currentTime = clamp(localT, 0, (vid.duration || 1) - 0.001);
        vid.onseeked = res;
        setTimeout(res, 200);
      });

      const vw = vid.videoWidth || 320, vh = vid.videoHeight || 240;
      cv.width = vw; cv.height = vh;
      try { gctx.drawImage(vid, 0, 0, vw, vh); } catch(e) { continue; }

      const cx = Math.round(clamp(lastX, trackW / 2, vw - trackW / 2));
      const cy = Math.round(clamp(lastY, trackH / 2, vh - trackH / 2));

      if (!templateData) {
        // First frame: sample template region
        const rx = cx - trackW / 2, ry = cy - trackH / 2;
        templateData = gctx.getImageData(rx, ry, trackW, trackH).data;
        keyframes.push({ t, x: cx / vw * c.width, y: cy / vh * c.height });
        continue;
      }

      // Search for best match via SSD
      const sx = Math.max(trackW / 2, cx - scanW / 2), ex = Math.min(vw - trackW / 2, cx + scanW / 2);
      const sy = Math.max(trackH / 2, cy - scanH / 2), ey = Math.min(vh - trackH / 2, cy + scanH / 2);
      let bestSSD = Infinity, bestX = cx, bestY = cy;

      for (let ty = sy; ty <= ey; ty += 4) {
        for (let tx = sx; tx <= ex; tx += 4) {
          const candidate = gctx.getImageData(tx - trackW / 2, ty - trackH / 2, trackW, trackH).data;
          let ssd = 0;
          for (let i = 0; i < candidate.length; i += 16) {
            const dr = candidate[i] - templateData[i];
            const dg = candidate[i+1] - templateData[i+1];
            const db = candidate[i+2] - templateData[i+2];
            ssd += dr*dr + dg*dg + db*db;
          }
          if (ssd < bestSSD) { bestSSD = ssd; bestX = tx; bestY = ty; }
        }
      }

      lastX = bestX; lastY = bestY;
      templateData = gctx.getImageData(bestX - trackW / 2, bestY - trackH / 2, trackW, trackH).data;
      keyframes.push({ t, x: bestX / vw * c.width, y: bestY / vh * c.height });

      if (f % 5 === 0) await new Promise(r => setTimeout(r, 0));
    }

    if (keyframes.length < 2) throw new Error("Tracking produced no keyframes");

    App.commit();
    const p = targetLayer.props.position;
    p.anim = true;
    p.keys = keyframes.map(k => ({ t: snapT(k.t), v: [Math.round(k.x), Math.round(k.y)], ease: "linear" }));
    App.emit("project");
    toast(`Tracking complete: ${keyframes.length} keyframes applied`);
  }

  return { track };
})();

/* ── Warp Stabilizer (basic) ── */
const WarpStabilizer = (() => {
  async function analyze(videoLayer) {
    const asset = Assets.find(videoLayer.data.assetId);
    if (!asset || !asset.el || asset.type !== "video") throw new Error("No video asset");
    const vid = asset.el;
    const c = App.comp;
    const t0 = videoLayer.inPoint, t1 = videoLayer.outPoint;
    const frames = Math.min(Math.round((t1 - t0) * c.fps), 120);
    const cv = document.createElement("canvas");
    cv.width = 160; cv.height = 90;
    const gctx = cv.getContext("2d", { willReadFrequently: true });
    const positions = [];

    for (let f = 0; f < frames; f++) {
      const t = t0 + f / c.fps;
      vid.currentTime = clamp(mediaTime(videoLayer, t), 0, vid.duration - 0.001);
      await new Promise(res => { vid.onseeked = res; setTimeout(res, 150); });
      gctx.drawImage(vid, 0, 0, 160, 90);
      const d = gctx.getImageData(0, 0, 160, 90).data;
      let cx = 0, cy = 0, weight = 0;
      for (let py = 0; py < 90; py += 3) {
        for (let px = 0; px < 160; px += 3) {
          const i = (py * 160 + px) * 4;
          const lum = 0.2126 * d[i] + 0.7152 * d[i+1] + 0.0722 * d[i+2];
          const edge = Math.abs(lum - (py > 0 ? 0.2126*d[((py-3)*160+px)*4]+0.7152*d[((py-3)*160+px)*4+1]+0.0722*d[((py-3)*160+px)*4+2] : lum));
          cx += px * edge; cy += py * edge; weight += edge;
        }
      }
      if (weight > 0) positions.push({ t, cx: cx / weight / 160 * c.width, cy: cy / weight / 90 * c.height });
      if (f % 5 === 0) await new Promise(r => setTimeout(r, 0));
    }
    return positions;
  }

  async function stabilize(videoLayer) {
    toast("Analyzing motion…");
    try {
      const positions = await analyze(videoLayer);
      if (positions.length < 2) throw new Error("Not enough frames");
      const avgX = positions.reduce((s, p) => s + p.cx, 0) / positions.length;
      const avgY = positions.reduce((s, p) => s + p.cy, 0) / positions.length;
      App.commit();
      const p = videoLayer.props.position;
      p.anim = true;
      p.keys = positions.map(pos => ({
        t: snapT(pos.t),
        v: [Math.round(avgX * 2 - pos.cx), Math.round(avgY * 2 - pos.cy)],
        ease: "linear",
      }));
      App.emit("project");
      toast("Warp stabilizer applied — " + positions.length + " keyframes");
    } catch (e) { toast("Stabilizer failed: " + e.message); }
  }

  return { stabilize };
})();

/* ── Desktop app download (Electron ZIP) ── */
async function downloadDesktopApp() {
  toast("Building desktop app package…");
  try {
    const enc = new TextEncoder();
    // Fetch source files
    const fetchText = async url => {
      try { const r = await fetch(url); return await r.text(); } catch (e) { return ""; }
    };
    const [indexHtml, stylesCss, coreJs, rendererJs, timelineJs, viewportJs, panelsJs, premiereJs, appJs] = await Promise.all([
      fetchText("index.html"), fetchText("styles.css"),
      fetchText("js/core.js"), fetchText("js/renderer.js"),
      fetchText("js/timeline.js"), fetchText("js/viewport.js"),
      fetchText("js/panels.js"), fetchText("js/premiere.js"), fetchText("js/app.js"),
    ]);

    const mainJs = `const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

function createWindow() {
  const win = new BrowserWindow({
    width: 1600, height: 960, minWidth: 900, minHeight: 600,
    backgroundColor: '#101216',
    webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(__dirname, 'preload.js') }
  });
  win.loadFile('index.html');
  win.setTitle('Lumen — Motion Studio');
}

ipcMain.handle('dialog:openFile', async (_, opts) => {
  const result = await dialog.showOpenDialog(opts || {});
  if (result.canceled) return null;
  const filePath = result.filePaths[0];
  return { filePath, content: fs.readFileSync(filePath, 'utf8') };
});

ipcMain.handle('dialog:saveFile', async (_, { defaultPath, content }) => {
  const result = await dialog.showSaveDialog({ defaultPath });
  if (result.canceled) return null;
  fs.writeFileSync(result.filePath, content, 'utf8');
  return result.filePath;
});

ipcMain.handle('dialog:saveBuffer', async (_, { defaultPath, buffer }) => {
  const result = await dialog.showSaveDialog({ defaultPath });
  if (result.canceled) return null;
  fs.writeFileSync(result.filePath, Buffer.from(buffer));
  return result.filePath;
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
`;

    const preloadJs = `const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('electronAPI', {
  openFile: (opts) => ipcRenderer.invoke('dialog:openFile', opts),
  saveFile: (opts) => ipcRenderer.invoke('dialog:saveFile', opts),
  saveBuffer: (opts) => ipcRenderer.invoke('dialog:saveBuffer', opts),
});
`;

    const packageJson = JSON.stringify({
      name: "lumen-motion-studio",
      version: "1.0.0",
      description: "Lumen — Motion design in your browser and desktop",
      main: "electron/main.js",
      scripts: {
        start: "electron .",
        build: "electron-builder",
      },
      dependencies: {},
      devDependencies: {
        electron: "^28.0.0",
        "electron-builder": "^24.0.0",
      },
      build: {
        appId: "com.lumen.motionstudio",
        productName: "Lumen",
        directories: { output: "dist" },
        files: ["**/*", "!dist/*", "!node_modules/**/electron/dist/**"],
      },
    }, null, 2);

    const readmeTxt = `# Lumen Motion Studio — Desktop App

## Quick Start
1. Install Node.js (https://nodejs.org)
2. Run: npm install
3. Run: npm start

## Build Distributable
  npm run build

The built app will be in the dist/ folder.

## System Requirements
- Windows 10+, macOS 10.13+, or Linux
- 4GB RAM minimum
`;

    const entries = [
      { name: "index.html", data: enc.encode(indexHtml) },
      { name: "styles.css", data: enc.encode(stylesCss) },
      { name: "js/core.js", data: enc.encode(coreJs) },
      { name: "js/renderer.js", data: enc.encode(rendererJs) },
      { name: "js/timeline.js", data: enc.encode(timelineJs) },
      { name: "js/viewport.js", data: enc.encode(viewportJs) },
      { name: "js/panels.js", data: enc.encode(panelsJs) },
      { name: "js/premiere.js", data: enc.encode(premiereJs) },
      { name: "js/app.js", data: enc.encode(appJs) },
      { name: "electron/main.js", data: enc.encode(mainJs) },
      { name: "electron/preload.js", data: enc.encode(preloadJs) },
      { name: "package.json", data: enc.encode(packageJson) },
      { name: "README.md", data: enc.encode(readmeTxt) },
    ];

    const zip = Zip.build(entries);
    Exporter.download(zip, "lumen-desktop-app.zip");
    toast("Desktop app downloaded — extract and run: npm install && npm start");
  } catch (e) {
    toast("Download failed: " + e.message);
  }
}

/* ── project save / open / autosave ── */
function saveProject() {
  const blob = new Blob([serializeProject()], { type: "application/json" });
  Exporter.download(blob, App.project.name.replace(/\s+/g, "-") + ".lumen");
  App.dirty = false;
  App.emit("dirty");
  toast("Project saved");
}

function newProject(confirmFirst) {
  if (confirmFirst && App.dirty && !confirm("Discard unsaved changes?")) return;
  App.project = defaultProject();
  afterProjectLoad(App.project.name);
}

function afterProjectLoad(name) {
  App.project.name = name || App.project.name;
  App.time = 0; App.selection = null; App.selExtra = new Set(); App.expanded = new Set();
  App.dirty = false;
  History.stack = []; History.index = -1;
  document.getElementById("project-name").value = App.project.name;
  App.emit("project");
  App.emit("selection");
  App.emit("comps");
  App.emit("time", {});
  Viewport.fit();
  Timeline.fit();
}

const AUTOSAVE_KEY = "lumen.autosave";
function autosave() {
  if (!App.dirty) return;
  try { localStorage.setItem(AUTOSAVE_KEY, serializeProject()); } catch (e) { /* quota */ }
}
function tryRestoreAutosave() {
  try {
    const json = localStorage.getItem(AUTOSAVE_KEY);
    if (!json) return false;
    const s = JSON.parse(json);
    if (!confirm(`Restore autosaved project "${s.name}"?`)) {
      localStorage.removeItem(AUTOSAVE_KEY);
      return false;
    }
    loadProjectJSON(json);
    document.getElementById("project-name").value = App.project.name;
    Viewport.fit();
    Timeline.fit();
    toast("Autosave restored");
    return true;
  } catch (e) { return false; }
}

function selectAll() {
  if (!App.layers.length) return;
  App.selection = App.layers[0].id;
  App.selExtra = new Set(App.layers.slice(1).map(l => l.id));
  App.emit("selection");
}

function togglePanels() {
  document.getElementById("panel-project").classList.toggle("collapsed");
  document.getElementById("panel-props").classList.toggle("collapsed");
}

function showShortcuts() {
  document.getElementById("shortcuts-overlay").hidden = false;
}

/* ── font import ── */
async function importFont(file) {
  try {
    const url = URL.createObjectURL(file);
    const name = file.name.replace(/\.(ttf|otf|woff2?)$/i, "").replace(/[-_]/g, " ");
    const face = new FontFace(name, `url(${url})`);
    const loaded = await face.load();
    document.fonts.add(loaded);
    toast(`Font loaded: ${name}`);
    App.project._fonts = App.project._fonts || [];
    App.project._fonts.push({ name, url });
    App.emit("project");
  } catch (e) {
    toast("Font load failed: " + e.message);
  }
}

/* ── panel resizing ── */
function initResizers() {
  const left = document.getElementById("panel-project");
  const right = document.getElementById("panel-props");
  const tl = document.getElementById("timeline");
  const saved = (() => { try { return JSON.parse(localStorage.getItem("lumen.layout") || "{}"); } catch (e) { return {}; } })();
  if (saved.l) left.style.width = saved.l + "px";
  if (saved.r) right.style.width = saved.r + "px";
  if (saved.t) tl.style.height = saved.t + "px";
  const persist = () => {
    try {
      localStorage.setItem("lumen.layout", JSON.stringify({
        l: left.offsetWidth, r: right.offsetWidth, t: tl.offsetHeight,
      }));
    } catch (e) {}
  };
  document.getElementById("rs-left").addEventListener("pointerdown", e => {
    const w0 = left.offsetWidth;
    startDrag(e, {
      cursor: "col-resize",
      move(ev, dx) { left.style.width = clamp(w0 + dx, 170, 420) + "px"; Viewport.requestDraw(); },
      up: persist,
    });
  });
  document.getElementById("rs-right").addEventListener("pointerdown", e => {
    const w0 = right.offsetWidth;
    startDrag(e, {
      cursor: "col-resize",
      move(ev, dx) { right.style.width = clamp(w0 - dx, 200, 460) + "px"; Viewport.requestDraw(); },
      up: persist,
    });
  });
  document.getElementById("rs-tl").addEventListener("pointerdown", e => {
    const h0 = tl.offsetHeight;
    startDrag(e, {
      cursor: "row-resize",
      move(ev, dx, dy) { tl.style.height = clamp(h0 - dy, 130, innerHeight - 200) + "px"; Viewport.requestDraw(); },
      up: persist,
    });
  });
}

/* ── demo composition ── */
function buildDemo() {
  const c = App.comp;
  const cx = c.width / 2, cy = c.height / 2;

  const glow = makeLayer("shape", { name: "Glow" });
  glow.data = { shape: "ellipse", w: 700, h: 700, fill: "#5e6ad2", fill2: "#26b5ce", fillType: "radial", gradAngle: 0, stroke: "", strokeWidth: 0, radius: 0, points: 5, inset: 0.5 };
  glow.props.opacity.value = 38;
  glow.blend = "screen";
  const blurFx = { id: uid(), type: "blur", enabled: true, params: { amount: animProp(90) } };
  glow.effects = [blurFx];
  glow.props.position.anim = true;
  glow.props.position.loop = "pingpong";
  glow.props.position.keys = [
    { t: 0, v: [cx - 240, cy + 60], ease: "easeInOut" },
    { t: 5, v: [cx + 240, cy - 40], ease: "easeInOut" },
  ];

  const star = makeLayer("shape", { name: "Star" });
  star.data = { shape: "star", w: 110, h: 110, fill: "", fill2: "", fillType: "solid", gradAngle: 0, stroke: "#7c89f0", strokeWidth: 5, radius: 0, points: 5, inset: 0.48 };
  star.props.position.value = [c.width - 170, 140];
  star.props.position.wseed = 41;
  star.props.position.wiggle = { on: true, freq: 0.5, amp: 14 };
  star.props.opacity.value = 70;
  star.props.rotation.anim = true;
  star.props.rotation.loop = "cycle";
  star.props.rotation.keys = [
    { t: 0, v: 0, ease: "linear" },
    { t: 10, v: 360, ease: "linear" },
  ];

  const title = makeLayer("text", { name: "Title" });
  title.data.text = "Lumen";
  title.data.size = 132;
  title.data.weight = "700";
  title.props.position.value = [cx, cy - 30];
  title.props.opacity.anim = true;
  title.props.opacity.keys = [
    { t: 0, v: 0, ease: "easeOut" },
    { t: 0.8, v: 100, ease: "linear" },
  ];
  title.props.scale.anim = true;
  title.props.scale.keys = [
    { t: 0, v: [86, 86], ease: "easeOut" },
    { t: 1.1, v: [100, 100], ease: "linear" },
  ];

  const sub = makeLayer("text", { name: "Subtitle" });
  sub.data = { ...sub.data, text: "Motion design, in your browser", size: 30, weight: "400", color: "#8a8f98", reveal: "fadechar", revealStart: 0.4, revealDur: 1.4 };
  sub.props.position.value = [cx, cy + 64];

  const rule = makeLayer("solid", { name: "Rule" });
  rule.data = { ...rule.data, color: "#5e6ad2", w: 1, h: 3 };
  rule.props.position.value = [cx, cy + 118];
  rule.props.scale.anim = true;
  rule.props.scale.keys = [
    { t: 0.9, v: [0, 100], ease: "easeInOut" },
    { t: 2.0, v: [22000, 100], ease: "linear" },
  ];

  App.comp.layers = [title, sub, rule, star, glow];
  App.comp.markers = [{ id: uid(), t: 2, label: "intro done" }];
}

/* ── Auto-save (IndexedDB, 2-minute interval) ── */
const AutoSave = (() => {
  const KEY = "lumen-autosave-v1";
  const INTERVAL_MS = 120_000; // 2 minutes
  let _timer = null;
  let _indicator = null;

  function _openDB() {
    return new Promise((res, rej) => {
      const req = indexedDB.open("lumen-autosave", 1);
      req.onupgradeneeded = e => e.target.result.createObjectStore("saves", { keyPath:"id" });
      req.onsuccess = e => res(e.target.result);
      req.onerror = e => rej(e.target.error);
    });
  }

  async function save() {
    if (!App.project) return;
    try {
      const db = await _openDB();
      const data = JSON.stringify(App.project);
      const tx = db.transaction("saves", "readwrite");
      tx.objectStore("saves").put({ id: KEY, data, savedAt: Date.now(), name: App.project.name });
      await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
      _flash();
    } catch(e) { /* silent */ }
  }

  async function check() {
    try {
      const db = await _openDB();
      return await new Promise(res => {
        const req = db.transaction("saves", "readonly").objectStore("saves").get(KEY);
        req.onsuccess = e => res(e.target.result || null);
        req.onerror = () => res(null);
      });
    } catch(e) { return null; }
  }

  async function clear() {
    try {
      const db = await _openDB();
      const tx = db.transaction("saves", "readwrite");
      tx.objectStore("saves").delete(KEY);
    } catch(e) {}
  }

  function _flash() {
    if (!_indicator) {
      _indicator = document.getElementById("autosave-indicator");
    }
    if (!_indicator) return;
    _indicator.textContent = "Auto-saved";
    _indicator.classList.add("visible");
    setTimeout(() => _indicator.classList.remove("visible"), 2500);
  }

  function init() {
    _timer = setInterval(save, INTERVAL_MS);
    App.on("project", () => { /* dirty flag set, will be saved on next interval */ });
  }

  return { init, save, check, clear };
})();

/* ── Export Queue ── */
const ExportQueue = (() => {
  let _queue = []; // array of { compId, format, quality, scale, name }
  let _running = false;
  let _overlay = null;

  function open() {
    if (!_overlay) _buildOverlay();
    _overlay.hidden = false;
    _refresh();
  }
  function close() { if (_overlay) _overlay.hidden = true; }

  function _buildOverlay() {
    _overlay = document.createElement("div");
    _overlay.className = "overlay";
    _overlay.id = "queue-overlay";
    _overlay.innerHTML = `
      <div class="modal" style="width:520px">
        <div class="modal-head">
          <span>Export Queue</span>
          <button class="icon-btn sm" id="queue-close" title="Close">
            <svg viewBox="0 0 16 16"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
          </button>
        </div>
        <div class="modal-body" style="min-height:200px">
          <div id="queue-list" style="margin-bottom:12px"></div>
          <div class="form-row">
            <label>Add comp</label>
            <select id="queue-comp-sel" class="export-sel"></select>
          </div>
          <div class="form-row">
            <label>Format</label>
            <select id="queue-fmt"><option value="mp4">MP4</option><option value="webm">WebM</option><option value="pngseq">PNG seq</option></select>
          </div>
          <button class="btn ghost sm" id="queue-add-btn" style="margin-top:8px">+ Add to Queue</button>
        </div>
        <div class="modal-foot">
          <span id="queue-status" style="flex:1;font-size:12px;color:var(--text-3)"></span>
          <button class="btn ghost" id="queue-clear-btn">Clear</button>
          <button class="btn primary" id="queue-run-btn">Render All</button>
        </div>
      </div>`;
    document.body.appendChild(_overlay);
    document.getElementById("queue-close").addEventListener("click", close);
    _overlay.addEventListener("pointerdown", e => { if (e.target === _overlay) close(); });
    document.getElementById("queue-add-btn").addEventListener("click", () => {
      const compId = document.getElementById("queue-comp-sel").value;
      const fmt = document.getElementById("queue-fmt").value;
      const comp = App.project.comps.find(c => c.id === compId);
      if (!comp) return;
      _queue.push({ compId, format: fmt, scale: 1, name: comp.name });
      _refresh();
    });
    document.getElementById("queue-clear-btn").addEventListener("click", () => { _queue = []; _refresh(); });
    document.getElementById("queue-run-btn").addEventListener("click", () => _runAll());
  }

  function _refresh() {
    if (!_overlay) return;
    const sel = document.getElementById("queue-comp-sel");
    if (sel) {
      sel.innerHTML = App.project.comps.map(c => `<option value="${c.id}">${c.name}</option>`).join("");
    }
    const list = document.getElementById("queue-list"); if (!list) return;
    if (!_queue.length) { list.innerHTML = `<div class="empty-hint pad">Queue is empty. Add comps to render.</div>`; return; }
    list.innerHTML = _queue.map((item, i) =>
      `<div class="queue-item">
        <span style="flex:1">${item.name} · ${item.format.toUpperCase()}</span>
        <button class="btn ghost sm" onclick="ExportQueue._remove(${i})">✕</button>
      </div>`).join("");
  }

  function _remove(i) { _queue.splice(i, 1); _refresh(); }

  async function _runAll() {
    if (_running || !_queue.length) return;
    _running = true;
    const status = document.getElementById("queue-status");
    const runBtn = document.getElementById("queue-run-btn");
    if (runBtn) runBtn.disabled = true;
    const total = _queue.length;
    for (let i = 0; i < _queue.length; i++) {
      const item = _queue[i];
      if (status) status.textContent = `Rendering ${i+1}/${total}: ${item.name}…`;
      const comp = App.project.comps.find(c => c.id === item.compId);
      if (!comp) continue;
      try {
        const prevComp = App.project.activeCompId;
        App.project.activeCompId = item.compId;
        // Use existing export function
        if (typeof startExport === "function") {
          await new Promise(res => {
            startExport({ format: item.format, scale: item.scale, onDone: res });
          });
        }
        App.project.activeCompId = prevComp;
      } catch(e) { if (status) status.textContent = `Error: ${e.message}`; }
    }
    _queue = [];
    _running = false;
    if (runBtn) runBtn.disabled = false;
    if (status) status.textContent = `All done!`;
    _refresh();
    setTimeout(() => { if (status) status.textContent = ""; }, 3000);
  }

  return { open, close, _remove };
})();

/* ── Script Editor REPL ── */
const ScriptEditor = (() => {
  let _overlay = null;

  function open() {
    if (!_overlay) _build();
    _overlay.hidden = false;
    _overlay.querySelector("textarea").focus();
  }
  function close() { _overlay.hidden = true; }

  function _build() {
    _overlay = document.createElement("div");
    _overlay.className = "overlay";
    _overlay.id = "script-overlay";
    _overlay.innerHTML = `
      <div class="modal script-modal">
        <div class="modal-head">
          <span>Script Editor</span>
          <span style="font-size:11px;color:var(--text-3);flex:1;margin-left:12px">Run JS against the current project (Ctrl+Enter to run)</span>
          <button class="icon-btn sm" id="script-close">
            <svg viewBox="0 0 16 16"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
          </button>
        </div>
        <div class="modal-body" style="padding:0;display:flex;flex-direction:column;height:400px">
          <textarea id="script-input" spellcheck="false" style="flex:1;background:var(--bg-1);color:var(--text-1);border:none;padding:12px;font:13px/1.5 'JetBrains Mono','Fira Mono',monospace;resize:none;outline:none;border-bottom:1px solid var(--border)"
          placeholder="// Example: animate opacity on all text layers
App.layers.filter(l=&gt;l.type==='text').forEach(l=&gt;{
  Layers.toggleAnim(l,'opacity');
  Layers.upsertKey(l,'opacity',0,0);
  Layers.upsertKey(l,'opacity',1,100);
});
App.emit('project');">
          </textarea>
          <div id="script-output" style="height:100px;overflow-y:auto;background:var(--bg-1);padding:8px 12px;font:12px/1.4 'JetBrains Mono','Fira Mono',monospace;color:var(--text-2)">
            <div style="color:var(--text-3)">// Output appears here</div>
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn ghost" id="script-clear-btn">Clear</button>
          <button class="btn ghost" id="script-examples-btn">Examples</button>
          <div style="flex:1"></div>
          <button class="btn ghost" id="script-close-btn">Close</button>
          <button class="btn primary" id="script-run-btn">Run &#9654; (Ctrl+Enter)</button>
        </div>
      </div>`;
    document.body.appendChild(_overlay);

    const out = _overlay.querySelector("#script-output");
    const inp = _overlay.querySelector("#script-input");

    document.getElementById("script-close").onclick = close;
    document.getElementById("script-close-btn").onclick = close;
    document.getElementById("script-clear-btn").onclick = () => { inp.value = ""; out.innerHTML = '<div style="color:var(--text-3)">// Output appears here</div>'; };
    document.getElementById("script-run-btn").onclick = run;
    document.getElementById("script-examples-btn").onclick = () => {
      const examples = [
        ["Animate all text opacity", "App.layers.filter(l=>l.type==='text').forEach(l=>{\n  App.commit();\n  Layers.toggleAnim(l,'opacity');\n  Layers.upsertKey(l,'opacity',0,0);\n  Layers.upsertKey(l,'opacity',1,100);\n});\nApp.emit('project');"],
        ["List all layer names", "App.layers.map(l=>l.name+' ('+l.type+')').join('\\n');"],
        ["Randomize layer positions", "App.commit();\nApp.layers.forEach(l=>{\n  Layers.setProp(l,'position',[Math.random()*App.comp.width,Math.random()*App.comp.height]);\n});\nApp.emit('project');"],
        ["Set all scales to 50%", "App.commit();\nApp.layers.forEach(l=>Layers.setProp(l,'scale',[50,50]));\nApp.emit('project');"],
        ["Print comp info", "const c=App.comp;\n`${c.name}: ${c.width}x${c.height} @ ${c.fps}fps, ${c.duration}s, ${c.layers.length} layers`;"],
      ];
      const eg = examples[Math.floor(Math.random() * examples.length)];
      inp.value = eg[1];
    };

    inp.addEventListener("keydown", e => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); run(); }
      if (e.key === "Tab") { e.preventDefault(); const s=inp.selectionStart, end=inp.selectionEnd; inp.value=inp.value.slice(0,s)+"  "+inp.value.slice(end); inp.selectionStart=inp.selectionEnd=s+2; }
    });
    _overlay.addEventListener("pointerdown", e => { if (e.target === _overlay) close(); });

    function run() {
      const code = inp.value.trim(); if (!code) return;
      const logs = [];
      const fakeConsole = { log: (...a)=>logs.push(a.map(x=>typeof x==="object"?JSON.stringify(x):String(x)).join(" ")), error: (...a)=>logs.push("ERROR: "+a.join(" ")), warn: (...a)=>logs.push("WARN: "+a.join(" ")) };
      try {
        const fn = new Function(
          "App","Layers","Comps","Assets","History","animProp","evalProp","cloneVal","uid","timecode","makeLayer","makeComp","toast","console",
          '"use strict";\n' + code + "\n//# sourceURL=script.js"
        );
        const result = fn(App,Layers,Comps,Assets,History,animProp,evalProp,cloneVal,uid,timecode,makeLayer,makeComp,toast,fakeConsole);
        const lines = [...logs];
        if (result !== undefined) lines.push("→ " + (typeof result === "object" ? JSON.stringify(result, null, 2) : String(result)));
        out.innerHTML = lines.length ? lines.map(l=>`<div>${escapeHtml(l)}</div>`).join("") : '<div style="color:var(--text-3)">// (no output)</div>';
      } catch(err) {
        out.innerHTML = `<div style="color:var(--danger)">${escapeHtml(err.message)}</div>`;
      }
      out.scrollTop = out.scrollHeight;
    }
  }

  return { open, close };
})();

/* ── boot ── */
function initApp() {
  // Desktop app detection
  if (window.electronAPI?.isDesktop || window.LUMEN_DESKTOP) {
    document.body.dataset.desktop = '1';
    // Wire native file import
    const importBtns = document.querySelectorAll('[data-import-media]');
    importBtns.forEach(btn => btn.addEventListener('click', async () => {
      const paths = await window.electronAPI.openFile([
        { name: 'Media Files', extensions: ['mp4','mov','avi','mkv','mp3','wav','aac','jpg','jpeg','png','gif','webp','tiff','psd'] },
        { name: 'All Files', extensions: ['*'] }
      ]);
      if (paths && paths.length) {
        for (const p of paths) App.importFromPath?.(p);
      }
    }));
    // Wire menu events
    if (window.electronAPI.onMenu) {
      window.electronAPI.onMenu('new-project', () => App.newProject?.());
      window.electronAPI.onMenu('save', () => App.saveProject?.());
      window.electronAPI.onMenu('import-media', () => document.getElementById('asset-import-input')?.click());
      window.electronAPI.onMenu('export', () => document.getElementById('btn-export')?.click());
      window.electronAPI.onMenu('export-queue', () => document.getElementById('btn-export-queue')?.click());
    }
  }

  Settings.load();
  App.snapToGrid = Settings.get("snapGrid");
  App.project = defaultProject();
  App.project.name = "Welcome to Lumen";
  buildDemo();

  // Crash recovery check
  (async () => {
    const saved = await AutoSave.check();
    if (!saved) return;
    const minutesAgo = Math.round((Date.now() - saved.savedAt) / 60000);
    if (minutesAgo > 120) { AutoSave.clear(); return; } // ignore saves older than 2h
    const overlay = document.getElementById("crash-recovery-overlay");
    const label = document.getElementById("crash-recovery-label");
    if (overlay && label) {
      label.textContent = `Auto-saved project "${saved.name}" (${minutesAgo < 1 ? "just now" : minutesAgo + " min ago"})`;
      overlay.hidden = false;
      document.getElementById("crash-recovery-restore").addEventListener("click", async () => {
        try {
          loadProjectJSON(JSON.parse(saved.data));
          document.getElementById("project-name").value = App.project.name;
          if (typeof Viewport !== "undefined") Viewport.fit();
          if (typeof Timeline !== "undefined") Timeline.fit();
          toast("Project restored from auto-save");
        } catch(e) { toast("Restore failed: " + e.message); }
        overlay.hidden = true;
        AutoSave.clear();
      });
      document.getElementById("crash-recovery-dismiss").addEventListener("click", () => {
        overlay.hidden = true;
        AutoSave.clear();
      });
    }
  })();
  AutoSave.init();

  Panels.init();
  Timeline.init();
  Viewport.init();
  Palette.init();
  GraphEditor.init();
  CompTabs.init();
  LibraryModal.init();
  initResizers();

  /* top bar */
  const nameInput = document.getElementById("project-name");
  nameInput.value = App.project.name;
  nameInput.addEventListener("change", () => { App.project.name = nameInput.value || "Untitled Project"; App.emit("dirty"); });
  nameInput.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Enter") nameInput.blur(); });

  document.getElementById("btn-play").addEventListener("click", () => Playback.toggle());
  document.getElementById("btn-go-start").addEventListener("click", () => App.setTime(0));
  document.getElementById("btn-prev-frame").addEventListener("click", () => Playback.step(-1));
  document.getElementById("btn-next-frame").addEventListener("click", () => Playback.step(1));
  document.getElementById("btn-undo").addEventListener("click", () => History.undo());
  document.getElementById("btn-redo").addEventListener("click", () => History.redo());
  document.getElementById("btn-save").addEventListener("click", saveProject);
  document.getElementById("btn-open").addEventListener("click", () => document.getElementById("file-open").click());
  document.getElementById("btn-export").addEventListener("click", () => Exporter.open());
  document.getElementById("btn-export-queue")?.addEventListener("click", ExportQueue.open);
  document.getElementById("btn-script-editor")?.addEventListener("click", ScriptEditor.open);
  document.getElementById("btn-help").addEventListener("click", showShortcuts);
  document.getElementById("shortcuts-close").addEventListener("click", () => {
    document.getElementById("shortcuts-overlay").hidden = true;
  });

  // Settings gear
  const settingsBtn = document.getElementById("btn-settings");
  if (settingsBtn) settingsBtn.addEventListener("click", () => Settings.openModal());
  const settingsClose = document.getElementById("settings-close");
  if (settingsClose) settingsClose.addEventListener("click", () => Settings.closeModal());
  const settingsOverlay = document.getElementById("settings-overlay");
  if (settingsOverlay) {
    settingsOverlay.addEventListener("pointerdown", e => { if (e.target === settingsOverlay) Settings.closeModal(); });
  }

  // Desktop download button → open modal
  bindBtn('btn-desktop', () => {
    const m = document.getElementById('desktop-download-modal');
    if (m) m.hidden = false;
  });

  // RAM preview button
  const ramBtn = document.getElementById("btn-ram-preview");
  if (ramBtn) {
    ramBtn.addEventListener("click", () => {
      if (RamPreview.isBuilding()) { RamPreview.stop(); toast("RAM preview stopped"); }
      else RamPreview.build(null);
    });
  }

  // Escape for settings
  document.addEventListener("keydown_settings", () => {});  // placeholder, handled in main keydown
  document.getElementById("shortcuts-overlay").addEventListener("pointerdown", e => {
    if (e.target.id === "shortcuts-overlay") e.target.hidden = true;
  });

  const speedSel = document.getElementById("speed-select");
  speedSel.addEventListener("change", () => { App.speed = parseFloat(speedSel.value); });
  const loopBtn = document.getElementById("btn-loop");
  loopBtn.classList.toggle("active", App.loop);
  loopBtn.addEventListener("click", () => {
    App.loop = !App.loop;
    loopBtn.classList.toggle("active", App.loop);
  });
  const muteBtn = document.getElementById("btn-mute");
  muteBtn.addEventListener("click", () => {
    App.muted = !App.muted;
    muteBtn.classList.toggle("active", App.muted);
    AudioEngine.sync();
  });

  /* editable timecode */
  const tcInput = document.getElementById("timecode");
  tcInput.addEventListener("focus", () => tcInput.select());
  tcInput.addEventListener("keydown", e => {
    e.stopPropagation();
    if (e.key === "Enter") {
      const t = parseTimecode(tcInput.value);
      if (t !== null) App.setTime(snapT(t));
      tcInput.blur();
    }
    if (e.key === "Escape") { tcInput.value = timecode(App.time); tcInput.blur(); }
  });
  tcInput.addEventListener("blur", () => { tcInput.value = timecode(App.time); });

  document.getElementById("file-open").addEventListener("change", e => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        loadProjectJSON(reader.result);
        document.getElementById("project-name").value = App.project.name;
        Viewport.fit();
        Timeline.fit();
        toast("Project loaded");
      } catch (err) {
        toast("Could not open project: " + err.message);
      }
    };
    reader.readAsText(file);
  });

  document.getElementById("file-font").addEventListener("change", e => {
    const file = e.target.files[0];
    e.target.value = "";
    if (file) importFont(file);
  });

  /* export modal */
  document.getElementById("export-close").addEventListener("click", () => Exporter.close());
  document.getElementById("export-cancel").addEventListener("click", () => Exporter.close());
  document.getElementById("export-start").addEventListener("click", () => Exporter.start());
  document.getElementById("export-format").addEventListener("change", e => {
    const f = e.target.value;
    document.getElementById("export-quality-row").style.display = (f === "webm" || f === "mp4") ? "" : "none";
  });

  /* events → UI */
  App.on("time", () => {
    if (document.activeElement !== tcInput) tcInput.value = timecode(App.time);
  });
  App.on("playback", () => {
    document.getElementById("ic-play").style.display = App.playing ? "none" : "";
    document.getElementById("ic-pause").style.display = App.playing ? "" : "none";
  });
  App.on("dirty", () => {
    document.title = (App.dirty ? "● " : "") + App.project.name + " — Lumen";
  });
  App.on("comps", () => {
    document.title = (App.dirty ? "● " : "") + App.project.name + " — Lumen";
  });

  let _propsRafId = null;
  App.on("props", () => {
    if (_propsRafId) cancelAnimationFrame(_propsRafId);
    _propsRafId = requestAnimationFrame(() => { _propsRafId = null; Panels.refreshValues(); });
  });

  /* autosave every 25s + before unload */
  setInterval(autosave, 25000);
  window.addEventListener("beforeunload", autosave);

  /* sketch label in hud */
  setInterval(() => {
    const el = document.getElementById("sketch-label");
    if (el) el.hidden = !MotionSketch.isRecording();
  }, 200);

  /* keyboard shortcuts */
  window.addEventListener("keydown", e => {
    const tag = (e.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return;
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key;

    if (mod) {
      switch (key.toLowerCase()) {
        case "k": e.preventDefault(); Palette.isOpen() ? Palette.close() : Palette.open(); return;
        case "z": e.preventDefault(); e.shiftKey ? History.redo() : History.undo(); return;
        case "s": e.preventDefault(); saveProject(); return;
        case "o": e.preventDefault(); document.getElementById("file-open").click(); return;
        case "d": e.preventDefault(); { const s = App.selectedLayer(); if (s) { App.commit(); Layers.duplicate(s.id); } } return;
        case "c": e.preventDefault(); UIClipboard.copyLayers(); return;
        case "v": e.preventDefault(); UIClipboard.pasteLayers(); return;
        case "a": e.preventDefault(); selectAll(); return;
        case "l": e.preventDefault(); LibraryModal.open(); return;
      }
      return;
    }

    const sel = App.selectedLayer();
    switch (key) {
      case " ": e.preventDefault(); Playback.toggle(); return;
      case "ArrowLeft": e.preventDefault();
        if (e.altKey) { UICommands.nudgeTime(e.shiftKey ? -10 : -1); }
        else Playback.step(e.shiftKey ? -10 : -1);
        return;
      case "ArrowRight": e.preventDefault();
        if (e.altKey) { UICommands.nudgeTime(e.shiftKey ? 10 : 1); }
        else Playback.step(e.shiftKey ? 10 : 1);
        return;
      case "ArrowUp": e.preventDefault();
        if (e.shiftKey && mod) UICommands.nudgeScale(10);
        else UICommands.nudge(0, e.shiftKey ? -10 : -1);
        return;
      case "ArrowDown": e.preventDefault();
        if (e.shiftKey && mod) UICommands.nudgeScale(-10);
        else UICommands.nudge(0, e.shiftKey ? 10 : 1);
        return;
      case "Home": e.preventDefault(); App.setTime(0); return;
      case "End": e.preventDefault(); App.setTime(App.comp.duration); return;
      case "Delete": case "Backspace": {
        const ids = App.selectedIds();
        if (ids.length) { App.commit(); Layers.removeMany(ids); }
        return;
      }
      case "Escape":
        if (MotionSketch.isRecording()) { MotionSketch.stop(); return; }
        if (Palette.isOpen()) Palette.close();
        else if (GraphEditor.isOpen()) GraphEditor.close();
        else if (!document.getElementById("shortcuts-overlay").hidden) document.getElementById("shortcuts-overlay").hidden = true;
        else if (!document.getElementById("export-overlay").hidden) Exporter.close();
        else if (!document.getElementById("library-overlay").hidden) LibraryModal.close();
        else if (document.getElementById("settings-overlay") && !document.getElementById("settings-overlay").hidden) Settings.closeModal();
        else { App.selectedKeys = []; App.select(null); }
        return;
      case "Tab": e.preventDefault(); togglePanels(); return;
      case "F9": e.preventDefault(); UICommands.easyEaseSelected(); return;
    }

    switch (key.toLowerCase()) {
      case "m": Timeline.addMarker(); return;
      case "b": { App.commit(); const c = App.comp; c.workStart = Math.min(snapT(App.time), c.workEnd - 0.1); Timeline.drawRuler(); return; }
      case "n": { App.commit(); const c = App.comp; c.workEnd = Math.max(snapT(App.time), c.workStart + 0.1); Timeline.drawRuler(); return; }
      case "f": Viewport.fit(); return;
      case "g": Viewport.toggleGuides(); return;
      case "i": if (sel) App.setTime(sel.inPoint); return;
      case "o": if (sel) App.setTime(sel.outPoint); return;
      case "j": UICommands.jumpKey(-1); return;
      case "k": UICommands.jumpKey(1); return;
      case "[": e.shiftKey ? UICommands.nudgeTime(-Math.round((App.time - (sel ? sel.inPoint : 0)) * App.comp.fps)) : UICommands.trimToPlayhead("in"); return;
      case "]": UICommands.trimToPlayhead("out"); return;
      case "p": if (e.shiftKey) { Viewport.togglePenTool(); return; } if (sel) Timeline.revealProp(sel, "position"); return;
      case "s": if (sel) Timeline.revealProp(sel, "scale"); return;
      case "r": if (sel) Timeline.revealProp(sel, "rotation"); return;
      case "t": if (sel) Timeline.revealProp(sel, "opacity"); return;
      case "a": if (sel) Timeline.revealProp(sel, "anchor"); return;
      case "?": showShortcuts(); return;
      case "+": case "=": if (e.shiftKey) UICommands.cycleBlend(1); return;
      case "-": case "_": if (e.shiftKey) UICommands.cycleBlend(-1); return;
      case ".": if (e.shiftKey) UICommands.jumpMarker(1); return;
      case ",": if (e.shiftKey) UICommands.jumpMarker(-1); return;
    }
  });

  App.emit("project");
  App.emit("selection");
  App.emit("comps");
  App.emit("time", {});
  Viewport.fit();
  Timeline.fit();

  setTimeout(() => tryRestoreAutosave(), 300);

  if (typeof initPremiere === "function") initPremiere();

  // Close-modal handler for data-modal buttons
  document.querySelectorAll('.close-modal[data-modal]').forEach(btn => {
    btn.addEventListener('click', () => {
      const m = document.getElementById(btn.dataset.modal);
      if (m) m.hidden = true;
    });
  });

  // Desktop download modal: close on overlay click
  const ddModal = document.getElementById('desktop-download-modal');
  if (ddModal) ddModal.addEventListener('pointerdown', e => { if (e.target === ddModal) ddModal.hidden = true; });
  const fxModal = document.getElementById('fx-browser-modal');
  if (fxModal) fxModal.addEventListener('pointerdown', e => { if (e.target === fxModal) fxModal.hidden = true; });

  // Effects catalog browser
  (function initFxBrowser() {
    if (typeof EffectsCatalog === 'undefined') return;
    const modal = document.getElementById('fx-browser-modal');
    const grid = document.getElementById('fx-grid');
    const search = document.getElementById('fx-search');
    const catFilter = document.getElementById('fx-cat-filter');
    const countBar = document.getElementById('fx-count-bar');
    if (!modal || !grid) return;

    // Populate category filter
    const cats = Object.keys(EffectsCatalog.byCategory()).sort();
    cats.forEach(c => {
      const o = document.createElement('option'); o.value = c; o.textContent = c;
      catFilter.appendChild(o);
    });

    let _targetLayer = null;

    function renderGrid() {
      const q = search.value.trim();
      const cat = catFilter.value;
      let effects = q ? EffectsCatalog.search(q) : EffectsCatalog.CATALOG;
      if (cat) effects = effects.filter(e => e.cat === cat);
      const isDesktop = document.body.dataset.desktop === '1';
      grid.innerHTML = '';
      effects.forEach(eff => {
        const locked = eff.desktop && !isDesktop;
        const item = document.createElement('div');
        item.className = 'fx-item' + (locked ? ' locked' : '');
        item.title = locked ? 'Desktop app required' : eff.name;
        item.innerHTML = `
          <div class="fx-item-name">${eff.name}</div>
          <div class="fx-item-cat">${eff.cat}</div>
          ${locked ? '<div class="fx-item-lock">🔒 Desktop</div>' : ''}
        `;
        if (!locked) {
          item.addEventListener('click', () => {
            if (!_targetLayer) return;
            if (!_targetLayer.catalogFx) _targetLayer.catalogFx = [];
            const defaults = {};
            (eff.params || []).forEach(p => { defaults[p.id] = p.default ?? p.min ?? 0; });
            _targetLayer.catalogFx.push({ id: eff.id, params: defaults });
            App.emit('project');
            modal.hidden = true;
            // Refresh panel
            if (typeof buildPropsPanel === 'function') buildPropsPanel?.();
            if (typeof App !== 'undefined') App.emit('selection');
          });
        } else {
          item.addEventListener('click', () => {
            const dm = document.getElementById('desktop-download-modal');
            if (dm) { modal.hidden = true; dm.hidden = false; }
          });
        }
        grid.appendChild(item);
      });
      countBar.textContent = `${effects.length} effects${cat ? ` in ${cat}` : ''} — ${EffectsCatalog.count()} total in catalog`;
    }

    search.addEventListener('input', renderGrid);
    catFilter.addEventListener('change', renderGrid);

    // Expose opener
    window.openFxBrowser = (layer) => {
      _targetLayer = layer;
      modal.hidden = false;
      renderGrid();
    };

    renderGrid();
  })();
}

window.addEventListener("DOMContentLoaded", initApp);
