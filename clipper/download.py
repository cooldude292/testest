"""Get the source video onto disk: yt-dlp for URLs, passthrough for local files."""
import os
import re
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urljoin

import requests
import yt_dlp

from .util import ffmpeg


def parse_ts(s):
    """'1:02:03' / '62:03' / '3723' -> seconds."""
    s = s.strip()
    if not s:
        return None
    total = 0.0
    for part in s.split(":"):
        total = total * 60 + float(part)
    return total


def parse_section(section):
    """'1:00:00-1:30:00' -> (3600, 5400). Either side may be empty."""
    if not section or not section.strip():
        return None
    m = re.fullmatch(r"\s*([\d:.]*)\s*-\s*([\d:.]*)\s*", section)
    if not m:
        raise ValueError(f"Bad time range '{section}'. Use start-end like 10:00-45:00")
    start = parse_ts(m.group(1)) or 0.0
    end = parse_ts(m.group(2))
    if end is not None and end <= start:
        raise ValueError("Time range end must be after start")
    return start, end


def is_url(source):
    return bool(re.match(r"^https?://", source.strip(), re.I))


def _fmt_bytes(n):
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024:
            return f"{n:.0f}{unit}"
        n /= 1024
    return f"{n:.1f}TB"


def fetch(source, job_dir, section, ctx):
    """Returns (path_to_video, title)."""
    source = source.strip()
    rng = parse_section(section)

    if not is_url(source):
        path = Path(source).expanduser()
        if not path.is_file():
            raise FileNotFoundError(f"No such file: {path}")
        if not rng:
            return path, path.stem
        ctx.stage("download", None, "Cutting the time range out of the local file")
        out = job_dir / "source.mp4"
        args = ["-ss", rng[0], "-i", path]
        if rng[1] is not None:
            args += ["-t", rng[1] - rng[0]]
        ffmpeg(*args, "-c", "copy", out)
        return out, path.stem

    def hook(d):
        ctx.check()
        if d["status"] != "downloading":
            return
        done = d.get("downloaded_bytes") or 0
        total = d.get("total_bytes") or d.get("total_bytes_estimate")
        frac = None
        if total:
            frac = done / total
        elif d.get("fragment_count"):
            frac = (d.get("fragment_index") or 0) / d["fragment_count"]
        speed = d.get("speed")
        eta = d.get("eta")
        bits = [f"{_fmt_bytes(done)}" + (f" / {_fmt_bytes(total)}" if total else "")]
        if speed:
            bits.append(f"{_fmt_bytes(speed)}/s")
        if eta:
            bits.append(f"ETA {int(eta)//60}m{int(eta)%60:02d}s")
        kind = "audio" if d.get("info_dict", {}).get("vcodec") == "none" else "video"
        ctx.stage("download", frac, f"Downloading {kind}: " + ", ".join(bits))

    opts = {
        "format": "bv*[height<=1080]+ba/b[height<=1080]/bv*+ba/b",
        "merge_output_format": "mp4",
        "outtmpl": str(job_dir / "source.%(ext)s"),
        "progress_hooks": [hook],
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "concurrent_fragment_downloads": 8,
    }
    if rng:
        end = rng[1] if rng[1] is not None else float("inf")
        opts["download_ranges"] = yt_dlp.utils.download_range_func(None, [(rng[0], end)])

    ctx.stage("download", None, "Looking up the video")
    if rng:
        # Streams (Twitch, Kick) are HLS playlists of short chunks. Grab only the chunks
        # in the range, in parallel; letting ffmpeg seek through hours of chunks crawls.
        info = _extract_with_cookie_fallback(source, opts, ctx, download=False)
        if info.get("_type") == "playlist" and info.get("entries"):
            info = info["entries"][0]
        if not info.get("requested_formats") and str(info.get("protocol", "")).startswith("m3u8"):
            out = job_dir / "source.mp4"
            if _hls_slice(info, rng, job_dir, out, ctx):
                return out, info.get("title") or "video"
    info = _extract_with_cookie_fallback(source, opts, ctx)
    if info.get("_type") == "playlist" and info.get("entries"):
        info = info["entries"][0]
    path = None
    for rd in info.get("requested_downloads") or []:
        if rd.get("filepath") and Path(rd["filepath"]).exists():
            path = Path(rd["filepath"])
    if path is None:
        candidates = sorted(job_dir.glob("source.*"), key=lambda p: p.stat().st_size)
        if not candidates:
            raise RuntimeError("yt-dlp finished but no file showed up")
        path = candidates[-1]
    return path, info.get("title") or "video"


BROWSERS = ("chrome", "safari", "firefox", "brave", "edge", "arc")


def _extract(source, opts, download=True):
    with yt_dlp.YoutubeDL(opts) as ydl:
        return ydl.extract_info(source, download=download)


def _extract_with_cookie_fallback(source, opts, ctx, download=True):
    """YouTube sometimes demands a login ("confirm you're not a bot"). If that happens,
    borrow the login cookies from a browser on this machine and try again."""
    forced = os.environ.get("CLIPPER_COOKIES_FROM")
    if forced:
        return _extract(source, {**opts, "cookiesfrombrowser": (forced,)}, download)
    try:
        return _extract(source, opts, download)
    except yt_dlp.utils.DownloadError as ex:
        if "not a bot" not in str(ex) and "Sign in" not in str(ex):
            raise
        first_error = ex
    for browser in BROWSERS:
        ctx.check()
        ctx.log(f"Site wants a login. Trying your {browser} cookies")
        try:
            return _extract(source, {**opts, "cookiesfrombrowser": (browser,)}, download)
        except Exception as ex:
            ctx.log(f"{browser}: {str(ex).splitlines()[0][:160]}")
    raise RuntimeError(
        "The site blocked the download and asked for a login. Log into YouTube in Chrome or "
        "Firefox and try again, or restart with CLIPPER_COOKIES_FROM=chrome ./start.sh"
    ) from first_error


def _hls_slice(fmt, rng, job_dir, out, ctx):
    """Download just the HLS segments covering rng. Returns False if the playlist is
    something we don't handle (encrypted, master playlist), so the caller falls back to yt-dlp."""
    url, headers = fmt["url"], fmt.get("http_headers") or {}
    text = requests.get(url, headers=headers, timeout=30).text
    if "#EXT-X-STREAM-INF" in text or re.search(r"#EXT-X-KEY:(?!METHOD=NONE)", text):
        return False
    init, segs, t, dur = None, [], 0.0, 0.0
    for ln in text.splitlines():
        ln = ln.strip()
        if ln.startswith("#EXT-X-MAP:"):
            m = re.search(r'URI="([^"]+)"', ln)
            u = urljoin(url, m.group(1)) if m else None
            if init and u != init:
                return False  # init changes mid-stream; not worth handling here
            init = u
        elif ln.startswith("#EXTINF:"):
            dur = float(ln[8:].split(",")[0] or 0)
        elif ln and not ln.startswith("#"):
            segs.append((t, dur, urljoin(url, ln)))
            t += dur
    start, end = rng[0], rng[1] if rng[1] is not None else t
    pick = [s for s in segs if s[0] + s[1] > start and s[0] < end]
    if not pick:
        raise ValueError(f"That time range is past the end of the video ({t/60:.0f} min long)")

    parts = job_dir / "parts"
    parts.mkdir(exist_ok=True)
    session = requests.Session()
    session.headers.update(headers)
    done = [0, 0]  # segments, bytes

    def get(i_seg):
        i, (_, _, u) = i_seg
        dest = parts / f"{i:06d}"
        if not dest.exists():
            for attempt in range(4):
                try:
                    r = session.get(u, timeout=60)
                    r.raise_for_status()
                    break
                except requests.RequestException:
                    if attempt == 3:
                        raise
            dest.with_suffix(".tmp").write_bytes(r.content)
            dest.with_suffix(".tmp").rename(dest)
        done[0] += 1
        done[1] += dest.stat().st_size
        ctx.stage("download", done[0] / len(pick),
                  f"Downloading stream chunks: {done[0]}/{len(pick)} ({done[1]/1e6:.0f}MB)")
        ctx.check()

    with ThreadPoolExecutor(8) as pool:
        list(pool.map(get, enumerate(pick)))

    ctx.stage("download", None, "Stitching chunks together")
    joined = job_dir / ("joined.mp4" if init else "joined.ts")
    with joined.open("wb") as f:
        if init:
            f.write(session.get(init, timeout=60).content)
        for i in range(len(pick)):
            f.write((parts / f"{i:06d}").read_bytes())
    ffmpeg("-i", joined, "-c", "copy", "-avoid_negative_ts", "make_zero", "-movflags", "+faststart", out)
    joined.unlink()
    for p in parts.iterdir():
        p.unlink()
    parts.rmdir()
    ctx.log(f"Grabbed {len(pick)} chunks ({pick[0][0]/60:.1f}-{(pick[-1][0]+pick[-1][1])/60:.1f} min)")
    return True
