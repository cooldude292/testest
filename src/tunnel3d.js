// The 3D wind tunnel: places the body in the D3Q19 solver, and turns the
// flow field into things you can see (animated streamlines, a coloured
// slice plane, pressure painted on the body).
import * as THREE from 'three';
import { Lbm3D, voxelize } from './lbm3d.js';

export const GRIDS = [
  [96, 40, 48],
  [128, 56, 64],
  [176, 72, 88],
  [224, 96, 112],
];

const MAX_PTS = 260;
const SRGB2LIN = new Float32Array(256).map((_, i) => Math.pow(i / 255, 2.2));
const MAX_SEEDS = 1024;

const LINE_VS = `
attribute float aSpeed;
attribute float aTime;
attribute float aPhase;
varying float vSpeed;
varying float vTime;
varying float vPhase;
void main() {
  vSpeed = aSpeed;
  vTime = aTime;
  vPhase = aPhase;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const LINE_FS = `
uniform sampler2D lut;
uniform float time;
uniform float pulses;
uniform float opacity;
varying float vSpeed;
varying float vTime;
varying float vPhase;
void main() {
  vec3 c = texture2D(lut, vec2(clamp(vSpeed / 1.5, 0.0, 1.0), 0.5)).rgb;
  float ph = fract(vTime * pulses - time + vPhase);
  float pulse = smoothstep(0.0, 0.08, ph) * (1.0 - smoothstep(0.08, 0.55, ph));
  float a = opacity * (0.14 + 0.86 * pulse);
  gl_FragColor = vec4(c * a, a);
}`;

export function lutTexture(stops) {
  const data = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let j = 0;
    while (j < stops.length - 2 && t > stops[j + 1][0]) j++;
    const [t0, c0] = stops[j];
    const [t1, c1] = stops[j + 1];
    const u = Math.min(1, Math.max(0, (t - t0) / (t1 - t0 || 1)));
    for (let c = 0; c < 3; c++) data[i * 4 + c] = c0[c] + (c1[c] - c0[c]) * u;
    data[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, 256, 1, THREE.RGBAFormat);
  tex.needsUpdate = true;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  return { tex, data };
}

// Classic CFD "jet": slow = deep blue, fast = red.
const JET = [
  [0, [20, 40, 170]],
  [0.25, [30, 120, 255]],
  [0.45, [40, 220, 230]],
  [0.6, [70, 235, 110]],
  [0.75, [240, 230, 60]],
  [0.9, [250, 130, 40]],
  [1, [235, 45, 40]],
];
const PRESS = [
  [0, [40, 80, 220]],
  [0.35, [90, 190, 250]],
  [0.6, [235, 240, 235]],
  [0.8, [250, 170, 70]],
  [1, [225, 40, 35]],
];

export class Tunnel3D {
  constructor(scene) {
    this.scene = scene;
    this.solver = null;
    this.level = 1;
    this.ground = false;
    this.scale = 1;
    this.o = [0, 0, 0];
    this.bounds = null;
    this.seedsDirty = true;
    this.jet = lutTexture(JET);
    this.press = lutTexture(PRESS);

    // Streamlines
    const geo = new THREE.BufferGeometry();
    const nv = MAX_SEEDS * MAX_PTS * 2;
    this.lpos = new Float32Array(nv * 3);
    this.lspeed = new Float32Array(nv);
    this.ltime = new Float32Array(nv);
    this.lphase = new Float32Array(nv);
    geo.setAttribute('position', new THREE.BufferAttribute(this.lpos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aSpeed', new THREE.BufferAttribute(this.lspeed, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aTime', new THREE.BufferAttribute(this.ltime, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aPhase', new THREE.BufferAttribute(this.lphase, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setDrawRange(0, 0);
    this.lineMat = new THREE.ShaderMaterial({
      vertexShader: LINE_VS,
      fragmentShader: LINE_FS,
      uniforms: { lut: { value: this.jet.tex }, time: { value: 0 }, pulses: { value: 1.4 }, opacity: { value: 0.7 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.lines = new THREE.LineSegments(geo, this.lineMat);
    this.lines.frustumCulled = false;
    scene.add(this.lines);

    // Slice plane
    this.sliceCanvas = document.createElement('canvas');
    this.sliceCtx = this.sliceCanvas.getContext('2d');
    this.sliceTex = new THREE.CanvasTexture(this.sliceCanvas);
    this.sliceTex.colorSpace = THREE.SRGBColorSpace;
    this.slice = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: this.sliceTex, transparent: true, opacity: 0.75, side: THREE.DoubleSide, depthWrite: false }),
    );
    scene.add(this.slice);

    // Tunnel outline
    this.box = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
      new THREE.LineBasicMaterial({ color: 0x2a3446, transparent: true, opacity: 0.6 }),
    );
    scene.add(this.box);
    this.tmp = [0, 0, 0, 0];
  }

  setVisible(v) {
    this.lines.visible = v;
    this.slice.visible = v && this.sliceMode !== 'off';
    this.box.visible = v;
  }

  makeSolver(level) {
    this.level = level;
    if (this.solver) this.solver.dispose();
    this.solver = null;
    const [nx, ny, nz] = GRIDS[level];
    this.solver = new Lbm3D(nx, ny, nz);
    return this.solver;
  }

  // rot: rotated triangle soup in model units (length 1 along X before rotation).
  // frontal: projected area facing the flow, in model units^2.
  // bounds: of the rotated body. ub / frontal: the unrotated body's bounds
  // and frontal area (model units), used for sizing so rotating doesn't rescale.
  setBody(rot, bounds, ub, frontal) {
    const s = this.solver;
    if (!s) return;
    const { nx, ny, nz } = s;
    this.bounds = bounds;
    s.ground = this.ground;
    // Keep blockage (body frontal area / tunnel cross-section) around 7%, like
    // a decent real tunnel, and leave room around the body in every direction.
    const size = ub.size;
    const sc = Math.min(
      nx * 0.25,
      Math.sqrt((0.07 * ny * nz) / Math.max(1e-3, frontal)),
      (0.45 * ny) / Math.max(1e-3, size[1]),
      (0.6 * nz) / Math.max(1e-3, size[2]),
      (0.4 * Math.min(ny, nz)) / Math.max(0.3, Math.hypot(size[0], size[1], size[2]) / 2),
    );
    this.scale = sc;
    const ox = nx * 0.3;
    const oy = this.ground ? 2.05 - bounds.min[1] * sc : ny / 2 + 0.3;
    const oz = nz / 2 + 0.31;
    this.o = [ox, oy, oz];
    const cells = new Float32Array(rot.length);
    for (let i = 0; i < rot.length; i += 3) {
      cells[i] = ox + rot[i] * sc;
      cells[i + 1] = oy + rot[i + 1] * sc;
      cells[i + 2] = oz + rot[i + 2] * sc;
    }
    s.setSolid(voxelize(cells, nx, ny, nz));

    // Frame the tunnel outline and slice plane in model units.
    this.box.scale.set(nx / sc, ny / sc, nz / sc);
    this.box.position.set((nx / 2 - ox) / sc, (ny / 2 - oy) / sc, (nz / 2 - oz) / sc);
    this.floorY = (0 - oy) / sc;
    this.seedsDirty = true;
    this.placeSlice();
  }

  // Cell <-> model-unit transforms.
  toCell(p) {
    return [this.o[0] + p[0] * this.scale, this.o[1] + p[1] * this.scale, this.o[2] + p[2] * this.scale];
  }

  // Integrate streamlines from a rake of seeds upstream of the body.
  updateStreamlines({ density = 18, rake = 'grid', maxPts = MAX_PTS }) {
    const s = this.solver;
    if (!s || !this.bounds) return;
    const b = this.bounds;
    const sc = this.scale;
    const u0 = s.u0 || 0.1;
    const pad = 0.14;
    const ylo = this.ground ? Math.max(b.min[1] + 0.01, this.floorY + 2 / sc) : b.min[1] - pad;
    const yhi = b.max[1] + pad;
    const zlo = b.min[2] - pad, zhi = b.max[2] + pad;
    const x0 = Math.max(b.min[0] - 0.45, (3 - this.o[0]) / sc);
    const seeds = [];
    if (rake === 'plane') {
      const n = Math.min(MAX_SEEDS, Math.round(density * 2.2));
      for (let i = 0; i < n; i++) seeds.push([x0, ylo + ((i + 0.5) / n) * (yhi - ylo), 0.002]);
    } else {
      const ny_ = Math.max(2, Math.round(density));
      const nz_ = Math.max(2, Math.round((density * (zhi - zlo)) / Math.max(0.05, yhi - ylo)));
      const total = ny_ * nz_;
      const f = total > MAX_SEEDS ? Math.sqrt(MAX_SEEDS / total) : 1;
      const a = Math.max(2, Math.floor(ny_ * f)), c = Math.max(2, Math.floor(nz_ * f));
      for (let j = 0; j < a; j++)
        for (let k = 0; k < c; k++)
          seeds.push([x0, ylo + ((j + 0.5) / a) * (yhi - ylo), zlo + ((k + 0.5) / c) * (zhi - zlo)]);
    }

    const { nx, ny, nz } = s;
    const out = this.tmp;
    const h = 0.7; // cells per integration step
    let v = 0;
    const P = this.lpos, S = this.lspeed, T = this.ltime, Ph = this.lphase;
    for (let si = 0; si < seeds.length; si++) {
      let [cx, cy, cz] = this.toCell(seeds[si]);
      const phase = (si * 0.61803) % 1;
      let tau = 0;
      s.sample(cx, cy, cz, out);
      let spd = Math.hypot(out[0], out[1], out[2]) / u0;
      for (let k = 0; k < maxPts; k++) {
        // RK2 (midpoint), step length fixed in space
        const m1 = Math.hypot(out[0], out[1], out[2]);
        if (m1 < 0.02 * u0) break;
        const hx = cx + (out[0] / m1) * h * 0.5, hy = cy + (out[1] / m1) * h * 0.5, hz = cz + (out[2] / m1) * h * 0.5;
        s.sample(hx, hy, hz, out);
        const m2 = Math.hypot(out[0], out[1], out[2]);
        if (m2 < 0.02 * u0) break;
        const nxp = cx + (out[0] / m2) * h, nyp = cy + (out[1] / m2) * h, nzp = cz + (out[2] / m2) * h;
        if (nxp < 1 || nxp > nx - 2 || nyp < 1 || nyp > ny - 2 || nzp < 1 || nzp > nz - 2) break;
        if (s.isSolid(nxp, nyp, nzp)) break;
        const dtau = h / sc / Math.max(0.05, m2 / u0);
        // segment (cx,cy,cz) -> (nxp,nyp,nzp)
        P[v * 3] = (cx - this.o[0]) / sc;
        P[v * 3 + 1] = (cy - this.o[1]) / sc;
        P[v * 3 + 2] = (cz - this.o[2]) / sc;
        S[v] = spd;
        T[v] = tau;
        Ph[v] = phase;
        v++;
        tau += dtau;
        spd = m2 / u0;
        P[v * 3] = (nxp - this.o[0]) / sc;
        P[v * 3 + 1] = (nyp - this.o[1]) / sc;
        P[v * 3 + 2] = (nzp - this.o[2]) / sc;
        S[v] = spd;
        T[v] = tau;
        Ph[v] = phase;
        v++;
        cx = nxp;
        cy = nyp;
        cz = nzp;
        s.sample(cx, cy, cz, out);
      }
    }
    const g = this.lines.geometry;
    g.setDrawRange(0, v);
    for (const name of ['position', 'aSpeed', 'aTime', 'aPhase']) {
      const a = g.attributes[name];
      a.clearUpdateRanges();
      a.addUpdateRange(0, v * a.itemSize);
      a.needsUpdate = true;
    }
  }

  placeSlice() {
    const s = this.solver;
    if (!s) return;
    const { nx, ny, nz } = s;
    const sc = this.scale;
    const [ox, oy, oz] = this.o;
    const mode = this.sliceMode || 'side';
    this.slice.visible = mode !== 'off' && this.lines.visible;
    if (mode === 'side') {
      this.sliceCanvas.width = s.hx;
      this.sliceCanvas.height = s.hy;
      this.slice.rotation.set(0, 0, 0);
      this.slice.scale.set(nx / sc, ny / sc, 1);
      this.slice.position.set((nx / 2 - ox) / sc, (ny / 2 - oy) / sc, 0);
    } else {
      this.sliceCanvas.width = s.hx;
      this.sliceCanvas.height = s.hz;
      this.slice.rotation.set(-Math.PI / 2, 0, 0);
      this.slice.scale.set(nx / sc, nz / sc, 1);
      const y = this.ground ? this.floorY + 1.5 / sc : this.bounds ? (this.bounds.min[1] + this.bounds.max[1]) / 2 : 0;
      this.sliceY = y;
      this.slice.position.set((nx / 2 - ox) / sc, y, (nz / 2 - oz) / sc);
    }
    // A canvas texture can't change size after upload.
    this.sliceTex.dispose();
    this.sliceTex = new THREE.CanvasTexture(this.sliceCanvas);
    this.sliceTex.colorSpace = THREE.SRGBColorSpace;
    this.slice.material.map = this.sliceTex;
    this.slice.material.needsUpdate = true;
  }

  updateSlice() {
    const s = this.solver;
    if (!s || !this.slice.visible) return;
    const { hx, hy, hz } = s;
    const u0 = s.u0 || 0.1;
    const side = (this.sliceMode || 'side') === 'side';
    const w = hx, h = side ? hy : hz;
    const img = this.sliceCtx.createImageData(w, h);
    const d = img.data;
    const L = this.jet.data;
    const zc = Math.min(hz - 1, Math.max(0, Math.round(this.o[2] / 2)));
    const yc = Math.min(hy - 1, Math.max(0, Math.round((this.o[1] + (this.sliceY ?? 0) * this.scale) / 2)));
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const k = side ? i + hx * (j + hy * zc) : i + hx * (yc + hy * j);
        const sp = Math.hypot(s.hux[k], s.huy[k], s.huz[k]) / u0;
        // canvas row 0 is the top of the texture: high y (side) or low z (floor)
        const row = side ? h - 1 - j : j;
        const p = (row * w + i) * 4;
        const solid = s.hrho[k] === 1 && sp === 0;
        if (solid) {
          d[p] = d[p + 1] = d[p + 2] = 90;
          d[p + 3] = 255;
          continue;
        }
        const li = Math.min(255, (sp / 1.5) * 255) | 0;
        d[p] = L[li * 4];
        d[p + 1] = L[li * 4 + 1];
        d[p + 2] = L[li * 4 + 2];
        d[p + 3] = 235;
      }
    }
    this.sliceCtx.putImageData(img, 0, 0);
    this.sliceTex.needsUpdate = true;
  }

  // Colour each vertex of the (rotated) mesh by the pressure just outside it.
  pressureColors(pos, nrm, M, out) {
    const s = this.solver;
    if (!s) return;
    const u0 = s.u0 || 0.1;
    const q = 0.5 * u0 * u0;
    const L = this.press.data;
    const off = 1.6 / this.scale;
    const t = this.tmp;
    for (let i = 0; i < pos.length; i += 3) {
      const x = pos[i], y = pos[i + 1], z = pos[i + 2];
      const a = nrm[i], b = nrm[i + 1], c = nrm[i + 2];
      const px = M[0] * x + M[1] * y + M[2] * z + (M[0] * a + M[1] * b + M[2] * c) * off;
      const py = M[3] * x + M[4] * y + M[5] * z + (M[3] * a + M[4] * b + M[5] * c) * off;
      const pz = M[6] * x + M[7] * y + M[8] * z + (M[6] * a + M[7] * b + M[8] * c) * off;
      const [cx, cy, cz] = this.toCell([px, py, pz]);
      s.sample(cx, cy, cz, t);
      const cp = (t[3] - s.rhoRef) / 3 / q;
      const li = Math.min(255, Math.max(0, ((cp + 1.5) / 2.5) * 255)) | 0;
      // vertex colours are linear; the LUT is sRGB
      out[i] = SRGB2LIN[L[li * 4]];
      out[i + 1] = SRGB2LIN[L[li * 4 + 1]];
      out[i + 2] = SRGB2LIN[L[li * 4 + 2]];
    }
  }
}
