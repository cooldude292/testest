/* ─── Lumen core: state, animation model, history ─────────────────── */
"use strict";

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);

/* Cubic-bezier easing (CSS-style) */
function cubicBezier(p1x, p1y, p2x, p2y) {
  const cx = 3 * p1x, bx = 3 * (p2x - p1x) - cx, ax = 1 - cx - bx;
  const cy = 3 * p1y, by = 3 * (p2y - p1y) - cy, ay = 1 - cy - by;
  const sampleX = t => ((ax * t + bx) * t + cx) * t;
  const sampleY = t => ((ay * t + by) * t + cy) * t;
  const sampleDX = t => (3 * ax * t + 2 * bx) * t + cx;
  return function (x) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) {
      const err = sampleX(t) - x;
      if (Math.abs(err) < 1e-5) return sampleY(t);
      const d = sampleDX(t);
      if (Math.abs(d) < 1e-6) break;
      t -= err / d;
    }
    // bisection fallback
    let lo = 0, hi = 1;
    t = x;
    while (hi - lo > 1e-5) {
      if (sampleX(t) < x) lo = t; else hi = t;
      t = (lo + hi) / 2;
    }
    return sampleY(t);
  };
}

const Easing = {
  linear: t => t,
  easeIn: cubicBezier(0.5, 0.05, 0.85, 0.3),
  easeOut: cubicBezier(0.15, 0.7, 0.5, 0.95),
  easeInOut: cubicBezier(0.4, 0.0, 0.25, 1.0),
  hold: t => 0,
};
const EASE_LABELS = {
  linear: "Linear", easeIn: "Ease In", easeOut: "Ease Out",
  easeInOut: "Easy Ease", hold: "Hold",
};

function mix(a, b, t) {
  if (Array.isArray(a)) return a.map((v, i) => lerp(v, b[i], t));
  return lerp(a, b, t);
}
const cloneVal = v => Array.isArray(v) ? v.slice() : v;

/* Evaluate an animatable property at time t */
function evalProp(p, t) {
  if (!p.anim || !p.keys || p.keys.length === 0) return p.value;
  const keys = p.keys;
  if (keys.length === 1 || t <= keys[0].t) return keys[0].v;
  if (t >= keys[keys.length - 1].t) return keys[keys.length - 1].v;
  let i = 0;
  while (i < keys.length - 2 && keys[i + 1].t <= t) i++;
  const a = keys[i], b = keys[i + 1];
  if (a.ease === "hold") return a.v;
  const span = b.t - a.t;
  const u = span > 0 ? (t - a.t) / span : 1;
  const fn = Easing[a.ease] || Easing.linear;
  return mix(a.v, b.v, fn(u));
}

/* ─── Effects registry ─────────────────────────────────────────── */
const EFFECTS = {
  blur:       { label: "Gaussian Blur",  params: [{ key: "amount", label: "Blurriness", min: 0, max: 100, step: 0.5, def: 10, unit: "px" }],
                css: p => `blur(${p.amount}px)` },
  brightness: { label: "Brightness",     params: [{ key: "amount", label: "Amount", min: 0, max: 300, step: 1, def: 120, unit: "%" }],
                css: p => `brightness(${p.amount}%)` },
  contrast:   { label: "Contrast",       params: [{ key: "amount", label: "Amount", min: 0, max: 300, step: 1, def: 120, unit: "%" }],
                css: p => `contrast(${p.amount}%)` },
  saturation: { label: "Saturation",     params: [{ key: "amount", label: "Amount", min: 0, max: 300, step: 1, def: 130, unit: "%" }],
                css: p => `saturate(${p.amount}%)` },
  hue:        { label: "Hue Rotate",     params: [{ key: "deg", label: "Angle", min: 0, max: 360, step: 1, def: 90, unit: "°" }],
                css: p => `hue-rotate(${p.deg}deg)` },
  invert:     { label: "Invert",         params: [{ key: "amount", label: "Amount", min: 0, max: 100, step: 1, def: 100, unit: "%" }],
                css: p => `invert(${p.amount}%)` },
  sepia:      { label: "Sepia",          params: [{ key: "amount", label: "Amount", min: 0, max: 100, step: 1, def: 100, unit: "%" }],
                css: p => `sepia(${p.amount}%)` },
  shadow:     { label: "Drop Shadow",    params: [
                  { key: "x", label: "Offset X", min: -100, max: 100, step: 1, def: 0, unit: "px" },
                  { key: "y", label: "Offset Y", min: -100, max: 100, step: 1, def: 12, unit: "px" },
                  { key: "blur", label: "Softness", min: 0, max: 100, step: 1, def: 18, unit: "px" },
                ],
                css: p => `drop-shadow(${p.x}px ${p.y}px ${p.blur}px rgba(0,0,0,0.6))` },
};

const BLEND_MODES = [
  ["source-over", "Normal"], ["multiply", "Multiply"], ["screen", "Screen"],
  ["overlay", "Overlay"], ["darken", "Darken"], ["lighten", "Lighten"],
  ["color-dodge", "Color Dodge"], ["color-burn", "Color Burn"],
  ["hard-light", "Hard Light"], ["soft-light", "Soft Light"],
  ["difference", "Difference"], ["exclusion", "Exclusion"], ["lighter", "Add"],
  ["hue", "Hue"], ["saturation", "Saturation"], ["color", "Color"], ["luminosity", "Luminosity"],
];

const LAYER_COLORS = {
  solid: "#5e6ad2", text: "#26b5ce", shape: "#4cb782",
  image: "#d2995e", video: "#b75ed2", null: "#8a8f98",
};
const LAYER_BAR = {
  solid: ["#272b45", "#3c4474"], text: ["#16323a", "#1f5564"],
  shape: ["#19332a", "#27574a"], image: ["#3a2d1c", "#5e4a2c"],
  video: ["#33203a", "#56335e"], null: ["#26282d", "#3a3d44"],
};

/* ─── App state ────────────────────────────────────────────────── */
const App = {
  project: null,           // { name, comp:{width,height,fps,duration,bg}, layers:[], assets:[] }
  time: 0,
  playing: false,
  selection: null,         // layer id
  selectedKey: null,       // { layerId, prop, index }
  expanded: new Set(),     // layer ids with open property tracks

  _subs: {},
  on(ev, fn) { (this._subs[ev] = this._subs[ev] || []).push(fn); },
  emit(ev, data) { (this._subs[ev] || []).forEach(fn => fn(data)); },

  get comp() { return this.project.comp; },
  get layers() { return this.project.layers; },

  setTime(t, opts = {}) {
    this.time = clamp(t, 0, this.comp.duration);
    this.emit("time", opts);
  },
  setPlaying(p) {
    this.playing = p;
    this.emit("playback");
  },
  select(id) {
    if (this.selection === id) return;
    this.selection = id;
    this.selectedKey = null;
    this.emit("selection");
  },
  selectedLayer() {
    return this.layers.find(l => l.id === this.selection) || null;
  },
  /* call before any user-driven mutation */
  commit() { History.push(); },
};

const snapT = t => Math.round(t * App.comp.fps) / App.comp.fps;

function timecode(t) {
  const fps = App.comp.fps;
  const f = Math.round(t * fps);
  const ff = f % fps;
  const s = Math.floor(f / fps);
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return `0:${pad(Math.floor(s / 60))}:${pad(s % 60)}:${pad(ff)}`;
}

/* ─── History (undo / redo) ────────────────────────────────────── */
const History = {
  stack: [], index: -1, max: 100,
  snapshot() {
    return JSON.stringify({
      comp: App.project.comp,
      layers: App.project.layers,
      name: App.project.name,
    });
  },
  push() {
    this.stack = this.stack.slice(0, this.index + 1);
    this.stack.push(this.snapshot());
    if (this.stack.length > this.max) this.stack.shift();
    this.index = this.stack.length - 1;
  },
  restore(json) {
    const s = JSON.parse(json);
    App.project.comp = s.comp;
    App.project.layers = s.layers;
    App.project.name = s.name;
    if (App.selection && !App.layers.some(l => l.id === App.selection)) App.selection = null;
    App.selectedKey = null;
    App.time = clamp(App.time, 0, App.comp.duration);
    App.emit("project");
    App.emit("selection");
  },
  undo() {
    if (this.index < 0) return;
    const cur = this.snapshot();
    const prev = this.stack[this.index];
    // store current state so redo works
    if (this.index === this.stack.length - 1) { this.stack.push(cur); }
    this.index--;
    this.restore(prev);
  },
  redo() {
    if (this.index >= this.stack.length - 2) return;
    this.index++;
    this.restore(this.stack[this.index + 1]);
  },
};

/* ─── Layer model ──────────────────────────────────────────────── */
function animProp(value) {
  return { value: cloneVal(value), anim: false, keys: [] };
}

function makeLayer(type, opts = {}) {
  const c = App.comp;
  const base = {
    id: uid(),
    type,
    name: opts.name || ({ solid: "Solid", text: "Text", shape: "Shape", image: "Image", video: "Video", null: "Adjustment" }[type] || "Layer"),
    visible: true,
    locked: false,
    inPoint: 0,
    outPoint: c.duration,
    blend: "source-over",
    effects: [],
    props: {
      position: animProp([c.width / 2, c.height / 2]),
      scale: animProp([100, 100]),
      rotation: animProp(0),
      opacity: animProp(100),
      anchor: animProp([0, 0]),
    },
    data: {},
  };
  switch (type) {
    case "solid":
      base.data = { color: "#5e6ad2", w: Math.round(c.width * 0.4), h: Math.round(c.height * 0.4) };
      break;
    case "text":
      base.data = { text: opts.text || "Hello", font: "Inter, system-ui, sans-serif", size: 72, weight: "600", color: "#f7f8f8", lineHeight: 1.2, tracking: 0 };
      break;
    case "shape":
      base.data = { shape: "rect", w: 300, h: 300, fill: "#4cb782", stroke: "", strokeWidth: 0, radius: 24, points: 5, inset: 0.5 };
      break;
    case "image":
    case "video":
      base.data = { assetId: opts.assetId || null };
      break;
    case "null":
      base.data = {};
      break;
  }
  Object.assign(base.data, opts.data || {});
  return base;
}

const PROP_LABELS = { position: "Position", scale: "Scale", rotation: "Rotation", opacity: "Opacity", anchor: "Anchor" };
const PROP_ORDER = ["position", "scale", "rotation", "opacity", "anchor"];

const Layers = {
  find: id => App.layers.find(l => l.id === id) || null,

  add(layer, index = 0) {
    App.layers.splice(index, 0, layer);
    App.select(layer.id);
    App.emit("project");
    return layer;
  },

  remove(id) {
    const i = App.layers.findIndex(l => l.id === id);
    if (i < 0) return;
    App.layers.splice(i, 1);
    if (App.selection === id) App.selection = null;
    App.emit("project");
    App.emit("selection");
  },

  duplicate(id) {
    const l = this.find(id);
    if (!l) return;
    const copy = JSON.parse(JSON.stringify(l));
    copy.id = uid();
    copy.name = l.name + " copy";
    const i = App.layers.indexOf(l);
    App.layers.splice(i, 0, copy);
    App.select(copy.id);
    App.emit("project");
    return copy;
  },

  split(id, t) {
    const l = this.find(id);
    if (!l || t <= l.inPoint || t >= l.outPoint) return;
    const copy = JSON.parse(JSON.stringify(l));
    copy.id = uid();
    copy.inPoint = t;
    l.outPoint = t;
    const i = App.layers.indexOf(l);
    App.layers.splice(i, 0, copy);
    App.select(copy.id);
    App.emit("project");
  },

  move(id, toIndex) {
    const i = App.layers.findIndex(l => l.id === id);
    if (i < 0) return;
    const [l] = App.layers.splice(i, 1);
    App.layers.splice(clamp(toIndex, 0, App.layers.length), 0, l);
    App.emit("project");
  },

  /* Set a property value; auto-keyframes when animation is enabled */
  setProp(layer, name, value) {
    const p = layer.props[name];
    if (p.anim) {
      this.upsertKey(layer, name, App.time, value);
    } else {
      p.value = cloneVal(value);
    }
    App.emit("props");
  },

  toggleAnim(layer, name) {
    const p = layer.props[name];
    if (!p.anim) {
      p.anim = true;
      p.keys = [{ t: snapT(App.time), v: cloneVal(evalProp(p, App.time)), ease: "easeInOut" }];
      App.expanded.add(layer.id);
    } else {
      p.value = cloneVal(evalProp(p, App.time));
      p.anim = false;
      p.keys = [];
    }
    App.emit("project");
  },

  upsertKey(layer, name, t, value, ease) {
    const p = layer.props[name];
    t = snapT(t);
    const eps = 1 / (App.comp.fps * 4);
    let k = p.keys.find(k => Math.abs(k.t - t) < eps);
    if (k) {
      if (value !== undefined) k.v = cloneVal(value);
      if (ease) k.ease = ease;
    } else {
      k = { t, v: cloneVal(value !== undefined ? value : evalProp(p, t)), ease: ease || "easeInOut" };
      p.keys.push(k);
      p.keys.sort((a, b) => a.t - b.t);
    }
    return k;
  },

  removeKeyAt(layer, name, t) {
    const p = layer.props[name];
    const eps = 1 / (App.comp.fps * 4);
    const i = p.keys.findIndex(k => Math.abs(k.t - t) < eps);
    if (i >= 0) p.keys.splice(i, 1);
    if (p.keys.length === 0) { p.anim = false; p.value = cloneVal(evalProp(p, t)); }
  },

  hasKeyAt(layer, name, t) {
    const p = layer.props[name];
    const eps = 1 / (App.comp.fps * 4);
    return p.anim && p.keys.some(k => Math.abs(k.t - t) < eps);
  },

  addEffect(layer, type) {
    const def = EFFECTS[type];
    if (!def) return;
    const params = {};
    def.params.forEach(p => params[p.key] = p.def);
    layer.effects.push({ id: uid(), type, enabled: true, params });
    App.emit("project");
  },
};

/* ─── Assets ───────────────────────────────────────────────────── */
const Assets = {
  find: id => App.project.assets.find(a => a.id === id) || null,

  importFiles(files) {
    [...files].forEach(file => {
      const isVideo = file.type.startsWith("video/");
      const isImage = file.type.startsWith("image/");
      if (!isVideo && !isImage) return;
      const reader = new FileReader();
      reader.onload = () => {
        const asset = {
          id: uid(), name: file.name,
          type: isVideo ? "video" : "image",
          src: reader.result, el: null,
        };
        this.hydrate(asset, () => {
          App.project.assets.push(asset);
          App.emit("project");
        });
      };
      reader.readAsDataURL(file);
    });
  },

  hydrate(asset, done) {
    if (asset.type === "image") {
      const img = new Image();
      img.onload = () => { asset.el = img; done && done(); };
      img.onerror = () => { done && done(); };
      img.src = asset.src;
    } else {
      const v = document.createElement("video");
      v.muted = true; v.loop = false; v.playsInline = true; v.preload = "auto";
      v.src = asset.src;
      v.addEventListener("loadeddata", () => { asset.el = v; done && done(); }, { once: true });
      v.addEventListener("error", () => { done && done(); }, { once: true });
    }
  },

  addToComp(asset) {
    App.commit();
    const layer = makeLayer(asset.type === "video" ? "video" : "image", { name: asset.name.replace(/\.[^.]+$/, ""), assetId: asset.id });
    // fit oversized media into comp
    if (asset.el) {
      const w = asset.el.naturalWidth || asset.el.videoWidth || 0;
      const h = asset.el.naturalHeight || asset.el.videoHeight || 0;
      if (w > 0) {
        const s = Math.min(1, App.comp.width / w, App.comp.height / h) * 100;
        layer.props.scale.value = [Math.round(s), Math.round(s)];
      }
    }
    Layers.add(layer);
  },
};

/* Natural content size of a layer (before transform), centred on origin */
const _measureCtx = document.createElement("canvas").getContext("2d");
function contentSize(layer) {
  const d = layer.data;
  switch (layer.type) {
    case "solid": return [d.w, d.h];
    case "shape": return [d.w, d.h];
    case "null": return [120, 120];
    case "text": {
      _measureCtx.font = `${d.weight} ${d.size}px ${d.font}`;
      const lines = String(d.text || "").split("\n");
      let w = 0;
      lines.forEach(line => { w = Math.max(w, _measureCtx.measureText(line).width + (d.tracking || 0) * Math.max(0, line.length - 1)); });
      return [Math.max(10, w), Math.max(10, lines.length * d.size * (d.lineHeight || 1.2))];
    }
    case "image": case "video": {
      const a = Assets.find(d.assetId);
      if (a && a.el) {
        const w = a.el.naturalWidth || a.el.videoWidth, h = a.el.naturalHeight || a.el.videoHeight;
        if (w) return [w, h];
      }
      return [400, 300];
    }
  }
  return [100, 100];
}

/* ─── Project lifecycle ────────────────────────────────────────── */
function defaultProject() {
  return {
    name: "Untitled Project",
    comp: { width: 1280, height: 720, fps: 30, duration: 10, bg: "#101216" },
    layers: [],
    assets: [],
  };
}

function serializeProject() {
  const p = App.project;
  return JSON.stringify({
    app: "lumen", version: 1,
    name: p.name, comp: p.comp, layers: p.layers,
    assets: p.assets.map(a => ({ id: a.id, name: a.name, type: a.type, src: a.type === "image" ? a.src : null })),
  });
}

function loadProjectJSON(json) {
  const s = JSON.parse(json);
  if (s.app !== "lumen") throw new Error("Not a Lumen project file");
  const p = defaultProject();
  p.name = s.name || p.name;
  p.comp = Object.assign(p.comp, s.comp);
  p.layers = s.layers || [];
  p.assets = (s.assets || []).filter(a => a.src).map(a => ({ ...a, el: null }));
  App.project = p;
  App.time = 0;
  App.selection = null;
  App.expanded = new Set();
  History.stack = []; History.index = -1;
  p.assets.forEach(a => Assets.hydrate(a, () => App.emit("project")));
  App.emit("project");
  App.emit("selection");
  App.emit("time", {});
}
