"use strict";
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
const pad = n => String(n).padStart(2, "0");
const tc = t => { t = Math.max(0, Math.floor(t || 0)); return `${pad(Math.floor(t / 3600))}:${pad(Math.floor(t % 3600 / 60))}:${pad(t % 60)}`; };
const parseTc = s => { s = String(s).trim(); if (!s) return null; let t = 0;
  for (const p of s.split(":")) { const v = parseFloat(p); if (isNaN(v)) return null; t = t * 60 + v; } return t; };
const ago = ts => { const s = Math.max(0, Date.now() / 1000 - ts);
  return s < 60 ? `${Math.floor(s)}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`; };
const api = async (path, opts = {}) => {
  const r = await fetch(path, {headers: {"Content-Type": "application/json"}, ...opts});
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.detail || `Request failed (${r.status})`);
  return d;
};
function toast(msg, err) {
  const el = document.createElement("div"); el.textContent = msg; if (err) el.className = "err";
  $("#toast").appendChild(el); setTimeout(() => el.remove(), err ? 7000 : 3500);
}
const isoTime = ts => { const d = new Date(ts * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
const scoreCls = s => s >= 70 ? "hi" : s >= 50 ? "mid" : "lo";
const LAYOUTS = {track: "FOLLOW SPEAKER", split: "FACECAM / GAME", zoom: "GAMEPLAY ZOOM", fit: "FULL FRAME", center: "CENTER CROP"};

/* ---------------- frame: routing, clock, keys ---------------- */
const PAGES = ["discovery", "factory", "packaging", "shipping", "system"];
function route() {
  const p = PAGES.includes(location.hash.slice(1)) ? location.hash.slice(1) : "discovery";
  $$(".page").forEach(el => el.classList.toggle("on", el.id === "page-" + p));
  $$(".tabs a").forEach(a => a.classList.toggle("on", a.dataset.page === p));
  if (p === "discovery") requestAnimationFrame(drawTimeline);
  if (p === "packaging") requestAnimationFrame(fitPhone);
  if (p !== "packaging" && pv && !pv.paused) pv.pause();
}
const go = p => { location.hash = "#" + p; };
window.addEventListener("hashchange", route);
function tick() {
  const d = new Date();
  $("#clock").textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  $("#clock-date").textContent = d.toISOString().slice(0, 10);
}
setInterval(tick, 1000); tick();

/* ---------------- command line ---------------- */
const HELP = "AUTO <url> = clip a whole stream overnight · URL or file path = load source to pick by hand · DIS FAC PKG SHIP SYS = switch module · IN / OUT = mark range · SEND = dispatch · WO 1001 = open order";
function runCommand(raw) {
  const s = raw.trim(); if (!s) return;
  const up = s.toUpperCase(), [head, ...rest] = up.split(/\s+/);
  if (head === "AUTO" && rest.length) return queueAuto(s.split(/\s+/).slice(1));
  if (/^https?:\/\//i.test(s) || s.startsWith("/") || s.startsWith("~")) return loadSource(s);
  const nav = {DIS: "discovery", DISC: "discovery", DISCOVERY: "discovery", WB: "discovery", FAC: "factory", FACTORY: "factory",
    PKG: "packaging", PACK: "packaging", PACKAGING: "packaging", SHIP: "shipping", SHIPPING: "shipping", SYS: "system", SYSTEM: "system"};
  if (nav[head]) return go(nav[head]);
  if (head === "IN" && src) return markIn();
  if (head === "OUT" && src) return markOut();
  if (head === "SEND" || head === "DISPATCH") return $("#send").disabled ? toast("No valid range selected", true) : dispatch();
  if (head === "WO" && rest[0]) { const j = jobs.find(x => String(x.order) === rest[0].replace("WO-", ""));
    if (!j) return toast(`WO-${rest[0]} not found`, true); selOrder = j.id; renderOrders(true); return go("factory"); }
  if (head === "HELP" || head === "?") return toast(HELP);
  toast(`Unknown command: ${s}. Type HELP.`, true);
}
$("#cmd").addEventListener("keydown", e => { if (e.key === "Enter") { runCommand(e.target.value); e.target.select(); }
  if (e.key === "Escape") e.target.blur(); });
$("#cmd-go").onclick = () => runCommand($("#cmd").value);

document.addEventListener("keydown", e => {
  const fk = {F1: "discovery", F2: "factory", F3: "packaging", F4: "shipping", F5: "system"}[e.key];
  if (fk) { e.preventDefault(); return go(fk); }
  if ((e.metaKey || e.ctrlKey) && ["1", "2", "3", "4", "5"].includes(e.key)) { e.preventDefault(); return go(PAGES[+e.key - 1]); }
  const typing = ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement.tagName);
  if (e.key === "/" && !typing) { e.preventDefault(); $("#cmd").focus(); $("#cmd").select(); return; }
  if (!typing && $("#page-packaging").classList.contains("on")) return bayKey(e);
  if (typing || !src || !$("#page-discovery").classList.contains("on")) return;
  const k = e.key.toLowerCase();
  if (k === " ") { e.preventDefault(); video.paused ? video.play() : video.pause(); }
  else if (k === "i") markIn();
  else if (k === "o") markOut();
  else if (k === "j") seek(video.currentTime - 10);
  else if (k === "l") seek(video.currentTime + 10);
  else if (k === "arrowleft") seek(video.currentTime - (e.shiftKey ? 60 : 5));
  else if (k === "arrowright") seek(video.currentTime + (e.shiftKey ? 60 : 5));
});

/* ---------------- discovery: source ---------------- */
const video = $("#video");
let src = null, hls = null, heat = null, sel = null, heatTimer = null;

async function loadSource(source) {
  go("discovery");
  $("#cmd").value = source;
  toast("LOADING SOURCE…");
  try {
    src = await api("/api/probe", {method: "POST", body: JSON.stringify({source})});
    showSource();
  } catch (e) { toast(e.message, true); }
}

function showSource() {
  $("#wb-empty").style.display = "none"; $("#wb-loaded").style.display = "";
  $("#src-kind").textContent = src.kind === "file" ? "FILE" : src.kind.toUpperCase();
  $("#src-kind").className = "tag " + (src.kind === "twitch" ? "blue" : src.kind === "file" ? "" : "amber");
  $("#src-title").textContent = src.title;
  $("#src-chan").textContent = src.channel ? `CH ${src.channel}` : "";
  $("#src-dur").textContent = tc(src.duration);
  $("#src-id").textContent = src.twitch_id ? `VOD ${src.twitch_id}` : `KEY ${src.key}`;
  $("#ovl-src").textContent = `SRC ${(src.channel || src.title).slice(0, 32).toUpperCase()}`;
  $("#mon-fmt").textContent = `PREVIEW ${src.preview_type.toUpperCase()}`;
  sel = null; heat = null; updateSel(); updateTc();
  $("#player-msg").style.display = "none";
  if (hls) { hls.destroy(); hls = null; }
  if (src.preview_type === "hls" && !video.canPlayType("application/vnd.apple.mpegurl") && window.Hls && Hls.isSupported()) {
    hls = new Hls({maxBufferLength: 20}); hls.loadSource(src.preview_url); hls.attachMedia(video);
    hls.on(Hls.Events.ERROR, (_, d) => { if (d.fatal) previewFailed(); });
  } else { video.src = src.preview_url; }
  clearInterval(heatTimer); pollHeat(); heatTimer = setInterval(pollHeat, 2000);
  requestAnimationFrame(drawTimeline);
}

function previewFailed() {
  const m = $("#player-msg"); m.style.display = "";
  m.innerHTML = `<b>PREVIEW UNAVAILABLE</b><span>This player can't decode the stream. Use the signal timeline and peaks to pick a range; production is unaffected.</span>`;
}
video.addEventListener("error", () => { if (src) previewFailed(); });

async function pollHeat() {
  if (!src) return;
  try { heat = await api(`/api/heatmap/${src.key}`); } catch { return; }
  if (heat.state !== "running") clearInterval(heatTimer);
  const label = {"Chat activity": "CHAT DENSITY", "Most replayed": "REPLAY DENSITY"}[heat.source] || "NO SIGNAL";
  $("#tl-signal").textContent = heat.state === "none" ? "NO SIGNAL FOR THIS SOURCE" : label;
  $("#tl-status").textContent =
    heat.state === "running" ? ` · INGEST ${Math.round((heat.progress || 0) * 100)}%` :
    heat.state === "error" ? " · CHAT UNAVAILABLE" :
    heat.messages ? ` · ${heat.messages.toLocaleString()} MSG` : "";
  $("#hot-src").textContent = heat.state === "done" ? label : "";
  renderHot(); drawTimeline();
}

function renderHot() {
  const box = $("#hot");
  if (!heat || !heat.peaks || !heat.peaks.length) {
    box.innerHTML = `<div class="empty"><b>${heat && heat.state === "running" ? "INGESTING CHAT REPLAY" : "NO PEAKS"}</b>${
      heat && heat.state === "running" ? "Peaks appear when the signal is ready." : "Scrub the source and mark a range manually."}</div>`;
    return;
  }
  const top = Math.max(...heat.peaks.map(p => p.intensity));
  const ranked = heat.peaks.map((p, i) => ({...p, i})).sort((a, b) => b.intensity - a.intensity);
  box.innerHTML = `<table class="dt"><thead><tr><th style="width:28px">#</th><th style="width:76px">TC</th><th>Index</th><th class="r" style="width:36px">×</th><th style="width:80px"></th></tr></thead><tbody>
    ${ranked.map((p, n) => `<tr class="click"><td class="faint mono">${n + 1}</td><td class="data">${tc(p.start)}</td>
      <td><div class="hotbar"><i style="width:${(p.intensity / top * 100).toFixed(0)}%"></i></div></td>
      <td class="r mono">${p.intensity.toFixed(1)}</td>
      <td class="r acts-cell"><button class="btn minimal" data-go="${p.i}" title="Preview">▶</button><button class="btn" data-sel="${p.i}">SEL</button></td></tr>`).join("")}
    </tbody></table>`;
  $$("[data-go]", box).forEach(b => b.onclick = () => { seek(heat.peaks[+b.dataset.go].start); video.play(); });
  $$("[data-sel]", box).forEach(b => b.onclick = () => { const p = heat.peaks[+b.dataset.sel]; setSel(p.start, p.end); seek(p.start); });
}

async function renderRecent() {
  const list = await api("/api/recent").catch(() => []);
  $("#recent-n").textContent = `${list.length} ENTRIES`;
  $("#recent").innerHTML = list.length ? `<table class="dt"><thead><tr><th style="width:70px">Type</th><th>Source</th><th style="width:180px">Channel</th><th class="r" style="width:90px">Duration</th><th class="r" style="width:70px">Loaded</th></tr></thead><tbody>
    ${list.map((r, i) => `<tr class="click" data-i="${i}"><td><span class="tag ${r.kind === "twitch" ? "blue" : r.kind === "file" ? "" : "amber"}">${esc(r.kind)}</span></td>
      <td>${esc(r.title)}</td><td class="t2">${esc(r.channel)}</td><td class="r data">${tc(r.duration)}</td><td class="r mono faint">${ago(r.at)}</td></tr>`).join("")}</tbody></table>`
    : `<div class="empty"><b>NO SOURCES ON RECORD</b>Paste a stream or video URL into the command line and press GO.</div>`;
  $$("#recent tr.click").forEach(tr => tr.ondblclick = tr.onclick = () => loadSource(list[+tr.dataset.i].source));
}
$("#keys").innerHTML = [["/", "Command line"], ["F1–F5", "Switch module"], ["B", "Drop sound (Packaging)"], ["Space", "Play / pause"], ["I / O", "Mark in / out"],
  ["J / L", "−10 s / +10 s"], ["← / →", "−5 s / +5 s (⇧ 60 s)"]].map(([k, v]) => `<div><span class="key">${k}</span></div><div class="t2">${v}</div>`).join("");

async function openFile() {
  if (window.pywebview && window.pywebview.api && window.pywebview.api.pick_file) {
    const path = await window.pywebview.api.pick_file();
    if (path) loadSource(path);
  } else { $("#file-input").click(); }
}
$("#btn-file").onclick = openFile;
$("#file-input").onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  const fd = new FormData(); fd.append("file", f);
  toast("IMPORTING FILE…");
  try {
    const r = await fetch("/api/upload", {method: "POST", body: fd}); const d = await r.json();
    if (!r.ok) throw new Error(d.detail || "Import failed");
    src = d; go("discovery"); showSource();
  } catch (err) { toast(err.message, true); }
  e.target.value = "";
};

/* ---------------- transport ---------------- */
const seek = t => { video.currentTime = Math.max(0, Math.min(t, (src && src.duration) || t)); updateTc(); drawTimeline(); };
let loopSel = false;
function updateTc() {
  const t = video.currentTime || 0;
  $("#tp-tc").innerHTML = `${tc(t)} <small>/ ${tc(src ? src.duration : 0)}</small>`;
  $("#ovl-tc").textContent = tc(t);
}
$("#tp-play").onclick = () => video.paused ? video.play() : video.pause();
$("#tp-back").onclick = () => seek(video.currentTime - 10);
$("#tp-fwd").onclick = () => seek(video.currentTime + 10);
$("#tp-in").onclick = () => markIn();
$("#tp-out").onclick = () => markOut();
$("#tp-clear").onclick = () => { sel = null; updateSel(); };
$("#tp-loop").onclick = () => { if (!sel) return; loopSel = true; seek(sel.start); video.play(); };
video.addEventListener("play", () => $("#tp-play").textContent = "PAUSE");
video.addEventListener("pause", () => $("#tp-play").textContent = "PLAY");
video.addEventListener("timeupdate", () => {
  updateTc();
  if (loopSel && sel && video.currentTime >= sel.end) { video.pause(); loopSel = false; }
  drawTimeline();
});
function markIn() { const t = video.currentTime; setSel(t, sel && sel.end > t + 1 ? sel.end : Math.min(t + 600, src.duration)); }
function markOut() { const t = video.currentTime; setSel(sel && sel.start < t - 1 ? sel.start : Math.max(0, t - 600), t); }

/* ---------------- selection + dispatch ---------------- */
function setSel(a, b) {
  if (!src) return;
  a = Math.max(0, Math.min(a, src.duration)); b = Math.max(0, Math.min(b, src.duration));
  if (b < a) [a, b] = [b, a];
  sel = b - a >= 1 ? {start: a, end: b} : null;
  updateSel();
}
function updateSel() {
  const exact = $("#opt-mode").value === "exact", len = sel ? sel.end - sel.start : 0;
  const ok = !!sel && (exact ? len >= 3 && len <= 180 : len >= 10);
  $("#opt-clips").disabled = $("#opt-len").disabled = exact;
  $("#sel-in").value = sel ? tc(sel.start) : ""; $("#sel-out").value = sel ? tc(sel.end) : "";
  $("#sel-len").textContent = sel ? tc(sel.end - sel.start) : "—";
  const st = $("#wo-state");
  [st.textContent, st.className] = !sel ? ["NO RANGE", "tag"] : !ok ? [exact && len > 180 ? "MAX 3 MIN" : "TOO SHORT", "tag amber"] :
    sel.end - sel.start > 3600 ? ["LONG RANGE", "tag amber"] : ["READY", "tag green"];
  $("#send").disabled = !ok;
  drawTimeline();
}
$("#opt-mode").addEventListener("change", updateSel);
["#sel-in", "#sel-out"].forEach(id => $(id).addEventListener("change", () => {
  const a = parseTc($("#sel-in").value), b = parseTc($("#sel-out").value);
  if (a != null && b != null) setSel(a, b); else updateSel();
}));
async function queueAuto(sources) {
  sources = sources.map(x => x.trim()).filter(Boolean);
  if (!sources.length) return toast("Paste at least one stream link", true);
  const [mn, mx] = $("#auto-len").value.split("-").map(Number);
  $("#auto-go").disabled = true;
  try {
    const r = await api("/api/auto", {method: "POST", body: JSON.stringify({sources, max_clips: +$("#auto-n").value,
      min_len: mn, max_len: mx, layout: $("#auto-layout").value})});
    toast(`${r.orders.length} STREAM${r.orders.length === 1 ? "" : "S"} QUEUED: ${r.orders.map(o => "WO-" + o.order).join(" ")}`);
    r.errors.forEach(e => toast(e, true));
    $("#auto-src").value = "";
    selOrder = r.orders[0].id; poll(); go("factory");
  } catch (e) { toast(e.message, true); }
  $("#auto-go").disabled = false;
}
$("#auto-go").onclick = () => queueAuto($("#auto-src").value.split(/\n+/));
$("#auto-src").addEventListener("keydown", e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) $("#auto-go").click(); });
$("#send-auto").onclick = () => src && queueAuto([src.source]);

async function dispatch() {
  if (!sel || !src) return;
  const [mn, mx] = $("#opt-len").value.split("-").map(Number);
  $("#send").disabled = true;
  try {
    const wo = await api("/api/orders", {method: "POST", body: JSON.stringify({
      source: src.source, start: sel.start, end: sel.end, title: src.title,
      max_clips: +$("#opt-clips").value, min_len: mn, max_len: mx, layout: $("#opt-layout").value,
      mode: $("#opt-mode").value})});
    toast(`WO-${wo.order} DISPATCHED · ${tc(sel.start)}–${tc(sel.end)}`);
    selOrder = wo.id; sel = null; updateSel(); poll();
  } catch (e) { toast(e.message, true); $("#send").disabled = false; }
}
$("#send").onclick = dispatch;

/* ---------------- timeline canvas ---------------- */
const cv = $("#tl"), g = cv.getContext("2d");
let drag = null;
const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
function drawTimeline() {
  if (!src || !cv.offsetWidth) return;
  const dpr = window.devicePixelRatio || 1, W = cv.offsetWidth, H = cv.offsetHeight;
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
  g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
  const D = src.duration || 1, X = t => t / D * W, top = 16, base = H - 2;
  // ruler + grid
  const steps = [60, 300, 600, 900, 1800, 3600, 7200];
  const step = steps.find(s => D / s <= 14) || 7200;
  g.font = `10px ${css("--mono")}`; g.textBaseline = "top";
  for (let t = 0; t <= D; t += step) {
    g.fillStyle = "rgba(255,255,255,.05)"; g.fillRect(Math.round(X(t)), top, 1, base - top);
    g.fillStyle = css("--faint"); g.fillRect(Math.round(X(t)), 0, 1, 5);
    if (X(t) < W - 56) g.fillText(tc(t), X(t) + 3, 2);
  }
  g.fillStyle = css("--line"); g.fillRect(0, top - 1, W, 1);
  // signal
  if (heat && heat.bins) {
    const n = heat.bins.length, bw = W / n;
    heat.bins.forEach((v, i) => {
      const h = Math.max(1, v * (base - top - 2));
      g.fillStyle = v > .66 ? css("--heat-hi") : css("--heat");
      g.globalAlpha = .35 + .65 * v;
      g.fillRect(i * bw, base - h, Math.max(1, bw - .6), h);
    });
    g.globalAlpha = 1;
  } else {
    g.fillStyle = css("--line-strong"); g.fillRect(0, base - 1, W, 1);
  }
  // selection
  if (sel) {
    const a = X(sel.start), b = X(sel.end);
    g.fillStyle = css("--sel"); g.fillRect(a, top, b - a, base - top);
    g.fillStyle = css("--sel-line");
    g.fillRect(a - 1, top, 2, base - top); g.fillRect(b - 1, top, 2, base - top);
    g.font = `bold 9px ${css("--mono")}`;
    g.fillRect(a - 1, top, 18, 11); g.fillRect(b - 25, top, 26, 11);
    g.fillStyle = "#fff"; g.fillText("IN", a + 2, top + 1); g.fillText("OUT", b - 23, top + 1);
  }
  // playhead
  const p = Math.round(X(video.currentTime || 0));
  g.fillStyle = css("--data"); g.fillRect(p, 6, 1, H - 6);
  g.beginPath(); g.moveTo(p - 4, 6); g.lineTo(p + 5, 6); g.lineTo(p + .5, 11); g.fill();
}
window.addEventListener("resize", drawTimeline);
new ResizeObserver(() => drawTimeline()).observe(cv);
const tAt = e => { const r = cv.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * (src ? src.duration : 0); };
cv.addEventListener("pointerdown", e => {
  if (!src) return;
  cv.setPointerCapture(e.pointerId);
  const t = tAt(e), px = src.duration / cv.offsetWidth * 6;
  if (sel && Math.abs(t - sel.start) < px) drag = {mode: "a"};
  else if (sel && Math.abs(t - sel.end) < px) drag = {mode: "b"};
  else if (sel && t > sel.start && t < sel.end && e.shiftKey) drag = {mode: "move", off: t - sel.start, len: sel.end - sel.start};
  else drag = {mode: "new", t0: t, moved: false};
});
cv.addEventListener("pointermove", e => {
  if (!src) return;
  const t = tAt(e), px = src.duration / cv.offsetWidth * 6;
  if (!drag) { cv.style.cursor = sel && (Math.abs(t - sel.start) < px || Math.abs(t - sel.end) < px) ? "ew-resize" : "crosshair"; return; }
  if (drag.mode === "a") setSel(t, sel.end);
  else if (drag.mode === "b") setSel(sel.start, t);
  else if (drag.mode === "move") setSel(t - drag.off, t - drag.off + drag.len);
  else if (Math.abs(t - drag.t0) > px) { drag.moved = true; setSel(drag.t0, t); }
});
cv.addEventListener("pointerup", e => {
  if (drag && drag.mode === "new" && !drag.moved) seek(tAt(e));
  drag = null;
});

/* ---------------- factory ---------------- */
const STATIONS = [["download", "Intake"], ["audio", "Audio"], ["chat", "Chat"], ["transcribe", "Transcr."], ["moments", "Analysis"], ["render", "Assembly"]];
const AUTO_STATIONS = [["audio", "Audio"], ["signals", "Signals"], ["mining", "Mining"], ["transcribe", "Transcr."], ["judge", "Judge"], ["rank", "Rank"], ["video", "Video"], ["render", "Assembly"]];
const stationsOf = j => (j.options || {}).mode === "auto" ? AUTO_STATIONS : STATIONS;
const rangeOf = (o, long) => o.mode === "auto" ? "WHOLE STREAM" : o.start != null ? `${tc(o.start)}–${tc(o.end)}${long ? `  (${tc(o.end - o.start)})` : ""}` : "FULL";
const STATUS = {queued: ["QUEUED", ""], running: ["ACTIVE", "blue"], done: ["SHIPPED", "green"], failed: ["FAULT", "red"], cancelled: ["CANCELLED", "amber"]};
let jobs = [], selOrder = null;

function stationStates(j) {
  const st = stationsOf(j), cur = st.findIndex(s => s[0] === j.stage);
  return st.map((_, i) => j.status === "done" || i < cur ? "done" :
    i === cur ? (j.status === "running" ? "cur" : j.status === "failed" ? "fail" : "") : "");
}

function renderOrders(force) {
  const n = st => jobs.filter(j => j.status === st).length;
  $("#k-run").textContent = n("running"); $("#k-queue").textContent = n("queued"); $("#k-done").textContent = n("done");
  $("#k-fail").textContent = n("failed"); $("#k-clips").textContent = jobs.reduce((s, j) => s + j.clips.length, 0);
  const live = n("running") + n("queued");
  $("#nav-factory").textContent = live ? `${live}▲` : jobs.length || "";
  const box = $("#orders");
  const sig = JSON.stringify(jobs.map(j => [j.id, j.status, j.stage, j.progress && j.progress.toFixed(2), j.message, j.clips.length])) + selOrder;
  if (box.dataset.sig !== sig || force) {
    box.dataset.sig = sig;
    box.innerHTML = !jobs.length ? `<div class="empty"><b>PRODUCTION LINE IDLE</b>Queue streams for an overnight run in Discovery, or mark a range by hand.</div>` :
      `<table class="dt"><thead><tr><th style="width:74px">Order</th><th style="width:86px">Status</th><th>Source</th><th style="width:136px">Range</th>
        <th style="width:72px">Stations</th><th style="width:110px">Progress</th><th class="r" style="width:46px">Units</th><th class="r" style="width:52px">Age</th></tr></thead><tbody>
      ${jobs.map(j => {
        const [label, cls] = STATUS[j.status] || [j.status, ""], o = j.options || {};
        const pct = j.status === "done" ? 100 : (j.progress != null ? j.progress * 100 : 0);
        const indet = j.status === "running" && j.progress == null;
        return `<tr class="click ${j.id === selOrder ? "on" : ""}" data-id="${j.id}"><td class="data">WO-${j.order}</td><td><span class="tag ${cls}">${label}</span></td>
          <td>${esc(j.title || j.source)}</td><td class="mono t2">${rangeOf(o)}</td>
          <td><div class="mini-st">${stationStates(j).map(c => `<i class="${c}"></i>`).join("")}</div></td>
          <td>${j.status === "running" || j.status === "done" ? `<div class="meter ${j.status === "done" ? "green" : ""} ${indet ? "indet" : ""}"><i style="width:${pct.toFixed(1)}%"></i></div>` : `<span class="faint mono">—</span>`}</td>
          <td class="r data">${j.clips.length || "—"}</td><td class="r mono faint">${ago(j.created)}</td></tr>`;
      }).join("")}</tbody></table>`;
    $$("#orders tr.click").forEach(tr => tr.onclick = () => { selOrder = tr.dataset.id; renderOrders(true); });
  }
  renderOrderDetail();
}

let detailSig = "";
function renderOrderDetail() {
  const j = jobs.find(x => x.id === selOrder);
  const box = $("#wo-detail");
  if (!j) { $("#wo-id").textContent = ""; if (detailSig) { box.innerHTML = `<div class="empty"><b>NO ORDER SELECTED</b>Select a row on the production line.</div>`; detailSig = ""; } return; }
  const sig = JSON.stringify([j.id, j.status, j.stage, j.progress && j.progress.toFixed(3), j.message, j.log.length, j.clips.length]);
  if (sig === detailSig) return;
  detailSig = sig;
  const logEl = $(".log", box), stick = !logEl || logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 4;
  const [label, cls] = STATUS[j.status] || [j.status, ""], o = j.options || {};
  $("#wo-id").textContent = `WO-${j.order}`;
  const pct = j.status === "done" ? 100 : (j.progress != null ? j.progress * 100 : 0);
  box.innerHTML = `
    <div class="kv">
      <div>Status</div><div><span class="tag ${cls}">${label}</span></div>
      <div>Source</div><div>${esc(j.title || j.source)}</div>
      <div>Range</div><div class="data">${rangeOf(o, true)}</div>
      <div>Spec</div><div class="mono t2">${o.mode === "exact" ? "EXACT CUT" : o.mode === "auto" ? `AUTO · UP TO ${o.max_clips} UNITS · ${o.min_len}–${o.max_len}s` : `${o.max_clips} UNITS · ${o.min_len}–${o.max_len}s`} · ${o.layout === "auto" ? "AUTO" : LAYOUTS[o.layout] || o.layout}</div>
      <div>Received</div><div class="mono t2">${isoTime(j.created)}</div>
    </div>
    <div class="sect">Stations</div>
    <div class="stations">${stationStates(j).map((c, i) => `<div class="stn ${c}">${stationsOf(j)[i][1]}</div>`).join("")}</div>
    <div style="padding:0 10px 8px"><div class="meter ${j.status === "done" ? "green" : ""} ${j.status === "running" && j.progress == null ? "indet" : ""}"><i style="width:${pct.toFixed(1)}%"></i></div>
      <div class="mono t2" style="margin-top:5px;font-size:11px">${esc(j.message)}</div></div>
    <div class="acts">
      ${j.status === "done" ? `<button class="btn primary" data-act="inv">PACKAGE ${j.clips.length} UNIT${j.clips.length === 1 ? "" : "S"} ▸</button><button class="btn" data-act="reveal">REVEAL IN FINDER</button>` : ""}
      ${j.status === "running" || j.status === "queued" ? `<button class="btn" data-act="cancel">CANCEL ORDER</button>` : ""}
      ${j.status === "failed" || j.status === "cancelled" ? `<button class="btn amber" data-act="retry">RE-RUN</button>` : ""}
      ${j.status !== "running" && j.status !== "queued" ? `<button class="btn minimal" data-act="del">DELETE</button>` : ""}
    </div>
    ${o.mode === "auto" && j.clips.length ? `<div class="sect">Picks, best first</div>
    <table class="dt res"><thead><tr><th style="width:30px">#</th><th style="width:40px">Sc</th><th>Pick</th><th class="r" style="width:76px">TC</th></tr></thead><tbody>
      ${j.clips.map((c, i) => `<tr class="click" data-unit="${i}"><td class="faint mono">${i + 1}</td>
        <td><span class="score ${scoreCls(c.score)}">${c.score}</span></td>
        <td class="wh"><div class="hook">${esc(c.hook || c.title)}</div><div class="t2" style="font-size:10.5px" title="${esc(c.what_happens || "")}">${esc(c.what_happens || c.reason || "")}</div>
          <span class="why">${(c.why || []).map(w => `<span class="tag ${w.startsWith("viewers") ? "green" : "blue"}">${esc(w)}</span>`).join("")}</span></td>
        <td class="r data">${tc(c.abs_start)}<div class="faint mono" style="font-size:10px">${Math.round(c.end - c.start)}s</div></td></tr>`).join("")}
    </tbody></table>` : ""}
    <div class="sect">Production log</div>
    <pre class="log" style="max-height:340px;overflow:auto">${esc(j.log.join("\n"))}</pre>`;
  $$("[data-unit]", box).forEach(tr => tr.onclick = () => { go("packaging"); openUnit(j.id, +tr.dataset.unit); });
  const lg = $(".log", box); if (stick) lg.scrollTop = lg.scrollHeight;
  $$("[data-act]", box).forEach(b => b.onclick = async () => {
    const a = b.dataset.act, id = j.id;
    try {
      if (a === "inv") { $("#pk-order").value = id; go("packaging"); renderUnits(true); return; }
      if (a === "reveal") { const r = await api(`/api/orders/${id}/reveal`, {method: "POST"}); if (!navigator.platform.startsWith("Mac")) toast(r.path); return; }
      if (a === "cancel") await api(`/api/orders/${id}/cancel`, {method: "POST"});
      if (a === "retry") await api(`/api/orders/${id}/retry`, {method: "POST"});
      if (a === "del") {
        if (b.dataset.armed !== "1") { b.dataset.armed = "1"; b.textContent = "CONFIRM DELETE"; b.className = "btn amber";
          setTimeout(() => { b.dataset.armed = ""; b.textContent = "DELETE"; b.className = "btn minimal"; }, 3000); return; }
        await api(`/api/orders/${id}`, {method: "DELETE"}); selOrder = null;
      }
      detailSig = ""; poll();
    } catch (e) { toast(e.message, true); }
  });
}

/* ---------------- packaging ---------------- */
const pv = $("#pv");
const HIGHLIGHT = {yellow: "#ffd700", green: "#39ff14", red: "#ff3b30", cyan: "#00e5ff", pink: "#ff40a0", white: "#ffffff"};
const DEFAULT_FX = {boom: "zoom", bass_drop: "zoom", scratch: "shake", glitch: "shake", error: "shake", shutter: "flash"};
const FX_NAMES = {none: "NO VISUAL", zoom: "ZOOM PUNCH", shake: "SHAKE", flash: "FLASH"};
let lib = [], curSound = "boom", bay = null, selHit = -1, lastT = 0, saveTimer = null, unitsKey = "";
let sugg = [], wave = [];   // AI suggestions (not part of the edit until accepted) and the clip's loudness envelope
const ukey = (jid, idx) => `${jid}/${idx}`;
const ftc = t => { t = Math.max(0, t || 0); return `${pad(Math.floor(t / 60))}:${(t % 60).toFixed(1).padStart(4, "0")}`; };
const parseFtc = s => { const p = String(s).trim().split(":"); let t = 0; for (const x of p) { const v = parseFloat(x); if (isNaN(v)) return null; t = t * 60 + v; } return t; };
const libLabel = id => (lib.find(x => x.id === id) || {label: id}).label;

function allUnits() {
  const out = [];
  for (const j of jobs) j.clips.forEach((c, i) => out.push({...c, job: j, idx: i}));
  return out;
}
function pkgState(c) {
  const p = c.pkg || {};
  return p.status === "done" ? ["PACKAGED", "green"] : p.status === "running" ? [`RENDER ${Math.round((p.progress || 0) * 100)}%`, "blue"] :
    p.status === "queued" ? ["QUEUED", ""] : p.status === "failed" ? ["FAULT", "red"] : ["RAW", "amber"];
}
const thumbHtml = u => u.thumb ? `<img class="thumb" loading="lazy" src="/files/${encodeURIComponent(u.job.id)}/${encodeURIComponent(u.thumb)}">` : `<div class="thumb"></div>`;

function renderUnits(force) {
  const units = allUnits();
  const raw = units.filter(u => !(u.pkg && u.pkg.status === "done")).length;
  $("#nav-packaging").textContent = units.length ? (raw || "✓") : "";
  const orderSel = $("#pk-order"), cur = orderSel.value, withClips = jobs.filter(j => j.clips.length);
  if (orderSel.dataset.sig !== String(withClips.length)) {
    orderSel.innerHTML = `<option value="">ALL ORDERS</option>` + withClips.map(j => `<option value="${j.id}">WO-${j.order}</option>`).join("");
    orderSel.value = cur; orderSel.dataset.sig = String(withClips.length);
  }
  const q = $("#pk-q").value.toLowerCase(), ord = orderSel.value;
  const list = units.filter(u => (!ord || u.job.id === ord) && (!q || [u.hook, u.title, u.job.title].join(" ").toLowerCase().includes(q)))
    .sort((a, b) => b.job.created - a.job.created || a.idx - b.idx);
  $("#pk-count").textContent = `${list.length} UNITS`;
  const sel = bay ? ukey(bay.jid, bay.idx) : "";
  const key = JSON.stringify(list.map(u => [ukey(u.job.id, u.idx), pkgState(u)[0], u.hook])) + sel;
  if (key !== unitsKey || force) {
    unitsKey = key;
    $("#pk-units").innerHTML = !units.length ? `<div class="empty"><b>NO UNITS</b>Finished factory clips land here.</div>` :
      `<table class="dt"><thead><tr><th style="width:38px"></th><th style="width:34px">Sc</th><th>Unit</th><th style="width:92px">State</th></tr></thead><tbody>
      ${list.map(u => { const [lab, cls] = pkgState(u);
        return `<tr class="click tall ${ukey(u.job.id, u.idx) === sel ? "on" : ""}" data-j="${u.job.id}" data-i="${u.idx}"><td>${thumbHtml(u)}</td>
          <td><span class="score ${scoreCls(u.score)}">${u.score}</span></td>
          <td><div class="hook" style="overflow:hidden;text-overflow:ellipsis">${esc((u.package && u.package.hook) || u.hook || u.title)}</div>
            <div class="faint mono" style="font-size:10.5px">WO-${u.job.order} · ${Math.round(u.end - u.start)}s</div></td>
          <td><span class="tag ${cls}">${lab}</span></td></tr>`; }).join("")}</tbody></table>`;
    $$("#pk-units tr.click").forEach(tr => tr.onclick = () => openUnit(tr.dataset.j, +tr.dataset.i));
  }
  if (!bay && list.length && $("#page-packaging").classList.contains("on")) openUnit(list[0].job.id, list[0].idx);
}
["#pk-q", "#pk-order"].forEach(id => $(id).addEventListener("input", () => renderUnits(true)));

/* sound library */
const sfxUrl = id => `/api/sfx/file/${encodeURIComponent(id)}`;
const audioCache = {};
function playSfx(id, vol) {
  let a = audioCache[id];
  if (!a) { a = audioCache[id] = new Audio(sfxUrl(id)); a.preload = "auto"; }
  const n = a.cloneNode(); n.volume = Math.max(0, Math.min(1, vol)); n.play().catch(() => {});
}
async function loadLib(select) {
  lib = await api("/api/sfx").catch(() => []);
  if (select) curSound = select;
  if (!lib.find(x => x.id === curSound) && lib.length) curSound = lib[0].id;
  lib.forEach(x => { if (!audioCache[x.id]) { audioCache[x.id] = new Audio(sfxUrl(x.id)); audioCache[x.id].preload = "auto"; } });
  renderLib();
}
function renderLib() {
  $("#sfx-lib").innerHTML = lib.map(x => `<div class="sfx-row ${x.id === curSound ? "on" : ""}" data-id="${esc(x.id)}">
    <button class="btn minimal" data-play="${esc(x.id)}" title="Preview">▶</button>
    <div style="min-width:0"><div class="nm">${esc(x.label)} <span class="faint mono" style="font-weight:400">${x.duration ? x.duration.toFixed(1) + "s" : ""}</span></div><div class="hint">${esc(x.hint)}</div></div>
    <span class="tag ${x.kind === "user" ? "blue" : ""}">${x.kind === "user" ? "YOURS" : "STOCK"}</span></div>`).join("");
  $$("#sfx-lib .sfx-row").forEach(r => r.onclick = () => { curSound = r.dataset.id; renderLib(); });
  $$("#sfx-lib [data-play]").forEach(b => b.onclick = e => { e.stopPropagation(); playSfx(b.dataset.play, 0.9); });
  $("#pv-sound").innerHTML = lib.map(x => `<option value="${esc(x.id)}">${esc(x.label.toUpperCase())}</option>`).join("");
  $("#pv-sound").value = curSound;
}
$("#pv-sound").onchange = e => { curSound = e.target.value; renderLib(); };
$("#sfx-import").onclick = () => $("#sfx-file").click();
$("#sfx-folder").onclick = async () => { const r = await api("/api/sfx/reveal", {method: "POST"}); if (!navigator.platform.startsWith("Mac")) toast(r.path); };
$("#sfx-file").onchange = async e => {
  let last = null;
  for (const f of e.target.files) {
    const fd = new FormData(); fd.append("file", f);
    const r = await fetch("/api/sfx/import", {method: "POST", body: fd}); const d = await r.json().catch(() => ({}));
    if (!r.ok) toast(d.detail || `Couldn't import ${f.name}`, true); else last = d.id;
  }
  e.target.value = "";
  if (last) { await loadLib(last); toast("SOUND IMPORTED"); }
};

/* edit bay */
function clean(w) { return w.trim().toUpperCase().replace(/^["'(\[]+|["',.;:)\]]+$/g, ""); }
function buildEvents(words) {
  const local = words.map(w => ({t: clean(w.w), raw: w.w, s: w.s, e: w.e})).filter(w => w.t);
  const chunks = []; let cur = [];
  for (const w of local) {
    if (cur.length && (cur.length >= 3 || cur.reduce((n, x) => n + x.t.length + 1, 0) + w.t.length > 16 || w.s - cur[cur.length - 1].e > 0.4)) { chunks.push(cur); cur = []; }
    cur.push(w);
    if (".?!,".includes(w.raw.trim().slice(-1))) { chunks.push(cur); cur = []; }
  }
  if (cur.length) chunks.push(cur);
  const ev = [];
  chunks.forEach((ch, ci) => {
    let end = ch[ch.length - 1].e;
    if (ci + 1 < chunks.length && chunks[ci + 1][0].s - end < 0.5) end = chunks[ci + 1][0].s;
    ch.forEach((w, wi) => ev.push({s: w.s, e: Math.max(wi + 1 < ch.length ? ch[wi + 1].s : end, w.s + 0.05), words: ch.map(x => x.t), hi: wi}));
  });
  return ev;
}
const bayWords = () => bay.spec.words || bay.words;

async function openUnit(jid, idx) {
  if (bay && ukey(bay.jid, bay.idx) === ukey(jid, idx)) return;
  await flushSave();
  let d;
  try { d = await api(`/api/units/${jid}/${idx}`); } catch (e) { return toast(e.message, true); }
  const j = jobs.find(x => x.id === jid);
  bay = {jid, idx, spec: d.spec, words: d.words, dur: d.duration, layout: d.layout, order: j ? j.order : "", ok: !!d.base_url};
  bay.events = buildEvents(bayWords());
  selHit = -1; sugg = []; wave = []; renderSugg();
  api(`/api/units/${jid}/${idx}/wave`).then(w => { if (bay && bay.jid === jid && bay.idx === idx) { wave = w; renderTrack(); } }).catch(() => {});
  $("#bay-empty").style.display = "none"; $("#bay-main").style.display = "";
  $("#pk-id").textContent = `WO-${bay.order} / ${pad(idx + 1)}`;
  const c = j && j.clips[idx];
  $("#pk-why-box").style.display = c && (c.what_happens || (c.why || []).length) ? "" : "none";
  if (c) {
    $("#pk-what").textContent = c.what_happens || "";
    $("#pk-why").innerHTML = (c.why || []).map(w => `<span class="tag ${w.startsWith("viewers") ? "green" : "blue"}">${esc(w)}</span>`).join("") +
      (c.clip_titles && c.clip_titles.length ? `<span class="faint" style="font-size:10.5px">viewer clips: ${c.clip_titles.map(t => `"${esc(t)}"`).join(", ")}</span>` : "");
  }
  if (d.base_url) { pv.src = d.base_url; pv.currentTime = bay.spec.trim[0]; } else { pv.removeAttribute("src"); }
  $("#pk-render").disabled = !d.base_url;
  if (!d.base_url) $("#pk-status").textContent = "Made before Packaging existed. Re-run its work order in the Factory.";
  syncTextFields(); renderTrack(); renderHit(); renderUnits(true); fitPhone(); refreshBayStatus();
  $("#pk-saved").textContent = "";
}
function syncTextFields() {
  const s = bay.spec;
  $("#pk-hook").value = s.hook; $("#pk-hook-on").checked = s.hook_on; $("#pk-cap-on").checked = s.captions_on;
  $("#pk-color").value = s.color; $("#pk-in").value = ftc(s.trim[0]); $("#pk-out").value = ftc(s.trim[1]);
  $("#pk-text").value = bayWords().map(w => w.w.trim()).join(" ");
}
function fitPhone() {
  const ph = $("#phone");
  if (!ph.offsetWidth) return;
  ph.style.setProperty("--k", (ph.offsetWidth / 1080).toFixed(4));
  drawOverlay(); renderTrack();
}
new ResizeObserver(() => fitPhone()).observe($("#bay-stage"));

function hitState(t) {
  let scale = 1, dx = 0, dy = 0, flash = 0;
  for (const m of bay.spec.sfx) {
    const d = t - m.t;
    if (m.fx === "none" || d < 0 || d > 0.9) continue;
    if (m.fx === "zoom") scale *= 1 + 0.16 * Math.min(d / 0.06, 1) * Math.exp(-Math.max(0, d - 0.06) / 0.2);
    else if (m.fx === "shake" && d < 0.4) { const amp = 22 * (1 - d / 0.4); dx += amp * Math.sin(d * 97); dy += amp * Math.cos(d * 71); }
    else if (m.fx === "flash" && d < 0.2) flash = Math.max(flash, 0.85 * (1 - d / 0.2));
  }
  return {scale, dx, dy, flash};
}
function drawOverlay() {
  if (!bay) return;
  const s = bay.spec, t = pv.currentTime || 0, k = parseFloat($("#phone").style.getPropertyValue("--k")) || 0.3;
  const hook = $("#pv-hook");
  hook.style.display = s.hook_on && s.hook ? "" : "none"; hook.textContent = s.hook; hook.classList.toggle("split", bay.layout === "split");
  const cap = $("#pv-cap"); cap.classList.toggle("split", bay.layout === "split");
  const ev = s.captions_on ? bay.events.find(e => e.s <= t && t < e.e) : null;
  cap.innerHTML = ev ? ev.words.map((w, i) => i === ev.hi ? `<b style="color:${HIGHLIGHT[s.color]}">${esc(w)}</b>` : esc(w)).join(" ") : "";
  const h = hitState(t);
  $("#phone-fx").style.transform = `translate(${(h.dx * k).toFixed(2)}px, ${(h.dy * k).toFixed(2)}px) scale(${h.scale.toFixed(4)})`;
  $("#pv-flash").style.opacity = h.flash.toFixed(3);
}
function updatePvTc() {
  if (!bay) return;
  const [a, b] = bay.spec.trim;
  $("#pv-tc").innerHTML = `${ftc((pv.currentTime || 0) - a)} <small>/ ${ftc(b - a)}</small>`;
  $("#track-ph").style.left = `${(pv.currentTime || 0) / bay.dur * 100}%`;
}
function tickPv() {
  if (bay) {
    const t = pv.currentTime || 0, [a, b] = bay.spec.trim;
    if (!pv.paused) {
      if (t >= b) { pv.pause(); pv.currentTime = a; }
      else for (const m of bay.spec.sfx) if (m.t > lastT && m.t <= t && t - m.t < 0.25) playSfx(m.sound, m.vol);
    }
    lastT = t;
    drawOverlay(); updatePvTc();
  }
  requestAnimationFrame(tickPv);
}
requestAnimationFrame(tickPv);
pv.addEventListener("seeked", () => { lastT = pv.currentTime - 0.0001; });
pv.addEventListener("play", () => $("#pv-play").textContent = "PAUSE");
pv.addEventListener("pause", () => $("#pv-play").textContent = "PLAY");
function pvToggle() {
  if (!bay || !bay.ok) return;
  if (!pv.paused) return pv.pause();
  const [a, b] = bay.spec.trim;
  if (pv.currentTime < a || pv.currentTime >= b - 0.05) pv.currentTime = a;
  pv.play();
}
$("#pv-play").onclick = pvToggle;

function renderTrack() {
  if (!bay) return;
  const tr = $("#track"), W = tr.clientWidth || 1, D = bay.dur || 1, [a, b] = bay.spec.trim;
  $$(".mk", tr).forEach(x => x.remove());
  drawWave();
  sugg.forEach((m, i) => {
    const el = document.createElement("div");
    el.className = "mk ghost"; el.style.left = `${m.t / D * 100}%`; el.dataset.g = i;
    el.title = `Suggested: ${libLabel(m.sound)} · ${m.reason || ""} (click to accept)`;
    el.innerHTML = `${esc(libLabel(m.sound).toUpperCase())}?<small>SUGGESTED</small>`;
    tr.appendChild(el);
  });
  bay.spec.sfx.forEach((m, i) => {
    const el = document.createElement("div");
    el.className = "mk" + (i === selHit ? " on" : "");
    el.style.left = `${m.t / D * 100}%`;
    const next = bay.spec.sfx[i + 1];   // keep labels from running into the next marker
    if (next) el.style.maxWidth = `${Math.max(14, (next.t - m.t) / D * W - 3)}px`;
    el.style.overflow = "hidden";
    el.dataset.i = i;
    el.innerHTML = `${esc(libLabel(m.sound).toUpperCase())}<small>${m.fx !== "none" ? FX_NAMES[m.fx] : ftc(m.t)}</small>`;
    tr.appendChild(el);
  });
  $("#trim-l").style.width = `${a / D * 100}%`; $("#trim-r").style.width = `${(D - b) / D * 100}%`;
  let lastX = -999;
  $("#track-words").innerHTML = bayWords().map(w => { const x = w.s / D * W;
    if (x - lastX < 46) return ""; lastX = x; return `<span style="left:${x.toFixed(0)}px">${esc(w.w.trim())}</span>`; }).join("");
  updatePvTc();
}
let tdrag = null;
const trackT = e => { const r = $("#track").getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * bay.dur; };
$("#track").addEventListener("pointerdown", e => {
  if (!bay) return;
  $("#track").setPointerCapture(e.pointerId);
  const ghost = e.target.closest(".mk.ghost");
  if (ghost) { acceptSugg(+ghost.dataset.g); return; }
  const mk = e.target.closest(".mk");
  if (mk) { selHit = +mk.dataset.i; tdrag = {mode: "mk", i: selHit, moved: false}; renderTrack(); renderHit(); return; }
  if (e.target.id === "trim-l") { tdrag = {mode: "a"}; return; }
  if (e.target.id === "trim-r") { tdrag = {mode: "b"}; return; }
  tdrag = {mode: "seek"}; pv.currentTime = trackT(e);
});
$("#track").addEventListener("pointermove", e => {
  if (!bay || !tdrag) return;
  const t = trackT(e), s = bay.spec;
  if (tdrag.mode === "mk") { s.sfx[tdrag.i].t = snapT(t); tdrag.moved = true; renderTrack(); }
  else if (tdrag.mode === "a") { s.trim[0] = Math.min(t, s.trim[1] - 1); renderTrack(); }
  else if (tdrag.mode === "b") { s.trim[1] = Math.max(t, s.trim[0] + 1); renderTrack(); }
  else pv.currentTime = t;
});
$("#track").addEventListener("pointerup", () => {
  if (!tdrag) return;
  const m = tdrag.mode; tdrag = null;
  if (m === "mk" || m === "a" || m === "b") { sortHits(); syncTextFields(); changed(); renderHit(); }
});
function sortHits() {
  const s = bay.spec, keep = selHit >= 0 ? s.sfx[selHit] : null;
  s.sfx.sort((x, y) => x.t - y.t);
  selHit = keep ? s.sfx.indexOf(keep) : -1;
}
function addHit(t, sound) {
  if (!bay) return;
  const m = {t: snapT(t), sound, vol: 0.8, fx: DEFAULT_FX[sound] || "none"};
  bay.spec.sfx.push(m); selHit = bay.spec.sfx.indexOf(m); sortHits();
  playSfx(sound, 0.8); changed(); renderHit();
}
$("#pv-add").onclick = () => addHit(pv.currentTime || 0, curSound);
function bayKey(e) {
  if (!bay) return;
  const k = e.key.toLowerCase();
  if (k === " ") { e.preventDefault(); pvToggle(); }
  else if (k === "b") addHit(pv.currentTime || 0, curSound);
  else if ((k === "delete" || k === "backspace") && selHit >= 0) { bay.spec.sfx.splice(selHit, 1); selHit = -1; changed(); renderHit(); }
  else if (k === "arrowleft" || k === "arrowright") {
    e.preventDefault();
    const dir = k === "arrowleft" ? -1 : 1;
    if (selHit >= 0) { const m = bay.spec.sfx[selHit]; m.t = Math.max(0, Math.min(bay.dur, Math.round((m.t + dir * (e.shiftKey ? 0.5 : 0.05)) * 100) / 100)); sortHits(); changed(); renderHit(); }
    else pv.currentTime = Math.max(0, Math.min(bay.dur, pv.currentTime + dir * (e.shiftKey ? 5 : 1)));
  }
}
function renderHit() {
  const box = $("#hit-props");
  if (!bay || selHit < 0 || !bay.spec.sfx[selHit]) { box.innerHTML = `<div class="empty" style="padding:12px">Click a marker on the track, or press <span class="key">B</span> to drop one.</div>`; return; }
  const m = bay.spec.sfx[selHit];
  box.innerHTML = `<div class="kv">
    <div>Sound</div><div><select class="input" id="hp-sound">${lib.map(x => `<option value="${esc(x.id)}" ${x.id === m.sound ? "selected" : ""}>${esc(x.label.toUpperCase())}</option>`).join("")}</select></div>
    <div>Time</div><div><input class="input mono" id="hp-t" value="${m.t.toFixed(2)}"></div>
    <div>Volume</div><div style="display:flex;gap:6px;align-items:center"><input type="range" class="range" id="hp-vol" min="0" max="150" value="${Math.round(m.vol * 100)}"><span class="mono data" id="hp-vol-v" style="width:36px;text-align:right">${Math.round(m.vol * 100)}%</span></div>
    <div>Visual</div><div><select class="input" id="hp-fx">${Object.entries(FX_NAMES).map(([k, v]) => `<option value="${k}" ${k === m.fx ? "selected" : ""}>${v}</option>`).join("")}</select></div>
  </div><div class="acts"><button class="btn" id="hp-prev">PREVIEW HIT</button><button class="btn minimal" id="hp-del">REMOVE</button></div>`;
  $("#hp-sound").onchange = e => { m.sound = e.target.value; changed(); playSfx(m.sound, m.vol); };
  $("#hp-t").onchange = e => { const v = parseFloat(e.target.value); if (!isNaN(v)) { m.t = Math.max(0, Math.min(bay.dur, v)); sortHits(); changed(); renderHit(); } };
  $("#hp-vol").oninput = e => { m.vol = +e.target.value / 100; $("#hp-vol-v").textContent = `${e.target.value}%`; scheduleSave(); };
  $("#hp-vol").onchange = () => playSfx(m.sound, m.vol);
  $("#hp-fx").onchange = e => { m.fx = e.target.value; changed(); };
  $("#hp-prev").onclick = () => { pv.currentTime = Math.max(bay.spec.trim[0], m.t - 1.2); pv.play(); };
  $("#hp-del").onclick = () => { bay.spec.sfx.splice(selHit, 1); selHit = -1; changed(); renderHit(); };
}

/* text, trim, suggestions, saving */
$("#pk-hook").oninput = e => { bay.spec.hook = e.target.value; changed(); };
$("#pk-hook-on").onchange = e => { bay.spec.hook_on = e.target.checked; changed(); };
$("#pk-cap-on").onchange = e => { bay.spec.captions_on = e.target.checked; changed(); };
$("#pk-color").onchange = e => { bay.spec.color = e.target.value; changed(); };
["#pk-in", "#pk-out"].forEach(id => $(id).addEventListener("change", () => {
  const a = parseFtc($("#pk-in").value), b = parseFtc($("#pk-out").value);
  if (a != null && b != null && b - a >= 1) { bay.spec.trim = [Math.max(0, a), Math.min(bay.dur, b)]; changed(); }
  syncTextFields();
}));
$("#pk-apply-text").onclick = async () => {
  if (!bay) return;
  try {
    bay.spec.words = await api(`/api/units/${bay.jid}/${bay.idx}/retime`, {method: "POST", body: JSON.stringify({text: $("#pk-text").value})});
    bay.events = buildEvents(bay.spec.words); changed(); toast("TRANSCRIPT APPLIED");
  } catch (e) { toast(e.message, true); }
};
$("#pk-suggest").onclick = async () => {
  if (!bay) return;
  const b = $("#pk-suggest"); b.disabled = true; b.textContent = "THINKING…";
  try {
    const marks = await api(`/api/units/${bay.jid}/${bay.idx}/suggest-sfx`, {method: "POST", body: JSON.stringify({hook: bay.spec.hook, words: bayWords()})});
    // Only offer spots that aren't already covered by one of your own hits.
    sugg = marks.filter(m => !bay.spec.sfx.some(x => Math.abs(x.t - m.t) < 0.4));
    renderSugg(); renderTrack();
    toast(sugg.length ? `${sugg.length} SUGGESTIONS · dashed markers on the track. Click one to accept it.` : "NO NEW SUGGESTIONS");
  } catch (e) { toast(e.message, true); }
  finally { b.disabled = false; b.textContent = "SUGGEST HITS"; }
};
function acceptSugg(i) {
  const m = sugg[i]; if (!m) return;
  sugg.splice(i, 1);
  const hit = {t: m.t, sound: m.sound, vol: m.vol, fx: m.fx};
  bay.spec.sfx.push(hit); sortHits(); selHit = bay.spec.sfx.indexOf(hit);
  playSfx(hit.sound, hit.vol); renderSugg(); changed(); renderHit();
}
function renderSugg() {
  $("#sugg-wrap").style.display = sugg.length ? "" : "none";
  $("#pk-accept-all").style.display = $("#pk-dismiss").style.display = sugg.length ? "" : "none";
  $("#sugg").innerHTML = sugg.map((m, i) => `<div class="sugg-row"><span class="mono data">${ftc(m.t)}</span>
    <div style="min-width:0"><b>${esc(libLabel(m.sound))}</b>${m.fx !== "none" ? ` <span class="faint mono">+ ${FX_NAMES[m.fx]}</span>` : ""}<div class="why">${esc(m.reason || "")}</div></div>
    <span><button class="btn minimal" data-hear="${i}" title="Hear it in context">▶</button><button class="btn" data-ok="${i}">✓</button><button class="btn minimal" data-no="${i}">✕</button></span></div>`).join("");
  $$("#sugg [data-ok]").forEach(b => b.onclick = () => acceptSugg(+b.dataset.ok));
  $$("#sugg [data-no]").forEach(b => b.onclick = () => { sugg.splice(+b.dataset.no, 1); renderSugg(); renderTrack(); });
  $$("#sugg [data-hear]").forEach(b => b.onclick = () => { const m = sugg[+b.dataset.hear]; pv.currentTime = Math.max(bay.spec.trim[0], m.t - 1.5); pv.play();
    setTimeout(() => playSfx(m.sound, m.vol), 1500); });
}
$("#pk-accept-all").onclick = () => { while (sugg.length) acceptSugg(0); };
$("#pk-dismiss").onclick = () => { sugg = []; renderSugg(); renderTrack(); };
function snapT(t) {
  t = Math.max(0, Math.min(bay.dur, t));
  if ($("#pv-snap").checked) {
    let best = null;
    for (const w of bayWords()) for (const x of [w.s, w.e]) if (Math.abs(x - t) < 0.15 && (best == null || Math.abs(x - t) < Math.abs(best - t))) best = x;
    if (best != null) t = best;
  }
  return Math.round(t * 100) / 100;
}
function drawWave() {
  const cv = $("#wave"), dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
  if (!W) return;
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  const g = cv.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
  if (!wave.length) return;
  const bw = W / wave.length;
  wave.forEach((v, i) => {
    const h = Math.max(1, v * (H - 6));
    g.fillStyle = v > 0.7 ? "rgba(240,178,92,.55)" : "rgba(143,153,168,.28)";
    g.fillRect(i * bw, (H - h) / 2, Math.max(1, bw), h);
  });
}
$("#pk-clear").onclick = () => { if (!bay) return; bay.spec.sfx = []; selHit = -1; changed(); renderHit(); };
function changed() { renderTrack(); drawOverlay(); scheduleSave(); }
function scheduleSave() { clearTimeout(saveTimer); $("#pk-saved").textContent = "UNSAVED"; saveTimer = setTimeout(flushSave, 700); }
async function flushSave() {
  if (!bay || !saveTimer) return;
  clearTimeout(saveTimer); saveTimer = null;
  try { await api(`/api/units/${bay.jid}/${bay.idx}/package`, {method: "PUT", body: JSON.stringify(bay.spec)}); $("#pk-saved").textContent = `SAVED ${new Date().toTimeString().slice(0, 8)}`; }
  catch (e) { $("#pk-saved").textContent = "SAVE FAILED"; toast(e.message, true); }
}
$("#pk-render").onclick = async () => {
  if (!bay) return;
  saveTimer = saveTimer || -1; await flushSave();
  try { await api(`/api/units/${bay.jid}/${bay.idx}/render`, {method: "POST"}); toast(`WO-${bay.order}/${pad(bay.idx + 1)} SENT TO PACKAGING LINE`); poll(); }
  catch (e) { toast(e.message, true); }
};
function refreshBayStatus() {
  if (!bay) return;
  const j = jobs.find(x => x.id === bay.jid), c = j && j.clips[bay.idx];
  if (!c || !bay.ok) return;
  const p = c.pkg || {}, m = $("#pk-meter");
  m.className = "meter " + (p.status === "done" ? "green" : "");
  $("#pk-meter i").style.width = `${((p.status === "done" ? 1 : p.progress || 0) * 100).toFixed(1)}%`;
  $("#pk-status").textContent = p.status === "done" ? (c.shipped ? `SHIPPED → ${c.shipped.path.split("/").pop()}` : `PACKAGED ${isoTime(p.at)} · ready to ship`) :
    p.status === "failed" ? p.message : p.status ? p.message : "Not packaged yet";
  $("#pk-render").textContent = p.status === "done" ? "RE-RENDER PACKAGE ▸" : "RENDER PACKAGE ▸";
  $("#pk-ship").style.display = p.status === "done" ? "" : "none";
  $("#pk-ship").textContent = c.shipped ? "SHIPPED ✓ · SHIP AGAIN ▸" : "SHIP TO DOWNLOADS ▸";
  $("#pk-render").disabled = p.status === "running" || p.status === "queued";
}

/* ---------------- shipping ---------------- */
let selShip = null, shipKey = "", shipDetailKey = "";
function shipUnits() { return allUnits().filter(u => u.pkg && u.pkg.status === "done").sort((a, b) => (b.pkg.at || 0) - (a.pkg.at || 0)); }
async function shipUnit(jid, idx) {
  try {
    const r = await api(`/api/units/${jid}/${idx}/ship`, {method: "POST"});
    toast(`SHIPPED → ~/Downloads/${r.path.split("/").pop()}`);
    await poll(); renderShipping(true); renderShipDetail(true);
  } catch (e) { toast(e.message, true); }
}
$("#pk-ship").onclick = () => bay && shipUnit(bay.jid, bay.idx);
$("#sh-all").onclick = async () => {
  try {
    const r = await api("/api/ship-all", {method: "POST"});
    toast(r.shipped.length ? `${r.shipped.length} SHIPPED TO DOWNLOADS` : "NOTHING NEW TO SHIP");
    await poll(); renderShipping(true); renderShipDetail(true);
  } catch (e) { toast(e.message, true); }
};
function renderShipping(force) {
  const units = shipUnits(), ready = units.filter(u => !u.shipped).length;
  $("#nav-shipping").textContent = units.length ? (ready || "✓") : "";
  $("#sh-all").disabled = !ready;
  if (!selShip && units.length) selShip = ukey(units[0].job.id, units[0].idx);
  const key = JSON.stringify(units.map(u => [ukey(u.job.id, u.idx), u.shipped, u.pkg.at])) + selShip;
  if (key === shipKey && !force) return renderShipDetail();
  shipKey = key;
  $("#sh-list").innerHTML = !units.length ? `<div class="empty"><b>NOTHING TO SHIP</b>Render a package in F3 Packaging and it lands here.</div>` :
    `<table class="dt"><thead><tr><th style="width:38px"></th><th>Unit</th><th style="width:74px">Order</th><th style="width:64px">Packed</th>
      <th style="width:200px">Status</th><th style="width:86px"></th></tr></thead><tbody>
    ${units.map(u => `<tr class="click tall ${ukey(u.job.id, u.idx) === selShip ? "on" : ""}" data-k="${ukey(u.job.id, u.idx)}"><td>${thumbHtml(u)}</td>
      <td><div class="hook" style="overflow:hidden;text-overflow:ellipsis">${esc((u.package && u.package.hook) || u.hook)}</div><div class="faint" style="font-size:11px">${esc(u.title)}</div></td>
      <td class="data">WO-${u.job.order}</td><td class="mono faint">${ago(u.pkg.at || 0)}</td>
      <td>${u.shipped ? `<span class="tag green">SHIPPED</span> <span class="mono faint" style="font-size:10.5px">${ago(u.shipped.at)} ago</span>` : `<span class="tag amber">READY</span>`}</td>
      <td class="r acts-cell"><button class="btn ${u.shipped ? "" : "amber"}" data-ship="${u.job.id}|${u.idx}">${u.shipped ? "AGAIN" : "SHIP"}</button></td></tr>`).join("")}
    </tbody></table>`;
  $$("#sh-list tr.click").forEach(tr => tr.onclick = () => { selShip = tr.dataset.k; renderShipping(true); renderShipDetail(true); });
  $$("#sh-list [data-ship]").forEach(b => b.onclick = e => { e.stopPropagation(); const [j, i] = b.dataset.ship.split("|"); shipUnit(j, +i); });
  renderShipDetail();
}
function renderShipDetail(force) {
  const u = shipUnits().find(x => ukey(x.job.id, x.idx) === selShip), box = $("#sh-detail");
  if (!u) { if (shipDetailKey) { box.innerHTML = `<div class="empty"><b>NOTHING SELECTED</b>Packaged units appear here.</div>`; shipDetailKey = ""; $("#sh-id").textContent = ""; } return; }
  const key = JSON.stringify([selShip, u.shipped, u.pkg.at]);
  if (!force && key === shipDetailKey) return;
  shipDetailKey = key;
  const url = `/files/${encodeURIComponent(u.job.id)}/${encodeURIComponent(u.pkg.file)}`, spec = u.package || {};
  $("#sh-id").textContent = `WO-${u.job.order} / ${pad(u.idx + 1)}`;
  box.innerHTML = `<div class="clipview"><video src="${url}" controls playsinline preload="metadata"></video></div>
    <div class="kv">
      <div>Hook</div><div class="hook">${esc(spec.hook || u.hook)}</div>
      <div>Length</div><div class="mono t2">${spec.trim ? (spec.trim[1] - spec.trim[0]).toFixed(1) : Math.round(u.end - u.start)} s · 1080×1920</div>
      <div>Sounds</div><div class="mono t2">${(spec.sfx || []).length ? spec.sfx.map(m => libLabel(m.sound)).join(", ") : "none"}</div>
      <div>Packaged</div><div class="mono t2">${isoTime(u.pkg.at)}</div>
      <div>Status</div><div>${u.shipped ? `<span class="tag green">SHIPPED</span> <span class="mono t2" style="font-size:11px">${esc(u.shipped.path.replace(/^\/Users\/[^/]+/, "~"))}</span>` : `<span class="tag amber">READY</span>`}</div>
    </div>
    <div class="acts"><button class="btn amber" id="sh-one">${u.shipped ? "SHIP AGAIN" : "SHIP TO DOWNLOADS"}</button>
      <button class="btn" id="sh-reveal">${u.shipped ? "SHOW IN FINDER" : "SHOW PACKAGE FILE"}</button>
      <button class="btn minimal" id="sh-edit">BACK TO PACKAGING</button></div>`;
  $("#sh-one").onclick = () => shipUnit(u.job.id, u.idx);
  $("#sh-reveal").onclick = () => api(`/api/units/${u.job.id}/${u.idx}/reveal`, {method: "POST"});
  $("#sh-edit").onclick = () => { go("packaging"); openUnit(u.job.id, u.idx); };
}
loadLib();

/* ---------------- system + status bar ---------------- */
let sysSig = "";
function renderSystem(st) {
  const steps = Object.values(st.setup), a = st.app;
  const err = steps.find(s => s.status === "error"), pending = steps.filter(s => s.status !== "ok");
  const sig = JSON.stringify(st.setup);
  if (sig !== sysSig) {
    sysSig = sig;
    $("#steps").innerHTML = `<table class="dt"><thead><tr><th>Component</th><th style="width:90px">State</th><th style="width:160px">Progress</th><th style="width:38%">Detail</th></tr></thead><tbody>
      ${steps.map(s => {
        const [lab, cls] = {ok: ["ONLINE", "green"], error: ["FAULT", "red"], running: ["PROVISION", "blue"], pending: ["PENDING", ""]}[s.status] || [s.status, ""];
        const p = s.status === "ok" ? 100 : (s.progress != null ? s.progress * 100 : 0);
        return `<tr><td>${esc(s.label)}</td><td><span class="tag ${cls}">${lab}</span></td>
          <td><div class="meter ${s.status === "ok" ? "green" : ""} ${s.status === "running" && s.progress == null ? "indet" : ""}"><i style="width:${p.toFixed(1)}%"></i></div></td>
          <td class="mono t2" title="${esc(s.message)}">${esc(s.message || "—")}</td></tr>`;
      }).join("")}</tbody></table>`;
    $("#boot").innerHTML = steps.map(s => {
      const [t, c] = s.status === "ok" ? ["[ OK ]", "ok"] : s.status === "error" ? ["[FAIL]", "err"] : ["[ .. ]", "wait"];
      return `<div><span class="${c}">${t}</span> ${esc(s.label)}${s.status !== "ok" && s.message ? ` <span class="faint">· ${esc(s.message)}</span>` : ""}</div>`;
    }).join("") + `<div style="margin-top:6px">${st.ready ? `<span class="ok">READY.</span> Paste a source URL into the command line.` :
      `<span class="wait">PROVISIONING.</span> Sources can be loaded now; production starts when models are online.`}</div>`;
    $("#config").innerHTML = [["Product", `${a.name} ${a.version}`], ["Deployment", "Local · single station"], ["Language model", a.llm],
      ["Speech model", a.whisper], ["Compute", a.apple_silicon ? "Apple Silicon · Metal" : "CPU"], ["Ships to", a.downloads], ["Data", a.data]]
      .map(([k, v]) => `<div>${k}</div><div class="${["Ships to", "Data", "Language model", "Speech model"].includes(k) ? "mono t2" : ""}">${esc(v)}</div>`).join("");
  }
  $("#nav-system").textContent = err ? "!" : pending.length ? "…" : "";
  $("#st-led").className = "led " + (err ? "bad" : pending.length ? "warn blink" : "");
  $("#st-engine").textContent = err ? "ENGINE FAULT" : pending.length ? "PROVISIONING" : "ENGINE ONLINE";
  $("#st-llm").textContent = `${a.llm} ${st.ready ? "READY" : "…"}`;
  $("#st-exports").textContent = `SHIPS TO ${a.downloads.replace(/^\/Users\/[^/]+/, "~")}`;
  $("#sh-dest").textContent = `DESTINATION ${a.downloads.replace(/^\/Users\/[^/]+/, "~")}`;
  $("#st-ver").textContent = `v${a.version}`;
  const active = jobs.find(j => j.status === "running");
  const queued = jobs.filter(j => j.status === "queued").length;
  $("#st-queue").textContent = queued;
  $("#st-active").innerHTML = active ? `▶ <b>WO-${active.order}</b> ${esc((STATIONS.find(s => s[0] === active.stage) || ["", active.stage])[1]).toUpperCase()} · ${esc(active.message)}` :
    !st.ready ? (() => { const d = steps.find(s => s.status === "running"); return d ? `PROVISIONING ${esc(d.label.toUpperCase())} · ${esc(d.message)}` : "PROVISIONING"; })() : "IDLE · AWAITING WORK ORDERS";
}
$("#retry-setup").onclick = () => api("/api/setup/retry", {method: "POST"});
$("#btn-exports").onclick = async () => { const r = await api("/api/reveal-downloads", {method: "POST"}); if (!navigator.platform.startsWith("Mac")) toast(r.path); };

/* ---------------- polling ---------------- */
async function poll() {
  try {
    const st = await api("/api/state");
    jobs = st.jobs;
    if (!selOrder && jobs.length) selOrder = (jobs.find(j => j.status === "running") || jobs[0]).id;
    renderSystem(st); renderOrders(); renderUnits(); renderShipping(); refreshBayStatus();
  } catch {
    $("#st-led").className = "led bad"; $("#st-engine").textContent = "ENGINE OFFLINE";
  }
}
setInterval(poll, 1000);
poll(); renderRecent(); route();
