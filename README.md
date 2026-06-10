# Lumen — Motion Studio

A motion graphics & compositing studio that runs entirely in your browser. An After Effects alternative with a clean, Linear-style interface. Zero dependencies, zero build step — just open `index.html`.

![Lumen](https://img.shields.io/badge/dependencies-0-5e6ad2) ![Vanilla JS](https://img.shields.io/badge/vanilla-JS-4cb782)

## Running it

```sh
# option 1: just open it
open index.html

# option 2: serve it (recommended for large media)
npx http-server . -p 8080
```

Works best in Chrome / Edge / any Chromium browser (`canvas.captureStream`, `MediaRecorder`, WebAudio, EyeDropper).

## Core systems

- **Multiple compositions** — comp tabs above the timeline; create, rename, duplicate, delete. **Precompose** any selection into a nested comp; comp layers render recursively (cycle-safe) and honour time-stretch and reverse.
- **Layer parenting** — full transform-matrix chains. Pick any layer as a parent (cycle detection built in); children inherit position, rotation, and scale. Null objects included.
- **Keyframe animation everywhere** — transform properties *and every effect parameter* have stopwatches. Auto-keyframing on change, per-keyframe easing (Linear / Ease In / Ease Out / Easy Ease / Hold).
- **Graph editor** — per-property value curves with draggable keys (retime + revalue), per-component coloring, right-click easing, playhead scrubbing.
- **Masks** — rectangle/ellipse masks per layer with add/subtract modes and feather.
- **Track mattes** — alpha, alpha-inverted, luma, luma-inverted, using the layer above (auto-consumed like AE).
- **Expressions (modifiers)** — per-property **wiggle** (deterministic smooth noise, frequency/amplitude presets) and **loop** (cycle / pingpong), composable with keyframes.
- **Motion blur** — comp-level switch + per-layer toggle, multi-sample shutter rendering.
- **Audio** — import audio, waveforms drawn in the timeline, synced playback with per-layer volume, global mute, and audio **mixed into WebM exports** via WebAudio.
- **Adjustment layers** — apply effect stacks (filter *and* op-based) to everything below, optionally shaped by masks.
- **Time remapping basics** — per-layer time stretch (%) and reverse playback for media and nested comps.

## Effects (18, all parameters animatable)

Gaussian Blur · Brightness · Contrast · Saturation · Hue Rotate · Grayscale · Invert · Sepia · Drop Shadow · **Glow** · **Tint** · **Fill** · **Vignette** · **Noise** · **Pixelate** · **Chromatic Aberration** · **Linear Wipe** · **Circular Wipe**

Plus 17 blend modes (Multiply, Screen, Overlay, Add, Difference, …).

## The 99 details that make it feel right

**Timeline & keyframes**
1. Work area (B/N) with draggable handles, loops preview, scopes exports
2. Comp markers with labels (M to add)
3. Draggable markers, double-click to rename
4. Marker navigation (⇧, / ⇧.)
5. J/K — jump between keyframes & markers of the selected layer
6. I/O — jump to layer in/out point
7. `[` / `]` — trim layer in/out to playhead
8. ⌥←/→ — nudge layers in time by frames
9. Multi-select keyframes (shift-click)
10. Drag selected keyframes together
11. Click a property name to select all its keys
12. Copy/paste keyframes (relative offsets, pasted at playhead)
13. Easy ease selected keys (F9)
14. Reverse keyframes command
15. Sequence layers (auto-stagger end-to-end)
16. Effect group rows (ƒx) with parameter tracks in the timeline
17. Keyframe navigator per row (◀ ◆ ▶)
18. Per-property loop button (∞) cycling none → cycle → pingpong
19. Per-property wiggle button (∿) with preset menu
20. Per-property graph editor button
21. Double-click any track to drop a keyframe at that exact time
22. Frame-snapping on every drag
23. Ctrl+wheel timeline zoom around the cursor
24. Timeline auto-follows the playhead during playback
25. Layer search/filter box
26. Shy layers + hide-shy toggle
27. Solo layers
28. Layer label colors (8-color swatch menu)
29. Drag-to-reorder layers
30. Inline layer rename (double-click)
31. Audio waveforms rendered inside layer bars
32. Bar badges for matte/stretch/reversed states

**Layers & selection**
33. Multi-select layers (⌘/⇧-click), group-move in viewport and timeline
34. Select all (⌘A)
35. Copy/paste layers (⌘C/⌘V) with parent remapping
36. Copy/paste effect stacks between layers
37. Split layer at playhead
38. Duplicate (⌘D)
39. Pixel-nudge with arrow keys (⇧ = ×10)
40. P/S/R/T/A — reveal property in timeline with a highlight flash
41. Blend-mode cycling (⇧+ / ⇧−)
42. Flip horizontal / vertical
43. Center layer in comp
44. Fit layer to comp
45. Reset transform
46. Layer context menus in both timeline and viewport

**Viewport**
47. Motion paths drawn for animated position
48. Draggable motion-path keyframe points
49. Snap-to-center/edges while dragging, with magenta guide lines
50. Pan-behind tool (ctrl-drag moves the anchor without shifting the layer)
51. Grid overlay with center cross
52. Title/action-safe + rule-of-thirds overlay
53. Transparency checkerboard view
54. Preview resolution selector (full/half/quarter)
55. Live FPS meter during playback
56. Zoom presets menu (Fit/25/50/100/200%)
57. Wheel-zoom around the cursor, alt/middle-drag pan
58. Shift-drag for axis-constrained moves, shift-rotate snaps to 15°
59. Shift-scale for non-uniform scaling
60. Gizmos adapt to parented layers (work in parent space)
61. Dashed outlines for null/adjustment layers

**Text**
62. Typewriter reveal animator
63. Fade-per-character animator
64. Rise-per-character animator
65. Animator timing controls (start + duration)
66. Left/center/right alignment
67. Text stroke (outline) with color + width
68. All-caps toggle
69. Tracking and line-height controls

**Fills & color**
70. Linear gradient fills for solids and shapes
71. Radial gradient fills
72. Gradient angle control
73. Eyedropper screen color picking (EyeDropper API)
74. Transparent comp background (alpha-ready)

**Compositions**
75. Comp presets (1080p 30/60, 720p, 4K, square, vertical)
76. Comp tabs with rename/duplicate/delete (with in-use protection)
77. "Open" button jumps into a nested comp from its layer
78. Per-comp work area, markers, and motion-blur switch

**Export**
79. WebM with audio mixed in
80. PNG sequence export as .zip (built-in store-method ZIP writer)
81. Export scale (full/half/quarter resolution)
82. Export range: entire comp or work area
83. Current-frame PNG export
84. Copy frame to system clipboard
85. Live progress with timecode + cancel

**Playback**
86. Loop toggle
87. Playback speed (0.25×–2×)
88. Editable timecode field (accepts `1:30`, `2.5`, `f45`)
89. Global audio mute
90. ⇧←/→ for 10-frame steps

**Workflow**
91. Autosave to localStorage every 25s with restore prompt
92. Unsaved-changes dot in the window title + discard confirmation
93. Resizable panels (left/right/timeline) persisted across sessions
94. Tab hides side panels for a focused view
95. Keyboard shortcut cheat-sheet (?)
96. Command palette (⌘K) with 40+ context-aware commands
97. Load-demo command to get a working reference project back
98. Undo/redo across every operation above (100 steps)
99. Project files (.lumen) carry all comps, layers, keys, masks, mattes, markers — v1 files migrate automatically

## Keyboard shortcuts

Press `?` in the app for the full cheat sheet.

## Architecture

```
index.html        app shell
styles.css        Linear-inspired dark theme
js/core.js        data model, matrices, keyframe + modifier evaluation, history, audio engine
js/renderer.js    compositor: parent chains, masks, mattes, motion blur, nested comps, op-effects
js/timeline.js    timeline: ruler/work area/markers, bars, keyframe & effect-param tracks
js/viewport.js    comp view: gizmos, motion paths, snapping, overlays
js/panels.js      project & properties panels
js/app.js         playback, shortcuts, palette, graph editor, exporters, comp tabs
```

## Notes

- Video layers are best-effort (seek-on-scrub); video/audio sources are not embedded in saved project files (images are).
- Effects render through canvas 2D filters and compositing ops — GPU-accelerated where the browser supports it.
