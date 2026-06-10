/* ─── Lumen renderer: comp → canvas ────────────────────────────── */
"use strict";

const Renderer = (() => {
  /* buffer pools, one set per recursion depth */
  const pools = [];
  function getPool(depth, w, h) {
    if (!pools[depth]) {
      pools[depth] = {};
      ["tmp", "aux", "aux2", "mask", "out"].forEach(k => {
        pools[depth][k] = document.createElement("canvas");
        pools[depth][k + "Ctx"] = pools[depth][k].getContext("2d", { willReadFrequently: k === "aux" });
      });
    }
    const p = pools[depth];
    ["tmp", "aux", "aux2", "mask", "out"].forEach(k => {
      if (p[k].width !== w || p[k].height !== h) { p[k].width = w; p[k].height = h; }
    });
    return p;
  }

  let noiseCanvas = null, noiseSeed = 0;
  function getNoise() {
    if (!noiseCanvas) {
      noiseCanvas = document.createElement("canvas");
      noiseCanvas.width = noiseCanvas.height = 128;
    }
    const nctx = noiseCanvas.getContext("2d");
    const img = nctx.createImageData(128, 128);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = Math.random() * 255;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    nctx.putImageData(img, 0, 0);
    return noiseCanvas;
  }

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

  function evalFx(fx, t) {
    const out = {};
    for (const k in fx.params) out[k] = evalProp(fx.params[k], t);
    return out;
  }

  function filterString(layer, t) {
    const parts = [];
    for (const fx of layer.effects) {
      if (!fx.enabled) continue;
      const def = EFFECTS[fx.type];
      if (def && def.css) parts.push(def.css(evalFx(fx, t)));
    }
    return parts.length ? parts.join(" ") : "none";
  }

  function isActive(layer, t, ignoreVisible) {
    return (ignoreVisible || layer.visible) && t >= layer.inPoint && t < layer.outPoint + 1e-9;
  }

  /* ── content drawing (layer-local space, centred on origin) ── */
  function fillStyleFor(ctx, d, w, h, isShape) {
    const c1 = isShape ? d.fill : d.color;
    const type = d.fillType || "solid";
    if (type === "solid" || !d.color2 && !d.fill2) return c1;
    const c2 = isShape ? (d.fill2 || c1) : (d.color2 || c1);
    if (type === "radial") {
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, Math.max(w, h) / 2);
      g.addColorStop(0, c1); g.addColorStop(1, c2);
      return g;
    }
    if (type === "linear") {
      const a = ((d.gradAngle || 0) * Math.PI) / 180;
      const r = Math.max(w, h) / 2;
      const g = ctx.createLinearGradient(-Math.cos(a) * r, -Math.sin(a) * r, Math.cos(a) * r, Math.sin(a) * r);
      g.addColorStop(0, c1); g.addColorStop(1, c2);
      return g;
    }
    return c1;
  }

  function drawText(ctx, layer, t) {
    const d = layer.data;
    ctx.font = `${d.weight} ${d.size}px ${d.font}`;
    ctx.textBaseline = "middle";
    const txt = d.caps ? String(d.text || "").toUpperCase() : String(d.text || "");
    const lines = txt.split("\n");
    const lh = d.size * (d.lineHeight || 1.2);
    const y0 = -((lines.length - 1) / 2) * lh;
    const [W] = contentSize(layer);
    if (d.tracking) ctx.letterSpacing = `${d.tracking}px`;

    // reveal animator progress 0..1 within [revealStart, revealStart+revealDur] after inPoint
    let prog = 1;
    if (d.reveal && d.reveal !== "none") {
      const local = t - layer.inPoint - (d.revealStart || 0);
      prog = clamp(local / Math.max(0.01, d.revealDur || 1), 0, 1);
    }
    const totalChars = lines.reduce((n, l) => n + l.length, 0) || 1;
    let drawnChars = 0;

    lines.forEach((line, li) => {
      const y = y0 + li * lh;
      let x;
      const lineW = _measureCtx.measureText ? (() => {
        _measureCtx.font = ctx.font;
        return _measureCtx.measureText(line).width + (d.tracking || 0) * Math.max(0, line.length - 1);
      })() : 0;
      if (d.align === "left") { ctx.textAlign = "left"; x = -W / 2; }
      else if (d.align === "right") { ctx.textAlign = "right"; x = W / 2; }
      else { ctx.textAlign = "center"; x = 0; }

      const paint = (str, px) => {
        ctx.fillStyle = d.color;
        ctx.fillText(str, px, y);
        if (d.strokeWidth > 0) {
          ctx.strokeStyle = d.strokeColor || "#000";
          ctx.lineWidth = d.strokeWidth;
          ctx.lineJoin = "round";
          ctx.strokeText(str, px, y);
        }
      };

      if (!d.reveal || d.reveal === "none" || prog >= 1) {
        paint(line, x);
      } else if (d.reveal === "typewriter") {
        const visible = Math.floor(prog * totalChars);
        const n = clamp(visible - drawnChars, 0, line.length);
        paint(line.slice(0, n), d.align === "center" ? -lineW / 2 + 0 : x);
        if (d.align === "center") {
          // left-anchor partial line so it types outward naturally
          ctx.textAlign = "left";
          ctx.clearRect; // no-op, keep alignment handling simple
        }
      } else {
        // per-character fade / rise
        ctx.save();
        ctx.textAlign = "left";
        let cx = d.align === "left" ? -W / 2 : d.align === "right" ? W / 2 - lineW : -lineW / 2;
        for (let i = 0; i < line.length; i++) {
          const charProg = clamp((prog * (totalChars + 6) - (drawnChars + i)) / 6, 0, 1);
          const chW = _measureCtx.measureText(line[i]).width + (d.tracking || 0);
          if (charProg > 0) {
            ctx.globalAlpha = charProg;
            const dy = d.reveal === "risechar" ? (1 - charProg) * d.size * 0.5 : 0;
            ctx.fillStyle = d.color;
            ctx.fillText(line[i], cx, y + dy);
            if (d.strokeWidth > 0) {
              ctx.strokeStyle = d.strokeColor || "#000";
              ctx.lineWidth = d.strokeWidth;
              ctx.strokeText(line[i], cx, y + dy);
            }
          }
          cx += chW;
        }
        ctx.restore();
      }
      drawnChars += line.length;
    });
    if (d.tracking) ctx.letterSpacing = "0px";
  }

  function drawContent(ctx, layer, t, opts) {
    const d = layer.data;
    switch (layer.type) {
      case "solid": {
        ctx.fillStyle = fillStyleFor(ctx, d, d.w, d.h, false);
        ctx.fillRect(-d.w / 2, -d.h / 2, d.w, d.h);
        break;
      }
      case "text": drawText(ctx, layer, t); break;
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
        if (d.fill) { ctx.fillStyle = fillStyleFor(ctx, d, w, h, true); ctx.fill(); }
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
            if (layer.type === "video") syncVideo(a.el, layer, t);
            try { ctx.drawImage(a.el, -w / 2, -h / 2); } catch (e) { /* not ready */ }
            break;
          }
        }
        ctx.fillStyle = "#1b1d22";
        ctx.fillRect(-200, -150, 400, 300);
        ctx.strokeStyle = "#3a3d44"; ctx.lineWidth = 2;
        ctx.strokeRect(-200, -150, 400, 300);
        ctx.fillStyle = "#5e636e"; ctx.font = "500 22px Inter, sans-serif";
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText("Missing media", 0, 0);
        break;
      }
      case "comp": {
        const inner = Comps.find(d.compId);
        if (!inner || (opts.visited && opts.visited.has(inner.id)) || (opts.depth || 0) > 5) break;
        const q = opts.scale || 1;
        const nt = clamp(mediaTime(layer, t), 0, inner.duration);
        const pool = getPool((opts.depth || 0) + 1, Math.max(2, Math.round(inner.width * q)), Math.max(2, Math.round(inner.height * q)));
        const visited = new Set(opts.visited || []);
        visited.add(inner.id);
        drawComp(pool.outCtx, inner, nt, { scale: q, depth: (opts.depth || 0) + 1, visited });
        ctx.drawImage(pool.out, -inner.width / 2, -inner.height / 2, inner.width, inner.height);
        break;
      }
      case "adjust": case "nullobj": case "audio": break;
    }
  }

  function syncVideo(el, layer, t) {
    const localT = mediaTime(layer, t);
    if (App.playing) {
      el.playbackRate = clamp((App.speed || 1) * 100 / (layer.stretch || 100), 0.25, 4);
      if (el.paused && !layer.reverse) { el.currentTime = clamp(localT, 0, el.duration || 0); el.play().catch(() => {}); }
      if (layer.reverse) { // reverse playback: seek per frame
        const want = clamp(localT, 0, (el.duration || 0) - 0.001);
        if (Math.abs(el.currentTime - want) > 0.06) el.currentTime = want;
      }
    } else {
      if (!el.paused) el.pause();
      const want = clamp(localT, 0, (el.duration || 0) - 0.001);
      if (Math.abs(el.currentTime - want) > 0.06) el.currentTime = want;
    }
  }

  function pauseAllVideos() {
    (App.project.assets || []).forEach(a => {
      if ((a.type === "video" || a.type === "audio") && a.el && !a.el.paused) a.el.pause();
    });
  }

  /* ── op effects (buffer-space) ── */
  function applyOps(buf, bctx, pool, layer, t, q) {
    const W = buf.width, H = buf.height;
    for (const fx of layer.effects) {
      if (!fx.enabled) continue;
      const def = EFFECTS[fx.type];
      if (!def || !def.op) continue;
      const p = evalFx(fx, t);
      const aux = pool.aux2, actx = pool.aux2Ctx;

      switch (def.op) {
        case "glow": {
          actx.clearRect(0, 0, W, H);
          actx.save();
          actx.filter = `blur(${p.radius * q}px) brightness(${p.intensity}%)`;
          actx.drawImage(buf, 0, 0);
          actx.restore();
          bctx.save();
          bctx.globalCompositeOperation = "lighter";
          bctx.drawImage(aux, 0, 0);
          bctx.restore();
          break;
        }
        case "tint": case "fill": {
          actx.clearRect(0, 0, W, H);
          actx.drawImage(buf, 0, 0);
          actx.save();
          actx.globalCompositeOperation = "source-in";
          actx.fillStyle = fx.color || "#fff";
          actx.fillRect(0, 0, W, H);
          actx.restore();
          bctx.save();
          bctx.globalAlpha = clamp(p.amount / 100, 0, 1);
          bctx.drawImage(aux, 0, 0);
          bctx.restore();
          break;
        }
        case "vignette": {
          bctx.save();
          bctx.globalCompositeOperation = "source-atop";
          const r = Math.hypot(W, H) / 2;
          const g = bctx.createRadialGradient(W / 2, H / 2, r * clamp(p.size, 1, 200) / 150, W / 2, H / 2, r);
          g.addColorStop(0, "rgba(0,0,0,0)");
          g.addColorStop(1, `rgba(0,0,0,${clamp(p.amount / 100, 0, 1)})`);
          bctx.fillStyle = g;
          bctx.fillRect(0, 0, W, H);
          bctx.restore();
          break;
        }
        case "noise": {
          bctx.save();
          bctx.globalCompositeOperation = "overlay";
          bctx.globalAlpha = clamp(p.amount / 100, 0, 1);
          const pat = bctx.createPattern(getNoise(), "repeat");
          bctx.fillStyle = pat;
          bctx.fillRect(0, 0, W, H);
          bctx.restore();
          break;
        }
        case "pixelate": {
          const block = Math.max(1, p.size * q);
          if (block <= 1) break;
          const sw = Math.max(1, Math.round(W / block)), sh = Math.max(1, Math.round(H / block));
          actx.clearRect(0, 0, W, H);
          actx.imageSmoothingEnabled = false;
          actx.drawImage(buf, 0, 0, sw, sh);
          bctx.save();
          bctx.clearRect(0, 0, W, H);
          bctx.imageSmoothingEnabled = false;
          bctx.drawImage(aux, 0, 0, sw, sh, 0, 0, W, H);
          bctx.imageSmoothingEnabled = true;
          bctx.restore();
          break;
        }
        case "chroma": {
          const d = p.amount * q;
          if (d < 0.1) break;
          actx.clearRect(0, 0, W, H);
          actx.drawImage(buf, 0, 0);
          bctx.save();
          bctx.clearRect(0, 0, W, H);
          [["#ff0000", -d], ["#00ff00", 0], ["#0000ff", d]].forEach(([col, dx]) => {
            const m = pool.mask, mctx = pool.maskCtx;
            mctx.clearRect(0, 0, W, H);
            mctx.drawImage(aux, 0, 0);
            mctx.save();
            mctx.globalCompositeOperation = "multiply";
            mctx.fillStyle = col;
            mctx.fillRect(0, 0, W, H);
            mctx.restore();
            mctx.save();
            mctx.globalCompositeOperation = "destination-in";
            mctx.drawImage(aux, 0, 0);
            mctx.restore();
            bctx.globalCompositeOperation = "lighter";
            bctx.drawImage(m, dx, 0);
          });
          bctx.restore();
          break;
        }
        case "linearwipe": {
          const c = clamp(p.completion / 100, 0, 1);
          if (c <= 0) break;
          const a = ((p.angle - 90) * Math.PI) / 180;
          const dx = Math.cos(a), dy = Math.sin(a);
          const corners = [[0, 0], [W, 0], [0, H], [W, H]];
          const projs = corners.map(([x, y]) => x * dx + y * dy);
          const pmin = Math.min(...projs), pmax = Math.max(...projs);
          const cut = pmin + (pmax - pmin) * c;
          const f = Math.max(0.01, p.feather * q);
          const g = bctx.createLinearGradient(dx * (cut - f), dy * (cut - f), dx * cut, dy * cut);
          g.addColorStop(0, "rgba(0,0,0,0)");
          g.addColorStop(1, "rgba(0,0,0,1)");
          bctx.save();
          bctx.globalCompositeOperation = "destination-out";
          // fill the fully-wiped half plus the feather ramp
          bctx.fillStyle = g;
          bctx.fillRect(0, 0, W, H);
          bctx.restore();
          break;
        }
        case "circwipe": {
          const c = clamp(p.completion / 100, 0, 1);
          if (c <= 0) break;
          const maxR = Math.hypot(W, H) / 2;
          const R = (1 - c) * maxR;
          const f = Math.max(0.01, p.feather * q);
          const g = bctx.createRadialGradient(W / 2, H / 2, Math.max(0, R - f), W / 2, H / 2, Math.max(0.01, R));
          g.addColorStop(0, "rgba(0,0,0,0)");
          g.addColorStop(1, "rgba(0,0,0,1)");
          bctx.save();
          bctx.globalCompositeOperation = "destination-out";
          bctx.fillStyle = g;
          bctx.fillRect(0, 0, W, H);
          // fully remove beyond R
          bctx.beginPath();
          bctx.rect(0, 0, W, H);
          bctx.arc(W / 2, H / 2, Math.max(0.01, R), 0, Math.PI * 2, true);
          bctx.fill();
          bctx.restore();
          break;
        }
      }
    }
  }

  /* ── masks ── */
  function applyMasks(buf, bctx, pool, layer, t, q) {
    if (!layer.masks.length) return;
    const W = buf.width, H = buf.height;
    const mctx = pool.maskCtx;
    mctx.clearRect(0, 0, W, H);
    const M = worldMatrix(layer, t);
    layer.masks.forEach(mask => {
      mctx.save();
      mctx.setTransform(q * M[0], q * M[1], q * M[2], q * M[3], q * M[4], q * M[5]);
      if (mask.feather > 0) mctx.filter = `blur(${mask.feather * q}px)`;
      mctx.globalCompositeOperation = mask.mode === "subtract" ? "destination-out" : "source-over";
      mctx.fillStyle = "#fff";
      mctx.beginPath();
      if (mask.shape === "ellipse") mctx.ellipse(mask.x, mask.y, mask.w / 2, mask.h / 2, 0, 0, Math.PI * 2);
      else mctx.rect(mask.x - mask.w / 2, mask.y - mask.h / 2, mask.w, mask.h);
      mctx.fill();
      mctx.restore();
    });
    bctx.save();
    bctx.globalCompositeOperation = "destination-in";
    bctx.setTransform(1, 0, 0, 1, 0, 0);
    bctx.drawImage(pool.mask, 0, 0);
    bctx.restore();
  }

  /* render one layer (content+transform+masks+ops) into pool.tmp */
  function renderLayerBuffer(pool, layer, comp, t, opts) {
    const q = opts.scale || 1;
    const buf = pool.tmp, bctx = pool.tmpCtx;
    const W = buf.width, H = buf.height;
    bctx.save();
    bctx.setTransform(1, 0, 0, 1, 0, 0);
    bctx.clearRect(0, 0, W, H);
    bctx.restore();

    const mb = comp.motionBlur && layer.motionBlur;
    const samples = mb ? 6 : 1;
    const shutter = 0.5 / comp.fps;
    for (let s = 0; s < samples; s++) {
      const ts = samples === 1 ? t : t - shutter / 2 + (shutter * s) / (samples - 1);
      const M = worldMatrix(layer, ts);
      bctx.save();
      bctx.globalAlpha = 1 / samples;
      bctx.setTransform(q * M[0], q * M[1], q * M[2], q * M[3], q * M[4], q * M[5]);
      drawContent(bctx, layer, t, opts);
      bctx.restore();
    }
    applyMasks(buf, bctx, pool, layer, t, q);
    applyOps(buf, bctx, pool, layer, t, q);
    return buf;
  }

  /* render matte source layer into pool.aux; returns aux */
  function renderMatte(pool, layer, comp, t, opts) {
    const q = opts.scale || 1;
    const buf = pool.aux, bctx = pool.auxCtx;
    bctx.save();
    bctx.setTransform(1, 0, 0, 1, 0, 0);
    bctx.clearRect(0, 0, buf.width, buf.height);
    const M = worldMatrix(layer, t);
    bctx.globalAlpha = clamp(evalProp(layer.props.opacity, t) / 100, 0, 1);
    bctx.setTransform(q * M[0], q * M[1], q * M[2], q * M[3], q * M[4], q * M[5]);
    drawContent(bctx, layer, t, opts);
    bctx.restore();
    applyMasks(buf, bctx, pool, layer, t, q);
    return buf;
  }

  function lumaToAlpha(buf, bctx, invert) {
    const W = buf.width, H = buf.height;
    const img = bctx.getImageData(0, 0, W, H);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      let luma = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
      luma *= d[i + 3] / 255;
      d[i + 3] = (invert ? 1 - luma : luma) * 255;
    }
    bctx.putImageData(img, 0, 0);
  }

  /* ── main comp render ── */
  function drawComp(ctx, comp, t, opts = {}) {
    const q = opts.scale || 1;
    const depth = opts.depth || 0;
    const W = Math.max(2, Math.round(comp.width * q));
    const H = Math.max(2, Math.round(comp.height * q));
    const pool = getPool(depth, W, H);

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    if (!comp.bgAlpha) {
      ctx.fillStyle = comp.bg;
      ctx.fillRect(0, 0, W, H);
    }

    const layers = comp.layers;
    const soloSet = new Set(layers.filter(l => l.solo).map(l => l.id));
    const consumed = new Set();
    layers.forEach((l, i) => {
      if (l.matte !== "none" && layers[i - 1]) consumed.add(layers[i - 1].id);
    });

    for (let i = layers.length - 1; i >= 0; i--) {
      const layer = layers[i];
      if (layer.type === "audio" || layer.type === "nullobj") continue;
      if (consumed.has(layer.id)) continue;
      if (soloSet.size && !soloSet.has(layer.id)) continue;
      if (!isActive(layer, t)) continue;
      const opacity = evalProp(layer.props.opacity, t);
      if (opacity <= 0) continue;

      if (layer.type === "adjust") {
        const f = filterString(layer, t);
        const hasOps = layer.effects.some(fx => fx.enabled && EFFECTS[fx.type] && EFFECTS[fx.type].op);
        if (f === "none" && !hasOps) continue;
        const actx = pool.auxCtx;
        actx.save();
        actx.setTransform(1, 0, 0, 1, 0, 0);
        actx.clearRect(0, 0, W, H);
        actx.filter = f;
        actx.drawImage(ctx.canvas, 0, 0, W, H, 0, 0, W, H);
        actx.restore();
        // op effects on the filtered frame copy (treated as full-frame layer)
        const fakePool = { ...pool, tmp: pool.aux, tmpCtx: pool.auxCtx };
        applyOps(pool.aux, pool.auxCtx, fakePool, layer, t, q);
        if (layer.masks.length) applyMasks(pool.aux, pool.auxCtx, pool, layer, t, q);
        ctx.save();
        ctx.globalAlpha = clamp(opacity / 100, 0, 1);
        ctx.drawImage(pool.aux, 0, 0);
        ctx.restore();
        continue;
      }

      const buf = renderLayerBuffer(pool, layer, comp, t, opts);

      // track matte
      if (layer.matte !== "none" && layers[i - 1]) {
        const matteLayer = layers[i - 1];
        if (isActive(matteLayer, t, true)) {
          const mbuf = renderMatte(pool, matteLayer, comp, t, opts);
          const inv = layer.matte.endsWith("-inv");
          if (layer.matte.startsWith("luma")) lumaToAlpha(mbuf, pool.auxCtx, inv);
          const btx = pool.tmpCtx;
          btx.save();
          btx.setTransform(1, 0, 0, 1, 0, 0);
          btx.globalCompositeOperation = (layer.matte.startsWith("alpha") && inv) ? "destination-out" : "destination-in";
          btx.drawImage(mbuf, 0, 0);
          btx.restore();
        } else if (!layer.matte.endsWith("-inv")) {
          continue; // matte source inactive → alpha/luma matte yields nothing
        }
      }

      ctx.save();
      ctx.globalAlpha = clamp(opacity / 100, 0, 1);
      ctx.globalCompositeOperation = layer.blend || "source-over";
      ctx.filter = filterString(layer, t);
      ctx.drawImage(buf, 0, 0);
      ctx.restore();
    }
    ctx.restore();
  }

  /* convenience: render active comp */
  function draw(ctx, t, opts = {}) {
    drawComp(ctx, App.comp, t, opts);
  }

  /* ── geometry helpers (comp space) ── */
  function corners(layer, t) {
    const M = worldMatrix(layer, t);
    const [w, h] = contentSize(layer);
    return [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]]
      .map(([x, y]) => matApply(M, x, y));
  }

  function toLocal(layer, t, mx, my) {
    return matApply(matInvert(worldMatrix(layer, t)), mx, my);
  }

  function hitTest(t, mx, my) {
    const selIds = App.selectedIds();
    for (const layer of App.layers) {
      if (layer.locked || layer.type === "audio") continue;
      const ghost = layer.type === "adjust" || layer.type === "nullobj";
      if (ghost && !selIds.includes(layer.id)) continue;
      if (!isActive(layer, t, ghost)) continue;
      const [w, h] = contentSize(layer);
      if (w <= 0) continue;
      const [lx, ly] = toLocal(layer, t, mx, my);
      if (Math.abs(lx) <= w / 2 && Math.abs(ly) <= h / 2) return layer;
    }
    return null;
  }

  return { draw, drawComp, evalT, evalFx, corners, toLocal, hitTest, isActive, pauseAllVideos, filterString };
})();
