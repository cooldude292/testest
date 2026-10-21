"use strict";
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
const pad = n => String(n).padStart(2, "0");
const tc = t => { t = Math.max(0, Math.floor(t || 0)); return `${pad(Math.floor(t / 3600))}:${pad(Math.floor(t % 3600 / 60))}:${pad(t % 60)}`; };
const dur = t => { t = Math.round(t || 0); const h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), s = t % 60;
  return h ? `${h}h ${pad(m)}m` : m ? `${m}m ${pad(s)}s` : `${s}s`; };
const parseTc = s => { s = String(s).trim(); if (!s) return null; let t = 0;
  for (const p of s.split(":")) { const v = parseFloat(p); if (isNaN(v)) return null; t = t * 60 + v; } return t; };
const api = async (path, opts = {}) => {
  const r = await fetch(path, {headers: {"Content-Type": "application/json"}, ...opts});
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.detail || `Request failed (${r.status})`);
  return d;
};
function toast(msg, err) {
  const el = document.createElement("div"); el.textContent = msg; if (err) el.className = "err";
  $("#toast").appendChild(el); setTimeout(() => el.remove(), err ? 6000 : 3500);
}

/* ---------------- routing ---------------- */
const PAGES = {workbench: "Workbench", factory: "Factory", inventory: "Inventory", system: "System"};
const CRUMBS = {workbench: "Select footage and dispatch work orders", factory: "Work orders in production",
                inventory: "Finished clips", system: "Models, storage and diagnostics"};
function route() {
  const p = (location.hash.slice(1) || "workbench");
  const page = PAGES[p] ? p : "workbench";
  $$(".page").forEach(el => el.classList.toggle("on", el.id === "page-" + page));
  $$(".nav a").forEach(a => a.classList.toggle("on", a.dataset.page === page));
  $("#page-title").textContent = PAGES[page];
  $("#page-crumb").textContent = "· " + CRUMBS[page];
  if (page === "workbench") drawTimeline();
}
window.addEventListener("hashchange", route);

/* ---------------- workbench: source ---------------- */
const video = $("#video");
let src = null, hls = null, heat = null, sel = null, heatTimer = null;

async function loadSource(source) {
  if (!source) return;
  $("#src-load").disabled = true; $("#src-load").textContent = "Loading…";
  try {
    src = await api("/api/probe", {method: "POST", body: JSON.stringify({source})});
    showSource();
  } catch (e) { toast(e.message, true); }
  finally { $("#src-load").disabled = false; $("#src-load").textContent = "Load source"; }
}

function showSource() {
  $("#wb-empty").style.display = "none"; $("#wb-loaded").style.display = "";
  $("#src-input").value = src.source;
  $("#src-kind").textContent = src.kind === "file" ? "File" : src.kind;
  $("#src-title").textContent = src.title;
  $("#src-meta").textContent = [src.channel, dur(src.duration)].filter(Boolean).join(" · ");
  sel = null; heat = null; updateSel();
  $("#tp-tc").textContent = `${tc(0)} / ${tc(src.duration)}`;
  $("#player-msg").style.display = "none";
  if (hls) { hls.destroy(); hls = null; }
  const url = src.preview_url;
  if (src.preview_type === "hls" && !video.canPlayType("application/vnd.apple.mpegurl") && window.Hls && Hls.isSupported()) {
    hls = new Hls({maxBufferLength: 20}); hls.loadSource(url); hls.attachMedia(video);
    hls.on(Hls.Events.ERROR, (_, d) => { if (d.fatal) previewFailed(); });
  } else { video.src = url; }
  clearInterval(heatTimer); pollHeat(); heatTimer = setInterval(pollHeat, 2000);
  drawTimeline();
}

async function pollHeat() {
  if (!src) return;
  try { heat = await api(`/api/heatmap/${src.key}`); } catch { return; }
  if (heat.state !== "running") clearInterval(heatTimer);
  const label = {"Chat activity": "Chat activity", "Most replayed": "Viewer replays"}[heat.source] || "No signal";
  $("#tl-signal").textContent = heat.state === "none" ? "No activity signal for this source" : label;
  $("#tl-status").textContent =
    heat.state === "running" ? ` · reading chat replay ${Math.round((heat.progress || 0) * 100)}%` :
    heat.state === "error" ? " · chat unavailable" :
    heat.messages ? ` · ${heat.messages.toLocaleString()} messages` : "";
  $("#hot-src").textContent = heat.state === "done" ? label : "";
  renderHot(); drawTimeline();
}

function renderHot() {
  const box = $("#hot");
  if (!heat || !heat.peaks || !heat.peaks.length) {
    box.innerHTML = `<div class="empty">${heat && heat.state === "running" ? "Analyzing chat replay…" :
      "No activity signal. Scrub the timeline and mark a range by hand."}</div>`;
    return;
  }
  const top = Math.max(...heat.peaks.map(p => p.intensity));
  box.innerHTML = heat.peaks.map((p, i) => `<div class="hot">
      <span class="mono">${tc(p.start)}</span>
      <div><div class="heat"><i style="width:${(p.intensity / top * 100).toFixed(0)}%"></i></div>
        <div class="faint" style="font-size:11px;margin-top:3px">${p.intensity}× normal activity</div></div>
      <span><button class="btn sm ghost" data-go="${i}">Preview</button><button class="btn sm" data-sel="${i}">Select</button></span>
    </div>`).join("");
  $$("[data-go]", box).forEach(b => b.onclick = () => { seek(heat.peaks[+b.dataset.go].start); video.play(); });
  $$("[data-sel]", box).forEach(b => b.onclick = () => { const p = heat.peaks[+b.dataset.sel]; setSel(p.start, p.end); seek(p.start); });
}

async function renderRecent() {
  const list = await api("/api/recent").catch(() => []);
  $("#recent").innerHTML = list.length ? `<table class="t"><thead><tr><th>Source</th><th>Channel</th><th>Type</th><th>Length</th></tr></thead><tbody>
    ${list.map((r, i) => `<tr class="click" data-i="${i}"><td><b>${esc(r.title)}</b></td><td class="muted">${esc(r.channel)}</td>
      <td><span class="badge">${esc(r.kind)}</span></td><td class="mono">${tc(r.duration)}</td></tr>`).join("")}</tbody></table>`
    : `<div class="empty"><b>No sources yet</b>Paste a stream or video link above to start.</div>`;
  $$("#recent tr.click").forEach(tr => tr.onclick = () => loadSource(list[+tr.dataset.i].source));
}

$("#src-load").onclick = () => loadSource($("#src-input").value);
$("#src-input").addEventListener("keydown", e => { if (e.key === "Enter") loadSource(e.target.value); });
$("#src-file").onclick = async () => {
  if (window.pywebview && window.pywebview.api && window.pywebview.api.pick_file) {
    const path = await window.pywebview.api.pick_file();
    if (path) loadSource(path);
  } else { $("#src-file-input").click(); }
};
$("#src-file-input").onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  const fd = new FormData(); fd.append("file", f);
  toast("Importing file…");
  try {
    const r = await fetch("/api/upload", {method: "POST", body: fd}); const d = await r.json();
    if (!r.ok) throw new Error(d.detail || "Import failed");
    src = d; showSource();
  } catch (err) { toast(err.message, true); }
  e.target.value = "";
};

/* ---------------- transport ---------------- */
const seek = t => { video.currentTime = Math.max(0, Math.min(t, (src && src.duration) || t)); drawTimeline(); };
let loopSel = false;
$("#tp-play").onclick = () => video.paused ? video.play() : video.pause();
$("#tp-back").onclick = () => seek(video.currentTime - 10);
$("#tp-fwd").onclick = () => seek(video.currentTime + 10);
$("#tp-in").onclick = () => markIn();
$("#tp-out").onclick = () => markOut();
$("#tp-clear").onclick = () => { sel = null; updateSel(); };
$("#tp-loop").onclick = () => { if (!sel) return; loopSel = true; seek(sel.start); video.play(); };
function previewFailed() {
  const m = $("#player-msg"); m.style.display = "";
  m.innerHTML = `<b>Preview unavailable</b><span>This player can't decode the stream. Use the timeline and hot spots to pick a range; the factory still works.</span>`;
}
video.addEventListener("error", () => { if (src) previewFailed(); });
video.addEventListener("play", () => $("#tp-play").textContent = "Pause");
video.addEventListener("pause", () => $("#tp-play").textContent = "Play");
video.addEventListener("timeupdate", () => {
  $("#tp-tc").textContent = `${tc(video.currentTime)} / ${tc(src ? src.duration : 0)}`;
  if (loopSel && sel && video.currentTime >= sel.end) { video.pause(); loopSel = false; }
  drawTimeline();
});
function markIn() { const t = video.currentTime; setSel(t, sel && sel.end > t + 1 ? sel.end : Math.min(t + 600, src.duration)); }
function markOut() { const t = video.currentTime; setSel(sel && sel.start < t - 1 ? sel.start : Math.max(0, t - 600), t); }
document.addEventListener("keydown", e => {
  if (!src || !$("#page-workbench").classList.contains("on")) return;
  if (["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement.tagName)) return;
  const k = e.key.toLowerCase();
  if (k === " ") { e.preventDefault(); video.paused ? video.play() : video.pause(); }
  else if (k === "i") markIn();
  else if (k === "o") markOut();
  else if (k === "j") seek(video.currentTime - 10);
  else if (k === "l") seek(video.currentTime + 10);
  else if (k === "arrowleft") seek(video.currentTime - (e.shiftKey ? 60 : 5));
  else if (k === "arrowright") seek(video.currentTime + (e.shiftKey ? 60 : 5));
});

/* ---------------- selection ---------------- */
function setSel(a, b) {
  if (!src) return;
  a = Math.max(0, Math.min(a, src.duration)); b = Math.max(0, Math.min(b, src.duration));
  if (b < a) [a, b] = [b, a];
  sel = b - a >= 1 ? {start: a, end: b} : null;
  updateSel();
}
function updateSel() {
  const ok = !!sel && sel.end - sel.start >= 10;
  $("#sel-in").value = sel ? tc(sel.start) : ""; $("#sel-out").value = sel ? tc(sel.end) : "";
  $("#sel-len").textContent = sel ? dur(sel.end - sel.start) : "—";
  const st = $("#wo-state");
  if (!sel) { st.textContent = "No selection"; st.className = "right badge"; }
  else if (!ok) { st.textContent = "Too short"; st.className = "right badge warn"; }
  else if (sel.end - sel.start > 3600) { st.textContent = "Long range"; st.className = "right badge warn"; }
  else { st.textContent = "Ready"; st.className = "right badge ok"; }
  $("#send").disabled = !ok;
  drawTimeline();
}
["#sel-in", "#sel-out"].forEach(id => $(id).addEventListener("change", () => {
  const a = parseTc($("#sel-in").value), b = parseTc($("#sel-out").value);
  if (a != null && b != null) setSel(a, b); else updateSel();
}));

$("#send").onclick = async () => {
  if (!sel || !src) return;
  const [mn, mx] = $("#opt-len").value.split("-").map(Number);
  $("#send").disabled = true;
  try {
    const wo = await api("/api/orders", {method: "POST", body: JSON.stringify({
      source: src.source, start: sel.start, end: sel.end, title: src.title,
      max_clips: +$("#opt-clips").value, min_len: mn, max_len: mx, layout: $("#opt-layout").value})});
    toast(`WO-${wo.order} dispatched to the factory`);
    sel = null; updateSel();
    poll();
  } catch (e) { toast(e.message, true); $("#send").disabled = false; }
};

/* ---------------- timeline canvas ---------------- */
const cv = $("#tl"), ctx2 = cv.getContext("2d");
let drag = null;
const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
function drawTimeline() {
  if (!src || !cv.offsetWidth) return;
  const dpr = window.devicePixelRatio || 1, W = cv.offsetWidth, H = cv.offsetHeight;
  if (cv.width !== W * dpr || cv.height !== H * dpr) { cv.width = W * dpr; cv.height = H * dpr; }
  const c = ctx2; c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, W, H);
  const D = src.duration || 1, X = t => t / D * W, top = 18, base = H - 4;
  // ruler
  c.fillStyle = css("--faint"); c.font = `10px ${css("--mono")}`; c.textBaseline = "top";
  const steps = [60, 300, 600, 900, 1800, 3600, 7200];
  const step = steps.find(s => D / s <= 12) || 7200;
  for (let t = 0; t <= D; t += step) {
    c.fillRect(X(t), 0, 1, 5);
    if (X(t) < W - 50) c.fillText(tc(t), X(t) + 3, 2);
  }
  // heat
  if (heat && heat.bins) {
    const n = heat.bins.length, bw = W / n;
    c.fillStyle = css("--heat");
    heat.bins.forEach((v, i) => { const h = Math.max(1, v * (base - top)); c.globalAlpha = .35 + .65 * v; c.fillRect(i * bw, base - h, Math.max(1, bw - .5), h); });
    c.globalAlpha = 1;
  } else {
    c.fillStyle = css("--line"); c.fillRect(0, base - 1, W, 1);
  }
  // selection
  if (sel) {
    const a = X(sel.start), b = X(sel.end);
    c.fillStyle = css("--sel"); c.fillRect(a, top - 4, b - a, base - top + 4);
    c.fillStyle = css("--sel-line"); c.fillRect(a - 1, top - 4, 2, base - top + 4); c.fillRect(b - 1, top - 4, 2, base - top + 4);
    c.fillRect(a - 4, top - 4, 8, 10); c.fillRect(b - 4, top - 4, 8, 10);
  }
  // playhead
  const p = X(video.currentTime || 0);
  c.fillStyle = css("--text"); c.fillRect(p - .5, 8, 1.5, H - 8);
  c.beginPath(); c.moveTo(p - 5, 8); c.lineTo(p + 6, 8); c.lineTo(p + .5, 14); c.fill();
}
window.addEventListener("resize", drawTimeline);
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
const STATIONS = [["download", "Intake"], ["audio", "Audio"], ["chat", "Chat"], ["transcribe", "Transcribe"],
                  ["moments", "Analysis"], ["render", "Assembly"]];
const STATUS = {queued: ["Queued", ""], running: ["In production", "live"], done: ["Shipped", "ok"],
                failed: ["Failed", "bad"], cancelled: ["Cancelled", "warn"]};
let jobs = [];
const openLogs = new Set();

function renderOrders() {
  const box = $("#orders");
  $("#k-run").textContent = jobs.filter(j => j.status === "running").length;
  $("#k-queue").textContent = jobs.filter(j => j.status === "queued").length;
  $("#k-done").textContent = jobs.filter(j => j.status === "done").length;
  $("#k-clips").textContent = jobs.reduce((n, j) => n + j.clips.length, 0);
  const live = jobs.filter(j => j.status === "running" || j.status === "queued").length;
  const nf = $("#nav-factory"); nf.textContent = live || jobs.length; nf.classList.toggle("live", live > 0);
  if (!jobs.length) { box.dataset.sig = ""; return; }
  const sig = JSON.stringify(jobs.map(j => [j.id, j.status, j.stage, j.progress && j.progress.toFixed(2), j.message,
                                            j.clips.length, j.log.length])) + [...openLogs].join();
  if (box.dataset.sig === sig) return;   // only redraw when something changed, so clicks aren't eaten
  box.dataset.sig = sig;
  box.innerHTML = jobs.map(j => {
    const [label, cls] = STATUS[j.status] || [j.status, ""];
    const cur = STATIONS.findIndex(s => s[0] === j.stage);
    const st = STATIONS.map(([k, name], i) => {
      let c = "";
      if (j.status === "done" || i < cur) c = "done";
      else if (i === cur) c = j.status === "running" ? "cur" : (j.status === "failed" ? "fail" : "");
      const icon = c === "cur" ? `<span class="spin"></span>` : c === "done" ? "✓" : "";
      return `<div class="st ${c}"><div class="ln"></div><div class="nm">${icon}${name}</div></div>`;
    }).join("");
    const o = j.options || {};
    const range = o.start != null ? `${tc(o.start)} – ${tc(o.end)}` : "Full source";
    const active = j.status === "running";
    const pct = j.status === "done" ? 100 : (j.progress != null ? j.progress * 100 : 0);
    return `<div class="wo" data-id="${j.id}">
      <div class="wo-h"><span class="id">WO-${j.order || "—"}</span><span class="badge ${cls}">${label}</span>
        <span class="ttl">${esc(j.title || j.source)}</span><span class="mono muted">${range}</span>
        <span class="right">
          ${j.status === "done" ? `<button class="btn sm" data-act="inv">${j.clips.length} clip${j.clips.length === 1 ? "" : "s"}</button><button class="btn sm" data-act="reveal">Reveal</button>` : ""}
          ${j.status === "running" || j.status === "queued" ? `<button class="btn sm" data-act="cancel">Cancel</button>` : ""}
          ${j.status === "failed" || j.status === "cancelled" ? `<button class="btn sm" data-act="retry">Re-run</button>` : ""}
          <button class="btn sm ghost" data-act="log">Log</button>
          ${j.status !== "running" && j.status !== "queued" ? `<button class="btn sm ghost" data-act="del" title="Delete order">Delete</button>` : ""}
        </span></div>
      <div class="stations">${st}</div>
      <div class="wo-msg">${active || j.status === "done" ? `<div class="bar ${active && j.progress == null ? "indet" : ""}"><i style="width:${pct.toFixed(1)}%"></i></div>` : ""}
        <span>${esc(j.message)}</span></div>
      <div class="log ${openLogs.has(j.id) ? "on" : ""}">${esc(j.log.join("\n"))}</div>
    </div>`;
  }).join("");
  $$(".wo", box).forEach(el => {
    const id = el.dataset.id;
    $$("[data-act]", el).forEach(b => b.onclick = async () => {
      const a = b.dataset.act;
      try {
        if (a === "log") { openLogs.has(id) ? openLogs.delete(id) : openLogs.add(id); renderOrders(); return; }
        if (a === "inv") { $("#inv-order").value = id; location.hash = "#inventory"; renderInventory(); return; }
        if (a === "reveal") { const r = await api(`/api/orders/${id}/reveal`, {method: "POST"}); if (!navigator.platform.startsWith("Mac")) toast(r.path); return; }
        if (a === "cancel") await api(`/api/orders/${id}/cancel`, {method: "POST"});
        if (a === "retry") await api(`/api/orders/${id}/retry`, {method: "POST"});
        if (a === "del") {
          if (b.dataset.armed !== "1") { b.dataset.armed = "1"; b.textContent = "Confirm delete"; b.classList.remove("ghost");
            setTimeout(() => { b.dataset.armed = ""; b.textContent = "Delete"; b.classList.add("ghost"); }, 3000); return; }
          await api(`/api/orders/${id}`, {method: "DELETE"});
        }
        poll();
      } catch (e) { toast(e.message, true); }
    });
  });
}

/* ---------------- inventory ---------------- */
let invKey = "";
function allClips() {
  const out = [];
  for (const j of jobs) j.clips.forEach((c, i) => out.push({...c, job: j, idx: i}));
  return out;
}
function renderInventory(force) {
  const clips = allClips();
  $("#nav-inventory").textContent = clips.length;
  const orderSel = $("#inv-order"), cur = orderSel.value;
  const withClips = jobs.filter(j => j.clips.length);
  const opts = `<option value="">All orders</option>` + withClips.map(j => `<option value="${j.id}">WO-${j.order} · ${esc((j.title || "").slice(0, 40))}</option>`).join("");
  if (orderSel.dataset.sig !== String(withClips.length)) { orderSel.innerHTML = opts; orderSel.value = cur; orderSel.dataset.sig = String(withClips.length); }
  const q = $("#inv-q").value.toLowerCase(), sort = $("#inv-sort").value, ord = orderSel.value;
  let list = clips.filter(c => (!ord || c.job.id === ord) &&
    (!q || [c.hook, c.title, c.job.title, c.text].join(" ").toLowerCase().includes(q)));
  list.sort(sort === "score" ? (a, b) => b.score - a.score : (a, b) => b.job.created - a.job.created || a.idx - b.idx);
  const key = list.map(c => c.job.id + c.file).join("|");
  $("#inv-count").textContent = `${list.length} clip${list.length === 1 ? "" : "s"}`;
  $("#inv-empty").style.display = clips.length ? "none" : "";
  if (key === invKey && !force) return;   // don't rebuild players mid-playback
  invKey = key;
  $("#clips").innerHTML = list.map(c => {
    const url = `/files/${encodeURIComponent(c.job.id)}/${encodeURIComponent(c.file)}`;
    const sc = c.score >= 70 ? "hi" : c.score >= 50 ? "mid" : "";
    const at = c.abs_start != null ? c.abs_start : c.start;
    const poster = c.thumb ? ` poster="/files/${encodeURIComponent(c.job.id)}/${encodeURIComponent(c.thumb)}"` : "";
    return `<div class="card clip"><video src="${url}"${poster} controls preload="none" playsinline></video>
      <div class="b"><div class="row"><span class="score ${sc}">${c.score}</span><span class="mono">WO-${c.job.order}</span><span>${Math.round(c.end - c.start)}s</span><span>${esc(c.layout || "")}</span></div>
        <div class="hk">${esc(c.hook || c.title)}</div>
        <div class="row">${esc(c.title)}</div>
        <div class="row faint">${esc(c.job.title || "")} @ ${tc(at)}${c.peak_chat >= 1.8 ? ` · chat ${c.peak_chat}×` : ""}</div>
        <div class="acts"><a class="btn sm" href="${url}" download="${esc((c.hook || c.title || "clip").slice(0, 60))}.mp4">Download</a>
          <button class="btn sm ghost" data-reveal="${c.job.id}">Reveal</button></div></div></div>`;
  }).join("");
  $$("[data-reveal]").forEach(b => b.onclick = () => api(`/api/orders/${b.dataset.reveal}/reveal`, {method: "POST"}));
}
["#inv-q", "#inv-sort", "#inv-order"].forEach(id => $(id).addEventListener("input", () => renderInventory(true)));

/* ---------------- system ---------------- */
function renderSystem(st) {
  const steps = Object.values(st.setup);
  $("#steps").innerHTML = steps.map(s => {
    const icon = s.status === "ok" ? `<span style="color:var(--ok)">✓</span>` : s.status === "error" ? `<span style="color:var(--bad)">✗</span>` :
                 s.status === "running" ? `<span class="spin" style="color:var(--accent)"></span>` : `<span class="faint">○</span>`;
    const p = s.status === "ok" ? 100 : (s.progress != null ? s.progress * 100 : 0);
    return `<div class="step">${icon}<div><b>${esc(s.label)}</b><div class="msg">${esc(s.message || s.status)}</div></div>
      <div class="bar ${s.status === "running" && s.progress == null ? "indet" : ""}"><i style="width:${p.toFixed(1)}%"></i></div></div>`;
  }).join("");
  const a = st.app;
  $("#config").innerHTML = [["Product", `${a.name} ${a.version}`], ["Language model", a.llm], ["Speech model", a.whisper],
    ["Compute", a.apple_silicon ? "Apple Silicon (Metal)" : "CPU"], ["Exports", a.exports], ["Data", a.data]]
    .map(([k, v]) => `<div>${k}</div><div class="${k === "Exports" || k === "Data" ? "mono" : ""}">${esc(v)}</div>`).join("");

  // global provisioning banner + sidebar status
  const pending = steps.filter(s => s.status !== "ok");
  const err = steps.find(s => s.status === "error");
  $("#provision").style.display = st.ready ? "none" : "";
  if (!st.ready) {
    const dl = steps.find(s => s.status === "running");
    $("#provision-msg").textContent = err ? `${err.label}: ${err.message}` : dl ? `${dl.label} · ${dl.message}` : "Starting…";
    const avg = steps.reduce((n, s) => n + (s.status === "ok" ? 1 : (s.progress || 0)), 0) / steps.length;
    $("#provision-bar i").style.width = (avg * 100).toFixed(1) + "%";
  }
  $("#sys-dot").className = "dot" + (err ? " bad" : pending.length ? " warn" : "");
  $("#sys-text").textContent = err ? "Attention required" : pending.length ? "Provisioning" : "All systems operational";
  $("#sys-ver").textContent = `v${a.version} · Local deployment`;
  $("#chip-llm").textContent = `${a.llm} · ${st.ready ? "ready" : "provisioning"}`;
}
$("#retry-setup").onclick = () => api("/api/setup/retry", {method: "POST"});
$("#btn-exports").onclick = async () => { const r = await api("/api/reveal-exports", {method: "POST"}); if (!navigator.platform.startsWith("Mac")) toast(r.path); };

/* ---------------- polling ---------------- */
async function poll() {
  try {
    const st = await api("/api/state");
    jobs = st.jobs;
    renderSystem(st); renderOrders(); renderInventory();
  } catch {
    $("#sys-dot").className = "dot bad"; $("#sys-text").textContent = "Engine offline";
  }
}
setInterval(poll, 1000);
poll(); renderRecent(); route();
