// WebGL2 version of the D2Q9 LBM in solver.js. Same physics, same public
// surface (run / setSolid / setViscosity / reset / sample / ux uy rho arrays),
// but the steps run in a fragment shader so we can afford big grids and many
// steps per frame.
//
// State lives in four RGBA32F textures (ping-ponged):
//   T0 = f0..f3   T1 = f4..f7   T2 = (f8, rho, ux, uy)   T3 = (Fx, Fy) accumulated

const VS = `#version 300 es
in vec2 pos;
void main() { gl_Position = vec4(pos, 0.0, 1.0); }`;

const COMMON = `#version 300 es
precision highp float;
precision highp int;
const int EX[9] = int[9](0, 1, 0, -1, 0, 1, -1, -1, 1);
const int EY[9] = int[9](0, 0, 1, 0, -1, 1, 1, -1, -1);
const int OPP[9] = int[9](0, 3, 4, 1, 2, 7, 8, 5, 6);
const float W[9] = float[9](4.0/9.0, 1.0/9.0, 1.0/9.0, 1.0/9.0, 1.0/9.0, 1.0/36.0, 1.0/36.0, 1.0/36.0, 1.0/36.0);
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
layout(location = 2) out vec4 o2;
layout(location = 3) out vec4 o3;
float feq(int i, float r, vec2 u) {
  float cu = float(EX[i]) * u.x + float(EY[i]) * u.y;
  return W[i] * r * (1.0 + 3.0 * cu + 4.5 * cu * cu - 1.5 * dot(u, u));
}
void writeEq(float r, vec2 u) {
  o0 = vec4(feq(0, r, u), feq(1, r, u), feq(2, r, u), feq(3, r, u));
  o1 = vec4(feq(4, r, u), feq(5, r, u), feq(6, r, u), feq(7, r, u));
  o2 = vec4(feq(8, r, u), r, u);
}
`;

const INIT_FS = COMMON + `
void main() { writeEq(1.0, vec2(0.0)); o3 = vec4(0.0); }`;

const STEP_FS = COMMON + `
uniform sampler2D T0, T1, T2, T3, S;
uniform ivec2 N;
uniform float uin, tau0, smag, accum;

bool solid(ivec2 q) { return texelFetch(S, q, 0).r > 0.5; }
float fpost(int i, ivec2 q) {
  if (i < 4) return texelFetch(T0, q, 0)[i];
  if (i < 8) return texelFetch(T1, q, 0)[i - 4];
  return texelFetch(T2, q, 0).x;
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec2 prevF = accum * texelFetch(T3, p, 0).xy;
  if (solid(p)) { writeEq(1.0, vec2(0.0)); o3 = vec4(prevF, 0.0, 0.0); return; }
  if (p.x == 0 || p.y == 0 || p.y == N.y - 1) {
    writeEq(1.0, vec2(uin, 0.0)); o3 = vec4(prevF, 0.0, 0.0); return;
  }
  if (p.x == N.x - 1) {
    ivec2 q = ivec2(p.x - 1, p.y);
    o0 = texelFetch(T0, q, 0); o1 = texelFetch(T1, q, 0); o2 = texelFetch(T2, q, 0);
    o3 = vec4(prevF, 0.0, 0.0); return;
  }

  float f[9];
  vec2 F = vec2(0.0);
  for (int i = 0; i < 9; i++) {
    ivec2 q = p - ivec2(EX[i], EY[i]);
    if (i > 0 && solid(q)) {
      float fo = fpost(OPP[i], p);
      f[i] = fo;
      F -= 2.0 * fo * vec2(float(EX[i]), float(EY[i]));
    } else {
      f[i] = fpost(i, q);
    }
  }

  float r = 0.0; vec2 u = vec2(0.0);
  for (int i = 0; i < 9; i++) { r += f[i]; u += f[i] * vec2(float(EX[i]), float(EY[i])); }
  if (!(r > 0.2) || isnan(r)) r = 1.0;
  u /= r;
  if (any(isnan(u))) u = vec2(0.0);

  float pxx = 0.0, pyy = 0.0, pxy = 0.0;
  float e[9];
  for (int i = 0; i < 9; i++) {
    e[i] = feq(i, r, u);
    float d = f[i] - e[i];
    float cx = float(EX[i]), cy = float(EY[i]);
    pxx += cx * cx * d; pyy += cy * cy * d; pxy += cx * cy * d;
  }
  float Q = sqrt(pxx * pxx + pyy * pyy + 2.0 * pxy * pxy);
  float tau = 0.5 * (tau0 + sqrt(tau0 * tau0 + smag * Q / r));
  float om = 1.0 / tau;
  for (int i = 0; i < 9; i++) f[i] += om * (e[i] - f[i]);

  o0 = vec4(f[0], f[1], f[2], f[3]);
  o1 = vec4(f[4], f[5], f[6], f[7]);
  o2 = vec4(f[8], r, u);
  o3 = vec4(prevF + F, 0.0, 0.0);
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
  return p;
}

export class GpuLBM {
  get kind() {
    return 'GPU';
  }

  constructor(nx, ny) {
    this.nx = nx;
    this.ny = ny;
    this.n = nx * ny;
    this.u0 = 0.1;
    this.tau0 = 0.52;
    this.cs = 0.16;
    this.fx = 0;
    this.fy = 0;
    this.steps = 0;
    this.rampSteps = 400;
    this.rho = new Float32Array(this.n);
    this.ux = new Float32Array(this.n);
    this.uy = new Float32Array(this.n);
    this.solid = new Uint8Array(this.n);
    this._read = new Float32Array(this.n * 4);

    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const gl = canvas.getContext('webgl2', { antialias: false, depth: false, preserveDrawingBuffer: false });
    if (!gl) throw new Error('WebGL2 not available');
    if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('No float render targets');
    if (gl.getParameter(gl.MAX_DRAW_BUFFERS) < 4) throw new Error('Need 4 draw buffers');
    this.gl = gl;

    this.stepProg = program(gl, STEP_FS);
    this.initProg = program(gl, INIT_FS);
    this.loc = {};
    for (const name of ['T0', 'T1', 'T2', 'T3', 'S', 'N', 'uin', 'tau0', 'smag', 'accum'])
      this.loc[name] = gl.getUniformLocation(this.stepProg, name);

    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    const tex = (internal, format, type, data = null) => {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, internal, nx, ny, 0, format, type, data);
      return t;
    };

    this.bufs = [0, 1].map(() => {
      const texs = [0, 1, 2, 3].map(() => tex(gl.RGBA32F, gl.RGBA, gl.FLOAT));
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      texs.forEach((t, i) => gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0));
      gl.drawBuffers([0, 1, 2, 3].map((i) => gl.COLOR_ATTACHMENT0 + i));
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Framebuffer incomplete');
      return { texs, fb };
    });
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    this.solidTex = tex(gl.R8, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array(this.n));
    this.cur = 0;
    this.reset();
  }

  setViscosity(nu) {
    this.tau0 = Math.max(0.5005, 3 * nu + 0.5);
  }

  get nu() {
    return (this.tau0 - 0.5) / 3;
  }

  setSolid(mask) {
    this.solid.set(mask);
    const gl = this.gl;
    const data = new Uint8Array(this.n);
    for (let k = 0; k < this.n; k++) data[k] = mask[k] ? 255 : 0;
    gl.bindTexture(gl.TEXTURE_2D, this.solidTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.nx, this.ny, gl.RED, gl.UNSIGNED_BYTE, data);
  }

  reset() {
    const gl = this.gl;
    this.steps = 0;
    gl.viewport(0, 0, this.nx, this.ny);
    gl.useProgram(this.initProg);
    gl.bindVertexArray(this.vao);
    for (const b of this.bufs) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, b.fb);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    this.rho.fill(1);
    this.ux.fill(0);
    this.uy.fill(0);
  }

  inletSpeed() {
    const r = Math.min(1, this.steps / this.rampSteps);
    return this.u0 * (0.5 - 0.5 * Math.cos(Math.PI * r));
  }

  run(steps) {
    const gl = this.gl;
    const L = this.loc;
    gl.viewport(0, 0, this.nx, this.ny);
    gl.useProgram(this.stepProg);
    gl.bindVertexArray(this.vao);
    gl.uniform2i(L.N, this.nx, this.ny);
    gl.uniform1f(L.tau0, this.tau0);
    gl.uniform1f(L.smag, 18 * Math.SQRT2 * this.cs * this.cs);
    gl.uniform1i(L.T0, 0);
    gl.uniform1i(L.T1, 1);
    gl.uniform1i(L.T2, 2);
    gl.uniform1i(L.T3, 3);
    gl.uniform1i(L.S, 4);
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, this.solidTex);

    for (let s = 0; s < steps; s++) {
      const src = this.bufs[this.cur];
      const dst = this.bufs[1 - this.cur];
      for (let i = 0; i < 4; i++) {
        gl.activeTexture(gl.TEXTURE0 + i);
        gl.bindTexture(gl.TEXTURE_2D, src.texs[i]);
      }
      gl.uniform1f(L.uin, this.inletSpeed());
      gl.uniform1f(L.accum, s === 0 ? 0 : 1);
      gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fb);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      this.cur = 1 - this.cur;
      this.steps++;
    }

    // Read back macroscopic fields and the accumulated force.
    const fb = this.bufs[this.cur].fb;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fb);
    const buf = this._read;
    gl.readBuffer(gl.COLOR_ATTACHMENT3);
    gl.readPixels(0, 0, this.nx, this.ny, gl.RGBA, gl.FLOAT, buf);
    let fx = 0, fy = 0;
    for (let k = 0, j = 0; k < this.n; k++, j += 4) {
      fx += buf[j];
      fy += buf[j + 1];
    }
    this.fx = fx / steps;
    this.fy = fy / steps;
    gl.readBuffer(gl.COLOR_ATTACHMENT2);
    gl.readPixels(0, 0, this.nx, this.ny, gl.RGBA, gl.FLOAT, buf);
    const { rho, ux, uy, solid } = this;
    for (let k = 0, j = 0; k < this.n; k++, j += 4) {
      if (solid[k]) {
        rho[k] = 1;
        ux[k] = 0;
        uy[k] = 0;
      } else {
        rho[k] = buf[j + 1];
        ux[k] = buf[j + 2];
        uy[k] = buf[j + 3];
      }
    }
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
  }

  sample(px, py) {
    const { nx, ny, ux, uy } = this;
    if (px < 0 || py < 0 || px >= nx - 1 || py >= ny - 1) return [this.inletSpeed(), 0];
    const x0 = px | 0, y0 = py | 0;
    const tx = px - x0, ty = py - y0;
    const k = y0 * nx + x0;
    const a = (1 - tx) * (1 - ty), b = tx * (1 - ty), c = (1 - tx) * ty, d = tx * ty;
    return [
      ux[k] * a + ux[k + 1] * b + ux[k + nx] * c + ux[k + nx + 1] * d,
      uy[k] * a + uy[k + 1] * b + uy[k + nx] * c + uy[k + nx + 1] * d,
    ];
  }

  isFinite() {
    const { ux, n } = this;
    for (let k = 0; k < n; k += 97) if (!Number.isFinite(ux[k])) return false;
    return true;
  }
}
