// WiFi coverage: a 2D FDTD (Yee) solve of Maxwell's equations at the real
// WiFi frequency, running on the GPU. Walls are lossy dielectrics with
// ITU-R P.2040 properties (metal is a perfect conductor). The router is a
// continuous-wave source; time-averaged |E|^2 becomes signal strength.
//
// It's a 2D slice of the floor, so waves spread cylindrically (1/r) instead
// of spherically (1/r^2). We fold that extra 1/r back in when converting to
// dBm, which gets the falloff right while keeping all the reflections,
// shadowing and interference the 2D solve gives us.

export const MATERIALS = [
  null,
  // eps_r, conductivity a*f^b (S/m, f in GHz), thickness (m), colour
  { name: 'Drywall', eps: 2.94, a: 0.0116, b: 0.7076, t: 0.1, color: [200, 205, 214] },
  { name: 'Brick', eps: 3.75, a: 0.038, b: 0, t: 0.22, color: [181, 101, 74] },
  { name: 'Concrete', eps: 5.31, a: 0.0326, b: 0.8095, t: 0.2, color: [138, 143, 153] },
  { name: 'Glass', eps: 6.27, a: 0.0043, b: 1.1925, t: 0.02, color: [127, 211, 247] },
  { name: 'Wood', eps: 1.99, a: 0.0047, b: 1.0718, t: 0.05, color: [160, 118, 75] },
  { name: 'Metal', eps: 1, a: 0, b: 0, t: 0.05, pec: true, color: [222, 230, 238] },
];

export const BANDS = { '2.4': 2.437, '5': 5.5 };
const C0 = 299792458;
const ETA0 = 376.73;
const MARGIN = 0.6; // metres of absorbing border around the plan

export function defaultLayout() {
  const W = [];
  const add = (x1, y1, x2, y2, m) => W.push({ x1, y1, x2, y2, m });
  // Outer shell: brick with windows.
  add(0, 0, 2, 0, 2); add(2, 0, 4, 0, 4); add(4, 0, 8.5, 0, 2); add(8.5, 0, 10.5, 0, 4); add(10.5, 0, 12, 0, 2);
  add(12, 0, 12, 8, 2);
  add(12, 8, 9, 8, 2); add(9, 8, 7.8, 8, 5); add(7.8, 8, 4.5, 8, 2); add(4.5, 8, 2, 8, 4); add(2, 8, 0, 8, 2);
  add(0, 8, 0, 5.2, 2); add(0, 5.2, 0, 3.6, 4); add(0, 3.6, 0, 0, 2);
  // Bedroom 1 | hallway
  add(0, 3.5, 3.4, 3.5, 1); add(4.3, 3.5, 5, 3.5, 1);
  // Concrete core around the bathroom
  add(5, 0, 5, 3.5, 3); add(5, 3.5, 5.7, 3.5, 3); add(6.6, 3.5, 7.5, 3.5, 3); add(7.5, 0, 7.5, 4.5, 3);
  // Bedroom 2
  add(7.5, 4.5, 8.3, 4.5, 1); add(9.2, 4.5, 12, 4.5, 1);
  // Kitchen half-wall and fridge
  add(7.5, 6.3, 7.5, 8, 1);
  W.push({ x1: 11.5, y1: 5.3, x2: 11.5, y2: 6.1, m: 6, t: 0.7 });
  // A metal-backed TV on the living room wall
  W.push({ x1: 0.15, y1: 5.9, x2: 0.15, y2: 7.1, m: 6, t: 0.06 });
  return { walls: W, routers: [{ x: 2.6, y: 6.2 }], size: [12, 8] };
}

const VS = `#version 300 es
in vec2 pos;
void main() { gl_Position = vec4(pos, 0.0, 1.0); }`;

const COMMON = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D U;   // (Ez, Hx, Hy, P)
uniform sampler2D M;   // material id * (1/255)
uniform ivec2 N;
uniform float sponge;
float damp(ivec2 p) {
  float L = 36.0;
  float d = float(min(min(p.x, p.y), min(N.x - 1 - p.x, N.y - 1 - p.y)));
  if (d >= L) return 0.0;
  float s = (L - d) / L;
  return sponge * s * s;
}
int mat(ivec2 p) { return int(texelFetch(M, p, 0).r * 255.0 + 0.5); }
`;

const H_FS =
  COMMON +
  `out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 c = texelFetch(U, p, 0);
  float ezR = texelFetch(U, min(p + ivec2(1, 0), N - 1), 0).x;
  float ezU = texelFetch(U, min(p + ivec2(0, 1), N - 1), 0).x;
  float k = 1.0 - damp(p);
  float hx = k * (c.y - 0.5 * (ezU - c.x));
  float hy = k * (c.z + 0.5 * (ezR - c.x));
  o = vec4(c.x, hx, hy, c.w);
}`;

const E_FS =
  COMMON +
  `out vec4 o;
uniform float CA[8], CB[8];
uniform vec2 R[4];
uniform int NR;
uniform float src, alpha;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 c = texelFetch(U, p, 0);
  int m = mat(p);
  float ez = 0.0;
  if (m != 6) {
    float hyL = texelFetch(U, max(p - ivec2(1, 0), ivec2(0)), 0).z;
    float hxD = texelFetch(U, max(p - ivec2(0, 1), ivec2(0)), 0).y;
    ez = CA[m] * c.x + CB[m] * ((c.z - hyL) - (c.y - hxD));
    for (int i = 0; i < 4; i++) {
      if (i >= NR) break;
      vec2 d = vec2(p) - R[i];
      if (dot(d, d) < 2.0) ez += src;
    }
    ez *= 1.0 - damp(p);
  }
  float P = c.w + alpha * (ez * ez - c.w);
  o = vec4(ez, c.y, c.z, P);
}`;

const INIT_FS = `#version 300 es
precision highp float;
out vec4 o;
void main() { o = vec4(0.0); }`;

// 4x4 box-filter of P for the CPU-side stats.
const DOWN_FS =
  COMMON +
  `out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy) * 4;
  float s = 0.0, walls = 0.0;
  for (int j = 0; j < 4; j++) for (int i = 0; i < 4; i++) {
    ivec2 q = min(p + ivec2(i, j), N - 1);
    s += texelFetch(U, q, 0).w;
    walls += mat(q) > 0 ? 1.0 : 0.0;
  }
  o = vec4(s / 16.0, walls / 16.0, 0.0, 0.0);
}`;

const SHOW_FS =
  COMMON +
  `out vec4 o;
uniform vec2 view0, viewS;  // cell = (frag - view0) * viewS
uniform float canvasH;
uniform int mode;           // 0 signal, 1 waves
uniform float P1m, cellsPerM, margin;
uniform vec2 plan;
uniform vec2 R[4];
uniform int NR;
uniform vec3 MC[8];

vec3 signalColor(float dbm) {
  // strong -> weak: teal, green, yellow, orange, red, dark
  const float S[6] = float[6](-40.0, -55.0, -67.0, -75.0, -85.0, -95.0);
  const vec3 C[6] = vec3[6](vec3(0.13, 0.78, 0.66), vec3(0.30, 0.80, 0.30), vec3(0.93, 0.86, 0.25),
                            vec3(0.96, 0.55, 0.20), vec3(0.85, 0.20, 0.18), vec3(0.18, 0.05, 0.07));
  if (dbm >= S[0]) return C[0];
  for (int i = 0; i < 5; i++) {
    if (dbm >= S[i + 1]) return mix(C[i + 1], C[i], (dbm - S[i + 1]) / (S[i] - S[i + 1]));
  }
  return C[5];
}

void main() {
  vec2 f = vec2(gl_FragCoord.x, canvasH - gl_FragCoord.y);
  vec2 cell = (f - view0) * viewS;
  ivec2 p = ivec2(floor(cell));
  if (p.x < 0 || p.y < 0 || p.x >= N.x || p.y >= N.y) { o = vec4(0.043, 0.055, 0.078, 1.0); return; }
  vec4 c = texelFetch(U, p, 0);
  int m = mat(p);
  float dmin = 1e9;
  for (int i = 0; i < 4; i++) { if (i >= NR) break; dmin = min(dmin, length(vec2(p) - R[i])); }
  float r = max(dmin / cellsPerM, 0.25);
  vec3 col;
  if (mode == 0) {
    // Average over ~half a wavelength: real radios (several antennas, 20+ MHz
    // of bandwidth) don't see the razor-thin standing-wave nulls.
    float P = 0.0, n = 0.0;
    for (int j = -3; j <= 3; j++) for (int i = -3; i <= 3; i++) {
      ivec2 q = clamp(p + ivec2(i, j), ivec2(0), N - 1);
      if (mat(q) > 0) continue;
      P += texelFetch(U, q, 0).w;
      n += 1.0;
    }
    P = n > 0.0 ? P / n : c.w;
    float dbm = -40.0 + 10.0 * log(max(P, 1e-30) / max(P1m, 1e-30)) / log(10.0) - 10.0 * log(r) / log(10.0);
    col = signalColor(dbm);
  } else {
    float a = c.x / sqrt(max(P1m, 1e-30)) * sqrt(r) * 0.7;
    float v = sign(a) * pow(min(abs(a), 1.0), 0.6);
    col = v > 0.0 ? mix(vec3(0.05, 0.06, 0.09), vec3(1.0, 0.45, 0.2), v) : mix(vec3(0.05, 0.06, 0.09), vec3(0.25, 0.55, 1.0), -v);
  }
  if (m > 0) col = mix(col, MC[m], 0.85);
  // dim the absorbing border
  vec2 m = vec2(p) / cellsPerM - margin;
  if (m.x < -0.05 || m.y < -0.05 || m.x > plan.x + 0.05 || m.y > plan.y + 0.05) col = mix(vec3(0.043, 0.055, 0.078), col, 0.3);
  o = vec4(col, 1.0);
}`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}
function program(gl, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VS));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.bindAttribLocation(p, 0, 'pos');
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const loc = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const name = gl.getActiveUniform(p, i).name.replace(/\[0\]$/, '');
    loc[name] = gl.getUniformLocation(p, name);
  }
  return { p, loc };
}

export class WifiSim {
  constructor(canvas) {
    const gl = canvas.getContext('webgl2', { antialias: false, depth: false, preserveDrawingBuffer: false });
    if (!gl) throw new Error('WebGL2 not available');
    if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('No float render targets');
    this.gl = gl;
    this.canvas = canvas;
    this.progs = {
      h: program(gl, H_FS),
      e: program(gl, E_FS),
      init: program(gl, INIT_FS),
      down: program(gl, DOWN_FS),
      show: program(gl, SHOW_FS),
    };
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

    const lay = defaultLayout();
    this.walls = lay.walls;
    this.routers = lay.routers;
    this.size = lay.size;
    this.band = '2.4';
    this.ppw = 9; // cells per wavelength
    this.mode = 0;
    this.P1m = 1;
    this.steps = 0;
    this.stats = null;
    this.textures = [];
    this.build();
  }

  get freqGHz() {
    return BANDS[this.band];
  }

  build() {
    const gl = this.gl;
    for (const t of this.textures) gl.deleteTexture(t);
    const lambda = C0 / (this.freqGHz * 1e9);
    this.dx = lambda / this.ppw;
    this.cellsPerM = 1 / this.dx;
    this.nx = Math.round((this.size[0] + 2 * MARGIN) * this.cellsPerM);
    this.ny = Math.round((this.size[1] + 2 * MARGIN) * this.cellsPerM);
    const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    if (this.nx > maxTex || this.ny > maxTex) {
      this.ppw = Math.max(6, this.ppw - 1);
      return this.build();
    }
    const tex = (w, h, internal, format, type) => {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, null);
      this.textures.push(t);
      return t;
    };
    const fb = (t) => {
      const f = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Framebuffer incomplete');
      return f;
    };
    this.state = [0, 1].map(() => {
      const t = tex(this.nx, this.ny, gl.RGBA32F, gl.RGBA, gl.FLOAT);
      return { t, f: fb(t) };
    });
    this.matTex = tex(this.nx, this.ny, gl.R8, gl.RED, gl.UNSIGNED_BYTE);
    this.dw = Math.ceil(this.nx / 4);
    this.dh = Math.ceil(this.ny / 4);
    this.downTex = tex(this.dw, this.dh, gl.RGBA32F, gl.RGBA, gl.FLOAT);
    this.downFb = fb(this.downTex);
    this.downBuf = new Float32Array(this.dw * this.dh * 4);
    this.cur = 0;

    // Update coefficients, normalised units: dx = 1, c = 1, dt = 0.5.
    const f = this.freqGHz;
    this.CA = new Float32Array(8).fill(1);
    this.CB = new Float32Array(8).fill(0.5);
    MATERIALS.forEach((m, i) => {
      if (!m || m.pec) return;
      const sigma = m.a * Math.pow(f, m.b);
      const loss = (sigma * this.dx * ETA0 * 0.5) / (2 * m.eps);
      this.CA[i] = (1 - loss) / (1 + loss);
      this.CB[i] = 0.5 / m.eps / (1 + loss);
    });
    this.omega = (2 * Math.PI) / this.ppw; // per unit time (dx/c)
    this.rasterize();
    this.reset();
  }

  reset() {
    const gl = this.gl;
    gl.useProgram(this.progs.init.p);
    gl.viewport(0, 0, this.nx, this.ny);
    gl.bindVertexArray(this.vao);
    for (const s of this.state) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, s.f);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    this.steps = 0;
    this.stats = null;
    this.P1m = 1;
  }

  toCell(x, y) {
    return [(x + MARGIN) * this.cellsPerM, (y + MARGIN) * this.cellsPerM];
  }

  fromCell(cx, cy) {
    return [cx / this.cellsPerM - MARGIN, cy / this.cellsPerM - MARGIN];
  }

  rasterize() {
    const { nx, ny } = this;
    const ids = new Uint8Array(nx * ny);
    for (const w of this.walls) {
      const m = MATERIALS[w.m];
      const half = Math.max((w.t ?? m.t) / 2, 0.6 * this.dx) * this.cellsPerM;
      const [ax, ay] = this.toCell(w.x1, w.y1);
      const [bx, by] = this.toCell(w.x2, w.y2);
      const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - half - 1));
      const x1 = Math.min(nx - 1, Math.ceil(Math.max(ax, bx) + half + 1));
      const y0 = Math.max(0, Math.floor(Math.min(ay, by) - half - 1));
      const y1 = Math.min(ny - 1, Math.ceil(Math.max(ay, by) + half + 1));
      const dx = bx - ax, dy = by - ay;
      const L2 = dx * dx + dy * dy || 1;
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const px = x + 0.5, py = y + 0.5;
          let t = ((px - ax) * dx + (py - ay) * dy) / L2;
          t = Math.max(0, Math.min(1, t));
          const qx = ax + t * dx - px, qy = ay + t * dy - py;
          // Square-ish ends so walls meet cleanly at corners.
          if (Math.abs(qx) <= half && Math.abs(qy) <= half) ids[y * nx + x] = w.m;
        }
      }
    }
    this.ids = ids;
    const data = new Uint8Array(nx * ny);
    for (let k = 0; k < ids.length; k++) data[k] = ids[k];
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.matTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, nx, ny, gl.RED, gl.UNSIGNED_BYTE, data);
  }

  routerCells() {
    const out = new Float32Array(8);
    this.routers.slice(0, 4).forEach((r, i) => {
      const [cx, cy] = this.toCell(r.x, r.y);
      out[i * 2] = Math.floor(cx);
      out[i * 2 + 1] = Math.floor(cy);
    });
    return out;
  }

  bind(prog, src) {
    const gl = this.gl;
    gl.useProgram(prog.p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src);
    gl.uniform1i(prog.loc.U, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.matTex);
    gl.uniform1i(prog.loc.M, 1);
    gl.uniform2i(prog.loc.N, this.nx, this.ny);
    gl.uniform1f(prog.loc.sponge, 0.08);
  }

  run(steps) {
    const gl = this.gl;
    gl.viewport(0, 0, this.nx, this.ny);
    gl.bindVertexArray(this.vao);
    const R = this.routerCells();
    const alpha = 1 / (this.ppw * 8); // time-average over a few periods
    for (let s = 0; s < steps; s++) {
      // H update
      this.bind(this.progs.h, this.state[this.cur].t);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.state[1 - this.cur].f);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      this.cur = 1 - this.cur;
      // E update + source
      const e = this.progs.e;
      this.bind(e, this.state[this.cur].t);
      gl.uniform1fv(e.loc.CA, this.CA);
      gl.uniform1fv(e.loc.CB, this.CB);
      gl.uniform2fv(e.loc.R, R);
      gl.uniform1i(e.loc.NR, Math.min(4, this.routers.length));
      const ramp = Math.min(1, this.steps / (this.ppw * 6));
      gl.uniform1f(e.loc.src, 0.25 * ramp * Math.sin(this.omega * 0.5 * this.steps));
      gl.uniform1f(e.loc.alpha, alpha);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.state[1 - this.cur].f);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      this.cur = 1 - this.cur;
      this.steps++;
    }
  }

  // Draw to the visible canvas. view: { ox, oy, s } maps cells to CSS px.
  render(view) {
    const gl = this.gl;
    const c = this.canvas;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, c.width, c.height);
    const sp = this.progs.show;
    this.bind(sp, this.state[this.cur].t);
    gl.uniform2f(sp.loc.view0, view.ox, view.oy);
    gl.uniform2f(sp.loc.viewS, 1 / view.s, 1 / view.s);
    gl.uniform1f(sp.loc.canvasH, c.height);
    gl.uniform1i(sp.loc.mode, this.mode);
    gl.uniform1f(sp.loc.P1m, this.P1m);
    gl.uniform1f(sp.loc.cellsPerM, this.cellsPerM);
    gl.uniform1f(sp.loc.margin, MARGIN);
    gl.uniform2f(sp.loc.plan, this.size[0], this.size[1]);
    gl.uniform2fv(sp.loc.R, this.routerCells());
    gl.uniform1i(sp.loc.NR, Math.min(4, this.routers.length));
    const mc = new Float32Array(24);
    MATERIALS.forEach((m, i) => m && m.color.forEach((v, j) => (mc[i * 3 + j] = v / 255)));
    gl.uniform3fv(sp.loc.MC, mc);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  dbmFrom(P, rMeters) {
    const r = Math.max(rMeters, 0.25);
    return -40 + 10 * Math.log10(Math.max(P, 1e-30) / Math.max(this.P1m, 1e-30)) - 10 * Math.log10(r);
  }

  nearestRouter(x, y) {
    let d = Infinity;
    for (const r of this.routers) d = Math.min(d, Math.hypot(r.x - x, r.y - y));
    return d;
  }

  // Pull a downsampled power map back and work out coverage numbers.
  updateStats() {
    const gl = this.gl;
    const dp = this.progs.down;
    this.bind(dp, this.state[this.cur].t);
    gl.viewport(0, 0, this.dw, this.dh);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.downFb);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.readPixels(0, 0, this.dw, this.dh, gl.RGBA, gl.FLOAT, this.downBuf);
    const buf = this.downBuf;
    const at = (x, y) => {
      const [cx, cy] = this.toCell(x, y);
      const i = Math.min(this.dw - 1, Math.max(0, Math.floor(cx / 4)));
      const j = Math.min(this.dh - 1, Math.max(0, Math.floor(cy / 4)));
      return (j * this.dw + i) * 4;
    };
    // Calibrate: average power on a 1 m ring around the first router.
    if (this.routers.length) {
      const r0 = this.routers[0];
      let s = 0, n = 0;
      for (let a = 0; a < 32; a++) {
        const k = at(r0.x + Math.cos((a / 32) * 2 * Math.PI), r0.y + Math.sin((a / 32) * 2 * Math.PI));
        if (buf[k + 1] > 0) continue;
        s += buf[k];
        n++;
      }
      if (n > 4 && s > 0) this.P1m = s / n;
    }
    let tot = 0, great = 0, ok = 0, weak = 0, dead = 0, sum = 0;
    const step = 0.1;
    for (let y = step / 2; y < this.size[1]; y += step) {
      for (let x = step / 2; x < this.size[0]; x += step) {
        const k = at(x, y);
        if (buf[k + 1] > 0.5) continue;
        const d = this.dbmFrom(buf[k], this.nearestRouter(x, y));
        tot++;
        sum += d;
        if (d >= -67) great++;
        else if (d >= -75) ok++;
        else if (d >= -85) weak++;
        else dead++;
      }
    }
    this.stats = tot
      ? { great: great / tot, ok: ok / tot, weak: weak / tot, dead: dead / tot, avg: sum / tot }
      : null;
  }

  probe(x, y) {
    const [cx, cy] = this.toCell(x, y);
    const i = Math.floor(cx), j = Math.floor(cy);
    if (i < 0 || j < 0 || i >= this.nx || j >= this.ny) return null;
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.state[this.cur].f);
    const px = new Float32Array(4);
    gl.readPixels(i, j, 1, 1, gl.RGBA, gl.FLOAT, px);
    return { dbm: this.dbmFrom(px[3], this.nearestRouter(x, y)), wall: this.ids[j * this.nx + i] };
  }
}
