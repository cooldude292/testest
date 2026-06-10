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
  if (r.bottom > innerHeight - 8) menu.style.top = Math.max(8, y - r.height) + "px";
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
  solo: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="4.5" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="8" cy="8" r="1.6" fill="currentColor"/></svg>',
  shy: '<svg viewBox="0 0 16 16"><path d="M2 10c1.5-3.5 4-5 6-5s4.5 1.5 6 5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><circle cx="8" cy="10.5" r="1.5" fill="currentColor"/></svg>',
  graph: '<svg viewBox="0 0 16 16"><path d="M2 13c3 0 3-9 6-9 2.5 0 2.5 7 6 7" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
};

const Timeline = (() => {
  let pps = 60;            // pixels per second
  let elLeft, elRight, elContent, elRuler, elTracks, elPlayhead, elZoom;
  let renderedBars = [], renderedKeys = [];
  let searchQuery = "";

  function trackWidth() {
    return Math.max(elRight.clientWidth, App.comp.duration * pps + 220);
  }
  const xToT = x => clamp(snapT(x / pps), 0, App.comp.duration);

  /* ── ruler: ticks + work area + markers ── */
  function drawRuler() {
    const w = trackWidth();
    const dpr = window.devicePixelRatio || 1;
    elRuler.width = w * dpr;
    elRuler.height = 34 * dpr;
    elRuler.style.width = w + "px";
    elRuler.style.height = "34px";
    const ctx = elRuler.getContext("2d");
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, 34);
    const c = App.comp;

    // work area band
    ctx.fillStyle = "rgba(255,255,255,0.045)";
    ctx.fillRect(0, 0, w, 7);
    ctx.fillStyle = "rgba(124,137,240,0.35)";
    ctx.fillRect(c.workStart * pps, 0, Math.max(2, (c.workEnd - c.workStart) * pps), 7);
    ctx.fillStyle = "#7c89f0";
    ctx.fillRect(c.workStart * pps - 1, 0, 3, 7);
    ctx.fillRect(c.workEnd * pps - 1, 0, 3, 7);

    const candidates = [0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120];
    let step = candidates.find(s => s * pps >= 64) || 120;
    ctx.font = "10px " + getComputedStyle(document.body).getPropertyValue("--mono");
    ctx.fillStyle = "#5e636e";
    ctx.strokeStyle = "#26282d";
    ctx.lineWidth = 1;
    const minor = step / 5;
    ctx.beginPath();
    for (let t = 0; t <= c.duration + 1e-6; t += minor) {
      const x = Math.round(t * pps) + 0.5;
      const isMajor = Math.abs(t / step - Math.round(t / step)) < 1e-6;
      ctx.moveTo(x, isMajor ? 19 : 27);
      ctx.lineTo(x, 34);
      if (isMajor) {
        const s = Math.round(t * 100) / 100;
        const label = s >= 60 ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}` : `${s}s`;
        ctx.fillText(label, x + 4, 16);
      }
    }
    ctx.stroke();
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.fillRect(c.duration * pps, 0, w - c.duration * pps, 34);

    // markers
    (c.markers || []).forEach(m => {
      const x = m.t * pps;
      ctx.fillStyle = "#4cb782";
      ctx.beginPath();
      ctx.moveTo(x - 4, 22); ctx.lineTo(x + 4, 22); ctx.lineTo(x + 4, 29); ctx.lineTo(x, 33); ctx.lineTo(x - 4, 29);
      ctx.closePath();
      ctx.fill();
      if (m.label) {
        ctx.fillStyle = "#8a8f98";
        ctx.font = "9px " + getComputedStyle(document.body).getPropertyValue("--font");
        ctx.fillText(m.label, x + 7, 31);
      }
    });
  }

  function markerAt(x) {
    return (App.comp.markers || []).find(m => Math.abs(m.t * pps - x) < 6) || null;
  }

  function rulerPointerDown(e) {
    const rect = elContent.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - elRuler.getBoundingClientRect().top;
    const c = App.comp;

    if (y <= 8) { // work area
      const nearStart = Math.abs(x - c.workStart * pps) < 7;
      const nearEnd = Math.abs(x - c.workEnd * pps) < 7;
      const inside = x > c.workStart * pps && x < c.workEnd * pps;
      if (nearStart || nearEnd || inside) {
        App.commit();
        const ws0 = c.workStart, we0 = c.workEnd;
        startDrag(e, {
          cursor: "ew-resize",
          move(ev, dx) {
            const dt = dx / pps;
            if (nearStart) c.workStart = clamp(snapT(ws0 + dt), 0, c.workEnd - 0.1);
            else if (nearEnd) c.workEnd = clamp(snapT(we0 + dt), c.workStart + 0.1, c.duration);
            else {
              const len = we0 - ws0;
              c.workStart = clamp(snapT(ws0 + dt), 0, c.duration - len);
              c.workEnd = c.workStart + len;
            }
            drawRuler();
          },
          up() { App.emit("props"); },
        });
        return;
      }
    }

    const mk = markerAt(x);
    if (mk && y > 18) {
      if (e.button === 2) return;
      App.commit();
      const t0 = mk.t;
      startDrag(e, {
        cursor: "ew-resize",
        move(ev, dx) { mk.t = xToT(t0 * pps + dx); drawRuler(); },
        up() { App.emit("props"); },
      });
      return;
    }

    const setFromEvent = ev => {
      const xx = ev.clientX - elContent.getBoundingClientRect().left;
      App.setTime(xToT(xx));
    };
    setFromEvent(e);
    startDrag(e, { move: setFromEvent, cursor: "ew-resize" });
  }

  /* ── row model ── */
  function visibleLayers() {
    return App.layers.filter(l => {
      if (App.shyHidden && l.shy) return false;
      if (searchQuery && !l.name.toLowerCase().includes(searchQuery)) return false;
      return true;
    });
  }

  function rowsForLayer(layer) {
    const rows = [{ kind: "layer", layer }];
    if (App.expanded.has(layer.id)) {
      PROP_ORDER.forEach(name => rows.push({ kind: "prop", layer, p: layer.props[name], label: PROP_LABELS[name] }));
      layer.effects.forEach(fx => {
        const def = EFFECTS[fx.type];
        if (!def) return;
        rows.push({ kind: "fxhead", layer, fx, label: def.label });
        def.params.forEach(pd => rows.push({ kind: "prop", layer, p: fx.params[pd.key], label: pd.label, fx }));
      });
    }
    return rows;
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
    row.className = "tl-row layer" + (App.isSelected(layer.id) ? " selected" : "");
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

    const chip = document.createElement("button");
    chip.className = "layer-chip btnchip";
    chip.style.background = layer.label || LAYER_COLORS[layer.type];
    chip.title = "Label color";
    chip.addEventListener("click", e => {
      e.stopPropagation();
      showMenu(e.clientX, e.clientY, LABEL_COLORS.map(col => ({
        label: `<span style="display:inline-block;width:10px;height:10px;border-radius:3px;background:${col};margin-right:6px;vertical-align:-1px"></span>${col}`,
        checked: layer.label === col,
        run: () => { App.commit(); layer.label = col; App.emit("project"); },
      })));
    });

    const name = document.createElement("span");
    name.className = "tl-name";
    name.textContent = layer.name;
    if (layer.parent) {
      const p = Layers.find(layer.parent);
      if (p) name.textContent += ` ⌝${p.name}`;
    }
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
      makeToggle("solo", layer.solo, "Solo", () => { App.commit(); layer.solo = !layer.solo; App.emit("project"); }, true),
      makeToggle("shy", layer.shy, "Shy (hide from timeline)", () => { App.commit(); layer.shy = !layer.shy; App.emit("project"); }, true),
      makeToggle("eye", layer.visible, "Toggle visibility", () => { App.commit(); layer.visible = !layer.visible; App.emit("project"); }),
      makeToggle("lock", layer.locked, "Toggle lock", () => { App.commit(); layer.locked = !layer.locked; App.emit("project"); }, true),
    );

    row.addEventListener("pointerdown", e => {
      if (e.button !== 0) return;
      if (e.shiftKey || e.metaKey || e.ctrlKey) { App.select(layer.id, true); return; }
      if (!App.isSelected(layer.id)) App.select(layer.id);
      beginReorder(e, layer, row);
    });
    row.addEventListener("contextmenu", e => {
      e.preventDefault();
      if (!App.isSelected(layer.id)) App.select(layer.id);
      showMenu(e.clientX, e.clientY, [
        { label: "Duplicate", run: () => { App.commit(); Layers.duplicate(layer.id); } },
        { label: "Split at playhead", run: () => { App.commit(); Layers.split(layer.id, snapT(App.time)); } },
        { label: "Precompose…", run: () => { App.commit(); Comps.precompose(); } },
        "-",
        { label: "Copy", run: () => UIClipboard.copyLayers() },
        { label: "Reverse layer time", checked: layer.reverse, run: () => { App.commit(); layer.reverse = !layer.reverse; App.emit("project"); } },
        { label: "Motion blur", checked: layer.motionBlur, run: () => { App.commit(); layer.motionBlur = !layer.motionBlur; App.emit("project"); } },
        "-",
        { label: "Delete layer", danger: true, run: () => { App.commit(); Layers.removeMany(App.selectedIds()); } },
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
        if (rows[0] && ev.clientY < rows[0].getBoundingClientRect().top) targetIdx = 0;
        targetIdx = clamp(targetIdx, 0, App.layers.length - 1);
        rows.forEach(r => r.style.boxShadow = "");
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

  function smallBtn(txt, title, cb, cls) {
    const b = document.createElement("button");
    b.className = "tl-mini" + (cls ? " " + cls : "");
    b.title = title;
    if (txt.startsWith("<svg")) b.innerHTML = txt; else b.textContent = txt;
    b.addEventListener("click", e => { e.stopPropagation(); cb(e, b); });
    return b;
  }

  function leftPropRow(rowDef) {
    const { layer, p, label, fx } = rowDef;
    const row = document.createElement("div");
    row.className = "tl-row prop";

    const sw = document.createElement("button");
    sw.className = "stopwatch" + (p.anim ? " on" : "");
    sw.title = "Toggle animation";
    sw.innerHTML = ICONS.stopwatch;
    sw.style.marginLeft = fx ? "30px" : "20px";
    sw.addEventListener("click", e => { e.stopPropagation(); App.commit(); Layers.toggleAnimObj(p, layer.id); });

    const name = document.createElement("span");
    name.className = "tl-prop-name";
    name.style.paddingLeft = "8px";
    name.textContent = label;
    name.title = "Click to select all keyframes";
    name.addEventListener("click", () => {
      if (!p.anim || !p.keys.length) return;
      App.selectedKeys = p.keys.map(key => ({ p, key }));
      renderAll();
    });

    // loop modifier
    const loopBtn = smallBtn("∞", `Loop: ${p.loop || "none"}`, () => {
      App.commit();
      p.loop = p.loop === "none" ? "cycle" : p.loop === "cycle" ? "pingpong" : "none";
      App.emit("project");
      toast(`Loop: ${p.loop}`);
    }, p.loop && p.loop !== "none" ? "on" : "");

    // wiggle modifier
    const wigBtn = smallBtn("∿", p.wiggle && p.wiggle.on ? `Wiggle ${p.wiggle.freq}Hz ±${p.wiggle.amp}` : "Add wiggle", (e2) => {
      const items = [];
      const setW = (freq, amp) => {
        App.commit();
        if (!p.wseed) p.wseed = Math.floor(Math.random() * 9999) + 1;
        p.wiggle = { on: true, freq, amp };
        App.emit("project");
      };
      [[1, 10], [2, 20], [3, 50], [5, 100], [0.5, 30]].forEach(([f, a]) =>
        items.push({ label: `Wiggle ${f} Hz · ±${a}`, checked: p.wiggle && p.wiggle.on && p.wiggle.freq === f && p.wiggle.amp === a, run: () => setW(f, a) }));
      items.push("-", { label: "Remove wiggle", danger: true, run: () => { App.commit(); p.wiggle = null; App.emit("project"); } });
      showMenu(e2.clientX, e2.clientY, items);
    }, p.wiggle && p.wiggle.on ? "on" : "");

    const graphBtn = smallBtn(ICONS.graph, "Graph editor", () => GraphEditor.open(p, `${layer.name} · ${label}`));

    const nav = document.createElement("span");
    nav.className = "keynav";
    const mk = (txt, title, cb) => {
      const b = document.createElement("button");
      b.textContent = txt; b.title = title;
      b.addEventListener("click", e => { e.stopPropagation(); cb(b); });
      return b;
    };
    nav.append(
      mk("◀", "Previous keyframe", () => {
        const ks = p.keys.filter(k => k.t < App.time - 1e-6);
        if (ks.length) App.setTime(ks[ks.length - 1].t);
      }),
      (() => {
        const b = mk("◆", "Add / remove keyframe", () => {
          App.commit();
          if (Layers.hasKeyAtObj(p, App.time)) Layers.removeKeyAtObj(p, snapT(App.time));
          else {
            if (!p.anim) p.anim = true;
            Layers.upsertKeyObj(p, App.time);
          }
          App.emit("project");
        });
        b.classList.add("key-toggle");
        if (Layers.hasKeyAtObj(p, App.time)) b.classList.add("has-key");
        return b;
      })(),
      mk("▶", "Next keyframe", () => {
        const k = p.keys.find(k => k.t > App.time + 1e-6);
        if (k) App.setTime(k.t);
      }),
    );

    row.append(sw, name, loopBtn, wigBtn, graphBtn, nav);
    return row;
  }

  function leftFxHeadRow(rowDef) {
    const row = document.createElement("div");
    row.className = "tl-row fxhead";
    const name = document.createElement("span");
    name.className = "tl-prop-name fx";
    name.textContent = "ƒx " + rowDef.label;
    row.appendChild(name);
    return row;
  }

  /* ── right rows ── */
  function positionBar(bar, layer) {
    bar.style.left = layer.inPoint * pps + "px";
    bar.style.width = Math.max(4, (layer.outPoint - layer.inPoint) * pps) + "px";
  }

  function drawWaveform(bar, layer) {
    const a = Assets.find(layer.data.assetId);
    if (!a || !a.peaks || !a.el || !a.el.duration) return;
    const w = Math.min(2400, Math.max(8, Math.round((layer.outPoint - layer.inPoint) * pps)));
    const h = 18;
    const cv = document.createElement("canvas");
    cv.width = w; cv.height = h;
    cv.className = "tl-wave";
    const ctx = cv.getContext("2d");
    ctx.fillStyle = "rgba(255,255,255,0.35)";
    const dur = a.el.duration;
    for (let x = 0; x < w; x++) {
      const t = (x / w) * (layer.outPoint - layer.inPoint);
      const mt = mediaTime(layer, layer.inPoint + t);
      const idx = clamp(Math.floor((mt / dur) * a.peaks.length), 0, a.peaks.length - 1);
      const v = a.peaks[idx] * (h / 2 - 1);
      ctx.fillRect(x, h / 2 - v, 1, v * 2 || 1);
    }
    bar.appendChild(cv);
  }

  function trackLayerRow(layer) {
    const row = document.createElement("div");
    row.className = "tl-row layer";

    const bar = document.createElement("div");
    bar.className = "tl-bar" + (App.isSelected(layer.id) ? " selected" : "");
    const [bg, bd] = LAYER_BAR[layer.type] || LAYER_BAR.adjust;
    bar.style.setProperty("--bar-bg", bg);
    bar.style.setProperty("--bar-border", bd);
    positionBar(bar, layer);

    if (layer.type === "audio") drawWaveform(bar, layer);

    const label = document.createElement("span");
    label.className = "tl-bar-label";
    label.textContent = layer.name + (layer.matte !== "none" ? " ⛒" : "") + (layer.stretch !== 100 ? ` ${layer.stretch}%` : "") + (layer.reverse ? " ⏴" : "");
    const hl = document.createElement("div"); hl.className = "bar-handle l";
    const hr = document.createElement("div"); hr.className = "bar-handle r";
    bar.append(label, hl, hr);

    const dragBar = (e, mode) => {
      if (layer.locked) return;
      e.stopPropagation();
      if (!App.isSelected(layer.id)) App.select(layer.id);
      App.commit();
      const group = mode === "move" ? App.selectedLayers().filter(l => !l.locked) : [layer];
      const starts = group.map(l => ({ l, in0: l.inPoint, out0: l.outPoint }));
      startDrag(e, {
        cursor: mode === "move" ? "grabbing" : "ew-resize",
        move(ev, dx) {
          const dt = dx / pps;
          starts.forEach(({ l, in0, out0 }) => {
            if (mode === "move") {
              const len = out0 - in0;
              const ni = snapT(clamp(in0 + dt, 0, App.comp.duration - len));
              l.inPoint = ni;
              l.outPoint = ni + len;
            } else if (mode === "l") {
              l.inPoint = snapT(clamp(in0 + dt, 0, out0 - 1 / App.comp.fps));
            } else {
              l.outPoint = snapT(clamp(out0 + dt, in0 + 1 / App.comp.fps, App.comp.duration));
            }
          });
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

  function keyIsSelected(p, key) {
    return App.selectedKeys.some(s => s.p === p && s.key === key);
  }

  function trackPropRow(rowDef) {
    const { layer, p } = rowDef;
    const row = document.createElement("div");
    row.className = "tl-row prop";

    row.addEventListener("dblclick", e => {
      const cx = e.clientX - elContent.getBoundingClientRect().left;
      App.commit();
      if (!p.anim) p.anim = true;
      Layers.upsertKeyObj(p, xToT(cx));
      App.emit("project");
    });

    if (p.anim) {
      p.keys.forEach(k => {
        const d = document.createElement("div");
        d.className = "keyframe" + (keyIsSelected(p, k) ? " selected" : "");
        d.style.left = k.t * pps + "px";
        d.title = `${rowDef.label} @ ${timecode(k.t)} · ${EASE_LABELS[k.ease] || "Linear"}`;

        d.addEventListener("pointerdown", e => {
          if (e.button !== 0) return;
          e.stopPropagation();
          if (e.shiftKey || e.metaKey || e.ctrlKey) {
            if (keyIsSelected(p, k)) App.selectedKeys = App.selectedKeys.filter(s => !(s.p === p && s.key === k));
            else App.selectedKeys.push({ p, key: k });
            renderAll();
            return;
          }
          if (!keyIsSelected(p, k)) App.selectedKeys = [{ p, key: k }];
          App.commit();
          const moveSet = App.selectedKeys.map(s => ({ ...s, t0: s.key.t }));
          startDrag(e, {
            move(ev, dx) {
              moveSet.forEach(s => { s.key.t = xToT(s.t0 * pps + dx); });
              App.emit("props");
              refreshPositions();
            },
            up() {
              const props = new Set(moveSet.map(s => s.p));
              props.forEach(pp => pp.keys.sort((a, b) => a.t - b.t));
              App.emit("project");
            },
          });
        });

        d.addEventListener("contextmenu", e => {
          e.preventDefault();
          e.stopPropagation();
          const targets = keyIsSelected(p, k) ? App.selectedKeys : [{ p, key: k }];
          const items = Object.keys(EASE_LABELS).map(ease => ({
            label: EASE_LABELS[ease],
            checked: k.ease === ease,
            run: () => { App.commit(); targets.forEach(s => s.key.ease = ease); App.emit("project"); },
          }));
          items.push("-",
            { label: "Copy keyframes", run: () => UIClipboard.copyKeys(targets) },
            { label: "Delete keyframe" + (targets.length > 1 ? "s" : ""), danger: true,
              run: () => {
                App.commit();
                targets.forEach(s => {
                  const i = s.p.keys.indexOf(s.key);
                  if (i >= 0) s.p.keys.splice(i, 1);
                  if (!s.p.keys.length) s.p.anim = false;
                });
                App.selectedKeys = [];
                App.emit("project");
              } });
          showMenu(e.clientX, e.clientY, items);
        });

        row.appendChild(d);
        renderedKeys.push({ el: d, key: k });
      });
    }
    return row;
  }

  function trackFxHeadRow() {
    const row = document.createElement("div");
    row.className = "tl-row fxhead";
    return row;
  }

  /* ── render ── */
  function renderAll() {
    renderedBars = []; renderedKeys = [];
    elLeft.innerHTML = "";
    elTracks.innerHTML = "";

    const w = trackWidth();
    elContent.style.width = w + "px";

    visibleLayers().forEach(layer => {
      rowsForLayer(layer).forEach(rowDef => {
        if (rowDef.kind === "layer") {
          elLeft.appendChild(leftLayerRow(layer));
          elTracks.appendChild(trackLayerRow(layer));
        } else if (rowDef.kind === "fxhead") {
          elLeft.appendChild(leftFxHeadRow(rowDef));
          elTracks.appendChild(trackFxHeadRow());
        } else {
          elLeft.appendChild(leftPropRow(rowDef));
          elTracks.appendChild(trackPropRow(rowDef));
        }
      });
    });

    if (App.layers.length === 0) {
      const hint = document.createElement("div");
      hint.className = "empty-hint";
      hint.style.padding = "22px";
      hint.innerHTML = "No layers yet — add one from the Project panel<br>or press ⌘K";
      elLeft.appendChild(hint);
    }

    const c = App.comp;
    document.getElementById("tl-comp-name").textContent =
      `${c.width}×${c.height} · ${c.fps}fps · ${c.duration}s${c.motionBlur ? " · MB" : ""}`;

    drawRuler();
    updatePlayhead();
  }

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

  /* expand a layer and flash a specific transform property row */
  function revealProp(layer, propName) {
    App.expanded.add(layer.id);
    renderAll();
    const idx = PROP_ORDER.indexOf(propName);
    const layerRows = [...elLeft.querySelectorAll(".tl-row")];
    const li = layerRows.findIndex(r => r.dataset && r.dataset.id === layer.id);
    const target = layerRows[li + 1 + idx];
    if (target) {
      target.scrollIntoView({ block: "nearest" });
      target.style.background = "rgba(94,106,210,0.3)";
      setTimeout(() => target.style.background = "", 600);
    }
  }

  function addMarker() {
    App.commit();
    const c = App.comp;
    c.markers = c.markers || [];
    c.markers.push({ id: uid(), t: snapT(App.time), label: `M${c.markers.length + 1}` });
    drawRuler();
    App.emit("props");
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

    const search = document.getElementById("layer-search");
    search.addEventListener("input", () => { searchQuery = search.value.trim().toLowerCase(); renderAll(); });
    search.addEventListener("keydown", e => e.stopPropagation());

    document.getElementById("btn-shy").addEventListener("click", e => {
      App.shyHidden = !App.shyHidden;
      e.currentTarget.classList.toggle("active", App.shyHidden);
      renderAll();
    });

    elRight.addEventListener("scroll", () => { elLeft.scrollTop = elRight.scrollTop; });

    elRuler.addEventListener("pointerdown", rulerPointerDown);
    elRuler.addEventListener("dblclick", e => {
      const x = e.clientX - elContent.getBoundingClientRect().left;
      const mk = markerAt(x);
      if (mk) {
        const label = prompt("Marker label:", mk.label || "");
        if (label !== null) { App.commit(); mk.label = label; drawRuler(); }
      } else {
        addMarker();
      }
    });
    elRuler.addEventListener("contextmenu", e => {
      e.preventDefault();
      const x = e.clientX - elContent.getBoundingClientRect().left;
      const mk = markerAt(x);
      const items = [{ label: "Add marker here", run: () => { App.commit(); App.comp.markers.push({ id: uid(), t: xToT(x), label: "" }); drawRuler(); } }];
      if (mk) {
        items.push(
          { label: "Rename marker…", run: () => { const v = prompt("Marker label:", mk.label || ""); if (v !== null) { App.commit(); mk.label = v; drawRuler(); } } },
          { label: "Delete marker", danger: true, run: () => { App.commit(); App.comp.markers = App.comp.markers.filter(m => m !== mk); drawRuler(); } },
        );
      }
      showMenu(e.clientX, e.clientY, items);
    });

    elTracks.addEventListener("pointerdown", e => {
      if (e.target === elTracks || e.target.classList.contains("tl-row")) {
        App.selectedKeys = [];
        App.select(null);
      }
    });

    elRight.addEventListener("wheel", e => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const mx = e.clientX - elContent.getBoundingClientRect().left;
      const tAtMouse = mx / pps;
      pps = clamp(pps * (e.deltaY < 0 ? 1.15 : 0.87), 8, 600);
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

  return { init, renderAll, updatePlayhead, fit, revealProp, addMarker, drawRuler, get pps() { return pps; } };
})();
