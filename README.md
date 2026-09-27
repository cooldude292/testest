# FlowTunnel

A real-time wind tunnel and water tank for macOS. Drop in a 3D model (a turtle, say), pick air or water, crank the speed, and watch the flow wrap around it live while it spits out drag, lift, buoyancy and vortex shedding numbers.

## Download

Grab the `.dmg` from [Releases](../../releases/latest), open it, drag **FlowTunnel** into Applications.

It isn't notarized by Apple, so macOS blocks the first launch. Fix it once, any of these:

- Right-click the app in Applications, **Open**, then **Open** again.
- System Settings > Privacy & Security > scroll down > **Open Anyway**.
- Terminal: `xattr -cr /Applications/FlowTunnel.app`

Universal build, runs on Apple Silicon and Intel.

## What it does

- **Import any model**: STL, OBJ, GLB, PLY. Button or drag-and-drop. Auto-orients it (longest axis along the flow). Built-ins: turtle, sphere, cylinder, NACA 2412 wing, flat plate.
- **Fluids**: air, fresh water, sea water, or custom density + viscosity.
- **Live flow field** on a slice through the body: speed, pressure, vorticity, smoke streaks, particle tracers, velocity vectors. Hover anywhere to read local speed, pressure and spin in real units.
- **Side view** (lift) or **top view** (side force). **Silhouette** of the whole body or a **cross-section** at any depth.
- **Orientation**: pitch / angle of attack, yaw, roll, flip nose.
- **Numbers**: drag and lift coefficients, drag and lift in newtons, L/D, power to hold position against the current, Reynolds number, vortex shedding frequency and Strouhal number.
- **Buoyancy**: volume from the mesh, buoyant force vs weight, floats/sinks verdict, % submerged, mass needed for neutral buoyancy, rough rise/sink speed. Checked against fresh and sea water too.
- **3D view** of the model with the live slice cutting through it.
- **Export CSV** of the results and the force history.

## How it works (and where it's honest about limits)

The flow is solved with a D2Q9 lattice Boltzmann method plus a Smagorinsky LES turbulence model, on the GPU via WebGL2 (CPU fallback if the GPU path isn't available). Forces come from momentum exchange at the body surface.

It's a **2D slice**, not a full 3D solve. The 3D force estimates apply the slice's coefficients to the body's real frontal/planform area. The lattice also can't hit real-world Reynolds numbers of 10^5 to 10^6, so it runs as high as it stably can and lets the turbulence model handle the rest; the app shows both numbers. Sanity check: a cylinder gives Strouhal ≈ 0.22 (textbook ~0.2). 2D drag at high Re runs high compared with real 3D bodies, which is a known 2D thing.

So: great for comparing shapes, angles, fluids and seeing what the flow does. Don't use it to certify an aircraft.

## Develop

```sh
npm install
npm start          # run the Electron app
npm run serve      # or run it in a browser at http://localhost:8080
```

The `.dmg` is built by GitHub Actions on a macOS runner (`.github/workflows/release.yml`) and published to Releases on every push.

## Layout

```
main.js            Electron main process
src/index.html     UI
src/app.js         app logic, rendering, 3D view, stats
src/solver-gpu.js  WebGL2 lattice Boltzmann solver
src/solver.js      CPU version of the same solver (fallback)
src/geometry.js    mesh volume/area, slicing, rasterising onto the grid
src/shapes.js      built-in models (the turtle lives here)
scripts/vendor.js  copies three.js into src/vendor
```
