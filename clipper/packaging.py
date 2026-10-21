"""Packaging: turn a factory clip into the finished product.

Starts from the factory's clean base render (reframed, no overlays) and adds the edit:
sound effects mixed into the audio, visual hits (zoom punch, shake, flash) on the frames,
the hook and captions (editable), and a trim.
"""
import difflib
import json
import subprocess

import cv2
import numpy as np

from . import captions, config, sfx
from .moments import ask_llm
from .render import _encoder_args, has_audio

FX = ("none", "zoom", "shake", "flash")
DEFAULT_FX = {"boom": "zoom", "bass_drop": "zoom", "scratch": "shake", "glitch": "shake", "error": "shake",
              "shutter": "flash"}
COLORS = tuple(captions.HIGHLIGHTS)


# ---------------------------------------------------------------- specs and words

def clip_words(words, clip):
    """Transcript words that fall inside the clip, with times relative to the clip start."""
    a, b = clip["start"], clip["end"]
    return [{"w": w["w"], "s": max(0.0, w["s"] - a), "e": min(b - a, w["e"] - a)}
            for w in words if w["e"] > a and w["s"] < b]


def default_spec(clip):
    return {"hook": clip.get("hook") or clip.get("title") or "", "hook_on": True, "captions_on": True,
            "color": "yellow", "trim": [0.0, round(clip["end"] - clip["start"], 2)], "sfx": [], "words": None}


def clean_spec(spec, duration):
    """Validate whatever the UI sent before it's saved or rendered."""
    a, b = (spec.get("trim") or [0, duration])[:2]
    a = max(0.0, min(float(a), duration - 1))
    b = max(a + 1, min(float(b), duration))
    lib = sfx.ids()
    marks = []
    for m in spec.get("sfx") or []:
        if m.get("sound") not in lib:
            continue
        marks.append({"t": round(max(0.0, min(float(m.get("t", 0)), duration)), 3), "sound": m["sound"],
                      "vol": round(max(0.0, min(float(m.get("vol", 0.8)), 1.5)), 2),
                      "fx": m.get("fx") if m.get("fx") in FX else "none"})
    words = spec.get("words")
    if words is not None:
        words = [{"w": str(w["w"]), "s": float(w["s"]), "e": float(w["e"])} for w in words][:2000]
    return {"hook": str(spec.get("hook", ""))[:120], "hook_on": bool(spec.get("hook_on", True)),
            "captions_on": bool(spec.get("captions_on", True)),
            "color": spec.get("color") if spec.get("color") in COLORS else "yellow",
            "trim": [round(a, 2), round(b, 2)], "sfx": sorted(marks, key=lambda m: m["t"]), "words": words}


def retime(words, text):
    """Apply an edited transcript: keep timings for unchanged words, spread new ones over the gap."""
    new = text.split()
    old = [w["w"].strip() for w in words]
    norm = lambda x: "".join(ch for ch in x.lower() if ch.isalnum())
    sm = difflib.SequenceMatcher(a=[norm(o) for o in old], b=[norm(n) for n in new], autojunk=False)
    out = []
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal":
            out += [{"w": " " + new[j1 + k], "s": words[i1 + k]["s"], "e": words[i1 + k]["e"]} for k in range(i2 - i1)]
        elif tag in ("replace", "insert"):
            start = words[i1]["s"] if i1 < len(words) and tag == "replace" else (out[-1]["e"] if out else 0.0)
            if i2 > i1:
                end = words[i2 - 1]["e"]
            else:
                end = words[i1]["s"] if i1 < len(words) else start + 0.3 * (j2 - j1)
            if end <= start:
                end = start + 0.25 * (j2 - j1)
            step = (end - start) / (j2 - j1)
            out += [{"w": " " + new[j1 + k], "s": start + k * step, "e": start + (k + 1) * step} for k in range(j2 - j1)]
    return out


# ---------------------------------------------------------------- visual hits

def _hit_state(t, hits):
    scale, dx, dy, flash = 1.0, 0.0, 0.0, 0.0
    for t0, fx in hits:
        d = t - t0
        if d < 0 or d > 0.9:
            continue
        if fx == "zoom":
            scale *= 1 + 0.16 * min(d / 0.06, 1.0) * np.exp(-max(0.0, d - 0.06) / 0.2)
        elif fx == "shake" and d < 0.4:
            amp = 22 * (1 - d / 0.4)
            dx += amp * np.sin(d * 97.0)
            dy += amp * np.cos(d * 71.0)
        elif fx == "flash" and d < 0.2:
            flash = max(flash, 0.85 * (1 - d / 0.2))
    return scale, dx, dy, flash


def _apply_hits(frame, state):
    scale, dx, dy, flash = state
    H, W = frame.shape[:2]
    if scale > 1.001 or abs(dx) > 0.5 or abs(dy) > 0.5:
        m = np.float32([[scale, 0, (1 - scale) * W / 2 + dx], [0, scale, (1 - scale) * H / 2 + dy]])
        frame = cv2.warpAffine(frame, m, (W, H), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)
    if flash > 0.01:
        frame = cv2.addWeighted(frame, 1 - flash, np.full_like(frame, 255), flash, 0)
    return frame


# ---------------------------------------------------------------- render

def compose(base, words, spec, layout, out, progress=None):
    a, b = spec["trim"]
    dur = b - a
    src_words = spec["words"] if spec.get("words") else words
    local = [{"w": w["w"], "s": w["s"] - a, "e": w["e"] - a} for w in src_words if w["e"] > a and w["s"] < b]
    caps = captions.Captions(local, 0.0, dur, spec["hook"] if spec["hook_on"] else "", layout,
                             show_captions=spec["captions_on"], color=spec["color"])
    marks = [m for m in spec["sfx"] if a <= m["t"] < b]
    hits = [(m["t"] - a, m["fx"]) for m in marks if m["fx"] != "none"]

    cap = cv2.VideoCapture(str(base))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    W, H = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    if a > 0:
        cap.set(cv2.CAP_PROP_POS_FRAMES, int(round(a * fps)))
    n = int(round(dur * fps))

    cmd = ["ffmpeg", "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{W}x{H}",
           "-r", f"{fps:.5f}", "-i", "-"]
    if has_audio(base):
        cmd += ["-ss", f"{a:.3f}", "-t", f"{dur:.3f}", "-i", str(base)]
    else:
        cmd += ["-f", "lavfi", "-t", f"{dur:.3f}", "-i", "anullsrc=r=48000:cl=stereo"]
    # Bring the clip to TikTok/Shorts loudness first, so effects land at a sane level on top of it
    # no matter how quiet the stream was.
    graph = ["[1:a]aresample=48000,aformat=channel_layouts=stereo,loudnorm=I=-14:TP=-2:LRA=11,aresample=48000[a0]"]
    labels = ["[a0]"]
    for j, m in enumerate(marks):
        cmd += ["-i", str(sfx.path_for(m["sound"]))]
        ms = int(round((m["t"] - a) * 1000))
        graph.append(f"[{j + 2}:a]aresample=48000,aformat=channel_layouts=stereo,volume={m['vol']},"
                     f"adelay={ms}|{ms}[s{j}]")
        labels.append(f"[s{j}]")
    graph.append("".join(labels) + f"amix=inputs={len(labels)}:normalize=0:duration=first:dropout_transition=0,"
                 "alimiter=limit=0.95[aout]")
    cmd += ["-filter_complex", ";".join(graph), "-map", "0:v", "-map", "[aout]", *_encoder_args(),
            "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-shortest", str(out)]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=subprocess.PIPE)
    i = 0
    try:
        while i < n:
            ok, frame = cap.read()
            if not ok:
                break
            t = i / fps
            if hits:
                frame = _apply_hits(frame, _hit_state(t, hits))
            caps.apply(frame, t)
            proc.stdin.write(frame.tobytes())
            i += 1
            if progress and i % 15 == 0:
                progress(i / max(n, 1))
    finally:
        cap.release()
        try:
            proc.stdin.close()
        except BrokenPipeError:
            pass
        err = proc.stderr.read().decode(errors="ignore")
        proc.wait()
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {err[-800:]}")


# ---------------------------------------------------------------- AI suggestions

SFX_PROMPT = """You are editing a {dur:.0f}-second vertical clip for TikTok/Shorts. Place sound effects the way top
clip editors do: few but well-timed. Hits land ON the moment (the punchline word, the reaction, the reveal),
never randomly. 2 to 5 sounds total. Often: a whoosh or swish at 0.0 to open, a boom on the funniest or most
shocking beat, a riser about 2 seconds before a payoff.

Available sounds:
{lib}

On-screen hook: {hook}

Transcript with word start times in seconds:
{words}

Return each placement with: t (seconds), sound (an id from the list), and reason (a few words)."""

SFX_SCHEMA = {"type": "object", "properties": {"placements": {"type": "array", "items": {
    "type": "object", "properties": {"t": {"type": "number"}, "sound": {"type": "string"}, "reason": {"type": "string"}},
    "required": ["t", "sound", "reason"]}}}, "required": ["placements"]}


def suggest_sfx(words, hook, duration):
    lib = sfx.library()
    ids = {x["id"] for x in lib}
    listing = "\n".join(f"- {x['id']}: {x['hint']}" for x in lib)
    wl = " ".join(f"[{w['s']:.1f}]{w['w'].strip()}" for w in words)[:6000]
    out = []
    try:
        r = ask_llm(SFX_PROMPT.format(dur=duration, lib=listing, hook=hook or "(none)", words=wl), SFX_SCHEMA)
        for p in r.get("placements") or r.get("clips") or []:
            snd = str(p.get("sound", "")).strip()
            if snd not in ids:
                continue
            t = max(0.0, min(float(p.get("t", 0)), duration - 0.1))
            out.append({"t": round(t, 2), "sound": snd, "vol": 0.8, "fx": DEFAULT_FX.get(snd, "none"),
                        "reason": str(p.get("reason", ""))[:80]})
    except Exception:
        out = []
    if not out:  # the LLM is down or gave nothing usable: a sane default edit
        out = [{"t": 0.0, "sound": "whoosh", "vol": 0.7, "fx": "none", "reason": "opener"}]
        enders = [w for w in words if w["w"].strip()[-1:] in "!?." and w["e"] > duration * 0.4]
        if enders:
            out.append({"t": round(enders[-1]["e"], 2), "sound": "boom", "vol": 0.85, "fx": "zoom", "reason": "payoff"})
    dedup = []
    for m in sorted(out, key=lambda m: m["t"]):
        if not dedup or m["t"] - dedup[-1]["t"] > 0.35:
            dedup.append(m)
    return dedup[:6]


# ---------------------------------------------------------------- shipping kit

SHIP_PROMPT = """Write the posting copy for this short vertical clip.

Clip hook: {hook}
What happens: {title}
Transcript: {text}
Original creator: {channel} (on {platform})
Required tags/mentions for this campaign (must appear in every caption, verbatim): {campaign}

Rules:
- Credit the original creator in every caption (e.g. "@{handle}" or their name).
- Sound like a real clip page, not a brand. Lowercase is fine. No cringe hype words.
- tiktok: one short line + 3-5 relevant hashtags, under 150 characters before hashtags.
- youtube_title: under 70 characters, curiosity-driven, end with #shorts.
- youtube_description: 1-2 lines + credit + 3 hashtags.
- instagram: 1-2 lines + credit + 5-8 hashtags.
- x: one punchy line under 200 characters + credit."""

SHIP_SCHEMA = {"type": "object", "properties": {k: {"type": "string"} for k in
               ("tiktok", "youtube_title", "youtube_description", "instagram", "x")},
               "required": ["tiktok", "youtube_title", "youtube_description", "instagram", "x"]}


def ship_kit(hook, title, text, channel, platform, campaign):
    handle = "".join(ch for ch in (channel or "") if ch.isalnum() or ch == "_") or "creator"
    try:
        kit = ask_llm(SHIP_PROMPT.format(hook=hook, title=title, text=text[:2500], channel=channel or "unknown",
                                         handle=handle, platform=platform or "stream", campaign=campaign or "(none)"),
                      SHIP_SCHEMA)
    except Exception:
        kit = {}
    credit = f"@{handle}" if channel else ""
    base = hook or title or "you have to see this"
    kit = {k: str(kit.get(k) or "").strip() for k in SHIP_SCHEMA["properties"]}
    j = lambda *parts: " ".join(x for x in parts if x)
    kit["tiktok"] = kit["tiktok"] or j(base, credit, "#fyp #clips")
    kit["youtube_title"] = kit["youtube_title"] or f"{base} #shorts"
    kit["youtube_description"] = kit["youtube_description"] or f"{base}\nCredit: {credit}\n#shorts #clips"
    kit["instagram"] = kit["instagram"] or f"{base}\n{credit}\n#reels #clips #viral"
    kit["x"] = kit["x"] or j(base, credit)
    # Credit and #shorts are non-negotiable, so they're enforced here rather than left to the model.
    if credit:
        for k in ("tiktok", "youtube_description", "instagram", "x"):
            if handle.lower() not in kit[k].lower():
                kit[k] = f"{kit[k]}\n🎥 {credit}" if k in ("youtube_description", "instagram") else f"{kit[k]} 🎥 {credit}"
    if "#shorts" not in kit["youtube_title"].lower():
        kit["youtube_title"] = f"{kit['youtube_title'][:88]} #shorts"
    if campaign:  # don't trust the model with requirements that decide whether you get paid
        for k in ("tiktok", "youtube_description", "instagram", "x"):
            if campaign not in kit[k]:
                kit[k] = f"{kit[k]} {campaign}".strip()
    return kit


def load_settings():
    try:
        return json.loads((config.DATA / "settings.json").read_text())
    except Exception:
        return {"campaign": ""}


def save_settings(d):
    (config.DATA / "settings.json").write_text(json.dumps({"campaign": str(d.get("campaign", ""))[:300]}))
