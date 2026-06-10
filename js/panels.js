/* ─── Lumen panels: project + properties ───────────────────────── */
"use strict";

/* Draggable numeric input (AE-style scrubbing) */
function scrubInput({ label, get, set, step = 1, min = -Infinity, max = Infinity, decimals = 1, animated = false }) {
  const wrap = document.createElement("span");
  wrap.className = "scrub" + (animated ? " animated" : "");
  const lab = document.createElement("span");
  lab.className = "scrub-label";
  lab.textContent = label;
  const input = document.createElement("input");
  input.type = "text";
  input.spellcheck = false;

  const fmt = v => (Math.round(v * 10 ** decimals) / 10 ** decimals).toString();
  const refresh = () => { if (document.activeElement !== input) input.value = fmt(get()); };
  refresh();

  lab.addEventListener("pointerdown", e => {
    const v0 = get();
    let committed = false;
    startDrag(e, {
      cursor: "ew-resize",
      move(ev, dx) {
        if (!committed) { App.commit(); committed = true; }
        const mult = ev.shiftKey ? 10 : 1;
        set(clamp(v0 + dx * step * mult, min, max));
        input.value = fmt(get());
      },
      up() { if (committed) App.emit("project"); },
    });
  });

  input.addEventListener("focus", () => input.select());
  input.addEventListener("keydown", e => {
    e.stopPropagation();
    if (e.key === "Enter") input.blur();
    if (e.key === "Escape") { refresh(); input.blur(); }
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      App.commit();
      const d = (e.key === "ArrowUp" ? 1 : -1) * (e.shiftKey ? 10 : 1) * step;
      set(clamp((parseFloat(input.value) || 0) + d, min, max));
      input.value = fmt(get());
      App.emit("project");
    }
  });
  input.addEventListener("blur", () => {
    const v = parseFloat(input.value);
    if (!isNaN(v) && Math.abs(v - get()) > 1e-9) {
      App.commit();
      set(clamp(v, min, max));
      App.emit("project");
    }
    refresh();
  });

  wrap.append(lab, input);
  wrap.refresh = refresh;
  return wrap;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const Panels = (() => {
  let refreshers = [];

  /* ── shared small controls ── */
  function colorInput(get, set) {
    const span = document.createElement("span");
    span.style.cssText = "display:inline-flex;gap:4px;align-items:center";
    const i = document.createElement("input");
    i.type = "color";
    i.value = get();
    i.addEventListener("input", () => { set(i.value); App.emit("props"); });
    i.addEventListener("change", () => { App.commit(); set(i.value); App.emit("props"); });
    span.appendChild(i);
    if (window.EyeDropper) {
      const b = document.createElement("button");
      b.className = "icon-btn sm";
      b.title = "Pick color from screen";
      b.innerHTML = '<svg viewBox="0 0 16 16"><path d="m9.5 3.5 3 3M11 2l3 3-7.5 7.5L3 14l1.5-3.5L12 3" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      b.addEventListener("click", async () => {
        try {
          const r = await new EyeDropper().open();
          App.commit(); set(r.sRGBHex); i.value = r.sRGBHex; App.emit("props");
        } catch (e) { /* cancelled */ }
      });
      span.appendChild(b);
    }
    return span;
  }

  function numInput(get, set, opts = {}) {
    return scrubInput({
      label: opts.label || "", get, set: v => { set(v); App.emit("props"); },
      step: opts.step ?? 1, min: opts.min ?? -1e6, max: opts.max ?? 1e6, decimals: opts.decimals ?? 0,
    });
  }

  function selectInput(options, get, set) {
    const s = document.createElement("select");
    options.forEach(([v, lab]) => {
      const o = document.createElement("option");
      o.value = v; o.textContent = lab;
      s.appendChild(o);
    });
    s.value = get();
    s.addEventListener("change", () => { App.commit(); set(s.value); App.emit("project"); });
    return s;
  }

  function checkbox(labelText, get, set) {
    const lab = document.createElement("label");
    lab.className = "check-row";
    const c = document.createElement("input");
    c.type = "checkbox";
    c.checked = !!get();
    c.addEventListener("change", () => { App.commit(); set(c.checked); App.emit("project"); });
    lab.append(c, document.createTextNode(labelText));
    return lab;
  }

  function dataRow(labelText, control) {
    const row = document.createElement("div");
    row.className = "prop-row";
    const label = document.createElement("span");
    label.className = "prop-label";
    label.style.paddingLeft = "23px";
    label.textContent = labelText;
    const wrap = document.createElement("span");
    wrap.className = "prop-fields";
    wrap.appendChild(control);
    row.append(label, wrap);
    return row;
  }

  function pairRow(labelText, c1, c2) {
    const wrap = document.createElement("span");
    wrap.className = "prop-fields";
    wrap.append(c1, c2);
    return dataRow(labelText, wrap);
  }

  /* ── project panel ── */
  function renderCompSettings() {
    const host = document.getElementById("comp-settings");
    host.innerHTML = "";
    const c = App.comp;
    const field = (label, value, apply, opts = {}) => {
      const f = document.createElement("div");
      f.className = "comp-field";
      const l = document.createElement("label");
      l.textContent = label;
      const i = document.createElement("input");
      i.type = "number";
      i.value = value;
      if (opts.min !== undefined) i.min = opts.min;
      i.addEventListener("change", () => {
        const v = parseFloat(i.value);
        if (isNaN(v)) { i.value = value; return; }
        App.commit();
        apply(clamp(v, opts.min ?? 1, opts.max ?? 1e6));
        c.workEnd = Math.min(c.workEnd, c.duration);
        c.workStart = Math.min(c.workStart, Math.max(0, c.duration - 0.1));
        App.setTime(Math.min(App.time, c.duration));
        App.emit("project");
      });
      i.addEventListener("keydown", e => e.stopPropagation());
      f.append(l, i);
      return f;
    };

    // preset select
    const presetWrap = document.createElement("div");
    presetWrap.className = "comp-field full";
    presetWrap.innerHTML = "<label>Preset</label>";
    const preset = document.createElement("select");
    preset.innerHTML = `<option value="">Custom…</option>` +
      COMP_PRESETS.map(([v, lab]) => `<option value="${v}">${lab}</option>`).join("");
    preset.addEventListener("change", () => {
      if (!preset.value) return;
      const [w, h, fps] = preset.value.split("x").map(Number);
      App.commit();
      c.width = w; c.height = h; c.fps = fps;
      App.emit("project");
      Viewport.fit();
    });
    presetWrap.appendChild(preset);
    host.appendChild(presetWrap);

    host.append(
      field("Width", c.width, v => c.width = Math.round(v), { min: 16, max: 7680 }),
      field("Height", c.height, v => c.height = Math.round(v), { min: 16, max: 4320 }),
      field("FPS", c.fps, v => c.fps = Math.round(v), { min: 1, max: 120 }),
      field("Duration", c.duration, v => { c.duration = v; if (c.workEnd > v) c.workEnd = v; }, { min: 0.5, max: 3600 }),
    );

    const bgRow = document.createElement("div");
    bgRow.className = "comp-field full";
    bgRow.innerHTML = `<label>Background</label>`;
    const bg = document.createElement("input");
    bg.type = "color";
    bg.value = c.bg;
    bg.addEventListener("input", () => { c.bg = bg.value; App.emit("props"); });
    bg.addEventListener("change", () => { App.commit(); c.bg = bg.value; App.emit("props"); });
    bgRow.appendChild(bg);
    host.appendChild(bgRow);

    const checks = document.createElement("div");
    checks.className = "comp-field full";
    checks.style.flexDirection = "column";
    checks.style.alignItems = "stretch";
    checks.append(
      checkbox("Transparent background", () => c.bgAlpha, v => c.bgAlpha = v),
      checkbox("Motion blur (per-layer switch)", () => c.motionBlur, v => c.motionBlur = v),
    );
    host.appendChild(checks);
  }

  function renderAssets() {
    const host = document.getElementById("asset-list");
    host.innerHTML = "";
    const assets = App.project.assets;
    if (!assets.length) {
      host.innerHTML = `<div class="empty-hint">Drop images, video or audio here,<br>or click ↓ in the header.</div>`;
      return;
    }
    assets.forEach(a => {
      const item = document.createElement("div");
      item.className = "asset-item";
      item.title = "Click to add to composition";
      let thumb;
      if (a.type === "image") {
        thumb = document.createElement("img");
        thumb.className = "asset-thumb";
        thumb.src = a.src;
      } else {
        thumb = document.createElement("div");
        thumb.className = "asset-thumb";
        thumb.style.cssText = "display:flex;align-items:center;justify-content:center;color:#5e636e;font-size:9px;font-weight:600";
        thumb.textContent = a.type === "video" ? "VID" : "AUD";
      }
      const name = document.createElement("span");
      name.className = "asset-name";
      name.textContent = a.name;
      item.append(thumb, name);
      item.addEventListener("click", () => Assets.addToComp(a));
      item.addEventListener("contextmenu", e => {
        e.preventDefault();
        showMenu(e.clientX, e.clientY, [
          { label: "Add to composition", run: () => Assets.addToComp(a) },
          "-",
          { label: "Remove asset", danger: true, run: () => {
            App.commit();
            App.project.assets = App.project.assets.filter(x => x.id !== a.id);
            App.emit("project");
          } },
        ]);
      });
      host.appendChild(item);
    });
  }

  /* ── properties panel ── */
  function renderProps() {
    refreshers = [];
    const host = document.getElementById("props-body");
    host.innerHTML = "";
    const layer = App.selectedLayer();
    if (!layer) {
      const n = App.selectedIds().length;
      host.innerHTML = `<div class="empty-hint pad">${n > 1 ? n + " layers selected" : "Select a layer to edit its properties."}</div>`;
      return;
    }

    const head = document.createElement("div");
    head.className = "props-layer-head";
    head.innerHTML = `
      <span class="layer-chip" style="background:${layer.label || LAYER_COLORS[layer.type]}"></span>
      <span class="props-layer-name">${escapeHtml(layer.name)}</span>
      <span class="props-layer-type">${TYPE_NAMES[layer.type] || layer.type}</span>`;
    host.appendChild(head);

    if (layer.type !== "audio") {
      host.appendChild(alignGroup(layer));
      host.appendChild(transformGroup(layer));
    }
    const dataGroup = layerDataGroup(layer);
    if (dataGroup) host.appendChild(dataGroup);
    host.appendChild(compositingGroup(layer));
    if (layer.type !== "audio") {
      host.appendChild(masksGroup(layer));
      host.appendChild(effectsGroup(layer));
    }
  }

  function stopwatchBtnObj(p, layerId) {
    const b = document.createElement("button");
    b.className = "stopwatch" + (p.anim ? " on" : "");
    b.title = p.anim ? "Disable animation (removes keyframes)" : "Enable animation";
    b.innerHTML = ICONS.stopwatch;
    b.addEventListener("click", () => { App.commit(); Layers.toggleAnimObj(p, layerId); });
    return b;
  }

  function exprEditor(p, layer) {
    const wrap = document.createElement("div");
    wrap.className = "expr-row";

    const header = document.createElement("div");
    header.style.cssText = "display:flex;align-items:center;gap:6px;margin-bottom:4px";

    const enCheck = document.createElement("input");
    enCheck.type = "checkbox";
    enCheck.checked = !!p.exprEnabled;
    enCheck.title = "Enable expression";
    enCheck.addEventListener("change", () => {
      App.commit();
      p.exprEnabled = enCheck.checked;
      App.emit("project");
    });

    const lbl = document.createElement("span");
    lbl.style.cssText = "font-size:11px;color:var(--text-3);flex:1";
    lbl.textContent = "ε Expression";

    const presets = document.createElement("select");
    presets.style.cssText = "font-size:10.5px;height:20px;width:auto;border-radius:3px";
    presets.innerHTML = `<option value="">Presets…</option>
      <option value="wiggle(2, 30)">wiggle(2,30)</option>
      <option value="wiggle(5, 10)">wiggle(5,10)</option>
      <option value="loopOut()">loopOut()</option>
      <option value="loopOut('pingpong')">loopOut pingpong</option>
      <option value="time * 60">time * 60°/s</option>
      <option value="Math.sin(time * 3) * 50">sine wave</option>
      <option value="Math.abs(Math.sin(time * Math.PI * 2)) * 100">bounce</option>
      <option value="clamp(time / 2, 0, 100)">ramp in</option>`;
    presets.addEventListener("change", () => {
      if (presets.value) { ta.value = presets.value; presets.value = ""; }
    });

    header.append(enCheck, lbl, presets);

    const ta = document.createElement("textarea");
    ta.className = "expr-textarea";
    ta.placeholder = "e.g. wiggle(2, 30)";
    ta.value = p.expr || "";
    ta.spellcheck = false;
    ta.addEventListener("keydown", e => e.stopPropagation());
    let exprTimer = null;
    ta.addEventListener("input", () => {
      clearTimeout(exprTimer);
      exprTimer = setTimeout(() => {
        App.commit();
        p.expr = ta.value.trim() || null;
        App.emit("project");
      }, 400);
    });

    wrap.append(header, ta);

    if (p._exprError) {
      const errEl = document.createElement("div");
      errEl.className = "expr-error";
      errEl.textContent = "⚠ " + p._exprError;
      wrap.appendChild(errEl);
    }

    return wrap;
  }

  function propRow(layer, prop, fields) {
    const row = document.createElement("div");
    row.className = "prop-row";
    const label = document.createElement("span");
    label.className = "prop-label";
    const swWrap = document.createElement("span");
    swWrap.className = "prop-sw-wrap";
    swWrap.appendChild(stopwatchBtnObj(layer.props[prop], layer.id));
    // expression toggle
    const p = layer.props[prop];
    const exprBtn = document.createElement("button");
    exprBtn.className = "expr-toggle-btn" + (p.exprEnabled ? " on" : "");
    exprBtn.title = "Expression editor";
    exprBtn.textContent = "ε";
    exprBtn.addEventListener("click", () => {
      const existing = row.parentElement.querySelector(".expr-row[data-prop='" + prop + "']");
      if (existing) { existing.remove(); return; }
      const ed = exprEditor(p, layer);
      ed.dataset.prop = prop;
      row.after(ed);
      refreshers.push({ refresh: () => {
        const err = p._exprError;
        const errEl = ed.querySelector(".expr-error");
        if (err && !errEl) {
          const e2 = document.createElement("div");
          e2.className = "expr-error";
          e2.textContent = "⚠ " + err;
          ed.appendChild(e2);
        } else if (!err && errEl) {
          errEl.remove();
        }
      }});
    });
    swWrap.appendChild(exprBtn);
    label.appendChild(swWrap);
    label.append(document.createTextNode(PROP_LABELS[prop]));
    const wrap = document.createElement("span");
    wrap.className = "prop-fields";
    fields.forEach(f => wrap.appendChild(f));
    row.append(label, wrap);
    return row;
  }

  function vecScrubs(layer, prop, labels, opts = {}) {
    const p = layer.props[prop];
    return labels.map((lab, i) => {
      const s = scrubInput({
        label: lab,
        get: () => evalProp(p, App.time)[i],
        set: v => {
          const cur = cloneVal(evalProp(p, App.time));
          cur[i] = v;
          Layers.setProp(layer, prop, cur);
        },
        step: opts.step ?? 1, min: opts.min ?? -Infinity, max: opts.max ?? Infinity,
        animated: p.anim,
      });
      refreshers.push(s);
      return s;
    });
  }

  function scalarScrub(layer, prop, lab, opts = {}) {
    const p = layer.props[prop];
    const s = scrubInput({
      label: lab,
      get: () => evalProp(p, App.time),
      set: v => Layers.setProp(layer, prop, v),
      step: opts.step ?? 1, min: opts.min ?? -Infinity, max: opts.max ?? Infinity,
      animated: p.anim,
    });
    refreshers.push(s);
    return s;
  }

  function transformGroup(layer) {
    const g = document.createElement("div");
    g.className = "prop-group";
    const titleRow = document.createElement("div");
    titleRow.className = "prop-group-title";
    titleRow.textContent = "Transform";
    const sketchBtn = motionSketchBtn(layer);
    titleRow.appendChild(sketchBtn);
    // pen tool button
    const penBtn = document.createElement("button");
    penBtn.className = "btn ghost sm";
    penBtn.title = "Pen tool: draw bezier path mask";
    penBtn.textContent = "✎ Pen";
    penBtn.addEventListener("click", () => typeof Viewport !== "undefined" && Viewport.togglePenTool());
    titleRow.appendChild(penBtn);
    g.appendChild(titleRow);
    g.appendChild(propRow(layer, "position", vecScrubs(layer, "position", ["X", "Y"])));
    g.appendChild(propRow(layer, "scale", vecScrubs(layer, "scale", ["X", "Y"], { step: 0.5 })));
    g.appendChild(propRow(layer, "rotation", [scalarScrub(layer, "rotation", "°", { step: 0.5 })]));
    if (layer.props.rotationX) {
      g.appendChild(propRow(layer, "rotationX", [scalarScrub(layer, "rotationX", "°", { step: 0.5, min: -360, max: 360 })]));
      g.appendChild(propRow(layer, "rotationY", [scalarScrub(layer, "rotationY", "°", { step: 0.5, min: -360, max: 360 })]));
    }
    g.appendChild(propRow(layer, "opacity", [scalarScrub(layer, "opacity", "%", { step: 0.5, min: 0, max: 100 })]));
    g.appendChild(propRow(layer, "anchor", vecScrubs(layer, "anchor", ["X", "Y"])));
    return g;
  }

  function alignGroup(layer) {
    const g = document.createElement("div");
    g.className = "prop-group align-group";
    const c = App.comp;
    const [w, h] = contentSize(layer);
    const mk = (label, title, fn) => {
      const b = document.createElement("button");
      b.className = "btn ghost sm";
      b.textContent = label;
      b.title = title;
      b.addEventListener("click", () => {
        App.commit();
        const pos = cloneVal(evalProp(layer.props.position, App.time));
        fn(pos);
        Layers.setProp(layer, "position", pos);
        App.emit("project");
      });
      return b;
    };
    g.append(
      mk("⊣", "Align left", p => p[0] = w / 2 * Math.abs(evalProp(layer.props.scale, App.time)[0]) / 100),
      mk("↔", "Center horizontally", p => p[0] = c.width / 2),
      mk("⊢", "Align right", p => p[0] = c.width - w / 2 * Math.abs(evalProp(layer.props.scale, App.time)[0]) / 100),
      mk("⊤", "Align top", p => p[1] = h / 2 * Math.abs(evalProp(layer.props.scale, App.time)[1]) / 100),
      mk("↕", "Center vertically", p => p[1] = c.height / 2),
      mk("⊥", "Align bottom", p => p[1] = c.height - h / 2 * Math.abs(evalProp(layer.props.scale, App.time)[1]) / 100),
    );
    return g;
  }

  function gradientControls(g, d, fillKey, fill2Key) {
    g.appendChild(dataRow("Fill type", selectInput(
      [["solid", "Solid"], ["linear", "Linear gradient"], ["radial", "Radial gradient"]],
      () => d.fillType || "solid", v => d.fillType = v)));
    g.appendChild(dataRow("Color", colorInput(() => d[fillKey] || "#5e6ad2", v => d[fillKey] = v)));
    if (d.fillType && d.fillType !== "solid") {
      g.appendChild(dataRow("Color 2", colorInput(() => d[fill2Key] || "#26b5ce", v => d[fill2Key] = v)));
      if (d.fillType === "linear")
        g.appendChild(dataRow("Angle", numInput(() => d.gradAngle || 0, v => d.gradAngle = v, { label: "°", min: 0, max: 360 })));
    }
  }

  function secHead(text) {
    const el = document.createElement("div");
    el.className = "prop-group-title";
    el.style.marginTop = "8px";
    el.textContent = text;
    return el;
  }

  function layerDataGroup(layer) {
    const d = layer.data;
    const g = document.createElement("div");
    g.className = "prop-group";
    const title = {
      solid: "Solid", text: "Text", shape: "Shape", image: "Media", video: "Media",
      audio: "Audio", comp: "Source", adjust: null, nullobj: null,
      camera: "Camera", light: "Light",
    }[layer.type];
    if (title === undefined) return null;
    if (!title) return null;
    g.innerHTML = `<div class="prop-group-title">${title}</div>`;

    if (layer.type === "solid") {
      gradientControls(g, d, "color", "color2");
      g.appendChild(pairRow("Size",
        numInput(() => d.w, v => d.w = Math.round(v), { label: "W", min: 1 }),
        numInput(() => d.h, v => d.h = Math.round(v), { label: "H", min: 1 })));
    }

    if (layer.type === "text") {
      const ta = document.createElement("textarea");
      ta.value = d.text;
      ta.spellcheck = false;
      ta.addEventListener("keydown", e => e.stopPropagation());
      let committed = false;
      ta.addEventListener("input", () => {
        if (!committed) { App.commit(); committed = true; }
        d.text = ta.value;
        App.emit("props");
      });
      ta.addEventListener("blur", () => { committed = false; });
      g.appendChild(dataRow("Content", ta));

      // build font list including any imported fonts
      const builtinFonts = [
        ["Inter, system-ui, sans-serif", "Inter"],
        ["Georgia, serif", "Georgia"],
        ["'Times New Roman', serif", "Times"],
        ["Futura, 'Century Gothic', sans-serif", "Futura"],
        ["'SF Mono', Menlo, monospace", "Mono"],
        ["'Arial Black', sans-serif", "Arial Black"],
      ];
      const importedFonts = (App.project._fonts || []).map(f => [f.name, f.name + " (imported)"]);
      const fontWrap = document.createElement("span");
      fontWrap.className = "prop-fields";
      fontWrap.style.gap = "5px";
      const fontSel = document.createElement("select");
      [...builtinFonts, ...importedFonts].forEach(([v, lab]) => {
        const o = document.createElement("option");
        o.value = v; o.textContent = lab; fontSel.appendChild(o);
      });
      fontSel.value = d.font || "Inter, system-ui, sans-serif";
      fontSel.addEventListener("change", () => { App.commit(); d.font = fontSel.value; App.emit("project"); });
      const importBtn = document.createElement("button");
      importBtn.className = "btn ghost sm";
      importBtn.title = "Import font (.ttf/.otf)";
      importBtn.textContent = "+ Font";
      importBtn.addEventListener("click", () => document.getElementById("file-font").click());
      fontWrap.append(fontSel, importBtn);
      g.appendChild(dataRow("Font", fontWrap));
      g.appendChild(pairRow("Size",
        numInput(() => d.size, v => d.size = v, { label: "px", min: 4, max: 1200 }),
        selectInput([["300", "Light"], ["400", "Regular"], ["500", "Medium"], ["600", "Semibold"], ["700", "Bold"], ["900", "Black"]],
          () => d.weight, v => d.weight = v)));
      g.appendChild(dataRow("Align", selectInput(
        [["left", "Left"], ["center", "Center"], ["right", "Right"]],
        () => d.align || "center", v => d.align = v)));
      g.appendChild(dataRow("Color", colorInput(() => d.color, v => d.color = v)));
      g.appendChild(pairRow("Tracking",
        numInput(() => d.tracking || 0, v => d.tracking = v, { label: "px", min: -20, max: 200 }),
        numInput(() => d.lineHeight, v => d.lineHeight = v, { label: "lh", min: 0.5, max: 4, step: 0.05, decimals: 2 })));
      g.appendChild(pairRow("Stroke",
        colorInput(() => d.strokeColor || "#000000", v => d.strokeColor = v),
        numInput(() => d.strokeWidth || 0, v => d.strokeWidth = v, { label: "W", min: 0, max: 60 })));
      g.appendChild(dataRow("Caps", checkbox("All caps", () => d.caps, v => d.caps = v)));
      g.appendChild(dataRow("Reveal", selectInput(
        [["none", "None"], ["typewriter", "Typewriter"], ["fadechar", "Fade per char"], ["risechar", "Rise per char"]],
        () => d.reveal || "none", v => d.reveal = v)));
      if (d.reveal && d.reveal !== "none") {
        g.appendChild(pairRow("Timing",
          numInput(() => d.revealStart || 0, v => d.revealStart = v, { label: "start", min: 0, max: 60, step: 0.05, decimals: 2 }),
          numInput(() => d.revealDur || 1, v => d.revealDur = v, { label: "dur", min: 0.05, max: 30, step: 0.05, decimals: 2 })));
      }

      // ─── Text Animators ───────────────────────────────────────────
      const animHead = document.createElement("div");
      animHead.className = "prop-group-title";
      animHead.style.marginTop = "10px";
      animHead.textContent = "Animators";
      const addAnimBtn = document.createElement("button");
      addAnimBtn.className = "btn ghost sm";
      addAnimBtn.textContent = "+ Add";
      addAnimBtn.title = "Add text animator";
      addAnimBtn.addEventListener("click", () => {
        App.commit();
        if (!d.animators) d.animators = [];
        d.animators.push({ id: uid(), name: "Animator " + (d.animators.length+1), enabled: true,
          rangeStart: 0, rangeEnd: 100, rangeOffset: 0, smoothness: 50,
          opacity: 100, blur: 0, posX: 0, posY: 0, scale: 100, rotation: 0 });
        App.emit("project");
      });
      animHead.appendChild(addAnimBtn);
      g.appendChild(animHead);

      (d.animators || []).forEach((anim, ai) => {
        const ag = document.createElement("div");
        ag.style.cssText = "border-left:2px solid var(--accent);padding-left:8px;margin:4px 0 8px;";
        const ah = document.createElement("div");
        ah.style.cssText = "display:flex;align-items:center;gap:4px;margin-bottom:4px;font-size:11px;color:var(--text-2);";
        const enCb = document.createElement("input"); enCb.type="checkbox"; enCb.checked=anim.enabled;
        enCb.addEventListener("change", () => { App.commit(); anim.enabled=enCb.checked; App.emit("project"); });
        const lbl = document.createElement("span"); lbl.textContent=anim.name; lbl.style.flex="1";
        const delBtn = document.createElement("button"); delBtn.className="btn ghost sm"; delBtn.textContent="✕"; delBtn.style.padding="0 4px";
        delBtn.addEventListener("click", () => { App.commit(); d.animators.splice(ai,1); App.emit("project"); });
        ah.append(enCb, lbl, delBtn);
        ag.appendChild(ah);
        // Range selector
        ag.appendChild(pairRow("Range",
          numInput(() => anim.rangeStart, v => { anim.rangeStart=clamp(v,0,100); }, { label: "S%", min:0, max:100, step:1 }),
          numInput(() => anim.rangeEnd,   v => { anim.rangeEnd  =clamp(v,0,100); }, { label: "E%", min:0, max:100, step:1 })));
        ag.appendChild(pairRow("Offset/Smooth",
          numInput(() => anim.rangeOffset, v => { anim.rangeOffset=v; }, { label: "Off", min:-200, max:200, step:1 }),
          numInput(() => anim.smoothness||0, v => { anim.smoothness=clamp(v,0,100); }, { label: "Soft%", min:0, max:100, step:1 })));
        // Property values
        ag.appendChild(dataRow("Opacity %", numInput(() => anim.opacity??100, v => { anim.opacity=clamp(v,0,100); }, { min:0, max:100, step:1 })));
        ag.appendChild(pairRow("Pos X/Y",
          numInput(() => anim.posX||0, v => { anim.posX=v; }, { label:"X", step:1 }),
          numInput(() => anim.posY||0, v => { anim.posY=v; }, { label:"Y", step:1 })));
        ag.appendChild(pairRow("Scale/Rot",
          numInput(() => anim.scale??100, v => { anim.scale=v; }, { label:"%", min:0, max:500, step:1 }),
          numInput(() => anim.rotation||0, v => { anim.rotation=v; }, { label:"°", step:0.5 })));
        ag.appendChild(dataRow("Blur px", numInput(() => anim.blur||0, v => { anim.blur=clamp(v,0,100); }, { min:0, max:100, step:1 })));
        g.appendChild(ag);
      });
    }

    if (layer.type === "shape") {
      g.appendChild(dataRow("Shape", selectInput(
        [["rect", "Rectangle"], ["ellipse", "Ellipse"], ["polygon", "Polygon"], ["star", "Star"]],
        () => d.shape, v => d.shape = v)));
      g.appendChild(pairRow("Size",
        numInput(() => d.w, v => d.w = Math.round(v), { label: "W", min: 1 }),
        numInput(() => d.h, v => d.h = Math.round(v), { label: "H", min: 1 })));
      gradientControls(g, d, "fill", "fill2");
      g.appendChild(pairRow("Stroke",
        colorInput(() => d.stroke || "#000000", v => d.stroke = v),
        numInput(() => d.strokeWidth || 0, v => d.strokeWidth = v, { label: "W", min: 0, max: 200 })));
      if (d.shape === "rect")
        g.appendChild(dataRow("Radius", numInput(() => d.radius || 0, v => d.radius = v, { min: 0, max: 500 })));
      if (d.shape === "polygon" || d.shape === "star")
        g.appendChild(dataRow("Points", numInput(() => d.points || 5, v => d.points = Math.round(v), { min: 3, max: 30 })));
      if (d.shape === "star")
        g.appendChild(dataRow("Inset", numInput(() => d.inset || 0.5, v => d.inset = v, { min: 0.05, max: 0.95, step: 0.01, decimals: 2 })));

      // trim paths
      const trimHead = document.createElement("div");
      trimHead.className = "prop-group-title";
      trimHead.style.marginTop = "8px";
      trimHead.append(document.createTextNode("Trim Paths"));
      const trimEnCheck = checkbox("Enable", () => d.trimEnabled, v => d.trimEnabled = v);
      trimHead.appendChild(trimEnCheck);
      g.appendChild(trimHead);
      if (d.trimEnabled !== false) {
        g.appendChild(pairRow("Trim",
          numInput(() => d.trimStart ?? 0, v => d.trimStart = clamp(v, 0, 100), { label: "Start%", min: 0, max: 100 }),
          numInput(() => d.trimEnd ?? 100, v => d.trimEnd = clamp(v, 0, 100), { label: "End%", min: 0, max: 100 })));
        g.appendChild(dataRow("Offset", numInput(() => d.trimOffset ?? 0, v => d.trimOffset = v % 360, { label: "°" })));
      }

      // shape repeater
      const repHead = document.createElement("div");
      repHead.className = "prop-group-title";
      repHead.style.marginTop = "8px";
      repHead.textContent = "Repeater";
      g.appendChild(repHead);
      g.appendChild(dataRow("Count", numInput(() => d.repeatCount ?? 1, v => d.repeatCount = clamp(Math.round(v), 1, 99), { min: 1, max: 99 })));
      if ((d.repeatCount ?? 1) > 1) {
        g.appendChild(pairRow("Offset",
          numInput(() => d.repeatOffsetX ?? 0, v => d.repeatOffsetX = v, { label: "X" }),
          numInput(() => d.repeatOffsetY ?? 0, v => d.repeatOffsetY = v, { label: "Y" })));
        g.appendChild(pairRow("Rot/Scale",
          numInput(() => d.repeatRotation ?? 0, v => d.repeatRotation = v, { label: "°" }),
          numInput(() => d.repeatScale ?? 100, v => d.repeatScale = v, { label: "%" })));
        g.appendChild(dataRow("Opacity", numInput(() => d.repeatOpacity ?? 100, v => d.repeatOpacity = clamp(v, 0, 100), { label: "%", min: 0, max: 100 })));
      }
    }

    if (layer.type === "image" || layer.type === "video" || layer.type === "audio") {
      const a = Assets.find(d.assetId);
      const span = document.createElement("span");
      span.className = "dim";
      span.style.fontSize = "12px";
      span.textContent = a ? a.name : "(missing)";
      g.appendChild(dataRow("Source", span));
      if (layer.type === "video") {
        const trackBtn = document.createElement("button");
        trackBtn.className = "btn ghost sm";
        trackBtn.textContent = "⌖ Track Motion";
        trackBtn.title = "Track motion from this video to selected layer";
        trackBtn.addEventListener("click", async () => {
          const target = App.selectedLayers().find(l => l.id !== layer.id) || App.layers.find(l => l.id !== layer.id);
          if (!target) { toast("Select a target layer to receive tracking data"); return; }
          toast("Motion tracking…");
          try { await MotionTracker.track(layer, target); }
          catch (e) { toast("Track failed: " + e.message); }
        });
        g.appendChild(dataRow("Tracker", trackBtn));
      }
      if (layer.type === "audio") {
        g.appendChild(dataRow("Volume", numInput(() => d.volume ?? 100, v => d.volume = v, { label: "%", min: 0, max: 200 })));
        const eqHead = document.createElement("div");
        eqHead.className = "prop-group-title";
        eqHead.style.marginTop = "8px";
        eqHead.textContent = "EQ";
        g.appendChild(eqHead);
        g.appendChild(pairRow("Low / Mid",
          numInput(() => d.eqLow ?? 0, v => d.eqLow = clamp(v, -24, 24), { label: "dB", min: -24, max: 24, step: 0.5, decimals: 1 }),
          numInput(() => d.eqMid ?? 0, v => d.eqMid = clamp(v, -24, 24), { label: "dB", min: -24, max: 24, step: 0.5, decimals: 1 })));
        g.appendChild(dataRow("High", numInput(() => d.eqHigh ?? 0, v => d.eqHigh = clamp(v, -24, 24), { label: "dB", min: -24, max: 24, step: 0.5, decimals: 1 })));

        // Motion tracker button
        const trackBtn = document.createElement("button");
        trackBtn.className = "btn ghost sm";
        trackBtn.style.marginTop = "6px";
        trackBtn.textContent = "⌖ Track Motion";
        trackBtn.title = "Track motion from video asset to position keyframes on selected layer";
        trackBtn.addEventListener("click", async () => {
          const vidLayer = App.layers.find(l => l.type === "video");
          const target = App.layers.find(l => l.id === App.selection && l.type !== "audio");
          if (!vidLayer || !target) { toast("Need a video layer and select a target layer"); return; }
          toast("Motion tracking… (this may take a moment)");
          try {
            await MotionTracker.track(vidLayer, target);
          } catch (e) { toast("Track failed: " + e.message); }
        });
        g.appendChild(trackBtn);
      }
    }

    if (layer.type === "comp") {
      const inner = Comps.find(d.compId);
      const wrap = document.createElement("span");
      wrap.className = "prop-fields";
      const span = document.createElement("span");
      span.className = "dim";
      span.style.fontSize = "12px";
      span.textContent = inner ? inner.name : "(missing)";
      const open = document.createElement("button");
      open.className = "btn ghost sm";
      open.textContent = "Open";
      open.addEventListener("click", () => { if (inner) App.setActiveComp(inner.id); });
      wrap.append(span, open);
      g.appendChild(dataRow("Comp", wrap));
    }

    if (layer.type === "camera") {
      g.appendChild(secHead("Camera"));
      g.appendChild(dataRow("FOV (°)",
        numInput(() => d.fov || 50, v => d.fov = clamp(v, 5, 170), { min:5, max:170, step:1 })));
      g.appendChild(dataRow("Zoom",
        numInput(() => d.zoom || 1, v => d.zoom = v, { min:0.1, max:10, step:0.01, decimals:2 })));
      const hint = document.createElement("div");
      hint.className = "dim"; hint.style.fontSize = "11px"; hint.style.padding = "4px 0";
      hint.textContent = "Place Camera layer in Z=-500. Other layers get Z depth via positionZ.";
      g.appendChild(hint);
    }

    if (layer.type === "light") {
      g.appendChild(secHead("Light"));
      g.appendChild(dataRow("Type", selectInput(
        [["ambient","Ambient"],["point","Point"],["directional","Directional"]],
        () => d.lightType || "point", v => d.lightType = v)));
      g.appendChild(dataRow("Intensity",
        numInput(() => d.intensity || 100, v => d.intensity = clamp(v,0,300), { min:0, max:300, step:1 })));
      g.appendChild(dataRow("Color", colorInput(() => d.color || "#ffffff", v => d.color = v)));
      if (d.lightType === "directional") {
        g.appendChild(dataRow("Angle",
          numInput(() => d.angle || 135, v => d.angle = v, { min:0, max:360, step:1 })));
      }
    }

    return g;
  }

  function compositingGroup(layer) {
    const g = document.createElement("div");
    g.className = "prop-group";
    g.innerHTML = `<div class="prop-group-title">Compositing</div>`;
    if (layer.type !== "audio") {
      g.appendChild(dataRow("Blend", selectInput(BLEND_MODES, () => layer.blend, v => layer.blend = v)));
      const idx = App.layers.indexOf(layer);
      if (idx > 0) {
        g.appendChild(dataRow("Matte", selectInput(MATTE_MODES, () => layer.matte, v => layer.matte = v)));
      }
    }

    // parent dropdown
    const opts = [["", "None"]];
    App.layers.forEach(l => {
      if (l.id !== layer.id && !Layers.wouldCycle(layer, l.id)) opts.push([l.id, l.name]);
    });
    g.appendChild(dataRow("Parent", selectInput(opts, () => layer.parent || "", v => layer.parent = v || null)));

    // positionZ (shown for non-audio layers)
    if (layer.type !== "audio" && layer.props.positionZ) {
      g.appendChild(propRow(layer, "positionZ", [scalarScrub(layer, "positionZ", "Z", { min: -5000, max: 5000, step: 1 })]));
    }

    g.appendChild(pairRow("Time",
      numInput(() => layer.stretch ?? 100, v => layer.stretch = clamp(v, 1, 1000), { label: "stretch %", min: 1, max: 1000 }),
      checkbox("Reverse", () => layer.reverse, v => layer.reverse = v)));
    if (layer.type !== "audio") {
      g.appendChild(dataRow("Motion blur", checkbox("Enable", () => layer.motionBlur, v => layer.motionBlur = v)));
    }

    // v3: auto-orient, hold frame, posterize time, collapse transform
    if (layer.props.position) {
      g.appendChild(dataRow("Path", checkbox("Auto-orient to path", () => layer.autoOrient, v => layer.autoOrient = v)));
    }
    g.appendChild(dataRow("Hold", checkbox("Hold frame at in-point", () => layer.holdFrame, v => layer.holdFrame = v)));

    const posterWrap = document.createElement("div");
    posterWrap.className = "prop-row";
    const posterCheck = checkbox("Posterize time", () => layer.posterizeTime, v => layer.posterizeTime = v);
    const posterFps = numInput(() => layer.posterizeTimeFPS ?? 12, v => layer.posterizeTimeFPS = clamp(Math.round(v), 1, 120), { label: "fps", min: 1, max: 120 });
    posterFps.style.width = "70px";
    posterWrap.append(posterCheck, posterFps);
    g.appendChild(posterWrap);

    if (layer.type === "comp") {
      g.appendChild(dataRow("Collapse", checkbox("Collapse transform", () => layer.collapseTransform, v => layer.collapseTransform = v)));
    }

    // v3: time remap
    if (layer.type !== "nullobj" && layer.type !== "adjust") {
      const trRow = document.createElement("div");
      trRow.className = "prop-row tremap-row";
      const trBtn = document.createElement("button");
      trBtn.className = "btn ghost sm";
      trBtn.textContent = layer.timeRemap ? "Disable Time Remap" : "Enable Time Remap";
      trBtn.addEventListener("click", () => {
        App.commit();
        if (layer.timeRemap) Layers.disableTimeRemap(layer);
        else Layers.enableTimeRemap(layer);
        App.emit("project");
      });
      trRow.appendChild(trBtn);
      g.appendChild(trRow);
    }

    // v3: notes
    const notesArea = document.createElement("textarea");
    notesArea.className = "notes-textarea";
    notesArea.placeholder = "Layer notes…";
    notesArea.value = layer.notes || "";
    notesArea.addEventListener("keydown", e => e.stopPropagation());
    notesArea.addEventListener("input", () => { layer.notes = notesArea.value; });
    notesArea.addEventListener("blur", () => { App.emit("project"); });
    g.appendChild(dataRow("Notes", notesArea));

    return g;
  }

  function masksGroup(layer) {
    const g = document.createElement("div");
    g.className = "prop-group";
    g.innerHTML = `<div class="prop-group-title">Masks</div>`;

    layer.masks.forEach((mask, mi) => {
      const card = document.createElement("div");
      card.className = "effect-card";
      const head = document.createElement("div");
      head.className = "effect-head";
      const name = document.createElement("span");
      name.className = "effect-name";
      name.textContent = `Mask ${mi + 1}`;
      const del = document.createElement("button");
      del.className = "icon-btn sm";
      del.title = "Remove mask";
      del.innerHTML = '<svg viewBox="0 0 16 16"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
      del.addEventListener("click", () => {
        App.commit();
        layer.masks = layer.masks.filter(m => m.id !== mask.id);
        App.emit("project");
      });
      head.append(name, del);
      card.appendChild(head);

      const row1 = document.createElement("div");
      row1.className = "prop-row";
      const shapeSel = mask.shape === "path"
        ? (() => { const s = document.createElement("span"); s.className = "dim"; s.style.fontSize="11px"; s.textContent = "Bezier Path"; return s; })()
        : selectInput([["rect", "Rectangle"], ["ellipse", "Ellipse"]], () => mask.shape, v => mask.shape = v);
      row1.append(
        shapeSel,
        selectInput([["add", "Add"], ["subtract", "Subtract"]], () => mask.mode, v => mask.mode = v),
      );
      card.appendChild(row1);
      if (mask.shape !== "path") {
        const row2 = document.createElement("div");
        row2.className = "prop-row";
        row2.append(
          numInput(() => mask.x, v => mask.x = v, { label: "X" }),
          numInput(() => mask.y, v => mask.y = v, { label: "Y" }),
        );
        card.appendChild(row2);
        const row3 = document.createElement("div");
        row3.className = "prop-row";
        row3.append(
          numInput(() => mask.w, v => mask.w = Math.max(1, v), { label: "W", min: 1 }),
          numInput(() => mask.h, v => mask.h = Math.max(1, v), { label: "H", min: 1 }),
        );
        card.appendChild(row3);
      } else {
        const pathInfo = document.createElement("div");
        pathInfo.className = "prop-row";
        pathInfo.innerHTML = `<span class="dim" style="font-size:11px">${mask.points ? mask.points.length : 0} points · ${mask.closed ? "closed" : "open"}</span>`;
        card.appendChild(pathInfo);
      }
      const row4 = document.createElement("div");
      row4.className = "prop-row";
      row4.append(numInput(() => mask.feather, v => mask.feather = Math.max(0, v), { label: "Feather", min: 0, max: 300 }));
      card.appendChild(row4);
      g.appendChild(card);
    });

    const addRow = document.createElement("div");
    addRow.className = "add-effect-row";
    const addRect = document.createElement("button");
    addRect.className = "btn ghost sm block";
    addRect.textContent = "+ Rect mask";
    addRect.addEventListener("click", () => { App.commit(); Layers.addMask(layer, "rect"); });
    const addEll = document.createElement("button");
    addEll.className = "btn ghost sm block";
    addEll.textContent = "+ Ellipse mask";
    addEll.addEventListener("click", () => { App.commit(); Layers.addMask(layer, "ellipse"); });
    const addPath = document.createElement("button");
    addPath.className = "btn ghost sm block";
    addPath.textContent = "✎ Pen tool";
    addPath.title = "Use pen tool to draw a bezier path mask";
    addPath.addEventListener("click", () => typeof Viewport !== "undefined" && Viewport.togglePenTool());
    addRow.append(addRect, addEll, addPath);
    g.appendChild(addRow);
    return g;
  }

  function effectsGroup(layer) {
    const g = document.createElement("div");
    g.className = "prop-group";
    g.innerHTML = `<div class="prop-group-title">Effects</div>`;

    layer.effects.forEach((fx, fi) => {
      const def = EFFECTS[fx.type];
      if (!def) return;
      const card = document.createElement("div");
      card.className = "effect-card" + (fx.enabled ? "" : " disabled");

      const head = document.createElement("div");
      head.className = "effect-head";
      const tog = document.createElement("button");
      tog.className = "icon-btn sm" + (fx.enabled ? " active" : "");
      tog.title = "Toggle effect";
      tog.innerHTML = ICONS.eye;
      tog.addEventListener("click", () => { App.commit(); fx.enabled = !fx.enabled; App.emit("project"); });
      const name = document.createElement("span");
      name.className = "effect-name";
      name.textContent = def.label;
      const up = document.createElement("button");
      up.className = "icon-btn sm";
      up.title = "Move up";
      up.innerHTML = '<svg viewBox="0 0 16 16"><path d="m4 9.5 4-4 4 4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      up.addEventListener("click", () => {
        if (fi === 0) return;
        App.commit();
        [layer.effects[fi - 1], layer.effects[fi]] = [layer.effects[fi], layer.effects[fi - 1]];
        App.emit("project");
      });
      const del = document.createElement("button");
      del.className = "icon-btn sm";
      del.title = "Remove effect";
      del.innerHTML = '<svg viewBox="0 0 16 16"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
      del.addEventListener("click", () => {
        App.commit();
        layer.effects = layer.effects.filter(f => f.id !== fx.id);
        App.emit("project");
      });
      head.append(tog, name, up, del);
      card.appendChild(head);

      def.params.forEach(pd => {
        const p = fx.params[pd.key];
        const row = document.createElement("div");
        row.className = "effect-row";
        row.appendChild(stopwatchBtnObj(p, layer.id));
        const lab = document.createElement("label");
        lab.textContent = pd.label;
        const s = scrubInput({
          label: pd.unit || "",
          get: () => evalProp(p, App.time),
          set: v => Layers.setPropObj(p, v),
          step: pd.step, min: pd.min, max: pd.max,
          decimals: pd.step < 1 ? 1 : 0,
          animated: p.anim,
        });
        refreshers.push(s);
        row.append(lab, s);
        card.appendChild(row);
      });

      if (def.color) {
        const row = document.createElement("div");
        row.className = "effect-row";
        const lab = document.createElement("label");
        lab.textContent = "Color";
        lab.style.marginLeft = "18px";
        row.append(lab, colorInput(() => fx.color || def.color.def, v => fx.color = v));
        card.appendChild(row);
      }
      g.appendChild(card);
    });

    const addRow = document.createElement("div");
    addRow.className = "add-effect-row";
    const sel = document.createElement("select");
    sel.innerHTML = `<option value="">Add effect…</option>` +
      Object.entries(EFFECTS).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join("");
    sel.addEventListener("change", () => {
      if (!sel.value) return;
      App.commit();
      Layers.addEffect(layer, sel.value);
      sel.value = "";
    });
    addRow.appendChild(sel);
    g.appendChild(addRow);
    return g;
  }

  function refreshValues() {
    refreshers.forEach(s => s.refresh());
  }

  function renderProject() {
    renderCompSettings();
    renderAssets();
  }

  function motionSketchBtn(layer) {
    const b = document.createElement("button");
    b.className = "btn ghost sm";
    b.title = "Record mouse movement as position keyframes";
    b.textContent = "⬤ Sketch";
    b.style.color = "var(--danger)";
    b.addEventListener("click", () => MotionSketch.start());
    return b;
  }

  function init() {
    document.getElementById("btn-import").addEventListener("click", () =>
      document.getElementById("file-import").click());
    document.getElementById("file-import").addEventListener("change", e => {
      Assets.importFiles(e.target.files);
      e.target.value = "";
    });

    const projPanel = document.getElementById("panel-project");
    projPanel.addEventListener("dragover", e => { e.preventDefault(); projPanel.classList.add("drop-target"); });
    projPanel.addEventListener("dragleave", () => projPanel.classList.remove("drop-target"));
    projPanel.addEventListener("drop", e => {
      e.preventDefault();
      projPanel.classList.remove("drop-target");
      if (e.dataTransfer.files.length) Assets.importFiles(e.dataTransfer.files);
    });

    document.querySelectorAll("[data-newlayer]").forEach(btn => {
      btn.addEventListener("click", () => {
        App.commit();
        const type = btn.dataset.newlayer;
        if (type === "comp") {
          const others = App.project.comps.filter(c => c.id !== App.comp.id);
          if (!others.length) { toast("No other compositions to add. Create another comp first."); return; }
          const names = others.map((c,i) => `${i+1}. ${c.name}`).join("\n");
          const idx = parseInt(prompt(`Choose composition:\n${names}\nEnter number:`), 10) - 1;
          if (isNaN(idx) || idx < 0 || idx >= others.length) return;
          Layers.add(makeLayer("comp", { compId: others[idx].id, name: others[idx].name }));
        } else {
          Layers.add(makeLayer(type));
        }
      });
    });

    App.on("project", () => { renderProject(); renderProps(); });
    App.on("selection", renderProps);
    App.on("time", refreshValues);
    App.on("props", refreshValues);
  }

  return { init, renderProject, renderProps, refreshValues };
})();
