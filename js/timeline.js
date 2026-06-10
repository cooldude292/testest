/* ─── Lumen timeline panel ─────────────────────────────────────── */
"use strict";

/* Shared drag helper */
function startDrag(e, { move, up, cursor }) {
  e.preventDefault();
  const startX = e.clientX, startY = e.clientY;
  const prevCursor = document.body.style.cursor;
  if (cursor) document.body.style.cursor = cursor;
  const onMove = ev => move && move(ev, ev.clientX - startX, ev.clientY - startY);
  const onUp = ev => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    document.body.style.cursor = prevCursor;
    up && up(ev, ev.clientX - startX, ev.clientY - startY);
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

/* Shared context menu */
function showMenu(x, y, items) {
  document.querySelectorAll(".ctx-menu").forEach(m => m.remove());
  const menu = document.createElement("div");
  menu.className = "ctx-menu";
  items.forEach(it => {
    if (it === "-") {
      const sep = document.createElement("div");
      sep.className = "ctx-sep";
      menu.appendChild(sep);
      return;
    }
    const el = document.createElement("div");
    el.className = "ctx-item" + (it.danger ? " danger" : "");
    el.innerHTML = `<span>${it.label}</span>${it.checked ? '<span class="check">✓</span>' : ""}`;
    el.addEventListener("click", () => { menu.remove(); it.run(); });
    menu.appendChild(el);
  });
  menu.style.left = x + "px";
  menu.style.top = y + "px";
  document.body.appendChild(menu);
  const r = menu.getBoundingClientRect();
  if (r.right > innerWidth - 8) menu.style.left = (innerWidth - r.width - 8) + "px";
  if (r.bottom > innerHeight - 8) menu.style.top = (y - r.height) + "px";
  const dismiss = ev => { if (!menu.contains(ev.target)) { menu.remove(); cleanup(); } };
  const onKey = ev => { if (ev.key === "Escape") { menu.remove(); cleanup(); } };
  const cleanup = () => { window.removeEventListener("pointerdown", dismiss, true); window.removeEventListener("keydown", onKey); };
  setTimeout(() => {
    window.addEventListener("pointerdown", dismiss, true);
    window.addEventListener("keydown", onKey);
  }, 0);
}

/* Toast notifications */
function toast(msg) {
  let el = document.getElementById("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove("show"), 2200);
}

const ICONS = {
  caret: '<svg viewBox="0 0 16 16"><path d="m5.5 3 6 5-6 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  eye: '<svg viewBox="0 0 16 16"><path d="M1.8 8s2.3-4.2 6.2-4.2S14.2 8 14.2 8 11.9 12.2 8 12.2 1.8 8 1.8 8Z" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="8" cy="8" r="2" fill="currentColor"/></svg>',
  lock: '<svg viewBox="0 0 16 16"><rect x="3.5" y="7" width="9" height="6.5" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>',
  stopwatch: '<svg viewBox="0 0 16 16"><circle cx="8" cy="9" r="5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 6.5V9l1.8 1.2M6.5 1.8h3M8 1.8v2" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round"/></svg>',
};

const Timeline = (() => {
  let pps = 60;            // pixels per second
  const ROW_LAYER = 30, ROW_PROP = 24;
  let elLeft, elRight, elContent, elRuler, elTracks, elPlayhead, elZoom;
  let renderedBars = [], renderedKeys = [];

  function trackWidth() {
    return Math.max(elRight.clientWidth, App.comp.duration * pps + 220);
  }
  const xToT = x => clamp(snapT(x / pps), 0, App.comp.duration);

  /* ── ruler ── */
  function drawRuler() {
    const w = trackWidth();
    const dpr = window.devicePixelRatio || 1;
    elRuler.width = w * dpr;
    elRuler.height = 28 * dpr;
    elRuler.style.width = w + "px";
    elRuler.style.height = "28px";
    const ctx = elRuler.getContext("2d");
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, 28);

    const candidates = [0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120];
    let step = candidates.find(s => s * pps >= 64) || 120;
    ctx.font = "10px " + getComputedStyle(document.body).getPropertyValue("--mono");
    ctx.fillStyle = "#5e636e";
    ctx.strokeStyle = "#26282d";
    ctx.lineWidth = 1;

    const minor = step / 5;
    ctx.beginPath();
    for (let t = 0; t <= App.comp.duration + 1e-6; t += minor) {
      const x = Math.round(t * pps) + 0.5;
      const isMajor = Math.abs(t / step - Math.round(t / step)) < 1e-6;
      ctx.moveTo(x, isMajor ? 13 : 21);
      ctx.lineTo(x, 28);
      if (isMajor) {
        const s = Math.round(t * 100) / 100;
        const label = s >= 60 ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}` : `${s}s`;
        ctx.fillText(label, x + 4, 11);
      }
    }
    ctx.stroke();
    // end-of-comp shade
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.fillRect(App.comp.duration * pps, 0, w - App.comp.duration * pps, 28);
  }

  /* ── left rows ── */
  function makeToggle(icon, on, title, cb, accentWhenOn) {
    const b = document.createElement("button");
    b.className = "tl-toggle" + (on ? (accentWhenOn ? " on-accent" : "") : " off");
    b.title = title;
    b.innerHTML = ICONS[icon];
    b.addEventListener("click", e => { e.stopPropagation(); cb(); });
    return b;
  }

  function leftLayerRow(layer) {
    const row = document.createElement("div");
    row.className = "tl-row layer" + (App.selection === layer.id ? " selected" : "");
    row.dataset.id = layer.id;

    const caret = document.createElement("button");
    caret.className = "tl-caret" + (App.expanded.has(layer.id) ? " open" : "");
    caret.innerHTML = ICONS.caret;
    caret.title = "Show animated properties";
    caret.addEventListener("click", e => {
      e.stopPropagation();
      App.expanded.has(layer.id) ? App.expanded.delete(layer.id) : App.expanded.add(layer.id);
      renderAll();
    });

    const chip = document.createElement("span");
    chip.className = "layer-chip";
    chip.style.background = LAYER_COLORS[layer.type] || "#888";

    const name = document.createElement("span");
    name.className = "tl-name";
    name.textContent = layer.name;
    name.addEventListener("dblclick", e => {
      e.stopPropagation();
      const input = document.createElement("input");
      input.type = "text";
      input.className = "tl-name-input";
      input.value = layer.name;
      name.replaceWith(input);
      input.focus(); input.select();
      const finish = save => {
        if (save && input.value.trim()) { App.commit(); layer.name = input.value.trim(); }
        App.emit("project");
      };
      input.addEventListener("keydown", ev => {
        if (ev.key === "Enter") finish(true);
        if (ev.key === "Escape") finish(false);
        ev.stopPropagation();
      });
      input.addEventListener("blur", () => finish(true));
    });

    row.append(caret, chip, name,
      makeToggle("eye", layer.visible, "Toggle visibility", () => { App.commit(); layer.visible = !layer.visible; App.emit("project"); }),
      makeToggle("lock", layer.locked, "Toggle lock", () => { App.commit(); layer.locked = !layer.locked; App.emit("project"); }, true),
    );

    row.addEventListener("pointerdown", e => {
      if (e.button !== 0) return;
      App.select(layer.id);
      beginReorder(e, layer, row);
    });
    row.addEventListener("contextmenu", e => {
      e.preventDefault();
      App.select(layer.id);
      showMenu(e.clientX, e.clientY, [
        { label: "Duplicate", run: () => { App.commit(); Layers.duplicate(layer.id); } },
        { label: "Split at playhead", run: () => { App.commit(); Layers.split(layer.id, snapT(App.time)); } },
        "-",
        { label: "Delete layer", danger: true, run: () => { App.commit(); Layers.remove(layer.id); } },
      ]);
    });
    return row;
  }

  function beginReorder(e, layer, row) {
    const startIdx = App.layers.indexOf(layer);
    let moved = false, targetIdx = startIdx;
    startDrag(e, {
      move(ev, dx, dy) {
        if (!moved && Math.abs(dy) < 6) return;
        moved = true;
        row.style.opacity = "0.4";
        const rows = [...elLeft.querySelectorAll(".tl-row.layer")];
        targetIdx = startIdx;
        for (let i = 0; i < rows.length; i++) {
          const r = rows[i].getBoundingClientRect();
          if (ev.clientY > r.top + r.height / 2) targetIdx = i + (i >= startIdx ? 0 : 1);
        }
        if (ev.clientY < rows[0]?.getBoundingClientRect().top) targetIdx = 0;
        targetIdx = clamp(targetIdx, 0, App.layers.length - 1);
        rows.forEach((r, i) => r.style.boxShadow = "");
        const t = rows[targetIdx];
        if (t && targetIdx !== startIdx) t.style.boxShadow = "0 -2px 0 var(--accent-bright) inset";
      },
      up() {
        row.style.opacity = "";
        if (moved && targetIdx !== startIdx) {
          App.commit();
          Layers.move(layer.id, targetIdx);
        } else if (moved) {
          renderAll();
        }
      },
    });
  }

  function leftPropRow(layer, prop) {
    const row = document.createElement("div");
    row.className = "tl-row prop";
    const p = layer.props[prop];

    const sw = document.createElement("button");
    sw.className = "stopwatch" + (p.anim ? " on" : "");
    sw.title = "Toggle animation";
    sw.innerHTML = ICONS.stopwatch;
    sw.style.marginLeft = "20px";
    sw.addEventListener("click", e => { e.stopPropagation(); App.commit(); Layers.toggleAnim(layer, prop); });

    const name = document.createElement("span");
    name.className = "tl-prop-name";
    name.style.paddingLeft = "8px";
    name.textContent = PROP_LABELS[prop];

    const nav = document.createElement("span");
    nav.className = "keynav";
    const mk = (txt, title, cb) => {
      const b = document.createElement("button");
      b.textContent = txt; b.title = title;
      b.addEventListener("click", e => { e.stopPropagation(); cb(b); });
      return b;
    };
    const prevB = mk("◀", "Previous keyframe", () => {
      const ks = p.keys.filter(k => k.t < App.time - 1e-6);
      if (ks.length) App.setTime(ks[ks.length - 1].t);
    });
    const togB = mk("◆", "Add / remove keyframe", () => {
      App.commit();
      if (Layers.hasKeyAt(layer, prop, App.time)) Layers.removeKeyAt(layer, prop, snapT(App.time));
      else {
        if (!p.anim) { p.anim = true; }
        Layers.upsertKey(layer, prop, App.time);
      }
      App.emit("project");
    });
    togB.classList.add("key-toggle");
    if (Layers.hasKeyAt(layer, prop, App.time)) togB.classList.add("has-key");
    const nextB = mk("▶", "Next keyframe", () => {
      const k = p.keys.find(k => k.t > App.time + 1e-6);
      if (k) App.setTime(k.t);
    });
    nav.append(prevB, togB, nextB);

    row.append(sw, name, nav);
    return row;
  }

  /* ── right rows ── */
  function trackLayerRow(layer) {
    const row = document.createElement("div");
    row.className = "tl-row layer";

    const bar = document.createElement("div");
    bar.className = "tl-bar" + (App.selection === layer.id ? " selected" : "");
    const [bg, bd] = LAYER_BAR[layer.type] || LAYER_BAR.null;
    bar.style.setProperty("--bar-bg", bg);
    bar.style.setProperty("--bar-border", bd);
    positionBar(bar, layer);

    const label = document.createElement("span");
    label.className = "tl-bar-label";
    label.textContent = layer.name;
    const hl = document.createElement("div"); hl.className = "bar-handle l";
    const hr = document.createElement("div"); hr.className = "bar-handle r";
    bar.append(label, hl, hr);

    const dragBar = (e, mode) => {
      if (layer.locked) return;
      e.stopPropagation();
      App.select(layer.id);
      App.commit();
      const in0 = layer.inPoint, out0 = layer.outPoint;
      startDrag(e, {
        cursor: mode === "move" ? "grabbing" : "ew-resize",
        move(ev, dx) {
          const dt = dx / pps;
          if (mode === "move") {
            const len = out0 - in0;
            let ni = snapT(clamp(in0 + dt, 0, App.comp.duration - len));
            layer.inPoint = ni;
            layer.outPoint = ni + len;
          } else if (mode === "l") {
            layer.inPoint = snapT(clamp(in0 + dt, 0, out0 - 1 / App.comp.fps));
          } else {
            layer.outPoint = snapT(clamp(out0 + dt, in0 + 1 / App.comp.fps, App.comp.duration));
          }
          positionBar(bar, layer);
          App.emit("props");
        },
        up() { App.emit("project"); },
      });
    };
    bar.addEventListener("pointerdown", e => { if (e.button === 0) dragBar(e, "move"); });
    hl.addEventListener("pointerdown", e => { if (e.button === 0) dragBar(e, "l"); });
    hr.addEventListener("pointerdown", e => { if (e.button === 0) dragBar(e, "r"); });

    row.appendChild(bar);
    renderedBars.push({ el: bar, layer });
    return row;
  }

  function positionBar(bar, layer) {
    bar.style.left = layer.inPoint * pps + "px";
    bar.style.width = Math.max(4, (layer.outPoint - layer.inPoint) * pps) + "px";
  }

  function trackPropRow(layer, prop) {
    const row = document.createElement("div");
    row.className = "tl-row prop";
    const p = layer.props[prop];

    row.addEventListener("dblclick", e => {
      const cx = e.clientX - elContent.getBoundingClientRect().left;
      App.commit();
      if (!p.anim) p.anim = true;
      Layers.upsertKey(layer, prop, xToT(cx));
      App.emit("project");
    });

    if (p.anim) {
      p.keys.forEach((k, idx) => {
        const d = document.createElement("div");
        d.className = "keyframe";
        const sel = App.selectedKey;
        if (sel && sel.layerId === layer.id && sel.prop === prop && sel.index === idx) d.classList.add("selected");
        d.style.left = k.t * pps + "px";
        d.title = `${PROP_LABELS[prop]} @ ${timecode(k.t)} · ${EASE_LABELS[k.ease] || "Linear"}`;

        d.addEventListener("pointerdown", e => {
          if (e.button !== 0) return;
          e.stopPropagation();
          App.selectedKey = { layerId: layer.id, prop, index: idx };
          App.select(layer.id);
          App.commit();
          const t0 = k.t;
          let movedAny = false;
          startDrag(e, {
            move(ev, dx) {
              movedAny = true;
              k.t = xToT(t0 * pps + dx);
              d.style.left = k.t * pps + "px";
              App.emit("props");
            },
            up() {
              p.keys.sort((a, b) => a.t - b.t);
              App.emit("project");
            },
          });
        });

        d.addEventListener("contextmenu", e => {
          e.preventDefault();
          e.stopPropagation();
          const items = Object.keys(EASE_LABELS).map(ease => ({
            label: EASE_LABELS[ease],
            checked: k.ease === ease,
            run: () => { App.commit(); k.ease = ease; App.emit("project"); },
          }));
          items.push("-", {
            label: "Delete keyframe", danger: true,
            run: () => { App.commit(); p.keys.splice(p.keys.indexOf(k), 1); if (!p.keys.length) { p.anim = false; } App.emit("project"); },
          });
          showMenu(e.clientX, e.clientY, items);
        });

        row.appendChild(d);
        renderedKeys.push({ el: d, key: k });
      });
    }
    return row;
  }

  /* ── render ── */
  function renderAll() {
    renderedBars = []; renderedKeys = [];
    const leftScroll = document.getElementById("tl-left-scroll");
    leftScroll.innerHTML = "";
    elTracks.innerHTML = "";

    const w = trackWidth();
    elContent.style.width = w + "px";

    App.layers.forEach(layer => {
      leftScroll.appendChild(leftLayerRow(layer));
      elTracks.appendChild(trackLayerRow(layer));
      if (App.expanded.has(layer.id)) {
        PROP_ORDER.forEach(prop => {
          leftScroll.appendChild(leftPropRow(layer, prop));
          elTracks.appendChild(trackPropRow(layer, prop));
        });
      }
    });

    if (App.layers.length === 0) {
      const hint = document.createElement("div");
      hint.className = "empty-hint";
      hint.style.padding = "22px";
      hint.innerHTML = "No layers yet — add one from the Project panel<br>or press ⌘K";
      leftScroll.appendChild(hint);
    }

    document.getElementById("tl-comp-name").textContent =
      `${App.comp.width}×${App.comp.height} · ${App.comp.fps}fps · ${App.comp.duration}s`;

    drawRuler();
    updatePlayhead();
  }

  /* lightweight refresh during drags */
  function refreshPositions() {
    renderedBars.forEach(({ el, layer }) => positionBar(el, layer));
    renderedKeys.forEach(({ el, key }) => { el.style.left = key.t * pps + "px"; });
  }

  function updatePlayhead() {
    const x = App.time * pps;
    elPlayhead.style.left = x + "px";
    if (App.playing) {
      const vis = elRight.scrollLeft;
      const vw = elRight.clientWidth;
      if (x < vis || x > vis + vw - 20) elRight.scrollLeft = Math.max(0, x - 40);
    }
  }

  function setPps(v, keepCenter = true) {
    const oldPps = pps;
    const center = (elRight.scrollLeft + elRight.clientWidth / 2) / oldPps;
    pps = clamp(v, 8, 600);
    elZoom.value = pps;
    renderAll();
    if (keepCenter) {
      elRight.scrollLeft = Math.max(0, center * pps - elRight.clientWidth / 2);
    }
  }

  function fit() {
    setPps(Math.max(8, (elRight.clientWidth - 60) / App.comp.duration), false);
    elRight.scrollLeft = 0;
  }

  function init() {
    elLeft = document.getElementById("tl-left-scroll");
    elRight = document.getElementById("tl-right");
    elContent = document.getElementById("tl-content");
    elRuler = document.getElementById("tl-ruler");
    elTracks = document.getElementById("tl-tracks");
    elPlayhead = document.getElementById("tl-playhead");
    elZoom = document.getElementById("tl-zoom");

    elZoom.addEventListener("input", () => setPps(+elZoom.value));
    document.getElementById("tl-fit").addEventListener("click", fit);

    elRight.addEventListener("scroll", () => {
      document.getElementById("tl-left-scroll").scrollTop = elRight.scrollTop;
    });

    // scrub on ruler
    elRuler.addEventListener("pointerdown", e => {
      const setFromEvent = ev => {
        const x = ev.clientX - elContent.getBoundingClientRect().left;
        App.setTime(xToT(x));
      };
      setFromEvent(e);
      startDrag(e, { move: setFromEvent, cursor: "ew-resize" });
    });

    // deselect on empty track click
    elTracks.addEventListener("pointerdown", e => {
      if (e.target === elTracks || e.target.classList.contains("tl-row")) App.select(null);
    });

    // zoom with ctrl+wheel on tracks
    elRight.addEventListener("wheel", e => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const mx = e.clientX - elContent.getBoundingClientRect().left;
      const tAtMouse = mx / pps;
      const np = clamp(pps * (e.deltaY < 0 ? 1.15 : 0.87), 8, 600);
      pps = np;
      elZoom.value = pps;
      renderAll();
      elRight.scrollLeft = Math.max(0, tAtMouse * pps - (e.clientX - elRight.getBoundingClientRect().left));
    }, { passive: false });

    new ResizeObserver(() => drawRuler()).observe(elRight);

    App.on("project", renderAll);
    App.on("selection", renderAll);
    App.on("props", refreshPositions);
    App.on("time", updatePlayhead);
  }

  return { init, renderAll, updatePlayhead, fit, get pps() { return pps; } };
})();
