// Triangle-soup helpers: pull triangles out of three.js objects, normalise
// them, measure them, and rasterise them onto the solver grid.
//
// A "soup" is a Float32Array with 9 floats per triangle (x,y,z for 3 verts).

export function soupFromObject(root, THREE) {
  const chunks = [];
  let total = 0;
  root.updateMatrixWorld(true);
  const v = new THREE.Vector3();
  root.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    const geo = o.geometry;
    const pos = geo.attributes.position;
    if (!pos) return;
    const idx = geo.index;
    const triCount = idx ? idx.count / 3 : pos.count / 3;
    const out = new Float32Array(triCount * 9);
    for (let t = 0; t < triCount; t++) {
      for (let j = 0; j < 3; j++) {
        const vi = idx ? idx.getX(t * 3 + j) : t * 3 + j;
        v.fromBufferAttribute(pos, vi).applyMatrix4(o.matrixWorld);
        out[t * 9 + j * 3] = v.x;
        out[t * 9 + j * 3 + 1] = v.y;
        out[t * 9 + j * 3 + 2] = v.z;
      }
    }
    chunks.push(out);
    total += out.length;
  });
  const soup = new Float32Array(total);
  let o = 0;
  for (const c of chunks) {
    soup.set(c, o);
    o += c.length;
  }
  return soup;
}

export function bounds(soup) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < soup.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const val = soup[i + a];
      if (val < min[a]) min[a] = val;
      if (val > max[a]) max[a] = val;
    }
  }
  return { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] };
}

// Centre on the bounding box and scale so the length along X (the flow
// direction) is 1. Returns a new array.
export function normalise(soup) {
  const b = bounds(soup);
  const cx = (b.min[0] + b.max[0]) / 2;
  const cy = (b.min[1] + b.max[1]) / 2;
  const cz = (b.min[2] + b.max[2]) / 2;
  const s = 1 / (b.size[0] || Math.max(...b.size) || 1);
  const out = new Float32Array(soup.length);
  for (let i = 0; i < soup.length; i += 3) {
    out[i] = (soup[i] - cx) * s;
    out[i + 1] = (soup[i + 1] - cy) * s;
    out[i + 2] = (soup[i + 2] - cz) * s;
  }
  return out;
}

// Apply a 3x3 row-major matrix.
export function transform(soup, m) {
  const out = new Float32Array(soup.length);
  for (let i = 0; i < soup.length; i += 3) {
    const x = soup[i], y = soup[i + 1], z = soup[i + 2];
    out[i] = m[0] * x + m[1] * y + m[2] * z;
    out[i + 1] = m[3] * x + m[4] * y + m[5] * z;
    out[i + 2] = m[6] * x + m[7] * y + m[8] * z;
  }
  return out;
}

export function volume(soup) {
  let v = 0;
  for (let i = 0; i < soup.length; i += 9) {
    const ax = soup[i], ay = soup[i + 1], az = soup[i + 2];
    const bx = soup[i + 3], by = soup[i + 4], bz = soup[i + 5];
    const cx = soup[i + 6], cy = soup[i + 7], cz = soup[i + 8];
    v += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return Math.abs(v / 6);
}

export function surfaceArea(soup) {
  let s = 0;
  for (let i = 0; i < soup.length; i += 9) {
    const ux = soup[i + 3] - soup[i], uy = soup[i + 4] - soup[i + 1], uz = soup[i + 5] - soup[i + 2];
    const vx = soup[i + 6] - soup[i], vy = soup[i + 7] - soup[i + 1], vz = soup[i + 8] - soup[i + 2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    s += Math.sqrt(cx * cx + cy * cy + cz * cz) / 2;
  }
  return s;
}

// Rasterise the projection of every triangle onto the plane spanned by
// axes (ia, ib). Grid cell (gx, gy) covers a = (gx - ox)/scale etc.
// Cell centres inside any triangle become solid.
export function rasterSilhouette(soup, ia, ib, nx, ny, ox, oy, scale, signB = 1) {
  const mask = new Uint8Array(nx * ny);
  for (let i = 0; i < soup.length; i += 9) {
    const x0 = ox + soup[i + ia] * scale, y0 = oy + signB * soup[i + ib] * scale;
    const x1 = ox + soup[i + 3 + ia] * scale, y1 = oy + signB * soup[i + 3 + ib] * scale;
    const x2 = ox + soup[i + 6 + ia] * scale, y2 = oy + signB * soup[i + 6 + ib] * scale;
    fillTri(mask, nx, ny, x0, y0, x1, y1, x2, y2);
  }
  fillHoles(mask, nx, ny);
  return mask;
}

function fillTri(mask, nx, ny, x0, y0, x1, y1, x2, y2) {
  const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
  if (Math.abs(area) < 1e-9) {
    // Edge-on triangle: stamp its vertices so thin shells don't vanish.
    stamp(mask, nx, ny, x0, y0);
    stamp(mask, nx, ny, x1, y1);
    stamp(mask, nx, ny, x2, y2);
    return;
  }
  const s = area > 0 ? 1 : -1;
  const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2)));
  const maxX = Math.min(nx - 1, Math.ceil(Math.max(x0, x1, x2)));
  const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2)));
  const maxY = Math.min(ny - 1, Math.ceil(Math.max(y0, y1, y2)));
  const eps = -1e-6;
  for (let gy = minY; gy <= maxY; gy++) {
    const py = gy + 0.5;
    for (let gx = minX; gx <= maxX; gx++) {
      const px = gx + 0.5;
      const w0 = s * ((x1 - px) * (y2 - py) - (x2 - px) * (y1 - py));
      if (w0 < eps) continue;
      const w1 = s * ((x2 - px) * (y0 - py) - (x0 - px) * (y2 - py));
      if (w1 < eps) continue;
      const w2 = s * ((x0 - px) * (y1 - py) - (x1 - px) * (y0 - py));
      if (w2 < eps) continue;
      mask[gy * nx + gx] = 1;
    }
  }
}

function stamp(mask, nx, ny, x, y) {
  const gx = Math.floor(x), gy = Math.floor(y);
  if (gx >= 0 && gy >= 0 && gx < nx && gy < ny) mask[gy * nx + gx] = 1;
}

// Cross-section: intersect with the plane (axis ic == value), then fill the
// outline row by row with even-odd parity.
export function rasterSection(soup, ia, ib, ic, value, nx, ny, ox, oy, scale, signB = 1) {
  const segs = [];
  for (let i = 0; i < soup.length; i += 9) {
    const d0 = soup[i + ic] - value, d1 = soup[i + 3 + ic] - value, d2 = soup[i + 6 + ic] - value;
    const pts = [];
    const edge = (a, da, b, db) => {
      if ((da > 0) === (db > 0)) return;
      const t = da / (da - db);
      pts.push(
        ox + (soup[a + ia] + t * (soup[b + ia] - soup[a + ia])) * scale,
        oy + signB * (soup[a + ib] + t * (soup[b + ib] - soup[a + ib])) * scale,
      );
    };
    edge(i, d0, i + 3, d1);
    edge(i + 3, d1, i + 6, d2);
    edge(i + 6, d2, i, d0);
    if (pts.length === 4) segs.push(pts);
  }
  const mask = new Uint8Array(nx * ny);
  const xs = [];
  for (let gy = 0; gy < ny; gy++) {
    const py = gy + 0.5;
    xs.length = 0;
    for (const s of segs) {
      const [ax, ay, bx, by] = s;
      if ((ay > py) === (by > py)) continue;
      xs.push(ax + ((py - ay) / (by - ay)) * (bx - ax));
    }
    if (xs.length < 2) continue;
    xs.sort((a, b) => a - b);
    for (let j = 0; j + 1 < xs.length; j += 2) {
      const from = Math.max(0, Math.ceil(xs[j] - 0.5));
      const to = Math.min(nx - 1, Math.floor(xs[j + 1] - 0.5));
      for (let gx = from; gx <= to; gx++) mask[gy * nx + gx] = 1;
    }
  }
  fillHoles(mask, nx, ny);
  return mask;
}

// Any fluid region not connected to the domain edge is sealed inside the
// body, so make it solid.
export function fillHoles(mask, nx, ny) {
  const seen = new Uint8Array(nx * ny);
  const stack = [];
  const push = (k) => {
    if (!seen[k] && !mask[k]) {
      seen[k] = 1;
      stack.push(k);
    }
  };
  for (let x = 0; x < nx; x++) {
    push(x);
    push((ny - 1) * nx + x);
  }
  for (let y = 0; y < ny; y++) {
    push(y * nx);
    push(y * nx + nx - 1);
  }
  while (stack.length) {
    const k = stack.pop();
    const x = k % nx;
    if (x > 0) push(k - 1);
    if (x < nx - 1) push(k + 1);
    if (k >= nx) push(k - nx);
    if (k < nx * (ny - 1)) push(k + nx);
  }
  for (let k = 0; k < nx * ny; k++) if (!seen[k]) mask[k] = 1;
}

// Projected area (in model units^2) of the soup looking down `axis`.
export function projectedArea(soup, axis, res = 256) {
  const ia = axis === 0 ? 1 : 0;
  const ib = axis === 2 ? 1 : 2;
  const b = bounds(soup);
  const span = Math.max(b.size[ia], b.size[ib]) || 1;
  const scale = (res - 4) / span;
  const ox = 2 - b.min[ia] * scale;
  const oy = 2 - b.min[ib] * scale;
  const mask = rasterSilhouette(soup, ia, ib, res, res, ox, oy, scale);
  let c = 0;
  for (let k = 0; k < mask.length; k++) c += mask[k];
  return c / (scale * scale);
}

export function maskExtent(mask, nx, ny) {
  let minX = nx, maxX = -1, minY = ny, maxY = -1, count = 0;
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      if (!mask[y * nx + x]) continue;
      count++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (count === 0) return { count, w: 0, h: 0, minX: 0, maxX: 0, minY: 0, maxY: 0 };
  return { count, w: maxX - minX + 1, h: maxY - minY + 1, minX, maxX, minY, maxY };
}

// Row-major 3x3 rotation from roll (about X), yaw (about Y), pitch (about Z),
// applied in that order. Pitch is nose-up positive for a body whose nose
// points toward -X (into the oncoming flow).
export function rotationMatrix(rollDeg, yawDeg, pitchDeg) {
  const r = (rollDeg * Math.PI) / 180, y = (yawDeg * Math.PI) / 180, p = (-pitchDeg * Math.PI) / 180;
  const Rx = [1, 0, 0, 0, Math.cos(r), -Math.sin(r), 0, Math.sin(r), Math.cos(r)];
  const Ry = [Math.cos(y), 0, Math.sin(y), 0, 1, 0, -Math.sin(y), 0, Math.cos(y)];
  const Rz = [Math.cos(p), -Math.sin(p), 0, Math.sin(p), Math.cos(p), 0, 0, 0, 1];
  return mul(Rz, mul(Ry, Rx));
}

export function mul(a, b) {
  const o = new Array(9);
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      o[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  return o;
}
