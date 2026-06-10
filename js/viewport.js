/* ─── Lumen viewport: comp view + transform gizmos ─────────────── */
"use strict";

const Viewport = (() => {
  let canvas, ctx, wrap;
  let compCanvas = document.createElement("canvas");
  let compCtx = compCanvas.getContext("2d");
  let view = { scale: 1, ox: 0, oy: 0, fitted: true };
  let dirty = true;
  const HANDLE = 7;

  function requestDraw() { dirty = true; }

  function fit() {
    const c = App.comp;
    const pad = 48;
    const s = Math.min((canvas.clientWidth - pad) / c.width, (canvas.clientHeight - pad) / c.height);
    view.scale = clamp(s, 0.02, 8);
    view.ox = (canvas.clientWidth - c.width * view.scale) / 2;
    view.oy = (canvas.clientHeight - c.height * view.scale) / 2;
    view.fitted = true;
    updateZoomLabel();
    requestDraw();
  }

  function setZoom(s, cx, cy) {
    // zoom around screen point (cx, cy)
    if (cx === undefined) { cx = canvas.clientWidth / 2; cy = canvas.clientHeight / 2; }
    const [wx, wy] = screenToComp(cx, cy);
    view.scale = clamp(s, 0.02, 8);
    view.ox = cx - wx * view.scale;
    view.oy = cy - wy * view.scale;
    view.fitted = false;
    updateZoomLabel();
    requestDraw();
  }

  function updateZoomLabel() {
    const el = document.getElementById("zoom-label");
    if (el) el.textContent = view.fitted ? "Fit" : Math.round(view.scale * 100) + "%";
  }

  const screenToComp = (sx, sy) => [(sx - view.ox) / view.scale, (sy - view.oy) / view.scale];
  const compToScreen = (wx, wy) => [wx * view.scale + view.ox, wy * view.scale + view.oy];

  /* ── drawing ── */
  function draw() {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr; canvas.height = h * dpr;
      if (view.fitted) fit();
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const c = App.comp;
    if (compCanvas.width !== c.width || compCanvas.height !== c.height) {
      compCanvas.width = c.width; compCanvas.height = c.height;
    }
    Renderer.draw(compCtx, App.time);

    // comp frame shadow + canvas
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.6)";
    ctx.shadowBlur = 30;
    ctx.fillStyle = "#000";
    ctx.fillRect(view.ox, view.oy, c.width * view.scale, c.height * view.scale);
    ctx.restore();

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(compCanvas, view.ox, view.oy, c.width * view.scale, c.height * view.scale);
    ctx.strokeStyle = "#26282d";
    ctx.lineWidth = 1;
    ctx.strokeRect(view.ox - 0.5, view.oy - 0.5, c.width * view.scale + 1, c.height * view.scale + 1);

    drawGizmo();
  }

  function drawGizmo() {
    const layer = App.selectedLayer();
    if (!layer || layer.type === "null" || !Renderer.isActive(layer, App.time)) return;
    const pts = Renderer.corners(layer, App.time).map(([x, y]) => compToScreen(x, y));
    const tr = Renderer.evalT(layer, App.time);
    const [ax, ay] = compToScreen(tr.pos[0], tr.pos[1]);

    ctx.save();
    ctx.strokeStyle = "#7c89f0";
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    pts.forEach(([x, y], i) => i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y));
    ctx.closePath();
    ctx.stroke();

    // rotation handle: stick from top edge midpoint
    const tm = [(pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2];
    const dir = [tm[0] - ax, tm[1] - ay];
    const len = Math.hypot(dir[0], dir[1]) || 1;
    const rh = [tm[0] + (dir[0] / len) * 22, tm[1] + (dir[1] / len) * 22];
    ctx.beginPath();
    ctx.moveTo(tm[0], tm[1]);
    ctx.lineTo(rh[0], rh[1]);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(rh[0], rh[1], 4.5, 0, Math.PI * 2);
    ctx.fillStyle = "#0f1011";
    ctx.fill();
    ctx.stroke();

    // corner handles
    pts.forEach(([x, y]) => {
      ctx.fillStyle = "#0f1011";
      ctx.strokeStyle = "#7c89f0";
      ctx.fillRect(x - HANDLE / 2, y - HANDLE / 2, HANDLE, HANDLE);
      ctx.strokeRect(x - HANDLE / 2, y - HANDLE / 2, HANDLE, HANDLE);
    });

    // anchor cross
    ctx.strokeStyle = "#7c89f0";
    ctx.beginPath();
    ctx.arc(ax, ay, 4, 0, Math.PI * 2);
    ctx.moveTo(ax - 8, ay); ctx.lineTo(ax + 8, ay);
    ctx.moveTo(ax, ay - 8); ctx.lineTo(ax, ay + 8);
    ctx.stroke();
    ctx.restore();

    return { pts, rh, ax, ay };
  }

  /* compute handle hit info without drawing */
  function gizmoHit(sx, sy) {
    const layer = App.selectedLayer();
    if (!layer || layer.type === "null" || !Renderer.isActive(layer, App.time)) return null;
    const pts = Renderer.corners(layer, App.time).map(([x, y]) => compToScreen(x, y));
    const tr = Renderer.evalT(layer, App.time);
    const [ax, ay] = compToScreen(tr.pos[0], tr.pos[1]);
    const tm = [(pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2];
    const dir = [tm[0] - ax, tm[1] - ay];
    const len = Math.hypot(dir[0], dir[1]) || 1;
    const rh = [tm[0] + (dir[0] / len) * 22, tm[1] + (dir[1] / len) * 22];

    if (Math.hypot(sx - rh[0], sy - rh[1]) < 8) return { type: "rotate", layer };
    for (let i = 0; i < 4; i++) {
      if (Math.abs(sx - pts[i][0]) < HANDLE && Math.abs(sy - pts[i][1]) < HANDLE)
        return { type: "scale", corner: i, layer };
    }
    return null;
  }

  /* ── interactions ── */
  function onPointerDown(e) {
    if (e.button === 1 || (e.button === 0 && e.altKey)) {
      // pan
      const ox0 = view.ox, oy0 = view.oy;
      startDrag(e, {
        cursor: "grabbing",
        move(ev, dx, dy) { view.ox = ox0 + dx; view.oy = oy0 + dy; view.fitted = false; requestDraw(); },
      });
      return;
    }
    if (e.button !== 0) return;

    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;

    const handle = gizmoHit(sx, sy);
    if (handle) {
      if (handle.type === "rotate") return dragRotate(e, handle.layer);
      return dragScale(e, handle.layer, handle.corner);
    }

    const [wx, wy] = screenToComp(sx, sy);
    const hit = Renderer.hitTest(App.time, wx, wy);
    if (hit) {
      App.select(hit.id);
      dragMove(e, hit);
    } else {
      App.select(null);
    }
  }

  function dragMove(e, layer) {
    if (layer.locked) return;
    const tr = Renderer.evalT(layer, App.time);
    const p0 = tr.pos.slice();
    let committed = false;
    startDrag(e, {
      move(ev, dx, dy) {
        if (!committed) { App.commit(); committed = true; }
        let nx = p0[0] + dx / view.scale, ny = p0[1] + dy / view.scale;
        if (ev.shiftKey) { Math.abs(dx) > Math.abs(dy) ? ny = p0[1] : nx = p0[0]; }
        Layers.setProp(layer, "position", [Math.round(nx * 10) / 10, Math.round(ny * 10) / 10]);
      },
      up() { if (committed) App.emit("project"); },
    });
  }

  function dragScale(e, layer, corner) {
    if (layer.locked) return;
    const tr = Renderer.evalT(layer, App.time);
    const [w, h] = contentSize(layer);
    const locals = [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]];
    const c = locals[corner];
    const denomX = c[0] - tr.anchor[0], denomY = c[1] - tr.anchor[1];
    const rot = (tr.rot * Math.PI) / 180;
    const s0 = tr.scale.slice();
    let committed = false;
    const rect = canvas.getBoundingClientRect();
    startDrag(e, {
      cursor: "nwse-resize",
      move(ev) {
        if (!committed) { App.commit(); committed = true; }
        const [mx, my] = screenToComp(ev.clientX - rect.left, ev.clientY - rect.top);
        // un-rotate mouse delta around position
        const dx = mx - tr.pos[0], dy = my - tr.pos[1];
        const rx = dx * Math.cos(-rot) - dy * Math.sin(-rot);
        const ry = dx * Math.sin(-rot) + dy * Math.cos(-rot);
        let nsx = Math.abs(denomX) > 1e-3 ? (rx / denomX) * 100 : s0[0];
        let nsy = Math.abs(denomY) > 1e-3 ? (ry / denomY) * 100 : s0[1];
        if (!ev.shiftKey) {
          // uniform by default (AE-style with shift inverted: shift = free)
          const k = (Math.abs(nsx / (s0[0] || 1)) + Math.abs(nsy / (s0[1] || 1))) / 2;
          nsx = (s0[0] || 100) * k;
          nsy = (s0[1] || 100) * k;
        }
        Layers.setProp(layer, "scale", [Math.round(nsx * 10) / 10, Math.round(nsy * 10) / 10]);
      },
      up() { if (committed) App.emit("project"); },
    });
  }

  function dragRotate(e, layer) {
    if (layer.locked) return;
    const tr = Renderer.evalT(layer, App.time);
    const rect = canvas.getBoundingClientRect();
    const [ax, ay] = compToScreen(tr.pos[0], tr.pos[1]);
    const a0 = Math.atan2(e.clientY - rect.top - ay, e.clientX - rect.left - ax);
    const r0 = tr.rot;
    let committed = false;
    startDrag(e, {
      cursor: "grabbing",
      move(ev) {
        if (!committed) { App.commit(); committed = true; }
        const a1 = Math.atan2(ev.clientY - rect.top - ay, ev.clientX - rect.left - ax);
        let nr = r0 + ((a1 - a0) * 180) / Math.PI;
        if (ev.shiftKey) nr = Math.round(nr / 15) * 15;
        Layers.setProp(layer, "rotation", Math.round(nr * 10) / 10);
      },
      up() { if (committed) App.emit("project"); },
    });
  }

  function onWheel(e) {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    setZoom(view.scale * factor, sx, sy);
  }

  function init() {
    canvas = document.getElementById("viewport");
    wrap = document.getElementById("viewport-wrap");
    ctx = canvas.getContext("2d");

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("contextmenu", e => e.preventDefault());

    document.getElementById("btn-zoom-in").addEventListener("click", () => setZoom(view.scale * 1.25));
    document.getElementById("btn-zoom-out").addEventListener("click", () => setZoom(view.scale * 0.8));
    document.getElementById("zoom-label").addEventListener("click", fit);

    new ResizeObserver(() => { if (view.fitted) fit(); requestDraw(); }).observe(wrap);

    // drag & drop media straight onto the canvas
    wrap.addEventListener("dragover", e => { e.preventDefault(); wrap.classList.add("drop-target"); });
    wrap.addEventListener("dragleave", () => wrap.classList.remove("drop-target"));
    wrap.addEventListener("drop", e => {
      e.preventDefault();
      wrap.classList.remove("drop-target");
      if (e.dataTransfer.files.length) Assets.importFiles(e.dataTransfer.files);
    });

    App.on("project", requestDraw);
    App.on("props", requestDraw);
    App.on("selection", requestDraw);
    App.on("time", requestDraw);

    // continuous paint loop (draws only when dirty)
    (function loop() {
      if (dirty || App.playing) { dirty = false; draw(); }
      requestAnimationFrame(loop);
    })();

    fit();
  }

  return { init, requestDraw, fit, setZoom, screenToComp, compToScreen };
})();
