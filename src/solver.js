// D2Q9 lattice Boltzmann solver with a Smagorinsky LES closure.
//
// Flow enters on the left at speed u0 (lattice units), leaves on the right.
// Top and bottom are far-field (held at free-stream equilibrium). Solid cells
// use half-way bounce-back, and the force on the body comes from the
// momentum-exchange method, summed over every fluid/solid link each step.

export const EX = [0, 1, 0, -1, 0, 1, -1, -1, 1];
export const EY = [0, 0, 1, 0, -1, 1, 1, -1, -1];
export const W = [4 / 9, 1 / 9, 1 / 9, 1 / 9, 1 / 9, 1 / 36, 1 / 36, 1 / 36, 1 / 36];
const OPP = [0, 3, 4, 1, 2, 7, 8, 5, 6];

export class LBM {
  get kind() {
    return 'CPU';
  }

  constructor(nx, ny) {
    this.nx = nx;
    this.ny = ny;
    const n = nx * ny;
    this.n = n;
    this.f = new Float32Array(9 * n);
    this.g = new Float32Array(9 * n);
    this.rho = new Float32Array(n);
    this.ux = new Float32Array(n);
    this.uy = new Float32Array(n);
    this.solid = new Uint8Array(n);
    this.near = new Uint8Array(n);
    this.u0 = 0.1;
    this.tau0 = 0.52;
    this.cs = 0.16; // Smagorinsky constant
    this.fx = 0;
    this.fy = 0;
    this.steps = 0;
    this.rampSteps = 400;
    this.reset();
  }

  setViscosity(nu) {
    // tau = 3 nu + 1/2. Clamp so the bare BGK part never goes unstable;
    // the LES term adds eddy viscosity on top where the flow needs it.
    this.tau0 = Math.max(0.5005, 3 * nu + 0.5);
  }

  get nu() {
    return (this.tau0 - 0.5) / 3;
  }

  setSolid(mask) {
    this.solid.set(mask);
    const { nx, ny } = this;
    const near = (this.near = new Uint8Array(nx * ny));
    for (let y = 1; y < ny - 1; y++) {
      for (let x = 1; x < nx - 1; x++) {
        const k = y * nx + x;
        for (let i = 1; i < 9; i++) if (mask[k + EX[i] + EY[i] * nx]) near[k] = 1;
      }
    }
    // Solid cells carry no flow.
    const { n, f } = this;
    for (let k = 0; k < n; k++) {
      if (mask[k]) {
        for (let i = 0; i < 9; i++) f[i * n + k] = W[i];
        this.ux[k] = 0;
        this.uy[k] = 0;
        this.rho[k] = 1;
      }
    }
  }

  reset() {
    const { n, f } = this;
    this.steps = 0;
    for (let k = 0; k < n; k++) {
      for (let i = 0; i < 9; i++) f[i * n + k] = W[i];
      this.rho[k] = 1;
      this.ux[k] = 0;
      this.uy[k] = 0;
    }
  }

  inletSpeed() {
    const r = Math.min(1, this.steps / this.rampSteps);
    return this.u0 * (0.5 - 0.5 * Math.cos(Math.PI * r));
  }

  step() {
    const { nx, ny, n, solid, rho, ux, uy } = this;
    let f = this.f;
    let g = this.g;
    const tau0 = this.tau0;
    const smag = 18 * Math.SQRT2 * this.cs * this.cs;

    // ---- collide (in place) ----
    for (let k = 0; k < n; k++) {
      if (solid[k]) continue;
      const f0 = f[k], f1 = f[n + k], f2 = f[2 * n + k], f3 = f[3 * n + k], f4 = f[4 * n + k];
      const f5 = f[5 * n + k], f6 = f[6 * n + k], f7 = f[7 * n + k], f8 = f[8 * n + k];
      let r = f0 + f1 + f2 + f3 + f4 + f5 + f6 + f7 + f8;
      if (!(r > 0.2)) r = 1; // guard against blow-ups
      const ir = 1 / r;
      const u = (f1 - f3 + f5 - f6 - f7 + f8) * ir;
      const v = (f2 - f4 + f5 + f6 - f7 - f8) * ir;
      rho[k] = r;
      ux[k] = u;
      uy[k] = v;

      const usq = 1.5 * (u * u + v * v);
      const a = r * (4 / 9), b = r / 9, c = r / 36;
      const e0 = a * (1 - usq);
      const e1 = b * (1 + 3 * u + 4.5 * u * u - usq);
      const e2 = b * (1 + 3 * v + 4.5 * v * v - usq);
      const e3 = b * (1 - 3 * u + 4.5 * u * u - usq);
      const e4 = b * (1 - 3 * v + 4.5 * v * v - usq);
      const uv5 = u + v, uv6 = -u + v;
      const e5 = c * (1 + 3 * uv5 + 4.5 * uv5 * uv5 - usq);
      const e6 = c * (1 + 3 * uv6 + 4.5 * uv6 * uv6 - usq);
      const e7 = c * (1 - 3 * uv5 + 4.5 * uv5 * uv5 - usq);
      const e8 = c * (1 - 3 * uv6 + 4.5 * uv6 * uv6 - usq);

      // Non-equilibrium stress for the LES eddy viscosity.
      const d1 = f1 - e1, d2 = f2 - e2, d3 = f3 - e3, d4 = f4 - e4;
      const d5 = f5 - e5, d6 = f6 - e6, d7 = f7 - e7, d8 = f8 - e8;
      const pxx = d1 + d3 + d5 + d6 + d7 + d8;
      const pyy = d2 + d4 + d5 + d6 + d7 + d8;
      const pxy = d5 - d6 + d7 - d8;
      const q = Math.sqrt(pxx * pxx + pyy * pyy + 2 * pxy * pxy);
      const tau = 0.5 * (tau0 + Math.sqrt(tau0 * tau0 + smag * q * ir));
      const om = 1 / tau;

      f[k] = f0 + om * (e0 - f0);
      f[n + k] = f1 - om * d1;
      f[2 * n + k] = f2 - om * d2;
      f[3 * n + k] = f3 - om * d3;
      f[4 * n + k] = f4 - om * d4;
      f[5 * n + k] = f5 - om * d5;
      f[6 * n + k] = f6 - om * d6;
      f[7 * n + k] = f7 - om * d7;
      f[8 * n + k] = f8 - om * d8;
    }

    // ---- stream (pull) with bounce-back + momentum exchange ----
    // Most cells have no solid neighbour, so they take the unrolled fast path.
    const near = this.near;
    let fx = 0, fy = 0;
    const n2 = 2 * n, n3 = 3 * n, n4 = 4 * n, n5 = 5 * n, n6 = 6 * n, n7 = 7 * n, n8 = 8 * n;
    for (let y = 1; y < ny - 1; y++) {
      const row = y * nx;
      for (let x = 1; x < nx - 1; x++) {
        const k = row + x;
        if (solid[k]) continue;
        g[k] = f[k];
        if (!near[k]) {
          g[n + k] = f[n + k - 1];
          g[n2 + k] = f[n2 + k - nx];
          g[n3 + k] = f[n3 + k + 1];
          g[n4 + k] = f[n4 + k + nx];
          g[n5 + k] = f[n5 + k - 1 - nx];
          g[n6 + k] = f[n6 + k + 1 - nx];
          g[n7 + k] = f[n7 + k + 1 + nx];
          g[n8 + k] = f[n8 + k - 1 + nx];
          continue;
        }
        for (let i = 1; i < 9; i++) {
          const src = k - EX[i] - EY[i] * nx;
          if (solid[src]) {
            const fo = f[OPP[i] * n + k];
            g[i * n + k] = fo;
            fx -= 2 * fo * EX[i];
            fy -= 2 * fo * EY[i];
          } else {
            g[i * n + k] = f[i * n + src];
          }
        }
      }
    }

    // ---- boundaries ----
    const uin = this.inletSpeed();
    const setEq = (k, u, v) => {
      const usq = 1.5 * (u * u + v * v);
      for (let i = 0; i < 9; i++) {
        const cu = EX[i] * u + EY[i] * v;
        g[i * n + k] = W[i] * (1 + 3 * cu + 4.5 * cu * cu - usq);
      }
    };
    for (let y = 0; y < ny; y++) setEq(y * nx, uin, 0); // inlet
    for (let x = 1; x < nx; x++) {
      setEq(x, uin, 0); // bottom far-field
      setEq((ny - 1) * nx + x, uin, 0); // top far-field
    }
    for (let y = 1; y < ny - 1; y++) {
      // outlet: zero-gradient
      const k = y * nx + nx - 1;
      for (let i = 0; i < 9; i++) g[i * n + k] = g[i * n + k - 1];
    }

    this.f = g;
    this.g = f;
    this.fx = fx;
    this.fy = fy;
    this.steps++;
  }

  // Advance `steps` steps. fx/fy end up as the per-step average force.
  run(steps) {
    let fx = 0, fy = 0;
    for (let s = 0; s < steps; s++) {
      this.step();
      fx += this.fx;
      fy += this.fy;
    }
    this.fx = fx / steps;
    this.fy = fy / steps;
  }

  // Bilinear velocity sample (lattice units) at fractional cell coords.
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
