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
    drawPenPath();
    drawPuppetPins();
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
    // Bezier tangent handles for selected keys
    const selKeys = App.selectedKeys.filter(sk => sk.p === "position");
    const selTimes = new Set(selKeys.map(sk => sk.key.t));
    p.keys.forEach((k, ki) => {
      if (!selTimes.has(k.t)) return;
      const P = parentMatrix(layer, k.t);
      const [wx, wy] = matApply(P, k.v[0], k.v[1]);
      const [sx, sy] = compToScreen(wx, wy);
      // cpOut handle
      if (k.cpOut) {
        const [ohx, ohy] = matApply(P, k.cpOut[0], k.cpOut[1]);
        const [osx, osy] = compToScreen(ohx, ohy);
        ctx.save();
        ctx.strokeStyle = "rgba(124,137,240,0.8)"; ctx.lineWidth = 1;
        ctx.setLineDash([3,3]);
        ctx.beginPath(); ctx.moveTo(sx,sy); ctx.lineTo(osx,osy); ctx.stroke();
        ctx.setLineDash([]);
        ctx.beginPath(); ctx.arc(osx, osy, 5, 0, Math.PI*2);
        ctx.fillStyle = "#7c89f0"; ctx.fill();
        ctx.strokeStyle = "#fff"; ctx.lineWidth = 1; ctx.stroke();
        ctx.restore();
      }
      // cpIn handle
      if (k.cpIn) {
        const [ihx, ihy] = matApply(P, k.cpIn[0], k.cpIn[1]);
        const [isx, isy] = compToScreen(ihx, ihy);
        ctx.save();
        ctx.strokeStyle = "rgba(240,160,48,0.8)"; ctx.lineWidth = 1;
        ctx.setLineDash([3,3]);
        ctx.beginPath(); ctx.moveTo(sx,sy); ctx.lineTo(isx,isy); ctx.stroke();
        ctx.setLineDash([]);
        ctx.beginPath(); ctx.arc(isx, isy, 5, 0, Math.PI*2);
        ctx.fillStyle = "#f0a030"; ctx.fill();
        ctx.strokeStyle = "#fff"; ctx.lineWidth = 1; ctx.stroke();
        ctx.restore();
      }
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

    // pen tool takes priority
    if (penMode) { penPointerDown(e); return; }

    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;

    // puppet tool
    if (App.tool === "puppet") {
      const pl = App.selectedLayer();
      if (!pl) return;
      const M = worldMatrix(pl, App.time);
      const [cw, ch] = contentSize(pl);
      const [wx, wy] = screenToComp(sx, sy);
      // Hit-test existing pins (at deformed position)
      for (const pin of pl.puppetPins) {
        const [wx2, wy2] = matApply(M, pin.dx - cw/2, pin.dy - ch/2);
        const [sx2, sy2] = compToScreen(wx2, wy2);
        if (Math.hypot(sx-sx2, sy-sy2) < 10) {
          startDrag(e, {
            move(ev) {
              const [mwx, mwy] = screenToComp(ev.clientX - rect.left, ev.clientY - rect.top);
              const invM = matInvert(M);
              const [lx, ly] = matApply(invM, mwx, mwy);
              pin.dx = lx + cw/2;
              pin.dy = ly + ch/2;
              App.emit("props");
            },
            up() { App.commit(); App.emit("project"); },
          });
          return;
        }
      }
      // Add new pin: click in layer bounds
      const invM = matInvert(M);
      const [lx, ly] = matApply(invM, wx, wy);
      const lox = lx + cw/2, loy = ly + ch/2;
      if (lox >= 0 && lox <= cw && loy >= 0 && loy <= ch) {
        App.commit();
        pl.puppetPins.push({ id: uid(), ox: lox, oy: loy, dx: lox, dy: loy });
        App.emit("project");
        requestDraw();
      }
      return;
    }

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

    // Bezier handle hit-test (only for motion paths on selected layer with anim keys)
    const selLayer = App.selectedLayer();
    if (selLayer && !e.altKey) {
      const p2 = selLayer.props.position;
      if (p2.anim && p2.keys.length >= 2) {
        const selTimes2 = new Set(App.selectedKeys.filter(sk=>sk.p==="position").map(sk=>sk.key.t));
        for (const k of p2.keys) {
          if (!selTimes2.has(k.t)) continue;
          const P = parentMatrix(selLayer, k.t);
          // Check cpOut
          if (k.cpOut) {
            const [ohx, ohy] = matApply(P, k.cpOut[0], k.cpOut[1]);
            const [osx, osy] = compToScreen(ohx, ohy);
            if (Math.hypot(sx-osx, sy-osy) < 9) {
              e.preventDefault();
              startDrag(e, {
                move(ev) {
                  const [wx, wy] = screenToComp(ev.clientX - rect.left, ev.clientY - rect.top);
                  const invP = matInvert(parentMatrix(selLayer, k.t));
                  const [lx, ly] = matApply(invP, wx, wy);
                  k.cpOut = [lx, ly];
                  App.emit("props");
                },
                up() { App.commit(); App.emit("project"); },
              });
              return;
            }
          }
          // Check cpIn
          if (k.cpIn) {
            const [ihx, ihy] = matApply(P, k.cpIn[0], k.cpIn[1]);
            const [isx, isy] = compToScreen(ihx, ihy);
            if (Math.hypot(sx-isx, sy-isy) < 9) {
              e.preventDefault();
              startDrag(e, {
                move(ev) {
                  const [wx, wy] = screenToComp(ev.clientX - rect.left, ev.clientY - rect.top);
                  const invP = matInvert(parentMatrix(selLayer, k.t));
                  const [lx, ly] = matApply(invP, wx, wy);
                  k.cpIn = [lx, ly];
                  App.emit("props");
                },
                up() { App.commit(); App.emit("project"); },
              });
              return;
            }
          }
        }
      }
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
      const r = canvas.getBoundingClientRect();
      const [wx, wy] = screenToComp(ev.clientX - r.left, ev.clientY - r.top);
      if (MotionSketch.isRecording()) MotionSketch.recordPos(wx, wy);
      if (penMode) { penHover = { x: wx, y: wy }; requestDraw(); }
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
    const penBtn = document.getElementById("btn-pen-tool");
    if (penBtn) penBtn.addEventListener("click", () => togglePenTool());
    document.getElementById("btn-puppet-tool")?.addEventListener("click", () => {
      App.tool = App.tool === "puppet" ? "pointer" : "puppet";
      draw();
    });
    // dblclick to toggle bezier handles on motion path keyframe dots
    canvas.addEventListener("dblclick", ev => {
      if (penMode) return;
      const rect2 = canvas.getBoundingClientRect();
      const cx = ev.clientX - rect2.left, cy = ev.clientY - rect2.top;
      const layer = App.selectedLayer();
      if (!layer) return;
      const p = layer.props.position;
      if (!p.anim || p.keys.length < 2) return;
      p.keys.forEach(k => {
        const P = parentMatrix(layer, k.t);
        const [wx, wy] = matApply(P, k.v[0], k.v[1]);
        const [sx, sy] = compToScreen(wx, wy);
        if (Math.hypot(cx-sx, cy-sy) < 8) {
          App.commit();
          if (k.cpOut) { delete k.cpOut; delete k.cpIn; }
          else {
            // Add smooth auto-handles: 1/3 of the distance to adjacent keyframe
            const ki = p.keys.indexOf(k);
            const prev = p.keys[ki-1], next = p.keys[ki+1];
            if (next) k.cpOut = [k.v[0]+(next.v[0]-k.v[0])/3, k.v[1]+(next.v[1]-k.v[1])/3];
            if (prev) k.cpIn  = [k.v[0]+(prev.v[0]-k.v[0])/3, k.v[1]+(prev.v[1]-k.v[1])/3];
          }
          App.emit("project");
        }
      });
    });
    // Escape key cancels pen tool
    document.addEventListener("keydown", ev => {
      if (penMode && ev.key === "Escape") { penPoints = []; penMode = false; canvas.style.cursor = ""; if (penBtn) penBtn.classList.remove("active"); requestDraw(); }
      if (penMode && ev.key === "Enter" && penPoints.length >= 2) finalizePenPath(true);
      if ((ev.key === "p" || ev.key === "P") && !ev.metaKey && !ev.ctrlKey) { App.tool = App.tool === "puppet" ? "pointer" : "puppet"; draw(); }
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

  /* ── puppet pin overlay ── */
  function drawPuppetPins() {
    if (App.tool !== "puppet") return;
    const pl = App.selectedLayer();
    if (!pl || !pl.puppetPins) return;
    const M = worldMatrix(pl, App.time);
    const [cw, ch] = contentSize(pl);
    pl.puppetPins.forEach(pin => {
      // pin is in layer-local coords (0,0 = top-left of content)
      const [wx, wy] = matApply(M, pin.ox - cw/2, pin.oy - ch/2);
      const [sx, sy] = compToScreen(wx, wy);
      const [wx2, wy2] = matApply(M, pin.dx - cw/2, pin.dy - ch/2);
      const [sx2, sy2] = compToScreen(wx2, wy2);
      // Draw line from original to deformed position
      if (sx2 !== sx || sy2 !== sy) {
        ctx.save(); ctx.strokeStyle="rgba(255,180,50,0.5)"; ctx.lineWidth=1;
        ctx.setLineDash([3,3]);
        ctx.beginPath(); ctx.moveTo(sx,sy); ctx.lineTo(sx2,sy2); ctx.stroke();
        ctx.setLineDash([]); ctx.restore();
      }
      // Draw pin circle at deformed position
      ctx.save();
      ctx.beginPath(); ctx.arc(sx2,sy2,7,0,Math.PI*2);
      ctx.fillStyle="#ffb432"; ctx.fill();
      ctx.strokeStyle="#fff"; ctx.lineWidth=1.5; ctx.stroke();
      ctx.restore();
    });
  }

  /* ── pen tool ── */
  let penMode = false;
  let penPoints = [];  // [{x,y,cpIn:{x,y},cpOut:{x,y}}]
  let penHover = null;

  function togglePenTool() {
    penMode = !penMode;
    penPoints = [];
    penHover = null;
    const btn = document.getElementById("btn-pen-tool");
    if (btn) btn.classList.toggle("active", penMode);
    canvas.style.cursor = penMode ? "crosshair" : "";
    toast(penMode ? "Pen tool on — click to add points, double-click or Enter to close" : "Pen tool off");
    requestDraw();
  }

  function drawPenPath() {
    if (!penMode && !penPoints.length) return;
    if (!penMode) return;
    const pts = penPoints;
    if (!pts.length) return;
    ctx.save();
    ctx.strokeStyle = "rgba(255,180,0,0.9)";
    ctx.fillStyle = "rgba(255,180,0,0.9)";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([]);
    if (pts.length >= 2) {
      ctx.beginPath();
      const [sx0, sy0] = compToScreen(pts[0].x, pts[0].y);
      ctx.moveTo(sx0, sy0);
      for (let i = 0; i < pts.length - 1; i++) {
        const c = pts[i], n = pts[i+1];
        const [cox, coy] = compToScreen(c.cpOut.x, c.cpOut.y);
        const [cnx, cny] = compToScreen(n.cpIn.x, n.cpIn.y);
        const [nx, ny] = compToScreen(n.x, n.y);
        ctx.bezierCurveTo(cox, coy, cnx, cny, nx, ny);
      }
      if (penHover) {
        const last = pts[pts.length-1];
        const [cox, coy] = compToScreen(last.cpOut.x, last.cpOut.y);
        const [hvx, hvy] = compToScreen(penHover.x, penHover.y);
        ctx.bezierCurveTo(cox, coy, hvx, hvy, hvx, hvy);
      }
      ctx.stroke();
    } else if (pts.length === 1 && penHover) {
      const [sx0, sy0] = compToScreen(pts[0].x, pts[0].y);
      const [hvx, hvy] = compToScreen(penHover.x, penHover.y);
      ctx.beginPath(); ctx.moveTo(sx0, sy0); ctx.lineTo(hvx, hvy);
      ctx.stroke();
    }
    // draw points and handles
    pts.forEach((p, i) => {
      const [px, py] = compToScreen(p.x, p.y);
      // handles
      if (i > 0) {
        const [inx, iny] = compToScreen(p.cpIn.x, p.cpIn.y);
        ctx.save(); ctx.strokeStyle="rgba(255,180,0,0.5)"; ctx.lineWidth=1;
        ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(inx, iny); ctx.stroke();
        ctx.fillStyle="#ffa500"; ctx.beginPath(); ctx.arc(inx, iny, 3, 0, Math.PI*2); ctx.fill(); ctx.restore();
      }
      if (i < pts.length-1) {
        const [outx, outy] = compToScreen(p.cpOut.x, p.cpOut.y);
        ctx.save(); ctx.strokeStyle="rgba(255,180,0,0.5)"; ctx.lineWidth=1;
        ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(outx, outy); ctx.stroke();
        ctx.fillStyle="#ffa500"; ctx.beginPath(); ctx.arc(outx, outy, 3, 0, Math.PI*2); ctx.fill(); ctx.restore();
      }
      // anchor
      ctx.fillStyle = i === 0 ? "#fff" : "#0f1011";
      ctx.strokeStyle = "#ffa500";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.rect(px - 4, py - 4, 8, 8);
      ctx.fill(); ctx.stroke();
    });
    ctx.restore();
  }

  function penPointerDown(e) {
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    const [wx, wy] = screenToComp(sx, sy);
    // check if clicking near first point to close path
    if (penPoints.length >= 3) {
      const [fx, fy] = compToScreen(penPoints[0].x, penPoints[0].y);
      if (Math.hypot(sx - fx, sy - fy) < 10) {
        finalizePenPath(true);
        return;
      }
    }
    // double-click to finalize open path
    if (e.detail >= 2 && penPoints.length >= 2) {
      finalizePenPath(false);
      return;
    }
    const pt = { x: wx, y: wy, cpIn: { x: wx, y: wy }, cpOut: { x: wx, y: wy } };
    penPoints.push(pt);
    // handle drag to set bezier handles
    startDrag(e, {
      cursor: "crosshair",
      move(ev) {
        const [dwx, dwy] = screenToComp(ev.clientX - rect.left, ev.clientY - rect.top);
        const dx = dwx - wx, dy = dwy - wy;
        pt.cpOut = { x: wx + dx, y: wy + dy };
        pt.cpIn = { x: wx - dx, y: wy - dy };
        requestDraw();
      },
    });
    requestDraw();
  }

  function finalizePenPath(closed) {
    if (penPoints.length < 2) { penPoints = []; penMode = false; requestDraw(); return; }
    const layer = App.selectedLayer();
    if (!layer || layer.type === "audio") {
      toast("Select a layer to add a mask path");
      penPoints = []; requestDraw(); return;
    }
    App.commit();
    // convert pen points to mask coordinates (layer-local space via inverse world matrix)
    const M = matInvert(worldMatrix(layer, App.time));
    const localPts = penPoints.map(p => {
      const [lx, ly] = matApply(M, p.x, p.y);
      const [cpInX, cpInY] = matApply(M, p.cpIn.x, p.cpIn.y);
      const [cpOutX, cpOutY] = matApply(M, p.cpOut.x, p.cpOut.y);
      return { x: lx, y: ly, cpIn: { x: cpInX, y: cpInY }, cpOut: { x: cpOutX, y: cpOutY } };
    });
    layer.masks.push({ id: uid(), shape: "path", mode: "add", feather: 0, closed: !!closed, points: localPts });
    App.emit("project");
    toast("Bezier mask added");
    penPoints = [];
    penMode = false;
    const btn = document.getElementById("btn-pen-tool");
    if (btn) btn.classList.remove("active");
    canvas.style.cursor = "";
    requestDraw();
  }

  return { init, requestDraw, fit, setZoom, setQuality, screenToComp, compToScreen, toggleGuides, currentScale, togglePenTool, isPenMode: () => penMode };
})();
