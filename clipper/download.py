"""Get the source video onto disk: yt-dlp for URLs, passthrough for local files."""
import os
import re
import subprocess
from pathlib import Path

import yt_dlp


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
        cmd = ["ffmpeg", "-y", "-v", "error", "-ss", str(rng[0]), "-i", str(path)]
        if rng[1] is not None:
            cmd += ["-t", str(rng[1] - rng[0])]
        cmd += ["-c", "copy", str(out)]
        subprocess.run(cmd, check=True)
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


def _extract(source, opts):
    with yt_dlp.YoutubeDL(opts) as ydl:
        return ydl.extract_info(source, download=True)


def _extract_with_cookie_fallback(source, opts, ctx):
    """YouTube sometimes demands a login ("confirm you're not a bot"). If that happens,
    borrow the login cookies from a browser on this machine and try again."""
    forced = os.environ.get("CLIPPER_COOKIES_FROM")
    if forced:
        return _extract(source, {**opts, "cookiesfrombrowser": (forced,)})
    try:
        return _extract(source, opts)
    except yt_dlp.utils.DownloadError as ex:
        if "not a bot" not in str(ex) and "Sign in" not in str(ex):
            raise
        first_error = ex
    for browser in BROWSERS:
        ctx.check()
        ctx.log(f"Site wants a login. Trying your {browser} cookies")
        try:
            return _extract(source, {**opts, "cookiesfrombrowser": (browser,)})
        except Exception as ex:
            ctx.log(f"{browser}: {str(ex).splitlines()[0][:160]}")
    raise RuntimeError(
        "The site blocked the download and asked for a login. Log into YouTube in Chrome or "
        "Firefox and try again, or restart with CLIPPER_COOKIES_FROM=chrome ./start.sh"
    ) from first_error
