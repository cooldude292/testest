/* ─── Lumen app shell: playback, shortcuts, palette, export ────── */
"use strict";

/* ── playback ── */
const Playback = (() => {
  let lastTs = null;

  function loop(ts) {
    if (App.playing) {
      if (lastTs !== null) {
        let t = App.time + (ts - lastTs) / 1000;
        if (t >= App.comp.duration) t = 0; // loop
        App.setTime(t, { playback: true });
      }
      lastTs = ts;
    } else {
      lastTs = null;
    }
    requestAnimationFrame(loop);
  }

  function toggle() {
    App.setPlaying(!App.playing);
    if (!App.playing) Renderer.pauseAllVideos();
  }

  function step(frames) {
    App.setPlaying(false);
    Renderer.pauseAllVideos();
    const fps = App.comp.fps;
    App.setTime(clamp(snapT(Math.round(App.time * fps + frames) / fps), 0, App.comp.duration));
  }

  requestAnimationFrame(loop);
  return { toggle, step };
})();

/* ── export ── */
const Exporter = (() => {
  let recording = false, recorder = null;

  function open() {
    document.getElementById("export-overlay").hidden = false;
    document.getElementById("export-progress").hidden = true;
    document.getElementById("export-start").disabled = false;
  }
  function close() {
    if (recording) stop(true);
    document.getElementById("export-overlay").hidden = true;
  }

  function exportPNG() {
    const c = App.comp;
    const cv = document.createElement("canvas");
    cv.width = c.width; cv.height = c.height;
    Renderer.draw(cv.getContext("2d"), App.time);
    cv.toBlob(blob => {
      download(blob, `${App.project.name.replace(/\s+/g, "-")}-${timecode(App.time).replace(/:/g, ".")}.png`);
      toast("Frame exported");
      close();
    }, "image/png");
  }

  function exportWebM() {
    if (typeof MediaRecorder === "undefined") {
      toast("MediaRecorder not supported in this browser");
      return;
    }
    const c = App.comp;
    const cv = document.createElement("canvas");
    cv.width = c.width; cv.height = c.height;
    const cctx = cv.getContext("2d");
    const stream = cv.captureStream(c.fps);
    const mime = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"]
      .find(m => MediaRecorder.isTypeSupported(m)) || "video/webm";
    const chunks = [];
    recorder = new MediaRecorder(stream, {
      mimeType: mime,
      videoBitsPerSecond: parseInt(document.getElementById("export-quality").value, 10),
    });
    recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    recorder.onstop = () => {
      if (!recording) return; // cancelled
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
    const dur = c.duration;
    const t0 = performance.now();
    recorder.start(200);

    (function frame() {
      if (!recording) return;
      const t = (performance.now() - t0) / 1000;
      if (t >= dur) {
        Renderer.draw(cctx, dur);
        label.textContent = "Encoding…";
        fill.style.width = "100%";
        recorder.stop();
        return;
      }
      Renderer.draw(cctx, t);
      App.setTime(t, { playback: true }); // live preview while rendering
      fill.style.width = (t / dur) * 100 + "%";
      label.textContent = `Rendering… ${timecode(t)} / ${timecode(dur)}`;
      requestAnimationFrame(frame);
    })();
  }

  function stop(cancelled) {
    recording = false;
    if (recorder && recorder.state !== "inactive") recorder.stop();
    recorder = null;
    if (cancelled) toast("Export cancelled");
  }

  function start() {
    const fmt = document.getElementById("export-format").value;
    fmt === "png" ? exportPNG() : exportWebM();
  }

  function download(blob, name) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  return { open, close, start, download };
})();

/* ── command palette ── */
const Palette = (() => {
  let items = [], active = 0, filtered = [];

  function actions() {
    const sel = App.selectedLayer();
    return [
      { title: "New text layer", hint: "", run: () => { App.commit(); Layers.add(makeLayer("text")); } },
      { title: "New solid layer", run: () => { App.commit(); Layers.add(makeLayer("solid")); } },
      { title: "New shape layer", run: () => { App.commit(); Layers.add(makeLayer("shape")); } },
      { title: "New adjustment layer", run: () => { App.commit(); Layers.add(makeLayer("null")); } },
      { title: "Import media…", run: () => document.getElementById("file-import").click() },
      { title: "Play / Pause", hint: "Space", run: () => Playback.toggle() },
      { title: "Go to start", hint: "Home", run: () => App.setTime(0) },
      { title: "Go to end", hint: "End", run: () => App.setTime(App.comp.duration) },
      sel && { title: `Duplicate "${sel.name}"`, hint: "⌘D", run: () => { App.commit(); Layers.duplicate(sel.id); } },
      sel && { title: `Split "${sel.name}" at playhead`, run: () => { App.commit(); Layers.split(sel.id, snapT(App.time)); } },
      sel && { title: `Delete "${sel.name}"`, hint: "⌫", run: () => { App.commit(); Layers.remove(sel.id); } },
      { title: "Fit viewport", run: () => Viewport.fit() },
      { title: "Fit timeline", run: () => Timeline.fit() },
      { title: "Undo", hint: "⌘Z", run: () => History.undo() },
      { title: "Redo", hint: "⇧⌘Z", run: () => History.redo() },
      { title: "Export video…", hint: "", run: () => Exporter.open() },
      { title: "Save project", hint: "⌘S", run: saveProject },
      { title: "Open project…", hint: "⌘O", run: () => document.getElementById("file-open").click() },
      { title: "New project", run: newProject },
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
  }
  function isOpen() {
    return !document.getElementById("palette-overlay").hidden;
  }

  function render(q) {
    const list = document.getElementById("palette-list");
    const needle = q.trim().toLowerCase();
    filtered = needle
      ? items.filter(it => it.title.toLowerCase().includes(needle))
      : items;
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

/* ── save / open ── */
function saveProject() {
  const blob = new Blob([serializeProject()], { type: "application/json" });
  Exporter.download(blob, App.project.name.replace(/\s+/g, "-") + ".lumen");
  toast("Project saved");
}

function newProject() {
  App.project = defaultProject();
  App.time = 0; App.selection = null; App.expanded = new Set();
  History.stack = []; History.index = -1;
  document.getElementById("project-name").value = App.project.name;
  App.emit("project");
  App.emit("selection");
  App.emit("time", {});
  Viewport.fit();
  Timeline.fit();
}

/* ── demo composition ── */
function buildDemo() {
  const c = App.comp;
  const cx = c.width / 2, cy = c.height / 2;

  const glow = makeLayer("shape", { name: "Glow" });
  glow.data = { shape: "ellipse", w: 700, h: 700, fill: "#5e6ad2", stroke: "", strokeWidth: 0, radius: 0, points: 5, inset: 0.5 };
  glow.props.opacity.value = 38;
  glow.blend = "screen";
  glow.effects = [{ id: uid(), type: "blur", enabled: true, params: { amount: 90 } }];
  glow.props.position.anim = true;
  glow.props.position.keys = [
    { t: 0, v: [cx - 240, cy + 60], ease: "easeInOut" },
    { t: 5, v: [cx + 240, cy - 40], ease: "easeInOut" },
    { t: 10, v: [cx - 240, cy + 60], ease: "easeInOut" },
  ];

  const star = makeLayer("shape", { name: "Star" });
  star.data = { shape: "star", w: 110, h: 110, fill: "", stroke: "#7c89f0", strokeWidth: 5, radius: 0, points: 5, inset: 0.48 };
  star.props.position.value = [c.width - 170, 140];
  star.props.opacity.value = 70;
  star.props.rotation.anim = true;
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
  sub.data = { ...sub.data, text: "Motion design, in your browser", size: 30, weight: "400", color: "#8a8f98" };
  sub.props.position.anim = true;
  sub.props.position.keys = [
    { t: 0.4, v: [cx, cy + 92], ease: "easeOut" },
    { t: 1.4, v: [cx, cy + 64], ease: "linear" },
  ];
  sub.props.opacity.anim = true;
  sub.props.opacity.keys = [
    { t: 0.4, v: 0, ease: "easeOut" },
    { t: 1.4, v: 100, ease: "linear" },
  ];

  const rule = makeLayer("solid", { name: "Rule" });
  rule.data = { color: "#5e6ad2", w: 1, h: 3 };
  rule.props.position.value = [cx, cy + 118];
  rule.props.scale.anim = true;
  rule.props.scale.keys = [
    { t: 0.9, v: [0, 100], ease: "easeInOut" },
    { t: 2.0, v: [22000, 100], ease: "linear" },
  ];

  App.project.layers = [title, sub, rule, star, glow];
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

  /* top bar */
  const nameInput = document.getElementById("project-name");
  nameInput.value = App.project.name;
  nameInput.addEventListener("change", () => { App.project.name = nameInput.value || "Untitled Project"; });
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
    document.getElementById("export-quality-row").style.display = e.target.value === "png" ? "none" : "";
  });

  /* events → UI */
  App.on("time", () => {
    document.getElementById("timecode").textContent = timecode(App.time);
  });
  App.on("playback", () => {
    document.getElementById("ic-play").style.display = App.playing ? "none" : "";
    document.getElementById("ic-pause").style.display = App.playing ? "" : "none";
  });

  /* keyboard */
  window.addEventListener("keydown", e => {
    const tag = (e.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return;
    const mod = e.metaKey || e.ctrlKey;

    if (mod && e.key.toLowerCase() === "k") { e.preventDefault(); Palette.isOpen() ? Palette.close() : Palette.open(); return; }
    if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? History.redo() : History.undo(); return; }
    if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); saveProject(); return; }
    if (mod && e.key.toLowerCase() === "o") { e.preventDefault(); document.getElementById("file-open").click(); return; }
    if (mod && e.key.toLowerCase() === "d") {
      e.preventDefault();
      const sel = App.selectedLayer();
      if (sel) { App.commit(); Layers.duplicate(sel.id); }
      return;
    }

    switch (e.key) {
      case " ":
        e.preventDefault();
        Playback.toggle();
        break;
      case "ArrowLeft": e.preventDefault(); Playback.step(e.shiftKey ? -10 : -1); break;
      case "ArrowRight": e.preventDefault(); Playback.step(e.shiftKey ? 10 : 1); break;
      case "Home": e.preventDefault(); App.setTime(0); break;
      case "End": e.preventDefault(); App.setTime(App.comp.duration); break;
      case "Delete": case "Backspace": {
        const sel = App.selectedLayer();
        if (sel) { App.commit(); Layers.remove(sel.id); }
        break;
      }
      case "Escape":
        if (Palette.isOpen()) Palette.close();
        else if (!document.getElementById("export-overlay").hidden) Exporter.close();
        else App.select(null);
        break;
    }
  });

  App.emit("project");
  App.emit("selection");
  App.emit("time", {});
  Viewport.fit();
  Timeline.fit();
}

window.addEventListener("DOMContentLoaded", initApp);
