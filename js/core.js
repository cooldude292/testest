/* ─── Lumen core v3: state, animation model, history ────────────── */
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
    if (x <= 0) return 0; if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) {
      const err = sampleX(t) - x; if (Math.abs(err) < 1e-5) return sampleY(t);
      const d = sampleDX(t); if (Math.abs(d) < 1e-6) break; t -= err / d;
    }
    let lo = 0, hi = 1; t = x;
    while (hi - lo > 1e-5) { if (sampleX(t) < x) lo = t; else hi = t; t = (lo + hi) / 2; }
    return sampleY(t);
  };
}
const Easing = {
  linear: t => t, easeIn: cubicBezier(0.5, 0.05, 0.85, 0.3),
  easeOut: cubicBezier(0.15, 0.7, 0.5, 0.95), easeInOut: cubicBezier(0.4, 0.0, 0.25, 1.0),
  hold: () => 0,
};
const EASE_LABELS = {
  linear: "Linear", easeIn: "Ease In", easeOut: "Ease Out", easeInOut: "Easy Ease", hold: "Hold",
};
function mix(a, b, t) { return Array.isArray(a) ? a.map((v, i) => lerp(v, b[i], t)) : lerp(a, b, t); }
const cloneVal = v => Array.isArray(v) ? v.slice() : v;

/* Deterministic smooth value-noise */
function noise1(seed, x) {
  const h = i => { const s = Math.sin(seed * 127.1 + i * 311.7) * 43758.5453; return (s - Math.floor(s)) * 2 - 1; };
  const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f);
  return lerp(h(i), h(i + 1), u);
}
function noise2(seed, x, y) {
  return noise1(seed, x + noise1(seed + 17, y) * 1.7) * 0.7 + noise1(seed + 31, y + noise1(seed + 53, x) * 1.3) * 0.3;
}

/* Color helpers */
function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d + 6) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return [h, max > 0 ? d / max : 0, max];
}
function hsvToRgb(h, s, v) {
  const i = Math.floor(h * 6), f = h * 6 - i, p = v * (1 - s), q = v * (1 - f * s), t2 = v * (1 - (1 - f) * s);
  let r, g, b;
  switch (i % 6) {
    case 0: r = v; g = t2; b = p; break; case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = t2; break; case 3: r = p; g = q; b = v; break;
    case 4: r = t2; g = p; b = v; break; default: r = v; g = p; b = q;
  }
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}
function hexToRgb(hex) {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/* Raw keyframe evaluation */
function rawEval(p, t) {
  const keys = p.keys;
  if (keys.length === 1 || t <= keys[0].t) return keys[0].v;
  if (t >= keys[keys.length - 1].t) return keys[keys.length - 1].v;
  let i = 0;
  while (i < keys.length - 2 && keys[i + 1].t <= t) i++;
  const a = keys[i], b = keys[i + 1];
  if (a.ease === "hold") return a.v;
  const span = b.t - a.t, u = span > 0 ? (t - a.t) / span : 1;
  return mix(a.v, b.v, (Easing[a.ease] || Easing.linear)(u));
}

/* Expression evaluation */
function evalExpr(p, t) {
  if (!p.exprEnabled || !p.expr) return undefined;
  try {
    const seed = p.wseed || 7;
    const wiggle = (freq, amp, octaves = 1) => {
      if (Array.isArray(p.value)) {
        return p.value.map((_, ci) => {
          let total = 0, a = amp, f = freq;
          for (let o = 0; o < octaves; o++) { total += noise1(seed + ci * 57 + o * 1000, t * f) * a; a *= 0.5; f *= 2; }
          return total;
        });
      }
      let total = 0, a = amp, f = freq;
      for (let o = 0; o < octaves; o++) { total += noise1(seed + o * 1000, t * f) * a; a *= 0.5; f *= 2; }
      return total;
    };
    const loopOut = (type = "cycle") => {
      if (!p.anim || !p.keys || p.keys.length < 2) return cloneVal(p.value);
      const a = p.keys[0].t, b = p.keys[p.keys.length - 1].t, span = b - a;
      if (t <= b || span < 1e-9) return rawEval(p, t);
      const off = t - a, ph = ((off % span) + span) % span, cycle = Math.floor(off / span);
      return rawEval(p, type === "pingpong" && (cycle % 2 !== 0) ? b - ph : a + ph);
    };
    const loopIn = (type = "cycle") => {
      if (!p.anim || !p.keys || p.keys.length < 2) return cloneVal(p.value);
      const a = p.keys[0].t, b = p.keys[p.keys.length - 1].t, span = b - a;
      if (t >= a || span < 1e-9) return rawEval(p, t);
      const off = b - t, ph = ((off % span) + span) % span, cycle = Math.floor(off / span);
      return rawEval(p, type === "pingpong" && (cycle % 2 !== 0) ? a + ph : b - ph);
    };
    const linear = (t, t1, t2, v1, v2) => lerp(v1, v2, clamp((t - t1) / (t2 - t1), 0, 1));
    const ease = (t, t1, t2, v1, v2) => lerp(v1, v2, Easing.easeInOut(clamp((t - t1) / (t2 - t1), 0, 1)));
    const fn = new Function("time", "wiggle", "loopOut", "loopIn", "clamp", "lerp", "linear", "ease", "Math",
      `"use strict"; return (${p.expr})`);
    const result = fn(t, wiggle, loopOut, loopIn, clamp, lerp, linear, ease, Math);
    if (result === undefined || result === null) return undefined;
    return result;
  } catch (e) { p._exprError = e.message; return undefined; }
}

/* Evaluate animatable property at time t */
function evalProp(p, t) {
  if (p.exprEnabled && p.expr) {
    const ev = evalExpr(p, t);
    if (ev !== undefined) { p._exprError = null; return ev; }
  }
  let v;
  if (!p.anim || !p.keys || p.keys.length === 0) {
    v = p.value;
  } else {
    let tt = t;
    if (p.loop && p.loop !== "none" && p.keys.length > 1) {
      const a = p.keys[0].t, b = p.keys[p.keys.length - 1].t, span = b - a;
      if (span > 1e-9 && (tt > b || tt < a)) {
        const off = tt - a, ph = ((off % span) + span) % span, cycle = Math.floor(off / span);
        tt = p.loop === "pingpong" && (cycle % 2 !== 0) ? b - ph : a + ph;
      }
    }
    v = rawEval(p, tt);
  }
  if (p.wiggle && p.wiggle.on && p.wiggle.amp) {
    const { freq, amp } = p.wiggle, seed = p.wseed || 7;
    v = Array.isArray(v) ? v.map((c, i) => c + noise1(seed + i * 57, t * freq) * amp) : v + noise1(seed, t * freq) * amp;
  }
  return v;
}

/* ─── 2D affine matrices ─────────────────────────────────────────── */
const matIdentity = () => [1, 0, 0, 1, 0, 0];
function matMul(m, n) {
  return [m[0]*n[0]+m[2]*n[1], m[1]*n[0]+m[3]*n[1], m[0]*n[2]+m[2]*n[3], m[1]*n[2]+m[3]*n[3],
          m[0]*n[4]+m[2]*n[5]+m[4], m[1]*n[4]+m[3]*n[5]+m[5]];
}
const matApply = (m, x, y) => [m[0]*x+m[2]*y+m[4], m[1]*x+m[3]*y+m[5]];
function matInvert(m) {
  const det = m[0]*m[3]-m[1]*m[2]; if (Math.abs(det) < 1e-12) return matIdentity();
  const id = 1/det;
  return [m[3]*id, -m[1]*id, -m[2]*id, m[0]*id, (m[2]*m[5]-m[3]*m[4])*id, (m[1]*m[4]-m[0]*m[5])*id];
}
function trsMatrix(pos, rotDeg, scale, anchor) {
  const r = (rotDeg * Math.PI) / 180, cos = Math.cos(r), sin = Math.sin(r);
  const sx = scale[0] / 100, sy = scale[1] / 100;
  return [cos*sx, sin*sx, -sin*sy, cos*sy,
          pos[0]-(cos*sx*anchor[0]-sin*sy*anchor[1]), pos[1]-(sin*sx*anchor[0]+cos*sy*anchor[1])];
}

/* ─── Effects registry ───────────────────────────────────────────── */
const EFFECTS = {
  /* ── CSS-filter effects ── */
  blur:       { label:"Gaussian Blur",   params:[{key:"amount",label:"Blurriness",min:0,max:100,step:0.5,def:10,unit:"px"}], css:p=>`blur(${p.amount}px)` },
  brightness: { label:"Brightness",      params:[{key:"amount",label:"Amount",min:0,max:300,step:1,def:120,unit:"%"}], css:p=>`brightness(${p.amount}%)` },
  contrast:   { label:"Contrast",        params:[{key:"amount",label:"Amount",min:0,max:300,step:1,def:120,unit:"%"}], css:p=>`contrast(${p.amount}%)` },
  saturation: { label:"Saturation",      params:[{key:"amount",label:"Amount",min:0,max:300,step:1,def:130,unit:"%"}], css:p=>`saturate(${p.amount}%)` },
  hue:        { label:"Hue Rotate",      params:[{key:"deg",label:"Angle",min:0,max:360,step:1,def:90,unit:"°"}], css:p=>`hue-rotate(${p.deg}deg)` },
  grayscale:  { label:"Grayscale",       params:[{key:"amount",label:"Amount",min:0,max:100,step:1,def:100,unit:"%"}], css:p=>`grayscale(${p.amount}%)` },
  invert:     { label:"Invert",          params:[{key:"amount",label:"Amount",min:0,max:100,step:1,def:100,unit:"%"}], css:p=>`invert(${p.amount}%)` },
  sepia:      { label:"Sepia",           params:[{key:"amount",label:"Amount",min:0,max:100,step:1,def:100,unit:"%"}], css:p=>`sepia(${p.amount}%)` },
  shadow:     { label:"Drop Shadow",     params:[{key:"x",label:"X",min:-100,max:100,step:1,def:0,unit:"px"},{key:"y",label:"Y",min:-100,max:100,step:1,def:12,unit:"px"},{key:"blur",label:"Softness",min:0,max:100,step:1,def:18,unit:"px"}], css:p=>`drop-shadow(${p.x}px ${p.y}px ${p.blur}px rgba(0,0,0,0.6))` },
  /* ── buffer-op effects ── */
  glow:       { label:"Glow",            params:[{key:"radius",label:"Radius",min:0,max:100,step:1,def:24,unit:"px"},{key:"intensity",label:"Intensity",min:0,max:300,step:1,def:120,unit:"%"}], op:"glow" },
  tint:       { label:"Tint",            params:[{key:"amount",label:"Amount",min:0,max:100,step:1,def:60,unit:"%"}], color:{key:"color",def:"#5e6ad2"}, op:"tint" },
  fill:       { label:"Fill",            params:[{key:"amount",label:"Opacity",min:0,max:100,step:1,def:100,unit:"%"}], color:{key:"color",def:"#ffffff"}, op:"fill" },
  vignette:   { label:"Vignette",        params:[{key:"amount",label:"Amount",min:0,max:100,step:1,def:55,unit:"%"},{key:"size",label:"Size",min:10,max:150,step:1,def:75,unit:"%"}], op:"vignette" },
  noise:      { label:"Noise",           params:[{key:"amount",label:"Amount",min:0,max:100,step:1,def:24,unit:"%"}], op:"noise" },
  pixelate:   { label:"Pixelate",        params:[{key:"size",label:"Block size",min:1,max:100,step:1,def:12,unit:"px"}], op:"pixelate" },
  chroma:     { label:"Chromatic Ab.",   params:[{key:"amount",label:"Shift",min:0,max:40,step:0.5,def:5,unit:"px"}], op:"chroma" },
  linearwipe: { label:"Linear Wipe",     params:[{key:"completion",label:"Completion",min:0,max:100,step:0.5,def:30,unit:"%"},{key:"angle",label:"Angle",min:0,max:360,step:1,def:90,unit:"°"},{key:"feather",label:"Feather",min:0,max:500,step:1,def:0,unit:"px"}], op:"linearwipe" },
  circwipe:   { label:"Circular Wipe",   params:[{key:"completion",label:"Completion",min:0,max:100,step:0.5,def:30,unit:"%"},{key:"feather",label:"Feather",min:0,max:500,step:1,def:0,unit:"px"}], op:"circwipe" },
  /* ── new v3 effects ── */
  levels:     { label:"Levels",          params:[{key:"inBlack",label:"In Black",min:0,max:253,step:1,def:0},{key:"inWhite",label:"In White",min:2,max:255,step:1,def:255},{key:"gamma",label:"Gamma",min:0.1,max:10,step:0.01,def:1},{key:"outBlack",label:"Out Black",min:0,max:255,step:1,def:0},{key:"outWhite",label:"Out White",min:0,max:255,step:1,def:255}], op:"levels" },
  curves:     { label:"Curves",          params:[{key:"shadows",label:"Shadows",min:-100,max:100,step:1,def:0},{key:"midtones",label:"Midtones",min:-100,max:100,step:1,def:0},{key:"highlights",label:"Highlights",min:-100,max:100,step:1,def:0}], op:"curves" },
  colorbalance:{ label:"Color Balance",  params:[{key:"shadowR",label:"Shadow R",min:-100,max:100,step:1,def:0},{key:"shadowG",label:"Shadow G",min:-100,max:100,step:1,def:0},{key:"shadowB",label:"Shadow B",min:-100,max:100,step:1,def:0},{key:"midR",label:"Mid R",min:-100,max:100,step:1,def:0},{key:"midG",label:"Mid G",min:-100,max:100,step:1,def:0},{key:"midB",label:"Mid B",min:-100,max:100,step:1,def:0},{key:"hiR",label:"Hi R",min:-100,max:100,step:1,def:0},{key:"hiG",label:"Hi G",min:-100,max:100,step:1,def:0},{key:"hiB",label:"Hi B",min:-100,max:100,step:1,def:0}], op:"colorbalance" },
  hslpro:     { label:"Hue/Saturation",  params:[{key:"hue",label:"Hue",min:-180,max:180,step:1,def:0,unit:"°"},{key:"sat",label:"Saturation",min:-100,max:100,step:1,def:0},{key:"light",label:"Lightness",min:-100,max:100,step:1,def:0}], op:"hslpro" },
  chromakey:  { label:"Chroma Key",      params:[{key:"tolerance",label:"Tolerance",min:0,max:100,step:1,def:30},{key:"edge",label:"Edge",min:0,max:100,step:1,def:15},{key:"spill",label:"Spill",min:0,max:100,step:1,def:50}], color:{key:"color",def:"#00ff00"}, op:"chromakey" },
  sharpen:    { label:"Sharpen",         params:[{key:"amount",label:"Amount",min:0,max:200,step:1,def:80}], op:"sharpen" },
  threshold:  { label:"Threshold",       params:[{key:"level",label:"Level",min:0,max:255,step:1,def:128}], op:"threshold" },
  posterize:  { label:"Posterize",       params:[{key:"levels",label:"Levels",min:2,max:24,step:1,def:4}], op:"posterize" },
  exposure:   { label:"Exposure",        params:[{key:"exposure",label:"Exposure (EV)",min:-10,max:10,step:0.1,def:0},{key:"gamma",label:"Gamma",min:0.1,max:5,step:0.01,def:1},{key:"pedestal",label:"Pedestal",min:-1,max:1,step:0.01,def:0}], op:"exposure" },
  fracnoise:  { label:"Fractal Noise",   params:[{key:"evolution",label:"Evolution",min:0,max:100,step:0.5,def:0},{key:"scale",label:"Scale",min:5,max:200,step:1,def:50},{key:"complexity",label:"Complexity",min:1,max:8,step:1,def:4},{key:"contrast",label:"Contrast",min:0,max:300,step:1,def:130},{key:"opacity",label:"Opacity",min:0,max:100,step:1,def:100}], op:"fracnoise" },
  turbdisplace:{ label:"Turbulent Disp.", params:[{key:"amount",label:"Amount",min:0,max:200,step:1,def:30},{key:"size",label:"Size",min:5,max:300,step:1,def:50},{key:"evolution",label:"Evolution",min:0,max:100,step:0.5,def:0}], op:"turbdisplace" },
  directblur: { label:"Directional Blur",params:[{key:"amount",label:"Amount",min:0,max:200,step:1,def:30},{key:"angle",label:"Angle",min:0,max:360,step:1,def:0,unit:"°"}], op:"directblur" },
  radialblur: { label:"Radial Blur",     params:[{key:"amount",label:"Amount",min:0,max:100,step:1,def:20},{key:"zoomSpin",label:"Zoom(0)/Spin(1)",min:0,max:1,step:1,def:0}], op:"radialblur" },
  mirror:     { label:"Mirror",          params:[{key:"angle",label:"Angle",min:0,max:360,step:1,def:0,unit:"°"},{key:"center",label:"Center %",min:0,max:100,step:0.5,def:50}], op:"mirror" },
  colorize:   { label:"Colorize",        params:[{key:"amount",label:"Amount",min:0,max:100,step:1,def:100},{key:"lightness",label:"Lightness",min:-100,max:100,step:1,def:0}], color:{key:"color",def:"#5e6ad2"}, op:"colorize" },
  echo:       { label:"Echo",            params:[{key:"echoes",label:"Echoes",min:1,max:8,step:1,def:3},{key:"decay",label:"Decay",min:0,max:100,step:1,def:50},{key:"offset",label:"Offset px",min:-100,max:100,step:1,def:3}], op:"echo" },
  ripple:     { label:"Ripple",          params:[{key:"amount",label:"Amplitude",min:0,max:100,step:1,def:20},{key:"freq",label:"Frequency",min:1,max:100,step:1,def:20},{key:"phase",label:"Phase",min:0,max:360,step:1,def:0,unit:"°"},{key:"axis",label:"H(0)/V(1)/Both(2)",min:0,max:2,step:1,def:0}], op:"ripple" },
  shake:      { label:"Shake",           params:[{key:"amount",label:"Amount",min:0,max:200,step:1,def:20},{key:"speed",label:"Speed",min:0.1,max:20,step:0.1,def:8},{key:"rotation",label:"Rotation",min:0,max:10,step:0.1,def:1}], op:"shake" },
};

const BLEND_MODES = [
  ["source-over","Normal"],["multiply","Multiply"],["screen","Screen"],["overlay","Overlay"],
  ["darken","Darken"],["lighten","Lighten"],["color-dodge","Color Dodge"],["color-burn","Color Burn"],
  ["hard-light","Hard Light"],["soft-light","Soft Light"],["difference","Difference"],
  ["exclusion","Exclusion"],["lighter","Add"],["hue","Hue"],["saturation","Saturation"],
  ["color","Color"],["luminosity","Luminosity"],
];
const MATTE_MODES = [["none","No matte"],["alpha","Alpha matte"],["alpha-inv","Alpha inverted"],["luma","Luma matte"],["luma-inv","Luma inverted"]];
const LAYER_COLORS = { solid:"#5e6ad2",text:"#26b5ce",shape:"#4cb782",image:"#d2995e",video:"#b75ed2",adjust:"#8a8f98",nullobj:"#5e636e",audio:"#cea04c",comp:"#e0639d" };
const LAYER_BAR = { solid:["#272b45","#3c4474"],text:["#16323a","#1f5564"],shape:["#19332a","#27574a"],image:["#3a2d1c","#5e4a2c"],video:["#33203a","#56335e"],adjust:["#26282d","#3a3d44"],nullobj:["#1f2023","#33363c"],audio:["#363017","#5c5226"],comp:["#3a1f2d","#5e3349"] };
const LABEL_COLORS = ["#5e6ad2","#26b5ce","#4cb782","#d2995e","#b75ed2","#eb5757","#e0639d","#cea04c"];
const TYPE_NAMES = { solid:"Solid",text:"Text",shape:"Shape",image:"Image",video:"Video",adjust:"Adjustment",nullobj:"Null",audio:"Audio",comp:"Comp" };

/* ─── App state ──────────────────────────────────────────────────── */
const App = {
  project: null, time: 0, playing: false, speed: 1, loop: true, muted: false,
  selection: null, selExtra: new Set(), selectedKeys: [],
  expanded: new Set(), shyHidden: false, dirty: false,
  _subs: {},
  on(ev, fn) { (this._subs[ev] = this._subs[ev] || []).push(fn); },
  emit(ev, data) { (this._subs[ev] || []).forEach(fn => fn(data)); },
  get comp() { const p = this.project; return p.comps.find(c => c.id === p.activeCompId) || p.comps[0]; },
  get layers() { return this.comp.layers; },
  setActiveComp(id) {
    if (!this.project.comps.some(c => c.id === id)) return;
    this.project.activeCompId = id;
    this.selection = null; this.selExtra = new Set(); this.selectedKeys = [];
    this.time = clamp(this.time, 0, this.comp.duration);
    this.emit("project"); this.emit("selection"); this.emit("comps");
  },
  setTime(t, opts = {}) { this.time = clamp(t, 0, this.comp.duration); this.emit("time", opts); },
  setPlaying(p) { this.playing = p; this.emit("playback"); },
  select(id, additive = false) {
    if (additive && id) {
      if (this.selection === id) { const r = [...this.selExtra]; this.selection = r.shift() || null; this.selExtra = new Set(r); }
      else if (this.selExtra.has(id)) this.selExtra.delete(id);
      else if (this.selection) this.selExtra.add(id);
      else this.selection = id;
    } else {
      if (this.selection === id && this.selExtra.size === 0) return;
      this.selection = id; this.selExtra = new Set();
    }
    this.selectedKeys = []; this.emit("selection");
  },
  selectedIds() { return this.selection ? [this.selection, ...this.selExtra] : [...this.selExtra]; },
  isSelected(id) { return this.selection === id || this.selExtra.has(id); },
  selectedLayer() { return this.layers.find(l => l.id === this.selection) || null; },
  selectedLayers() { const ids = this.selectedIds(); return this.layers.filter(l => ids.includes(l.id)); },
  commit() { History.push(); this.dirty = true; this.emit("dirty"); },
};

const snapT = t => Math.round(t * App.comp.fps) / App.comp.fps;

function timecode(t, comp) {
  const fps = (comp || App.comp).fps;
  const f = Math.round(t * fps), ff = f % fps, s = Math.floor(f / fps);
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return `0:${pad(Math.floor(s / 60))}:${pad(s % 60)}:${pad(ff)}`;
}
function parseTimecode(str) {
  str = String(str).trim().toLowerCase();
  let m;
  if ((m = str.match(/^f?(\d+)f?$/)) && str.includes("f")) return parseInt(m[1], 10) / App.comp.fps;
  if ((m = str.match(/^(\d+):(\d+):(\d+):(\d+)$/))) return ((+m[1]*60+ +m[2])*60+ +m[3]) + (+m[4])/App.comp.fps;
  if ((m = str.match(/^(\d+):(\d+):(\d+)$/))) return (+m[1]*60+ +m[2]) + (+m[3])/App.comp.fps;
  if ((m = str.match(/^(\d+):(\d+(?:\.\d+)?)$/))) return +m[1]*60 + +m[2];
  const v = parseFloat(str); return isNaN(v) ? null : v;
}
function mediaTime(layer, t) {
  if (layer.timeRemap && layer.timeRemap.anim && layer.timeRemap.keys.length) {
    return clamp(evalProp(layer.timeRemap, t), 0, 1000);
  }
  let local = (t - layer.inPoint) * (100 / (layer.stretch || 100));
  if (layer.reverse) { const len = (layer.outPoint - layer.inPoint) * (100 / (layer.stretch || 100)); local = len - local; }
  return Math.max(0, local);
}

/* ─── History ────────────────────────────────────────────────────── */
const History = {
  stack: [], index: -1, max: 100,
  snapshot() { return JSON.stringify({ comps: App.project.comps, activeCompId: App.project.activeCompId, name: App.project.name }); },
  push() {
    this.stack = this.stack.slice(0, this.index + 1);
    this.stack.push(this.snapshot());
    if (this.stack.length > this.max) this.stack.shift();
    this.index = this.stack.length - 1;
  },
  restore(json) {
    const s = JSON.parse(json);
    App.project.comps = s.comps; App.project.activeCompId = s.activeCompId; App.project.name = s.name;
    if (App.selection && !App.layers.some(l => l.id === App.selection)) App.selection = null;
    App.selExtra = new Set([...App.selExtra].filter(id => App.layers.some(l => l.id === id)));
    App.selectedKeys = []; App.time = clamp(App.time, 0, App.comp.duration);
    App.emit("project"); App.emit("selection"); App.emit("comps");
  },
  undo() {
    if (this.index < 0) return;
    const cur = this.snapshot(), prev = this.stack[this.index];
    if (this.index === this.stack.length - 1) this.stack.push(cur);
    this.index--; this.restore(prev);
  },
  redo() {
    if (this.index >= this.stack.length - 2) return;
    this.index++; this.restore(this.stack[this.index + 1]);
  },
};

/* ─── Comp + layer model ─────────────────────────────────────────── */
const COMP_PRESETS = [
  ["1920x1080x30","1080p · 30"],["1920x1080x60","1080p · 60"],["1280x720x30","720p · 30"],
  ["3840x2160x30","4K · 30"],["1080x1080x30","Square · 30"],["1080x1920x30","Vertical · 30"],
  ["2560x1440x60","1440p · 60"],["640x480x30","SD 480p"],["854x480x30","480p wide"],
];

function makeComp(name, w = 1280, h = 720, fps = 30, dur = 10) {
  return {
    id: uid(), name: name || "Comp", width: w, height: h, fps, duration: dur,
    bg: "#101216", bgAlpha: false, motionBlur: false,
    workStart: 0, workEnd: dur, markers: [],
    guides: [],
    layers: [],
  };
}

function animProp(value) {
  return { value: cloneVal(value), anim: false, keys: [], loop: "none", wiggle: null, wseed: 0, expr: null, exprEnabled: false };
}

function makeLayer(type, opts = {}) {
  const c = App.comp;
  const base = {
    id: uid(), type, name: opts.name || TYPE_NAMES[type] || "Layer",
    visible: true, locked: false, solo: false, shy: false,
    label: LAYER_COLORS[type] || "#5e6ad2",
    inPoint: 0, outPoint: c.duration,
    blend: "source-over", matte: "none",
    stretch: 100, reverse: false, motionBlur: false, parent: null,
    autoOrient: false, holdFrame: false,
    posterizeTime: false, posterizeTimeFPS: 12,
    notes: "", collapseTransform: false,
    timeRemap: null,
    effects: [], masks: [],
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
      base.data = { color:"#5e6ad2",color2:"#26b5ce",fillType:"solid",gradAngle:0, w:Math.round(c.width*0.4),h:Math.round(c.height*0.4) };
      break;
    case "text":
      base.data = { text:opts.text||"Hello",font:"Inter, system-ui, sans-serif",size:72,weight:"600",color:"#f7f8f8",lineHeight:1.2,tracking:0,align:"center",caps:false,strokeColor:"#000000",strokeWidth:0,reveal:"none",revealStart:0,revealDur:1 };
      break;
    case "shape":
      base.data = { shape:"rect",w:300,h:300,fill:"#4cb782",fill2:"#26b5ce",fillType:"solid",gradAngle:0,stroke:"",strokeWidth:0,radius:24,points:5,inset:0.5,
                    trimStart:0,trimEnd:100,trimOffset:0,trimEnabled:false,
                    repeatCount:1,repeatOffsetX:0,repeatOffsetY:0,repeatRotation:0,repeatScale:100,repeatOpacity:100 };
      break;
    case "image": case "video": base.data = { assetId: opts.assetId || null }; break;
    case "audio": base.data = { assetId: opts.assetId || null, volume: 100 }; break;
    case "comp": base.data = { compId: opts.compId || null }; break;
    case "adjust": case "nullobj": base.data = {}; break;
  }
  Object.assign(base.data, opts.data || {});
  return base;
}

const PROP_LABELS = { position:"Position",scale:"Scale",rotation:"Rotation",opacity:"Opacity",anchor:"Anchor" };
const PROP_ORDER = ["position","scale","rotation","opacity","anchor"];

const Layers = {
  find: id => App.layers.find(l => l.id === id) || null,
  add(layer, index = 0) { App.layers.splice(index, 0, layer); App.select(layer.id); App.emit("project"); return layer; },
  remove(id) {
    const i = App.layers.findIndex(l => l.id === id); if (i < 0) return;
    App.layers.splice(i, 1);
    App.layers.forEach(l => { if (l.parent === id) l.parent = null; });
    if (App.selection === id) App.selection = null;
    App.selExtra.delete(id); App.emit("project"); App.emit("selection");
  },
  removeMany(ids) {
    ids.forEach(id => { const i = App.layers.findIndex(l => l.id === id); if (i >= 0) App.layers.splice(i, 1); });
    App.layers.forEach(l => { if (l.parent && ids.includes(l.parent)) l.parent = null; });
    App.selection = null; App.selExtra = new Set();
    App.emit("project"); App.emit("selection");
  },
  duplicate(id) {
    const l = this.find(id); if (!l) return;
    const copy = JSON.parse(JSON.stringify(l));
    copy.id = uid(); copy.name = l.name + " copy";
    copy.effects.forEach(fx => fx.id = uid()); copy.masks.forEach(m => m.id = uid());
    const i = App.layers.indexOf(l);
    App.layers.splice(i, 0, copy); App.select(copy.id); App.emit("project"); return copy;
  },
  split(id, t) {
    const l = this.find(id); if (!l || t <= l.inPoint || t >= l.outPoint) return;
    const copy = JSON.parse(JSON.stringify(l));
    copy.id = uid(); copy.inPoint = t; l.outPoint = t;
    const i = App.layers.indexOf(l);
    App.layers.splice(i, 0, copy); App.select(copy.id); App.emit("project");
  },
  move(id, toIndex) {
    const i = App.layers.findIndex(l => l.id === id); if (i < 0) return;
    const [l] = App.layers.splice(i, 1);
    App.layers.splice(clamp(toIndex, 0, App.layers.length), 0, l); App.emit("project");
  },
  setPropObj(p, value) { if (p.anim) this.upsertKeyObj(p, App.time, value); else p.value = cloneVal(value); App.emit("props"); },
  setProp(layer, name, value) { this.setPropObj(layer.props[name], value); },
  toggleAnimObj(p, layerId) {
    if (!p.anim) { p.anim = true; p.keys = [{ t: snapT(App.time), v: cloneVal(evalProp(p, App.time)), ease: "easeInOut" }]; if (layerId) App.expanded.add(layerId); }
    else { p.value = cloneVal(rawEval(p, App.time)); p.anim = false; p.keys = []; }
    App.emit("project");
  },
  toggleAnim(layer, name) { this.toggleAnimObj(layer.props[name], layer.id); },
  upsertKeyObj(p, t, value, ease) {
    t = snapT(t);
    const eps = 1 / (App.comp.fps * 4);
    let k = p.keys.find(k => Math.abs(k.t - t) < eps);
    if (k) { if (value !== undefined) k.v = cloneVal(value); if (ease) k.ease = ease; }
    else { k = { t, v: cloneVal(value !== undefined ? value : evalProp(p, t)), ease: ease || "easeInOut" }; p.keys.push(k); p.keys.sort((a, b) => a.t - b.t); }
    return k;
  },
  upsertKey(layer, name, t, value, ease) { return this.upsertKeyObj(layer.props[name], t, value, ease); },
  removeKeyAtObj(p, t) {
    const eps = 1 / (App.comp.fps * 4), i = p.keys.findIndex(k => Math.abs(k.t - t) < eps);
    if (i >= 0) p.keys.splice(i, 1); if (p.keys.length === 0) p.anim = false;
  },
  hasKeyAtObj(p, t) { const eps = 1 / (App.comp.fps * 4); return p.anim && p.keys.some(k => Math.abs(k.t - t) < eps); },
  hasKeyAt(layer, name, t) { return this.hasKeyAtObj(layer.props[name], t); },
  addEffect(layer, type) {
    const def = EFFECTS[type]; if (!def) return;
    const params = {}; def.params.forEach(pd => params[pd.key] = animProp(pd.def));
    const fx = { id: uid(), type, enabled: true, params };
    if (def.color) fx.color = def.color.def;
    layer.effects.push(fx); App.emit("project"); return fx;
  },
  addMask(layer, shape) {
    const [w, h] = contentSize(layer);
    layer.masks.push({ id: uid(), shape: shape || "rect", mode: "add", x: 0, y: 0, w: Math.round(w * 0.8), h: Math.round(h * 0.8), feather: 0 });
    App.emit("project");
  },
  enableTimeRemap(layer) {
    if (layer.timeRemap) return;
    layer.timeRemap = animProp(layer.inPoint);
    layer.timeRemap.anim = true;
    layer.timeRemap.keys = [
      { t: layer.inPoint, v: 0, ease: "linear" },
      { t: layer.outPoint, v: layer.outPoint - layer.inPoint, ease: "linear" },
    ];
    App.emit("project");
  },
  disableTimeRemap(layer) { layer.timeRemap = null; App.emit("project"); },
  wouldCycle(layer, parentId) {
    let cur = parentId, guard = 0;
    while (cur && guard++ < 200) { if (cur === layer.id) return true; const p = this.find(cur); cur = p ? p.parent : null; }
    return false;
  },
};

function allAnimProps(layer) {
  const out = PROP_ORDER.map(name => ({ p: layer.props[name], label: PROP_LABELS[name], group: "Transform" }));
  if (layer.timeRemap) out.push({ p: layer.timeRemap, label: "Time Remap", group: "Time" });
  layer.effects.forEach(fx => {
    const def = EFFECTS[fx.type]; if (!def) return;
    def.params.forEach(pd => out.push({ p: fx.params[pd.key], label: pd.label, group: def.label, fx }));
  });
  return out;
}

/* ─── Comps ──────────────────────────────────────────────────────── */
const Comps = {
  find: id => App.project.comps.find(c => c.id === id) || null,
  create(name, w, h, fps, dur) {
    const c = makeComp(name || `Comp ${App.project.comps.length + 1}`, w, h, fps, dur);
    App.project.comps.push(c); App.emit("comps"); return c;
  },
  remove(id) {
    const p = App.project; if (p.comps.length <= 1) return false;
    const used = p.comps.some(c => c.layers.some(l => l.type === "comp" && l.data.compId === id));
    if (used) return false;
    p.comps = p.comps.filter(c => c.id !== id);
    if (p.activeCompId === id) p.activeCompId = p.comps[0].id;
    App.emit("project"); App.emit("comps"); return true;
  },
  precompose(name) {
    const sel = App.selectedLayers(); if (!sel.length) return null;
    const src = App.comp;
    const inner = makeComp(name || (sel[0].name + " Comp"), src.width, src.height, src.fps, src.duration);
    const topIdx = Math.min(...sel.map(l => App.layers.indexOf(l)));
    inner.layers = sel.map(l => JSON.parse(JSON.stringify(l)));
    src.layers = src.layers.filter(l => !sel.some(s => s.id === l.id));
    App.project.comps.push(inner);
    const compLayer = makeLayer("comp", { name: inner.name, compId: inner.id });
    src.layers.splice(clamp(topIdx, 0, src.layers.length), 0, compLayer);
    App.select(compLayer.id); App.emit("project"); App.emit("comps"); return inner;
  },
};

/* ─── Assets ─────────────────────────────────────────────────────── */
const Assets = {
  find: id => App.project.assets.find(a => a.id === id) || null,
  importFiles(files) {
    [...files].forEach(file => {
      const kind = file.type.startsWith("video/") ? "video" : file.type.startsWith("audio/") ? "audio" : file.type.startsWith("image/") ? "image" : null;
      if (!kind) { toastSafe(`Unsupported: ${file.name}`); return; }
      const reader = new FileReader();
      reader.onload = () => {
        const asset = { id: uid(), name: file.name, type: kind, src: reader.result, el: null, peaks: null };
        this.hydrate(asset, () => { App.project.assets.push(asset); App.emit("project"); });
      };
      reader.readAsDataURL(file);
    });
  },
  hydrate(asset, done) {
    if (asset.type === "image") {
      const img = new Image(); img.onload = () => { asset.el = img; done && done(); }; img.onerror = () => done && done(); img.src = asset.src;
    } else if (asset.type === "video") {
      const v = document.createElement("video"); v.muted = true; v.playsInline = true; v.preload = "auto"; v.src = asset.src;
      v.addEventListener("loadeddata", () => { asset.el = v; done && done(); }, { once: true });
      v.addEventListener("error", () => done && done(), { once: true });
    } else {
      const a = document.createElement("audio"); a.preload = "auto"; a.src = asset.src;
      a.addEventListener("loadeddata", () => { asset.el = a; AudioEngine.computePeaks(asset).finally(() => done && done()); }, { once: true });
      a.addEventListener("error", () => done && done(), { once: true });
    }
  },
  addToComp(asset) {
    App.commit();
    const type = asset.type === "video" ? "video" : asset.type === "audio" ? "audio" : "image";
    const layer = makeLayer(type, { name: asset.name.replace(/\.[^.]+$/, ""), assetId: asset.id });
    if (asset.el && type !== "audio") {
      const w = asset.el.naturalWidth || asset.el.videoWidth || 0, h = asset.el.naturalHeight || asset.el.videoHeight || 0;
      if (w > 0) { const s = Math.min(1, App.comp.width / w, App.comp.height / h) * 100; layer.props.scale.value = [Math.round(s), Math.round(s)]; }
    }
    if ((type === "audio" || type === "video") && asset.el && asset.el.duration) layer.outPoint = Math.min(App.comp.duration, asset.el.duration);
    Layers.add(layer);
  },
};

/* ─── Audio engine ───────────────────────────────────────────────── */
const AudioEngine = {
  ctx: null, masterGain: null, sources: new Map(),
  ensure() {
    if (!this.ctx) { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); this.masterGain = this.ctx.createGain(); this.masterGain.connect(this.ctx.destination); }
    return this.ctx;
  },
  route(asset) {
    this.ensure();
    if (!this.sources.has(asset.id) && asset.el) {
      const src = this.ctx.createMediaElementSource(asset.el), gain = this.ctx.createGain();
      src.connect(gain); gain.connect(this.masterGain);
      this.sources.set(asset.id, { src, gain });
    }
    return this.sources.get(asset.id);
  },
  async computePeaks(asset) {
    try {
      this.ensure();
      const resp = await fetch(asset.src), buf = await resp.arrayBuffer(), audio = await this.ctx.decodeAudioData(buf);
      const ch = audio.getChannelData(0), buckets = 1200, per = Math.max(1, Math.floor(ch.length / buckets));
      const peaks = new Float32Array(buckets);
      for (let i = 0; i < buckets; i++) {
        let max = 0, o = i * per;
        for (let j = 0; j < per; j += 16) max = Math.max(max, Math.abs(ch[o + j] || 0));
        peaks[i] = max;
      }
      asset.peaks = peaks;
    } catch (e) { /* best-effort */ }
  },
  sync() {
    const t = App.time;
    App.layers.forEach(l => {
      if (l.type !== "audio") return;
      const a = Assets.find(l.data.assetId); if (!a || !a.el) return;
      const node = this.route(a);
      if (node) node.gain.gain.value = (App.muted ? 0 : 1) * (l.data.volume ?? 100) / 100;
      const el = a.el, active = App.playing && l.visible && t >= l.inPoint && t < l.outPoint;
      if (active) {
        if (this.ctx && this.ctx.state === "suspended") this.ctx.resume();
        const want = mediaTime(l, t);
        if (Math.abs(el.currentTime - want) > 0.12) el.currentTime = clamp(want, 0, (el.duration || 1) - 0.01);
        el.playbackRate = clamp(App.speed * 100 / (l.stretch || 100), 0.25, 4);
        if (el.paused) el.play().catch(() => {});
      } else if (!el.paused) el.pause();
    });
  },
  pauseAll() { (App.project.assets || []).forEach(a => { if (a.type === "audio" && a.el && !a.el.paused) a.el.pause(); }); },
};

function toastSafe(msg) { if (typeof toast === "function") toast(msg); }

const _measureCtx = document.createElement("canvas").getContext("2d");
function contentSize(layer) {
  const d = layer.data;
  switch (layer.type) {
    case "solid": return [d.w, d.h];
    case "shape": return [d.w, d.h];
    case "adjust": return [160, 160];
    case "nullobj": return [100, 100];
    case "audio": return [0, 0];
    case "comp": { const c = Comps.find(d.compId); return c ? [c.width, c.height] : [400, 300]; }
    case "text": {
      _measureCtx.font = `${d.weight} ${d.size}px ${d.font}`;
      const txt = d.caps ? String(d.text || "").toUpperCase() : String(d.text || "");
      const lines = txt.split("\n"); let w = 0;
      lines.forEach(line => { w = Math.max(w, _measureCtx.measureText(line).width + (d.tracking || 0) * Math.max(0, line.length - 1)); });
      return [Math.max(10, w), Math.max(10, lines.length * d.size * (d.lineHeight || 1.2))];
    }
    case "image": case "video": {
      const a = Assets.find(d.assetId);
      if (a && a.el) { const w = a.el.naturalWidth || a.el.videoWidth, h = a.el.naturalHeight || a.el.videoHeight; if (w) return [w, h]; }
      return [400, 300];
    }
  }
  return [100, 100];
}

/* Effective rotation accounting for autoOrient */
function getEffectiveRotation(layer, t) {
  let rot = evalProp(layer.props.rotation, t);
  if (layer.autoOrient) {
    const dt = 0.016;
    const p0 = evalProp(layer.props.position, Math.max(0, t - dt));
    const p1 = evalProp(layer.props.position, Math.min(App.comp.duration, t + dt));
    const dx = p1[0] - p0[0], dy = p1[1] - p0[1];
    if (Math.hypot(dx, dy) > 0.01) rot += (Math.atan2(dy, dx) * 180) / Math.PI;
  }
  return rot;
}

function worldMatrix(layer, t, depth = 0) {
  const tr = {
    pos: evalProp(layer.props.position, t), scale: evalProp(layer.props.scale, t),
    rot: getEffectiveRotation(layer, t), anchor: evalProp(layer.props.anchor, t),
  };
  const local = trsMatrix(tr.pos, tr.rot, tr.scale, tr.anchor);
  if (!layer.parent || depth > 50) return local;
  const parent = Layers.find(layer.parent);
  if (!parent) return local;
  return matMul(worldMatrix(parent, t, depth + 1), local);
}
function parentMatrix(layer, t) {
  if (!layer.parent) return matIdentity();
  const parent = Layers.find(layer.parent);
  return parent ? worldMatrix(parent, t) : matIdentity();
}

/* ─── Project lifecycle ──────────────────────────────────────────── */
function defaultProject() {
  const comp = makeComp("Main", 1280, 720, 30, 10);
  return { name: "Untitled Project", comps: [comp], activeCompId: comp.id, assets: [] };
}

function serializeProject() {
  const p = App.project;
  return JSON.stringify({
    app: "lumen", version: 3,
    name: p.name, comps: p.comps, activeCompId: p.activeCompId,
    assets: p.assets.map(a => ({ id: a.id, name: a.name, type: a.type, src: a.type === "image" ? a.src : null })),
  });
}

function migrateLayer(l) {
  if (l.type === "null") l.type = "adjust";
  l.solo = l.solo ?? false; l.shy = l.shy ?? false;
  l.label = l.label || LAYER_COLORS[l.type] || "#5e6ad2";
  l.matte = l.matte || "none"; l.stretch = l.stretch ?? 100; l.reverse = l.reverse ?? false;
  l.motionBlur = l.motionBlur ?? false; l.parent = l.parent ?? null; l.masks = l.masks || [];
  l.autoOrient = l.autoOrient ?? false; l.holdFrame = l.holdFrame ?? false;
  l.posterizeTime = l.posterizeTime ?? false; l.posterizeTimeFPS = l.posterizeTimeFPS ?? 12;
  l.notes = l.notes ?? ""; l.collapseTransform = l.collapseTransform ?? false;
  l.timeRemap = l.timeRemap ?? null;
  if (l.type === "shape") {
    l.data.trimStart = l.data.trimStart ?? 0; l.data.trimEnd = l.data.trimEnd ?? 100;
    l.data.trimOffset = l.data.trimOffset ?? 0; l.data.trimEnabled = l.data.trimEnabled ?? false;
    l.data.repeatCount = l.data.repeatCount ?? 1;
  }
  Object.values(l.props).forEach(p => {
    p.loop = p.loop || "none"; p.wiggle = p.wiggle || null; p.wseed = p.wseed || 0;
    p.expr = p.expr ?? null; p.exprEnabled = p.exprEnabled ?? false;
  });
  (l.effects || []).forEach(fx => {
    const def = EFFECTS[fx.type]; if (!def) return;
    def.params.forEach(pd => {
      const cur = fx.params[pd.key];
      if (cur === undefined || typeof cur === "number") fx.params[pd.key] = animProp(cur ?? pd.def);
      else { cur.loop = cur.loop || "none"; cur.wiggle = cur.wiggle || null; cur.expr = cur.expr ?? null; cur.exprEnabled = cur.exprEnabled ?? false; }
    });
    if (def.color && fx.color === undefined) fx.color = def.color.def;
  });
  return l;
}

function loadProjectJSON(json) {
  const s = JSON.parse(json);
  if (s.app !== "lumen") throw new Error("Not a Lumen project file");
  const p = defaultProject();
  p.name = s.name || p.name;
  if (s.version >= 2 && Array.isArray(s.comps) && s.comps.length) {
    p.comps = s.comps;
    p.activeCompId = s.activeCompId && s.comps.some(c => c.id === s.activeCompId) ? s.activeCompId : s.comps[0].id;
  } else {
    const c = p.comps[0]; Object.assign(c, s.comp || {}); c.workEnd = c.workEnd ?? c.duration; c.markers = c.markers || []; c.layers = s.layers || [];
  }
  p.comps.forEach(c => {
    c.bgAlpha = c.bgAlpha ?? false; c.motionBlur = c.motionBlur ?? false;
    c.workStart = c.workStart ?? 0; c.workEnd = c.workEnd ?? c.duration;
    c.markers = c.markers || []; c.guides = c.guides || [];
    c.layers.forEach(migrateLayer);
  });
  p.assets = (s.assets || []).filter(a => a.src).map(a => ({ ...a, el: null, peaks: null }));
  App.project = p; App.time = 0; App.selection = null; App.selExtra = new Set(); App.expanded = new Set();
  App.dirty = false; History.stack = []; History.index = -1;
  p.assets.forEach(a => Assets.hydrate(a, () => App.emit("project")));
  App.emit("project"); App.emit("selection"); App.emit("comps"); App.emit("time", {});
}
