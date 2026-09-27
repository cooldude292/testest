// Built-in test bodies. All are built nose toward -X (into the flow), Y up.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

function part(geo, { pos = [0, 0, 0], rot = [0, 0, 0], scale = [1, 1, 1], color = 0x888888 } = {}) {
  let g = geo.index ? geo.toNonIndexed() : geo;
  g.deleteAttribute('uv');
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(...pos),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(...rot)),
    new THREE.Vector3(...scale),
  );
  g.applyMatrix4(m);
  const c = new THREE.Color(color);
  const cols = new Float32Array(g.attributes.position.count * 3);
  for (let i = 0; i < cols.length; i += 3) {
    cols[i] = c.r;
    cols[i + 1] = c.g;
    cols[i + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(cols, 3));
  return g;
}

function turtle() {
  // Shell: a sphere squashed into a dome with a flatter belly.
  const shell = new THREE.SphereGeometry(1, 64, 32);
  const p = shell.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    // Slightly pointed at the back, like a real carapace.
    const taper = x > 0 ? 1 - 0.18 * x * x : 1;
    p.setXYZ(i, x * 0.46, y > 0 ? y * 0.2 : y * 0.075, z * 0.36 * taper);
  }
  shell.computeVertexNormals();
  // A thin rim (the marginal scutes) where dome meets belly.
  const rim = new THREE.TorusGeometry(1, 0.035, 10, 64);
  const shellColor = 0x5b7a3a;
  const skin = 0x8f9a6a;

  const parts = [
    part(shell, { color: shellColor }),
    part(rim, { rot: [Math.PI / 2, 0, 0], scale: [0.45, 0.35, 0.6], color: 0x4a6130 }),
    // Head + neck
    part(new THREE.SphereGeometry(1, 32, 16), { pos: [-0.56, 0.02, 0], scale: [0.1, 0.075, 0.08], color: skin }),
    part(new THREE.CylinderGeometry(0.055, 0.07, 0.16, 20), {
      pos: [-0.46, 0.0, 0],
      rot: [0, 0, Math.PI / 2 - 0.15],
      color: skin,
    }),
  ];
  // Front flippers: long, swept back.
  for (const s of [-1, 1]) {
    parts.push(
      part(new THREE.SphereGeometry(1, 32, 12), {
        pos: [-0.14, -0.03, s * 0.44],
        rot: [0, s * 0.6, s * -0.12],
        scale: [0.26, 0.022, 0.075],
        color: skin,
      }),
    );
    // Rear flippers: short paddles.
    parts.push(
      part(new THREE.SphereGeometry(1, 24, 10), {
        pos: [0.36, -0.04, s * 0.2],
        rot: [0, s * -0.5, 0],
        scale: [0.11, 0.02, 0.065],
        color: skin,
      }),
    );
  }
  // Tail
  parts.push(
    part(new THREE.ConeGeometry(0.03, 0.12, 12), { pos: [0.5, -0.02, 0], rot: [0, 0, -Math.PI / 2], color: skin }),
  );
  return mergeGeometries(parts);
}

function naca(code = '2412', span = 3) {
  const m = +code[0] / 100, pp = +code[1] / 10, t = +code.slice(2) / 100;
  const n = 80;
  const upper = [], lower = [];
  for (let i = 0; i <= n; i++) {
    const beta = (i / n) * Math.PI;
    const x = (1 - Math.cos(beta)) / 2;
    const yt = 5 * t * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1036 * x ** 4);
    let yc = 0, dy = 0;
    if (m > 0) {
      if (x < pp) {
        yc = (m / (pp * pp)) * (2 * pp * x - x * x);
        dy = ((2 * m) / (pp * pp)) * (pp - x);
      } else {
        yc = (m / ((1 - pp) ** 2)) * (1 - 2 * pp + 2 * pp * x - x * x);
        dy = ((2 * m) / ((1 - pp) ** 2)) * (pp - x);
      }
    }
    const th = Math.atan(dy);
    upper.push(new THREE.Vector2(x - yt * Math.sin(th), yc + yt * Math.cos(th)));
    lower.push(new THREE.Vector2(x + yt * Math.sin(th), yc - yt * Math.cos(th)));
  }
  const pts = [...upper.reverse(), ...lower.slice(1, -1)];
  const shape = new THREE.Shape(pts);
  const geo = new THREE.ExtrudeGeometry(shape, { depth: span, bevelEnabled: false, curveSegments: 1 });
  // Chord runs +X from the leading edge; move it so the leading edge faces -X.
  return mergeGeometries([part(geo, { pos: [-0.5, 0, -span / 2], color: 0xb8c4d6 })]);
}

export const SHAPES = {
  turtle: { label: 'Turtle', length: 0.35, mass: 2.5, build: turtle },
  sphere: { label: 'Sphere', length: 0.22, mass: 0.43, build: () => part(new THREE.SphereGeometry(0.5, 64, 32), { color: 0xd9a441 }) },
  cylinder: {
    label: 'Cylinder (across flow)',
    length: 0.1,
    mass: 2,
    build: () => part(new THREE.CylinderGeometry(0.5, 0.5, 3, 64), { rot: [Math.PI / 2, 0, 0], color: 0x9aa7b8 }),
  },
  wing: { label: 'Wing (NACA 2412)', length: 0.3, mass: 0.4, build: () => naca('2412', 3) },
  plate: {
    label: 'Flat plate',
    length: 0.3,
    mass: 0.5,
    build: () => part(new THREE.BoxGeometry(1, 0.03, 2), { color: 0xc07a5a }),
  },
};
