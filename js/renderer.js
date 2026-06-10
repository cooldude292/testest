/* ─── Lumen renderer: comp → canvas ────────────────────────────── */
"use strict";

const Renderer = (() => {
  let tmpCanvas = document.createElement("canvas");
  let tmpCtx = tmpCanvas.getContext("2d");
  let adjCanvas = document.createElement("canvas");
  let adjCtx = adjCanvas.getContext("2d");

  function ensureSize(w, h) {
    if (tmpCanvas.width !== w || tmpCanvas.height !== h) {
      tmpCanvas.width = w; tmpCanvas.height = h;
      adjCanvas.width = w; adjCanvas.height = h;
    }
  }

  /* Evaluated transform of a layer at time t */
  function evalT(layer, t) {
    const p = layer.props;
    return {
      pos: evalProp(p.position, t),
      scale: evalProp(p.scale, t),
      rot: evalProp(p.rotation, t),
      opacity: evalProp(p.opacity, t),
      anchor: evalProp(p.anchor, t),
    };
  }

  function filterString(layer) {
    const parts = [];
    for (const fx of layer.effects) {
      if (!fx.enabled) continue;
      const def = EFFECTS[fx.type];
      if (def) parts.push(def.css(fx.params));
    }
    return parts.length ? parts.join(" ") : "none";
  }

  function isActive(layer, t) {
    return layer.visible && t >= layer.inPoint && t < layer.outPoint + 1e-9;
  }

  /* Draw layer content centred on local origin */
  function drawContent(ctx, layer, t) {
    const d = layer.data;
    switch (layer.type) {
      case "solid": {
        ctx.fillStyle = d.color;
        ctx.fillRect(-d.w / 2, -d.h / 2, d.w, d.h);
        break;
      }
      case "text": {
        ctx.font = `${d.weight} ${d.size}px ${d.font}`;
        ctx.fillStyle = d.color;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const lines = String(d.text || "").split("\n");
        const lh = d.size * (d.lineHeight || 1.2);
        const y0 = -((lines.length - 1) / 2) * lh;
        if (d.tracking) ctx.letterSpacing = `${d.tracking}px`;
        lines.forEach((line, i) => ctx.fillText(line, 0, y0 + i * lh));
        if (d.tracking) ctx.letterSpacing = "0px";
        break;
      }
      case "shape": {
        const w = d.w, h = d.h;
        ctx.beginPath();
        if (d.shape === "rect") {
          const r = clamp(d.radius || 0, 0, Math.min(w, h) / 2);
          if (ctx.roundRect) ctx.roundRect(-w / 2, -h / 2, w, h, r);
          else ctx.rect(-w / 2, -h / 2, w, h);
        } else if (d.shape === "ellipse") {
          ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2);
        } else if (d.shape === "polygon" || d.shape === "star") {
          const n = Math.max(3, d.points | 0);
          const R = Math.min(w, h) / 2;
          const r = R * clamp(d.inset || 0.5, 0.05, 0.95);
          const steps = d.shape === "star" ? n * 2 : n;
          for (let i = 0; i < steps; i++) {
            const rad = d.shape === "star" ? (i % 2 === 0 ? R : r) : R;
            const a = (i / steps) * Math.PI * 2 - Math.PI / 2;
            const x = Math.cos(a) * rad, y = Math.sin(a) * rad;
            i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
          }
          ctx.closePath();
        }
        if (d.fill) { ctx.fillStyle = d.fill; ctx.fill(); }
        if (d.stroke && d.strokeWidth > 0) {
          ctx.strokeStyle = d.stroke; ctx.lineWidth = d.strokeWidth; ctx.stroke();
        }
        break;
      }
      case "image": case "video": {
        const a = Assets.find(d.assetId);
        if (a && a.el) {
          const w = a.el.naturalWidth || a.el.videoWidth, h = a.el.naturalHeight || a.el.videoHeight;
          if (w) {
            if (layer.type === "video") syncVideo(a.el, t - layer.inPoint);
            try { ctx.drawImage(a.el, -w / 2, -h / 2); } catch (e) { /* video not ready */ }
            break;
          }
        }
        // missing media placeholder
        ctx.fillStyle = "#1b1d22";
        ctx.fillRect(-200, -150, 400, 300);
        ctx.strokeStyle = "#3a3d44"; ctx.lineWidth = 2;
        ctx.strokeRect(-200, -150, 400, 300);
        ctx.fillStyle = "#5e636e"; ctx.font = "500 22px Inter, sans-serif";
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText("Missing media", 0, 0);
        break;
      }
      case "null": break; // adjustment layers draw nothing themselves
    }
  }

  function syncVideo(el, localT) {
    if (App.playing) {
      if (el.paused) { el.currentTime = clamp(localT, 0, el.duration || 0); el.play().catch(() => {}); }
    } else {
      if (!el.paused) el.pause();
      const want = clamp(localT, 0, (el.duration || 0) - 0.001);
      if (Math.abs(el.currentTime - want) > 0.06) el.currentTime = want;
    }
  }

  function pauseAllVideos() {
    (App.project.assets || []).forEach(a => {
      if (a.type === "video" && a.el && !a.el.paused) a.el.pause();
    });
  }

  /* Render the whole comp at time t into ctx (which must be comp-sized) */
  function draw(ctx, t) {
    const c = App.comp;
    ensureSize(c.width, c.height);
    ctx.save();
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.fillStyle = c.bg;
    ctx.fillRect(0, 0, c.width, c.height);

    for (let i = App.layers.length - 1; i >= 0; i--) {
      const layer = App.layers[i];
      if (!isActive(layer, t)) continue;
      const tr = evalT(layer, t);
      if (tr.opacity <= 0) continue;

      if (layer.type === "null") {
        // adjustment layer: filter everything rendered so far
        const f = filterString(layer);
        if (f !== "none") {
          adjCtx.clearRect(0, 0, c.width, c.height);
          adjCtx.drawImage(ctx.canvas, 0, 0);
          ctx.save();
          ctx.globalAlpha = clamp(tr.opacity / 100, 0, 1);
          ctx.filter = f;
          ctx.drawImage(adjCanvas, 0, 0);
          ctx.restore();
        }
        continue;
      }

      // render layer into temp buffer with its transform
      tmpCtx.clearRect(0, 0, c.width, c.height);
      tmpCtx.save();
      tmpCtx.translate(tr.pos[0], tr.pos[1]);
      tmpCtx.rotate((tr.rot * Math.PI) / 180);
      tmpCtx.scale(tr.scale[0] / 100, tr.scale[1] / 100);
      tmpCtx.translate(-tr.anchor[0], -tr.anchor[1]);
      drawContent(tmpCtx, layer, t);
      tmpCtx.restore();

      ctx.save();
      ctx.globalAlpha = clamp(tr.opacity / 100, 0, 1);
      ctx.globalCompositeOperation = layer.blend || "source-over";
      ctx.filter = filterString(layer);
      ctx.drawImage(tmpCanvas, 0, 0);
      ctx.restore();
    }
    ctx.restore();
  }

  /* World-space corners of a layer's content box at time t */
  function corners(layer, t) {
    const tr = evalT(layer, t);
    const [w, h] = contentSize(layer);
    const cos = Math.cos((tr.rot * Math.PI) / 180), sin = Math.sin((tr.rot * Math.PI) / 180);
    const sx = tr.scale[0] / 100, sy = tr.scale[1] / 100;
    const pts = [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]];
    return pts.map(([lx, ly]) => {
      const x = (lx - tr.anchor[0]) * sx, y = (ly - tr.anchor[1]) * sy;
      return [tr.pos[0] + x * cos - y * sin, tr.pos[1] + x * sin + y * cos];
    });
  }

  /* Map a comp-space point into a layer's local content space */
  function toLocal(layer, t, mx, my) {
    const tr = evalT(layer, t);
    const r = (-tr.rot * Math.PI) / 180;
    let dx = mx - tr.pos[0], dy = my - tr.pos[1];
    let rx = dx * Math.cos(r) - dy * Math.sin(r);
    let ry = dx * Math.sin(r) + dy * Math.cos(r);
    const sx = tr.scale[0] / 100 || 1e-6, sy = tr.scale[1] / 100 || 1e-6;
    rx /= sx; ry /= sy;
    return [rx + tr.anchor[0], ry + tr.anchor[1]];
  }

  /* Topmost layer under a comp-space point */
  function hitTest(t, mx, my) {
    for (const layer of App.layers) {
      if (!isActive(layer, t) || layer.locked || layer.type === "null") continue;
      const [w, h] = contentSize(layer);
      const [lx, ly] = toLocal(layer, t, mx, my);
      if (Math.abs(lx) <= w / 2 && Math.abs(ly) <= h / 2) return layer;
    }
    return null;
  }

  return { draw, evalT, corners, toLocal, hitTest, isActive, pauseAllVideos };
})();
