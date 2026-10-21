"""Sound effect library: a set of synthesized defaults plus whatever the user imports.

The defaults are generated here from scratch (no third-party audio), so they're ours to ship.
Drop real meme sounds (vine boom etc.) into the user folder and they show up alongside.
"""
import json
import re
import shutil
import subprocess
import threading
import wave
from pathlib import Path

import numpy as np

from . import config

SR = 44100
BUILTIN_DIR = config.DATA / "sfx" / "builtin"
USER_DIR = config.DATA / "sfx" / "user"
AUDIO_EXT = {".wav", ".mp3", ".m4a", ".aac", ".ogg", ".flac", ".aiff", ".aif"}
BUILTIN_VERSION = 2
_lock = threading.Lock()
_ready = False
_durations = {}   # (path, mtime) -> seconds

# id -> (label, what it's for). The hints are also what the LLM sees when placing sounds.
BUILTIN = {
    "boom": ("Boom", "deep impact after a punchline, shock, roast or big reveal (vine-boom style)"),
    "bass_drop": ("Bass drop", "heavier, longer impact for the biggest moment of the clip"),
    "whoosh": ("Whoosh", "transition, quick movement, or the very start of the clip"),
    "swish": ("Swish", "short fast whoosh for a cut or a snappy line"),
    "ding": ("Ding", "realization, correct answer, 'he's got a point'"),
    "pop": ("Pop", "light emphasis on a single word or reaction"),
    "riser": ("Riser", "tension building up right before a payoff (place ~2s before it)"),
    "scratch": ("Record scratch", "sudden stop, awkward silence, 'wait what'"),
    "error": ("Error buzz", "fail, wrong answer, bad take, cringe"),
    "glitch": ("Glitch", "something broke, chaos, disbelief"),
    "shutter": ("Camera shutter", "'caught in 4K', screenshot-worthy moment"),
    "heartbeat": ("Heartbeat", "suspense, nervous moment"),
}


def _t(sec):
    return np.linspace(0, sec, int(SR * sec), endpoint=False)


def _env(n, attack=0.005, decay=1.0):
    t = np.arange(n) / SR
    a = np.clip(t / max(attack, 1e-4), 0, 1)
    return a * np.exp(-t / decay)


def _sweep(f0, f1, sec, curve=1.0):
    t = _t(sec)
    f = f0 + (f1 - f0) * (t / sec) ** curve
    return np.sin(2 * np.pi * np.cumsum(f) / SR)


def _noise(sec, seed=0):
    return np.random.default_rng(seed).standard_normal(int(SR * sec))


def _lowpass(x, cutoff):
    """One-pole low-pass; cutoff may be an array (time-varying)."""
    cutoff = np.broadcast_to(np.asarray(cutoff, dtype=float), x.shape)
    a = np.exp(-2 * np.pi * cutoff / SR)
    y = np.empty_like(x)
    prev = 0.0
    for i in range(len(x)):
        prev = (1 - a[i]) * x[i] + a[i] * prev
        y[i] = prev
    return y


def _norm(x, peak=0.9):
    m = np.max(np.abs(x)) or 1.0
    return x / m * peak


def _synth(sid):
    if sid == "boom":
        body = _sweep(70, 38, 1.4, 0.6) * _env(int(SR * 1.4), 0.002, 0.45)
        sub = np.sin(2 * np.pi * 45 * _t(1.4)) * _env(int(SR * 1.4), 0.002, 0.7)
        click = _noise(0.03, 1) * _env(int(SR * 0.03), 0.0005, 0.008)
        x = body + 0.8 * sub
        x[:len(click)] += 0.6 * click
        return _norm(np.tanh(2.6 * x))
    if sid == "bass_drop":
        x = _sweep(140, 28, 2.2, 0.4) * _env(int(SR * 2.2), 0.003, 1.1)
        return _norm(np.tanh(2.2 * x))
    if sid in ("whoosh", "swish"):
        sec = 0.75 if sid == "whoosh" else 0.32
        n = int(SR * sec)
        shape = np.sin(np.pi * np.linspace(0, 1, n)) ** 2
        cutoff = 300 + 5000 * shape
        return _norm(_lowpass(_noise(sec, 2), cutoff) * shape, 0.8)
    if sid == "ding":
        t = _t(1.3)
        x = sum(a * np.sin(2 * np.pi * f * t) for f, a in ((1320, 1), (2640, .35), (3960, .15), (1980, .2)))
        return _norm(x * _env(len(t), 0.002, 0.35), 0.7)
    if sid == "pop":
        return _norm(_sweep(900, 180, 0.09, 0.5) * _env(int(SR * 0.09), 0.0005, 0.03), 0.8)
    if sid == "riser":
        sec = 2.0
        n = int(SR * sec)
        ramp = np.linspace(0, 1, n) ** 2
        x = _sweep(180, 1400, sec, 2.0) * 0.5 + _lowpass(_noise(sec, 3), 200 + 6000 * ramp) * 0.8
        return _norm(x * ramp, 0.75)
    if sid == "scratch":
        sec = 0.55
        t = _t(sec)
        wob = np.sin(2 * np.pi * 9 * t)
        tone = np.sin(2 * np.pi * np.cumsum(400 + 900 * wob) / SR)
        x = (0.6 * tone + 0.6 * _lowpass(_noise(sec, 4), 2500)) * (0.6 + 0.4 * np.abs(wob))
        return _norm(x * _env(len(t), 0.002, 0.3), 0.8)
    if sid == "error":
        t = _t(0.7)
        sq = np.sign(np.sin(2 * np.pi * 150 * t)) + 0.5 * np.sign(np.sin(2 * np.pi * 157 * t))
        return _norm(_lowpass(sq, 1800) * _env(len(t), 0.005, 0.5), 0.6)
    if sid == "glitch":
        rng = np.random.default_rng(5)
        out = np.zeros(int(SR * 0.45))
        pos = 0
        while pos < len(out):
            seg = int(SR * rng.uniform(0.015, 0.06))
            f = rng.uniform(200, 2500)
            burst = np.sign(np.sin(2 * np.pi * f * np.arange(seg) / SR)) * rng.uniform(0.3, 1)
            if rng.random() < 0.3:
                burst = np.zeros(seg)
            out[pos:pos + seg] = burst[:len(out) - pos]
            pos += seg
        return _norm(np.round(out * 6) / 6, 0.6)
    if sid == "shutter":
        out = np.zeros(int(SR * 0.25))
        for off, seed in ((0, 6), (0.09, 7)):
            c = _lowpass(_noise(0.04, seed), 6000) * _env(int(SR * 0.04), 0.0005, 0.01)
            i = int(SR * off)
            out[i:i + len(c)] += c
        return _norm(out, 0.8)
    if sid == "heartbeat":
        out = np.zeros(int(SR * 1.0))
        for off in (0.0, 0.28):
            thump = np.sin(2 * np.pi * 55 * _t(0.18)) * _env(int(SR * 0.18), 0.004, 0.06)
            i = int(SR * off)
            out[i:i + len(thump)] += thump
        return _norm(np.tanh(2 * out), 0.85)
    raise KeyError(sid)


def _write_wav(path, x):
    pcm = (np.clip(x, -1, 1) * 32767).astype(np.int16)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())


def ensure_builtin():
    """Generate the stock sounds once. Many requests arrive at once when the editor opens, hence the lock."""
    global _ready
    if _ready:
        return
    with _lock:
        if _ready:
            return
        BUILTIN_DIR.mkdir(parents=True, exist_ok=True)
        USER_DIR.mkdir(parents=True, exist_ok=True)
        stamp = BUILTIN_DIR / "version.json"
        try:
            fresh = json.loads(stamp.read_text()).get("v") == BUILTIN_VERSION
        except Exception:
            fresh = False
        for sid in BUILTIN:
            f = BUILTIN_DIR / f"{sid}.wav"
            if not fresh or not f.exists():
                tmp = f.with_suffix(".tmp")
                _write_wav(tmp, _synth(sid))
                tmp.replace(f)
        stamp.write_text(json.dumps({"v": BUILTIN_VERSION}))
        _ready = True


def _duration(path):
    key = (str(path), path.stat().st_mtime)
    if key in _durations:
        return _durations[key]
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
                         capture_output=True, text=True)
    try:
        _durations[key] = round(float(out.stdout.strip()), 2)
    except ValueError:
        _durations[key] = None
    return _durations[key]


def library():
    ensure_builtin()
    items = [{"id": sid, "label": label, "hint": hint, "kind": "builtin",
              "duration": _duration(BUILTIN_DIR / f"{sid}.wav")} for sid, (label, hint) in BUILTIN.items()]
    for f in sorted(USER_DIR.iterdir()):
        if f.suffix.lower() in AUDIO_EXT:
            items.append({"id": "user:" + f.name, "label": f.stem.replace("_", " ").replace("-", " "),
                          "hint": "your sound", "kind": "user", "duration": _duration(f)})
    return items


def ids():
    ensure_builtin()
    return set(BUILTIN) | {"user:" + f.name for f in USER_DIR.iterdir() if f.suffix.lower() in AUDIO_EXT}


def path_for(sid):
    if sid.startswith("user:"):
        p = USER_DIR / Path(sid[5:]).name
    else:
        ensure_builtin()
        p = BUILTIN_DIR / f"{Path(sid).name}.wav"
    if not p.exists():
        raise FileNotFoundError(sid)
    return p


def import_file(src_name, fileobj):
    name = re.sub(r"[^\w.\- ]+", "", Path(src_name).name).strip() or "sound.mp3"
    if Path(name).suffix.lower() not in AUDIO_EXT:
        raise ValueError("Not an audio file (wav, mp3, m4a, ogg, flac, aiff)")
    USER_DIR.mkdir(parents=True, exist_ok=True)
    dest = USER_DIR / name
    with dest.open("wb") as f:
        shutil.copyfileobj(fileobj, f)
    return "user:" + dest.name
