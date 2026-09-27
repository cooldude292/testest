// D3Q19 lattice Boltzmann + Smagorinsky LES on WebGL2.
//
// The 3D grid is stored as a 2D "atlas": z-slices tiled across a texture.
// 19 populations live in 5 RGBA32F textures, the accumulated body force in a
// sixth. If the GPU can't write 6 targets at once we split each step into two
// passes that both do the full collision but write different textures.
//
// Flow enters at x = 0, leaves at x = NX-1. The four side walls are held at
// free-stream equilibrium (a moving floor, for cars, is the same thing).

export const E = [
  [0, 0, 0],
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
  [1, 1, 0], [-1, -1, 0], [1, -1, 0], [-1, 1, 0],
  [1, 0, 1], [-1, 0, -1], [1, 0, -1], [-1, 0, 1],
  [0, 1, 1], [0, -1, -1], [0, 1, -1], [0, -1, 1],
];
export const OPP = E.map(([x, y, z]) => E.findIndex(([a, b, c]) => a === -x && b === -y && c === -z));
const W = E.map((_, i) => (i === 0 ? 1 / 3 : i < 7 ? 1 / 18 : 1 / 36));

const VS = `#version 300 es
in vec2 pos;
void main() { gl_Position = vec4(pos, 0.0, 1.0); }`;

const glslArr = (type, arr) => `${type}[${arr.length}](${arr.join(', ')})`;

function header() {
  const ex = E.map((e) => `ivec3(${e.join(', ')})`);
  const w = W.map((v) => v.toFixed(10));
  return `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
const ivec3 E[19] = ${glslArr('ivec3', ex)};
const int OPP[19] = ${glslArr('int', OPP)};
const float W[19] = ${glslArr('float', w)};
uniform sampler2D T0, T1, T2, T3, T4, T5, S;
uniform ivec3 NN;
uniform int TX;
ivec2 atl(ivec3 p) { return ivec2((p.z % TX) * NN.x + p.x, (p.z / TX) * NN.y + p.y); }
vec4 tex(int t, ivec2 a) {
  if (t == 0) return texelFetch(T0, a, 0);
  if (t == 1) return texelFetch(T1, a, 0);
  if (t == 2) return texelFetch(T2, a, 0);
  if (t == 3) return texelFetch(T3, a, 0);
  return texelFetch(T4, a, 0);
}
float fpost(int i, ivec2 a) { int t = i / 4; return tex(t, a)[i - t * 4]; }
float feq(int i, float r, vec3 u) {
  float cu = dot(vec3(E[i]), u);
  return W[i] * r * (1.0 + 3.0 * cu + 4.5 * cu * cu - 1.5 * dot(u, u));
}
`;
}

// outputs: which state textures (0..5) this pass writes, in location order.
function stepShader(outputs) {
  const decl = outputs.map((t, loc) => `layout(location = ${loc}) out vec4 o${t};`).join('\n');
  const write = outputs
    .map((t) => {
      if (t === 5) return 'o5 = vec4(F, 0.0);';
      const idx = [0, 1, 2, 3].map((c) => t * 4 + c);
      return `o${t} = vec4(${idx.map((i) => (i < 19 ? `f[${i}]` : '0.0')).join(', ')});`;
    })
    .join('\n    ');
  return (
    header() +
    `${decl}
uniform float uin, tau0, smag, accum, ground;

void main() {
  ivec2 a = ivec2(gl_FragCoord.xy);
  int tx = a.x / NN.x, ty = a.y / NN.y;
  ivec3 p = ivec3(a.x - tx * NN.x, a.y - ty * NN.y, ty * TX + tx);
  float f[19];
  vec3 F = accum * texelFetch(T5, a, 0).xyz;
  if (p.z >= NN.z) {
    for (int i = 0; i < 19; i++) f[i] = 0.0;
    F = vec3(0.0);
    ${write}
    return;
  }
  float sv = texelFetch(S, a, 0).r;
  if (sv > 0.75) {
    for (int i = 0; i < 19; i++) f[i] = W[i];
    ${write}
    return;
  }
  if (p.x == 0 || (ground > 0.5 && p.y == 0)) {
    // Inlet, and the rolling road when there's a ground.
    for (int i = 0; i < 19; i++) f[i] = feq(i, 1.0, vec3(uin, 0.0, 0.0));
    ${write}
    return;
  }
  if (p.y == 0 || p.y == NN.y - 1 || p.z == 0 || p.z == NN.z - 1) {
    // Open sides: copy the neighbour just inside, so flow pushed aside by
    // the body can leave instead of being squeezed (tunnel blockage).
    ivec3 q = clamp(p, ivec3(0, 1, 1), NN - ivec3(1, 2, 2));
    ivec2 qa = atl(q);
    for (int i = 0; i < 19; i++) f[i] = fpost(i, qa);
    ${write}
    return;
  }
  if (p.x == NN.x - 1) {
    // Pressure outlet: density pinned to 1, velocity carried from upstream.
    ivec2 q = atl(p - ivec3(1, 0, 0));
    float rq = 0.0;
    vec3 uq = vec3(0.0);
    for (int i = 0; i < 19; i++) { float fi = fpost(i, q); rq += fi; uq += fi * vec3(E[i]); }
    uq /= max(rq, 0.2);
    for (int i = 0; i < 19; i++) f[i] = feq(i, 1.0, uq);
    ${write}
    return;
  }

  f[0] = fpost(0, a);
  if (sv < 0.25) {
    for (int i = 1; i < 19; i++) f[i] = fpost(i, atl(p - E[i]));
  } else {
    for (int i = 1; i < 19; i++) {
      ivec2 q = atl(p - E[i]);
      if (texelFetch(S, q, 0).r > 0.75) {
        float fo = fpost(OPP[i], a);
        f[i] = fo;
        F -= 2.0 * fo * vec3(E[i]);
      } else {
        f[i] = fpost(i, q);
      }
    }
  }

  float r = 0.0;
  vec3 u = vec3(0.0);
  for (int i = 0; i < 19; i++) { r += f[i]; u += f[i] * vec3(E[i]); }
  if (!(r > 0.2) || isnan(r)) r = 1.0;
  u /= r;
  if (any(isnan(u)) || length(u) > 0.4) u = vec3(uin, 0.0, 0.0);

  float pxx = 0.0, pyy = 0.0, pzz = 0.0, pxy = 0.0, pxz = 0.0, pyz = 0.0;
  float e[19];
  for (int i = 0; i < 19; i++) {
    e[i] = feq(i, r, u);
    float d = f[i] - e[i];
    vec3 c = vec3(E[i]);
    pxx += c.x * c.x * d; pyy += c.y * c.y * d; pzz += c.z * c.z * d;
    pxy += c.x * c.y * d; pxz += c.x * c.z * d; pyz += c.y * c.z * d;
  }
  float Q = sqrt(pxx * pxx + pyy * pyy + pzz * pzz + 2.0 * (pxy * pxy + pxz * pxz + pyz * pyz));
  // Sponge in front of the outlet soaks up the wake and pressure waves so
  // they don't bounce back up the tunnel.
  float sp = max(0.0, float(p.x - (NN.x - 16)) / 16.0);
  float t0 = tau0 + 0.4 * sp * sp;
  float tau = 0.5 * (t0 + sqrt(t0 * t0 + smag * Q / r));
  float om = 1.0 / tau;
  for (int i = 0; i < 19; i++) f[i] += om * (e[i] - f[i]);
  ${write}
}`
  );
}

const INIT_FS = (outputs) =>
  header() +
  `${outputs.map((t, loc) => `layout(location = ${loc}) out vec4 o${t};`).join('\n')}
void main() {
  ${outputs
    .map((t) => (t === 5 ? 'o5 = vec4(0.0);' : `o${t} = vec4(${[0, 1, 2, 3].map((c) => (t * 4 + c < 19 ? `W[${t * 4 + c}]` : '0.0')).join(', ')});`))
    .join('\n  ')}
}`;

// Half-resolution velocity + density, for streamlines and colouring.
const MACRO_FS =
  header() +
  `out vec4 o;
uniform ivec3 HN;
uniform int HTX;
void main() {
  ivec2 a = ivec2(gl_FragCoord.xy);
  int tx = a.x / HN.x, ty = a.y / HN.y;
  ivec3 h = ivec3(a.x - tx * HN.x, a.y - ty * HN.y, ty * HTX + tx);
  if (h.z >= HN.z) { o = vec4(0.0, 0.0, 0.0, 1.0); return; }
  ivec3 p = min(h * 2, NN - 1);
  ivec2 q = atl(p);
  if (texelFetch(S, q, 0).r > 0.75) { o = vec4(0.0, 0.0, 0.0, 1.0); return; }
  float r = 0.0;
  vec3 u = vec3(0.0);
  for (int i = 0; i < 19; i++) { float fi = fpost(i, q); r += fi; u += fi * vec3(E[i]); }
  o = vec4(u / max(r, 0.2), r);
}`;

// Sum the force texture along each atlas row.
const REDUCE_FS =
  header() +
  `out vec4 o;
uniform int AW;
void main() {
  int y = int(gl_FragCoord.y);
  vec3 s = vec3(0.0);
  for (int x = 0; x < 8192; x++) {
    if (x >= AW) break;
    s += texelFetch(T5, ivec2(x, y), 0).xyz;
  }
  o = vec4(s, 0.0);
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
    const name = gl.getActiveUniform(p, i).name;
    loc[name] = gl.getUniformLocation(p, name);
  }
  return { p, loc };
}

function tiling(nx, ny, nz) {
  // Pick a tile layout close to square.
  let best = null;
  for (let tx = 1; tx <= nz; tx++) {
    const ty = Math.ceil(nz / tx);
    const w = tx * nx, h = ty * ny;
    const score = Math.max(w, h);
    if (!best || score < best.score) best = { tx, ty, w, h, score };
  }
  return best;
}

export class Lbm3D {
  constructor(nx, ny, nz) {
    this.nx = nx;
    this.ny = ny;
    this.nz = nz;
    this.n = nx * ny * nz;
    this.u0 = 0.1;
    this.tau0 = 0.52;
    this.cs = 0.16;
    this.steps = 0;
    this.rampSteps = 500;
    this.force = [0, 0, 0];
    this.rhoRef = 1;
    this.ground = false;
    this.solid = new Uint8Array(this.n);

    const t = tiling(nx, ny, nz);
    this.tx = t.tx;
    this.aw = t.w;
    this.ah = t.h;
    this.hx = Math.ceil(nx / 2);
    this.hy = Math.ceil(ny / 2);
    this.hz = Math.ceil(nz / 2);
    const ht = tiling(this.hx, this.hy, this.hz);
    this.htx = ht.tx;
    this.haw = ht.w;
    this.hah = ht.h;
    const hn = this.hx * this.hy * this.hz;
    this.hux = new Float32Array(hn);
    this.huy = new Float32Array(hn);
    this.huz = new Float32Array(hn);
    this.hrho = new Float32Array(hn).fill(1);
    this._hread = new Float32Array(this.haw * this.hah * 4);
    this._fread = new Float32Array(this.ah * 4);

    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const gl = canvas.getContext('webgl2', { antialias: false, depth: false });
    if (!gl) throw new Error('WebGL2 not available');
    if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('No float render targets');
    const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    if (this.aw > maxTex || this.ah > maxTex) throw new Error('Grid too big for this GPU');
    this.gl = gl;
    this.canvas = canvas;

    const maxDB = gl.getParameter(gl.MAX_DRAW_BUFFERS);
    this.passes = maxDB >= 6 ? [[0, 1, 2, 3, 4, 5]] : [[0, 1, 2, 3], [4, 5]];
    this.stepProgs = this.passes.map((o) => program(gl, stepShader(o)));
    this.initProgs = this.passes.map((o) => program(gl, INIT_FS(o)));
    this.macroProg = program(gl, MACRO_FS);
    this.reduceProg = program(gl, REDUCE_FS);

    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    const tex = (w, h, internal, format, type, data = null) => {
      const tx = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tx);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, data);
      return tx;
    };
    const fbFor = (texs) => {
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      texs.forEach((t, i) => gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0));
      gl.drawBuffers(texs.map((_, i) => gl.COLOR_ATTACHMENT0 + i));
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Framebuffer incomplete');
      return fb;
    };
    this.bufs = [0, 1].map(() => {
      const texs = [0, 1, 2, 3, 4, 5].map(() => tex(this.aw, this.ah, gl.RGBA32F, gl.RGBA, gl.FLOAT));
      return { texs, fbs: this.passes.map((o) => fbFor(o.map((i) => texs[i]))) };
    });
    this.solidTex = tex(this.aw, this.ah, gl.R8, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array(this.aw * this.ah));
    this.macroTex = tex(this.haw, this.hah, gl.RGBA32F, gl.RGBA, gl.FLOAT);
    this.macroFb = fbFor([this.macroTex]);
    this.reduceTex = tex(1, this.ah, gl.RGBA32F, gl.RGBA, gl.FLOAT);
    this.reduceFb = fbFor([this.reduceTex]);
    this.cur = 0;
    this.reset();
  }

  get kind() {
    return 'GPU 3D';
  }

  setViscosity(nu) {
    this.tau0 = Math.max(0.5005, 3 * nu + 0.5);
  }

  get nu() {
    return (this.tau0 - 0.5) / 3;
  }

  inletSpeed() {
    const r = Math.min(1, this.steps / this.rampSteps);
    return this.u0 * (0.5 - 0.5 * Math.cos(Math.PI * r));
  }

  idx(x, y, z) {
    return x + this.nx * (y + this.ny * z);
  }

  setSolid(mask) {
    const { nx, ny, nz, gl } = this;
    this.solid.set(mask);
    const data = new Uint8Array(this.aw * this.ah);
    for (let z = 0; z < nz; z++) {
      const ox = (z % this.tx) * nx, oy = Math.floor(z / this.tx) * ny;
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
          const k = this.idx(x, y, z);
          let v = 0;
          if (mask[k]) v = 255;
          else if (x > 0 && y > 0 && z > 0 && x < nx - 1 && y < ny - 1 && z < nz - 1) {
            for (let i = 1; i < 19; i++) {
              if (mask[this.idx(x - E[i][0], y - E[i][1], z - E[i][2])]) {
                v = 128;
                break;
              }
            }
          }
          data[(oy + y) * this.aw + ox + x] = v;
        }
      }
    }
    gl.bindTexture(gl.TEXTURE_2D, this.solidTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.aw, this.ah, gl.RED, gl.UNSIGNED_BYTE, data);
  }

  bindState(src, prog) {
    const gl = this.gl;
    for (let i = 0; i < 6; i++) {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, src.texs[i]);
      if (prog.loc['T' + i]) gl.uniform1i(prog.loc['T' + i], i);
    }
    gl.activeTexture(gl.TEXTURE6);
    gl.bindTexture(gl.TEXTURE_2D, this.solidTex);
    if (prog.loc.S) gl.uniform1i(prog.loc.S, 6);
    if (prog.loc.NN) gl.uniform3i(prog.loc.NN, this.nx, this.ny, this.nz);
    if (prog.loc.TX) gl.uniform1i(prog.loc.TX, this.tx);
  }

  reset() {
    const gl = this.gl;
    this.steps = 0;
    gl.viewport(0, 0, this.aw, this.ah);
    gl.bindVertexArray(this.vao);
    for (const b of this.bufs) {
      this.passes.forEach((_, pi) => {
        const prog = this.initProgs[pi];
        gl.useProgram(prog.p);
        gl.bindFramebuffer(gl.FRAMEBUFFER, b.fbs[pi]);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      });
    }
    this.hux.fill(0);
    this.huy.fill(0);
    this.huz.fill(0);
    this.hrho.fill(1);
  }

  run(steps) {
    const gl = this.gl;
    gl.viewport(0, 0, this.aw, this.ah);
    gl.bindVertexArray(this.vao);
    const smag = 18 * Math.SQRT2 * this.cs * this.cs;
    for (let s = 0; s < steps; s++) {
      const src = this.bufs[this.cur];
      const dst = this.bufs[1 - this.cur];
      const uin = this.inletSpeed();
      this.passes.forEach((_, pi) => {
        const prog = this.stepProgs[pi];
        gl.useProgram(prog.p);
        this.bindState(src, prog);
        gl.uniform1f(prog.loc.uin, uin);
        gl.uniform1f(prog.loc.tau0, this.tau0);
        gl.uniform1f(prog.loc.smag, smag);
        gl.uniform1f(prog.loc.accum, s === 0 ? 0 : 1);
        gl.uniform1f(prog.loc.ground, this.ground ? 1 : 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbs[pi]);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      });
      this.cur = 1 - this.cur;
      this.steps++;
    }

    // Total force, averaged over the steps just taken.
    const st = this.bufs[this.cur];
    gl.useProgram(this.reduceProg.p);
    this.bindState(st, this.reduceProg);
    gl.uniform1i(this.reduceProg.loc.AW, this.aw);
    gl.viewport(0, 0, 1, this.ah);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.reduceFb);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.readPixels(0, 0, 1, this.ah, gl.RGBA, gl.FLOAT, this._fread);
    let fx = 0, fy = 0, fz = 0;
    for (let i = 0; i < this.ah; i++) {
      fx += this._fread[i * 4];
      fy += this._fread[i * 4 + 1];
      fz += this._fread[i * 4 + 2];
    }
    this.force = [fx / steps, fy / steps, fz / steps];
  }

  // Refresh the half-resolution velocity field on the CPU side.
  readField() {
    const gl = this.gl;
    const st = this.bufs[this.cur];
    gl.useProgram(this.macroProg.p);
    this.bindState(st, this.macroProg);
    gl.uniform3i(this.macroProg.loc.HN, this.hx, this.hy, this.hz);
    gl.uniform1i(this.macroProg.loc.HTX, this.htx);
    gl.viewport(0, 0, this.haw, this.hah);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.macroFb);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const buf = this._hread;
    gl.readPixels(0, 0, this.haw, this.hah, gl.RGBA, gl.FLOAT, buf);
    const { hx, hy, hz, htx, haw } = this;
    for (let z = 0; z < hz; z++) {
      const ox = (z % htx) * hx, oy = Math.floor(z / htx) * hy;
      for (let y = 0; y < hy; y++) {
        let j = ((oy + y) * haw + ox) * 4;
        let k = hx * (y + hy * z);
        for (let x = 0; x < hx; x++, j += 4, k++) {
          this.hux[k] = buf[j];
          this.huy[k] = buf[j + 1];
          this.huz[k] = buf[j + 2];
          this.hrho[k] = buf[j + 3];
        }
      }
    }
    // Free-stream density just past the inlet: the pressure reference.
    let sum = 0, n = 0;
    for (let z = 1; z < hz - 1; z++)
      for (let y = 1; y < hy - 1; y++) {
        sum += this.hrho[2 + hx * (y + hy * z)];
        n++;
      }
    this.rhoRef = n ? sum / n : 1;
  }

  // Trilinear sample of the half-res field at full-res cell coords.
  // Returns [ux, uy, uz, rho] into `out`.
  sample(x, y, z, out) {
    const { hx, hy, hz } = this;
    let px = x / 2, py = y / 2, pz = z / 2;
    if (px < 0) px = 0;
    if (py < 0) py = 0;
    if (pz < 0) pz = 0;
    if (px > hx - 1.001) px = hx - 1.001;
    if (py > hy - 1.001) py = hy - 1.001;
    if (pz > hz - 1.001) pz = hz - 1.001;
    const x0 = px | 0, y0 = py | 0, z0 = pz | 0;
    const tx = px - x0, ty = py - y0, tz = pz - z0;
    const sx = 1, sy = hx, sz = hx * hy;
    const k = x0 + sy * y0 + sz * z0;
    const w000 = (1 - tx) * (1 - ty) * (1 - tz), w100 = tx * (1 - ty) * (1 - tz);
    const w010 = (1 - tx) * ty * (1 - tz), w110 = tx * ty * (1 - tz);
    const w001 = (1 - tx) * (1 - ty) * tz, w101 = tx * (1 - ty) * tz;
    const w011 = (1 - tx) * ty * tz, w111 = tx * ty * tz;
    const f = (a) =>
      a[k] * w000 + a[k + sx] * w100 + a[k + sy] * w010 + a[k + sx + sy] * w110 +
      a[k + sz] * w001 + a[k + sx + sz] * w101 + a[k + sy + sz] * w011 + a[k + sx + sy + sz] * w111;
    out[0] = f(this.hux);
    out[1] = f(this.huy);
    out[2] = f(this.huz);
    out[3] = f(this.hrho);
    return out;
  }

  isSolid(x, y, z) {
    const xi = x | 0, yi = y | 0, zi = z | 0;
    if (xi < 0 || yi < 0 || zi < 0 || xi >= this.nx || yi >= this.ny || zi >= this.nz) return false;
    return this.solid[this.idx(xi, yi, zi)] === 1;
  }

  dispose() {
    const ext = this.gl.getExtension('WEBGL_lose_context');
    if (ext) ext.loseContext();
  }
}

// Voxelise a triangle soup already mapped into cell coordinates.
// Parity fill along X for closed shells, plus surface stamping so thin
// parts (fins, wings, flippers) don't fall through the grid.
export function voxelize(tris, nx, ny, nz) {
  const mask = new Uint8Array(nx * ny * nz);
  const idx = (x, y, z) => x + nx * (y + ny * z);
  const cols = new Map();
  for (let i = 0; i < tris.length; i += 9) {
    const ax = tris[i], ay = tris[i + 1], az = tris[i + 2];
    const bx = tris[i + 3], by = tris[i + 4], bz = tris[i + 5];
    const cx = tris[i + 6], cy = tris[i + 7], cz = tris[i + 8];
    // Column crossings (ray along +X through cell centres).
    const area = (by - ay) * (cz - az) - (cy - ay) * (bz - az);
    if (Math.abs(area) > 1e-12) {
      const y0 = Math.max(0, Math.ceil(Math.min(ay, by, cy) - 0.5));
      const y1 = Math.min(ny - 1, Math.floor(Math.max(ay, by, cy) - 0.5));
      const z0 = Math.max(0, Math.ceil(Math.min(az, bz, cz) - 0.5));
      const z1 = Math.min(nz - 1, Math.floor(Math.max(az, bz, cz) - 0.5));
      for (let gz = z0; gz <= z1; gz++) {
        const pz = gz + 0.5;
        for (let gy = y0; gy <= y1; gy++) {
          const py = gy + 0.5;
          const w0 = ((by - py) * (cz - pz) - (cy - py) * (bz - pz)) / area;
          const w1 = ((cy - py) * (az - pz) - (ay - py) * (cz - pz)) / area;
          const w2 = 1 - w0 - w1;
          if (w0 < 0 || w1 < 0 || w2 < 0) continue;
          const x = w0 * ax + w1 * bx + w2 * cx;
          const key = gy + ny * gz;
          let list = cols.get(key);
          if (!list) cols.set(key, (list = []));
          list.push(x);
        }
      }
    }
    // Surface stamp: mark cells whose centre lies within half a cell of the
    // triangle's plane, so thin parts survive without fattening the body.
    const e1 = Math.hypot(bx - ax, by - ay, bz - az);
    const e2 = Math.hypot(cx - ax, cy - ay, cz - az);
    const e3 = Math.hypot(cx - bx, cy - by, cz - bz);
    let nX = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
    let nY = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    let nZ = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const nl = Math.hypot(nX, nY, nZ) || 1;
    nX /= nl;
    nY /= nl;
    nZ /= nl;
    const n = Math.min(400, Math.ceil(Math.max(e1, e2, e3) / 0.35) + 1);
    for (let a = 0; a <= n; a++) {
      for (let b = 0; b <= n - a; b++) {
        const u = a / n, v = b / n, w = 1 - u - v;
        const px = u * ax + v * bx + w * cx, py = u * ay + v * by + w * cy, pz = u * az + v * bz + w * cz;
        const x = Math.floor(px), y = Math.floor(py), z = Math.floor(pz);
        if (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz) continue;
        const d = Math.abs((x + 0.5 - px) * nX + (y + 0.5 - py) * nY + (z + 0.5 - pz) * nZ);
        if (d < 0.5) mask[idx(x, y, z)] = 1;
      }
    }
  }
  for (const [key, xs] of cols) {
    if (xs.length < 2) continue;
    xs.sort((a, b) => a - b);
    const gy = key % ny, gz = (key / ny) | 0;
    for (let j = 0; j + 1 < xs.length; j += 2) {
      const from = Math.max(0, Math.ceil(xs[j] - 0.5));
      const to = Math.min(nx - 1, Math.floor(xs[j + 1] - 0.5));
      for (let gx = from; gx <= to; gx++) mask[idx(gx, gy, gz)] = 1;
    }
  }
  // Keep a layer of real fluid between the body and every boundary cell;
  // links into boundary cells aren't counted in the force, so a body
  // touching one would feel a pressure push with nothing opposing it.
  for (let z = 0; z < nz; z++)
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++)
        if (x < 3 || y < 2 || z < 2 || x > nx - 4 || y > ny - 3 || z > nz - 3) mask[idx(x, y, z)] = 0;
  return mask;
}
