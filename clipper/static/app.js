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
const PAGES = ["workbench", "factory", "inventory", "system"];
function route() {
  const p = PAGES.includes(location.hash.slice(1)) ? location.hash.slice(1) : "workbench";
  $$(".page").forEach(el => el.classList.toggle("on", el.id === "page-" + p));
  $$(".tabs a").forEach(a => a.classList.toggle("on", a.dataset.page === p));
  if (p === "workbench") requestAnimationFrame(drawTimeline);
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
const HELP = "URL or file path = load source · WB FAC INV SYS = switch module · IN / OUT = mark range · SEND = dispatch · WO 1001 = open order";
function runCommand(raw) {
  const s = raw.trim(); if (!s) return;
  const up = s.toUpperCase(), [head, ...rest] = up.split(/\s+/);
  if (/^https?:\/\//i.test(s) || s.startsWith("/") || s.startsWith("~")) return loadSource(s);
  const nav = {WB: "workbench", WORKBENCH: "workbench", FAC: "factory", FACTORY: "factory", INV: "inventory", INVENTORY: "inventory", SYS: "system", SYSTEM: "system"};
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
  const fk = {F1: "workbench", F2: "factory", F3: "inventory", F4: "system"}[e.key];
  if (fk) { e.preventDefault(); return go(fk); }
  if ((e.metaKey || e.ctrlKey) && ["1", "2", "3", "4"].includes(e.key)) { e.preventDefault(); return go(PAGES[+e.key - 1]); }
  const typing = ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement.tagName);
  if (e.key === "/" && !typing) { e.preventDefault(); $("#cmd").focus(); $("#cmd").select(); return; }
  if (typing || !src || !$("#page-workbench").classList.contains("on")) return;
  const k = e.key.toLowerCase();
  if (k === " ") { e.preventDefault(); video.paused ? video.play() : video.pause(); }
  else if (k === "i") markIn();
  else if (k === "o") markOut();
  else if (k === "j") seek(video.currentTime - 10);
  else if (k === "l") seek(video.currentTime + 10);
  else if (k === "arrowleft") seek(video.currentTime - (e.shiftKey ? 60 : 5));
  else if (k === "arrowright") seek(video.currentTime + (e.shiftKey ? 60 : 5));
});

/* ---------------- workbench: source ---------------- */
const video = $("#video");
let src = null, hls = null, heat = null, sel = null, heatTimer = null;

async function loadSource(source) {
  go("workbench");
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
$("#keys").innerHTML = [["/", "Command line"], ["F1–F4", "Switch module"], ["Space", "Play / pause"], ["I / O", "Mark in / out"],
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
    src = d; go("workbench"); showSource();
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
const STATUS = {queued: ["QUEUED", ""], running: ["ACTIVE", "blue"], done: ["SHIPPED", "green"], failed: ["FAULT", "red"], cancelled: ["CANCELLED", "amber"]};
let jobs = [], selOrder = null;

function stationStates(j) {
  const cur = STATIONS.findIndex(s => s[0] === j.stage);
  return STATIONS.map((_, i) => j.status === "done" || i < cur ? "done" :
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
    box.innerHTML = !jobs.length ? `<div class="empty"><b>PRODUCTION LINE IDLE</b>Mark a range in the Workbench and dispatch it.</div>` :
      `<table class="dt"><thead><tr><th style="width:74px">Order</th><th style="width:86px">Status</th><th>Source</th><th style="width:136px">Range</th>
        <th style="width:72px">Stations</th><th style="width:110px">Progress</th><th class="r" style="width:46px">Units</th><th class="r" style="width:52px">Age</th></tr></thead><tbody>
      ${jobs.map(j => {
        const [label, cls] = STATUS[j.status] || [j.status, ""], o = j.options || {};
        const pct = j.status === "done" ? 100 : (j.progress != null ? j.progress * 100 : 0);
        const indet = j.status === "running" && j.progress == null;
        return `<tr class="click ${j.id === selOrder ? "on" : ""}" data-id="${j.id}"><td class="data">WO-${j.order}</td><td><span class="tag ${cls}">${label}</span></td>
          <td>${esc(j.title || j.source)}</td><td class="mono t2">${o.start != null ? `${tc(o.start)}–${tc(o.end)}` : "FULL"}</td>
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
      <div>Range</div><div class="data">${o.start != null ? `${tc(o.start)} – ${tc(o.end)}  (${tc(o.end - o.start)})` : "FULL"}</div>
      <div>Spec</div><div class="mono t2">${o.mode === "exact" ? "EXACT CUT" : `${o.max_clips} UNITS · ${o.min_len}–${o.max_len}s`} · ${o.layout === "auto" ? "AUTO" : LAYOUTS[o.layout] || o.layout}</div>
      <div>Received</div><div class="mono t2">${isoTime(j.created)}</div>
      ${j.export_dir ? `<div>Exported</div><div class="mono t2">${esc(j.export_dir)}</div>` : ""}
    </div>
    <div class="sect">Stations</div>
    <div class="stations">${stationStates(j).map((c, i) => `<div class="stn ${c}">${STATIONS[i][1]}</div>`).join("")}</div>
    <div style="padding:0 10px 8px"><div class="meter ${j.status === "done" ? "green" : ""} ${j.status === "running" && j.progress == null ? "indet" : ""}"><i style="width:${pct.toFixed(1)}%"></i></div>
      <div class="mono t2" style="margin-top:5px;font-size:11px">${esc(j.message)}</div></div>
    <div class="acts">
      ${j.status === "done" ? `<button class="btn primary" data-act="inv">VIEW ${j.clips.length} UNIT${j.clips.length === 1 ? "" : "S"}</button><button class="btn" data-act="reveal">REVEAL IN FINDER</button>` : ""}
      ${j.status === "running" || j.status === "queued" ? `<button class="btn" data-act="cancel">CANCEL ORDER</button>` : ""}
      ${j.status === "failed" || j.status === "cancelled" ? `<button class="btn amber" data-act="retry">RE-RUN</button>` : ""}
      ${j.status !== "running" && j.status !== "queued" ? `<button class="btn minimal" data-act="del">DELETE</button>` : ""}
    </div>
    <div class="sect">Production log</div>
    <pre class="log" style="max-height:340px;overflow:auto">${esc(j.log.join("\n"))}</pre>`;
  const lg = $(".log", box); if (stick) lg.scrollTop = lg.scrollHeight;
  $$("[data-act]", box).forEach(b => b.onclick = async () => {
    const a = b.dataset.act, id = j.id;
    try {
      if (a === "inv") { $("#inv-order").value = id; go("inventory"); renderInventory(true); return; }
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

/* ---------------- inventory ---------------- */
let invKey = "", selUnit = null;
const unitKey = c => `${c.job.id}/${c.file}`;
function allClips() {
  const out = [];
  for (const j of jobs) j.clips.forEach((c, i) => out.push({...c, job: j, idx: i}));
  return out;
}
function renderInventory(force) {
  const clips = allClips();
  $("#nav-inventory").textContent = clips.length || "";
  const orderSel = $("#inv-order"), cur = orderSel.value;
  const withClips = jobs.filter(j => j.clips.length);
  if (orderSel.dataset.sig !== String(withClips.length)) {
    orderSel.innerHTML = `<option value="">ALL ORDERS</option>` + withClips.map(j => `<option value="${j.id}">WO-${j.order}</option>`).join("");
    orderSel.value = cur; orderSel.dataset.sig = String(withClips.length);
  }
  const q = $("#inv-q").value.toLowerCase(), sort = $("#inv-sort").value, ord = orderSel.value;
  const list = clips.filter(c => (!ord || c.job.id === ord) && (!q || [c.hook, c.title, c.job.title, c.text].join(" ").toLowerCase().includes(q)));
  list.sort(sort === "score" ? (a, b) => b.score - a.score : (a, b) => b.job.created - a.job.created || a.idx - b.idx);
  $("#inv-count").textContent = `${list.length} / ${clips.length} UNITS`;
  const key = list.map(unitKey).join("|") + selUnit;
  if (key !== invKey || force) {
    invKey = key;
    $("#clips").innerHTML = !clips.length ? `<div class="empty"><b>NO FINISHED GOODS</b>Shipped work orders deliver their clips here.</div>` :
      `<table class="dt"><thead><tr><th style="width:40px"></th><th style="width:52px">Score</th><th>Hook</th><th style="width:74px">Order</th>
        <th style="width:80px">Src TC</th><th class="r" style="width:46px">Dur</th><th style="width:120px">Layout</th><th class="r" style="width:56px">Chat</th></tr></thead><tbody>
      ${list.map(c => {
        const thumb = c.thumb ? `<img class="thumb" loading="lazy" src="/files/${encodeURIComponent(c.job.id)}/${encodeURIComponent(c.thumb)}">` : `<div class="thumb"></div>`;
        return `<tr class="click tall ${unitKey(c) === selUnit ? "on" : ""}" data-k="${esc(unitKey(c))}"><td>${thumb}</td>
          <td><span class="score ${scoreCls(c.score)}">${c.score}</span></td>
          <td><div class="hook" style="overflow:hidden;text-overflow:ellipsis">${esc(c.hook || c.title)}</div><div class="faint" style="font-size:11px;overflow:hidden;text-overflow:ellipsis">${esc(c.title)}</div></td>
          <td class="data">WO-${c.job.order}</td><td class="mono t2">${tc(c.abs_start != null ? c.abs_start : c.start)}</td>
          <td class="r mono">${Math.round(c.end - c.start)}s</td><td class="mono t2" style="font-size:10.5px">${LAYOUTS[c.layout] || "—"}</td>
          <td class="r mono ${c.peak_chat >= 1.8 ? "data" : "faint"}">${c.peak_chat ? c.peak_chat.toFixed(1) + "×" : "—"}</td></tr>`;
      }).join("")}</tbody></table>`;
    $$("#clips tr.click").forEach(tr => tr.onclick = () => { selUnit = tr.dataset.k; renderInventory(true); renderUnit(); });
  }
  if (!selUnit && list.length) { selUnit = unitKey(list[0]); renderInventory(true); renderUnit(); }
}
["#inv-q", "#inv-sort", "#inv-order"].forEach(id => $(id).addEventListener("input", () => renderInventory(true)));

function renderUnit() {
  const c = allClips().find(x => unitKey(x) === selUnit);
  const box = $("#unit");
  if (!c) { $("#unit-id").textContent = ""; box.innerHTML = `<div class="empty"><b>NO UNIT SELECTED</b>Select a clip to review it.</div>`; return; }
  const url = `/files/${encodeURIComponent(c.job.id)}/${encodeURIComponent(c.file)}`;
  const poster = c.thumb ? ` poster="/files/${encodeURIComponent(c.job.id)}/${encodeURIComponent(c.thumb)}"` : "";
  $("#unit-id").textContent = `WO-${c.job.order} / ${String(c.idx + 1).padStart(2, "0")}`;
  box.innerHTML = `<div class="clipview"><video src="${url}"${poster} controls playsinline preload="metadata"></video></div>
    <div class="kv">
      <div>Hook</div><div class="hook sel-text">${esc(c.hook || c.title)}</div>
      <div>Title</div><div class="sel-text">${esc(c.title)}</div>
      <div>Score</div><div><span class="score ${scoreCls(c.score)}">${c.score}</span> <span class="mono faint">LLM ${c.llm_score ?? "—"} · RANK ${c.rerank_score ?? "—"} · SIGNAL ${c.signal_score ?? "—"}</span></div>
      <div>Rationale</div><div class="t2">${esc(c.reason)}</div>
      <div>Source</div><div class="t2">${esc(c.job.title)}</div>
      <div>Source TC</div><div class="data">${tc(c.abs_start ?? c.start)} – ${tc(c.abs_end ?? c.end)}</div>
      <div>Format</div><div class="mono t2">1080×1920 · ${Math.round(c.end - c.start)}s · ${LAYOUTS[c.layout] || "—"}</div>
      <div>Chat peak</div><div class="mono ${c.peak_chat >= 1.8 ? "data" : "t2"}">${c.peak_chat ? c.peak_chat.toFixed(1) + "× baseline" : "n/a"}</div>
    </div>
    <div class="acts"><a class="btn primary" href="${url}" download="${esc((c.hook || c.title || "clip").slice(0, 60))}.mp4">DOWNLOAD MP4</a>
      <button class="btn" id="unit-reveal">REVEAL IN FINDER</button></div>
    <div class="sect">Transcript</div><div class="t2 sel-text" style="padding:0 10px 12px;font-size:11.5px;line-height:1.55">${esc(c.text || "")}</div>`;
  $("#unit-reveal").onclick = () => api(`/api/orders/${c.job.id}/reveal`, {method: "POST"});
}

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
      ["Speech model", a.whisper], ["Compute", a.apple_silicon ? "Apple Silicon · Metal" : "CPU"], ["Exports", a.exports], ["Data", a.data]]
      .map(([k, v]) => `<div>${k}</div><div class="${["Exports", "Data", "Language model", "Speech model"].includes(k) ? "mono t2" : ""}">${esc(v)}</div>`).join("");
  }
  $("#nav-system").textContent = err ? "!" : pending.length ? "…" : "";
  $("#st-led").className = "led " + (err ? "bad" : pending.length ? "warn blink" : "");
  $("#st-engine").textContent = err ? "ENGINE FAULT" : pending.length ? "PROVISIONING" : "ENGINE ONLINE";
  $("#st-llm").textContent = `${a.llm} ${st.ready ? "READY" : "…"}`;
  $("#st-exports").textContent = `EXPORTS ${a.exports.replace(/^\/Users\/[^/]+/, "~")}`;
  $("#st-ver").textContent = `v${a.version}`;
  const active = jobs.find(j => j.status === "running");
  const queued = jobs.filter(j => j.status === "queued").length;
  $("#st-queue").textContent = queued;
  $("#st-active").innerHTML = active ? `▶ <b>WO-${active.order}</b> ${esc((STATIONS.find(s => s[0] === active.stage) || ["", active.stage])[1]).toUpperCase()} · ${esc(active.message)}` :
    !st.ready ? (() => { const d = steps.find(s => s.status === "running"); return d ? `PROVISIONING ${esc(d.label.toUpperCase())} · ${esc(d.message)}` : "PROVISIONING"; })() : "IDLE · AWAITING WORK ORDERS";
}
$("#retry-setup").onclick = () => api("/api/setup/retry", {method: "POST"});
$("#btn-exports").onclick = async () => { const r = await api("/api/reveal-exports", {method: "POST"}); if (!navigator.platform.startsWith("Mac")) toast(r.path); };

/* ---------------- polling ---------------- */
async function poll() {
  try {
    const st = await api("/api/state");
    jobs = st.jobs;
    if (!selOrder && jobs.length) selOrder = (jobs.find(j => j.status === "running") || jobs[0]).id;
    renderSystem(st); renderOrders(); renderInventory();
    if (selUnit && !$("#unit video")) renderUnit();
  } catch {
    $("#st-led").className = "led bad"; $("#st-engine").textContent = "ENGINE OFFLINE";
  }
}
setInterval(poll, 1000);
poll(); renderRecent(); route();
