// Copies the bits of three.js the app uses into src/vendor so the renderer
// can load them over file:// (Electron) or a static server, no bundler needed.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const three = path.join(root, 'node_modules', 'three');
const out = path.join(root, 'src', 'vendor', 'three');

const files = [
  'build/three.module.js',
  'build/three.core.js',
  'examples/jsm/controls/OrbitControls.js',
  'examples/jsm/loaders/GLTFLoader.js',
  'examples/jsm/loaders/STLLoader.js',
  'examples/jsm/loaders/OBJLoader.js',
  'examples/jsm/loaders/PLYLoader.js',
  'examples/jsm/utils/BufferGeometryUtils.js',
  'examples/jsm/utils/SkeletonUtils.js',
];

for (const f of files) {
  const src = path.join(three, f);
  const dst = path.join(out, f);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}
console.log(`vendored ${files.length} three.js files -> src/vendor/three`);
