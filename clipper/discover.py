"""Whole-stream discovery: where did something actually happen?

The transcript alone is a weak judge of what's clip-worthy (a menu screen and a funny
moment can read the same). The audience tells you directly, so every second of the stream
gets scored from:

- chat speed against the stream's typical level,
- chat literally asking for a clip ("CLIP IT", "someone clip that", 📸),
- clips viewers already made of this VOD, when the platform exposes them,
- the streamer getting loud (weak on its own, mostly a tiebreaker),
- YouTube's "most replayed" graph for YouTube sources.

Chat reacts a few seconds after the moment, so chat-derived signals are shifted earlier.

Measured on 8 Twitch VODs from 5 streamers (33 h, 650k messages) against the 900+ clips
viewers made of them: chat speed alone puts 18% of clip views in its top 20 picks, speed
plus "clip it" 39%. Laugh/shock/hype word lists looked great tuned on one streamer and
fell apart on the others, so they're tracked for explanations but weighted 0.
"""
import re
import subprocess
from collections import Counter

import numpy as np

CHAT_DELAY = 6.0          # seconds chat lags behind what it reacts to
SMOOTH = 8                # seconds of smoothing on per-second signals
LOCAL_WIN = 900           # seconds of context for "normal" levels

# Each category: patterns matched against an upper-cased message (word-ish boundaries).
LEXICON = {
    "laugh": [r"KEKW?", r"KEKL", r"LULW?", r"OMEGALUL", r"ICANT", r"LMF?AO+", r"LO+L", r"HA(HA)+H?", r"XDD?",
              r"PEPELAUGH", r"DEAD", r"IM CRYING", r"CRYING", r"😂", r"🤣", r"💀", r"☠", r"JAJA+", r"KEKWAIT"],
    "shock": [r"WHAT+", r"WTF", r"\?{3,}", r"NO WAY", r"HOLY", r"OMG", r"MONKAS", r"MONKAW", r"D:", r"BRO WHAT",
              r"HUH+", r"WAIT", r"YOO+", r"😳", r"😱", r"NAH+", r"STOP"],
    "hype":  [r"POG\w*", r"POGGERS", r"W+", r"LETS GO+", r"LETSGO+", r"EZ+", r"GG+", r"🔥", r"CLAP", r"GOATED",
              r"HYPE", r"INSANE", r"CRAZY", r"PAUSE"],
    "fail":  [r"L+", r"RATIO", r"CRINGE", r"AWARE", r"SADGE", r"BRUH+", r"🤦", r"OOF", r"FAIL"],
    "clip":  [r"CLIP (IT|THAT|THIS)", r"CLIPPED", r"CLIPPING", r"CLIP\b", r"📸", r"SOMEONE CLIP", r"CLIPPERS?"],
}
_RX = {k: re.compile(r"(?<![A-Z0-9])(" + "|".join(v) + r")(?![A-Z0-9])") for k, v in LEXICON.items()}

# How much each signal counts (see the measurements in the docstring).
WEIGHTS = {"rate": 1.0, "laugh": 0.0, "shock": 0.0, "hype": 0.0, "fail": 0.0, "clip": 1.0, "wall": 0.0, "loud": 0.3,
           "clipped": 3.0, "replayed": 2.0}
SMOOTH_CFG = 30
NORM_CFG = "global"


def _smooth(x, w=SMOOTH):
    if w <= 1:
        return x
    k = np.ones(w) / w
    return np.convolve(x, k, mode="same")


def _local_z(x, win=LOCAL_WIN):
    """z-score against a rolling median/MAD, computed on 10 s blocks for speed."""
    n = len(x)
    if n == 0:
        return x
    blk = 10
    m = int(np.ceil(n / blk))
    xb = np.pad(x, (0, m * blk - n), mode="edge").reshape(m, blk).mean(axis=1)
    half = max(1, win // blk // 2)
    med = np.empty(m)
    mad = np.empty(m)
    for i in range(m):
        seg = xb[max(0, i - half): i + half + 1]
        md = np.median(seg)
        med[i] = md
        mad[i] = np.median(np.abs(seg - md)) * 1.4826
    floor = max(1e-6, float(np.median(mad[mad > 0])) * 0.5) if np.any(mad > 0) else 1e-3
    med_s, mad_s = np.repeat(med, blk)[:n], np.repeat(np.maximum(mad, floor), blk)[:n]
    return (x - med_s) / mad_s


def chat_features(msgs, duration, smooth=SMOOTH):
    """Per-second arrays for each chat signal, already shifted to line up with the moment itself."""
    n = int(np.ceil(duration)) + 1
    feats = {k: np.zeros(n) for k in ("rate", *LEXICON, "wall")}
    bins = {}
    for t, text in msgs:
        i = int(t - CHAT_DELAY)
        if not 0 <= i < n:
            continue
        feats["rate"][i] += 1
        up = text.upper()
        for k, rx in _RX.items():
            if rx.search(up):
                feats[k][i] += 1
        bins.setdefault(i // 5, []).append(up.strip()[:40])
    # Emote walls / copypasta: share of the most repeated message in each 5 s block.
    for b, texts in bins.items():
        if len(texts) >= 4:
            top = Counter(texts).most_common(1)[0][1]
            feats["wall"][b * 5: b * 5 + 5] = top / len(texts) * len(texts) / 5
    return {k: _smooth(v, smooth) for k, v in feats.items()}


def loudness(audio_path, duration=None):
    """Per-second loudness in dB from any audio/video file."""
    pcm = subprocess.run(["ffmpeg", "-v", "error", "-i", str(audio_path), "-vn", "-ac", "1", "-ar", "8000",
                          "-f", "s16le", "-"], capture_output=True).stdout
    a = np.frombuffer(pcm, np.int16).astype(np.float32) / 32768.0
    sec = len(a) // 8000
    if sec == 0:
        return np.zeros(int(duration or 0) + 1)
    blocks = a[: sec * 8000].reshape(sec, 8000)
    db = 20 * np.log10(np.sqrt((blocks ** 2).mean(axis=1)) + 1e-5)
    return db


def clip_feature(clips, duration):
    """Viewer clips: the moment is usually near the end of a clip (people clip what just happened).

    Weighted by views, log squared: other clippers run bots that clip every chat burst, and a
    pile of 2-view bot clips must not outvote one clip a thousand people watched."""
    n = int(np.ceil(duration)) + 1
    x = np.zeros(n)
    for c in clips:
        end = c["videoOffsetSeconds"] + (c.get("durationSeconds") or 30)
        i = int(max(0, end - 6))
        if i < n:
            x[i] += np.log1p(c.get("viewCount") or 0) ** 2
    return _smooth(x, 15)


def _norm(x, mode):
    if mode == "global":   # vs. the whole stream's typical level
        med = float(np.median(x))
        mad = float(np.median(np.abs(x - med))) * 1.4826
        return (x - med) / max(mad, 1e-3, 0.05 * float(np.mean(np.abs(x))) + 1e-6)
    if mode == "mean":
        return x / (float(np.mean(x)) + 1e-6)
    return _local_z(x)


def signal_parts(chat=None, loud_db=None, clips=None, duration=None, smooth=None, norm=None, use_clips=True, heat=None):
    """Each signal as a per-second array on a comparable scale."""
    smooth = smooth or SMOOTH_CFG
    norm = norm or NORM_CFG
    n = int(np.ceil(duration)) + 1
    parts = {}
    if chat:
        f = chat_features(chat, duration, smooth)
        for k, v in f.items():
            parts[k] = np.clip(_norm(v, norm), -3, 40)
    if loud_db is not None and len(loud_db):
        ld = np.pad(loud_db, (0, max(0, n - len(loud_db))), mode="edge")[:n]
        parts["loud"] = np.clip(_norm(_smooth(ld, max(4, smooth // 2)), norm), -3, 20)
    if clips and use_clips:
        cf = clip_feature(clips, duration)
        # Same scale as a big chat spike for the stream's most clipped moment, so weights mean something.
        parts["clipped"] = cf / (cf.max() or 1) * 15.0
    if heat:
        parts["replayed"] = np.clip(_norm(heat_feature(heat, duration), norm), -3, 40)
    return {k: v[:n] for k, v in parts.items()}


def combine(parts, weights=None):
    w = {**WEIGHTS, **(weights or {})}
    n = max(len(v) for v in parts.values())
    total = np.zeros(n)
    for k, v in parts.items():
        total[:len(v)] += w.get(k, 0.0) * np.maximum(v, 0)
    return total


def score_timeline(chat=None, loud_db=None, clips=None, duration=None, weights=None, use_clips=True, smooth=None,
                   norm=None, heat=None):
    """Combined per-second 'something happened' score plus the per-signal parts for explanations."""
    parts = signal_parts(chat, loud_db, clips, duration, smooth, norm, use_clips, heat)
    if not parts:
        return np.zeros(int(np.ceil(duration)) + 1), {}
    return combine(parts, weights), parts


def peaks(score, k=40, min_gap=75, skip_start=60):
    """Top-k local maxima at least min_gap seconds apart (non-maximum suppression)."""
    s = score.copy()
    s[:skip_start] = 0  # stream intros ("hi chat") always spike and are never the clip
    order = np.argsort(-s)
    picked = []
    for i in order:
        if s[i] <= 0 or len(picked) >= k:
            break
        if all(abs(i - j) >= min_gap for j in picked):
            picked.append(int(i))
    return picked


def heat_feature(heat, duration):
    """YouTube most-replayed [(start, end, 0..1)] as a per-second array."""
    n = int(np.ceil(duration)) + 1
    x = np.zeros(n)
    for a, b, v in heat:
        x[int(a):int(b) + 1] = np.maximum(x[int(a):int(b) + 1], v)
    return x


def explain(parts, t, window=8):
    """Signals that stand out around second t (strong for this stream), for showing why a moment was picked."""
    contrib = {k: float(np.max(np.maximum(v[max(0, t - window):t + window], 0))) for k, v in parts.items() if t < len(v)}
    names = {"rate": "chat spike", "laugh": "chat laughing", "shock": "chat shocked", "hype": "chat hype",
             "fail": "chat L's", "clip": "chat asking for a clip", "wall": "emote wall", "loud": "streamer got loud",
             "clipped": "viewers clipped this", "replayed": "most replayed"}
    top = sorted(contrib.items(), key=lambda kv: -kv[1])
    return [names.get(k, k) for k, v in top if v > 3][:3]
