/* ─── Lumen — Premiere Pro "Edit" Tab ──────────────────────────────── */
"use strict";

/* ── Data model ─────────────────────────────────────────────────────── */

let _prId = 9000;
const prUID = () => ++_prId;

function makeSequence(name) {
  return {
    id: prUID(), name: name || "Sequence 01",
    width: 1920, height: 1080, fps: 30, duration: 30,
    videoTracks: [makePrTrack("video","V1"), makePrTrack("video","V2"), makePrTrack("video","V3")],
    audioTracks: [makePrTrack("audio","A1"), makePrTrack("audio","A2")],
    markers: [],
    subtitles: [],
    multicam: false,
  };
}

function makePrTrack(type, name) {
  return { id: prUID(), type, name, clips: [], mute: false, solo: false, locked: false, height: type === "video" ? 70 : 42 };
}

function makePrClip(assetId, srcIn, srcOut) {
  const dur = srcOut - srcIn;
  return { id: prUID(), assetId, seqStart: 0, seqEnd: dur, srcIn, srcOut, speed: 1, volume: 100, opacity: 100, transIn: null, transOut: null, color: null, title: null, seqId: null, grade: { temp:0, tint:0, exposure:0, contrast:0, highlights:0, shadows:0, whites:0, blacks:0, sat:0, vibrance:0 }, fx: { blur: 0, sharpness: 0, noise: 0 }, audio: { comp: false, compThresh: -20, compRatio: 4, eq: false, eqLow: 0, eqMid: 0, eqHigh: 0, reverb: 0 } };
}

/* ── PrState ────────────────────────────────────────────────────────── */

const PrState = (() => {
  const sequences = [];
  let activeSeq = null;
  let _ph = 0, _playing = false, _raf = null, _lastTs = 0;
  let _tool = "select";
  let _zoom = 100;
  let _scrollX = 0, _scrollY = 0;
  const selected = new Set();
  let srcAssetId = null, srcIn = 0, srcOut = 5, srcPh = 0;

  function newSequence(name) {
    const s = makeSequence(name);
    sequences.push(s);
    activeSeq = s;
    return s;
  }

  function setSeq(s) { activeSeq = s; selected.clear(); }

  function addClipToTrack(trackRef, clip, startSec) {
    clip.seqStart = startSec;
    clip.seqEnd = startSec + (clip.srcOut - clip.srcIn) / clip.speed;
    trackRef.clips.push(clip);
    trackRef.clips.sort((a, b) => a.seqStart - b.seqStart);
    _refreshDuration();
  }

  function _refreshDuration() {
    if (!activeSeq) return;
    let end = 10;
    allTracks().forEach(tr => tr.clips.forEach(c => { if (c.seqEnd > end) end = c.seqEnd; }));
    activeSeq.duration = end + 5;
  }

  function allTracks() {
    if (!activeSeq) return [];
    return [...activeSeq.videoTracks, ...activeSeq.audioTracks];
  }

  function removeClip(id) {
    allTracks().forEach(tr => {
      const i = tr.clips.findIndex(c => c.id === id);
      if (i >= 0) tr.clips.splice(i, 1);
    });
    selected.delete(id);
    _refreshDuration();
  }

  function splitAt(clipId, sec) {
    for (const tr of allTracks()) {
      const clip = tr.clips.find(c => c.id === clipId);
      if (!clip) continue;
      if (sec <= clip.seqStart || sec >= clip.seqEnd) return;
      const ratio = (sec - clip.seqStart) / (clip.seqEnd - clip.seqStart);
      const srcMid = clip.srcIn + (clip.srcOut - clip.srcIn) * ratio;
      const right = { ...clip, id: prUID(), seqStart: sec, srcIn: srcMid, transIn: null };
      clip.seqEnd = sec;
      clip.srcOut = srcMid;
      clip.transOut = null;
      tr.clips.push(right);
      tr.clips.sort((a, b) => a.seqStart - b.seqStart);
      return;
    }
  }

  function razorAt(sec) {
    allTracks().forEach(tr => {
      const clip = tr.clips.find(c => sec > c.seqStart && sec < c.seqEnd);
      if (clip) splitAt(clip.id, sec);
    });
  }

  function togglePlay() {
    if (_playing) stopPlay(); else startPlay();
    _updatePlayBtn();
  }

  function startPlay() {
    if (_playing) return;
    _playing = true;
    _lastTs = performance.now();
    function tick(ts) {
      if (!_playing) return;
      const dt = (ts - _lastTs) / 1000;
      _lastTs = ts;
      _ph = Math.min(_ph + dt, activeSeq ? activeSeq.duration : 60);
      if (activeSeq && _ph >= activeSeq.duration) _ph = 0;
      PrProgramMonitor.draw();
      PrTimeline.drawPlayhead();
      _raf = requestAnimationFrame(tick);
    }
    _raf = requestAnimationFrame(tick);
  }

  function stopPlay() {
    _playing = false;
    if (_raf) { cancelAnimationFrame(_raf); _raf = null; }
    if (typeof PrAudio !== "undefined") PrAudio.stop();
  }

  function _updatePlayBtn() {
    const btn = document.getElementById("pr-play-btn");
    if (!btn) return;
    btn.innerHTML = _playing
      ? `<svg viewBox="0 0 16 16"><rect x="3.5" y="3" width="3.2" height="10" rx="1" fill="currentColor"/><rect x="9.3" y="3" width="3.2" height="10" rx="1" fill="currentColor"/></svg>`
      : `<svg viewBox="0 0 16 16"><path d="M4.5 3.1v9.8c0 .62.68 1 1.2.65l7.4-4.9a.78.78 0 0 0 0-1.3l-7.4-4.9A.78.78 0 0 0 4.5 3.1Z" fill="currentColor"/></svg>`;
  }

  return {
    get seq() { return activeSeq; },
    get seqs() { return sequences; },
    get playhead() { return _ph; },
    set playhead(v) { _ph = Math.max(0, v); },
    get playing() { return _playing; },
    get tool() { return _tool; },
    set tool(v) { _tool = v; },
    get zoom() { return _zoom; },
    set zoom(v) { _zoom = Math.max(8, Math.min(3000, v)); },
    get scrollX() { return _scrollX; },
    set scrollX(v) { _scrollX = Math.max(0, v); },
    get scrollY() { return _scrollY; },
    set scrollY(v) { _scrollY = v; },
    get selected() { return selected; },
    get srcAssetId() { return srcAssetId; },
    set srcAssetId(v) { srcAssetId = v; },
    get srcIn() { return srcIn; },
    set srcIn(v) { srcIn = v; },
    get srcOut() { return srcOut; },
    set srcOut(v) { srcOut = v; },
    get srcPlayhead() { return srcPh; },
    set srcPlayhead(v) { srcPh = v; },
    newSequence, setSeq, allTracks, addClipToTrack, removeClip, splitAt, razorAt,
    refreshDuration: _refreshDuration,
    togglePlay, startPlay, stopPlay,
  };
})();

/* ── Asset & video helpers ──────────────────────────────────────────── */

function prAsset(id) {
  return (typeof App !== "undefined" && App.project?.assets || []).find(a => a.id === id) || null;
}
function prAllAssets() {
  return (typeof App !== "undefined" && App.project?.assets || []);
}

const _vidPool = new Map();
async function prGetVideo(assetId) {
  if (_vidPool.has(assetId)) return _vidPool.get(assetId);
  const asset = prAsset(assetId);
  if (!asset) return null;
  let url = asset.url || null;
  if (!url && typeof MediaStore !== "undefined") {
    const blob = await MediaStore.get(assetId).catch(() => null);
    if (blob) url = URL.createObjectURL(blob);
  }
  if (!url) return null;
  const v = document.createElement("video");
  v.src = url; v.muted = true; v.preload = "auto"; v.crossOrigin = "anonymous";
  await new Promise(r => { v.onloadedmetadata = r; v.onerror = r; setTimeout(r, 3000); });
  _vidPool.set(assetId, v);
  return v;
}

const _imgCache = new Map();
async function prGetImage(assetId) {
  if (_imgCache.has(assetId)) return _imgCache.get(assetId);
  const asset = prAsset(assetId);
  if (!asset) return null;
  let url = asset.url || null;
  if (!url && typeof MediaStore !== "undefined") {
    const blob = await MediaStore.get(assetId).catch(() => null);
    if (blob) url = URL.createObjectURL(blob);
  }
  if (!url) return null;
  const img = new Image(); img.crossOrigin = "anonymous"; img.src = url;
  await new Promise(r => { img.onload = r; img.onerror = r; });
  _imgCache.set(assetId, img);
  return img;
}

function prFmtTC(sec) {
  const m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60), f = Math.floor((sec % 1) * 30);
  return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}:${String(f).padStart(2,'0')}`;
}
function prFmtTCFull(sec) {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60), f = Math.floor((sec % 1) * 30);
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}:${String(f).padStart(2,'0')}`;
}

/* ── Color grade helper ─────────────────────────────────────────────── */

function applyPrGrade(ctx, clip, W, H) {
  const g = clip.grade;
  if (!g) return;
  const e = g.exposure||0, c = g.contrast||0, s = g.sat||0, t = g.temp||0;
  const parts = [];
  if (Math.abs(e) > 0.1) parts.push(`brightness(${100 + e*8}%)`);
  if (Math.abs(c) > 0.5) parts.push(`contrast(${100 + c}%)`);
  if (Math.abs(s) > 0.5) parts.push(`saturate(${100 + s}%)`);
  if (Math.abs(t) > 0.5) parts.push(`hue-rotate(${t * 0.4}deg)`);
  if (!parts.length) return;
  // copy to offscreen, apply filter, draw back
  const tmp = document.createElement("canvas"); tmp.width = W; tmp.height = H;
  const tc = tmp.getContext("2d");
  tc.drawImage(ctx.canvas, 0, 0, W, H, 0, 0, W, H);
  ctx.filter = parts.join(" ");
  ctx.clearRect(0, 0, W, H);
  ctx.drawImage(tmp, 0, 0);
  ctx.filter = "none";
}

function applyPrFx(ctx, clip, W, H) {
  const fx = clip.fx;
  if (!fx) return;
  const parts = [];
  if (fx.blur > 0.5) parts.push(`blur(${fx.blur * 0.3}px)`);
  if (parts.length) {
    const tmp2 = document.createElement("canvas"); tmp2.width=W; tmp2.height=H;
    const tc2 = tmp2.getContext("2d");
    tc2.drawImage(ctx.canvas, 0, 0, W, H, 0, 0, W, H);
    ctx.filter = parts.join(" ");
    ctx.clearRect(0,0,W,H); ctx.drawImage(tmp2,0,0); ctx.filter="none";
  }
}

/* ── SRT subtitle parser ────────────────────────────────────────────── */

function parseSRT(text) {
  const subs = [];
  const blocks = text.trim().replace(/\r\n/g,"\n").split(/\n\n+/);
  blocks.forEach(block => {
    const lines = block.split("\n");
    if (lines.length < 3) return;
    const tc = lines[1].match(/(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)/);
    if (!tc) return;
    const toSec = (h,m,s,ms) => +h*3600 + +m*60 + +s + +ms/1000;
    subs.push({
      id: "sub_" + subs.length,
      start: toSec(tc[1],tc[2],tc[3],tc[4]),
      end:   toSec(tc[5],tc[6],tc[7],tc[8]),
      text: lines.slice(2).join("\n").replace(/<[^>]+>/g,"")
    });
  });
  return subs;
}

/* ── Waveform cache ─────────────────────────────────────────────────── */

const _waveformPeaks = new Map(); // assetId → Float32Array
const _waveformPending = new Set();

async function ensureWaveform(assetId) {
  if (_waveformPeaks.has(assetId) || _waveformPending.has(assetId)) return;
  _waveformPending.add(assetId);
  try {
    const asset = prAsset(assetId); if (!asset) return;
    const blob = await (typeof MediaStore !== "undefined" ? MediaStore.get(assetId).catch(()=>null) : Promise.resolve(null));
    if (!blob) return;
    const ab = await blob.arrayBuffer();
    const ac = new OfflineAudioContext(1, 44100, 44100);
    const decoded = await ac.decodeAudioData(ab);
    const data = decoded.getChannelData(0);
    const BARS = 300;
    const step = Math.max(1, Math.floor(data.length / BARS));
    const peaks = new Float32Array(BARS);
    for (let i = 0; i < BARS; i++) {
      let max = 0;
      const off = i * step;
      for (let j = 0; j < step && off+j < data.length; j++) max = Math.max(max, Math.abs(data[off+j]));
      peaks[i] = max;
    }
    _waveformPeaks.set(assetId, peaks);
    PrTimeline.draw(); // redraw with waveform
  } catch(e) {
    // audio decode failed; leave without waveform
  } finally {
    _waveformPending.delete(assetId);
  }
}

/* ── PrRenderer (frame renderer) ───────────────────────────────────── */

const PrRenderer = (() => {
  async function drawClip(ctx, clip, clipT, W, H, playing, opts) {
    // Nested sequence
    if (clip.seqId) {
      const nested = PrState.seqs.find(s => s.id === clip.seqId);
      if (nested && (opts && (opts.depth||0)) < 4) {
        const oldOpts = opts || {};
        await renderFrame(ctx, nested, clipT, playing, { depth: (oldOpts.depth||0)+1 });
      } else {
        ctx.fillStyle = "#1b1d22"; ctx.fillRect(0,0,W,H);
        ctx.fillStyle = "#5e636e"; ctx.font = "bold 18px Inter,sans-serif";
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText("Nested: " + (PrState.seqs.find(s=>s.id===clip.seqId)?.name||"?"), W/2, H/2);
      }
      return;
    }
    if (clip._isTitleClip || clip.assetId === -1) {
      ctx.fillStyle = "#101216";
      ctx.fillRect(0, 0, W, H);
      if (clip.title) {
        ctx.font = "bold 52px Inter, system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = "#ffffff";
        ctx.fillText(clip.title, W/2, H/2, W - 80);
      }
      return;
    }
    const asset = prAsset(clip.assetId);
    if (!asset) {
      ctx.fillStyle = clip.color || "#2a2a3a";
      ctx.fillRect(0, 0, W, H);
      if (clip.title) {
        ctx.save();
        ctx.font = "bold 48px Inter, system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "bottom";
        const padding = 20;
        const textMetrics = ctx.measureText(clip.title);
        const tw = textMetrics.width + padding * 2;
        const th = 60;
        const tx = W / 2;
        const ty = H - 30;
        ctx.fillStyle = "rgba(0,0,0,0.55)";
        ctx.roundRect ? ctx.roundRect(tx - tw/2, ty - th, tw, th, 8) : ctx.rect(tx - tw/2, ty - th, tw, th);
        ctx.fill();
        ctx.fillStyle = "#ffffff";
        ctx.fillText(clip.title, tx, ty - 8, W - 40);
        ctx.restore();
      }
      return;
    }
    if (asset.type === "video") {
      const vid = _vidPool.get(clip.assetId);
      if (vid && !isNaN(vid.duration) && vid.duration > 0) {
        if (!playing) {
          const t = Math.max(0, Math.min(vid.duration - 0.001, clipT));
          if (Math.abs(vid.currentTime - t) > 0.08) {
            vid.currentTime = t;
            await new Promise(r => { vid.onseeked = r; setTimeout(r, 150); });
          }
        }
        try { ctx.drawImage(vid, 0, 0, W, H); applyPrGrade(ctx, clip, W, H); applyPrFx(ctx, clip, W, H); } catch(e) {}
      } else {
        ctx.fillStyle = "#111"; ctx.fillRect(0, 0, W, H);
      }
    } else if (asset.type === "image") {
      const img = await prGetImage(clip.assetId);
      if (img) { ctx.drawImage(img, 0, 0, W, H); applyPrGrade(ctx, clip, W, H); applyPrFx(ctx, clip, W, H); }
    } else {
      ctx.fillStyle = "#1e1e26"; ctx.fillRect(0, 0, W, H);
    }
    if (clip.title) {
      ctx.save();
      ctx.font = "bold 48px Inter, system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      const padding = 20;
      const textMetrics = ctx.measureText(clip.title);
      const tw = textMetrics.width + padding * 2;
      const th = 60;
      const tx = W / 2;
      const ty = H - 30;
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.roundRect ? ctx.roundRect(tx - tw/2, ty - th, tw, th, 8) : ctx.rect(tx - tw/2, ty - th, tw, th);
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.fillText(clip.title, tx, ty - 8, W - 40);
      ctx.restore();
    }
  }

  async function renderFrame(ctx, seq, t, playing, opts={}) {
    const W = ctx.canvas.width, H = ctx.canvas.height;
    ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, H);
    if (!seq) return;
    for (let ti = seq.videoTracks.length - 1; ti >= 0; ti--) {
      const tr = seq.videoTracks[ti];
      if (tr.mute) continue;
      for (const clip of tr.clips) {
        if (t < clip.seqStart || t >= clip.seqEnd) continue;
        const clipT = clip.srcIn + (t - clip.seqStart) * clip.speed;
        let alpha = clip.opacity / 100;
        if (clip.transIn && t < clip.seqStart + clip.transIn.duration)
          alpha *= (t - clip.seqStart) / clip.transIn.duration;
        if (clip.transOut && t > clip.seqEnd - clip.transOut.duration)
          alpha *= (clip.seqEnd - t) / clip.transOut.duration;
        ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
        await drawClip(ctx, clip, clipT, W, H, playing, opts);
      }
    }
    ctx.globalAlpha = 1;
  }

  return { renderFrame };
})();

/* ── PrSourceMonitor ────────────────────────────────────────────────── */

const PrSourceMonitor = (() => {
  let cvs, ctx, scrub = false, playing = false, raf = null, lastTs = 0;

  function init() {
    cvs = document.getElementById("pr-src-canvas");
    if (!cvs) return;
    ctx = cvs.getContext("2d");
    resizeCanvas();
    window.addEventListener("resize", resizeCanvas);
    cvs.addEventListener("mousedown", onDown);
    bindBtn("pr-src-set-in",  () => { PrState.srcIn = PrState.srcPlayhead; draw(); });
    bindBtn("pr-src-set-out", () => { PrState.srcOut = PrState.srcPlayhead; draw(); });
    bindBtn("pr-src-play",    togglePlay);
    bindBtn("pr-src-insert",  insertClip);
    bindBtn("pr-src-overwrite", overwriteClip);
    draw();
  }

  function resizeCanvas() {
    if (!cvs) return;
    const p = cvs.parentElement;
    if (!p) return;
    cvs.width  = p.clientWidth  || 400;
    cvs.height = (p.clientHeight || 300) - 36;
  }

  function loadAsset(id) {
    PrState.srcAssetId = id;
    const a = prAsset(id);
    if (!a) return;
    PrState.srcIn = 0; PrState.srcOut = a.duration || 5; PrState.srcPlayhead = 0;
    if (a.type === "video") prGetVideo(id).then(() => draw()).catch(() => {});
    const el = document.getElementById("pr-src-name");
    if (el) el.textContent = a.name;
    draw();
  }

  async function draw() {
    if (!ctx || !cvs) return;
    const W = cvs.width, H = cvs.height;
    ctx.clearRect(0, 0, W, H);
    const a = prAsset(PrState.srcAssetId);
    if (!a) {
      ctx.fillStyle = "#111"; ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = "#444"; ctx.font = "13px system-ui"; ctx.textAlign = "center";
      ctx.fillText("No clip loaded — click an asset", W / 2, H / 2);
      return;
    }
    if (a.type === "video") {
      const vid = _vidPool.get(PrState.srcAssetId);
      if (vid && !isNaN(vid.duration)) {
        const t = Math.min(PrState.srcPlayhead, vid.duration - 0.001);
        if (Math.abs(vid.currentTime - t) > 0.08) {
          vid.currentTime = t;
          await new Promise(r => { vid.onseeked = r; setTimeout(r, 100); });
        }
        ctx.drawImage(vid, 0, 0, W, H);
      }
    } else if (a.type === "image") {
      const img = await prGetImage(PrState.srcAssetId);
      if (img) ctx.drawImage(img, 0, 0, W, H);
    } else {
      ctx.fillStyle = "#1a1a26"; ctx.fillRect(0, 0, W, H);
    }
    _drawScrub(W, H, a.duration || 10);
    _drawTC(W, H);
  }

  function _drawScrub(W, H, dur) {
    const by = H - 14, bh = 5;
    ctx.fillStyle = "#333"; ctx.fillRect(6, by, W - 12, bh);
    const ix = 6 + (PrState.srcIn / dur) * (W - 12);
    const ox = 6 + (PrState.srcOut / dur) * (W - 12);
    ctx.fillStyle = "#5e6ad2"; ctx.fillRect(ix, by, ox - ix, bh);
    const px = 6 + (PrState.srcPlayhead / dur) * (W - 12);
    ctx.fillStyle = "#fff"; ctx.fillRect(px - 1, by - 3, 2, bh + 6);
  }

  function _drawTC(W, H) {
    ctx.fillStyle = "rgba(0,0,0,.65)"; ctx.fillRect(0, H - 16, 85, 16);
    ctx.fillStyle = "#ccc"; ctx.font = "10px monospace"; ctx.textAlign = "left";
    ctx.fillText(prFmtTC(PrState.srcPlayhead), 5, H - 4);
  }

  function onDown(e) {
    scrub = true; moveScrub(e);
    const mm = e2 => { if (scrub) moveScrub(e2); };
    const mu = () => { scrub = false; document.removeEventListener("mousemove", mm); document.removeEventListener("mouseup", mu); };
    document.addEventListener("mousemove", mm);
    document.addEventListener("mouseup", mu);
  }

  function moveScrub(e) {
    const a = prAsset(PrState.srcAssetId); if (!a) return;
    const r = cvs.getBoundingClientRect();
    const nx = (e.clientX - r.left) / r.width * cvs.width;
    const dur = a.duration || 10;
    PrState.srcPlayhead = Math.max(0, Math.min(dur, ((nx - 6) / (cvs.width - 12)) * dur));
    draw();
  }

  function togglePlay() {
    playing = !playing;
    const btn = document.getElementById("pr-src-play");
    if (btn) btn.textContent = playing ? "⏸" : "▶";
    if (playing) {
      lastTs = performance.now();
      function tick(ts) {
        if (!playing) return;
        const dt = (ts - lastTs) / 1000; lastTs = ts;
        const a = prAsset(PrState.srcAssetId);
        PrState.srcPlayhead = Math.min(PrState.srcPlayhead + dt, PrState.srcOut);
        if (PrState.srcPlayhead >= PrState.srcOut) PrState.srcPlayhead = PrState.srcIn;
        draw();
        raf = requestAnimationFrame(tick);
      }
      raf = requestAnimationFrame(tick);
    } else if (raf) { cancelAnimationFrame(raf); }
  }

  function insertClip() {
    if (!PrState.srcAssetId || !PrState.seq) return;
    const seq = PrState.seq;
    const track = seq.videoTracks[0]; if (!track) return;
    const clip = makePrClip(PrState.srcAssetId, PrState.srcIn, PrState.srcOut);
    // Find end of last clip in V1 for insert
    const insertAt = PrState.playhead;
    // Shift clips after insertAt
    const dur = clip.srcOut - clip.srcIn;
    track.clips.filter(c => c.seqStart >= insertAt).forEach(c => { c.seqStart += dur; c.seqEnd += dur; });
    // Do same for A1
    if (seq.audioTracks[0]) {
      seq.audioTracks[0].clips.filter(c => c.seqStart >= insertAt).forEach(c => { c.seqStart += dur; c.seqEnd += dur; });
    }
    PrState.addClipToTrack(track, clip, insertAt);
    PrTimeline.draw(); PrBins.refresh();
  }

  function overwriteClip() {
    if (!PrState.srcAssetId || !PrState.seq) return;
    const seq = PrState.seq;
    const track = seq.videoTracks[0]; if (!track) return;
    const clip = makePrClip(PrState.srcAssetId, PrState.srcIn, PrState.srcOut);
    const dur = clip.srcOut - clip.srcIn;
    const end = PrState.playhead + dur;
    track.clips = track.clips.filter(c => c.seqEnd <= PrState.playhead || c.seqStart >= end);
    PrState.addClipToTrack(track, clip, PrState.playhead);
    PrTimeline.draw();
  }

  return { init, loadAsset, draw, resizeCanvas };
})();

/* ── PrProgramMonitor ───────────────────────────────────────────────── */

const PrProgramMonitor = (() => {
  let cvs, ctx, scrub = false;

  function init() {
    cvs = document.getElementById("pr-prog-canvas");
    if (!cvs) return;
    ctx = cvs.getContext("2d");
    resizeCanvas();
    window.addEventListener("resize", resizeCanvas);
    cvs.addEventListener("mousedown", onDown);
    bindBtn("pr-play-btn",  () => { PrState.togglePlay(); PrAudio.sync(); });
    bindBtn("pr-go-start",  () => { PrState.stopPlay(); PrState.playhead = 0; PrAudio.stop(); draw(); PrTimeline.drawPlayhead(); });
    bindBtn("pr-go-end",    () => { PrState.stopPlay(); PrState.playhead = PrState.seq?.duration || 0; PrAudio.stop(); draw(); PrTimeline.drawPlayhead(); });
    bindBtn("pr-step-back", () => { PrState.stopPlay(); PrState.playhead -= 1 / (PrState.seq?.fps || 30); PrAudio.stop(); draw(); PrTimeline.drawPlayhead(); });
    bindBtn("pr-step-fwd",  () => { PrState.stopPlay(); PrState.playhead += 1 / (PrState.seq?.fps || 30); PrAudio.stop(); draw(); PrTimeline.drawPlayhead(); });
    bindBtn("pr-lift",    liftAtPlayhead);
    bindBtn("pr-extract", extractAtPlayhead);
    draw();
  }

  function resizeCanvas() {
    if (!cvs) return;
    const p = cvs.parentElement;
    if (!p) return;
    cvs.width  = p.clientWidth  || 400;
    cvs.height = (p.clientHeight || 300) - 36;
  }

  async function draw() {
    if (!ctx || !cvs) return;
    const W = cvs.width, H = cvs.height;
    ctx.clearRect(0, 0, W, H);
    const seq = PrState.seq;
    if (!seq) {
      ctx.fillStyle = "#0d0d0d"; ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = "#444"; ctx.font = "13px system-ui"; ctx.textAlign = "center";
      ctx.fillText("No sequence — create one in the bins panel", W / 2, H / 2);
      return;
    }
    await PrRenderer.renderFrame(ctx, seq, PrState.playhead, PrState.playing);
    const seq2 = PrState.seq;
    if (seq2 && seq2.subtitles && seq2.subtitles.length) {
      const sub = seq2.subtitles.find(s => PrState.playhead >= s.start && PrState.playhead < s.end);
      if (sub) {
        const cw = cvs.width, ch = cvs.height;
        const lines = sub.text.split("\n");
        const lineH = Math.round(cw * 0.045), pad = 12;
        const totalH = lines.length * lineH + pad*2;
        ctx.save();
        ctx.fillStyle = "rgba(0,0,0,0.65)";
        ctx.fillRect(cw*0.1, ch-totalH-20, cw*0.8, totalH);
        ctx.font = `bold ${lineH*0.72|0}px Inter,system-ui,sans-serif`;
        ctx.fillStyle = "#fff";
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        lines.forEach((l,i) => ctx.fillText(l, cw/2, ch-totalH-20+pad+lineH*(i+0.5)));
        ctx.restore();
      }
    }
    _drawOverlay(W, H, seq);
  }

  function _drawOverlay(W, H, seq) {
    const by = H - 12, bh = 4;
    ctx.fillStyle = "rgba(0,0,0,.55)"; ctx.fillRect(0, by - 4, W, bh + 8);
    ctx.fillStyle = "#333"; ctx.fillRect(0, by, W, bh);
    const px = (PrState.playhead / seq.duration) * W;
    ctx.fillStyle = "#5e6ad2"; ctx.fillRect(0, by, px, bh);
    ctx.fillStyle = "#fff"; ctx.fillRect(px - 1, by - 3, 2, bh + 6);
    ctx.fillStyle = "rgba(0,0,0,.7)"; ctx.fillRect(0, H - 16, 100, 16);
    ctx.fillStyle = "#ccc"; ctx.font = "10px monospace"; ctx.textAlign = "left";
    ctx.fillText(prFmtTCFull(PrState.playhead), 4, H - 4);
  }

  function onDown(e) {
    PrState.stopPlay(); PrAudio.stop();
    scrub = true; moveScrub(e);
    const mm = e2 => { if (scrub) moveScrub(e2); };
    const mu = () => { scrub = false; document.removeEventListener("mousemove", mm); document.removeEventListener("mouseup", mu); };
    document.addEventListener("mousemove", mm);
    document.addEventListener("mouseup", mu);
  }
  function moveScrub(e) {
    const seq = PrState.seq; if (!seq) return;
    const r = cvs.getBoundingClientRect();
    PrState.playhead = Math.max(0, Math.min(seq.duration, ((e.clientX - r.left) / r.width) * seq.duration));
    draw(); PrTimeline.drawPlayhead();
  }

  function liftAtPlayhead() {
    const seq = PrState.seq; if (!seq) return;
    seq.videoTracks.forEach(tr => {
      const c = tr.clips.find(c => PrState.playhead >= c.seqStart && PrState.playhead < c.seqEnd);
      if (c) PrState.removeClip(c.id);
    });
    PrTimeline.draw();
  }

  function extractAtPlayhead() {
    const seq = PrState.seq; if (!seq) return;
    PrState.allTracks().forEach(tr => {
      const c = tr.clips.find(c => PrState.playhead >= c.seqStart && PrState.playhead < c.seqEnd);
      if (!c) return;
      const dur = c.seqEnd - c.seqStart;
      PrState.removeClip(c.id);
      tr.clips.filter(cc => cc.seqStart >= c.seqEnd).forEach(cc => { cc.seqStart -= dur; cc.seqEnd -= dur; });
    });
    PrState.refreshDuration();
    PrTimeline.draw();
  }

  return { init, draw, resizeCanvas };
})();

/* ── PrAudio — sequence audio playback ─────────────────────────────── */
const PrAudio = (() => {
  const _playing = new Map(); // assetId → { el, startWallTime, startSeqTime }

  function sync() {
    if (!PrState.playing) { stop(); return; }
    const seq = PrState.seq; if (!seq) return;
    const now = performance.now() / 1000;
    const seqT = PrState.playhead;

    // Stop elements no longer needed
    _playing.forEach((info, assetId) => {
      const active = seq.audioTracks.some(tr =>
        tr.clips.some(c => !tr.mute && assetId === c.assetId && seqT >= c.seqStart && seqT < c.seqEnd)
      );
      if (!active) { try { info.el.pause(); } catch(e){} _playing.delete(assetId); }
    });

    // Start/continue audio elements for active clips
    seq.audioTracks.forEach(tr => {
      if (tr.mute) return;
      tr.clips.forEach(clip => {
        if (seqT < clip.seqStart || seqT >= clip.seqEnd) return;
        const asset = prAsset(clip.assetId); if (!asset) return;
        const clipT = clip.srcIn + (seqT - clip.seqStart) * clip.speed;
        if (_playing.has(clip.assetId)) {
          const info = _playing.get(clip.assetId);
          info.el.volume = clamp((clip.volume || 100) / 100, 0, 1);
          info.el.playbackRate = clip.speed || 1;
          return;
        }
        // Also play audio from video clips if they have audio
        let el = _vidPool.get(clip.assetId);
        if (!el) {
          // Try audio element
          const vid = document.createElement("audio");
          vid.src = asset.url || asset.src || "";
          vid.preload = "auto";
          el = vid;
          _vidPool.set(clip.assetId, el);
        }
        if (!el) return;
        el.muted = false;
        el.volume = clamp((clip.volume || 100) / 100, 0, 1);
        el.playbackRate = clip.speed || 1;
        // Basic EQ/compression via Web Audio if AudioContext available
        if (clip.audio && (clip.audio.eqLow !== 0 || clip.audio.eqMid !== 0 || clip.audio.eqHigh !== 0)) {
          // We can't easily route HTMLMediaElement through AudioContext mid-play
          // So use volume as a proxy for now (full Web Audio routing is in a dedicated mixer)
          // Just apply overall gain adjustment based on eq settings
          const eqGain = 1 + (clip.audio.eqLow + clip.audio.eqMid + clip.audio.eqHigh) / 300;
          el.volume = Math.min(1, el.volume * eqGain);
        }
        el.currentTime = clipT;
        el.play().catch(() => {});
        _playing.set(clip.assetId, { el, startWallTime: now, startSeqTime: seqT });
      });
    });

    // Also unmute video clips' audio when playing
    seq.videoTracks.forEach(tr => {
      if (tr.mute) return;
      tr.clips.forEach(clip => {
        if (seqT < clip.seqStart || seqT >= clip.seqEnd) return;
        const vid = _vidPool.get(clip.assetId);
        if (vid && vid.tagName === "VIDEO" && vid.paused) {
          const clipT = clip.srcIn + (seqT - clip.seqStart) * clip.speed;
          vid.muted = false;
          vid.volume = clamp((clip.volume || 100) / 100, 0, 1);
          vid.playbackRate = clip.speed || 1;
          vid.currentTime = clipT;
          vid.play().catch(() => {});
        }
      });
    });
  }

  function stop() {
    _playing.forEach(info => { try { info.el.pause(); } catch(e){} });
    _playing.clear();
    // Mute all video elements
    _vidPool.forEach(v => { if (v.tagName === "VIDEO") { try { v.pause(); v.muted = true; } catch(e){} } });
  }

  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }

  return { sync, stop };
})();

/* ── PrLumetri (color grading panel) ───────────────────────────────── */

const PrLumetri = (() => {
  let _clip = null;
  let _panel = null;

  function show(clip) {
    _clip = clip;
    if (!_panel) _buildPanel();
    _panel.hidden = false;
    // Show/hide audio section based on clip type
    const audioSection = _panel.querySelector("#pr-lum-audio-section");
    if (audioSection) {
      const isAudio = PrState.seq && PrState.seq.audioTracks.some(tr => tr.clips.some(c => c.id === clip.id));
      audioSection.hidden = !isAudio;
      let node = audioSection.nextElementSibling;
      while (node && node.classList.contains("pr-lum-row") && node.querySelector("input[data-section='audio']")) {
        node.hidden = !isAudio;
        node = node.nextElementSibling;
      }
    }
    _refresh();
  }
  function hide() {
    if (_panel) _panel.hidden = true;
    _clip = null;
  }

  function _buildPanel() {
    _panel = document.createElement("div");
    _panel.id = "pr-lumetri-panel";
    _panel.className = "pr-lumetri";
    _panel.hidden = true;
    _panel.innerHTML = `
      <div class="pr-lumetri-head">
        <span>Lumetri Color</span>
        <button class="pr-lumetri-close" title="Close">✕</button>
      </div>
      <div class="pr-lumetri-body">
        <div class="pr-lum-section">Basic Correction</div>
        ${_slider("temp",   "Temperature", -100, 100)}
        ${_slider("tint",   "Tint",        -100, 100)}
        ${_slider("exposure","Exposure",   -10,  10, 0.1)}
        ${_slider("contrast","Contrast",   -100, 100)}
        <div class="pr-lum-section">Tone</div>
        ${_slider("highlights","Highlights",-100,100)}
        ${_slider("shadows",  "Shadows",   -100, 100)}
        ${_slider("whites",   "Whites",    -100, 100)}
        ${_slider("blacks",   "Blacks",    -100, 100)}
        <div class="pr-lum-section">Creative</div>
        ${_slider("sat",    "Saturation", -100, 100)}
        ${_slider("vibrance","Vibrance",  -100, 100)}
        <div class="pr-lum-section">Video Effects</div>
        ${_sliderFx("blur",       "Blur",       0, 100)}
        ${_sliderFx("sharpness",  "Sharpness",  0, 100)}
        ${_sliderFx("noise",      "Noise",      0, 100)}
        <div class="pr-lum-section" id="pr-lum-audio-section">Audio</div>
        ${_sliderAudio("eqLow",   "EQ Low",   -24, 24, 1)}
        ${_sliderAudio("eqMid",   "EQ Mid",   -24, 24, 1)}
        ${_sliderAudio("eqHigh",  "EQ High",  -24, 24, 1)}
        ${_sliderAudio("reverb",  "Reverb",     0, 100, 1)}
      </div>`;
    // place inside #pr-tl-body as right column
    const body = document.getElementById("pr-tl-body");
    if (body) body.appendChild(_panel);
    _panel.querySelector(".pr-lumetri-close").addEventListener("click", hide);
    _panel.querySelectorAll("input[type=range]").forEach(inp => {
      inp.addEventListener("input", () => {
        if (!_clip) return;
        const section = inp.dataset.section;
        const obj = section === "fx" ? (_clip.fx || (_clip.fx={})) : section === "audio" ? (_clip.audio || (_clip.audio={})) : (_clip.grade || (_clip.grade={}));
        obj[inp.dataset.key] = parseFloat(inp.value);
        PrProgramMonitor.draw();
        const valSpan = _panel.querySelector(`span[data-val="${inp.dataset.key}"][data-section="${section || 'grade'}"]`);
        if (valSpan) valSpan.textContent = (+inp.value).toFixed(inp.dataset.key === "exposure" ? 1 : 0);
      });
    });
  }

  function _slider(key, label, min, max, step = 1) {
    return `<div class="pr-lum-row">
      <span class="pr-lum-label">${label}</span>
      <input type="range" min="${min}" max="${max}" step="${step}" value="0" data-key="${key}" data-section="grade">
      <span class="pr-lum-val" data-val="${key}" data-section="grade">0</span>
    </div>`;
  }

  function _sliderFx(key, label, min, max, step = 1) {
    return `<div class="pr-lum-row">
      <span class="pr-lum-label">${label}</span>
      <input type="range" min="${min}" max="${max}" step="${step}" value="0" data-key="${key}" data-section="fx">
      <span class="pr-lum-val" data-val="${key}" data-section="fx">0</span>
    </div>`;
  }

  function _sliderAudio(key, label, min, max, step = 1) {
    return `<div class="pr-lum-row">
      <span class="pr-lum-label">${label}</span>
      <input type="range" min="${min}" max="${max}" step="${step}" value="0" data-key="${key}" data-section="audio">
      <span class="pr-lum-val" data-val="${key}" data-section="audio">0</span>
    </div>`;
  }

  function _refresh() {
    if (!_clip || !_panel) return;
    const g = _clip.grade || {};
    const fx = _clip.fx || {};
    const audio = _clip.audio || {};
    _panel.querySelectorAll("input[type=range]").forEach(inp => {
      const section = inp.dataset.section;
      const obj = section === "fx" ? fx : section === "audio" ? audio : g;
      inp.value = obj[inp.dataset.key] || 0;
      const valSpan = _panel.querySelector(`span[data-val="${inp.dataset.key}"][data-section="${section}"]`);
      if (valSpan) valSpan.textContent = (+inp.value).toFixed(inp.dataset.key === "exposure" ? 1 : 0);
    });
  }

  return { show, hide };
})();

/* ── PrBins (project / bins panel) ─────────────────────────────────── */

const PrBins = (() => {
  function init() {
    bindBtn("pr-new-seq-btn", () => {
      const n = PrState.seqs.length + 1;
      const seq = PrState.newSequence(`Sequence ${String(n).padStart(2,'0')}`);
      refresh();
      PrTimeline.setSequence(seq);
      PrProgramMonitor.draw();
    });
    refresh();
    const subBtn = document.createElement("button");
    subBtn.className = "btn ghost sm";
    subBtn.style.cssText = "margin:4px 8px;width:calc(100% - 16px)";
    subBtn.textContent = "Import Subtitles (.srt)…";
    subBtn.addEventListener("click", () => {
      const inp = document.createElement("input");
      inp.type = "file"; inp.accept = ".srt,.vtt";
      inp.addEventListener("change", async () => {
        const f = inp.files[0]; if (!f || !PrState.seq) return;
        const text = await f.text();
        PrState.seq.subtitles = parseSRT(text);
        if (typeof toast !== "undefined") toast(`Loaded ${PrState.seq.subtitles.length} subtitle(s)`);
        PrProgramMonitor.draw();
      });
      inp.click();
    });
    document.getElementById("pr-bins-panel")?.appendChild(subBtn);
  }

  function refresh() {
    _buildSeqList();
    _buildAssetList();
    const el = document.getElementById("pr-prog-seq-name");
    if (el && PrState.seq) el.textContent = PrState.seq.name;
    if (typeof updateMulticamBar === "function") updateMulticamBar();
  }

  function _buildSeqList() {
    const el = document.getElementById("pr-seq-list"); if (!el) return;
    el.innerHTML = "";
    PrState.seqs.forEach(seq => {
      const row = _row(seq === PrState.seq);
      row.innerHTML = `<span class="pr-bin-icon">▶</span><span class="pr-bin-label">${_esc(seq.name)}</span>`;
      row.title = seq.name;
      row.addEventListener("click", () => {
        PrState.setSeq(seq);
        PrTimeline.setSequence(seq);
        PrProgramMonitor.draw();
        refresh();
      });
      row.addEventListener("dblclick", () => {
        const n = prompt("Rename sequence:", seq.name);
        if (n && n.trim()) { seq.name = n.trim(); refresh(); }
      });
      row.draggable = true;
      row.addEventListener("dragstart", e => { e.dataTransfer.setData("pr-seq-id", seq.id); });
      el.appendChild(row);
    });
    if (!PrState.seqs.length) el.innerHTML = `<div class="pr-empty-hint">No sequences yet.</div>`;
  }

  function _buildAssetList() {
    const el = document.getElementById("pr-bins-assets"); if (!el) return;
    el.innerHTML = "";
    const assets = prAllAssets();
    if (!assets.length) {
      el.innerHTML = `<div class="pr-empty-hint">Import media in the Motion tab,<br>then switch here to edit.</div>`;
      return;
    }
    assets.forEach(asset => {
      const icon = asset.type === "video" ? "▶" : asset.type === "audio" ? "♬" : "▣";
      const dur  = asset.duration ? ` · ${prFmtTC(asset.duration)}` : "";
      const row = _row(false);
      row.innerHTML = `<span class="pr-bin-icon">${icon}</span><span class="pr-bin-label">${_esc(asset.name)}</span><span class="pr-bin-dur">${dur}</span>`;
      row.draggable = true;
      row.addEventListener("dragstart", e => { e.dataTransfer.setData("pr-asset-id", String(asset.id)); });
      row.addEventListener("dblclick", () => {
        if (asset.type !== "audio") {
          prGetVideo(asset.id).catch(() => {});
          PrSourceMonitor.loadAsset(asset.id);
          _switchSrcTab("src");
        }
      });
      row.addEventListener("click", () => {
        if (asset.type !== "audio") {
          prGetVideo(asset.id).catch(() => {});
          PrSourceMonitor.loadAsset(asset.id);
          _switchSrcTab("src");
        }
      });
      el.appendChild(row);
    });
  }

  function _switchSrcTab(tab) {
    document.getElementById("pr-src-tab-src")?.classList.toggle("active", tab === "src");
    document.getElementById("pr-src-tab-effects")?.classList.toggle("active", tab === "effects");
    const sv = document.getElementById("pr-src-view"); if (sv) sv.hidden = tab !== "src";
    const ev = document.getElementById("pr-effects-view"); if (ev) ev.hidden = tab !== "effects";
  }

  function _row(active) {
    const d = document.createElement("div");
    d.className = "pr-bin-item" + (active ? " active" : "");
    return d;
  }

  function _esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  return { init, refresh };
})();

/* ── PrTimeline ─────────────────────────────────────────────────────── */

const PrTimeline = (() => {
  let cvs, ctx, seq = null;
  const LABEL_W = 118, RULER_H = 26;
  let drag = null;

  const CLR = { video: "#1e3d72", audio: "#0f4a30", image: "#3d2a70", default: "#2a2a44" };

  function _clipColor(clip) {
    const a = prAsset(clip.assetId);
    if (!a) return clip.color || CLR.default;
    return CLR[a.type] || CLR.default;
  }

  function _bright(hex, n) {
    const v = parseInt(hex.replace("#",""), 16);
    const clamp = x => Math.min(255, Math.max(0, x));
    return `#${[v>>16, (v>>8)&0xff, v&0xff].map(c => clamp(c+n).toString(16).padStart(2,"0")).join("")}`;
  }

  function init() {
    cvs = document.getElementById("pr-tl-canvas"); if (!cvs) return;
    ctx = cvs.getContext("2d");
    _resize();
    window.addEventListener("resize", _resize);
    cvs.addEventListener("mousedown", onDown);
    cvs.addEventListener("mousemove", onMove);
    cvs.addEventListener("mouseup",   onUp);
    cvs.addEventListener("wheel",     onWheel, { passive: false });
    cvs.addEventListener("contextmenu", onCtxMenu);
    cvs.addEventListener("dragover", e => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; });
    cvs.addEventListener("drop", onDrop);
    bindBtn("pr-tool-select", () => _setTool("select"));
    bindBtn("pr-tool-ripple", () => _setTool("ripple"));
    bindBtn("pr-tool-razor",  () => _setTool("razor"));
    bindBtn("pr-tool-slip",   () => _setTool("slip"));
    bindBtn("pr-tool-hand",   () => _setTool("hand"));
    bindBtn("pr-tl-zoom-in",  () => { PrState.zoom *= 1.5; draw(); });
    bindBtn("pr-tl-zoom-out", () => { PrState.zoom /= 1.5; draw(); });
    bindBtn("pr-delete-sel",  _deleteSelected);
    bindBtn("pr-add-vtrack",  () => { seq?.videoTracks.push(makePrTrack("video",`V${seq.videoTracks.length+1}`)); draw(); });
    bindBtn("pr-add-atrack",  () => { seq?.audioTracks.push(makePrTrack("audio",`A${seq.audioTracks.length+1}`)); draw(); });
    document.addEventListener("keydown", onKeyDown);
    const titleBtn = document.createElement("button");
    titleBtn.className = "pr-tool-btn";
    titleBtn.title = "Add title clip to V1 at playhead";
    titleBtn.textContent = "T+";
    titleBtn.addEventListener("click", () => {
      const seq = PrState.seq; if (!seq || !seq.videoTracks.length) return;
      const t = prompt("Title text:", "Title");
      if (!t || !t.trim()) return;
      const dur = 5;
      const clip = makePrClip(-1, 0, dur); // assetId -1 = title-only clip
      clip.title = t.trim();
      clip._isTitleClip = true;
      PrState.addClipToTrack(seq.videoTracks[0], clip, PrState.playhead);
      PrTimeline.draw();
    });
    document.getElementById("pr-tl-toolbar")?.appendChild(titleBtn);
    draw();
  }

  function _resize() {
    if (!cvs) return;
    const p = cvs.parentElement; if (!p) return;
    cvs.width  = p.clientWidth  || 900;
    cvs.height = p.clientHeight || 240;
    draw();
  }

  function _setTool(t) {
    PrState.tool = t;
    ["select","ripple","razor","slip","hand"].forEach(id => {
      document.getElementById(`pr-tool-${id}`)?.classList.toggle("active", t === id);
    });
    cvs.style.cursor = t === "razor" ? "crosshair" : t === "hand" ? "grab" : "default";
  }

  function setSequence(s) { seq = s; PrState.setSeq(s); draw(); if (typeof updateMulticamBar === "function") updateMulticamBar(); }

  /* ── Drawing ─────────────────────────────────────────────────────── */

  function draw() {
    if (!ctx || !cvs) return;
    const W = cvs.width, H = cvs.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#141416"; ctx.fillRect(0, 0, W, H);
    if (!seq) {
      ctx.fillStyle = "#3a3a4a"; ctx.font = "13px system-ui"; ctx.textAlign = "center";
      ctx.fillText("No sequence. Click '+ Seq' to create one.", W/2, H/2); return;
    }
    _drawRuler(W);
    _drawTracks(W, H);
    drawPlayhead();
    _drawScrollbar(W, H);
  }

  function _drawRuler(W) {
    ctx.fillStyle = "#1e1e22"; ctx.fillRect(0, 0, W, RULER_H);
    ctx.fillStyle = "#0f0f11"; ctx.fillRect(0, 0, LABEL_W, RULER_H);
    if (!seq) return;
    const pps = PrState.zoom;
    const s0  = PrState.scrollX / pps, s1 = s0 + (W - LABEL_W) / pps;
    let step = 1;
    if (pps < 15) step = 30; else if (pps < 40) step = 10; else if (pps < 80) step = 5;
    else if (pps > 500) step = 0.1; else if (pps > 200) step = 0.25;
    ctx.strokeStyle = "#444"; ctx.lineWidth = 1;
    ctx.fillStyle = "#666"; ctx.font = "9px system-ui"; ctx.textAlign = "left";
    for (let t = Math.floor(s0/step)*step; t <= s1+step; t += step) {
      const x = LABEL_W + t * pps - PrState.scrollX;
      if (x < LABEL_W || x > W) continue;
      ctx.beginPath(); ctx.moveTo(x, RULER_H - 5); ctx.lineTo(x, RULER_H); ctx.stroke();
      if (x > LABEL_W + 2) ctx.fillText(prFmtTC(t), x + 2, RULER_H - 8);
    }
    // Draw sequence markers
    if (seq.markers) {
      seq.markers.forEach(m => {
        const mx = LABEL_W + m.t * PrState.zoom - PrState.scrollX;
        if (mx < LABEL_W || mx > W) return;
        ctx.save();
        ctx.fillStyle = m.color || "#4cb782";
        ctx.beginPath();
        ctx.moveTo(mx-6, 2);
        ctx.lineTo(mx+6, 2);
        ctx.lineTo(mx, 14);
        ctx.closePath();
        ctx.fill();
        if (m.label) {
          ctx.font = "10px Inter, system-ui, sans-serif";
          ctx.fillStyle = "#fff";
          ctx.textAlign = "left";
          ctx.fillText(m.label, mx+8, 13);
        }
        ctx.restore();
      });
    }
  }

  function _allTracks() {
    if (!seq) return [];
    return [...seq.videoTracks, ...seq.audioTracks];
  }

  function _trackY(idx) {
    const all = _allTracks();
    let y = RULER_H - PrState.scrollY;
    for (let i = 0; i < idx; i++) y += all[i]?.height || 0;
    return y;
  }

  function _trackAt(my) {
    const all = _allTracks();
    let y = RULER_H - PrState.scrollY;
    for (let i = 0; i < all.length; i++) {
      const h = all[i].height;
      if (my >= y && my < y + h) return { track: all[i], idx: i };
      y += h;
    }
    return null;
  }

  function _drawTracks(W, H) {
    const all = _allTracks();
    const pps = PrState.zoom;
    all.forEach((tr, i) => {
      const y = _trackY(i), h = tr.height;
      if (y + h < RULER_H || y > H) return;

      // Label bg
      ctx.fillStyle = "#1c1c1f"; ctx.fillRect(0, y, LABEL_W, h);
      ctx.strokeStyle = "#2a2a2e"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, y + h - .5); ctx.lineTo(W, y + h - .5); ctx.stroke();

      // Track name
      ctx.fillStyle = "#888"; ctx.font = "11px system-ui"; ctx.textAlign = "left";
      ctx.fillText(tr.name, 8, y + h/2 + 4);

      // Mute/Solo mini-buttons
      _miniBtn(LABEL_W - 38, y + 5, "M", tr.mute  ? "#5e6ad2" : "#333", "#ddd");
      _miniBtn(LABEL_W - 20, y + 5, "S", tr.solo  ? "#d49a20" : "#333", "#ddd");

      // Track lane
      ctx.fillStyle = "#191919"; ctx.fillRect(LABEL_W, y, W - LABEL_W, h);

      // Clips
      tr.clips.forEach(clip => {
        const cx  = LABEL_W + clip.seqStart * pps - PrState.scrollX;
        const cw  = Math.max(2, (clip.seqEnd - clip.seqStart) * pps);
        if (cx + cw < LABEL_W || cx > W) return;

        const sel = PrState.selected.has(clip.id);
        const clr = _clipColor(clip);
        ctx.fillStyle = sel ? _bright(clr, 50) : clr;
        _rrect(cx + 1, y + 2, cw - 2, h - 4, 3);
        ctx.fill();
        ctx.fillStyle = "rgba(255,255,255,0.08)";
        ctx.fillRect(cx + 1, y + 2, cw - 2, 3);
        ctx.strokeStyle = sel ? "#fff" : "rgba(255,255,255,0.18)";
        ctx.lineWidth = sel ? 1.5 : 0.5;
        _rrect(cx + 1, y + 2, cw - 2, h - 4, 3); ctx.stroke();

        // Label (top-left corner)
        const asset = prAsset(clip.assetId);
        const name = asset?.name || "Clip";
        ctx.fillStyle = "rgba(255,255,255,0.82)"; ctx.font = "10px system-ui"; ctx.textAlign = "left";
        ctx.save(); ctx.beginPath(); ctx.rect(cx + 3, y + 2, cw - 6, h - 4); ctx.clip();
        ctx.fillText(name, cx + 5, y + 14); ctx.restore();

        // Waveform for audio tracks (real peaks if available, else stub)
        if (tr.type === "audio" && cw > 24) {
          const x1 = cx + 1, x2 = cx + cw - 1;
          const ry = y + 2, rh = h - 4;
          const peaks = _waveformPeaks.get(clip.assetId);
          if (peaks) {
            ctx.save();
            ctx.strokeStyle = "rgba(76,183,130,0.8)";
            ctx.lineWidth = 1;
            const mid = ry + rh/2, amp = (rh/2 - 2);
            for (let i = 0; i < peaks.length; i++) {
              const px = Math.round(x1 + (i/peaks.length)*(x2-x1));
              if (px < LABEL_W || px > cvs.width) continue;
              const h2 = Math.max(1, peaks[i]*amp);
              ctx.beginPath(); ctx.moveTo(px, mid-h2); ctx.lineTo(px, mid+h2); ctx.stroke();
            }
            ctx.restore();
          } else {
            // fallback stub + trigger async decode
            ctx.strokeStyle = "rgba(80,200,120,0.45)"; ctx.lineWidth = 1;
            ctx.beginPath();
            for (let px = 0; px < cw - 2; px += 2) {
              const amp = (Math.sin(px * 0.4 + clip.id) * 0.35 + 0.2) * (h / 2 - 6);
              ctx.moveTo(cx + 2 + px, y + h/2 - amp);
              ctx.lineTo(cx + 2 + px, y + h/2 + amp);
            }
            ctx.stroke();
            if (asset && (asset.type === "audio" || asset.type === "video")) {
              ensureWaveform(clip.assetId);
            }
          }
        }

        // Transition tints
        if (clip.transIn) {
          const tw = Math.min(clip.transIn.duration * pps, cw / 2);
          ctx.fillStyle = "rgba(240,200,40,0.35)"; ctx.fillRect(cx+1, y+2, tw, h-4);
        }
        if (clip.transOut) {
          const tw = Math.min(clip.transOut.duration * pps, cw / 2);
          ctx.fillStyle = "rgba(240,200,40,0.35)"; ctx.fillRect(cx + cw - 1 - tw, y+2, tw, h-4);
        }

        // Clip name label (centered in clip body)
        if (cw - 2 > 30) {
          ctx.save();
          ctx.font = "11px Inter, system-ui, sans-serif";
          ctx.fillStyle = "rgba(255,255,255,0.85)";
          ctx.textBaseline = "middle";
          ctx.textAlign = "left";
          ctx.beginPath(); ctx.rect(cx+1, y+1, cw-2, h-2); ctx.clip();
          const cname = asset?.name || "Clip";
          ctx.fillText(cname, cx + 6, y + h/2);
          ctx.restore();
        }
      });
    });
  }

  function _miniBtn(x, y, lbl, bg, fg) {
    ctx.fillStyle = bg; _rrect(x, y, 14, 12, 2); ctx.fill();
    ctx.fillStyle = fg; ctx.font = "bold 8px system-ui"; ctx.textAlign = "center";
    ctx.fillText(lbl, x + 7, y + 9);
  }

  function _rrect(x, y, w, h, r) {
    ctx.beginPath();
    if (ctx.roundRect) { ctx.roundRect(x, y, w, h, r); }
    else {
      ctx.moveTo(x+r,y); ctx.lineTo(x+w-r,y); ctx.quadraticCurveTo(x+w,y,x+w,y+r);
      ctx.lineTo(x+w,y+h-r); ctx.quadraticCurveTo(x+w,y+h,x+w-r,y+h);
      ctx.lineTo(x+r,y+h); ctx.quadraticCurveTo(x,y+h,x,y+h-r);
      ctx.lineTo(x,y+r); ctx.quadraticCurveTo(x,y,x+r,y); ctx.closePath();
    }
  }

  function _drawScrollbar(W, H) {
    if (!seq || seq.duration <= 0) return;
    const vis = (W - LABEL_W) / PrState.zoom;
    if (vis >= seq.duration) return;
    const sbH = 7, sbY = H - sbH;
    const sbW = W - LABEL_W;
    ctx.fillStyle = "#222"; ctx.fillRect(LABEL_W, sbY, sbW, sbH);
    const tw = Math.max(20, (vis / seq.duration) * sbW);
    const tx = LABEL_W + (PrState.scrollX / (seq.duration * PrState.zoom)) * sbW;
    ctx.fillStyle = "#444"; _rrect(tx, sbY+1, tw, sbH-2, 3); ctx.fill();
  }

  function drawPlayhead() {
    if (!ctx || !cvs || !seq) return;
    const W = cvs.width, H = cvs.height;
    const x = LABEL_W + PrState.playhead * PrState.zoom - PrState.scrollX;
    if (x < LABEL_W - 2 || x > W) return;
    ctx.strokeStyle = "#e8c444"; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(x, RULER_H - 3); ctx.lineTo(x, H - 7); ctx.stroke();
    ctx.fillStyle = "#e8c444";
    ctx.beginPath(); ctx.moveTo(x-5,RULER_H-7); ctx.lineTo(x+5,RULER_H-7);
    ctx.lineTo(x+2,RULER_H-2); ctx.lineTo(x-2,RULER_H-2); ctx.closePath(); ctx.fill();
    // Timecode on ruler
    ctx.fillStyle = "rgba(0,0,0,.7)"; ctx.fillRect(Math.max(LABEL_W, x-24), 2, 52, 14);
    ctx.fillStyle = "#e8c444"; ctx.font = "9px monospace"; ctx.textAlign = "center";
    ctx.fillText(prFmtTC(PrState.playhead), x, 12);
  }

  /* ── Snapping ────────────────────────────────────────────────────── */

  function snapSec(sec, excludeClipId, snapRange = 8 / PrState.zoom) {
    const seq = PrState.seq; if (!seq) return sec;
    const candidates = [0, seq.duration, PrState.playhead];
    seq.videoTracks.concat(seq.audioTracks).forEach(tr => {
      tr.clips.forEach(c => {
        if (c.id !== excludeClipId) { candidates.push(c.seqStart, c.seqEnd); }
      });
    });
    const snap = candidates.find(t => Math.abs(t - sec) < snapRange);
    return snap !== undefined ? snap : sec;
  }

  /* ── Mouse ───────────────────────────────────────────────────────── */

  function _sec(cx) { return (cx - LABEL_W + PrState.scrollX) / PrState.zoom; }

  function onDown(e) {
    const r = cvs.getBoundingClientRect();
    const mx = (e.clientX - r.left) * cvs.width  / r.width;
    const my = (e.clientY - r.top)  * cvs.height / r.height;
    const sec = _sec(mx);

    if (my < RULER_H) {
      PrState.playhead = Math.max(0, sec);
      PrProgramMonitor.draw(); draw();
      drag = { type: "ph" };
      return;
    }

    const ti = _trackAt(my); if (!ti) return;
    const { track } = ti;

    // Mute/solo buttons in label area
    if (mx < LABEL_W) {
      const ty = _trackY(ti.idx) + 5;
      if (mx >= LABEL_W-38 && mx < LABEL_W-24 && my >= ty && my < ty+12) { track.mute = !track.mute; draw(); return; }
      if (mx >= LABEL_W-20 && mx < LABEL_W-6  && my >= ty && my < ty+12) { track.solo = !track.solo; draw(); return; }
      return;
    }

    const tool = PrState.tool;
    if (tool === "razor") { PrState.razorAt(sec); draw(); return; }

    const clip = track.clips.find(c => sec >= c.seqStart && sec < c.seqEnd);
    if (!clip) {
      if (!e.shiftKey) PrState.selected.clear();
      PrLumetri.hide();
      PrState.playhead = Math.max(0, sec);
      PrProgramMonitor.draw(); draw();
      drag = { type: "ph" };
      return;
    }

    if (!e.shiftKey) PrState.selected.clear();
    PrState.selected.add(clip.id);
    PrLumetri.show(clip);

    const x1 = LABEL_W + clip.seqStart * PrState.zoom - PrState.scrollX;
    const x2 = LABEL_W + clip.seqEnd   * PrState.zoom - PrState.scrollX;
    const TOL = 8;

    if (Math.abs(mx - x1) < TOL) {
      drag = { type: "trim-in", clip, startMx: mx, origSeqStart: clip.seqStart, origSrcIn: clip.srcIn };
    } else if (Math.abs(mx - x2) < TOL) {
      drag = { type: "trim-out", clip, startMx: mx, origSeqEnd: clip.seqEnd, origSrcOut: clip.srcOut };
    } else {
      const items = [...PrState.selected].map(id => {
        let c = null;
        PrState.allTracks().forEach(tr => { const f = tr.clips.find(x => x.id === id); if (f) c = f; });
        return c ? { clip: c, orig: c.seqStart } : null;
      }).filter(Boolean);
      drag = { type: "move", items, startMx: mx, ripple: tool === "ripple" };
    }
    draw();
  }

  function onMove(e) {
    const r = cvs.getBoundingClientRect();
    const mx = (e.clientX - r.left) * cvs.width  / r.width;
    const my = (e.clientY - r.top)  * cvs.height / r.height;
    const sec = _sec(mx);

    if (!drag) { _cursor(mx, my, sec); return; }

    if (drag.type === "ph") {
      PrState.playhead = Math.max(0, sec);
      PrProgramMonitor.draw(); draw();
    } else if (drag.type === "move") {
      const dSec = (mx - drag.startMx) / PrState.zoom;
      drag.items.forEach(item => {
        const dur = item.clip.seqEnd - item.clip.seqStart;
        const rawStart = Math.max(0, item.orig + dSec);
        item.clip.seqStart = snapSec(rawStart, item.clip.id);
        item.clip.seqEnd   = item.clip.seqStart + dur;
      });
      PrState.refreshDuration(); draw();
    } else if (drag.type === "trim-in") {
      const dSec = (mx - drag.startMx) / PrState.zoom;
      const newStart = Math.max(0, Math.min(drag.clip.seqEnd - 0.067, drag.origSeqStart + dSec));
      const delta = newStart - drag.origSeqStart;
      drag.clip.seqStart = newStart;
      drag.clip.srcIn    = Math.max(0, drag.origSrcIn + delta);
      draw();
    } else if (drag.type === "trim-out") {
      const dSec = (mx - drag.startMx) / PrState.zoom;
      const newEnd = Math.max(drag.clip.seqStart + 0.067, drag.origSeqEnd + dSec);
      const delta = newEnd - drag.origSeqEnd;
      drag.clip.seqEnd   = newEnd;
      drag.clip.srcOut   = Math.min(prAsset(drag.clip.assetId)?.duration || 9999, Math.max(drag.clip.srcIn + 0.067, drag.origSrcOut + delta));
      PrState.refreshDuration(); draw();
    }
  }

  function onUp() {
    if (drag && (drag.type === "move" || drag.type?.startsWith("trim"))) {
      PrState.refreshDuration(); PrProgramMonitor.draw();
    }
    drag = null;
  }

  function _cursor(mx, my, sec) {
    if (PrState.tool === "razor") { cvs.style.cursor = "crosshair"; return; }
    const ti = _trackAt(my);
    if (ti && mx > LABEL_W) {
      const clip = ti.track.clips.find(c => sec >= c.seqStart && sec < c.seqEnd);
      if (clip) {
        const x1 = LABEL_W + clip.seqStart * PrState.zoom - PrState.scrollX;
        const x2 = LABEL_W + clip.seqEnd   * PrState.zoom - PrState.scrollX;
        if (Math.abs(mx-x1) < 8 || Math.abs(mx-x2) < 8) { cvs.style.cursor = "ew-resize"; return; }
        cvs.style.cursor = "grab"; return;
      }
    }
    cvs.style.cursor = "default";
  }

  function onWheel(e) {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const r = cvs.getBoundingClientRect();
      const mx = (e.clientX - r.left) * cvs.width / r.width;
      const sec = _sec(mx);
      const factor = e.deltaY > 0 ? 0.75 : 1.33;
      const oldZoom = PrState.zoom;
      PrState.zoom *= factor;
      PrState.scrollX = Math.max(0, (PrState.scrollX + (mx - LABEL_W)) - (mx - LABEL_W) * (PrState.zoom / oldZoom));
    } else {
      PrState.scrollX += e.deltaX + e.deltaY * 0.6;
    }
    draw();
  }

  function onCtxMenu(e) {
    e.preventDefault();
    const r = cvs.getBoundingClientRect();
    const mx = (e.clientX - r.left) * cvs.width  / r.width;
    const my = (e.clientY - r.top)  * cvs.height / r.height;
    const sec = _sec(mx);
    const ti = _trackAt(my); if (!ti) return;
    const clip = ti.track.clips.find(c => sec >= c.seqStart && sec < c.seqEnd); if (!clip) return;
    _ctxMenu(e.clientX, e.clientY, clip, ti.track);
  }

  function _ctxMenu(cx, cy, clip, track) {
    document.getElementById("pr-ctx")?.remove();
    const m = document.createElement("div"); m.id = "pr-ctx"; m.className = "pr-ctx-menu";
    m.style.cssText = `left:${cx}px;top:${cy}px`;
    const items = [
      ["Delete",            () => { PrState.removeClip(clip.id); draw(); }],
      ["Ripple Delete",     () => _rippleDel(clip, track)],
      null,
      ["Dissolve In",       () => { clip.transIn  = { type:"dissolve", duration:0.5 }; draw(); }],
      ["Dissolve Out",      () => { clip.transOut = { type:"dissolve", duration:0.5 }; draw(); }],
      ["Dip to Black In",   () => { clip.transIn  = { type:"dip", duration:0.5 }; draw(); }],
      ["Dip to Black Out",  () => { clip.transOut = { type:"dip", duration:0.5 }; draw(); }],
      ["Clear Transitions", () => { clip.transIn = null; clip.transOut = null; draw(); }],
      null,
      ["Speed / Duration…", () => _speedDlg(clip)],
      ["Clip Properties…",  () => _propsDlg(clip)],
      null,
      ["Set Title…", () => {
        const t = prompt("Title text (blank to remove):", clip.title || "");
        if (t !== null) clip.title = t.trim() || null;
        draw();
      }],
    ];
    items.forEach(item => {
      if (!item) { const s = document.createElement("div"); s.className = "pr-ctx-sep"; m.appendChild(s); return; }
      const row = document.createElement("div"); row.className = "pr-ctx-item"; row.textContent = item[0];
      row.onclick = () => { item[1](); m.remove(); };
      m.appendChild(row);
    });
    document.body.appendChild(m);
    setTimeout(() => document.addEventListener("mousedown", function d() { m.remove(); document.removeEventListener("mousedown", d); }, { once: true }), 10);
  }

  function _rippleDel(clip, track) {
    const dur = clip.seqEnd - clip.seqStart, start = clip.seqStart;
    PrState.removeClip(clip.id);
    track.clips.filter(c => c.seqStart >= start).forEach(c => { c.seqStart -= dur; c.seqEnd -= dur; });
    PrState.refreshDuration(); draw();
  }

  function _speedDlg(clip) {
    const v = parseFloat(prompt("Speed multiplier (1.0 = normal, 2.0 = double speed):", String(clip.speed)));
    if (isNaN(v) || v <= 0) return;
    clip.speed = v;
    clip.seqEnd = clip.seqStart + (clip.srcOut - clip.srcIn) / v;
    PrState.refreshDuration(); draw();
  }

  function _propsDlg(clip) {
    const a = prAsset(clip.assetId);
    const lines = [
      `Clip: ${a?.name || "Unknown"}`,
      `Start: ${prFmtTCFull(clip.seqStart)}`,
      `End:   ${prFmtTCFull(clip.seqEnd)}`,
      `Dur:   ${prFmtTCFull(clip.seqEnd - clip.seqStart)}`,
      `Speed: ${(clip.speed * 100).toFixed(0)}%`,
      `Opacity: ${clip.opacity}%`,
      `Src In: ${prFmtTC(clip.srcIn)}  Out: ${prFmtTC(clip.srcOut)}`,
    ];
    alert(lines.join("\n"));
  }

  function _deleteSelected() {
    PrState.selected.forEach(id => PrState.removeClip(id));
    PrState.selected.clear(); draw();
  }

  function onDrop(e) {
    e.preventDefault();
    const assetId = parseInt(e.dataTransfer.getData("pr-asset-id"), 10);
    const seqId = e.dataTransfer.getData("pr-seq-id");
    if (seqId && seq) {
      const nested = PrState.seqs.find(s => s.id === parseInt(seqId, 10));
      if (!nested || nested === seq) return;
      const r = cvs.getBoundingClientRect();
      const mx = (e.clientX - r.left) * cvs.width  / r.width;
      const my = (e.clientY - r.top)  * cvs.height / r.height;
      const sec = Math.max(0, _sec(mx));
      const dur = nested.duration || 5;
      const clip = makePrClip(-1, 0, dur);
      clip.seqId = nested.id;
      clip._label = nested.name;
      if (seq.videoTracks.length) PrState.addClipToTrack(seq.videoTracks[0], clip, sec);
      draw(); return;
    }
    if (!assetId || !seq) return;
    const r = cvs.getBoundingClientRect();
    const mx = (e.clientX - r.left) * cvs.width  / r.width;
    const my = (e.clientY - r.top)  * cvs.height / r.height;
    const sec = Math.max(0, _sec(mx));
    const ti = _trackAt(my); if (!ti) return;
    const a = prAsset(assetId); if (!a) return;
    const dur = a.duration || 5;
    const clip = makePrClip(assetId, 0, dur);
    PrState.addClipToTrack(ti.track, clip, sec);
    // Linked audio: if dropping a video with duration on a video track, also add to first audio track
    if (a.type === "video" && seq.audioTracks.length > 0) {
      const isVideoTrack = seq.videoTracks.includes(ti.track);
      if (isVideoTrack) {
        prGetVideo(assetId).then(v => {
          if (v && !v.muted) { // video has audio
            const aClip = makePrClip(assetId, 0, dur);
            aClip.opacity = 100; // mark as audio-linked
            PrState.addClipToTrack(seq.audioTracks[0], aClip, sec);
            ensureWaveform(assetId); // trigger waveform decode for linked audio
            draw();
          }
        }).catch(() => {});
      }
    }
    // Trigger waveform loading for audio assets dropped directly
    if (a.type === "audio") ensureWaveform(assetId);
    draw();
  }

  function onKeyDown(e) {
    if (document.getElementById("pr-app")?.hidden) return;
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
    if (e.code === "Space") { e.preventDefault(); PrState.togglePlay(); }
    else if (e.code === "KeyV") _setTool("select");
    else if (e.code === "KeyC" && !e.ctrlKey && !e.metaKey) _setTool("razor");
    else if (e.code === "KeyB") _setTool("ripple");
    else if (e.code === "KeyH") _setTool("hand");
    else if (e.code === "Delete" || e.code === "Backspace") _deleteSelected();
    else if (e.code === "ArrowLeft")  { PrState.playhead -= e.shiftKey ? 1 : 1/(seq?.fps||30); PrProgramMonitor.draw(); draw(); }
    else if (e.code === "ArrowRight") { PrState.playhead += e.shiftKey ? 1 : 1/(seq?.fps||30); PrProgramMonitor.draw(); draw(); }
    else if (e.code === "KeyM") {
      const seq = PrState.seq; if (!seq) return;
      if (!seq.markers) seq.markers = [];
      seq.markers.push({ id: prUID(), t: PrState.playhead, label: "", color: "#4cb782" });
      draw();
    }
    else if (e.code.startsWith("Digit") && PrState.seq?.multicam) {
      const camIdx = parseInt(e.code.slice(5), 10) - 1;
      if (camIdx >= 0 && camIdx < (PrState.seq.videoTracks||[]).length) {
        PrState.seq.videoTracks.forEach((t,i) => { t.mute = (i !== camIdx); });
        draw(); PrProgramMonitor.draw();
      }
    }
  }

  return { init, setSequence, draw, drawPlayhead };
})();

/* ── PrTabManager ────────────────────────────────────────────────────── */

const PrTabManager = (() => {
  function init() {
    bindBtn("tab-motion", () => switchTo("motion"));
    bindBtn("tab-edit",   () => switchTo("edit"));
  }

  function switchTo(tab) {
    const edit = tab === "edit";
    const s = (id, hide) => { const el = document.getElementById(id); if (el) el.hidden = hide; };
    s("main", edit);
    s("timeline", edit);
    s("rs-tl", edit);
    s("pr-app", !edit);
    document.getElementById("tab-motion")?.classList.toggle("active", !edit);
    document.getElementById("tab-edit")?.classList.toggle("active",   edit);
    if (edit) {
      PrSourceMonitor.resizeCanvas();
      PrProgramMonitor.resizeCanvas();
      PrTimeline.draw();
      PrProgramMonitor.draw();
      PrBins.refresh();
    }
  }

  return { init, switchTo };
})();

/* ── Helper ─────────────────────────────────────────────────────────── */

function bindBtn(id, fn) {
  document.getElementById(id)?.addEventListener("click", fn);
}

/* ── initPremiere ────────────────────────────────────────────────────── */

function updateMulticamBar() {
  let bar = document.getElementById("pr-multicam-bar");
  if (!PrState.seq?.multicam) { if (bar) bar.hidden = true; return; }
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "pr-multicam-bar";
    bar.style.cssText = "display:flex;gap:4px;padding:4px 8px;background:var(--bg-3);border-bottom:1px solid var(--border)";
    document.getElementById("pr-tl-toolbar")?.before(bar);
  }
  bar.hidden = false;
  bar.innerHTML = "<span style='font-size:11px;color:var(--text-3);margin-right:4px'>CAM:</span>";
  (PrState.seq.videoTracks || []).forEach((tr, i) => {
    const btn = document.createElement("button");
    btn.className = "pr-tool-btn";
    btn.textContent = String(i+1);
    btn.title = `Switch to camera ${i+1} at playhead`;
    btn.addEventListener("click", () => {
      // Mute all video tracks except selected
      PrState.seq.videoTracks.forEach((t2, j) => { t2.mute = (j !== i); });
      PrTimeline.draw();
      PrProgramMonitor.draw();
    });
    bar.appendChild(btn);
  });
}

function initPremiere() {
  if (PrState.seqs.length === 0) PrState.newSequence("Sequence 01");

  if (!document.getElementById("pr-lumetri-styles")) {
    const s = document.createElement("style");
    s.id = "pr-lumetri-styles";
    s.textContent = `
      #pr-tl-body { display:flex; }
      #pr-tl-canvas { flex:1; min-width:0; }
      #pr-lumetri-panel { width:210px; flex-shrink:0; background:var(--bg-2); border-left:1px solid var(--border); overflow-y:auto; font-size:12px; }
      .pr-lumetri-head { display:flex; align-items:center; justify-content:space-between; padding:6px 10px; border-bottom:1px solid var(--border); font-weight:600; }
      .pr-lumetri-close { background:none; border:none; color:var(--text-2); cursor:pointer; font-size:14px; padding:0 2px; }
      .pr-lumetri-close:hover { color:var(--text-1); }
      .pr-lumetri-body { padding:8px; }
      .pr-lum-section { font-size:10px; font-weight:600; text-transform:uppercase; letter-spacing:.06em; color:var(--text-3); margin:10px 0 4px; }
      .pr-lum-row { display:flex; align-items:center; gap:4px; margin-bottom:4px; }
      .pr-lum-label { width:74px; color:var(--text-2); flex-shrink:0; }
      .pr-lum-row input[type=range] { flex:1; height:3px; accent-color:var(--accent); }
      .pr-lum-val { width:28px; text-align:right; color:var(--text-3); }
    `;
    document.head.appendChild(s);
  }

  PrSourceMonitor.init();
  PrProgramMonitor.init();
  PrBins.init();
  PrTimeline.init();
  PrTimeline.setSequence(PrState.seq);
  PrTabManager.init();

  // Source-monitor tabs
  function switchSrcTab(tab) {
    document.getElementById("pr-src-tab-src")?.classList.toggle("active", tab === "src");
    document.getElementById("pr-src-tab-effects")?.classList.toggle("active", tab === "effects");
    const sv = document.getElementById("pr-src-view"),  ev = document.getElementById("pr-effects-view");
    if (sv) sv.hidden = tab !== "src";
    if (ev) ev.hidden = tab !== "effects";
  }
  bindBtn("pr-src-tab-src",     () => switchSrcTab("src"));
  bindBtn("pr-src-tab-effects", () => switchSrcTab("effects"));

  // Effects panel: drag transition onto selected clip
  document.querySelectorAll(".pr-fx-item[data-trans]").forEach(item => {
    item.addEventListener("dblclick", () => {
      const type = item.dataset.trans;
      PrState.selected.forEach(id => {
        PrState.allTracks().forEach(tr => {
          const c = tr.clips.find(c => c.id === id);
          if (c) { c.transIn = { type, duration: 0.5 }; c.transOut = { type, duration: 0.5 }; }
        });
      });
      PrTimeline.draw();
    });
    item.title = "Double-click to apply to selected clip";
  });

  // Sequence settings
  document.getElementById("pr-seq-fps")?.addEventListener("change", e => {
    if (PrState.seq) PrState.seq.fps = parseFloat(e.target.value);
  });
  document.getElementById("pr-seq-res")?.addEventListener("change", e => {
    const [w, h] = e.target.value.split("x").map(Number);
    if (PrState.seq) { PrState.seq.width = w; PrState.seq.height = h; }
  });

  // Export sequence
  bindBtn("pr-export-btn", () => exportSequence());

  updateMulticamBar();
}

async function exportSequence() {
  const seq = PrState.seq;
  if (!seq) { if (typeof toast !== "undefined") toast("No sequence to export"); return; }
  const fmt = document.getElementById("pr-export-format")?.value || "webm";
  const fps = seq.fps || 30;
  const totalFrames = Math.ceil(seq.duration * fps);
  const W = seq.width, H = seq.height;

  if (typeof toast !== "undefined") toast("Exporting sequence…");

  const cv = document.createElement("canvas");
  cv.width = W; cv.height = H;
  const cctx = cv.getContext("2d");

  // Try WebCodecs MP4 first if fmt=mp4
  if (fmt === "mp4" && window.VideoEncoder && typeof Muxer !== "undefined" && Muxer?.Muxer) {
    try {
      const muxer = new Muxer.Muxer({
        target: new Muxer.ArrayBufferTarget(),
        video: { codec: "avc", width: W, height: H },
        fastStart: "in-memory",
      });
      const encoder = new VideoEncoder({
        output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
        error: e => console.error("VideoEncoder:", e),
      });
      encoder.configure({ codec: "avc1.42001f", width: W, height: H, bitrate: 8_000_000, framerate: fps });
      for (let f = 0; f < totalFrames; f++) {
        const t = f / fps;
        await PrRenderer.renderFrame(cctx, seq, t, false);
        const frame = new VideoFrame(cv, { timestamp: Math.round(t * 1_000_000), duration: Math.round(1_000_000 / fps) });
        encoder.encode(frame, { keyFrame: f % 30 === 0 });
        frame.close();
      }
      await encoder.flush();
      muxer.finalize();
      const buf = muxer.target.buffer;
      const blob = new Blob([buf], { type: "video/mp4" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = (seq.name || "sequence") + ".mp4"; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      if (typeof toast !== "undefined") toast("Sequence exported as MP4");
      return;
    } catch(e) { console.warn("MP4 export failed, falling back to WebM:", e); }
  }

  // WebM fallback via MediaRecorder
  const stream = cv.captureStream(fps);
  const chunks = [];
  const rec = new MediaRecorder(stream, { mimeType: "video/webm" });
  rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
  await new Promise(resolve => {
    rec.onstop = resolve;
    rec.start();
    let f = 0;
    (function frame() {
      if (f >= totalFrames) { rec.stop(); return; }
      const t = f / fps;
      PrRenderer.renderFrame(cctx, seq, t, false).then(() => { f++; requestAnimationFrame(frame); });
    })();
  });
  const blob = new Blob(chunks, { type: "video/webm" });
  const url = URL.createObjectURL(blob);
  const a2 = document.createElement("a"); a2.href = url; a2.download = (seq.name || "sequence") + ".webm"; a2.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  if (typeof toast !== "undefined") toast("Sequence exported as WebM");
}
