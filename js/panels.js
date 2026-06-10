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

  function propRow(layer, prop, fields) {
    const row = document.createElement("div");
    row.className = "prop-row";
    const label = document.createElement("span");
    label.className = "prop-label";
    label.append(stopwatchBtnObj(layer.props[prop], layer.id));
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
    g.innerHTML = `<div class="prop-group-title">Transform</div>`;
    g.appendChild(propRow(layer, "position", vecScrubs(layer, "position", ["X", "Y"])));
    g.appendChild(propRow(layer, "scale", vecScrubs(layer, "scale", ["X", "Y"], { step: 0.5 })));
    g.appendChild(propRow(layer, "rotation", [scalarScrub(layer, "rotation", "°", { step: 0.5 })]));
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

  function layerDataGroup(layer) {
    const d = layer.data;
    const g = document.createElement("div");
    g.className = "prop-group";
    const title = {
      solid: "Solid", text: "Text", shape: "Shape", image: "Media", video: "Media",
      audio: "Audio", comp: "Source", adjust: null, nullobj: null,
    }[layer.type];
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
      g.appendChild(dataRow("Font", selectInput([
        ["Inter, system-ui, sans-serif", "Inter"],
        ["Georgia, serif", "Georgia"],
        ["'Times New Roman', serif", "Times"],
        ["Futura, 'Century Gothic', sans-serif", "Futura"],
        ["'SF Mono', Menlo, monospace", "Mono"],
        ["'Arial Black', sans-serif", "Arial Black"],
      ], () => d.font, v => d.font = v)));
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
      g.appendChild(dataRow("Animator", selectInput(
        [["none", "None"], ["typewriter", "Typewriter"], ["fadechar", "Fade per char"], ["risechar", "Rise per char"]],
        () => d.reveal || "none", v => d.reveal = v)));
      if (d.reveal && d.reveal !== "none") {
        g.appendChild(pairRow("Timing",
          numInput(() => d.revealStart || 0, v => d.revealStart = v, { label: "start", min: 0, max: 60, step: 0.05, decimals: 2 }),
          numInput(() => d.revealDur || 1, v => d.revealDur = v, { label: "dur", min: 0.05, max: 30, step: 0.05, decimals: 2 })));
      }
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
    }

    if (layer.type === "image" || layer.type === "video" || layer.type === "audio") {
      const a = Assets.find(d.assetId);
      const span = document.createElement("span");
      span.className = "dim";
      span.style.fontSize = "12px";
      span.textContent = a ? a.name : "(missing)";
      g.appendChild(dataRow("Source", span));
      if (layer.type === "audio") {
        g.appendChild(dataRow("Volume", numInput(() => d.volume ?? 100, v => d.volume = v, { label: "%", min: 0, max: 200 })));
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

    g.appendChild(pairRow("Time",
      numInput(() => layer.stretch ?? 100, v => layer.stretch = clamp(v, 1, 1000), { label: "stretch %", min: 1, max: 1000 }),
      checkbox("Reverse", () => layer.reverse, v => layer.reverse = v)));
    if (layer.type !== "audio") {
      g.appendChild(dataRow("Motion blur", checkbox("Enable", () => layer.motionBlur, v => layer.motionBlur = v)));
    }
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
      row1.append(
        selectInput([["rect", "Rectangle"], ["ellipse", "Ellipse"]], () => mask.shape, v => mask.shape = v),
        selectInput([["add", "Add"], ["subtract", "Subtract"]], () => mask.mode, v => mask.mode = v),
      );
      card.appendChild(row1);
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
    addRow.append(addRect, addEll);
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
        Layers.add(makeLayer(btn.dataset.newlayer));
      });
    });

    App.on("project", () => { renderProject(); renderProps(); });
    App.on("selection", renderProps);
    App.on("time", refreshValues);
    App.on("props", refreshValues);
  }

  return { init, renderProject, renderProps, refreshValues };
})();
