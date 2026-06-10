/* ─── Lumen viewport: comp view + transform gizmos ─────────────── */
"use strict";

const Viewport = (() => {
  let canvas, ctx, wrap;
  let compCanvas = document.createElement("canvas");
  let compCtx = compCanvas.getContext("2d");
  let view = { scale: 1, ox: 0, oy: 0, fitted: true };
  let dirty = true;
  let quality = 1;
  let showGrid = false, showSafe = false, showChecker = false, showGuides = true;
  let activeGuides = [];      // snap guide lines while dragging
  let fpsTime = 0, fpsCount = 0, fpsValue = 0;
  let marquee = null;         // { x0, y0, x1, y1 } in screen coords
  const HANDLE = 7;
  const SNAP_TOL = 6;
  const RULER_W = 20;         // guide ruler drag zone in px

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
  function drawChecker(x, y, w, h) {
    const size = 12;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    ctx.fillStyle = "#1a1b1e";
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = "#232428";
    for (let yy = 0; yy < h / size + 1; yy++)
      for (let xx = (yy % 2); xx < w / size + 1; xx += 2)
        ctx.fillRect(x + xx * size, y + yy * size, size, size);
    ctx.restore();
  }

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
    const bw = Math.max(2, Math.round(c.width * quality));
    const bh = Math.max(2, Math.round(c.height * quality));
    if (compCanvas.width !== bw || compCanvas.height !== bh) {
      compCanvas.width = bw; compCanvas.height = bh;
    }
    Renderer.draw(compCtx, App.time, { scale: quality });

    const vx = view.ox, vy = view.oy, vw = c.width * view.scale, vh = c.height * view.scale;

    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.6)";
    ctx.shadowBlur = 30;
    ctx.fillStyle = "#000";
    ctx.fillRect(vx, vy, vw, vh);
    ctx.restore();

    if (showChecker || c.bgAlpha) drawChecker(vx, vy, vw, vh);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(compCanvas, vx, vy, vw, vh);
    ctx.strokeStyle = "#26282d";
    ctx.lineWidth = 1;
    ctx.strokeRect(vx - 0.5, vy - 0.5, vw + 1, vh + 1);

    if (showGrid) drawGrid(vx, vy, vw, vh);
    if (showSafe) drawSafe(vx, vy, vw, vh);
    if (showGuides) drawRulerGuides();
    drawMotionPath();
    drawGizmo();
    drawSnapGuides();
    drawMarquee();
    updateFps();
  }

  function drawGrid(vx, vy, vw, vh) {
    const c = App.comp;
    const step = 50 * view.scale;
    ctx.save();
    ctx.strokeStyle = "rgba(124,137,240,0.12)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = vx; x <= vx + vw + 0.5; x += step) { ctx.moveTo(x, vy); ctx.lineTo(x, vy + vh); }
    for (let y = vy; y <= vy + vh + 0.5; y += step) { ctx.moveTo(vx, y); ctx.lineTo(vx + vw, y); }
    ctx.stroke();
    // center cross
    ctx.strokeStyle = "rgba(124,137,240,0.4)";
    ctx.beginPath();
    ctx.moveTo(vx + vw / 2, vy); ctx.lineTo(vx + vw / 2, vy + vh);
    ctx.moveTo(vx, vy + vh / 2); ctx.lineTo(vx + vw, vy + vh / 2);
    ctx.stroke();
    ctx.restore();
  }

  function drawSafe(vx, vy, vw, vh) {
    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.25)";
    ctx.setLineDash([4, 4]);
    ctx.strokeRect(vx + vw * 0.05, vy + vh * 0.05, vw * 0.9, vh * 0.9);   // action safe
    ctx.strokeRect(vx + vw * 0.1, vy + vh * 0.1, vw * 0.8, vh * 0.8);     // title safe
    // thirds
    ctx.strokeStyle = "rgba(255,255,255,0.1)";
    ctx.beginPath();
    [1 / 3, 2 / 3].forEach(f => {
      ctx.moveTo(vx + vw * f, vy); ctx.lineTo(vx + vw * f, vy + vh);
      ctx.moveTo(vx, vy + vh * f); ctx.lineTo(vx + vw, vy + vh * f);
    });
    ctx.stroke();
    ctx.restore();
  }

  function drawRulerGuides() {
    const guides = (App.comp && App.comp.guides) || [];
    if (!guides.length) return;
    ctx.save();
    ctx.strokeStyle = "rgba(0,200,255,0.5)";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    guides.forEach(g => {
      if (g.axis === "v") {
        const [sx] = compToScreen(g.v, 0);
        ctx.moveTo(sx, 0); ctx.lineTo(sx, canvas.clientHeight);
      } else {
        const [, sy] = compToScreen(0, g.v);
        ctx.moveTo(0, sy); ctx.lineTo(canvas.clientWidth, sy);
      }
    });
    ctx.stroke();
    ctx.restore();
  }

  function drawMarquee() {
    if (!marquee) return;
    const { x0, y0, x1, y1 } = marquee;
    const x = Math.min(x0, x1), y = Math.min(y0, y1);
    const w = Math.abs(x1 - x0), h = Math.abs(y1 - y0);
    ctx.save();
    ctx.strokeStyle = "rgba(124,137,240,0.9)";
    ctx.fillStyle = "rgba(124,137,240,0.07)";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.fill(); ctx.stroke();
    ctx.restore();
  }

  function drawSnapGuides() {
    if (!activeGuides.length) return;
    ctx.save();
    ctx.strokeStyle = "#e0639d";
    ctx.lineWidth = 1;
    ctx.beginPath();
    activeGuides.forEach(g => {
      if (g.axis === "v") {
        const [sx] = compToScreen(g.v, 0);
        ctx.moveTo(sx, 0); ctx.lineTo(sx, canvas.clientHeight);
      } else {
        const [, sy] = compToScreen(0, g.v);
        ctx.moveTo(0, sy); ctx.lineTo(canvas.clientWidth, sy);
      }
    });
    ctx.stroke();
    ctx.restore();
  }

  function drawMotionPath() {
    const layer = App.selectedLayer();
    if (!layer) return;
    const p = layer.props.position;
    if (!p.anim || p.keys.length < 2) return;
    const t0 = Math.max(layer.inPoint, p.keys[0].t - 0.5);
    const t1 = Math.min(layer.outPoint, p.keys[p.keys.length - 1].t + 0.5);
    const steps = Math.min(400, Math.max(24, Math.round((t1 - t0) * App.comp.fps)));
    ctx.save();
    ctx.strokeStyle = "rgba(124,137,240,0.65)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i <= steps; i++) {
      const tt = t0 + ((t1 - t0) * i) / steps;
      const pos = evalProp(p, tt);
      const P = parentMatrix(layer, tt);
      const [wx, wy] = matApply(P, pos[0], pos[1]);
      const [sx, sy] = compToScreen(wx, wy);
      i === 0 ? ctx.moveTo(sx, sy) : ctx.lineTo(sx, sy);
    }
    ctx.stroke();
    // key dots
    p.keys.forEach(k => {
      const P = parentMatrix(layer, k.t);
      const [wx, wy] = matApply(P, k.v[0], k.v[1]);
      const [sx, sy] = compToScreen(wx, wy);
      ctx.fillStyle = "#0f1011";
      ctx.strokeStyle = "#7c89f0";
      ctx.beginPath();
      ctx.rect(sx - 3.5, sy - 3.5, 7, 7);
      ctx.fill(); ctx.stroke();
    });
    ctx.restore();
  }

  function gizmoGeometry(layer) {
    const pts = Renderer.corners(layer, App.time).map(([x, y]) => compToScreen(x, y));
    const tr = Renderer.evalT(layer, App.time);
    const P = parentMatrix(layer, App.time);
    const [wxp, wyp] = matApply(P, tr.pos[0], tr.pos[1]);
    const [ax, ay] = compToScreen(wxp, wyp);
    const tm = [(pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2];
    const dir = [tm[0] - ax, tm[1] - ay];
    const len = Math.hypot(dir[0], dir[1]) || 1;
    const rh = [tm[0] + (dir[0] / len) * 22, tm[1] + (dir[1] / len) * 22];
    return { pts, ax, ay, tm, rh };
  }

  function drawGizmo() {
    const layer = App.selectedLayer();
    if (!layer || layer.type === "audio" || !Renderer.isActive(layer, App.time, layer.type === "adjust" || layer.type === "nullobj")) return;
    const { pts, ax, ay, tm, rh } = gizmoGeometry(layer);

    ctx.save();
    ctx.strokeStyle = layer.type === "nullobj" ? "#8a8f98" : "#7c89f0";
    ctx.lineWidth = 1.2;
    if (layer.type === "nullobj" || layer.type === "adjust") ctx.setLineDash([5, 4]);
    ctx.beginPath();
    pts.forEach(([x, y], i) => i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y));
    ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.beginPath();
    ctx.moveTo(tm[0], tm[1]);
    ctx.lineTo(rh[0], rh[1]);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(rh[0], rh[1], 4.5, 0, Math.PI * 2);
    ctx.fillStyle = "#0f1011";
    ctx.fill();
    ctx.stroke();

    pts.forEach(([x, y]) => {
      ctx.fillStyle = "#0f1011";
      ctx.strokeStyle = "#7c89f0";
      ctx.fillRect(x - HANDLE / 2, y - HANDLE / 2, HANDLE, HANDLE);
      ctx.strokeRect(x - HANDLE / 2, y - HANDLE / 2, HANDLE, HANDLE);
    });

    ctx.strokeStyle = "#7c89f0";
    ctx.beginPath();
    ctx.arc(ax, ay, 4, 0, Math.PI * 2);
    ctx.moveTo(ax - 8, ay); ctx.lineTo(ax + 8, ay);
    ctx.moveTo(ax, ay - 8); ctx.lineTo(ax, ay + 8);
    ctx.stroke();
    ctx.restore();
  }

  function gizmoHit(sx, sy) {
    const layer = App.selectedLayer();
    if (!layer || layer.type === "audio" || !Renderer.isActive(layer, App.time, true)) return null;
    const { pts, rh } = gizmoGeometry(layer);
    if (Math.hypot(sx - rh[0], sy - rh[1]) < 8) return { type: "rotate", layer };
    for (let i = 0; i < 4; i++) {
      if (Math.abs(sx - pts[i][0]) < HANDLE && Math.abs(sy - pts[i][1]) < HANDLE)
        return { type: "scale", corner: i, layer };
    }
    return null;
  }

  function motionKeyHit(sx, sy) {
    const layer = App.selectedLayer();
    if (!layer) return null;
    const p = layer.props.position;
    if (!p.anim || p.keys.length < 2) return null;
    for (const k of p.keys) {
      const P = parentMatrix(layer, k.t);
      const [wx, wy] = matApply(P, k.v[0], k.v[1]);
      const [kx, ky] = compToScreen(wx, wy);
      if (Math.hypot(sx - kx, sy - ky) < 7) return { layer, p, key: k };
    }
    return null;
  }

  /* ── interactions ── */
  function onPointerDown(e) {
    if (e.button === 1 || (e.button === 0 && e.altKey)) {
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

    // check for guide creation from rulers (near top/left edge)
    if (sx < RULER_W) { dragCreateGuide(e, "v"); return; }
    if (sy < RULER_W) { dragCreateGuide(e, "h"); return; }

    // check for guide hit (within snap tolerance)
    if (showGuides) {
      const gh = guideHit(sx, sy);
      if (gh) { dragGuide(e, gh); return; }
    }

    if (MotionSketch.isRecording()) {
      const [wx, wy] = screenToComp(sx, sy);
      MotionSketch.recordPos(wx, wy);
      return;
    }

    const mk = motionKeyHit(sx, sy);
    if (mk) return dragMotionKey(e, mk);

    const handle = gizmoHit(sx, sy);
    if (handle) {
      if (handle.type === "rotate") return dragRotate(e, handle.layer);
      return dragScale(e, handle.layer, handle.corner);
    }

    const [wx, wy] = screenToComp(sx, sy);
    const hit = Renderer.hitTest(App.time, wx, wy);
    if (hit) {
      if (e.shiftKey || e.metaKey) { App.select(hit.id, true); return; }
      if (!App.isSelected(hit.id)) App.select(hit.id);
      if (e.ctrlKey) dragAnchor(e, hit);
      else dragMove(e, hit);
    } else {
      // start marquee selection
      if (!e.shiftKey && !e.metaKey) App.select(null);
      dragMarquee(e, sx, sy);
    }
  }

  function guideHit(sx, sy) {
    const guides = (App.comp && App.comp.guides) || [];
    const tol = 5;
    for (const g of guides) {
      if (g.axis === "v") {
        const [gx] = compToScreen(g.v, 0);
        if (Math.abs(sx - gx) < tol) return g;
      } else {
        const [, gy] = compToScreen(0, g.v);
        if (Math.abs(sy - gy) < tol) return g;
      }
    }
    return null;
  }

  function dragCreateGuide(e, axis) {
    if (!App.comp.guides) App.comp.guides = [];
    const guide = { id: uid(), axis, v: 0 };
    App.commit();
    App.comp.guides.push(guide);
    const rect = canvas.getBoundingClientRect();
    startDrag(e, {
      cursor: axis === "v" ? "ew-resize" : "ns-resize",
      move(ev) {
        const sx = ev.clientX - rect.left, sy = ev.clientY - rect.top;
        if (axis === "v") { const [wx] = screenToComp(sx, 0); guide.v = Math.round(wx); }
        else { const [, wy] = screenToComp(0, sy); guide.v = Math.round(wy); }
        requestDraw();
      },
      up() { App.emit("project"); },
    });
  }

  function dragGuide(e, guide) {
    App.commit();
    const rect = canvas.getBoundingClientRect();
    startDrag(e, {
      cursor: guide.axis === "v" ? "ew-resize" : "ns-resize",
      move(ev) {
        const sx = ev.clientX - rect.left, sy = ev.clientY - rect.top;
        if (guide.axis === "v") { const [wx] = screenToComp(sx, 0); guide.v = Math.round(wx); }
        else { const [, wy] = screenToComp(0, sy); guide.v = Math.round(wy); }
        requestDraw();
      },
      up(ev, dx, dy) {
        // if dragged off screen, remove guide
        const totalDist = Math.hypot(dx, dy);
        if (totalDist < 5) {
          App.comp.guides = App.comp.guides.filter(g => g !== guide);
        }
        App.emit("project");
      },
    });
  }

  function dragMarquee(e, sx0, sy0) {
    const rect = canvas.getBoundingClientRect();
    marquee = { x0: sx0, y0: sy0, x1: sx0, y1: sy0 };
    startDrag(e, {
      move(ev) {
        marquee.x1 = ev.clientX - rect.left;
        marquee.y1 = ev.clientY - rect.top;
        requestDraw();
      },
      up() {
        if (marquee) {
          // select all layers whose positions fall in the marquee
          const x0 = Math.min(marquee.x0, marquee.x1);
          const y0 = Math.min(marquee.y0, marquee.y1);
          const x1 = Math.max(marquee.x0, marquee.x1);
          const y1 = Math.max(marquee.y0, marquee.y1);
          if (x1 - x0 > 5 || y1 - y0 > 5) {
            const hits = App.layers.filter(l => {
              if (!Renderer.isActive(l, App.time, true)) return false;
              const [lx, ly] = compToScreen(...evalProp(l.props.position, App.time));
              return lx >= x0 && lx <= x1 && ly >= y0 && ly <= y1;
            });
            if (hits.length) {
              App.selection = hits[0].id;
              App.selExtra = new Set(hits.slice(1).map(l => l.id));
              App.emit("selection");
            }
          }
        }
        marquee = null;
        requestDraw();
      },
    });
  }

  function dragMotionKey(e, { layer, p, key }) {
    let committed = false;
    const rect = canvas.getBoundingClientRect();
    startDrag(e, {
      move(ev) {
        if (!committed) { App.commit(); committed = true; }
        const [wx, wy] = screenToComp(ev.clientX - rect.left, ev.clientY - rect.top);
        const invP = matInvert(parentMatrix(layer, key.t));
        const [px, py] = matApply(invP, wx, wy);
        key.v = [Math.round(px * 10) / 10, Math.round(py * 10) / 10];
        App.emit("props");
      },
      up() { if (committed) App.emit("project"); },
    });
  }

  function snapWorld(wx, wy) {
    const c = App.comp;
    const tol = SNAP_TOL / view.scale;
    activeGuides = [];
    const targetsX = [0, c.width / 2, c.width];
    const targetsY = [0, c.height / 2, c.height];
    for (const tx of targetsX) {
      if (Math.abs(wx - tx) < tol) { wx = tx; activeGuides.push({ axis: "v", v: tx }); break; }
    }
    for (const ty of targetsY) {
      if (Math.abs(wy - ty) < tol) { wy = ty; activeGuides.push({ axis: "h", v: ty }); break; }
    }
    return [wx, wy];
  }

  function dragMove(e, layer) {
    if (layer.locked) return;
    const group = App.selectedLayers().filter(l => !l.locked && l.type !== "audio");
    const starts = group.map(l => ({ l, p0: evalProp(l.props.position, App.time).slice() }));
    let committed = false;
    startDrag(e, {
      move(ev, dx, dy) {
        if (!committed) { App.commit(); committed = true; }
        starts.forEach(({ l, p0 }) => {
          const invP = matInvert(parentMatrix(l, App.time));
          // mouse delta (comp px) → parent-space delta
          const pdx = (invP[0] * dx + invP[2] * dy) / view.scale;
          const pdy = (invP[1] * dx + invP[3] * dy) / view.scale;
          let nx = p0[0] + pdx, ny = p0[1] + pdy;
          if (ev.shiftKey) { Math.abs(dx) > Math.abs(dy) ? ny = p0[1] : nx = p0[0]; }
          if (l === layer && !l.parent && group.length === 1 && !ev.shiftKey) {
            [nx, ny] = snapWorld(nx, ny);
          }
          Layers.setProp(l, "position", [Math.round(nx * 10) / 10, Math.round(ny * 10) / 10]);
        });
      },
      up() {
        activeGuides = [];
        requestDraw();
        if (committed) App.emit("project");
      },
    });
  }

  /* ctrl+drag: pan-behind — move anchor without moving the layer */
  function dragAnchor(e, layer) {
    if (layer.locked) return;
    const tr = Renderer.evalT(layer, App.time);
    const a0 = tr.anchor.slice(), pos0 = tr.pos.slice();
    const rect = canvas.getBoundingClientRect();
    let committed = false;
    startDrag(e, {
      cursor: "move",
      move(ev) {
        if (!committed) { App.commit(); committed = true; }
        const [wx, wy] = screenToComp(ev.clientX - rect.left, ev.clientY - rect.top);
        const [lx, ly] = Renderer.toLocal(layer, App.time, wx, wy);
        const da = [lx - a0[0], ly - a0[1]];
        // pos' = pos + R·S·(a' − a) in parent space
        const r = (tr.rot * Math.PI) / 180;
        const sxs = tr.scale[0] / 100, sys = tr.scale[1] / 100;
        const ox = Math.cos(r) * sxs * da[0] - Math.sin(r) * sys * da[1];
        const oy = Math.sin(r) * sxs * da[0] + Math.cos(r) * sys * da[1];
        Layers.setProp(layer, "anchor", [Math.round(lx * 10) / 10, Math.round(ly * 10) / 10]);
        Layers.setProp(layer, "position", [Math.round((pos0[0] + ox) * 10) / 10, Math.round((pos0[1] + oy) * 10) / 10]);
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
        const invP = matInvert(parentMatrix(layer, App.time));
        const [pmx, pmy] = matApply(invP, mx, my);
        const dx = pmx - tr.pos[0], dy = pmy - tr.pos[1];
        const rx = dx * Math.cos(-rot) - dy * Math.sin(-rot);
        const ry = dx * Math.sin(-rot) + dy * Math.cos(-rot);
        let nsx = Math.abs(denomX) > 1e-3 ? (rx / denomX) * 100 : s0[0];
        let nsy = Math.abs(denomY) > 1e-3 ? (ry / denomY) * 100 : s0[1];
        if (!ev.shiftKey) {
          const k = (Math.abs(nsx / (s0[0] || 100)) + Math.abs(nsy / (s0[1] || 100))) / 2;
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
    const P = parentMatrix(layer, App.time);
    const [wxp, wyp] = matApply(P, tr.pos[0], tr.pos[1]);
    const [ax, ay] = compToScreen(wxp, wyp);
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
    setZoom(view.scale * (e.deltaY < 0 ? 1.1 : 0.9), e.clientX - rect.left, e.clientY - rect.top);
  }

  function updateFps() {
    const el = document.getElementById("fps-label");
    if (!el) return;
    if (!App.playing) { el.textContent = ""; return; }
    fpsCount++;
    const now = performance.now();
    if (now - fpsTime > 500) {
      fpsValue = Math.round((fpsCount * 1000) / (now - fpsTime));
      fpsTime = now;
      fpsCount = 0;
    }
    el.textContent = fpsValue ? fpsValue + " fps" : "";
  }

  function setQuality(q) {
    quality = q;
    requestDraw();
  }

  function init() {
    canvas = document.getElementById("viewport");
    wrap = document.getElementById("viewport-wrap");
    ctx = canvas.getContext("2d");

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("contextmenu", e => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const [wx, wy] = screenToComp(e.clientX - rect.left, e.clientY - rect.top);
      const hit = Renderer.hitTest(App.time, wx, wy);
      if (!hit) return;
      App.select(hit.id);
      showMenu(e.clientX, e.clientY, [
        { label: "Center in comp", run: () => { App.commit(); Layers.setProp(hit, "position", [App.comp.width / 2, App.comp.height / 2]); App.emit("project"); } },
        { label: "Fit to comp", run: () => UICommands.fitLayerToComp(hit) },
        { label: "Flip horizontal", run: () => UICommands.flip(hit, "h") },
        { label: "Flip vertical", run: () => UICommands.flip(hit, "v") },
        { label: "Reset transform", run: () => UICommands.resetTransform(hit) },
        "-",
        { label: "Duplicate", run: () => { App.commit(); Layers.duplicate(hit.id); } },
        { label: "Delete", danger: true, run: () => { App.commit(); Layers.remove(hit.id); } },
      ]);
    });

    document.getElementById("btn-zoom-in").addEventListener("click", () => setZoom(view.scale * 1.25));
    document.getElementById("btn-zoom-out").addEventListener("click", () => setZoom(view.scale * 0.8));
    document.getElementById("zoom-label").addEventListener("click", e => {
      showMenu(e.clientX, e.clientY, [
        { label: "Fit", run: fit },
        { label: "25%", run: () => setZoom(0.25) },
        { label: "50%", run: () => setZoom(0.5) },
        { label: "100%", run: () => setZoom(1) },
        { label: "200%", run: () => setZoom(2) },
      ]);
    });

    canvas.addEventListener("pointermove", ev => {
      if (MotionSketch.isRecording()) {
        const r = canvas.getBoundingClientRect();
        const [wx, wy] = screenToComp(ev.clientX - r.left, ev.clientY - r.top);
        MotionSketch.recordPos(wx, wy);
      }
    });

    document.getElementById("btn-grid").addEventListener("click", e => {
      showGrid = !showGrid;
      e.currentTarget.classList.toggle("active", showGrid);
      requestDraw();
    });
    document.getElementById("btn-safe").addEventListener("click", e => {
      showSafe = !showSafe;
      e.currentTarget.classList.toggle("active", showSafe);
      requestDraw();
    });
    document.getElementById("btn-checker").addEventListener("click", e => {
      showChecker = !showChecker;
      e.currentTarget.classList.toggle("active", showChecker);
      requestDraw();
    });
    document.getElementById("btn-guides").addEventListener("click", e => {
      showGuides = !showGuides;
      e.currentTarget.classList.toggle("active", showGuides);
      requestDraw();
    });
    document.getElementById("quality-select").addEventListener("change", e => {
      setQuality(parseFloat(e.target.value));
    });

    new ResizeObserver(() => { if (view.fitted) fit(); requestDraw(); }).observe(wrap);

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
    App.on("comps", () => { fit(); requestDraw(); });

    (function loop() {
      if (dirty || App.playing) { dirty = false; draw(); }
      requestAnimationFrame(loop);
    })();

    fit();
  }

  function toggleGuides() {
    showGuides = !showGuides;
    const btn = document.getElementById("btn-guides");
    if (btn) btn.classList.toggle("active", showGuides);
    requestDraw();
    toast("Guides: " + (showGuides ? "on" : "off"));
  }

  function currentScale() { return view.scale; }

  return { init, requestDraw, fit, setZoom, setQuality, screenToComp, compToScreen, toggleGuides, currentScale };
})();
