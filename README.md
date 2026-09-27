# FlowTunnel

A real-time wind tunnel, water tank and WiFi simulator for macOS. Drop in a 3D model (a turtle, a shark, a car, a cow), pick air or water, crank the speed, and watch glowing streamlines wrap around it live while it spits out drag, lift/downforce, buoyancy and vortex shedding numbers. Or draw your floor plan and see where your WiFi dies.

## Download

Grab the `.dmg` from [Releases](../../releases/latest), open it, drag **FlowTunnel** into Applications.

It isn't notarized by Apple, so macOS blocks the first launch. Fix it once, any of these:

- Right-click the app in Applications, **Open**, then **Open** again.
- System Settings > Privacy & Security > scroll down > **Open Anyway**.
- Terminal: `xattr -cr /Applications/FlowTunnel.app`

Universal build, runs on Apple Silicon and Intel.

## Three modes

- **3D wind tunnel**: full 3D fluid solve on the GPU. Animated streamlines coloured by speed (pulses travel at the real local flow speed), pressure painted on the body, optional speed slice plane, rolling-road ground for cars.
- **2D slice**: faster, higher-res 2D solve through a slice of the body with smoke, vorticity, pressure and particle views.
- **WiFi**: draw walls (drywall, brick, concrete, glass, wood, metal), drop up to 4 routers, pick 2.4 or 5 GHz. It solves Maxwell's equations on the plan in real time: signal heatmap in dBm, live wave view, coverage and dead-zone percentages, hover for signal at any spot.

Built-in bodies: sea turtle, shark, sedan, SUV/Jeep, F1 car, airliner, cow, NACA wing, sphere, cylinder, flat plate.

## What it does (flow modes)

- **Import any model**: STL, OBJ, GLB, PLY. Button or drag-and-drop. Auto-orients it (longest axis along the flow).
- **Fluids**: air, fresh water, sea water, or custom density + viscosity.
- **2D slice view** through the body: speed, pressure, vorticity, smoke streaks, particle tracers, velocity vectors. Hover anywhere to read local speed, pressure and spin in real units.
- **Side view** (lift) or **top view** (side force). **Silhouette** of the whole body or a **cross-section** at any depth.
- **Orientation**: pitch / angle of attack, yaw, roll, flip nose.
- **Numbers**: drag and lift coefficients, drag, lift/downforce and side force in newtons, power in watts and hp, L/D, power to hold position against the current, Reynolds number, vortex shedding frequency and Strouhal number.
- **Buoyancy**: volume from the mesh, buoyant force vs weight, floats/sinks verdict, % submerged, mass needed for neutral buoyancy, rough rise/sink speed. Checked against fresh and sea water too.
- **Export CSV** of the results and the force history.

## How it works (and where it's honest about limits)

3D mode: D3Q19 lattice Boltzmann + Smagorinsky LES on the GPU (WebGL2). The model is voxelised into the grid; forces come from momentum exchange at the body surface.

2D mode: D2Q9 version of the same thing (CPU fallback if the GPU path isn't available). Its 3D force estimates apply the slice's coefficients to the body's real frontal/planform area.

WiFi mode: 2D FDTD (Yee scheme) at the real frequency, walls from ITU-R P.2040 material data, metal as a perfect conductor, absorbing border. Because it's a 2D slice of the floor, waves spread as 1/r; the extra 1/r of real 3D spreading is folded back in when converting to dBm (calibrated to about -40 dBm at 1 m from the router). The heatmap is averaged over half a wavelength, like a real multi-antenna radio sees it.

For the flow modes: the lattice also can't hit real-world Reynolds numbers of 10^5 to 10^6, so it runs as high as it stably can and lets the turbulence model handle the rest; the app shows both numbers. Sanity check: a cylinder gives Strouhal ≈ 0.22 (textbook ~0.2). 2D drag at high Re runs high compared with real 3D bodies, which is a known 2D thing.

The 3D grid is coarse next to a real CFD mesh (a car is ~35-60 cells long), so small details like mirrors get lost.

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
src/lbm3d.js       WebGL2 3D lattice Boltzmann (D3Q19) + voxeliser
src/tunnel3d.js    3D tunnel: streamlines, slice plane, surface pressure
src/wifi.js        WebGL2 FDTD WiFi solver + floor plan
src/solver-gpu.js  WebGL2 2D lattice Boltzmann solver
src/solver.js      CPU version of the 2D solver (fallback)
src/geometry.js    mesh volume/area, slicing, rasterising onto the grid
src/shapes.js      built-in models (turtle, shark, cars, plane, cow...)
scripts/vendor.js  copies three.js into src/vendor
```
