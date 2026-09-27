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


const V2 = (pts) => pts.map(([x, y]) => new THREE.Vector2(x, y));

// Side profile (x along the car, y up) extruded across the width, centred.
function profile(pts, width, opts = {}) {
  const bevel = opts.bevel ?? 0.02;
  const geo = new THREE.ExtrudeGeometry(new THREE.Shape(V2(pts)), {
    depth: width - 2 * bevel,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 3,
    curveSegments: 4,
  });
  geo.translate(0, 0, -(width - 2 * bevel) / 2);
  return geo;
}

function wheel(r, w, pos, color = 0x1d1f24) {
  return part(new THREE.CylinderGeometry(r, r, w, 28), { pos, rot: [Math.PI / 2, 0, 0], color });
}

function sedan() {
  const parts = [
    part(
      profile(
        [[-0.5, 0.07], [0.49, 0.07], [0.5, 0.12], [0.5, 0.2], [0.47, 0.235], [0.36, 0.245], [-0.12, 0.235], [-0.3, 0.215], [-0.47, 0.19], [-0.5, 0.15]],
        0.39,
      ),
      { color: 0xc0392b },
    ),
    part(profile([[-0.16, 0.225], [0.38, 0.235], [0.22, 0.335], [0.02, 0.34]], 0.33, { bevel: 0.015 }), { color: 0x1b2430 }),
  ];
  for (const x of [-0.32, 0.31]) for (const z of [-0.165, 0.165]) parts.push(wheel(0.07, 0.06, [x, 0.07, z]));
  return mergeGeometries(parts);
}

function suv() {
  const parts = [
    part(profile([[-0.5, 0.1], [0.5, 0.1], [0.5, 0.31], [-0.25, 0.315], [-0.45, 0.3], [-0.5, 0.27]], 0.41, { bevel: 0.015 }), {
      color: 0x5d6b3a,
    }),
    part(profile([[-0.23, 0.31], [0.5, 0.31], [0.49, 0.44], [-0.16, 0.44]], 0.38, { bevel: 0.01 }), { color: 0x4f5c31 }),
    // roof rack, bumpers, spare tyre: the stuff that makes a Jeep a brick
    part(new THREE.BoxGeometry(0.5, 0.02, 0.3), { pos: [0.18, 0.465, 0], color: 0x222222 }),
    part(new THREE.BoxGeometry(0.04, 0.05, 0.42), { pos: [-0.51, 0.13, 0], color: 0x222222 }),
    part(new THREE.CylinderGeometry(0.085, 0.085, 0.06, 24), { pos: [0.53, 0.26, 0], rot: [0, 0, Math.PI / 2], color: 0x1d1f24 }),
  ];
  for (const x of [-0.31, 0.3]) for (const z of [-0.175, 0.175]) parts.push(wheel(0.095, 0.075, [x, 0.095, z]));
  return mergeGeometries(parts);
}

function f1() {
  const red = 0xd11f1f, dark = 0x1c1c1f;
  const parts = [
    part(profile([[-0.5, 0.045], [0.45, 0.04], [0.45, 0.09], [0.2, 0.14], [0.08, 0.19], [0.0, 0.15], [-0.2, 0.11], [-0.5, 0.07]], 0.12, { bevel: 0.02 }), { color: red }),
    part(new THREE.BoxGeometry(0.36, 0.07, 0.31), { pos: [0.08, 0.075, 0], color: red }),
    part(new THREE.SphereGeometry(0.035, 20, 12), { pos: [-0.03, 0.155, 0], color: 0xf2c200 }),
    // floor
    part(new THREE.BoxGeometry(0.62, 0.012, 0.34), { pos: [0.08, 0.035, 0], color: dark }),
    // front wing + endplates
    part(new THREE.BoxGeometry(0.1, 0.012, 0.37), { pos: [-0.47, 0.03, 0], rot: [0, 0, 0.06], color: dark }),
    part(new THREE.BoxGeometry(0.08, 0.01, 0.34), { pos: [-0.45, 0.055, 0], rot: [0, 0, 0.18], color: red }),
    part(new THREE.BoxGeometry(0.11, 0.05, 0.006), { pos: [-0.46, 0.045, 0.185], color: dark }),
    part(new THREE.BoxGeometry(0.11, 0.05, 0.006), { pos: [-0.46, 0.045, -0.185], color: dark }),
    // rear wing + endplates
    part(new THREE.BoxGeometry(0.08, 0.01, 0.2), { pos: [0.47, 0.16, 0], rot: [0, 0, -0.12], color: dark }),
    part(new THREE.BoxGeometry(0.06, 0.008, 0.2), { pos: [0.49, 0.185, 0], rot: [0, 0, -0.3], color: red }),
    part(new THREE.BoxGeometry(0.12, 0.12, 0.006), { pos: [0.48, 0.14, 0.1], color: dark }),
    part(new THREE.BoxGeometry(0.12, 0.12, 0.006), { pos: [0.48, 0.14, -0.1], color: dark }),
  ];
  for (const [x, r] of [[-0.3, 0.06], [0.33, 0.065]]) for (const z of [-0.155, 0.155]) parts.push(wheel(r, 0.07, [x, r, z]));
  return mergeGeometries(parts);
}

function shark() {
  // Spindle body from a lathe: t runs tail (0) to nose (1).
  const pts = [];
  for (let i = 0; i <= 40; i++) {
    const t = i / 40;
    const r = 0.105 * Math.pow(Math.sin(Math.PI * Math.pow(t, 0.75)), 0.75) + 0.006;
    pts.push(new THREE.Vector2(i === 0 || i === 40 ? 0 : r, t - 0.5));
  }
  const body = new THREE.LatheGeometry(pts, 32);
  const grey = 0x6d7f93;
  const fin = (shape, depth = 0.012) => {
    const g = new THREE.ExtrudeGeometry(new THREE.Shape(V2(shape)), { depth, bevelEnabled: false });
    g.translate(0, 0, -depth / 2);
    return g;
  };
  const parts = [
    part(body, { rot: [0, 0, Math.PI / 2], scale: [1, 1, 0.85], color: grey }),
    // dorsal
    part(fin([[0, 0], [0.16, 0], [0.12, 0.02], [0.05, 0.17]]), { pos: [-0.08, 0.07, 0], color: 0x5c6e82 }),
    // tail (heterocercal: big upper lobe)
    part(fin([[0, 0.01], [0.16, 0.21], [0.11, 0.03], [0.14, -0.12], [0, -0.01]]), { pos: [0.44, 0, 0], color: 0x5c6e82 }),
    // second dorsal + anal
    part(fin([[0, 0], [0.05, 0], [0.04, 0.035]]), { pos: [0.28, 0.035, 0], color: 0x5c6e82 }),
  ];
  for (const s of [-1, 1]) {
    parts.push(
      part(fin([[0, 0], [0.12, 0], [0.19, -0.02], [0.05, -0.02]], 0.01), {
        pos: [-0.16, -0.04, s * 0.07],
        rot: [s * -1.2, s * 0.35, 0],
        color: 0x5c6e82,
      }),
    );
  }
  return mergeGeometries(parts);
}

function airliner() {
  const white = 0xe8edf2, grey = 0x9aa7b8;
  const fus = new THREE.CapsuleGeometry(0.05, 0.86, 8, 24);
  const parts = [
    part(fus, { rot: [0, 0, Math.PI / 2], color: white }),
    part(new THREE.ConeGeometry(0.05, 0.12, 24), { pos: [0.49, 0.015, 0], rot: [0, 0, -Math.PI / 2], scale: [1, 1, 0.9], color: white }),
  ];
  const wingGeo = (span, root, tip, sweep, t = 0.012) => {
    const g = new THREE.ExtrudeGeometry(new THREE.Shape(V2([[0, 0], [root, 0], [sweep + tip, span], [sweep, span]])), {
      depth: t,
      bevelEnabled: false,
    });
    g.rotateX(Math.PI / 2);
    return g;
  };
  for (const s of [-1, 1]) {
    parts.push(part(wingGeo(0.46, 0.2, 0.06, 0.2), { pos: [-0.12, -0.02, 0], scale: [1, 1, s], color: grey }));
    parts.push(part(wingGeo(0.15, 0.09, 0.035, 0.08, 0.008), { pos: [0.38, 0.02, 0], scale: [1, 1, s], color: grey }));
    parts.push(
      part(new THREE.CylinderGeometry(0.022, 0.02, 0.09, 16), { pos: [-0.06, -0.05, s * 0.17], rot: [0, 0, Math.PI / 2], color: grey }),
    );
  }
  const fin = new THREE.ExtrudeGeometry(new THREE.Shape(V2([[0, 0], [0.13, 0], [0.16, 0.16], [0.1, 0.16]])), { depth: 0.01, bevelEnabled: false });
  parts.push(part(fin, { pos: [0.33, 0.04, -0.005], color: white }));
  return mergeGeometries(parts);
}

function cow() {
  // Spherical cows are a physics tradition; this one gets legs.
  const white = 0xf2f0ea, black = 0x1f1f1f, pink = 0xe8a8a0;
  const parts = [
    part(new THREE.SphereGeometry(1, 32, 20), { pos: [0, 0.34, 0], scale: [0.36, 0.16, 0.16], color: white }),
    part(new THREE.SphereGeometry(1, 16, 12), { pos: [0.05, 0.4, 0.11], scale: [0.12, 0.08, 0.06], color: black }),
    part(new THREE.SphereGeometry(1, 16, 12), { pos: [-0.14, 0.3, -0.12], scale: [0.1, 0.07, 0.05], color: black }),
    part(new THREE.BoxGeometry(0.16, 0.1, 0.1), { pos: [-0.42, 0.42, 0], rot: [0, 0, -0.4], color: white }),
    part(new THREE.BoxGeometry(0.07, 0.06, 0.09), { pos: [-0.49, 0.37, 0], rot: [0, 0, -0.4], color: pink }),
    part(new THREE.SphereGeometry(0.04, 12, 8), { pos: [0.08, 0.2, 0], color: pink }),
    part(new THREE.CylinderGeometry(0.01, 0.006, 0.25, 8), { pos: [0.37, 0.28, 0], rot: [0, 0, 0.25], color: white }),
  ];
  for (const s of [-1, 1]) {
    parts.push(part(new THREE.ConeGeometry(0.012, 0.06, 8), { pos: [-0.4, 0.49, s * 0.04], rot: [s * 0.6, 0, 0], color: 0xd8cfae }));
    parts.push(part(new THREE.BoxGeometry(0.03, 0.02, 0.05), { pos: [-0.38, 0.46, s * 0.07], color: white }));
    for (const x of [-0.23, 0.23]) {
      parts.push(part(new THREE.CylinderGeometry(0.03, 0.026, 0.24, 12), { pos: [x, 0.12, s * 0.09], color: white }));
      parts.push(part(new THREE.CylinderGeometry(0.03, 0.03, 0.03, 12), { pos: [x, 0.015, s * 0.09], color: black }));
    }
  }
  return mergeGeometries(parts);
}

// length (m), mass (kg), preferred fluid + speed, and whether it sits on the ground.
export const SHAPES = {
  turtle: { label: 'Sea turtle', length: 0.35, mass: 2.5, medium: 'sea', speed: 1, build: turtle },
  shark: { label: 'Shark', length: 2.5, mass: 170, medium: 'sea', speed: 2, build: shark },
  sedan: { label: 'Car: sedan', length: 4.7, mass: 1500, medium: 'air', speed: 30, ground: true, build: sedan },
  suv: { label: 'Car: SUV / Jeep', length: 4.6, mass: 2200, medium: 'air', speed: 30, ground: true, build: suv },
  f1: { label: 'Car: F1', length: 5.6, mass: 798, medium: 'air', speed: 80, ground: true, build: f1 },
  airliner: { label: 'Airliner', length: 38, mass: 65000, medium: 'air', speed: 75, build: airliner },
  cow: { label: 'Cow', length: 2.4, mass: 700, medium: 'air', speed: 20, ground: true, build: cow },
  wing: { label: 'Wing (NACA 2412)', length: 0.3, mass: 0.4, medium: 'air', speed: 20, build: () => naca('2412', 3) },
  sphere: {
    label: 'Sphere',
    length: 0.22,
    mass: 0.43,
    medium: 'air',
    speed: 10,
    build: () => part(new THREE.SphereGeometry(0.5, 64, 32), { color: 0xd9a441 }),
  },
  cylinder: {
    label: 'Cylinder (across flow)',
    length: 0.1,
    mass: 2,
    medium: 'air',
    speed: 10,
    build: () => part(new THREE.CylinderGeometry(0.5, 0.5, 3, 64), { rot: [Math.PI / 2, 0, 0], color: 0x9aa7b8 }),
  },
  plate: {
    label: 'Flat plate',
    length: 0.3,
    mass: 0.5,
    medium: 'air',
    speed: 10,
    build: () => part(new THREE.BoxGeometry(1, 0.03, 2), { color: 0xc07a5a }),
  },
};
