# Lumen — Motion Studio

A motion graphics & compositing tool that runs entirely in your browser. Think After Effects, reimagined with a clean, Linear-style interface. Zero dependencies, zero build step — just open `index.html`.

![Lumen](https://img.shields.io/badge/dependencies-0-5e6ad2) ![Vanilla JS](https://img.shields.io/badge/vanilla-JS-4cb782)

## Running it

```sh
# option 1: just open it
open index.html

# option 2: serve it (recommended for importing large media)
npx http-server . -p 8080
```

Works best in Chrome / Edge / any Chromium browser (uses `canvas.captureStream` + `MediaRecorder` for video export).

## Features

**Layers** — text, solids, shapes (rect / ellipse / polygon / star), images, video, and adjustment layers that apply their effects to everything beneath them.

**Keyframe animation** — every transform property (position, scale, rotation, opacity, anchor point) is animatable. Click the stopwatch to enable animation; change a value and a keyframe drops at the playhead automatically. Per-keyframe easing: Linear, Ease In, Ease Out, Easy Ease, Hold (right-click a keyframe).

**Timeline** — scrubbing ruler, draggable layer bars with trim handles, expandable property tracks, draggable keyframes, keyframe navigators (◀ ◆ ▶), drag-to-reorder layers, frame-snapping everywhere, ctrl+wheel zoom.

**Viewport** — direct manipulation with transform gizmos: drag to move, corner handles to scale (Shift for non-uniform), rotation handle, anchor point indicator. Wheel to zoom, Alt-drag / middle-drag to pan.

**Effects** — Gaussian Blur, Brightness, Contrast, Saturation, Hue Rotate, Invert, Sepia, Drop Shadow. Stack as many as you like per layer; toggle or remove any of them.

**Compositing** — 17 blend modes (Multiply, Screen, Overlay, Add, Difference, …) and per-layer opacity.

**Export** — WebM video (VP9/VP8) rendered at full composition resolution, or PNG of the current frame.

**Projects** — save / load as `.lumen` files (JSON; imported images are embedded).

**Workflow** — full undo/redo, ⌘K command palette, drag-and-drop media import, layer splitting at the playhead, duplication, renaming, lock & solo visibility.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `Space` | Play / pause |
| `← / →` | Step one frame (`Shift` = 10) |
| `Home / End` | Jump to start / end |
| `⌘K` | Command palette |
| `⌘Z / ⇧⌘Z` | Undo / redo |
| `⌘D` | Duplicate layer |
| `⌘S / ⌘O` | Save / open project |
| `Delete` | Delete selected layer |
| `Esc` | Deselect / close overlays |

## Architecture

```
index.html        app shell
styles.css        Linear-inspired dark theme
js/core.js        data model, keyframe interpolation, cubic-bezier easing, undo history
js/renderer.js    canvas compositor: transforms, blend modes, CSS-filter effects, hit testing
js/timeline.js    timeline panel: ruler, bars, keyframes, reordering
js/viewport.js    comp view: pan/zoom, selection gizmos, direct manipulation
js/panels.js      project & properties panels, scrubbable inputs
js/app.js         playback engine, shortcuts, command palette, exporters
```

The renderer evaluates every animated property at time *t* (binary keyframe segments + cubic-bezier easing), draws each layer into an offscreen buffer with its transform, then composites with opacity, blend mode and filter stack. Adjustment layers snapshot the frame below and re-draw it filtered. Export replays the composition in real time into a `MediaRecorder` attached to an offscreen full-resolution canvas.

## Notes

- Video layers are best-effort: frames are seeked on scrub and played through during playback. Video sources are not embedded in saved project files (images are).
- Effects use canvas 2D filters, so rendering is GPU-accelerated where the browser supports it.
