/* ─── Lumen app shell: playback, shortcuts, palette, export ────── */
"use strict";

/* ── playback ── */
const Playback = (() => {
  let lastTs = null;

  function loop(ts) {
    if (App.playing) {
      if (lastTs !== null) {
        const c = App.comp;
        let t = App.time + ((ts - lastTs) / 1000) * App.speed;
        const end = c.workEnd > c.workStart + 0.05 ? c.workEnd : c.duration;
        const start = c.workEnd > c.workStart + 0.05 ? c.workStart : 0;
        if (t >= end) {
          if (App.loop) t = start;
          else { t = end; App.setPlaying(false); Renderer.pauseAllVideos(); AudioEngine.pauseAll(); }
        }
        App.setTime(t, { playback: true });
        AudioEngine.sync();
      }
      lastTs = ts;
    } else {
      lastTs = null;
    }
    requestAnimationFrame(loop);
  }

  function toggle() {
    App.setPlaying(!App.playing);
    if (!App.playing) { Renderer.pauseAllVideos(); AudioEngine.pauseAll(); }
    else AudioEngine.sync();
  }

  function step(frames) {
    App.setPlaying(false);
    Renderer.pauseAllVideos();
    AudioEngine.pauseAll();
    const fps = App.comp.fps;
    App.setTime(clamp(snapT(Math.round(App.time * fps + frames) / fps), 0, App.comp.duration));
  }

  requestAnimationFrame(loop);
  return { toggle, step };
})();

/* ── clipboard (layers, keyframes, effects) ── */
const UIClipboard = {
  layers: null, keys: null, effects: null,

  copyLayers() {
    const sel = App.selectedLayers();
    if (!sel.length) return;
    this.layers = JSON.stringify(sel);
    toast(`Copied ${sel.length} layer${sel.length > 1 ? "s" : ""}`);
  },
  pasteLayers() {
    if (!this.layers) return;
    App.commit();
    const arr = JSON.parse(this.layers);
    const idMap = {};
    arr.forEach(l => { idMap[l.id] = uid(); });
    arr.forEach(l => {
      l.id = idMap[l.id];
      if (l.parent && idMap[l.parent]) l.parent = idMap[l.parent];
      else l.parent = null;
      l.effects.forEach(fx => fx.id = uid());
      l.masks.forEach(m => m.id = uid());
      l.inPoint = clamp(l.inPoint, 0, App.comp.duration);
      l.outPoint = clamp(l.outPoint, l.inPoint + 0.05, App.comp.duration);
    });
    App.layers.unshift(...arr);
    App.selection = arr[0].id;
    App.selExtra = new Set(arr.slice(1).map(l => l.id));
    App.emit("project");
    App.emit("selection");
  },

  copyKeys(targets) {
    const list = targets || App.selectedKeys;
    if (!list.length) { toast("No keyframes selected"); return; }
    const t0 = Math.min(...list.map(s => s.key.t));
    this.keys = list.map(s => ({ p: s.p, dt: s.key.t - t0, v: cloneVal(s.key.v), ease: s.key.ease }));
    toast(`Copied ${list.length} keyframe${list.length > 1 ? "s" : ""}`);
  },
  pasteKeys() {
    if (!this.keys || !this.keys.length) { toast("Keyframe clipboard is empty"); return; }
    App.commit();
    this.keys.forEach(k => {
      if (!k.p.anim) k.p.anim = true;
      Layers.upsertKeyObj(k.p, App.time + k.dt, k.v, k.ease);
    });
    App.emit("project");
    toast("Keyframes pasted at playhead");
  },

  copyEffects() {
    const l = App.selectedLayer();
    if (!l || !l.effects.length) { toast("No effects to copy"); return; }
    this.effects = JSON.stringify(l.effects);
    toast(`Copied ${l.effects.length} effect${l.effects.length > 1 ? "s" : ""}`);
  },
  pasteEffects() {
    const l = App.selectedLayer();
    if (!l || !this.effects) return;
    App.commit();
    const arr = JSON.parse(this.effects);
    arr.forEach(fx => fx.id = uid());
    l.effects.push(...arr);
    App.emit("project");
    toast("Effects pasted");
  },
};

/* ── layer commands ── */
const UICommands = {
  flip(layer, axis) {
    App.commit();
    const s = cloneVal(evalProp(layer.props.scale, App.time));
    if (axis === "h") s[0] = -s[0]; else s[1] = -s[1];
    Layers.setProp(layer, "scale", s);
    App.emit("project");
  },
  resetTransform(layer) {
    App.commit();
    const c = App.comp;
    ["position", "scale", "rotation", "opacity", "anchor"].forEach(n => {
      const p = layer.props[n];
      p.anim = false; p.keys = []; p.loop = "none"; p.wiggle = null;
    });
    layer.props.position.value = [c.width / 2, c.height / 2];
    layer.props.scale.value = [100, 100];
    layer.props.rotation.value = 0;
    layer.props.opacity.value = 100;
    layer.props.anchor.value = [0, 0];
    App.emit("project");
  },
  fitLayerToComp(layer) {
    App.commit();
    const c = App.comp;
    const [w, h] = contentSize(layer);
    if (w > 0 && h > 0) {
      const s = Math.min(c.width / w, c.height / h) * 100;
      Layers.setProp(layer, "scale", [Math.round(s * 10) / 10, Math.round(s * 10) / 10]);
      Layers.setProp(layer, "position", [c.width / 2, c.height / 2]);
    }
    App.emit("project");
  },
  sequenceLayers() {
    const sel = App.selectedLayers();
    const list = sel.length > 1 ? sel : App.layers.slice();
    if (list.length < 2) { toast("Need at least two layers"); return; }
    App.commit();
    let cursor = 0;
    [...list].reverse().forEach(l => {
      const len = l.outPoint - l.inPoint;
      l.inPoint = snapT(clamp(cursor, 0, App.comp.duration - 0.05));
      l.outPoint = snapT(clamp(cursor + len, l.inPoint + 0.05, App.comp.duration));
      cursor += len;
    });
    App.emit("project");
    toast("Layers sequenced");
  },
  easyEaseSelected() {
    if (!App.selectedKeys.length) { toast("No keyframes selected"); return; }
    App.commit();
    App.selectedKeys.forEach(s => s.key.ease = "easeInOut");
    App.emit("project");
    toast("Easy ease applied");
  },
  reverseKeys() {
    const props = new Set(App.selectedKeys.map(s => s.p));
    if (!props.size) { toast("No keyframes selected"); return; }
    App.commit();
    props.forEach(p => {
      if (p.keys.length < 2) return;
      const t0 = p.keys[0].t, t1 = p.keys[p.keys.length - 1].t;
      p.keys.forEach(k => k.t = t1 - (k.t - t0));
      p.keys.sort((a, b) => a.t - b.t);
    });
    App.emit("project");
    toast("Keyframes reversed");
  },
  nudge(dx, dy) {
    const sel = App.selectedLayers().filter(l => !l.locked && l.type !== "audio");
    if (!sel.length) return false;
    App.commit();
    sel.forEach(l => {
      const p = cloneVal(evalProp(l.props.position, App.time));
      Layers.setProp(l, "position", [p[0] + dx, p[1] + dy]);
    });
    App.emit("project");
    return true;
  },
  nudgeTime(frames) {
    const sel = App.selectedLayers().filter(l => !l.locked);
    if (!sel.length) return false;
    App.commit();
    const dt = frames / App.comp.fps;
    sel.forEach(l => {
      const len = l.outPoint - l.inPoint;
      l.inPoint = snapT(clamp(l.inPoint + dt, 0, App.comp.duration - len));
      l.outPoint = l.inPoint + len;
    });
    App.emit("project");
    return true;
  },
  trimToPlayhead(side) {
    const sel = App.selectedLayers().filter(l => !l.locked);
    if (!sel.length) return;
    App.commit();
    const t = snapT(App.time);
    sel.forEach(l => {
      if (side === "in" && t < l.outPoint) l.inPoint = t;
      if (side === "out" && t > l.inPoint) l.outPoint = t;
    });
    App.emit("project");
  },
  cycleBlend(dir) {
    const l = App.selectedLayer();
    if (!l) return;
    App.commit();
    const idx = BLEND_MODES.findIndex(([v]) => v === l.blend);
    const next = (idx + dir + BLEND_MODES.length) % BLEND_MODES.length;
    l.blend = BLEND_MODES[next][0];
    App.emit("project");
    toast(`Blend: ${BLEND_MODES[next][1]}`);
  },
  jumpKey(dir) {
    const l = App.selectedLayer();
    if (!l) return;
    let times = [];
    allAnimProps(l).forEach(({ p }) => { if (p.anim) times.push(...p.keys.map(k => k.t)); });
    times.push(...(App.comp.markers || []).map(m => m.t));
    times = [...new Set(times)].sort((a, b) => a - b);
    const t = App.time;
    const next = dir > 0 ? times.find(x => x > t + 1e-6) : [...times].reverse().find(x => x < t - 1e-6);
    if (next !== undefined) App.setTime(next);
  },
  jumpMarker(dir) {
    const ms = (App.comp.markers || []).map(m => m.t).sort((a, b) => a - b);
    const t = App.time;
    const next = dir > 0 ? ms.find(x => x > t + 1e-6) : [...ms].reverse().find(x => x < t - 1e-6);
    if (next !== undefined) App.setTime(next);
  },
};

/* ── minimal ZIP writer (store method) ── */
const Zip = (() => {
  const crcTable = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(data) {
    let c = 0xffffffff;
    for (let i = 0; i < data.length; i++) c = crcTable[(c ^ data[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  function build(entries) {
    const enc = new TextEncoder();
    const chunks = [], central = [];
    let offset = 0;
    entries.forEach(({ name, data }) => {
      const nameB = enc.encode(name);
      const crc = crc32(data);
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, data.length, true);
      local.setUint32(22, data.length, true);
      local.setUint16(26, nameB.length, true);
      chunks.push(new Uint8Array(local.buffer), nameB, data);
      const cd = new DataView(new ArrayBuffer(46));
      cd.setUint32(0, 0x02014b50, true);
      cd.setUint16(4, 20, true); cd.setUint16(6, 20, true);
      cd.setUint32(16, crc, true);
      cd.setUint32(20, data.length, true);
      cd.setUint32(24, data.length, true);
      cd.setUint16(28, nameB.length, true);
      cd.setUint32(42, offset, true);
      central.push(new Uint8Array(cd.buffer), nameB);
      offset += 30 + nameB.length + data.length;
    });
    let cdSize = 0;
    central.forEach(c => cdSize += c.length);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, entries.length, true);
    end.setUint16(10, entries.length, true);
    end.setUint32(12, cdSize, true);
    end.setUint32(16, offset, true);
    return new Blob([...chunks, ...central, new Uint8Array(end.buffer)], { type: "application/zip" });
  }
  return { build };
})();

/* ── export ── */
const Exporter = (() => {
  let recording = false, recorder = null, cancelled = false;

  function open() {
    document.getElementById("export-overlay").hidden = false;
    document.getElementById("export-progress").hidden = true;
    document.getElementById("export-start").disabled = false;
  }
  function close() {
    if (recording) stop(true);
    cancelled = true;
    document.getElementById("export-overlay").hidden = true;
  }

  function getOpts() {
    return {
      format: document.getElementById("export-format").value,
      bitrate: parseInt(document.getElementById("export-quality").value, 10),
      scale: parseFloat(document.getElementById("export-scale").value),
      range: document.getElementById("export-range").value,
    };
  }
  function rangeBounds(opts) {
    const c = App.comp;
    if (opts.range === "work" && c.workEnd > c.workStart + 0.05) return [c.workStart, c.workEnd];
    return [0, c.duration];
  }

  function makeCanvas(scale) {
    const c = App.comp;
    const cv = document.createElement("canvas");
    cv.width = Math.max(2, Math.round(c.width * scale));
    cv.height = Math.max(2, Math.round(c.height * scale));
    return cv;
  }

  function exportPNG(opts) {
    const cv = makeCanvas(opts.scale);
    Renderer.draw(cv.getContext("2d"), App.time, { scale: opts.scale });
    cv.toBlob(blob => {
      download(blob, `${App.project.name.replace(/\s+/g, "-")}-${timecode(App.time).replace(/:/g, ".")}.png`);
      toast("Frame exported");
      close();
    }, "image/png");
  }

  async function exportPNGSeq(opts) {
    const c = App.comp;
    const [t0, t1] = rangeBounds(opts);
    const frames = Math.max(1, Math.round((t1 - t0) * c.fps));
    const cv = makeCanvas(opts.scale);
    const cctx = cv.getContext("2d");
    const fill = document.getElementById("export-progress-fill");
    const label = document.getElementById("export-progress-label");
    document.getElementById("export-progress").hidden = false;
    document.getElementById("export-start").disabled = true;
    cancelled = false;
    const entries = [];
    for (let f = 0; f < frames; f++) {
      if (cancelled) return;
      const t = t0 + f / c.fps;
      Renderer.draw(cctx, t, { scale: opts.scale });
      const blob = await new Promise(res => cv.toBlob(res, "image/png"));
      const buf = new Uint8Array(await blob.arrayBuffer());
      entries.push({ name: `frame_${String(f).padStart(4, "0")}.png`, data: buf });
      fill.style.width = ((f + 1) / frames) * 100 + "%";
      label.textContent = `Rendering frame ${f + 1} / ${frames}`;
      await new Promise(r => setTimeout(r, 0));
    }
    label.textContent = "Building ZIP…";
    const zip = Zip.build(entries);
    download(zip, `${App.project.name.replace(/\s+/g, "-")}-frames.zip`);
    toast(`Exported ${frames} frames`);
    close();
  }

  function exportWebM(opts) {
    if (typeof MediaRecorder === "undefined") {
      toast("MediaRecorder not supported in this browser");
      return;
    }
    const c = App.comp;
    const [t0, t1] = rangeBounds(opts);
    const cv = makeCanvas(opts.scale);
    const cctx = cv.getContext("2d");
    const stream = cv.captureStream(c.fps);

    // mix audio layers into the recording
    let audioDest = null;
    const hasAudio = App.layers.some(l => l.type === "audio" && l.visible);
    if (hasAudio) {
      try {
        AudioEngine.ensure();
        audioDest = AudioEngine.ctx.createMediaStreamDestination();
        AudioEngine.masterGain.connect(audioDest);
        audioDest.stream.getAudioTracks().forEach(tr => stream.addTrack(tr));
      } catch (e) { audioDest = null; }
    }

    const mime = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"]
      .find(m => MediaRecorder.isTypeSupported(m)) || "video/webm";
    const chunks = [];
    recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: opts.bitrate });
    recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    recorder.onstop = () => {
      if (audioDest) { try { AudioEngine.masterGain.disconnect(audioDest); } catch (e) {} }
      AudioEngine.pauseAll();
      if (!recording) return;
      recording = false;
      const blob = new Blob(chunks, { type: "video/webm" });
      download(blob, `${App.project.name.replace(/\s+/g, "-")}.webm`);
      toast("Export complete");
      close();
    };

    App.setPlaying(false);
    Renderer.pauseAllVideos();
    recording = true;
    document.getElementById("export-progress").hidden = false;
    document.getElementById("export-start").disabled = true;

    const fill = document.getElementById("export-progress-fill");
    const label = document.getElementById("export-progress-label");
    const dur = t1 - t0;
    const start = performance.now();
    recorder.start(200);
    const wasPlaying = App.playing;
    App.playing = true; // make audio/video elements run during export
    AudioEngine.sync();

    (function frame() {
      if (!recording) { App.playing = wasPlaying; return; }
      const t = (performance.now() - start) / 1000;
      if (t >= dur) {
        Renderer.draw(cctx, t1, { scale: opts.scale });
        label.textContent = "Encoding…";
        fill.style.width = "100%";
        App.playing = false;
        recorder.stop();
        return;
      }
      Renderer.draw(cctx, t0 + t, { scale: opts.scale });
      App.time = t0 + t;
      App.emit("time", { playback: true });
      AudioEngine.sync();
      fill.style.width = (t / dur) * 100 + "%";
      label.textContent = `Rendering… ${timecode(t0 + t)} / ${timecode(t1)}`;
      requestAnimationFrame(frame);
    })();
  }

  function stop(wasCancelled) {
    recording = false;
    App.playing = false;
    AudioEngine.pauseAll();
    if (recorder && recorder.state !== "inactive") recorder.stop();
    recorder = null;
    if (wasCancelled) toast("Export cancelled");
  }

  function start() {
    const opts = getOpts();
    if (opts.format === "png") exportPNG(opts);
    else if (opts.format === "pngseq") exportPNGSeq(opts);
    else exportWebM(opts);
  }

  async function copyFrameToClipboard() {
    try {
      const cv = makeCanvas(1);
      Renderer.draw(cv.getContext("2d"), App.time, { scale: 1 });
      const blob = await new Promise(res => cv.toBlob(res, "image/png"));
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      toast("Frame copied to clipboard");
    } catch (e) {
      toast("Clipboard not available");
    }
  }

  function download(blob, name) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  return { open, close, start, download, copyFrameToClipboard };
})();

/* ── graph editor ── */
const GraphEditor = (() => {
  let prop = null, canvas, gctx;
  const PAD = { l: 44, r: 14, t: 14, b: 24 };

  function open(p, title) {
    if (!p.anim || !p.keys.length) { toast("Property has no keyframes"); return; }
    prop = p;
    document.getElementById("graph-overlay").hidden = false;
    document.getElementById("graph-title").textContent = title || "Graph editor";
    canvas = document.getElementById("graph-canvas");
    gctx = canvas.getContext("2d");
    render();
  }
  function close() {
    document.getElementById("graph-overlay").hidden = true;
    prop = null;
  }
  function isOpen() { return prop !== null; }

  function valueRange() {
    let lo = Infinity, hi = -Infinity;
    prop.keys.forEach(k => {
      const vs = Array.isArray(k.v) ? k.v : [k.v];
      vs.forEach(v => { lo = Math.min(lo, v); hi = Math.max(hi, v); });
    });
    if (!isFinite(lo)) { lo = 0; hi = 1; }
    if (hi - lo < 1e-6) { lo -= 1; hi += 1; }
    const pad = (hi - lo) * 0.15;
    return [lo - pad, hi + pad];
  }

  function xOf(t) { return PAD.l + (t / App.comp.duration) * (canvas.width - PAD.l - PAD.r); }
  function yOf(v, lo, hi) { return canvas.height - PAD.b - ((v - lo) / (hi - lo)) * (canvas.height - PAD.t - PAD.b); }
  function tOf(x) { return clamp(((x - PAD.l) / (canvas.width - PAD.l - PAD.r)) * App.comp.duration, 0, App.comp.duration); }
  function vOf(y, lo, hi) { return lo + ((canvas.height - PAD.b - y) / (canvas.height - PAD.t - PAD.b)) * (hi - lo); }

  function render() {
    if (!prop) return;
    const W = canvas.width, H = canvas.height;
    const [lo, hi] = valueRange();
    gctx.clearRect(0, 0, W, H);
    gctx.fillStyle = "#0f1011";
    gctx.fillRect(0, 0, W, H);

    // grid
    gctx.strokeStyle = "#1b1d22";
    gctx.fillStyle = "#5e636e";
    gctx.font = "10px ui-monospace, monospace";
    gctx.lineWidth = 1;
    gctx.beginPath();
    for (let i = 0; i <= 5; i++) {
      const v = lo + ((hi - lo) * i) / 5;
      const y = yOf(v, lo, hi);
      gctx.moveTo(PAD.l, y); gctx.lineTo(W - PAD.r, y);
      gctx.fillText((Math.round(v * 10) / 10).toString(), 4, y + 3);
    }
    for (let s = 0; s <= App.comp.duration; s++) {
      const x = xOf(s);
      gctx.moveTo(x, PAD.t); gctx.lineTo(x, H - PAD.b);
      gctx.fillText(s + "s", x + 2, H - 8);
    }
    gctx.stroke();

    // playhead
    gctx.strokeStyle = "#7c89f0";
    gctx.beginPath();
    const px = xOf(App.time);
    gctx.moveTo(px, PAD.t); gctx.lineTo(px, H - PAD.b);
    gctx.stroke();

    // curves per component
    const comps = Array.isArray(prop.keys[0].v) ? prop.keys[0].v.length : 1;
    const colors = ["#eb5757", "#4cb782", "#26b5ce"];
    for (let ci = 0; ci < comps; ci++) {
      gctx.strokeStyle = colors[ci % colors.length];
      gctx.lineWidth = 1.5;
      gctx.beginPath();
      const steps = 240;
      for (let i = 0; i <= steps; i++) {
        const t = (App.comp.duration * i) / steps;
        const v = rawEval(prop, t);
        const val = Array.isArray(v) ? v[ci] : v;
        const x = xOf(t), y = yOf(val, lo, hi);
        i === 0 ? gctx.moveTo(x, y) : gctx.lineTo(x, y);
      }
      gctx.stroke();
      // dots
      prop.keys.forEach(k => {
        const val = Array.isArray(k.v) ? k.v[ci] : k.v;
        const x = xOf(k.t), y = yOf(val, lo, hi);
        gctx.fillStyle = "#0f1011";
        gctx.strokeStyle = colors[ci % colors.length];
        gctx.beginPath();
        gctx.rect(x - 4, y - 4, 8, 8);
        gctx.fill(); gctx.stroke();
      });
    }
  }

  function hitKey(mx, my) {
    if (!prop) return null;
    const [lo, hi] = valueRange();
    const comps = Array.isArray(prop.keys[0].v) ? prop.keys[0].v.length : 1;
    for (const k of prop.keys) {
      for (let ci = 0; ci < comps; ci++) {
        const val = Array.isArray(k.v) ? k.v[ci] : k.v;
        if (Math.abs(mx - xOf(k.t)) < 7 && Math.abs(my - yOf(val, lo, hi)) < 7)
          return { key: k, ci };
      }
    }
    return null;
  }

  function init() {
    canvas = document.getElementById("graph-canvas");
    gctx = canvas.getContext("2d");
    document.getElementById("graph-close").addEventListener("click", close);
    document.getElementById("graph-overlay").addEventListener("pointerdown", e => {
      if (e.target.id === "graph-overlay") close();
    });

    canvas.addEventListener("pointerdown", e => {
      if (!prop) return;
      const rect = canvas.getBoundingClientRect();
      const mx = (e.clientX - rect.left) * (canvas.width / rect.width);
      const my = (e.clientY - rect.top) * (canvas.height / rect.height);
      const hit = hitKey(mx, my);
      if (!hit) {
        App.setTime(snapT(tOf(mx)));
        render();
        return;
      }
      App.commit();
      const [lo, hi] = valueRange();
      startDrag(e, {
        move(ev) {
          const x = (ev.clientX - rect.left) * (canvas.width / rect.width);
          const y = (ev.clientY - rect.top) * (canvas.height / rect.height);
          hit.key.t = snapT(tOf(x));
          const nv = vOf(y, lo, hi);
          if (Array.isArray(hit.key.v)) hit.key.v[hit.ci] = Math.round(nv * 10) / 10;
          else hit.key.v = Math.round(nv * 10) / 10;
          render();
          App.emit("props");
        },
        up() {
          prop.keys.sort((a, b) => a.t - b.t);
          App.emit("project");
          render();
        },
      });
    });
    canvas.addEventListener("contextmenu", e => {
      e.preventDefault();
      if (!prop) return;
      const rect = canvas.getBoundingClientRect();
      const mx = (e.clientX - rect.left) * (canvas.width / rect.width);
      const my = (e.clientY - rect.top) * (canvas.height / rect.height);
      const hit = hitKey(mx, my);
      if (!hit) return;
      const items = Object.keys(EASE_LABELS).map(ease => ({
        label: EASE_LABELS[ease],
        checked: hit.key.ease === ease,
        run: () => { App.commit(); hit.key.ease = ease; App.emit("project"); render(); },
      }));
      showMenu(e.clientX, e.clientY, items);
    });

    App.on("time", () => { if (isOpen()) render(); });
    App.on("project", () => { if (isOpen() && prop && (!prop.anim || !prop.keys.length)) close(); else if (isOpen()) render(); });
  }

  return { init, open, close, isOpen };
})();

/* ── comp tabs ── */
const CompTabs = (() => {
  function render() {
    const host = document.getElementById("comp-tabs");
    host.innerHTML = "";
    App.project.comps.forEach(c => {
      const tab = document.createElement("button");
      tab.className = "comp-tab" + (c.id === App.project.activeCompId ? " active" : "");
      tab.textContent = c.name;
      tab.title = `${c.width}×${c.height} · ${c.fps}fps`;
      tab.addEventListener("click", () => App.setActiveComp(c.id));
      tab.addEventListener("dblclick", () => {
        const name = prompt("Composition name:", c.name);
        if (name) { App.commit(); c.name = name; render(); App.emit("project"); }
      });
      tab.addEventListener("contextmenu", e => {
        e.preventDefault();
        showMenu(e.clientX, e.clientY, [
          { label: "Rename…", run: () => { const n = prompt("Composition name:", c.name); if (n) { App.commit(); c.name = n; render(); } } },
          { label: "Duplicate comp", run: () => {
            App.commit();
            const copy = JSON.parse(JSON.stringify(c));
            copy.id = uid(); copy.name = c.name + " copy";
            copy.layers.forEach(l => l.id = uid());
            App.project.comps.push(copy);
            render();
          } },
          "-",
          { label: "Delete comp", danger: true, run: () => {
            App.commit();
            if (!Comps.remove(c.id)) toast("Can't delete: comp is in use or is the last one");
          } },
        ]);
      });
      host.appendChild(tab);
    });
    const add = document.createElement("button");
    add.className = "comp-tab add";
    add.textContent = "+";
    add.title = "New composition";
    add.addEventListener("click", () => {
      App.commit();
      const src = App.comp;
      const c = Comps.create(null, src.width, src.height, src.fps, src.duration);
      App.setActiveComp(c.id);
    });
    host.appendChild(add);
  }
  function init() {
    App.on("comps", render);
    App.on("project", render);
  }
  return { init, render };
})();

/* ── command palette ── */
const Palette = (() => {
  let items = [], active = 0, filtered = [];

  function actions() {
    const sel = App.selectedLayer();
    const c = App.comp;
    return [
      { title: "New text layer", run: () => { App.commit(); Layers.add(makeLayer("text")); } },
      { title: "New solid layer", run: () => { App.commit(); Layers.add(makeLayer("solid")); } },
      { title: "New shape layer", run: () => { App.commit(); Layers.add(makeLayer("shape")); } },
      { title: "New adjustment layer", run: () => { App.commit(); Layers.add(makeLayer("adjust")); } },
      { title: "New null object", run: () => { App.commit(); Layers.add(makeLayer("nullobj")); } },
      { title: "New composition", run: () => { App.commit(); const cc = Comps.create(); App.setActiveComp(cc.id); } },
      { title: "Import media…", run: () => document.getElementById("file-import").click() },
      { title: "Play / Pause", hint: "Space", run: () => Playback.toggle() },
      { title: "Toggle loop playback", hint: "", run: () => { App.loop = !App.loop; toast(App.loop ? "Loop on" : "Loop off"); } },
      { title: "Go to start", hint: "Home", run: () => App.setTime(0) },
      { title: "Go to end", hint: "End", run: () => App.setTime(c.duration) },
      { title: "Add marker at playhead", hint: "M", run: () => Timeline.addMarker() },
      { title: "Next marker", hint: "⇧.", run: () => UICommands.jumpMarker(1) },
      { title: "Previous marker", hint: "⇧,", run: () => UICommands.jumpMarker(-1) },
      { title: "Set work area start", hint: "B", run: () => { App.commit(); c.workStart = Math.min(snapT(App.time), c.workEnd - 0.1); Timeline.drawRuler(); } },
      { title: "Set work area end", hint: "N", run: () => { App.commit(); c.workEnd = Math.max(snapT(App.time), c.workStart + 0.1); Timeline.drawRuler(); } },
      sel && { title: `Duplicate "${sel.name}"`, hint: "⌘D", run: () => { App.commit(); Layers.duplicate(sel.id); } },
      sel && { title: `Split "${sel.name}" at playhead`, run: () => { App.commit(); Layers.split(sel.id, snapT(App.time)); } },
      sel && { title: `Delete selected layer${App.selectedIds().length > 1 ? "s" : ""}`, hint: "⌫", run: () => { App.commit(); Layers.removeMany(App.selectedIds()); } },
      sel && { title: "Precompose selection", run: () => { App.commit(); Comps.precompose(); } },
      sel && { title: "Center layer in comp", run: () => { App.commit(); Layers.setProp(sel, "position", [c.width / 2, c.height / 2]); App.emit("project"); } },
      sel && { title: "Fit layer to comp", run: () => UICommands.fitLayerToComp(sel) },
      sel && { title: "Flip horizontal", run: () => UICommands.flip(sel, "h") },
      sel && { title: "Flip vertical", run: () => UICommands.flip(sel, "v") },
      sel && { title: "Reset transform", run: () => UICommands.resetTransform(sel) },
      sel && { title: "Copy layers", hint: "⌘C", run: () => UIClipboard.copyLayers() },
      { title: "Paste layers", hint: "⌘V", run: () => UIClipboard.pasteLayers() },
      sel && { title: "Copy effects", run: () => UIClipboard.copyEffects() },
      sel && { title: "Paste effects", run: () => UIClipboard.pasteEffects() },
      { title: "Paste keyframes at playhead", run: () => UIClipboard.pasteKeys() },
      { title: "Easy ease selected keyframes", hint: "F9", run: () => UICommands.easyEaseSelected() },
      { title: "Reverse selected keyframes", run: () => UICommands.reverseKeys() },
      { title: "Sequence layers (stagger)", run: () => UICommands.sequenceLayers() },
      { title: "Select all layers", hint: "⌘A", run: () => selectAll() },
      { title: "Toggle comp motion blur", run: () => { App.commit(); c.motionBlur = !c.motionBlur; App.emit("project"); } },
      { title: "Toggle transparent background", run: () => { App.commit(); c.bgAlpha = !c.bgAlpha; App.emit("project"); } },
      { title: "Fit viewport", hint: "F", run: () => Viewport.fit() },
      { title: "Fit timeline", run: () => Timeline.fit() },
      { title: "Toggle side panels", hint: "Tab", run: () => togglePanels() },
      { title: "Undo", hint: "⌘Z", run: () => History.undo() },
      { title: "Redo", hint: "⇧⌘Z", run: () => History.redo() },
      { title: "Export…", run: () => Exporter.open() },
      { title: "Copy frame to clipboard", run: () => Exporter.copyFrameToClipboard() },
      { title: "Save project", hint: "⌘S", run: saveProject },
      { title: "Open project…", hint: "⌘O", run: () => document.getElementById("file-open").click() },
      { title: "New project", run: () => newProject(true) },
      { title: "Load demo project", run: () => { newProject(false); buildDemo(); afterProjectLoad("Welcome to Lumen"); } },
      { title: "Keyboard shortcuts", hint: "?", run: () => showShortcuts() },
    ].filter(Boolean);
  }

  function open() {
    items = actions();
    document.getElementById("palette-overlay").hidden = false;
    const input = document.getElementById("palette-input");
    input.value = "";
    input.focus();
    active = 0;
    render("");
  }
  function close() {
    document.getElementById("palette-overlay").hidden = true;
    document.getElementById("palette-input").blur();
  }
  function isOpen() { return !document.getElementById("palette-overlay").hidden; }

  function render(q) {
    const list = document.getElementById("palette-list");
    const needle = q.trim().toLowerCase();
    filtered = needle ? items.filter(it => it.title.toLowerCase().includes(needle)) : items;
    active = clamp(active, 0, Math.max(0, filtered.length - 1));
    list.innerHTML = "";
    if (!filtered.length) {
      list.innerHTML = `<div class="palette-empty">No matching commands</div>`;
      return;
    }
    filtered.forEach((it, i) => {
      const el = document.createElement("div");
      el.className = "palette-item" + (i === active ? " active" : "");
      el.innerHTML = `<span class="pi-title">${escapeHtml(it.title)}</span>` +
        (it.hint ? `<span class="pi-hint">${it.hint}</span>` : "");
      el.addEventListener("click", () => { close(); it.run(); });
      el.addEventListener("pointermove", () => { if (active !== i) { active = i; render(q); } });
      list.appendChild(el);
    });
    const act = list.children[active];
    if (act && act.scrollIntoView) act.scrollIntoView({ block: "nearest" });
  }

  function init() {
    const input = document.getElementById("palette-input");
    input.addEventListener("input", () => { active = 0; render(input.value); });
    input.addEventListener("keydown", e => {
      e.stopPropagation();
      if (e.key === "Escape") close();
      if (e.key === "ArrowDown") { e.preventDefault(); active++; render(input.value); }
      if (e.key === "ArrowUp") { e.preventDefault(); active--; render(input.value); }
      if (e.key === "Enter" && filtered[active]) { close(); filtered[active].run(); }
    });
    document.getElementById("palette-overlay").addEventListener("pointerdown", e => {
      if (e.target.id === "palette-overlay") close();
    });
    document.getElementById("btn-palette").addEventListener("click", open);
  }

  return { init, open, close, isOpen };
})();

/* ── project save / open / autosave ── */
function saveProject() {
  const blob = new Blob([serializeProject()], { type: "application/json" });
  Exporter.download(blob, App.project.name.replace(/\s+/g, "-") + ".lumen");
  App.dirty = false;
  App.emit("dirty");
  toast("Project saved");
}

function newProject(confirmFirst) {
  if (confirmFirst && App.dirty && !confirm("Discard unsaved changes?")) return;
  App.project = defaultProject();
  afterProjectLoad(App.project.name);
}

function afterProjectLoad(name) {
  App.project.name = name || App.project.name;
  App.time = 0; App.selection = null; App.selExtra = new Set(); App.expanded = new Set();
  App.dirty = false;
  History.stack = []; History.index = -1;
  document.getElementById("project-name").value = App.project.name;
  App.emit("project");
  App.emit("selection");
  App.emit("comps");
  App.emit("time", {});
  Viewport.fit();
  Timeline.fit();
}

const AUTOSAVE_KEY = "lumen.autosave";
function autosave() {
  if (!App.dirty) return;
  try { localStorage.setItem(AUTOSAVE_KEY, serializeProject()); } catch (e) { /* quota */ }
}
function tryRestoreAutosave() {
  try {
    const json = localStorage.getItem(AUTOSAVE_KEY);
    if (!json) return false;
    const s = JSON.parse(json);
    if (!confirm(`Restore autosaved project "${s.name}"?`)) {
      localStorage.removeItem(AUTOSAVE_KEY);
      return false;
    }
    loadProjectJSON(json);
    document.getElementById("project-name").value = App.project.name;
    Viewport.fit();
    Timeline.fit();
    toast("Autosave restored");
    return true;
  } catch (e) { return false; }
}

function selectAll() {
  if (!App.layers.length) return;
  App.selection = App.layers[0].id;
  App.selExtra = new Set(App.layers.slice(1).map(l => l.id));
  App.emit("selection");
}

function togglePanels() {
  document.getElementById("panel-project").classList.toggle("collapsed");
  document.getElementById("panel-props").classList.toggle("collapsed");
}

function showShortcuts() {
  document.getElementById("shortcuts-overlay").hidden = false;
}

/* ── panel resizing ── */
function initResizers() {
  const left = document.getElementById("panel-project");
  const right = document.getElementById("panel-props");
  const tl = document.getElementById("timeline");
  const saved = (() => { try { return JSON.parse(localStorage.getItem("lumen.layout") || "{}"); } catch (e) { return {}; } })();
  if (saved.l) left.style.width = saved.l + "px";
  if (saved.r) right.style.width = saved.r + "px";
  if (saved.t) tl.style.height = saved.t + "px";
  const persist = () => {
    try {
      localStorage.setItem("lumen.layout", JSON.stringify({
        l: left.offsetWidth, r: right.offsetWidth, t: tl.offsetHeight,
      }));
    } catch (e) {}
  };
  document.getElementById("rs-left").addEventListener("pointerdown", e => {
    const w0 = left.offsetWidth;
    startDrag(e, {
      cursor: "col-resize",
      move(ev, dx) { left.style.width = clamp(w0 + dx, 170, 420) + "px"; Viewport.requestDraw(); },
      up: persist,
    });
  });
  document.getElementById("rs-right").addEventListener("pointerdown", e => {
    const w0 = right.offsetWidth;
    startDrag(e, {
      cursor: "col-resize",
      move(ev, dx) { right.style.width = clamp(w0 - dx, 200, 460) + "px"; Viewport.requestDraw(); },
      up: persist,
    });
  });
  document.getElementById("rs-tl").addEventListener("pointerdown", e => {
    const h0 = tl.offsetHeight;
    startDrag(e, {
      cursor: "row-resize",
      move(ev, dx, dy) { tl.style.height = clamp(h0 - dy, 130, innerHeight - 200) + "px"; Viewport.requestDraw(); },
      up: persist,
    });
  });
}

/* ── demo composition ── */
function buildDemo() {
  const c = App.comp;
  const cx = c.width / 2, cy = c.height / 2;

  const glow = makeLayer("shape", { name: "Glow" });
  glow.data = { shape: "ellipse", w: 700, h: 700, fill: "#5e6ad2", fill2: "#26b5ce", fillType: "radial", gradAngle: 0, stroke: "", strokeWidth: 0, radius: 0, points: 5, inset: 0.5 };
  glow.props.opacity.value = 38;
  glow.blend = "screen";
  const blurFx = { id: uid(), type: "blur", enabled: true, params: { amount: animProp(90) } };
  glow.effects = [blurFx];
  glow.props.position.anim = true;
  glow.props.position.loop = "pingpong";
  glow.props.position.keys = [
    { t: 0, v: [cx - 240, cy + 60], ease: "easeInOut" },
    { t: 5, v: [cx + 240, cy - 40], ease: "easeInOut" },
  ];

  const star = makeLayer("shape", { name: "Star" });
  star.data = { shape: "star", w: 110, h: 110, fill: "", fill2: "", fillType: "solid", gradAngle: 0, stroke: "#7c89f0", strokeWidth: 5, radius: 0, points: 5, inset: 0.48 };
  star.props.position.value = [c.width - 170, 140];
  star.props.position.wseed = 41;
  star.props.position.wiggle = { on: true, freq: 0.5, amp: 14 };
  star.props.opacity.value = 70;
  star.props.rotation.anim = true;
  star.props.rotation.loop = "cycle";
  star.props.rotation.keys = [
    { t: 0, v: 0, ease: "linear" },
    { t: 10, v: 360, ease: "linear" },
  ];

  const title = makeLayer("text", { name: "Title" });
  title.data.text = "Lumen";
  title.data.size = 132;
  title.data.weight = "700";
  title.props.position.value = [cx, cy - 30];
  title.props.opacity.anim = true;
  title.props.opacity.keys = [
    { t: 0, v: 0, ease: "easeOut" },
    { t: 0.8, v: 100, ease: "linear" },
  ];
  title.props.scale.anim = true;
  title.props.scale.keys = [
    { t: 0, v: [86, 86], ease: "easeOut" },
    { t: 1.1, v: [100, 100], ease: "linear" },
  ];

  const sub = makeLayer("text", { name: "Subtitle" });
  sub.data = { ...sub.data, text: "Motion design, in your browser", size: 30, weight: "400", color: "#8a8f98", reveal: "fadechar", revealStart: 0.4, revealDur: 1.4 };
  sub.props.position.value = [cx, cy + 64];

  const rule = makeLayer("solid", { name: "Rule" });
  rule.data = { ...rule.data, color: "#5e6ad2", w: 1, h: 3 };
  rule.props.position.value = [cx, cy + 118];
  rule.props.scale.anim = true;
  rule.props.scale.keys = [
    { t: 0.9, v: [0, 100], ease: "easeInOut" },
    { t: 2.0, v: [22000, 100], ease: "linear" },
  ];

  App.comp.layers = [title, sub, rule, star, glow];
  App.comp.markers = [{ id: uid(), t: 2, label: "intro done" }];
}

/* ── boot ── */
function initApp() {
  App.project = defaultProject();
  App.project.name = "Welcome to Lumen";
  buildDemo();

  Panels.init();
  Timeline.init();
  Viewport.init();
  Palette.init();
  GraphEditor.init();
  CompTabs.init();
  initResizers();

  /* top bar */
  const nameInput = document.getElementById("project-name");
  nameInput.value = App.project.name;
  nameInput.addEventListener("change", () => { App.project.name = nameInput.value || "Untitled Project"; App.emit("dirty"); });
  nameInput.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Enter") nameInput.blur(); });

  document.getElementById("btn-play").addEventListener("click", () => Playback.toggle());
  document.getElementById("btn-go-start").addEventListener("click", () => App.setTime(0));
  document.getElementById("btn-prev-frame").addEventListener("click", () => Playback.step(-1));
  document.getElementById("btn-next-frame").addEventListener("click", () => Playback.step(1));
  document.getElementById("btn-undo").addEventListener("click", () => History.undo());
  document.getElementById("btn-redo").addEventListener("click", () => History.redo());
  document.getElementById("btn-save").addEventListener("click", saveProject);
  document.getElementById("btn-open").addEventListener("click", () => document.getElementById("file-open").click());
  document.getElementById("btn-export").addEventListener("click", () => Exporter.open());
  document.getElementById("btn-help").addEventListener("click", showShortcuts);
  document.getElementById("shortcuts-close").addEventListener("click", () => {
    document.getElementById("shortcuts-overlay").hidden = true;
  });
  document.getElementById("shortcuts-overlay").addEventListener("pointerdown", e => {
    if (e.target.id === "shortcuts-overlay") e.target.hidden = true;
  });

  const speedSel = document.getElementById("speed-select");
  speedSel.addEventListener("change", () => { App.speed = parseFloat(speedSel.value); });
  const loopBtn = document.getElementById("btn-loop");
  loopBtn.classList.toggle("active", App.loop);
  loopBtn.addEventListener("click", () => {
    App.loop = !App.loop;
    loopBtn.classList.toggle("active", App.loop);
  });
  const muteBtn = document.getElementById("btn-mute");
  muteBtn.addEventListener("click", () => {
    App.muted = !App.muted;
    muteBtn.classList.toggle("active", App.muted);
    AudioEngine.sync();
  });

  /* editable timecode */
  const tcInput = document.getElementById("timecode");
  tcInput.addEventListener("focus", () => tcInput.select());
  tcInput.addEventListener("keydown", e => {
    e.stopPropagation();
    if (e.key === "Enter") {
      const t = parseTimecode(tcInput.value);
      if (t !== null) App.setTime(snapT(t));
      tcInput.blur();
    }
    if (e.key === "Escape") { tcInput.value = timecode(App.time); tcInput.blur(); }
  });
  tcInput.addEventListener("blur", () => { tcInput.value = timecode(App.time); });

  document.getElementById("file-open").addEventListener("change", e => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        loadProjectJSON(reader.result);
        document.getElementById("project-name").value = App.project.name;
        Viewport.fit();
        Timeline.fit();
        toast("Project loaded");
      } catch (err) {
        toast("Could not open project: " + err.message);
      }
    };
    reader.readAsText(file);
  });

  /* export modal */
  document.getElementById("export-close").addEventListener("click", () => Exporter.close());
  document.getElementById("export-cancel").addEventListener("click", () => Exporter.close());
  document.getElementById("export-start").addEventListener("click", () => Exporter.start());
  document.getElementById("export-format").addEventListener("change", e => {
    document.getElementById("export-quality-row").style.display = e.target.value === "webm" ? "" : "none";
  });

  /* events → UI */
  App.on("time", () => {
    if (document.activeElement !== tcInput) tcInput.value = timecode(App.time);
  });
  App.on("playback", () => {
    document.getElementById("ic-play").style.display = App.playing ? "none" : "";
    document.getElementById("ic-pause").style.display = App.playing ? "" : "none";
  });
  App.on("dirty", () => {
    document.title = (App.dirty ? "● " : "") + App.project.name + " — Lumen";
  });
  App.on("comps", () => {
    document.title = (App.dirty ? "● " : "") + App.project.name + " — Lumen";
  });

  /* autosave */
  setInterval(autosave, 25000);
  window.addEventListener("beforeunload", autosave);

  /* keyboard */
  window.addEventListener("keydown", e => {
    const tag = (e.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return;
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key;

    if (mod) {
      switch (key.toLowerCase()) {
        case "k": e.preventDefault(); Palette.isOpen() ? Palette.close() : Palette.open(); return;
        case "z": e.preventDefault(); e.shiftKey ? History.redo() : History.undo(); return;
        case "s": e.preventDefault(); saveProject(); return;
        case "o": e.preventDefault(); document.getElementById("file-open").click(); return;
        case "d": e.preventDefault(); { const s = App.selectedLayer(); if (s) { App.commit(); Layers.duplicate(s.id); } } return;
        case "c": e.preventDefault(); UIClipboard.copyLayers(); return;
        case "v": e.preventDefault(); UIClipboard.pasteLayers(); return;
        case "a": e.preventDefault(); selectAll(); return;
      }
      return;
    }

    const sel = App.selectedLayer();
    switch (key) {
      case " ": e.preventDefault(); Playback.toggle(); return;
      case "ArrowLeft": e.preventDefault();
        if (e.altKey) { UICommands.nudgeTime(e.shiftKey ? -10 : -1); }
        else Playback.step(e.shiftKey ? -10 : -1);
        return;
      case "ArrowRight": e.preventDefault();
        if (e.altKey) { UICommands.nudgeTime(e.shiftKey ? 10 : 1); }
        else Playback.step(e.shiftKey ? 10 : 1);
        return;
      case "ArrowUp": e.preventDefault(); UICommands.nudge(0, e.shiftKey ? -10 : -1); return;
      case "ArrowDown": e.preventDefault(); UICommands.nudge(0, e.shiftKey ? 10 : 1); return;
      case "Home": e.preventDefault(); App.setTime(0); return;
      case "End": e.preventDefault(); App.setTime(App.comp.duration); return;
      case "Delete": case "Backspace": {
        const ids = App.selectedIds();
        if (ids.length) { App.commit(); Layers.removeMany(ids); }
        return;
      }
      case "Escape":
        if (Palette.isOpen()) Palette.close();
        else if (GraphEditor.isOpen()) GraphEditor.close();
        else if (!document.getElementById("shortcuts-overlay").hidden) document.getElementById("shortcuts-overlay").hidden = true;
        else if (!document.getElementById("export-overlay").hidden) Exporter.close();
        else { App.selectedKeys = []; App.select(null); }
        return;
      case "Tab": e.preventDefault(); togglePanels(); return;
      case "F9": e.preventDefault(); UICommands.easyEaseSelected(); return;
    }

    switch (key.toLowerCase()) {
      case "m": Timeline.addMarker(); return;
      case "b": { App.commit(); const c = App.comp; c.workStart = Math.min(snapT(App.time), c.workEnd - 0.1); Timeline.drawRuler(); return; }
      case "n": { App.commit(); const c = App.comp; c.workEnd = Math.max(snapT(App.time), c.workStart + 0.1); Timeline.drawRuler(); return; }
      case "f": Viewport.fit(); return;
      case "i": if (sel) App.setTime(sel.inPoint); return;
      case "o": if (sel) App.setTime(sel.outPoint); return;
      case "j": UICommands.jumpKey(-1); return;
      case "k": UICommands.jumpKey(1); return;
      case "[": e.shiftKey ? UICommands.nudgeTime(-Math.round((App.time - (sel ? sel.inPoint : 0)) * App.comp.fps)) : UICommands.trimToPlayhead("in"); return;
      case "]": UICommands.trimToPlayhead("out"); return;
      case "p": if (sel) Timeline.revealProp(sel, "position"); return;
      case "s": if (sel) Timeline.revealProp(sel, "scale"); return;
      case "r": if (sel) Timeline.revealProp(sel, "rotation"); return;
      case "t": if (sel) Timeline.revealProp(sel, "opacity"); return;
      case "a": if (sel) Timeline.revealProp(sel, "anchor"); return;
      case "?": showShortcuts(); return;
      case "+": case "=": if (e.shiftKey) UICommands.cycleBlend(1); return;
      case "-": case "_": if (e.shiftKey) UICommands.cycleBlend(-1); return;
      case ".": if (e.shiftKey) UICommands.jumpMarker(1); return;
      case ",": if (e.shiftKey) UICommands.jumpMarker(-1); return;
    }
  });

  App.emit("project");
  App.emit("selection");
  App.emit("comps");
  App.emit("time", {});
  Viewport.fit();
  Timeline.fit();

  setTimeout(() => tryRestoreAutosave(), 300);
}

window.addEventListener("DOMContentLoaded", initApp);
