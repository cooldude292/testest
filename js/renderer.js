/* ─── Lumen renderer v3: compositor + effects ───────────────────── */
"use strict";

const Renderer = (() => {
  const pools = [];
  function getPool(depth, w, h) {
    if (!pools[depth]) {
      pools[depth] = {};
      ["tmp","aux","aux2","mask","out"].forEach(k => {
        pools[depth][k] = document.createElement("canvas");
        pools[depth][k+"Ctx"] = pools[depth][k].getContext("2d", { willReadFrequently: k === "aux" || k === "aux2" });
      });
    }
    const p = pools[depth];
    ["tmp","aux","aux2","mask","out"].forEach(k => {
      if (p[k].width !== w || p[k].height !== h) { p[k].width = w; p[k].height = h; }
    });
    return p;
  }

  let noiseCanvas = null;
  function getNoise() {
    if (!noiseCanvas) { noiseCanvas = document.createElement("canvas"); noiseCanvas.width = noiseCanvas.height = 128; }
    const nctx = noiseCanvas.getContext("2d");
    const img = nctx.createImageData(128, 128);
    for (let i = 0; i < img.data.length; i += 4) { const v = Math.random() * 255; img.data[i] = img.data[i+1] = img.data[i+2] = v; img.data[i+3] = 255; }
    nctx.putImageData(img, 0, 0); return noiseCanvas;
  }

  function evalT(layer, t) {
    const p = layer.props;
    return { pos: evalProp(p.position, t), scale: evalProp(p.scale, t), rot: getEffectiveRotation(layer, t), opacity: evalProp(p.opacity, t), anchor: evalProp(p.anchor, t) };
  }
  function evalFx(fx, t) { const out = {}; for (const k in fx.params) out[k] = evalProp(fx.params[k], t); return out; }

  function filterString(layer, t) {
    const parts = [];
    for (const fx of layer.effects) {
      if (!fx.enabled) continue;
      const def = EFFECTS[fx.type];
      if (def && def.css) parts.push(def.css(evalFx(fx, t)));
    }
    return parts.length ? parts.join(" ") : "none";
  }
  function isActive(layer, t, ignoreVisible) {
    return (ignoreVisible || layer.visible) && t >= layer.inPoint && t < layer.outPoint + 1e-9;
  }

  /* effective time at which to render a layer's content */
  function contentT(layer, t) {
    if (layer.holdFrame) return layer.inPoint;
    if (layer.posterizeTime && layer.posterizeTimeFPS > 0) {
      const fps = layer.posterizeTimeFPS;
      return Math.floor(t * fps) / fps;
    }
    return t;
  }

  /* ── pixel-op helpers ── */
  function applyLUT(bctx, W, H, lut) {
    const img = bctx.getImageData(0, 0, W, H); const d = img.data;
    for (let i = 0; i < d.length; i += 4) { d[i] = lut[d[i]]; d[i+1] = lut[d[i+1]]; d[i+2] = lut[d[i+2]]; }
    bctx.putImageData(img, 0, 0);
  }
  function buildLUT(fn) { const lut = new Uint8ClampedArray(256); for (let i = 0; i < 256; i++) lut[i] = clamp(Math.round(fn(i)), 0, 255); return lut; }

  function fillStyleFor(ctx, d, w, h, isShape) {
    const c1 = isShape ? d.fill : d.color, type = d.fillType || "solid";
    if (type === "solid" || (!d.color2 && !d.fill2)) return c1;
    const c2 = isShape ? (d.fill2 || c1) : (d.color2 || c1);
    if (type === "radial") { const g = ctx.createRadialGradient(0,0,0,0,0,Math.max(w,h)/2); g.addColorStop(0,c1); g.addColorStop(1,c2); return g; }
    if (type === "linear") { const a = ((d.gradAngle||0)*Math.PI)/180, r=Math.max(w,h)/2, g=ctx.createLinearGradient(-Math.cos(a)*r,-Math.sin(a)*r,Math.cos(a)*r,Math.sin(a)*r); g.addColorStop(0,c1); g.addColorStop(1,c2); return g; }
    return c1;
  }

  function drawText(ctx, layer, t) {
    const d = layer.data;
    ctx.font = `${d.weight} ${d.size}px ${d.font}`;
    ctx.textBaseline = "middle";
    const txt = d.caps ? String(d.text || "").toUpperCase() : String(d.text || "");
    const lines = txt.split("\n"), lh = d.size * (d.lineHeight || 1.2);
    const y0 = -((lines.length - 1) / 2) * lh;
    const [W] = contentSize(layer);
    if (d.tracking) ctx.letterSpacing = `${d.tracking}px`;
    let prog = 1;
    if (d.reveal && d.reveal !== "none") { const local = t - layer.inPoint - (d.revealStart || 0); prog = clamp(local / Math.max(0.01, d.revealDur || 1), 0, 1); }
    const totalChars = lines.reduce((n, l) => n + l.length, 0) || 1;
    let drawnChars = 0;
    lines.forEach((line, li) => {
      const y = y0 + li * lh; let x;
      const lineW = (() => { _measureCtx.font = ctx.font; return _measureCtx.measureText(line).width + (d.tracking||0)*Math.max(0,line.length-1); })();
      if (d.align === "left") { ctx.textAlign = "left"; x = -W/2; }
      else if (d.align === "right") { ctx.textAlign = "right"; x = W/2; }
      else { ctx.textAlign = "center"; x = 0; }
      const paint = (str, px) => {
        ctx.fillStyle = d.color; ctx.fillText(str, px, y);
        if (d.strokeWidth > 0) { ctx.strokeStyle = d.strokeColor||"#000"; ctx.lineWidth = d.strokeWidth; ctx.lineJoin = "round"; ctx.strokeText(str, px, y); }
      };
      if (!d.reveal || d.reveal === "none" || prog >= 1) { paint(line, x); }
      else if (d.reveal === "typewriter") {
        const n = clamp(Math.floor(prog*totalChars)-drawnChars, 0, line.length);
        if (n > 0) paint(line.slice(0, n), d.align==="center" ? -lineW/2 : x);
      } else {
        ctx.save(); ctx.textAlign = "left";
        let cx2 = d.align==="left" ? -W/2 : d.align==="right" ? W/2-lineW : -lineW/2;
        for (let i = 0; i < line.length; i++) {
          const cp = clamp((prog*(totalChars+6)-(drawnChars+i))/6, 0, 1);
          const chW = _measureCtx.measureText(line[i]).width + (d.tracking||0);
          if (cp > 0) {
            ctx.globalAlpha = cp;
            const dy = d.reveal==="risechar" ? (1-cp)*d.size*0.5 : 0;
            ctx.fillStyle = d.color; ctx.fillText(line[i], cx2, y+dy);
            if (d.strokeWidth > 0) { ctx.strokeStyle = d.strokeColor||"#000"; ctx.lineWidth = d.strokeWidth; ctx.strokeText(line[i], cx2, y+dy); }
          }
          cx2 += chW;
        }
        ctx.restore();
      }
      drawnChars += line.length;
    });
    if (d.tracking) ctx.letterSpacing = "0px";
  }

  function drawShapePath(ctx, d) {
    const w = d.w, h = d.h;
    ctx.beginPath();
    if (d.shape === "rect") {
      const r = clamp(d.radius||0, 0, Math.min(w,h)/2);
      if (ctx.roundRect) ctx.roundRect(-w/2,-h/2,w,h,r); else ctx.rect(-w/2,-h/2,w,h);
    } else if (d.shape === "ellipse") {
      ctx.ellipse(0,0,w/2,h/2,0,0,Math.PI*2);
    } else if (d.shape === "polygon" || d.shape === "star") {
      const n = Math.max(3, d.points|0), R = Math.min(w,h)/2, r2 = R*clamp(d.inset||0.5,0.05,0.95);
      const steps = d.shape==="star" ? n*2 : n;
      for (let i=0; i<steps; i++) {
        const rad = d.shape==="star" ? (i%2===0?R:r2):R, a=(i/steps)*Math.PI*2-Math.PI/2;
        i===0 ? ctx.moveTo(Math.cos(a)*rad,Math.sin(a)*rad) : ctx.lineTo(Math.cos(a)*rad,Math.sin(a)*rad);
      }
      ctx.closePath();
    }
  }

  function drawContent(ctx, layer, t, opts) {
    const d = layer.data;
    switch (layer.type) {
      case "solid": {
        ctx.fillStyle = fillStyleFor(ctx, d, d.w, d.h, false);
        ctx.fillRect(-d.w/2,-d.h/2,d.w,d.h); break;
      }
      case "text": drawText(ctx, layer, t); break;
      case "shape": {
        const w = d.w, h = d.h;
        const numRepeats = Math.max(1, Math.round(d.repeatCount||1));
        for (let ri = 0; ri < numRepeats; ri++) {
          ctx.save();
          if (numRepeats > 1) {
            const ox = (ri - (numRepeats-1)/2) * (d.repeatOffsetX||0);
            const oy = (ri - (numRepeats-1)/2) * (d.repeatOffsetY||0);
            const rrot = (ri - (numRepeats-1)/2) * ((d.repeatRotation||0)*Math.PI/180);
            const rs = Math.pow((d.repeatScale||100)/100, ri);
            ctx.translate(ox, oy); ctx.rotate(rrot); ctx.scale(rs, rs);
            ctx.globalAlpha *= Math.pow((d.repeatOpacity||100)/100, ri);
          }
          if (d.trimEnabled && d.stroke && d.strokeWidth > 0) {
            const s = clamp(d.trimStart/100, 0, 1), e = clamp(d.trimEnd/100, 0, 1);
            const off = ((d.trimOffset||0)/360);
            const start = ((s + off) % 1) * Math.PI * 2, end = ((e + off) % 1) * Math.PI * 2;
            ctx.beginPath();
            if (d.shape === "ellipse") ctx.ellipse(0,0,w/2,h/2,0,start,end);
            else { drawShapePath(ctx, d); } // fallback for non-ellipse
            ctx.strokeStyle = d.stroke; ctx.lineWidth = d.strokeWidth; ctx.stroke();
          } else {
            drawShapePath(ctx, d);
            if (d.fill) { ctx.fillStyle = fillStyleFor(ctx, d, w, h, true); ctx.fill(); }
            if (d.stroke && d.strokeWidth > 0) { ctx.strokeStyle = d.stroke; ctx.lineWidth = d.strokeWidth; ctx.stroke(); }
          }
          ctx.restore();
        }
        break;
      }
      case "image": case "video": {
        const a = Assets.find(d.assetId);
        if (a && a.el) {
          const w = a.el.naturalWidth||a.el.videoWidth, h = a.el.naturalHeight||a.el.videoHeight;
          if (w) { if (layer.type==="video") syncVideo(a.el, layer, t); try { ctx.drawImage(a.el,-w/2,-h/2); } catch(e) {} break; }
        }
        ctx.fillStyle = "#1b1d22"; ctx.fillRect(-200,-150,400,300);
        ctx.fillStyle="#5e636e"; ctx.font="500 22px Inter,sans-serif"; ctx.textAlign="center"; ctx.textBaseline="middle"; ctx.fillText("Missing media",0,0);
        break;
      }
      case "comp": {
        const inner = Comps.find(d.compId);
        if (!inner || (opts.visited&&opts.visited.has(inner.id)) || (opts.depth||0)>5) break;
        const q = opts.scale||1;
        const nt = clamp(mediaTime(layer, t), 0, inner.duration);
        const pool = getPool((opts.depth||0)+1, Math.max(2,Math.round(inner.width*q)), Math.max(2,Math.round(inner.height*q)));
        const visited = new Set(opts.visited||[]); visited.add(inner.id);
        drawComp(pool.outCtx, inner, nt, { scale:q, depth:(opts.depth||0)+1, visited, collapse: layer.collapseTransform });
        ctx.drawImage(pool.out,-inner.width/2,-inner.height/2,inner.width,inner.height);
        break;
      }
      case "adjust": case "nullobj": case "audio": break;
    }
  }

  function syncVideo(el, layer, t) {
    const localT = mediaTime(layer, t);
    if (App.playing) {
      el.playbackRate = clamp((App.speed||1)*100/(layer.stretch||100), 0.25, 4);
      if (el.paused && !layer.reverse) { el.currentTime = clamp(localT,0,el.duration||0); el.play().catch(()=>{}); }
      if (layer.reverse) { const want = clamp(localT,0,(el.duration||0)-0.001); if (Math.abs(el.currentTime-want)>0.06) el.currentTime=want; }
    } else {
      if (!el.paused) el.pause();
      const want = clamp(localT,0,(el.duration||0)-0.001);
      if (Math.abs(el.currentTime-want)>0.06) el.currentTime=want;
    }
  }

  function pauseAllVideos() {
    (App.project.assets||[]).forEach(a => { if ((a.type==="video"||a.type==="audio")&&a.el&&!a.el.paused) a.el.pause(); });
  }

  /* ── op effects ── */
  function applyOps(buf, bctx, pool, layer, t, q, opts) {
    const W = buf.width, H = buf.height;
    for (const fx of layer.effects) {
      if (!fx.enabled) continue;
      const def = EFFECTS[fx.type]; if (!def||!def.op) continue;
      const p = evalFx(fx, t);
      const aux = pool.aux2, actx = pool.aux2Ctx;

      switch (def.op) {
        case "glow": {
          actx.clearRect(0,0,W,H); actx.save();
          actx.filter = `blur(${p.radius*q}px) brightness(${p.intensity}%)`; actx.drawImage(buf,0,0); actx.restore();
          bctx.save(); bctx.globalCompositeOperation="lighter"; bctx.drawImage(aux,0,0); bctx.restore(); break;
        }
        case "tint": case "fill": {
          actx.clearRect(0,0,W,H); actx.drawImage(buf,0,0);
          actx.save(); actx.globalCompositeOperation="source-in"; actx.fillStyle=fx.color||"#fff"; actx.fillRect(0,0,W,H); actx.restore();
          bctx.save(); bctx.globalAlpha=clamp(p.amount/100,0,1); bctx.drawImage(aux,0,0); bctx.restore(); break;
        }
        case "vignette": {
          bctx.save(); bctx.globalCompositeOperation="source-atop";
          const r=Math.hypot(W,H)/2, g=bctx.createRadialGradient(W/2,H/2,r*clamp(p.size,1,200)/150,W/2,H/2,r);
          g.addColorStop(0,"rgba(0,0,0,0)"); g.addColorStop(1,`rgba(0,0,0,${clamp(p.amount/100,0,1)})`);
          bctx.fillStyle=g; bctx.fillRect(0,0,W,H); bctx.restore(); break;
        }
        case "noise": {
          bctx.save(); bctx.globalCompositeOperation="overlay"; bctx.globalAlpha=clamp(p.amount/100,0,1);
          bctx.fillStyle=bctx.createPattern(getNoise(),"repeat"); bctx.fillRect(0,0,W,H); bctx.restore(); break;
        }
        case "pixelate": {
          const block=Math.max(1,p.size*q); if (block<=1) break;
          const sw=Math.max(1,Math.round(W/block)), sh=Math.max(1,Math.round(H/block));
          actx.clearRect(0,0,W,H); actx.imageSmoothingEnabled=false; actx.drawImage(buf,0,0,sw,sh);
          bctx.save(); bctx.clearRect(0,0,W,H); bctx.imageSmoothingEnabled=false; bctx.drawImage(aux,0,0,sw,sh,0,0,W,H); bctx.imageSmoothingEnabled=true; bctx.restore(); break;
        }
        case "chroma": {
          const d2=p.amount*q; if (d2<0.1) break;
          actx.clearRect(0,0,W,H); actx.drawImage(buf,0,0);
          bctx.save(); bctx.clearRect(0,0,W,H);
          [["#ff0000",-d2],["#00ff00",0],["#0000ff",d2]].forEach(([col,dx]) => {
            const m=pool.mask, mctx=pool.maskCtx; mctx.clearRect(0,0,W,H); mctx.drawImage(aux,0,0);
            mctx.save(); mctx.globalCompositeOperation="multiply"; mctx.fillStyle=col; mctx.fillRect(0,0,W,H); mctx.restore();
            mctx.save(); mctx.globalCompositeOperation="destination-in"; mctx.drawImage(aux,0,0); mctx.restore();
            bctx.globalCompositeOperation="lighter"; bctx.drawImage(m,dx,0);
          }); bctx.restore(); break;
        }
        case "linearwipe": {
          const c=clamp(p.completion/100,0,1); if (c<=0) break;
          const a=((p.angle-90)*Math.PI)/180, dx=Math.cos(a), dy=Math.sin(a);
          const cors=[[0,0],[W,0],[0,H],[W,H]], projs=cors.map(([x,y])=>x*dx+y*dy);
          const pmin=Math.min(...projs), pmax=Math.max(...projs), cut=pmin+(pmax-pmin)*c;
          const f=Math.max(0.01,p.feather*q), g=bctx.createLinearGradient(dx*(cut-f),dy*(cut-f),dx*cut,dy*cut);
          g.addColorStop(0,"rgba(0,0,0,0)"); g.addColorStop(1,"rgba(0,0,0,1)");
          bctx.save(); bctx.globalCompositeOperation="destination-out"; bctx.fillStyle=g; bctx.fillRect(0,0,W,H); bctx.restore(); break;
        }
        case "circwipe": {
          const c=clamp(p.completion/100,0,1); if (c<=0) break;
          const maxR=Math.hypot(W,H)/2, R=(1-c)*maxR, f=Math.max(0.01,p.feather*q);
          const g=bctx.createRadialGradient(W/2,H/2,Math.max(0,R-f),W/2,H/2,Math.max(0.01,R));
          g.addColorStop(0,"rgba(0,0,0,0)"); g.addColorStop(1,"rgba(0,0,0,1)");
          bctx.save(); bctx.globalCompositeOperation="destination-out"; bctx.fillStyle=g; bctx.fillRect(0,0,W,H);
          bctx.beginPath(); bctx.rect(0,0,W,H); bctx.arc(W/2,H/2,Math.max(0.01,R),0,Math.PI*2,true); bctx.fill(); bctx.restore(); break;
        }

        /* ── new v3 effects ── */
        case "levels": {
          const ib=p.inBlack, iw=Math.max(ib+2,p.inWhite), g=Math.max(0.01,p.gamma), ob=p.outBlack, ow=p.outWhite;
          const lut = buildLUT(i => { const n=clamp((i-ib)/(iw-ib),0,1), gc=Math.pow(n,1/g); return ob+gc*(ow-ob); });
          applyLUT(bctx, W, H, lut); break;
        }
        case "curves": {
          const lut = buildLUT(i => {
            const n = i / 255;
            const s = p.shadows / 100, m = p.midtones / 100, h2 = p.highlights / 100;
            const shadow = n < 0.33 ? s * (1 - n / 0.33) : 0;
            const mid = n > 0.2 && n < 0.8 ? m * Math.sin(Math.PI * (n - 0.2) / 0.6) : 0;
            const hi = n > 0.67 ? h2 * ((n - 0.67) / 0.33) : 0;
            return (n + shadow + mid + hi) * 255;
          });
          applyLUT(bctx, W, H, lut); break;
        }
        case "colorbalance": {
          const img = bctx.getImageData(0,0,W,H); const d2=img.data;
          for (let i=0; i<d2.length; i+=4) {
            const r2=d2[i]/255, g2=d2[i+1]/255, b2=d2[i+2]/255;
            const luma = 0.2126*r2+0.7152*g2+0.0722*b2;
            const isS=luma<0.33, isH=luma>0.67;
            const sc = isS?1:(luma<0.5?2*(0.5-luma):0), mc=isS?0:(isH?0:1), hc=isH?1:(luma>0.5?2*(luma-0.5):0);
            d2[i]   = clamp(d2[i]  +(p.shadowR*sc+p.midR*mc+p.hiR*hc)*255/100,0,255);
            d2[i+1] = clamp(d2[i+1]+(p.shadowG*sc+p.midG*mc+p.hiG*hc)*255/100,0,255);
            d2[i+2] = clamp(d2[i+2]+(p.shadowB*sc+p.midB*mc+p.hiB*hc)*255/100,0,255);
          }
          bctx.putImageData(img,0,0); break;
        }
        case "hslpro": {
          const img=bctx.getImageData(0,0,W,H); const d2=img.data;
          for (let i=0; i<d2.length; i+=4) {
            let [h2,s2,v2]=rgbToHsv(d2[i],d2[i+1],d2[i+2]);
            h2=(h2+(p.hue/360)+1)%1; s2=clamp(s2+(p.sat/100),0,1); v2=clamp(v2+(p.light/100),0,1);
            const [r2,g2,b2]=hsvToRgb(h2,s2,v2); d2[i]=r2; d2[i+1]=g2; d2[i+2]=b2;
          }
          bctx.putImageData(img,0,0); break;
        }
        case "chromakey": {
          const [kr,kg,kb]=hexToRgb(fx.color||"#00ff00");
          const [kh,ks]=rgbToHsv(kr,kg,kb);
          const tol=p.tolerance/100*0.6, edge=Math.max(0.001,p.edge/100*0.2), spill=p.spill/100;
          const img=bctx.getImageData(0,0,W,H); const d2=img.data;
          for (let i=0; i<d2.length; i+=4) {
            const [h2,s2]=rgbToHsv(d2[i],d2[i+1],d2[i+2]);
            let hdiff=Math.abs(h2-kh); if(hdiff>0.5) hdiff=1-hdiff;
            const dist=hdiff*0.7+Math.abs(s2-ks)*0.3;
            if (dist<tol+edge) {
              d2[i+3]=Math.round(clamp((dist-tol)/edge,0,1)*d2[i+3]);
              if (spill>0&&d2[i+1]>d2[i]) d2[i+1]=Math.max(d2[i],Math.round(d2[i+1]-(d2[i+1]-d2[i])*spill));
            }
          }
          bctx.putImageData(img,0,0); break;
        }
        case "sharpen": {
          const a=p.amount/100; if(a<0.01) break;
          actx.clearRect(0,0,W,H); actx.drawImage(buf,0,0);
          actx.save(); actx.filter=`blur(1px)`; actx.drawImage(buf,0,0); actx.restore();
          bctx.save(); bctx.globalAlpha=a*(1+a); bctx.drawImage(buf,0,0); bctx.restore();
          bctx.save(); bctx.globalAlpha=a; bctx.globalCompositeOperation="difference"; bctx.drawImage(aux,0,0); bctx.restore();
          break;
        }
        case "threshold": {
          const lut=buildLUT(i=>i<p.level?0:255); applyLUT(bctx,W,H,lut); break;
        }
        case "posterize": {
          const lvl=Math.max(2,Math.round(p.levels));
          const lut=buildLUT(i=>Math.round(Math.round(i/255*(lvl-1))/(lvl-1)*255));
          applyLUT(bctx,W,H,lut); break;
        }
        case "exposure": {
          const mult=Math.pow(2,p.exposure), g=Math.max(0.01,p.gamma), ped=p.pedestal;
          const lut=buildLUT(i=>Math.pow(clamp(i/255*mult+ped,0,1),1/g)*255);
          applyLUT(bctx,W,H,lut); break;
        }
        case "colorize": {
          const [cr,cg,cb]=hexToRgb(fx.color||"#5e6ad2");
          const [ch,cs]=rgbToHsv(cr,cg,cb);
          const amt=p.amount/100, lightAdj=p.lightness/100;
          const img=bctx.getImageData(0,0,W,H); const d2=img.data;
          for (let i=0; i<d2.length; i+=4) {
            const [,, v2]=rgbToHsv(d2[i],d2[i+1],d2[i+2]);
            const [r2,g2,b2]=hsvToRgb(ch,cs,clamp(v2+lightAdj,0,1));
            d2[i]  =Math.round(d2[i]*(1-amt)+r2*amt);
            d2[i+1]=Math.round(d2[i+1]*(1-amt)+g2*amt);
            d2[i+2]=Math.round(d2[i+2]*(1-amt)+b2*amt);
          }
          bctx.putImageData(img,0,0); break;
        }
        case "fracnoise": {
          const evo=p.evolution||0, scl=Math.max(1,p.scale*q), cmpl=Math.round(p.complexity||4);
          const con=(p.contrast||100)/100, bright=(p.brightness||0)/100, opa=(p.opacity||100)/100;
          if (W*H > 1500000) break; // skip at very high res to avoid lockup
          const imgData=actx.createImageData(W,H); const d2=imgData.data;
          for (let y=0; y<H; y++) {
            for (let x=0; x<W; x++) {
              let v=0, amp=1, freq=1, total=0;
              for (let o=0; o<cmpl; o++) {
                v += noise2(1+o*100, (x/scl+evo)*freq, (y/scl+evo*0.7)*freq) * amp;
                total+=amp; amp*=0.5; freq*=2;
              }
              v=v/total;
              const val=clamp(Math.round((v*con+bright+0.5)*255),0,255);
              const idx=(y*W+x)*4; d2[idx]=d2[idx+1]=d2[idx+2]=val; d2[idx+3]=255;
            }
          }
          actx.putImageData(imgData,0,0);
          bctx.save(); bctx.globalCompositeOperation="overlay"; bctx.globalAlpha=opa; bctx.drawImage(aux,0,0); bctx.restore(); break;
        }
        case "turbdisplace": {
          const amt=p.amount*q, sz=Math.max(1,p.size*q), evo=p.evolution||0;
          if (amt<0.5 || W*H>1000000) break;
          actx.clearRect(0,0,W,H); actx.drawImage(buf,0,0);
          const src=actx.getImageData(0,0,W,H), dst=bctx.createImageData(W,H);
          const sd=src.data, dd=dst.data;
          for (let y=0; y<H; y++) {
            for (let x=0; x<W; x++) {
              const nx=x/sz+evo*0.3, ny=y/sz+evo*0.2;
              const dx=Math.round(noise1(1,nx+ny*3.14)*amt), dy=Math.round(noise1(2,ny+nx*2.71)*amt);
              const sx2=clamp(x+dx,0,W-1), sy2=clamp(y+dy,0,H-1);
              const si=(sy2*W+sx2)*4, di=(y*W+x)*4;
              dd[di]=sd[si]; dd[di+1]=sd[si+1]; dd[di+2]=sd[si+2]; dd[di+3]=sd[si+3];
            }
          }
          bctx.putImageData(dst,0,0); break;
        }
        case "directblur": {
          const steps=Math.min(16,Math.max(4,Math.round(p.amount*q/3))), dist=p.amount*q;
          if (dist<0.5) break;
          const angle=((p.angle||0)*Math.PI)/180;
          actx.clearRect(0,0,W,H); actx.drawImage(buf,0,0);
          bctx.clearRect(0,0,W,H);
          for (let s=0; s<steps; s++) {
            const tt=(s/(steps-1)-0.5)*2, dx=Math.cos(angle)*dist*tt, dy=Math.sin(angle)*dist*tt;
            bctx.save(); bctx.globalAlpha=1/steps; bctx.drawImage(aux,dx,dy); bctx.restore();
          }
          break;
        }
        case "radialblur": {
          const steps=8, amt=p.amount/100*0.5; if(amt<0.001) break;
          actx.clearRect(0,0,W,H); actx.drawImage(buf,0,0);
          bctx.clearRect(0,0,W,H);
          for (let s=0; s<steps; s++) {
            const tt=s/steps;
            if (p.zoomSpin<0.5) { // zoom
              const sc=1+(tt-0.5)*amt, tx=W/2*(1-sc), ty=H/2*(1-sc);
              bctx.save(); bctx.globalAlpha=1/steps; bctx.setTransform(sc,0,0,sc,tx,ty); bctx.drawImage(aux,0,0); bctx.restore();
            } else { // spin
              const ang=(tt-0.5)*amt;
              bctx.save(); bctx.globalAlpha=1/steps; bctx.translate(W/2,H/2); bctx.rotate(ang); bctx.translate(-W/2,-H/2); bctx.drawImage(aux,0,0); bctx.restore();
            }
          }
          break;
        }
        case "mirror": {
          const angle=((p.angle||0)*Math.PI)/180;
          const cx2=(p.center||50)/100*W, cy2=H/2;
          actx.clearRect(0,0,W,H); actx.drawImage(buf,0,0);
          bctx.save(); bctx.translate(cx2*2,0); bctx.scale(-1,1);
          bctx.drawImage(aux,0,0); bctx.restore();
          if (Math.abs(angle)>0.01) {
            actx.clearRect(0,0,W,H); actx.drawImage(buf,0,0);
            bctx.save(); bctx.translate(W/2,H/2); bctx.rotate(angle); bctx.translate(-W/2,-H/2);
            bctx.drawImage(aux,0,0); bctx.restore();
          }
          break;
        }
        case "echo": {
          const echoes=Math.min(8,Math.round(p.echoes)), decay=p.decay/100, offset=p.offset*q;
          if (echoes<1) break;
          actx.clearRect(0,0,W,H); actx.drawImage(buf,0,0);
          for (let e=1; e<=echoes; e++) {
            const alpha=Math.pow(decay,e); if(alpha<0.01) break;
            bctx.save(); bctx.globalAlpha=alpha; bctx.globalCompositeOperation="source-over";
            bctx.drawImage(aux, offset*e, offset*e); bctx.restore();
          }
          break;
        }
        case "ripple": {
          const amt=p.amount*q, freq=(p.freq||20), phase=((p.phase||0)*Math.PI)/180;
          if (amt<0.5 || W*H>800000) break;
          actx.clearRect(0,0,W,H); actx.drawImage(buf,0,0);
          const src=actx.getImageData(0,0,W,H), dst=bctx.createImageData(W,H);
          const sd=src.data, dd=dst.data;
          const axis=Math.round(p.axis||0);
          for (let y=0; y<H; y++) {
            for (let x=0; x<W; x++) {
              let sx2=x, sy2=y;
              if (axis===0||axis===2) sx2=x+Math.round(Math.sin(y/H*freq*Math.PI+phase)*amt);
              if (axis===1||axis===2) sy2=y+Math.round(Math.sin(x/W*freq*Math.PI+phase)*amt);
              sx2=clamp(sx2,0,W-1); sy2=clamp(sy2,0,H-1);
              const si=(sy2*W+sx2)*4, di=(y*W+x)*4;
              dd[di]=sd[si]; dd[di+1]=sd[si+1]; dd[di+2]=sd[si+2]; dd[di+3]=sd[si+3];
            }
          }
          bctx.putImageData(dst,0,0); break;
        }
        case "shake": {
          const amt=p.amount*q, spd=p.speed||8, rot=p.rotation||0;
          actx.clearRect(0,0,W,H); actx.drawImage(buf,0,0);
          const ox=noise1(99, t*spd)*amt, oy=noise1(98, t*spd+0.5)*amt, or2=noise1(97, t*spd+1)*rot*Math.PI/180;
          bctx.clearRect(0,0,W,H);
          bctx.save(); bctx.translate(W/2+ox,H/2+oy); bctx.rotate(or2); bctx.translate(-W/2,-H/2);
          bctx.drawImage(aux,0,0); bctx.restore(); break;
        }
      }
    }
  }

  function applyMasks(buf, bctx, pool, layer, t, q) {
    if (!layer.masks.length) return;
    const W=buf.width, H=buf.height, mctx=pool.maskCtx;
    mctx.clearRect(0,0,W,H);
    const M=worldMatrix(layer, t);
    layer.masks.forEach(mask => {
      mctx.save(); mctx.setTransform(q*M[0],q*M[1],q*M[2],q*M[3],q*M[4],q*M[5]);
      if (mask.feather>0) mctx.filter=`blur(${mask.feather*q}px)`;
      mctx.globalCompositeOperation = mask.mode==="subtract" ? "destination-out" : "source-over";
      mctx.fillStyle="#fff"; mctx.beginPath();
      if (mask.shape==="ellipse") {
        mctx.ellipse(mask.x,mask.y,mask.w/2,mask.h/2,0,0,Math.PI*2);
      } else if (mask.shape==="path" && mask.points && mask.points.length>1) {
        const pts=mask.points;
        mctx.moveTo(pts[0].x, pts[0].y);
        for (let i=0; i<pts.length; i++) {
          const c=pts[i], n=pts[(i+1)%pts.length];
          mctx.bezierCurveTo(c.cpOut.x,c.cpOut.y, n.cpIn.x,n.cpIn.y, n.x,n.y);
        }
        if (mask.closed!==false) mctx.closePath();
      } else {
        mctx.rect(mask.x-mask.w/2,mask.y-mask.h/2,mask.w,mask.h);
      }
      mctx.fill(); mctx.restore();
    });
    bctx.save(); bctx.globalCompositeOperation="destination-in"; bctx.setTransform(1,0,0,1,0,0); bctx.drawImage(pool.mask,0,0); bctx.restore();
  }

  function renderLayerBuffer(pool, layer, comp, t, opts) {
    const q=opts.scale||1, buf=pool.tmp, bctx=pool.tmpCtx, W=buf.width, H=buf.height;
    bctx.save(); bctx.setTransform(1,0,0,1,0,0); bctx.clearRect(0,0,W,H); bctx.restore();
    const ct = contentT(layer, t);
    const mb=comp.motionBlur&&layer.motionBlur, samples=mb?6:1, shutter=0.5/comp.fps;
    for (let s=0; s<samples; s++) {
      const ts=samples===1?t:t-shutter/2+(shutter*s)/(samples-1);
      const M=worldMatrix(layer, ts);
      bctx.save(); bctx.globalAlpha=1/samples;
      bctx.setTransform(q*M[0],q*M[1],q*M[2],q*M[3],q*M[4],q*M[5]);
      const rx=(evalProp(layer.props.rotationX,ts)||0)*Math.PI/180;
      const ry=(evalProp(layer.props.rotationY,ts)||0)*Math.PI/180;
      if (Math.abs(rx)>0.001||Math.abs(ry)>0.001) {
        const cosX=Math.cos(rx), cosY=Math.cos(ry), sinX=Math.sin(rx), sinY=Math.sin(ry);
        bctx.transform(cosY, sinX*sinY*0.5, sinY*0.5, cosX, 0, 0);
      }
      drawContent(bctx, layer, ct, opts);
      bctx.restore();
    }
    applyMasks(buf, bctx, pool, layer, t, q);
    applyOps(buf, bctx, pool, layer, t, q, opts);
    return buf;
  }

  function renderMatte(pool, layer, comp, t, opts) {
    const q=opts.scale||1, buf=pool.aux, bctx=pool.auxCtx;
    bctx.save(); bctx.setTransform(1,0,0,1,0,0); bctx.clearRect(0,0,buf.width,buf.height);
    const M=worldMatrix(layer, t);
    bctx.globalAlpha=clamp(evalProp(layer.props.opacity,t)/100,0,1);
    bctx.setTransform(q*M[0],q*M[1],q*M[2],q*M[3],q*M[4],q*M[5]);
    drawContent(bctx, layer, contentT(layer, t), opts);
    bctx.restore();
    applyMasks(buf, bctx, pool, layer, t, q);
    return buf;
  }

  function lumaToAlpha(buf, bctx, invert) {
    const W=buf.width, H=buf.height, img=bctx.getImageData(0,0,W,H), d=img.data;
    for (let i=0; i<d.length; i+=4) {
      let luma=(0.2126*d[i]+0.7152*d[i+1]+0.0722*d[i+2])/255 * d[i+3]/255;
      d[i+3]=(invert?1-luma:luma)*255;
    }
    bctx.putImageData(img,0,0);
  }

  function drawComp(ctx, comp, t, opts = {}) {
    const q=opts.scale||1, depth=opts.depth||0;
    const W=Math.max(2,Math.round(comp.width*q)), H=Math.max(2,Math.round(comp.height*q));
    const pool=getPool(depth,W,H);
    ctx.save(); ctx.setTransform(1,0,0,1,0,0); ctx.clearRect(0,0,ctx.canvas.width,ctx.canvas.height);
    if (!comp.bgAlpha) { ctx.fillStyle=comp.bg; ctx.fillRect(0,0,W,H); }
    const layers=comp.layers;
    const soloSet=new Set(layers.filter(l=>l.solo).map(l=>l.id));
    const consumed=new Set();
    layers.forEach((l,i) => { if (l.matte!=="none"&&layers[i-1]) consumed.add(layers[i-1].id); });
    for (let i=layers.length-1; i>=0; i--) {
      const layer=layers[i];
      if (layer.type==="audio"||layer.type==="nullobj") continue;
      if (consumed.has(layer.id)) continue;
      if (soloSet.size&&!soloSet.has(layer.id)) continue;
      if (!isActive(layer,t)) continue;
      const opacity=evalProp(layer.props.opacity,t);
      if (opacity<=0) continue;
      if (layer.type==="adjust") {
        const f=filterString(layer,t);
        const hasOps=layer.effects.some(fx=>fx.enabled&&EFFECTS[fx.type]&&EFFECTS[fx.type].op);
        if (f==="none"&&!hasOps) continue;
        const actx=pool.auxCtx;
        actx.save(); actx.setTransform(1,0,0,1,0,0); actx.clearRect(0,0,W,H);
        actx.filter=f; actx.drawImage(ctx.canvas,0,0,W,H,0,0,W,H); actx.restore();
        const fakePool={...pool,tmp:pool.aux,tmpCtx:pool.auxCtx};
        applyOps(pool.aux,pool.auxCtx,fakePool,layer,t,q,opts);
        if (layer.masks.length) applyMasks(pool.aux,pool.auxCtx,pool,layer,t,q);
        ctx.save(); ctx.globalAlpha=clamp(opacity/100,0,1); ctx.drawImage(pool.aux,0,0); ctx.restore();
        continue;
      }
      const buf=renderLayerBuffer(pool,layer,comp,t,opts);
      if (layer.matte!=="none"&&layers[i-1]) {
        const matteLayer=layers[i-1];
        if (isActive(matteLayer,t,true)) {
          const mbuf=renderMatte(pool,matteLayer,comp,t,opts);
          const inv=layer.matte.endsWith("-inv");
          if (layer.matte.startsWith("luma")) lumaToAlpha(mbuf,pool.auxCtx,inv);
          const btx=pool.tmpCtx; btx.save(); btx.setTransform(1,0,0,1,0,0);
          btx.globalCompositeOperation=(layer.matte.startsWith("alpha")&&inv)?"destination-out":"destination-in";
          btx.drawImage(mbuf,0,0); btx.restore();
        } else if (!layer.matte.endsWith("-inv")) continue;
      }
      ctx.save(); ctx.globalAlpha=clamp(opacity/100,0,1); ctx.globalCompositeOperation=layer.blend||"source-over";
      ctx.filter=filterString(layer,t); ctx.drawImage(buf,0,0); ctx.restore();
    }
    ctx.restore();
  }

  function draw(ctx, t, opts = {}) {
    if (!opts.skipRam && typeof RamPreview !== "undefined" && RamPreview.has(t)) {
      const bm = RamPreview.getFrame(t);
      if (bm) { ctx.save(); ctx.setTransform(1,0,0,1,0,0); ctx.clearRect(0,0,ctx.canvas.width,ctx.canvas.height); ctx.drawImage(bm,0,0,ctx.canvas.width,ctx.canvas.height); ctx.restore(); return; }
    }
    drawComp(ctx, App.comp, t, opts);
  }

  function corners(layer, t) {
    const M=worldMatrix(layer,t), [w,h]=contentSize(layer);
    return [[-w/2,-h/2],[w/2,-h/2],[w/2,h/2],[-w/2,h/2]].map(([x,y])=>matApply(M,x,y));
  }
  function toLocal(layer, t, mx, my) { return matApply(matInvert(worldMatrix(layer,t)),mx,my); }
  function hitTest(t, mx, my) {
    const selIds=App.selectedIds();
    for (const layer of App.layers) {
      if (layer.locked||layer.type==="audio") continue;
      const ghost=layer.type==="adjust"||layer.type==="nullobj";
      if (ghost&&!selIds.includes(layer.id)) continue;
      if (!isActive(layer,t,ghost)) continue;
      const [w,h]=contentSize(layer); if (w<=0) continue;
      const [lx,ly]=toLocal(layer,t,mx,my);
      if (Math.abs(lx)<=w/2&&Math.abs(ly)<=h/2) return layer;
    }
    return null;
  }

  return { draw, drawComp, evalT, evalFx, corners, toLocal, hitTest, isActive, pauseAllVideos, filterString };
})();
