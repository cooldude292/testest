import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { LBM } from './solver.js';
import { GpuLBM } from './solver-gpu.js';
import * as G from './geometry.js';
import { SHAPES } from './shapes.js';
import { Tunnel3D, GRIDS } from './tunnel3d.js';
import { WifiSim, MATERIALS, defaultLayout } from './wifi.js';

const $ = (id) => document.getElementById(id);
const GRAV = 9.81;
const RES = [
  [320, 160],
  [480, 240],
  [640, 320],
  [960, 480],
];
const MEDIA = {
  air: { rho: 1.204, nu: 1.516e-5, max: 120, speed: 10 },
  fresh: { rho: 998.2, nu: 1.004e-6, max: 8, speed: 1 },
  sea: { rho: 1025, nu: 1.05e-6, max: 8, speed: 1 },
};

const state = {
  shape: 'turtle',
  modelName: 'Turtle',
  rawSoup: null, // imported, before up-axis fix
  rawExt: '',
  soup: null, // normalised, x-length 1
  colors: null,
  R: 0.6,
  unitVolume: 0,
  unitSurface: 0,
  length: 0.35,
  mass: 1.6,
  medium: 'air',
  rho: MEDIA.air.rho,
  nu: MEDIA.air.nu,
  speed: 10,
  speedMax: 80,
  pitch: 0,
  yaw: 0,
  roll: 0,
  flip: false,
  view: 'side',
  slice: 'silhouette',
  slicePos: 0,
  res: 1,
  spf: 16,
  cs: 0.16,
  field: 'speed',
  tracers: true,
  arrows: false,
  running: true,
  mode: '3d',
  res3: 1,
  spf3: 6,
  lines: true,
  rake: 'grid',
  density: 14,
  pulse: 1,
  pressure: false,
  slice3: 'off',
  ground: false,
  band: '2.4',
  wview: 'signal',
  tool: 'router',
  wspf: 24,
};

// Geometry-derived numbers for the current orientation.
const body = {
  scale: 1, // cells per model unit
  ox: 0,
  oy: 0,
  signB: 1,
  href: 0, // projected height of the slice, cells
  chord: 1, // body length, cells
  frontal: 0, // model units^2
  planform: 0,
  side: 0,
  sliceValue: 0,
  sliceHalf: 0.5,
};

let solver = null;
let useGpu = true;
const hist = { cd: [], cl: [], cs: [], step: [] };
const HIST_MAX = 900;
let crossings = [];
let lastClSign = 0;

// ---------------------------------------------------------------- solver --
function makeSolver() {
  const [nx, ny] = RES[state.res];
  solver = null;
  if (useGpu) {
    try {
      solver = new GpuLBM(nx, ny);
    } catch (e) {
      console.warn('GPU solver unavailable, falling back to CPU:', e);
      useGpu = false;
      toast('GPU solver unavailable, using CPU (slower)');
    }
  }
  if (!solver) solver = new LBM(nx, ny);
  solver.cs = state.cs;
  $('st-engine').textContent = `${solver.kind} solver · ${nx}×${ny}`;
  initTracers();
  dye = new Float32Array(nx * ny);
  dye2 = new Float32Array(nx * ny);
  image = new ImageData(nx, ny);
  fieldCanvas.width = nx;
  fieldCanvas.height = ny;
  texCanvas.width = nx * 2;
  texCanvas.height = ny * 2;
  // A canvas texture can't change size after upload, so make a fresh one.
  sliceTex.dispose();
  sliceTex = new THREE.CanvasTexture(texCanvas);
  sliceTex.colorSpace = THREE.SRGBColorSpace;
  sliceMat.map = sliceTex;
  sliceMat.needsUpdate = true;
  rebuildBody();
  resetStats();
}

function updatePhysics() {
  if (!solver) return;
  const u0 = state.speed > 0 ? 0.1 : 0;
  solver.u0 = u0;
  solver.cs = state.cs;
  const re = realRe();
  // Match the real Reynolds number if the lattice can take it; otherwise run
  // at the lowest stable viscosity and let the LES model do the rest.
  const nuLat = re > 0 ? (0.1 * body.chord) / re : 0.05;
  solver.setViscosity(nuLat);
  const s3 = tunnel && tunnel.solver;
  if (s3) {
    s3.u0 = u0;
    s3.cs = state.cs;
    s3.setViscosity(re > 0 ? (0.1 * tunnel.scale) / re : 0.05);
  }
}

// The solver behind the current flow mode.
function active() {
  return state.mode === '3d' && tunnel && tunnel.solver ? tunnel.solver : solver;
}
function chordCells() {
  return state.mode === '3d' && tunnel && tunnel.solver ? tunnel.scale : body.chord;
}

function realRe() {
  return (state.speed * state.length) / state.nu;
}

function simRe() {
  return (0.1 * chordCells()) / active().nu;
}

// ------------------------------------------------------------------ body --
function setModel(soup, name, colors = null) {
  state.soup = G.normalise(soup);
  state.colors = colors;
  state.modelName = name;
  let R = 0;
  for (let i = 0; i < state.soup.length; i += 3) {
    const r = Math.hypot(state.soup[i], state.soup[i + 1], state.soup[i + 2]);
    if (r > R) R = r;
  }
  state.R = R;
  state.unitVolume = G.volume(state.soup);
  state.ub = G.bounds(state.soup);
  state.uFrontal = G.projectedArea(state.soup, 0);
  state.unitSurface = G.surfaceArea(state.soup);
  buildMesh();
  rebuildBody();
  resetStats();
}

function loadShape(key) {
  const s = SHAPES[key];
  const geo = s.build();
  const mesh = new THREE.Mesh(geo);
  const soup = G.soupFromObject(mesh, THREE);
  const col = geo.attributes.color;
  let colors = null;
  if (col) {
    const g2 = geo.index ? geo.toNonIndexed() : geo;
    colors = new Float32Array(g2.attributes.color.array);
  }
  state.shape = key;
  state.length = s.length;
  state.mass = s.mass;
  $('in-length').value = s.length;
  $('in-mass').value = s.mass;
  state.rawSoup = null;
  state.ground = !!s.ground;
  $('in-ground').checked = state.ground;
  if (tunnel) tunnel.ground = state.ground;
  if (s.medium && s.medium !== state.medium) setMedium(s.medium);
  if (s.speed) {
    state.speed = Math.min(s.speed, state.speedMax);
    syncSpeed();
  }
  setModel(soup, s.label, colors);
  frameCamera();
  updateLegend();
}

function orientImported() {
  let soup = state.rawSoup;
  const up = $('in-up').value;
  const zUp = up === 'z' || (up === 'auto' && (state.rawExt === 'stl' || state.rawExt === 'ply'));
  if (zUp) soup = G.transform(soup, [1, 0, 0, 0, 0, 1, 0, -1, 0]); // Z-up -> Y-up
  const b = G.bounds(soup);
  if (b.size[2] > b.size[0] * 1.15) soup = G.transform(soup, [0, 0, 1, 0, 1, 0, -1, 0, 0]); // long axis -> X
  return soup;
}

let rebuildQueued = false;
function queueRebuild() {
  if (rebuildQueued) return;
  rebuildQueued = true;
  requestAnimationFrame(() => {
    rebuildQueued = false;
    rebuildBody();
  });
}

function rotation() {
  return G.rotationMatrix(state.roll, state.yaw + (state.flip ? 180 : 0), state.pitch);
}

function rebuildBody() {
  if (!solver || !state.soup) return;
  const { nx, ny } = solver;
  const M = rotation();
  const rot = G.transform(state.soup, M);
  state.rot = rot;
  state.M = M;
  body.frontal = G.projectedArea(rot, 0);
  body.planform = G.projectedArea(rot, 1);
  body.side = G.projectedArea(rot, 2);
  if (tunnel && tunnel.solver) {
    tunnel.ground = state.ground;
    tunnel.sliceMode = state.slice3;
    tunnel.setBody(rot, G.bounds(rot), state.ub, state.uFrontal);
  }

  const side = state.view === 'side';
  const ia = 0;
  const ib = side ? 1 : 2;
  const ic = side ? 2 : 1;
  body.signB = side ? 1 : -1;
  const b = G.bounds(rot);

  // Keep the body to ~13% of the tunnel height so blockage doesn't pump up drag.
  // (sized from the unrotated body so turning it doesn't rescale it)
  body.scale = Math.min(nx * 0.16, (ny * 0.13) / Math.max(0.05, state.ub.size[ib]));
  body.chord = body.scale;
  body.ox = nx * 0.3;
  body.oy = ny / 2 + 0.37; // off-centre by a hair so symmetric bodies still start shedding

  body.sliceHalf = Math.max(Math.abs(b.min[ic]), Math.abs(b.max[ic]));
  body.sliceValue = state.slicePos * body.sliceHalf * 0.98;

  const mask =
    state.slice === 'section'
      ? G.rasterSection(rot, ia, ib, ic, body.sliceValue, nx, ny, body.ox, body.oy, body.scale, body.signB)
      : G.rasterSilhouette(rot, ia, ib, nx, ny, body.ox, body.oy, body.scale, body.signB);
  // Keep the far-field rows and inlet/outlet columns clear.
  for (let x = 0; x < nx; x++) {
    mask[x] = mask[nx + x] = mask[(ny - 1) * nx + x] = mask[(ny - 2) * nx + x] = 0;
  }
  for (let y = 0; y < ny; y++) mask[y * nx] = mask[y * nx + 1] = mask[y * nx + nx - 1] = mask[y * nx + nx - 2] = 0;

  solver.setSolid(mask);
  const ext = G.maskExtent(mask, nx, ny);
  body.href = ext.h;

  updatePhysics();
  update3D(M);
  $('cl-key').innerHTML = side ? 'C<sub>l</sub> (lift)' : 'C<sub>s</sub> (side force)';
  $('out-slicepos').textContent =
    state.slice === 'section' ? `${(body.sliceValue * state.length * 100).toFixed(1)} cm` : 'n/a';
}

// ------------------------------------------------------------- rendering --
const flowCanvas = $('flow');
const fctx = flowCanvas.getContext('2d');
const fieldCanvas = document.createElement('canvas');
const fieldCtx = fieldCanvas.getContext('2d');
const texCanvas = document.createElement('canvas');
const texCtx = texCanvas.getContext('2d');
let image = null;
let dye = null;
let dye2 = null;

function lut(stops) {
  const out = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let j = 0;
    while (j < stops.length - 2 && t > stops[j + 1][0]) j++;
    const [t0, c0] = stops[j];
    const [t1, c1] = stops[j + 1];
    const u = Math.min(1, Math.max(0, (t - t0) / (t1 - t0 || 1)));
    for (let c = 0; c < 3; c++) out[i * 3 + c] = c0[c] + (c1[c] - c0[c]) * u;
  }
  return out;
}
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const LUT = {
  speed: lut([
    [0, hex('#0b1026')],
    [0.2, hex('#1d3a8a')],
    [0.4, hex('#1f8fb0')],
    [0.6, hex('#36c3a4')],
    [0.75, hex('#c9e05a')],
    [0.88, hex('#f2a33a')],
    [1, hex('#e8453c')],
  ]),
  diverge: lut([
    [0, hex('#3b6fe0')],
    [0.3, hex('#1c2c55')],
    [0.5, hex('#0e121a')],
    [0.7, hex('#5c2020')],
    [1, hex('#f0643c')],
  ]),
  pressure: lut([
    [0, hex('#2d5bd6')],
    [0.4, hex('#7fb2f0')],
    [0.6667, hex('#f1f1ef')],
    [0.85, hex('#f29a4a')],
    [1, hex('#d93a2b')],
  ]),
};
const SOLID = [74, 84, 102];

function renderField() {
  const { nx, ny, ux, uy, rho, solid } = solver;
  const d = image.data;
  const u0 = 0.1;
  const mode = state.field;
  const rhoRef = refDensity();
  for (let y = 0; y < ny; y++) {
    const row = (ny - 1 - y) * nx;
    for (let x = 0; x < nx; x++) {
      const k = y * nx + x;
      const p = (row + x) * 4;
      if (solid[k]) {
        d[p] = SOLID[0];
        d[p + 1] = SOLID[1];
        d[p + 2] = SOLID[2];
        d[p + 3] = 255;
        continue;
      }
      let li, L;
      if (mode === 'speed') {
        const s = Math.hypot(ux[k], uy[k]) / u0;
        li = Math.min(255, (s / 1.6) * 255) | 0;
        L = LUT.speed;
      } else if (mode === 'pressure') {
        const cp = (rho[k] - rhoRef) / 3 / (0.5 * u0 * u0);
        li = Math.min(255, Math.max(0, ((cp + 2) / 3) * 255)) | 0;
        L = LUT.pressure;
      } else if (mode === 'vorticity') {
        const w = vort(k, x, y);
        li = (127.5 + 127.5 * Math.tanh((w / u0) * 6)) | 0;
        L = LUT.diverge;
      } else {
        const s = Math.hypot(ux[k], uy[k]) / u0;
        const dv = Math.min(1, dye[k]);
        d[p] = 12 + dv * 230 + s * 10;
        d[p + 1] = 16 + dv * 225 + s * 20;
        d[p + 2] = 26 + dv * 215 + s * 40;
        d[p + 3] = 255;
        continue;
      }
      d[p] = L[li * 3];
      d[p + 1] = L[li * 3 + 1];
      d[p + 2] = L[li * 3 + 2];
      d[p + 3] = 255;
    }
  }
  fieldCtx.putImageData(image, 0, 0);
}

// Free-stream density just past the inlet, the zero for pressure.
function refDensity() {
  const { nx, ny, rho } = solver;
  let s = 0;
  for (let y = 1; y < ny - 1; y++) s += rho[y * nx + 3];
  return s / (ny - 2);
}

function vort(k, x, y) {
  const { nx, ny, ux, uy } = solver;
  if (x < 1 || y < 1 || x >= nx - 1 || y >= ny - 1) return 0;
  return (uy[k + 1] - uy[k - 1] - ux[k + nx] + ux[k - nx]) / 2;
}

function advectDye(steps) {
  const { nx, ny, ux, uy, solid } = solver;
  const src = dye;
  const out = dye2;
  for (let y = 1; y < ny - 1; y++) {
    for (let x = 2; x < nx - 1; x++) {
      const k = y * nx + x;
      if (solid[k]) {
        out[k] = 0;
        continue;
      }
      let px = x - ux[k] * steps;
      let py = y - uy[k] * steps;
      if (px < 0) px = 0;
      if (py < 0) py = 0;
      if (px > nx - 1.001) px = nx - 1.001;
      if (py > ny - 1.001) py = ny - 1.001;
      const x0 = px | 0, y0 = py | 0, tx = px - x0, ty = py - y0;
      const j = y0 * nx + x0;
      out[k] =
        0.999 *
        (src[j] * (1 - tx) * (1 - ty) + src[j + 1] * tx * (1 - ty) + src[j + nx] * (1 - tx) * ty + src[j + nx + 1] * tx * ty);
    }
  }
  const period = Math.max(8, Math.round(ny / 14));
  const width = Math.max(2, Math.round(period / 4));
  for (let y = 0; y < ny; y++) {
    const on = y % period < width ? 1 : 0;
    out[y * nx] = out[y * nx + 1] = on;
  }
  dye = out;
  dye2 = src;
}

// Tracer particles
let tracers = null;
function initTracers() {
  const [nx, ny] = RES[state.res];
  const count = Math.round((nx * ny) / 40);
  tracers = { x: new Float32Array(count), y: new Float32Array(count), px: new Float32Array(count), py: new Float32Array(count), age: new Float32Array(count) };
  for (let i = 0; i < count; i++) respawn(i, true, nx, ny);
}
function respawn(i, anywhere, nx, ny) {
  tracers.x[i] = anywhere ? Math.random() * nx : Math.random() * 3;
  tracers.y[i] = 1 + Math.random() * (ny - 2);
  tracers.px[i] = tracers.x[i];
  tracers.py[i] = tracers.y[i];
  tracers.age[i] = Math.random() * 200;
}
function moveTracers(steps) {
  const { nx, ny, solid } = solver;
  const t = tracers;
  for (let i = 0; i < t.x.length; i++) {
    const [u, v] = solver.sample(t.x[i], t.y[i]);
    t.px[i] = t.x[i];
    t.py[i] = t.y[i];
    t.x[i] += u * steps;
    t.y[i] += v * steps;
    t.age[i] += 1;
    const gx = t.x[i] | 0, gy = t.y[i] | 0;
    if (t.x[i] >= nx - 2 || t.y[i] < 1 || t.y[i] >= ny - 1 || solid[gy * nx + gx] || t.age[i] > 1200) {
      respawn(i, false, nx, ny);
      t.age[i] = 0;
    }
  }
}

function view() {
  const dpr = window.devicePixelRatio || 1;
  const cw = flowCanvas.clientWidth * dpr;
  const ch = flowCanvas.clientHeight * dpr;
  if (flowCanvas.width !== cw || flowCanvas.height !== ch) {
    flowCanvas.width = cw;
    flowCanvas.height = ch;
  }
  const s = Math.min(cw / solver.nx, ch / solver.ny);
  return { s, ox: (cw - solver.nx * s) / 2, oy: (ch - solver.ny * s) / 2, dpr };
}

function drawFlow() {
  const v = view();
  const { nx, ny } = solver;
  fctx.fillStyle = '#0b0e14';
  fctx.fillRect(0, 0, flowCanvas.width, flowCanvas.height);
  fctx.imageSmoothingEnabled = true;
  fctx.imageSmoothingQuality = 'high';
  fctx.drawImage(fieldCanvas, v.ox, v.oy, nx * v.s, ny * v.s);

  if (state.tracers) drawTracers(fctx, v.ox, v.oy, v.s, ny, v.dpr);
  if (state.arrows) drawArrows(fctx, v);
}

function drawTracers(ctx, ox, oy, s, ny, dpr) {
  const t = tracers;
  ctx.strokeStyle = state.field === 'smoke' ? 'rgba(120,200,255,0.55)' : 'rgba(255,255,255,0.6)';
  ctx.lineWidth = Math.max(1, 1.1 * dpr);
  ctx.beginPath();
  for (let i = 0; i < t.x.length; i++) {
    if (t.age[i] < 2) continue;
    const x1 = ox + t.x[i] * s, y1 = oy + (ny - t.y[i]) * s;
    let x0 = ox + t.px[i] * s, y0 = oy + (ny - t.py[i]) * s;
    // stretch streaks a bit so motion reads at a glance
    x0 = x1 + (x0 - x1) * 2.5;
    y0 = y1 + (y0 - y1) * 2.5;
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1 + 0.01, y1);
  }
  ctx.stroke();
}

function drawArrows(ctx, v) {
  const { nx, ny, solid } = solver;
  const stepC = Math.max(8, Math.round(nx / 40));
  ctx.strokeStyle = 'rgba(255,255,255,0.75)';
  ctx.lineWidth = v.dpr;
  ctx.beginPath();
  for (let y = stepC / 2; y < ny; y += stepC) {
    for (let x = stepC / 2; x < nx; x += stepC) {
      const k = (y | 0) * nx + (x | 0);
      if (solid[k]) continue;
      const [u, w] = solver.sample(x, y);
      const len = (stepC * 0.9 * Math.hypot(u, w)) / 0.1;
      const a = Math.atan2(-w, u);
      const sx = v.ox + x * v.s, sy = v.oy + (ny - y) * v.s;
      const L = (len * v.s) / 1;
      const ex = sx + Math.cos(a) * L, ey = sy + Math.sin(a) * L;
      ctx.moveTo(sx, sy);
      ctx.lineTo(ex, ey);
      const h = Math.min(6 * v.dpr, L * 0.35);
      ctx.moveTo(ex, ey);
      ctx.lineTo(ex - Math.cos(a - 0.45) * h, ey - Math.sin(a - 0.45) * h);
      ctx.moveTo(ex, ey);
      ctx.lineTo(ex - Math.cos(a + 0.45) * h, ey - Math.sin(a + 0.45) * h);
    }
  }
  ctx.stroke();
}

function drawTexture() {
  const { ny } = solver;
  texCtx.imageSmoothingEnabled = true;
  texCtx.drawImage(fieldCanvas, 0, 0, texCanvas.width, texCanvas.height);
  if (state.tracers) drawTracers(texCtx, 0, 0, 2, ny, 1);
  sliceTex.needsUpdate = true;
}

function updateLegend() {
  const q = 0.5 * state.rho * state.speed * state.speed;
  let html = '';
  const bar = (L) => {
    const stops = [];
    for (let i = 0; i <= 8; i++) {
      const j = Math.round((i / 8) * 255) * 3;
      stops.push(`rgb(${L[j]},${L[j + 1]},${L[j + 2]}) ${(i / 8) * 100}%`);
    }
    return `<div class="bar" style="background:linear-gradient(90deg,${stops.join(',')})"></div>`;
  };
  if (state.field === 'speed') {
    html = `Flow speed${bar(LUT.speed)}<div class="ends"><span>0</span><span>${fmtNum(state.speed * 0.8)}</span><span>${fmtNum(state.speed * 1.6)} m/s</span></div>`;
  } else if (state.field === 'pressure') {
    html = `Pressure (vs. free stream)${bar(LUT.pressure)}<div class="ends"><span>${fmtNum(-2 * q)}</span><span>0</span><span>+${fmtNum(q)} Pa</span></div>`;
  } else if (state.field === 'vorticity') {
    html = `Vorticity (spin)${bar(LUT.diverge)}<div class="ends"><span>clockwise</span><span>counter-clockwise</span></div>`;
  } else {
    html = 'Smoke streaks injected at the inlet';
  }
  $('legend').innerHTML = html;
  updateLegend3();
}

// -------------------------------------------------------------------- 3D --
const v3 = $('view3d');
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
renderer.setPixelRatio(window.devicePixelRatio || 1);
renderer.setClearColor(0x0f131b);
v3.appendChild(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 100);
camera.position.set(-1.1, 1.1, 2.6);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.target.set(0.35, 0, 0);
scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x20242c, 1.4));
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.position.set(-2, 3, 2);
scene.add(sun);
const grid = new THREE.GridHelper(4, 20, 0x2a3345, 0x1a2130);
grid.position.y = -0.6;
scene.add(grid);

const modelMat = new THREE.MeshStandardMaterial({ color: 0xc8d2e0, roughness: 0.55, metalness: 0.05, vertexColors: false });
let modelMesh = null;
let sliceTex = new THREE.CanvasTexture(texCanvas);
sliceTex.colorSpace = THREE.SRGBColorSpace;
const sliceMat = new THREE.MeshBasicMaterial({ map: sliceTex, transparent: true, opacity: 0.88, side: THREE.DoubleSide, depthWrite: false });
const slicePlane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), sliceMat);
scene.add(slicePlane);
const windArrows = new THREE.Group();
scene.add(windArrows);
for (let i = 0; i < 5; i++) {
  const a = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1.5, -0.3 + i * 0.15, 0.7), 0.35, 0x36c3a4, 0.08, 0.05);
  windArrows.add(a);
}

function buildMesh() {
  if (modelMesh) {
    scene.remove(modelMesh);
    modelMesh.geometry.dispose();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(state.soup, 3));
  if (state.colors && state.colors.length === state.soup.length) {
    geo.setAttribute('color', new THREE.BufferAttribute(state.colors, 3));
    modelMat.vertexColors = true;
    modelMat.color.set(0xffffff);
  } else {
    modelMat.vertexColors = false;
    modelMat.color.set(0xc8d2e0);
  }
  modelMat.needsUpdate = true;
  geo.computeVertexNormals();
  modelMesh = new THREE.Mesh(geo, modelMat);
  scene.add(modelMesh);
}

function update3D(M) {
  if (!modelMesh) return;
  const m4 = new THREE.Matrix4().set(M[0], M[1], M[2], 0, M[3], M[4], M[5], 0, M[6], M[7], M[8], 0, 0, 0, 0, 1);
  modelMesh.matrixAutoUpdate = false;
  modelMesh.matrix.copy(m4);
  modelMesh.matrixWorldNeedsUpdate = true;

  // Show only the part of the slice around the body; the full tunnel is huge.
  const { nx, ny } = solver;
  const sc = body.scale;
  const gx0 = Math.max(0, body.ox - 1.3 * sc), gx1 = Math.min(nx, body.ox + 2.7 * sc);
  const gy0 = Math.max(0, body.oy - 1.0 * sc), gy1 = Math.min(ny, body.oy + 1.0 * sc);
  sliceTex.repeat.set((gx1 - gx0) / nx, (gy1 - gy0) / ny);
  sliceTex.offset.set(gx0 / nx, gy0 / ny);
  const cx = ((gx0 + gx1) / 2 - body.ox) / sc;
  const cb = ((gy0 + gy1) / 2 - body.oy) / sc;
  slicePlane.scale.set((gx1 - gx0) / sc, (gy1 - gy0) / sc, 1);
  const depth = state.slice === 'section' ? body.sliceValue : 0;
  if (state.view === 'side') {
    slicePlane.rotation.set(0, 0, 0);
    slicePlane.position.set(cx, cb, depth);
  } else {
    slicePlane.rotation.set(-Math.PI / 2, 0, 0);
    slicePlane.position.set(cx, depth, -cb);
  }
  const bb = new THREE.Box3().setFromObject(modelMesh);
  grid.position.y = state.mode === '3d' && state.ground && tunnel.solver ? tunnel.floorY : bb.min.y - 0.05;
  slicePlane.visible = state.mode === '2d';
  if (tunnel) tunnel.setVisible(state.mode === '3d');
  tunnel.lines.visible = state.mode === '3d' && state.lines;
  windArrows.visible = state.mode === '2d';
}

function frameCamera() {
  if (!state.rot) return;
  const b = G.bounds(state.rot);
  const c = new THREE.Vector3((b.min[0] + b.max[0]) / 2 + 0.15, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2);
  const r = Math.max(0.7, state.R) * 2.4;
  controls.target.copy(c);
  camera.position.set(c.x - 0.75 * r, c.y + 0.5 * r, c.z + 1.05 * r);
  camera.updateProjectionMatrix();
}

function resize3D() {
  const w = v3.clientWidth, h = v3.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  renderer.domElement.style.width = w + 'px';
  renderer.domElement.style.height = h + 'px';
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize3D).observe(v3);

// ----------------------------------------------------------------- stats --
function resetStats() {
  hist.cd.length = 0;
  hist.cl.length = 0;
  hist.cs.length = 0;
  hist.step.length = 0;
  crossings = [];
  lastClSign = 0;
}

function coeffs() {
  const u0 = 0.1;
  const q = 0.5 * u0 * u0;
  if (state.mode === '3d') {
    const F = tunnel.solver.force;
    const s2 = tunnel.scale * tunnel.scale;
    return {
      cd: F[0] / (q * body.frontal * s2),
      cl: F[1] / (q * body.planform * s2),
      cs: F[2] / (q * body.side * s2),
    };
  }
  const cd = body.href > 0 ? solver.fx / (q * body.href) : 0;
  const cl = solver.fy / (q * body.chord);
  return { cd, cl, cs: 0 };
}

function recordStats() {
  const sv = active();
  if (sv.steps < sv.rampSteps * 2 || state.speed <= 0) return;
  const { cd, cl, cs } = coeffs();
  if (!Number.isFinite(cd) || !Number.isFinite(cl)) return;
  hist.cd.push(cd);
  hist.cl.push(cl);
  hist.cs.push(cs);
  hist.step.push(sv.steps);
  if (hist.cd.length > HIST_MAX) {
    hist.cd.shift();
    hist.cl.shift();
    hist.cs.shift();
    hist.step.shift();
  }
  // Vortex shedding: count low->high swings of the lift signal, with
  // hysteresis so solver jitter doesn't register as a period.
  const n = Math.min(hist.cl.length, 120);
  if (n > 20) {
    let mean = 0, sq = 0;
    for (let i = hist.cl.length - n; i < hist.cl.length; i++) {
      mean += hist.cl[i];
      sq += hist.cl[i] * hist.cl[i];
    }
    mean /= n;
    const h = 0.5 * Math.sqrt(Math.max(0, sq / n - mean * mean));
    const smooth = (hist.cl[hist.cl.length - 1] + hist.cl[hist.cl.length - 2]) / 2;
    if (smooth > mean + h) {
      if (lastClSign < 0) {
        crossings.push(sv.steps);
        if (crossings.length > 8) crossings.shift();
      }
      lastClSign = 1;
    } else if (smooth < mean - h) {
      lastClSign = -1;
    }
  }
}

function averaged(arr, n = 240) {
  const m = Math.min(arr.length, n);
  if (!m) return { mean: NaN, amp: 0 };
  let s = 0, lo = Infinity, hi = -Infinity;
  for (let i = arr.length - m; i < arr.length; i++) {
    s += arr[i];
    lo = Math.min(lo, arr[i]);
    hi = Math.max(hi, arr[i]);
  }
  return { mean: s / m, amp: (hi - lo) / 2 };
}

function results() {
  const U = state.speed;
  const L = state.length;
  const rho = state.rho;
  const q = 0.5 * rho * U * U;
  const is3 = state.mode === '3d';
  const cd = averaged(hist.cd);
  const cl = averaged(hist.cl);
  const cs = averaged(hist.cs);
  const A = body.frontal * L * L;
  const Aplan = (is3 || state.view === 'side' ? body.planform : body.side) * L * L;
  const drag = Number.isFinite(cd.mean) ? cd.mean * q * A : NaN;
  const lift = Number.isFinite(cl.mean) ? cl.mean * q * Aplan : NaN;
  const side = is3 && Number.isFinite(cs.mean) ? cs.mean * q * body.side * L * L : NaN;
  const dx = L / chordCells();
  const dt = U > 0 ? (dx * 0.1) / U : 0;
  // Reference length for the Strouhal number: height across the flow, cells.
  const href = is3 && state.rot ? (G.bounds(state.rot).size[1] || 0) * tunnel.scale : body.href;

  let st = NaN, freq = NaN;
  if (crossings.length >= 4 && cl.amp > 0.02) {
    const period = (crossings[crossings.length - 1] - crossings[0]) / (crossings.length - 1);
    if (period > 20) {
      const fLat = 1 / period;
      st = (fLat * href) / 0.1;
      freq = fLat / dt;
    }
  }

  const V = state.unitVolume * L * L * L;
  const Fb = rho * V * GRAV;
  const Wt = state.mass * GRAV;
  const bodyDensity = V > 0 ? state.mass / V : NaN;
  return { U, L, rho, q, cd, cl, cs, A, Aplan, drag, lift, side, st, freq, V, Fb, Wt, bodyDensity, dt };
}

// ------------------------------------------------------------ formatting --
function fmtNum(v, digits = 3) {
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a === 0) return '0';
  if (a >= 1e5 || a < 1e-3) return v.toExponential(2);
  return Number(v.toPrecision(digits)).toLocaleString('en-US', { maximumFractionDigits: 6 });
}
function fmtSI(v, unit) {
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  const pre = [
    [1e6, 'M'],
    [1e3, 'k'],
    [1, ''],
    [1e-3, 'm'],
    [1e-6, 'µ'],
  ];
  if (a === 0) return `0 ${unit}`;
  for (const [f, p] of pre) if (a >= f) return `${fmtNum(v / f)} ${p}${unit}`;
  return `${v.toExponential(2)} ${unit}`;
}
function fmtArea(v) {
  if (!Number.isFinite(v)) return '—';
  return v >= 0.1 ? `${fmtNum(v)} m²` : `${fmtNum(v * 1e4)} cm²`;
}
function fmtVol(v) {
  if (!Number.isFinite(v)) return '—';
  return v >= 0.1 ? `${fmtNum(v)} m³` : `${fmtNum(v * 1000)} L`;
}
function rows(list) {
  return list
    .map(([k, v, cls = '', sub = '']) => `<div class="k">${k}</div><div class="v ${cls}">${v}</div>${sub ? `<div class="sub">${sub}</div>` : ''}`)
    .join('');
}

function updatePanels() {
  const r = results();
  const is3 = state.mode === '3d';
  const side = is3 || state.view === 'side';
  const liftName = side ? 'Lift' : 'Side force';
  const lf = r.lift;
  if (is3) {
    $('m-forces').innerHTML = rows([
      ['Drag coefficient C<sub>d</sub>', fmtNum(r.cd.mean), 'big'],
      ['Lift coefficient C<sub>l</sub>', fmtNum(r.cl.mean), 'big'],
      ['Drag force', fmtSI(r.drag, 'N')],
      [lf < 0 ? 'Downforce' : 'Lift', fmtSI(Math.abs(lf), 'N'), '', lf < 0 ? 'pushing the body down' : 'pushing the body up'],
      ['Side force', fmtSI(r.side, 'N'), '', 'C<sub>s</sub> ' + fmtNum(r.cs.mean)],
      ['Lift / drag', fmtNum(r.lift / r.drag)],
      ['Power to push through', fmtSI(r.drag * r.U, 'W'), '', `${fmtNum((r.drag * r.U) / 745.7)} hp`],
      ['Unsteadiness (C<sub>l</sub> swing)', `± ${fmtNum(r.cl.amp)}`],
    ]);
  } else $('m-forces').innerHTML = rows([
    ['Drag coefficient C<sub>d</sub>', fmtNum(r.cd.mean), 'big'],
    [`${liftName} coeff. C<sub>${side ? 'l' : 's'}</sub>`, fmtNum(r.cl.mean), 'big'],
    ['Drag force', fmtSI(r.drag, 'N')],
    [`${liftName}`, fmtSI(r.lift, 'N'), '', side ? 'positive = up' : 'positive = toward top of slice'],
    [side ? 'Lift / drag' : 'Side force / drag', fmtNum(r.lift / r.drag)],
    ['Power to hold position', fmtSI(r.drag * r.U, 'W')],
    [`Unsteadiness (C<sub>${side ? 'l' : 's'}</sub> swing)`, `± ${fmtNum(r.cl.amp)}`],
  ]);
  const re = realRe();
  const sre = simRe();
  $('m-flow').innerHTML = rows([
    ['Reynolds number', fmtNum(re), '', re > 5e5 ? 'turbulent boundary layer likely' : re > 2e3 ? 'transitional / turbulent wake' : 'laminar-ish'],
    [is3 ? 'Simulated Re (lattice)' : 'Simulated Re (slice)', fmtNum(sre), sre < re * 0.5 ? 'warn' : '', sre < re * 0.5 ? 'lattice caps Re; LES models the rest' : ''],
    ['Dynamic pressure', fmtSI(r.q, 'Pa')],
    ['Vortex shedding', Number.isFinite(r.freq) ? `${fmtNum(r.freq)} Hz` : '—'],
    ['Strouhal number', fmtNum(r.st)],
    ['Sim time', `${fmtNum(active().steps * r.dt)} s`],
  ]);

  const med = state.medium === 'air' ? 'air' : state.medium === 'custom' ? 'this fluid' : state.medium === 'sea' ? 'sea water' : 'fresh water';
  const vd = $('verdict');
  const ratio = r.bodyDensity / r.rho;
  if (!Number.isFinite(ratio)) {
    vd.className = 'verdict';
    vd.textContent = 'Volume unknown (mesh not closed?)';
  } else if (ratio < 0.98) {
    vd.className = 'verdict floats';
    vd.textContent = `Floats in ${med} · ${fmtNum(Math.min(100, ratio * 100), 3)}% submerged`;
  } else if (ratio > 1.02) {
    vd.className = 'verdict sinks';
    vd.textContent = `Sinks in ${med}`;
  } else {
    vd.className = 'verdict neutral';
    vd.textContent = `About neutrally buoyant in ${med}`;
  }
  const net = r.Fb - r.Wt;
  // Terminal speed rising / sinking, belly-first, using a flat-body Cd of ~1.
  const vt = Math.sqrt((2 * Math.abs(net)) / (r.rho * 1.0 * (body.planform * r.L * r.L || 1)));
  $('m-buoy').innerHTML = rows([
    ['Buoyant force', fmtSI(r.Fb, 'N')],
    ['Weight', fmtSI(r.Wt, 'N')],
    ['Net (up +)', fmtSI(net, 'N')],
    ['Body density', `${fmtNum(r.bodyDensity)} kg/m³`],
    ['Mass for neutral buoyancy', `${fmtNum(r.rho * r.V)} kg`],
    [net < 0 ? 'Sinking speed (est.)' : 'Rising speed (est.)', `${fmtNum(vt)} m/s`, '', 'belly-first, C<sub>d</sub> ≈ 1'],
    ['In fresh water', verdictShort(r.bodyDensity / MEDIA.fresh.rho)],
    ['In sea water', verdictShort(r.bodyDensity / MEDIA.sea.rho)],
  ]);
  $('m-body').innerHTML = rows([
    ['Model', state.modelName],
    ['Length', `${fmtNum(r.L)} m`],
    ['Frontal area', fmtArea(r.A)],
    ['Planform (top) area', fmtArea(body.planform * r.L * r.L)],
    ['Wetted surface', fmtArea(state.unitSurface * r.L * r.L)],
    ['Volume', fmtVol(r.V)],
    ...(is3 ? [['Body length on grid', `${Math.round(tunnel.scale)} cells`]] : [['Slice height', `${body.href} cells`]]),
  ]);
  $('st-steps').textContent = `${active().steps.toLocaleString()} steps`;
}

function verdictShort(ratio) {
  if (!Number.isFinite(ratio)) return '—';
  if (ratio < 0.98) return `floats (${fmtNum(ratio * 100, 3)}% under)`;
  if (ratio > 1.02) return 'sinks';
  return 'neutral';
}

// ----------------------------------------------------------------- chart --
const chart = $('chart');
const cctx = chart.getContext('2d');
function drawChart() {
  const dpr = window.devicePixelRatio || 1;
  const w = chart.clientWidth * dpr, h = chart.clientHeight * dpr;
  if (chart.width !== w || chart.height !== h) {
    chart.width = w;
    chart.height = h;
  }
  cctx.clearRect(0, 0, w, h);
  const pad = { l: 44 * dpr, r: 10 * dpr, t: 10 * dpr, b: 22 * dpr };
  const n = hist.cd.length;
  cctx.font = `${11 * dpr}px -apple-system, system-ui, sans-serif`;
  cctx.fillStyle = '#8592a6';
  if (n < 2) {
    cctx.fillText(state.speed > 0 ? 'Waiting for the flow to develop…' : 'Flow speed is zero', pad.l, h / 2);
    return;
  }
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < n; i++) {
    lo = Math.min(lo, hist.cd[i], hist.cl[i]);
    hi = Math.max(hi, hist.cd[i], hist.cl[i]);
  }
  lo = Math.min(lo, 0);
  const span = hi - lo || 1;
  lo -= span * 0.08;
  hi += span * 0.08;
  const X = (i) => pad.l + (i / (HIST_MAX - 1)) * (w - pad.l - pad.r);
  const Y = (v) => pad.t + (1 - (v - lo) / (hi - lo)) * (h - pad.t - pad.b);

  cctx.strokeStyle = '#222a37';
  cctx.lineWidth = dpr;
  const ticks = 5;
  for (let i = 0; i <= ticks; i++) {
    const v = lo + ((hi - lo) * i) / ticks;
    const y = Y(v);
    cctx.beginPath();
    cctx.moveTo(pad.l, y);
    cctx.lineTo(w - pad.r, y);
    cctx.stroke();
    cctx.fillText(v.toFixed(2), 6 * dpr, y + 4 * dpr);
  }
  cctx.strokeStyle = '#3a4456';
  cctx.beginPath();
  cctx.moveTo(pad.l, Y(0));
  cctx.lineTo(w - pad.r, Y(0));
  cctx.stroke();

  const line = (arr, color) => {
    cctx.strokeStyle = color;
    cctx.lineWidth = 1.6 * dpr;
    cctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = X(i), y = Y(arr[i]);
      i ? cctx.lineTo(x, y) : cctx.moveTo(x, y);
    }
    cctx.stroke();
  };
  line(hist.cl, '#f2a33a');
  line(hist.cd, '#36c3a4');
  const dtReal = results().dt;
  const secs = (hist.step[n - 1] - hist.step[0]) * dtReal;
  cctx.fillStyle = '#8592a6';
  cctx.fillText(`last ${fmtNum(secs)} s of flow`, pad.l, h - 6 * dpr);
}

// ------------------------------------------------------------------ loop --
let frames = 0;
let fpsT = performance.now();
let frameNo = 0;
let lastT = performance.now();
function frame() {
  requestAnimationFrame(frame);
  frameNo++;
  const now = performance.now();
  const dtSec = Math.min(0.1, (now - lastT) / 1000);
  lastT = now;

  if (state.mode === 'wifi') wifiFrame();
  else if (state.mode === '3d') frame3D(dtSec);
  else frame2D();

  frames++;
  if (now - fpsT > 1000) {
    $('st-fps').textContent = `${Math.round((frames * 1000) / (now - fpsT))} fps`;
    frames = 0;
    fpsT = now;
  }
}

function frame2D() {
  if (state.running && solver) {
    solver.run(state.spf);
    if (!solver.isFinite()) {
      solver.reset();
      bumpTurbulence();
    }
    recordStats();
    if (state.field === 'smoke') advectDye(state.spf);
    if (state.tracers) moveTracers(state.spf);
  }
  if (solver) {
    renderField();
    drawFlow();
    if (frameNo % 2 === 0) drawTexture();
    if (frameNo % 6 === 0) {
      updatePanels();
      drawChart();
    }
  }
  controls.update();
  renderer.render(scene, camera);
}

function bumpTurbulence() {
  state.cs = Math.min(0.3, state.cs + 0.04);
  $('in-cs').value = state.cs;
  $('out-cs').textContent = state.cs.toFixed(2);
  updatePhysics();
  toast('Flow blew up. Restarted with a stronger turbulence model.');
}

function frame3D(dtSec) {
  const s3 = tunnel.solver;
  if (s3) {
    if (state.running) {
      s3.run(state.spf3);
      if (!s3.force.every(Number.isFinite)) {
        s3.reset();
        bumpTurbulence();
      }
      recordStats();
    }
    // Spread the CPU-side work over frames: field readback + streamlines,
    // then slice + surface pressure.
    const phase = frameNo % 6;
    if (phase === 0 && (state.running || !fieldPrimed)) {
      s3.readField();
      fieldPrimed = true;
      if (state.lines) tunnel.updateStreamlines({ density: state.density, rake: state.rake });
    } else if (phase === 3 && fieldPrimed) {
      tunnel.updateSlice();
      if (state.pressure) paintPressure();
    }
    tunnel.lineMat.uniforms.time.value += state.pulse * dtSec * 0.8;
    if (frameNo % 6 === 0) {
      updatePanels();
      drawChart();
    }
  }
  controls.update();
  renderer.render(scene, camera);
}

let pressureBuf = null;
let fieldPrimed = false;
function paintPressure() {
  if (!modelMesh) return;
  const geo = modelMesh.geometry;
  const pos = geo.attributes.position.array;
  if (!pressureBuf || pressureBuf.length !== pos.length) pressureBuf = new Float32Array(pos.length);
  tunnel.pressureColors(pos, geo.attributes.normal.array, state.M, pressureBuf);
  let attr = geo.attributes.color;
  if (!attr || attr.array !== pressureBuf) {
    geo.setAttribute('color', new THREE.BufferAttribute(pressureBuf, 3));
    attr = geo.attributes.color;
  }
  attr.needsUpdate = true;
  if (!modelMat.vertexColors) {
    modelMat.vertexColors = true;
    modelMat.color.set(0xffffff);
    modelMat.needsUpdate = true;
  }
}

function restoreColors() {
  if (!modelMesh) return;
  const geo = modelMesh.geometry;
  if (state.colors && state.colors.length === state.soup.length) {
    geo.setAttribute('color', new THREE.BufferAttribute(state.colors, 3));
    modelMat.vertexColors = true;
    modelMat.color.set(0xffffff);
  } else {
    geo.deleteAttribute('color');
    modelMat.vertexColors = false;
    modelMat.color.set(0xc8d2e0);
  }
  modelMat.needsUpdate = true;
}

// ------------------------------------------------------------------ wifi --
let wifi = null;
const wgl = $('wifi-gl');
const wui = $('wifi-ui');
const wctx = wui.getContext('2d');
let wDrag = null;
let wHover = null;
const undoStack = [];

function makeWifi() {
  try {
    wifi = new WifiSim(wgl);
    wifi.band = state.band;
    wifi.build();
  } catch (e) {
    console.error(e);
    toast(`WiFi sim needs WebGL2 float support: ${e.message}`);
    wifi = null;
  }
}

function wifiView() {
  const dpr = window.devicePixelRatio || 1;
  const cw = Math.round(wgl.clientWidth * dpr), ch = Math.round(wgl.clientHeight * dpr);
  for (const c of [wgl, wui]) {
    if (c.width !== cw || c.height !== ch) {
      c.width = cw;
      c.height = ch;
    }
  }
  const s = Math.min(cw / wifi.nx, ch / wifi.ny);
  return { s, ox: (cw - wifi.nx * s) / 2, oy: (ch - wifi.ny * s) / 2, dpr };
}

function wToScreen(v, x, y) {
  const [cx, cy] = wifi.toCell(x, y);
  return [v.ox + cx * v.s, v.oy + cy * v.s];
}
function wFromEvent(e) {
  const v = wifiView();
  const cx = (e.offsetX * v.dpr - v.ox) / v.s, cy = (e.offsetY * v.dpr - v.oy) / v.s;
  return wifi.fromCell(cx, cy);
}

function wifiFrame() {
  if (!wifi) return;
  if (state.running) wifi.run(state.wspf);
  const v = wifiView();
  wifi.render(v);
  drawWifiUI(v);
  if (frameNo % 20 === 0) {
    wifi.updateStats();
    updateWifiPanels();
  }
}

function drawWifiUI(v) {
  const c = wctx;
  c.clearRect(0, 0, wui.width, wui.height);
  const d = v.dpr;
  // Scale bar
  const [x0, y0] = wToScreen(v, 0, wifi.size[1] + 0.35);
  const [x1] = wToScreen(v, 1, 0);
  c.strokeStyle = '#dfe6f1';
  c.fillStyle = '#dfe6f1';
  c.lineWidth = 2 * d;
  c.beginPath();
  c.moveTo(x0, y0);
  c.lineTo(x1, y0);
  c.stroke();
  c.font = `${11 * d}px -apple-system, system-ui, sans-serif`;
  c.fillText('1 m', x1 + 6 * d, y0 + 4 * d);
  // Wall being drawn
  if (wDrag && wDrag.kind === 'wall' && wDrag.to) {
    const [ax, ay] = wToScreen(v, wDrag.from[0], wDrag.from[1]);
    const [bx, by] = wToScreen(v, wDrag.to[0], wDrag.to[1]);
    const m = MATERIALS[+$('in-mat').value];
    c.strokeStyle = `rgb(${m.color.join(',')})`;
    c.lineWidth = Math.max(3 * d, m.t * wifi.cellsPerM * v.s);
    c.setLineDash([6 * d, 4 * d]);
    c.beginPath();
    c.moveTo(ax, ay);
    c.lineTo(bx, by);
    c.stroke();
    c.setLineDash([]);
    const len = Math.hypot(wDrag.to[0] - wDrag.from[0], wDrag.to[1] - wDrag.from[1]);
    c.fillStyle = '#fff';
    c.fillText(`${len.toFixed(2)} m`, bx + 8 * d, by - 8 * d);
  }
  // Routers
  wifi.routers.forEach((r, i) => {
    const [x, y] = wToScreen(v, r.x, r.y);
    const t = (performance.now() / 1000) % 1.6;
    c.strokeStyle = `rgba(54,195,164,${0.8 - t / 2})`;
    c.lineWidth = 2 * d;
    c.beginPath();
    c.arc(x, y, (8 + t * 18) * d, 0, Math.PI * 2);
    c.stroke();
    c.fillStyle = '#0b0e14';
    c.strokeStyle = '#36c3a4';
    c.beginPath();
    c.arc(x, y, 9 * d, 0, Math.PI * 2);
    c.fill();
    c.stroke();
    c.fillStyle = '#36c3a4';
    c.textAlign = 'center';
    c.fillText(`${i + 1}`, x, y + 4 * d);
    c.textAlign = 'left';
  });
  // Eraser target
  if (state.tool === 'erase' && wHover) {
    const w = nearestWall(wHover[0], wHover[1]);
    if (w) {
      const [ax, ay] = wToScreen(v, w.x1, w.y1);
      const [bx, by] = wToScreen(v, w.x2, w.y2);
      c.strokeStyle = '#ef5f5f';
      c.lineWidth = 4 * d;
      c.beginPath();
      c.moveTo(ax, ay);
      c.lineTo(bx, by);
      c.stroke();
    }
  }
}

function nearestWall(x, y, maxD = 0.35) {
  let best = null, bd = maxD;
  for (const w of wifi.walls) {
    const dx = w.x2 - w.x1, dy = w.y2 - w.y1;
    const L2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((x - w.x1) * dx + (y - w.y1) * dy) / L2));
    const d = Math.hypot(w.x1 + t * dx - x, w.y1 + t * dy - y);
    if (d < bd) {
      bd = d;
      best = w;
    }
  }
  return best;
}

function pushUndo() {
  undoStack.push(JSON.stringify({ walls: wifi.walls, routers: wifi.routers }));
  if (undoStack.length > 50) undoStack.shift();
}

function signalWord(dbm) {
  if (dbm >= -50) return 'excellent';
  if (dbm >= -60) return 'very good';
  if (dbm >= -67) return 'good: video calls, 4K';
  if (dbm >= -75) return 'fair: browsing ok';
  if (dbm >= -85) return 'weak: drops likely';
  return 'no usable signal';
}

function updateWifiPanels() {
  const st = wifi.stats;
  const pct = (v) => (st ? `${(v * 100).toFixed(0)}%` : '—');
  $('m-wifi').innerHTML = rows([
    ['Good or better (≥ -67 dBm)', pct(st?.great), 'big'],
    ['Fair (-67 to -75)', pct(st?.ok)],
    ['Weak (-75 to -85)', pct(st?.weak)],
    ['Dead zones (< -85)', pct(st?.dead)],
    ['Average signal', st ? `${st.avg.toFixed(0)} dBm` : '—'],
  ]);
  const lambda = 299792458 / (wifi.freqGHz * 1e9);
  $('m-wifi2').innerHTML = rows([
    ['Frequency', `${wifi.freqGHz} GHz`],
    ['Wavelength', `${(lambda * 100).toFixed(1)} cm`],
    ['Grid', `${wifi.nx} × ${wifi.ny}`],
    ['Cell size', `${(wifi.dx * 1000).toFixed(1)} mm`],
    ['Routers', `${wifi.routers.length}`],
    ['Walls', `${wifi.walls.length}`],
    ['Sim time', `${((wifi.steps * 0.5 * wifi.dx) / 299792458 * 1e9).toFixed(1)} ns`],
  ]);
  $('st-steps').textContent = `${wifi.steps.toLocaleString()} steps`;
  $('st-engine').textContent = `GPU FDTD · ${wifi.nx}×${wifi.ny}`;
  const L = $('wlegend');
  if (state.wview === 'signal') {
    const stops = [
      ['#21c7a8', '-40'],
      ['#4dcc4d', '-55'],
      ['#eddb40', '-67'],
      ['#f58c33', '-75'],
      ['#d9332e', '-85'],
      ['#2e0d12', '-95'],
    ];
    L.innerHTML = `Signal strength (dBm)<div class="bar" style="background:linear-gradient(90deg,${stops.map((s) => s[0]).join(',')})"></div><div class="ends">${stops.map((s) => `<span>${s[1]}</span>`).join('')}</div>`;
  } else {
    L.innerHTML = 'Electric field right now (blue −, orange +)';
  }
}

// -------------------------------------------------------------------- UI --
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('on'), 3200);
}

function seg(id, key, onChange) {
  const el = $(id);
  const sync = () => el.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === state[key]));
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    state[key] = b.dataset.v;
    sync();
    onChange?.(b.dataset.v);
  });
  sync();
  return sync;
}

function speedFromSlider(t) {
  return state.speedMax * t * t;
}
function sliderFromSpeed(s) {
  return Math.sqrt(Math.min(1, s / state.speedMax));
}
function syncSpeed() {
  $('in-speed').value = sliderFromSpeed(state.speed);
  const kmh = state.speed * 3.6;
  $('out-speed').textContent = `${fmtNum(state.speed)} m/s · ${fmtNum(kmh)} km/h`;
}

function setMedium(m) {
  state.medium = m;
  if (MEDIA[m]) {
    const md = MEDIA[m];
    const wasAir = state.speedMax === MEDIA.air.max;
    state.rho = md.rho;
    state.nu = md.nu;
    state.speedMax = md.max;
    if (wasAir !== (m === 'air')) state.speed = md.speed;
  }
  $('in-rho').value = state.rho;
  $('in-nu').value = state.nu.toExponential(3);
  syncMedium();
  syncSpeed();
  updatePhysics();
  updateLegend();
}
let syncMedium = () => {};

function bindSlider(id, key, fmt, onChange) {
  const el = $(id);
  const out = $(id.replace('in-', 'out-'));
  el.value = state[key];
  const show = () => out && (out.textContent = fmt(state[key]));
  show();
  el.addEventListener('input', () => {
    state[key] = parseFloat(el.value);
    show();
    onChange?.();
  });
}

async function importFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  if (!['stl', 'obj', 'glb', 'gltf', 'ply'].includes(ext)) {
    toast(`Can't read .${ext} files. Use STL, OBJ, GLB or PLY.`);
    return;
  }
  toast(`Loading ${file.name}…`);
  try {
    const buf = await file.arrayBuffer();
    let obj;
    if (ext === 'stl') obj = new THREE.Mesh(new STLLoader().parse(buf));
    else if (ext === 'ply') obj = new THREE.Mesh(new PLYLoader().parse(buf));
    else if (ext === 'obj') obj = new OBJLoader().parse(new TextDecoder().decode(buf));
    else obj = (await new GLTFLoader().parseAsync(buf, '')).scene;
    const soup = G.soupFromObject(obj, THREE);
    if (soup.length < 9) throw new Error('no triangles found');
    state.rawSoup = soup;
    state.rawExt = ext;
    const name = file.name.replace(/\.[^.]+$/, '');
    setModel(orientImported(), name);
    let custom = document.querySelector('#in-shape option[value="__import"]');
    if (!custom) {
      custom = document.createElement('option');
      custom.value = '__import';
      $('in-shape').appendChild(custom);
    }
    custom.textContent = `Imported: ${name}`;
    $('in-shape').value = '__import';
    const tris = (soup.length / 9).toLocaleString();
    toast(`Loaded ${name} (${tris} triangles). Set its real length and mass on the left.`);
  } catch (e) {
    console.error(e);
    toast(`Couldn't load that file: ${e.message}`);
  }
}

function exportCSV() {
  const r = results();
  const lines = [
    ['FlowTunnel results'],
    ['model', state.modelName],
    ['fluid', state.medium],
    ['density_kg_m3', state.rho],
    ['kinematic_viscosity_m2_s', state.nu],
    ['speed_m_s', r.U],
    ['length_m', r.L],
    ['mass_kg', state.mass],
    ['pitch_deg', state.pitch],
    ['yaw_deg', state.yaw],
    ['roll_deg', state.roll],
    ['view', state.view],
    ['slice', state.slice],
    ['reynolds', realRe()],
    ['sim_reynolds', simRe()],
    ['Cd', r.cd.mean],
    [state.view === 'side' ? 'Cl' : 'Cs', r.cl.mean],
    ['drag_N', r.drag],
    ['lift_or_side_N', r.lift],
    ['frontal_area_m2', r.A],
    ['volume_m3', r.V],
    ['buoyant_force_N', r.Fb],
    ['weight_N', r.Wt],
    ['strouhal', r.st],
    ['shedding_hz', r.freq],
    [],
    ['time_s', 'Cd', state.view === 'side' ? 'Cl' : 'Cs'],
    ...hist.cd.map((cd, i) => [(hist.step[i] * r.dt).toFixed(5), cd.toFixed(5), hist.cl[i].toFixed(5)]),
  ];
  const blob = new Blob([lines.map((l) => l.join(',')).join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `flowtunnel-${state.modelName.replace(/\W+/g, '_')}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function initUI() {
  const sel = $('in-shape');
  for (const [k, s] of Object.entries(SHAPES)) {
    const o = document.createElement('option');
    o.value = k;
    o.textContent = s.label;
    sel.appendChild(o);
  }
  sel.value = state.shape;
  sel.addEventListener('change', () => {
    if (sel.value === '__import') {
      if (state.rawSoup) setModel(orientImported(), state.modelName);
      return;
    }
    loadShape(sel.value);
  });

  $('btn-import').addEventListener('click', () => $('file').click());
  $('file').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (f) importFile(f);
    e.target.value = '';
  });
  $('in-up').addEventListener('change', () => {
    if (state.rawSoup && sel.value === '__import') setModel(orientImported(), state.modelName);
  });

  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragDepth++;
    $('drop').classList.add('on');
  });
  window.addEventListener('dragleave', () => {
    if (--dragDepth <= 0) $('drop').classList.remove('on');
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    $('drop').classList.remove('on');
    const f = e.dataTransfer.files[0];
    if (f) importFile(f);
  });

  $('in-length').value = state.length;
  $('in-mass').value = state.mass;
  $('in-length').addEventListener('input', (e) => {
    const v = parseFloat(e.target.value);
    if (v > 0) {
      state.length = v;
      updatePhysics();
    }
  });
  $('in-mass').addEventListener('input', (e) => {
    const v = parseFloat(e.target.value);
    if (v >= 0) state.mass = v;
  });

  syncMedium = seg('seg-medium', 'medium', (m) => setMedium(m));
  $('in-rho').addEventListener('input', (e) => {
    const v = parseFloat(e.target.value);
    if (v > 0) {
      state.rho = v;
      state.medium = 'custom';
      syncMedium();
      updateLegend();
    }
  });
  $('in-nu').addEventListener('change', (e) => {
    const v = parseFloat(e.target.value);
    if (v > 0) {
      state.nu = v;
      state.medium = 'custom';
      syncMedium();
      updatePhysics();
    } else {
      e.target.value = state.nu.toExponential(3);
    }
  });
  $('in-speed').addEventListener('input', (e) => {
    const wasZero = state.speed <= 0;
    state.speed = speedFromSlider(parseFloat(e.target.value));
    syncSpeed();
    updatePhysics();
    updateLegend();
    if (wasZero && state.speed > 0) {
      solver.steps = 0;
      resetStats();
    }
  });

  const deg = (v) => `${v}°`;
  bindSlider('in-pitch', 'pitch', deg, queueRebuild);
  bindSlider('in-yaw', 'yaw', deg, queueRebuild);
  bindSlider('in-roll', 'roll', deg, queueRebuild);
  $('btn-flip').addEventListener('click', () => {
    state.flip = !state.flip;
    rebuildBody();
    resetStats();
  });

  seg('seg-view', 'view', () => {
    rebuildBody();
    resetStats();
  });
  seg('seg-slice', 'slice', () => {
    rebuildBody();
    resetStats();
  });
  bindSlider('in-slicepos', 'slicePos', () => '', queueRebuild);

  $('in-res').value = state.res;
  $('in-res').addEventListener('change', (e) => {
    state.res = +e.target.value;
    makeSolver();
  });
  bindSlider('in-spf', 'spf', (v) => `${v}`);
  bindSlider('in-cs', 'cs', (v) => v.toFixed(2), () => solver && (solver.cs = state.cs));

  seg('seg-field', 'field', () => updateLegend());
  $('in-tracers').addEventListener('change', (e) => (state.tracers = e.target.checked));
  $('in-arrows').addEventListener('change', (e) => (state.arrows = e.target.checked));

  const play = $('btn-play');
  const togglePlay = () => {
    state.running = !state.running;
    play.textContent = state.running ? 'Pause' : 'Run';
  };
  play.addEventListener('click', togglePlay);
  const resetFlow = () => {
    if (state.mode === 'wifi') {
      if (wifi) wifi.reset();
      return;
    }
    if (state.mode === '3d' && tunnel.solver) tunnel.solver.reset();
    solver.reset();
    dye.fill(0);
    initTracers();
    resetStats();
  };
  $('btn-reset').addEventListener('click', resetFlow);
  $('btn-export').addEventListener('click', exportCSV);
  window.addEventListener('keydown', (e) => {
    if (e.target.matches('input, select, textarea')) return;
    if (e.code === 'Space') {
      e.preventDefault();
      togglePlay();
    } else if (e.key === 'r' || e.key === 'R') resetFlow();
  });

  flowCanvas.addEventListener('mousemove', (e) => {
    if (!solver) return;
    const v = view();
    const gx = ((e.offsetX * v.dpr - v.ox) / v.s) | 0;
    const gy = (solver.ny - (e.offsetY * v.dpr - v.oy) / v.s) | 0;
    if (gx < 1 || gy < 1 || gx >= solver.nx - 1 || gy >= solver.ny - 1) {
      $('probe').textContent = '';
      return;
    }
    const k = gy * solver.nx + gx;
    if (solver.solid[k]) {
      $('probe').textContent = 'inside body';
      return;
    }
    const U = state.speed;
    const u = (Math.hypot(solver.ux[k], solver.uy[k]) / 0.1) * U;
    const cp = (solver.rho[k] - refDensity()) / 3 / (0.5 * 0.01);
    const p = cp * 0.5 * state.rho * U * U;
    const w = (vort(k, gx, gy) / 0.1) * (U / (state.length / body.chord));
    $('probe').textContent = `speed ${fmtNum(u)} m/s · pressure ${fmtNum(p)} Pa · spin ${fmtNum(w)} 1/s`;
  });
  flowCanvas.addEventListener('mouseleave', () => ($('probe').textContent = ''));

  // ---- mode ----
  seg('seg-mode', 'mode', (m) => setMode(m));

  // ---- 3D display ----
  $('in-lines').addEventListener('change', (e) => {
    state.lines = e.target.checked;
    tunnel.lines.visible = state.lines && state.mode === '3d';
  });
  seg('seg-rake', 'rake');
  bindSlider('in-density', 'density', (v) => `${v}`);
  bindSlider('in-pulse', 'pulse', (v) => (v === 0 ? 'off' : `${v.toFixed(2)}×`), () => {
    tunnel.lineMat.uniforms.pulses.value = state.pulse === 0 ? 0 : 1.4;
  });
  $('in-pressure').addEventListener('change', (e) => {
    state.pressure = e.target.checked;
    if (state.pressure) paintPressure();
    else restoreColors();
    updateLegend3();
  });
  $('in-ground').addEventListener('change', (e) => {
    state.ground = e.target.checked;
    rebuildBody();
    resetStats();
  });
  $('in-slice3').value = state.slice3;
  $('in-slice3').addEventListener('change', (e) => {
    state.slice3 = e.target.value;
    tunnel.sliceMode = state.slice3;
    tunnel.placeSlice();
    tunnel.updateSlice();
  });
  $('in-res3').value = state.res3;
  $('in-res3').addEventListener('change', (e) => {
    state.res3 = +e.target.value;
    makeTunnel();
  });
  bindSlider('in-spf3', 'spf3', (v) => `${v}`);

  // ---- WiFi ----
  const matSel = $('in-mat');
  MATERIALS.forEach((m, i) => {
    if (!m) return;
    const o = document.createElement('option');
    o.value = i;
    o.textContent = `${m.name} (${Math.round(m.t * 100)} cm)`;
    matSel.appendChild(o);
  });
  matSel.value = 1;
  seg('seg-band', 'band', (b) => {
    if (!wifi) return;
    wifi.band = b;
    wifi.build();
  });
  seg('seg-wview', 'wview', (v) => wifi && (wifi.mode = v === 'signal' ? 0 : 1));
  seg('seg-tool', 'tool');
  $('in-ppw').value = '9';
  $('in-ppw').addEventListener('change', (e) => {
    if (!wifi) return;
    wifi.ppw = +e.target.value;
    wifi.build();
  });
  bindSlider('in-wspf', 'wspf', (v) => `${v}`);
  $('btn-addrouter').addEventListener('click', () => {
    if (!wifi) return;
    if (wifi.routers.length >= 4) return toast('Four routers max.');
    pushUndo();
    wifi.routers.push({ x: wifi.size[0] / 2, y: wifi.size[1] / 2 });
    toast('Router added in the middle. Drag it where you want it.');
  });
  $('btn-delrouter').addEventListener('click', () => {
    if (!wifi || wifi.routers.length <= 1) return toast('Need at least one router.');
    pushUndo();
    wifi.routers.pop();
    wifi.reset();
  });
  $('btn-undo').addEventListener('click', () => {
    if (!wifi || !undoStack.length) return;
    const snap = JSON.parse(undoStack.pop());
    wifi.walls = snap.walls;
    wifi.routers = snap.routers;
    wifi.rasterize();
  });
  $('btn-clearwalls').addEventListener('click', () => {
    if (!wifi) return;
    pushUndo();
    wifi.walls = [];
    wifi.rasterize();
  });
  $('btn-layout').addEventListener('click', () => {
    if (!wifi) return;
    pushUndo();
    const l = defaultLayout();
    wifi.walls = l.walls;
    wifi.routers = l.routers;
    wifi.rasterize();
    wifi.reset();
  });
  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'z' && state.mode === 'wifi') {
      e.preventDefault();
      $('btn-undo').click();
    }
  });

  const snap = (p, from, straight) => {
    let [x, y] = p.map((v) => Math.round(v * 20) / 20);
    if (straight && from) {
      if (Math.abs(x - from[0]) > Math.abs(y - from[1])) y = from[1];
      else x = from[0];
    }
    return [x, y];
  };
  wui.addEventListener('pointerdown', (e) => {
    if (!wifi) return;
    wui.setPointerCapture(e.pointerId);
    const p = wFromEvent(e);
    if (state.tool === 'router') {
      let best = -1, bd = Infinity;
      wifi.routers.forEach((r, i) => {
        const d = Math.hypot(r.x - p[0], r.y - p[1]);
        if (d < bd) {
          bd = d;
          best = i;
        }
      });
      if (best >= 0) {
        pushUndo();
        wDrag = { kind: 'router', i: best };
        wifi.routers[best].x = p[0];
        wifi.routers[best].y = p[1];
      }
    } else if (state.tool === 'wall') {
      wDrag = { kind: 'wall', from: snap(p), to: null };
    } else {
      const w = nearestWall(p[0], p[1]);
      if (w) {
        pushUndo();
        wifi.walls = wifi.walls.filter((x) => x !== w);
        wifi.rasterize();
      }
    }
  });
  wui.addEventListener('pointermove', (e) => {
    if (!wifi) return;
    const p = wFromEvent(e);
    wHover = p;
    if (wDrag && wDrag.kind === 'router') {
      const r = wifi.routers[wDrag.i];
      r.x = Math.max(-0.4, Math.min(wifi.size[0] + 0.4, p[0]));
      r.y = Math.max(-0.4, Math.min(wifi.size[1] + 0.4, p[1]));
    } else if (wDrag && wDrag.kind === 'wall') {
      wDrag.to = snap(p, wDrag.from, e.shiftKey);
    }
    const pr = wifi.probe(p[0], p[1]);
    if (pr && p[0] >= -0.6 && p[1] >= -0.6 && p[0] <= wifi.size[0] + 0.6 && p[1] <= wifi.size[1] + 0.6) {
      const inWall = pr.wall ? ` · inside ${MATERIALS[pr.wall].name.toLowerCase()}` : '';
      $('wprobe').textContent = `(${p[0].toFixed(1)}, ${p[1].toFixed(1)}) m · ${pr.dbm.toFixed(0)} dBm · ${signalWord(pr.dbm)}${inWall}`;
    } else $('wprobe').textContent = '';
  });
  const endDrag = () => {
    if (wDrag && wDrag.kind === 'wall' && wDrag.to) {
      const [x1, y1] = wDrag.from, [x2, y2] = wDrag.to;
      if (Math.hypot(x2 - x1, y2 - y1) > 0.08) {
        pushUndo();
        wifi.walls.push({ x1, y1, x2, y2, m: +$('in-mat').value });
        wifi.rasterize();
      }
    }
    wDrag = null;
  };
  wui.addEventListener('pointerup', endDrag);
  wui.addEventListener('pointercancel', endDrag);
  wui.addEventListener('pointerleave', () => {
    wHover = null;
    $('wprobe').textContent = '';
  });
}

function makeTunnel() {
  try {
    tunnel.makeSolver(state.res3);
  } catch (e) {
    console.error(e);
    toast(`3D tunnel unavailable on this GPU (${e.message}). Using the 2D slice.`);
    setMode('2d');
    return false;
  }
  tunnel.sliceMode = state.slice3;
  rebuildBody();
  updatePhysics();
  resetStats();
  const [a, b, c] = GRIDS[state.res3];
  $('st-engine').textContent = `GPU 3D solver · ${a}×${b}×${c}`;
  return true;
}

function setMode(m) {
  state.mode = m;
  document.body.dataset.mode = m;
  document.querySelectorAll('#seg-mode button').forEach((b) => b.classList.toggle('on', b.dataset.v === m));
  if (m === '3d') {
    if (!tunnel.solver && !makeTunnel()) return;
    const [a, b, c] = GRIDS[state.res3];
    $('st-engine').textContent = `GPU 3D solver · ${a}×${b}×${c}`;
    $('v3-title').textContent = 'Wind tunnel';
    if (state.pressure) paintPressure();
  } else if (m === '2d') {
    $('st-engine').textContent = `${solver.kind} solver · ${solver.nx}×${solver.ny}`;
    $('v3-title').textContent = '3D model + live slice';
    restoreColors();
  } else if (m === 'wifi') {
    if (!wifi) makeWifi();
    if (wifi) wifi.mode = state.wview === 'signal' ? 0 : 1;
  }
  if (m !== 'wifi' && state.soup) {
    rebuildBody();
    resetStats();
  }
  updateLegend3();
  requestAnimationFrame(() => {
    resize3D();
    if (m !== 'wifi') frameCamera();
  });
}

function updateLegend3() {
  const L = $('legend3');
  if (state.mode !== '3d') {
    L.style.display = 'none';
    return;
  }
  L.style.display = '';
  const bar = (data) => {
    const stops = [];
    for (let i = 0; i <= 8; i++) {
      const j = Math.round((i / 8) * 255) * 4;
      stops.push(`rgb(${data[j]},${data[j + 1]},${data[j + 2]}) ${(i / 8) * 100}%`);
    }
    return `<div class="bar" style="background:linear-gradient(90deg,${stops.join(',')})"></div>`;
  };
  const U = state.speed;
  let html = `Flow speed${bar(tunnel.jet.data)}<div class="ends"><span>0</span><span>${fmtNum(U * 0.75)}</span><span>${fmtNum(U * 1.5)} m/s</span></div>`;
  if (state.pressure) {
    const q = 0.5 * state.rho * U * U;
    html += `<div style="margin-top:6px">Surface pressure</div>${bar(tunnel.press.data)}<div class="ends"><span>${fmtNum(-1.5 * q)}</span><span>0</span><span>+${fmtNum(q)} Pa</span></div>`;
  }
  L.innerHTML = html;
}

// ------------------------------------------------------------------ boot --
const tunnel = new Tunnel3D(scene);
initUI();
if (!('WebGL2RenderingContext' in window) || location.search.includes('cpu')) useGpu = false;
state.res = 1;
$('in-res').value = 1;
setMedium('sea');
loadShape('turtle');
makeSolver();
if (!useGpu) {
  state.res = 0;
  $('in-res').value = 0;
  state.spf = 4;
  $('in-spf').value = 4;
  $('out-spf').textContent = '4';
  makeSolver();
}
updateLegend();
setMode(new URLSearchParams(location.search).get('mode') || '3d');
resize3D();
requestAnimationFrame(frame);
