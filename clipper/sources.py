"""Loading a source into the Workbench: metadata, a playable preview, and a heatmap of where stuff happened."""
import hashlib
import json
import re
import subprocess
import threading
import time
from pathlib import Path
from urllib.parse import quote, urljoin

import requests
import yt_dlp

from . import chat, config
from .download import _extract_with_cookie_fallback, _twitch_id, is_url

_sources = {}          # key -> probe result (includes upstream preview url, never sent to the page)
_chat_jobs = {}        # twitch id -> {"state", "progress", "count", "error"}
_lock = threading.Lock()


class _Quiet:
    """Minimal ctx for code that reports progress we don't need here."""
    def stage(self, *a):
        pass

    def log(self, *a):
        pass

    def check(self):
        pass


def key_for(source):
    return hashlib.sha1(source.strip().encode()).hexdigest()[:12]


def _ffprobe_duration(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0",
                          str(path)], capture_output=True, text=True)
    try:
        return float(out.stdout.strip())
    except ValueError:
        return 0.0


def probe(source):
    source = source.strip()
    k = key_for(source)
    if k in _sources and time.time() - _sources[k]["probed"] < 3 * 3600:
        return public(_sources[k])

    if not is_url(source):
        path = Path(source).expanduser()
        if not path.is_file():
            raise FileNotFoundError(f"No such file: {path}")
        info = {"key": k, "source": str(path), "kind": "file", "title": path.stem, "channel": "Local file",
                "duration": _ffprobe_duration(path), "preview_type": "file", "upstream": str(path),
                "headers": {}, "twitch_id": None, "heatmap": None, "thumbnail": None}
    else:
        opts = {"format": "b[height<=480]/b[height<=720]/b/bv*[height<=480]",
                "noplaylist": True, "quiet": True, "no_warnings": True}
        raw = _extract_with_cookie_fallback(source, opts, _Quiet(), download=False)
        if raw.get("_type") == "playlist" and raw.get("entries"):
            raw = raw["entries"][0]
        proto = str(raw.get("protocol", ""))
        heat = None
        if raw.get("heatmap"):  # YouTube "most replayed"
            heat = [(h["start_time"], h["end_time"], h["value"]) for h in raw["heatmap"]]
        tid = _twitch_id(raw)
        info = {"key": k, "source": source,
                "kind": "twitch" if tid else (raw.get("extractor_key") or "web").lower(),
                "title": raw.get("title") or "Untitled", "channel": raw.get("uploader") or raw.get("channel") or "",
                "duration": float(raw.get("duration") or 0), "thumbnail": raw.get("thumbnail"),
                "preview_type": "hls" if proto.startswith("m3u8") else "mp4",
                "upstream": raw.get("url"), "headers": raw.get("http_headers") or {},
                "twitch_id": tid, "heatmap": heat}
    info["probed"] = time.time()
    _sources[k] = info
    if info["twitch_id"]:
        start_chat(info["twitch_id"], info["duration"])
    _remember(info)
    return public(info)


def public(info):
    out = {x: info[x] for x in ("key", "source", "kind", "title", "channel", "duration", "thumbnail",
                                "preview_type", "twitch_id")}
    out["preview_url"] = f"/api/preview/{info['key']}"
    out["has_heatmap"] = bool(info["heatmap"] or info["twitch_id"])
    return out


def _remember(info):
    """Recent sources list for the Workbench."""
    f = config.DATA / "recent.json"
    try:
        recent = json.loads(f.read_text())
    except Exception:
        recent = []
    recent = [r for r in recent if r["source"] != info["source"]]
    recent.insert(0, {"source": info["source"], "title": info["title"], "channel": info["channel"],
                      "duration": info["duration"], "kind": info["kind"], "at": time.time()})
    f.write_text(json.dumps(recent[:12]))


def recent():
    try:
        return json.loads((config.DATA / "recent.json").read_text())
    except Exception:
        return []


# ---------- preview proxy ----------

def upstream(key):
    info = _sources.get(key)
    if not info:
        raise KeyError(key)
    return info


def proxied(key, url):
    return f"/api/preview/{key}?u={quote(url, safe='')}"


def rewrite_m3u8(key, base_url, text):
    """Point every URI in a playlist back through our proxy (no CORS, headers handled here)."""
    out = []
    for ln in text.splitlines():
        s = ln.strip()
        if s and not s.startswith("#"):
            out.append(proxied(key, urljoin(base_url, s)))
        elif 'URI="' in s:
            out.append(re.sub(r'URI="([^"]+)"', lambda m: f'URI="{proxied(key, urljoin(base_url, m.group(1)))}"', ln))
        else:
            out.append(ln)
    return "\n".join(out) + "\n"


# ---------- heatmap ----------

def start_chat(twitch_id, duration):
    with _lock:
        st = _chat_jobs.get(twitch_id)
        if st and st["state"] in ("running", "done"):
            return
        cached = config.CACHE_DIR / f"chat_{twitch_id}.json"
        if cached.exists():
            _chat_jobs[twitch_id] = {"state": "done", "progress": 1.0, "count": None, "error": ""}
            return
        _chat_jobs[twitch_id] = {"state": "running", "progress": 0.0, "count": 0, "error": ""}
    threading.Thread(target=_fetch_chat, args=(twitch_id, duration), daemon=True).start()


def _fetch_chat(twitch_id, duration):
    st = _chat_jobs[twitch_id]

    class Ctx(_Quiet):
        def stage(self, _s, frac, _m):
            st["progress"] = frac

    try:
        msgs = chat.fetch(twitch_id, 0, duration, Ctx())
        tmp = config.CACHE_DIR / f"chat_{twitch_id}.tmp"
        tmp.write_text(json.dumps({"duration": duration, "messages": msgs}))
        tmp.rename(config.CACHE_DIR / f"chat_{twitch_id}.json")
        st.update(state="done", progress=1.0, count=len(msgs))
    except Exception as ex:
        st.update(state="error", error=str(ex))


def cached_chat(twitch_id):
    """(messages, vod_duration) if the whole-VOD chat is on disk, else None."""
    f = config.CACHE_DIR / f"chat_{twitch_id}.json"
    if not f.exists():
        return None
    d = json.loads(f.read_text())
    return [tuple(m) for m in d["messages"]], d["duration"]


def heatmap(key, bins=400):
    info = upstream(key)
    dur = info["duration"] or 1
    if info["heatmap"]:
        vals = [0.0] * bins
        for s, e, v in info["heatmap"]:
            for b in range(int(s / dur * bins), min(bins, int(e / dur * bins) + 1)):
                vals[b] = max(vals[b], v)
        return {"state": "done", "progress": 1.0, "source": "Most replayed", "bins": vals,
                "peaks": _peaks(vals, dur)}
    if info["twitch_id"]:
        st = _chat_jobs.get(info["twitch_id"], {"state": "idle", "progress": 0})
        out = {"state": st["state"], "progress": st.get("progress"), "source": "Chat activity",
               "bins": None, "peaks": [], "error": st.get("error", "")}
        if st["state"] == "done":
            msgs, vdur = cached_chat(info["twitch_id"])
            counts = [0] * bins
            for t, _ in msgs:
                counts[min(bins - 1, int(t / vdur * bins))] += 1
            top = max(counts) or 1
            out["bins"] = [c / top for c in counts]
            out["peaks"] = _peaks(out["bins"], vdur)
            out["messages"] = len(msgs)
        return out
    return {"state": "none", "bins": None, "peaks": []}


def _peaks(vals, dur, n=8, window_s=300):
    """Top n non-overlapping windows by total activity, as hot spots to jump to."""
    bins = len(vals)
    w = max(1, int(window_s / dur * bins))
    sums = [sum(vals[i:i + w]) for i in range(max(1, bins - w + 1))]
    mean = (sum(vals) / bins) * w or 1e-9
    order = sorted(range(len(sums)), key=lambda i: -sums[i])
    picked = []
    for i in order:
        if all(abs(i - j) >= w for j in picked):
            picked.append(i)
        if len(picked) >= n:
            break
    return [{"start": i / bins * dur, "end": min(dur, (i + w) / bins * dur),
             "intensity": round(sums[i] / mean, 1)} for i in sorted(picked)]
