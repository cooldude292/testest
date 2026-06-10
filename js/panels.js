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

const Panels = (() => {
  let refreshers = [];   // scrub inputs that track animated values

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
        App.setTime(Math.min(App.time, App.comp.duration));
        App.emit("project");
      });
      i.addEventListener("keydown", e => e.stopPropagation());
      f.append(l, i);
      return f;
    };
    host.append(
      field("Width", c.width, v => c.width = Math.round(v), { min: 16, max: 7680 }),
      field("Height", c.height, v => c.height = Math.round(v), { min: 16, max: 4320 }),
      field("FPS", c.fps, v => c.fps = Math.round(v), { min: 1, max: 120 }),
      field("Duration", c.duration, v => c.duration = v, { min: 0.5, max: 3600 }),
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
  }

  function renderAssets() {
    const host = document.getElementById("asset-list");
    host.innerHTML = "";
    const assets = App.project.assets;
    if (!assets.length) {
      host.innerHTML = `<div class="empty-hint">Drop images or video here,<br>or click ↓ in the header.</div>`;
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
        thumb.textContent = "VID";
      }
      const name = document.createElement("span");
      name.className = "asset-name";
      name.textContent = a.name;
      const add = document.createElement("button");
      add.className = "icon-btn sm asset-add";
      add.title = "Add to composition";
      add.innerHTML = '<svg viewBox="0 0 16 16"><path d="M8 3.5v9M3.5 8h9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
      item.append(thumb, name, add);
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
      host.innerHTML = `<div class="empty-hint pad">Select a layer to edit its properties.</div>`;
      return;
    }

    // header
    const head = document.createElement("div");
    head.className = "props-layer-head";
    head.innerHTML = `
      <span class="layer-chip" style="background:${LAYER_COLORS[layer.type]}"></span>
      <span class="props-layer-name">${escapeHtml(layer.name)}</span>
      <span class="props-layer-type">${layer.type === "null" ? "adjust" : layer.type}</span>`;
    host.appendChild(head);

    host.appendChild(transformGroup(layer));
    const dataGroup = layerDataGroup(layer);
    if (dataGroup) host.appendChild(dataGroup);
    host.appendChild(blendGroup(layer));
    host.appendChild(effectsGroup(layer));
  }

  function stopwatchBtn(layer, prop) {
    const p = layer.props[prop];
    const b = document.createElement("button");
    b.className = "stopwatch" + (p.anim ? " on" : "");
    b.title = p.anim ? "Disable animation (removes keyframes)" : "Enable animation";
    b.innerHTML = ICONS.stopwatch;
    b.addEventListener("click", () => { App.commit(); Layers.toggleAnim(layer, prop); });
    return b;
  }

  function propRow(layer, prop, fields) {
    const row = document.createElement("div");
    row.className = "prop-row";
    const label = document.createElement("span");
    label.className = "prop-label";
    label.append(stopwatchBtn(layer, prop));
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

  /* simple labelled control row for layer data */
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

  function colorInput(get, set) {
    const i = document.createElement("input");
    i.type = "color";
    i.value = get();
    i.addEventListener("input", () => { set(i.value); App.emit("props"); });
    i.addEventListener("change", () => { App.commit(); set(i.value); App.emit("props"); });
    return i;
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
    s.addEventListener("change", () => { App.commit(); set(s.value); App.emit("props"); });
    return s;
  }

  function layerDataGroup(layer) {
    const d = layer.data;
    const g = document.createElement("div");
    g.className = "prop-group";
    const title = { solid: "Solid", text: "Text", shape: "Shape", image: "Media", video: "Media", null: null }[layer.type];
    if (!title) return null;
    g.innerHTML = `<div class="prop-group-title">${title}</div>`;

    if (layer.type === "solid") {
      g.appendChild(dataRow("Color", colorInput(() => d.color, v => d.color = v)));
      g.appendChild(dataRow("Size", (() => {
        const wrap = document.createElement("span");
        wrap.className = "prop-fields";
        wrap.append(
          numInput(() => d.w, v => d.w = Math.round(v), { label: "W", min: 1 }),
          numInput(() => d.h, v => d.h = Math.round(v), { label: "H", min: 1 }),
        );
        return wrap;
      })()));
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
      g.appendChild(dataRow("Size", numInput(() => d.size, v => d.size = v, { label: "px", min: 4, max: 1200 })));
      g.appendChild(dataRow("Weight", selectInput(
        [["300", "Light"], ["400", "Regular"], ["500", "Medium"], ["600", "Semibold"], ["700", "Bold"], ["900", "Black"]],
        () => d.weight, v => d.weight = v)));
      g.appendChild(dataRow("Color", colorInput(() => d.color, v => d.color = v)));
      g.appendChild(dataRow("Tracking", numInput(() => d.tracking || 0, v => d.tracking = v, { label: "px", min: -20, max: 200 })));
      g.appendChild(dataRow("Leading", numInput(() => d.lineHeight, v => d.lineHeight = v, { label: "×", min: 0.5, max: 4, step: 0.05, decimals: 2 })));
    }

    if (layer.type === "shape") {
      g.appendChild(dataRow("Shape", selectInput(
        [["rect", "Rectangle"], ["ellipse", "Ellipse"], ["polygon", "Polygon"], ["star", "Star"]],
        () => d.shape, v => d.shape = v)));
      g.appendChild(dataRow("Size", (() => {
        const wrap = document.createElement("span");
        wrap.className = "prop-fields";
        wrap.append(
          numInput(() => d.w, v => d.w = Math.round(v), { label: "W", min: 1 }),
          numInput(() => d.h, v => d.h = Math.round(v), { label: "H", min: 1 }),
        );
        return wrap;
      })()));
      g.appendChild(dataRow("Fill", colorInput(() => d.fill || "#4cb782", v => d.fill = v)));
      g.appendChild(dataRow("Stroke", colorInput(() => d.stroke || "#000000", v => d.stroke = v)));
      g.appendChild(dataRow("Stroke W", numInput(() => d.strokeWidth || 0, v => d.strokeWidth = v, { min: 0, max: 200 })));
      if (d.shape === "rect")
        g.appendChild(dataRow("Radius", numInput(() => d.radius || 0, v => d.radius = v, { min: 0, max: 500 })));
      if (d.shape === "polygon" || d.shape === "star")
        g.appendChild(dataRow("Points", numInput(() => d.points || 5, v => d.points = Math.round(v), { min: 3, max: 30 })));
      if (d.shape === "star")
        g.appendChild(dataRow("Inset", numInput(() => d.inset || 0.5, v => d.inset = v, { min: 0.05, max: 0.95, step: 0.01, decimals: 2 })));
    }

    if (layer.type === "image" || layer.type === "video") {
      const a = Assets.find(d.assetId);
      const span = document.createElement("span");
      span.className = "dim";
      span.style.fontSize = "12px";
      span.textContent = a ? a.name : "(missing)";
      g.appendChild(dataRow("Source", span));
    }
    return g;
  }

  function blendGroup(layer) {
    const g = document.createElement("div");
    g.className = "prop-group";
    g.innerHTML = `<div class="prop-group-title">Compositing</div>`;
    g.appendChild(dataRow("Blend", selectInput(BLEND_MODES, () => layer.blend, v => layer.blend = v)));
    return g;
  }

  function effectsGroup(layer) {
    const g = document.createElement("div");
    g.className = "prop-group";
    g.innerHTML = `<div class="prop-group-title">Effects</div>`;

    layer.effects.forEach(fx => {
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
      const del = document.createElement("button");
      del.className = "icon-btn sm";
      del.title = "Remove effect";
      del.innerHTML = '<svg viewBox="0 0 16 16"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
      del.addEventListener("click", () => {
        App.commit();
        layer.effects = layer.effects.filter(f => f.id !== fx.id);
        App.emit("project");
      });
      head.append(tog, name, del);
      card.appendChild(head);

      def.params.forEach(pd => {
        const row = document.createElement("div");
        row.className = "effect-row";
        const lab = document.createElement("label");
        lab.textContent = pd.label;
        const slider = document.createElement("input");
        slider.type = "range";
        slider.min = pd.min; slider.max = pd.max; slider.step = pd.step;
        slider.value = fx.params[pd.key];
        const val = document.createElement("span");
        val.className = "effect-val";
        val.textContent = fx.params[pd.key] + pd.unit;
        let committed = false;
        slider.addEventListener("pointerdown", () => { committed = false; });
        slider.addEventListener("input", () => {
          if (!committed) { App.commit(); committed = true; }
          fx.params[pd.key] = parseFloat(slider.value);
          val.textContent = fx.params[pd.key] + pd.unit;
          App.emit("props");
        });
        row.append(lab, slider, val);
        card.appendChild(row);
      });
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

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
