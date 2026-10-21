"""Job state, persistence, and the single worker thread that runs the pipeline."""
import json
import queue
import re
import shutil
import subprocess
import threading
import time
import traceback
import uuid
from pathlib import Path

from . import chat, config, download, moments, render, setup_tasks, sources, transcribe
from .util import ffmpeg

STAGES = ["download", "audio", "chat", "transcribe", "moments", "render"]


class Cancelled(Exception):
    pass


class Job:
    def __init__(self, source, options, jid=None, order=0):
        self.id = jid or time.strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:4]
        self.order = order
        self.export_dir = ""
        self.source = source
        self.options = options
        self.title = ""
        self.status = "queued"       # queued | running | done | failed | cancelled
        self.stage = ""
        self.progress = None
        self.message = "Waiting in line"
        self.log_lines = []
        self.clips = []
        self.error = ""
        self.created = time.time()
        self.cancel_requested = False
        self._last_save = 0.0

    @property
    def dir(self):
        return config.JOBS_DIR / self.id

    def to_dict(self, log_tail=12):
        return {
            "id": self.id, "order": self.order, "export_dir": self.export_dir,
            "source": self.source, "options": self.options, "title": self.title,
            "status": self.status, "stage": self.stage, "progress": self.progress,
            "message": self.message, "log": self.log_lines[-log_tail:] if log_tail else self.log_lines,
            "clips": self.clips, "error": self.error, "created": self.created,
        }

    def save(self, force=False):
        now = time.time()
        if not force and now - self._last_save < 2:
            return
        self._last_save = now
        self.dir.mkdir(parents=True, exist_ok=True)
        (self.dir / "job.json").write_text(json.dumps(self.to_dict(log_tail=0), indent=2))

    def stage_update(self, stage, progress, message):
        self.stage, self.progress, self.message = stage, progress, message
        self.save()

    def log(self, msg):
        self.log_lines.append(time.strftime("%H:%M:%S ") + msg)
        self.save()

    def check(self):
        if self.cancel_requested:
            raise Cancelled()


class Ctx:
    """What pipeline code talks to. Kept separate so Job.stage stays a plain attribute."""

    def __init__(self, job):
        self.job = job

    def stage(self, stage, progress, message):
        self.job.stage_update(stage, progress, message)

    def log(self, msg):
        self.job.log(msg)

    def check(self):
        self.job.check()


class Manager:
    def __init__(self):
        self.jobs = {}
        self.q = queue.Queue()
        self.lock = threading.Lock()
        self._load()
        threading.Thread(target=self._worker, daemon=True).start()

    def _load(self):
        for f in sorted(config.JOBS_DIR.glob("*/job.json")):
            try:
                d = json.loads(f.read_text())
            except Exception:
                continue
            j = Job(d["source"], d.get("options", {}), d["id"], d.get("order", 0))
            j.export_dir = d.get("export_dir", "")
            j.title, j.status, j.stage = d.get("title", ""), d.get("status"), d.get("stage", "")
            j.progress, j.message = d.get("progress"), d.get("message", "")
            j.log_lines, j.clips, j.error = d.get("log", []), d.get("clips", []), d.get("error", "")
            j.created = d.get("created", 0)
            if j.status in ("queued", "running"):
                j.status, j.message = "failed", "Interrupted (app was closed). Submit it again."
                j.save(force=True)
            self.jobs[j.id] = j

    def submit(self, source, options):
        with self.lock:
            order = max([1000] + [x.order for x in self.jobs.values()]) + 1
        j = Job(source, options, order=order)
        j.title = options.get("source_title", "")
        rng = (f"{_tc(options['start'])}-{_tc(options['end'])}" if options.get("start") is not None
               else options.get("section") or "full")
        j.log(f"Work order WO-{order} received: {source} [{rng}]")
        j.save(force=True)
        with self.lock:
            self.jobs[j.id] = j
        self.q.put(j.id)
        return j

    def cancel(self, jid):
        j = self.jobs.get(jid)
        if j and j.status in ("queued", "running"):
            j.cancel_requested = True
            if j.status == "queued":
                j.status, j.message = "cancelled", "Cancelled"
                j.save(force=True)

    def retry(self, jid):
        j = self.jobs.get(jid)
        if not j or j.status not in ("failed", "cancelled"):
            return False
        j.status, j.stage, j.progress, j.error, j.clips = "queued", "", None, "", []
        j.cancel_requested = False
        j.message = "Waiting in line"
        j.log("Retrying (reusing anything already downloaded)")
        j.save(force=True)
        self.q.put(j.id)
        return True

    def delete(self, jid):
        j = self.jobs.get(jid)
        if not j or j.status in ("queued", "running"):
            return False
        with self.lock:
            self.jobs.pop(jid, None)
        shutil.rmtree(j.dir, ignore_errors=True)
        return True

    def list(self):
        with self.lock:
            return sorted((j.to_dict() for j in self.jobs.values()), key=lambda d: -d["created"])

    def _worker(self):
        while True:
            jid = self.q.get()
            j = self.jobs.get(jid)
            if not j or j.status != "queued":
                continue
            while not setup_tasks.ready():
                j.message = "Waiting for setup to finish (models downloading)"
                if j.cancel_requested:
                    break
                time.sleep(1)
            if j.cancel_requested:
                j.status, j.message = "cancelled", "Cancelled"
                j.save(force=True)
                continue
            j.status = "running"
            try:
                run_pipeline(j, Ctx(j))
                j.status, j.stage, j.progress = "done", "done", 1.0
                j.message = f"Done: {len(j.clips)} clip(s)"
                j.log(j.message)
            except Cancelled:
                j.status, j.message = "cancelled", "Cancelled"
                j.log("Cancelled")
            except Exception as ex:
                j.status, j.error = "failed", f"{type(ex).__name__}: {ex}"
                j.message = "Failed: " + j.error
                j.log(traceback.format_exc()[-1500:])
            j.save(force=True)


def media_duration(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                          "-of", "csv=p=0", str(path)], capture_output=True, text=True)
    try:
        return float(out.stdout.strip())
    except ValueError:
        return 0.0


def run_pipeline(job, ctx):
    o = job.options
    job.dir.mkdir(parents=True, exist_ok=True)

    saved = job.dir / "download.json"
    if saved.exists() and Path(json.loads(saved.read_text())["src"]).exists():
        d = json.loads(saved.read_text())  # retry: reuse what we already downloaded
        src, title, meta = Path(d["src"]), d["title"], d["meta"]
    else:
        src, title, meta = download.fetch(job.source, job.dir, o.get("section"), ctx)
        saved.write_text(json.dumps({"src": str(src), "title": title, "meta": meta}))
    job.title = title
    duration = media_duration(src)
    ctx.log(f"Got video: {title} ({duration/60:.1f} min)")

    ctx.stage("audio", None, "Pulling audio out")
    audio = job.dir / "audio.wav"
    ffmpeg("-i", src, "-vn", "-ac", "1", "-ar", "16000", audio)

    messages, chat_base = [], None
    if meta.get("twitch_id"):
        ctx.stage("chat", 0.0, "Reading Twitch chat")
        try:
            full = sources.cached_chat(meta["twitch_id"])
            if full:
                all_msgs, vod_dur = full
                lo, hi = meta["offset"], meta["offset"] + duration
                raw = [(t, x) for t, x in all_msgs if lo <= t < hi]
                chat_base = len(all_msgs) / max(vod_dur, 1)
                ctx.log(f"Using cached chat for the whole stream ({len(all_msgs)} messages)")
            else:
                raw = chat.fetch(meta["twitch_id"], meta["offset"], meta["offset"] + duration, ctx)
            messages = [(t - meta["offset"], text) for t, text in raw]
            ctx.log(f"Read {len(messages)} chat messages")
            if chat_base is None and meta.get("vod_duration") and meta["vod_duration"] > duration * 1.5:
                ctx.stage("chat", None, "Sampling chat across the whole stream for a baseline")
                chat_base = chat.baseline_rate(meta["twitch_id"], meta["vod_duration"])
                if chat_base:
                    ctx.log(f"Normal chat speed for this stream: {chat_base:.1f} msg/s")
        except Exception as ex:
            ctx.log(f"Couldn't read Twitch chat, going without it: {ex}")

    tpath = job.dir / "transcript.json"
    if tpath.exists():
        words = json.loads(tpath.read_text())
    else:
        ctx.stage("transcribe", 0.0, "Loading Whisper")
        words = transcribe.transcribe(audio, duration, ctx)
        tpath.write_text(json.dumps(words))
    ctx.log(f"Transcribed {len(words)} words")
    if not words:
        raise RuntimeError("No speech found in this video")

    ctx.stage("moments", 0.0, "Checking the LLM is up")
    setup_tasks.ensure_ollama()
    picks = moments.find_moments(words, int(o.get("max_clips", 5)), float(o.get("min_len", 20)),
                                 float(o.get("max_len", 60)), ctx, audio_path=audio, chat=messages, chat_base=chat_base,
                                 kind="livestream" if meta.get("twitch_id") else "video")
    if not picks:
        raise RuntimeError("The LLM didn't find any clip-worthy moments")
    ctx.log(f"Picked {len(picks)} moment(s)")
    for c in picks:  # where each clip sits in the original video, for the UI
        c["abs_start"], c["abs_end"] = meta["offset"] + c["start"], meta["offset"] + c["end"]
    (job.dir / "moments.json").write_text(json.dumps(picks, indent=2))

    for n, clip in enumerate(picks, 1):
        name = f"clip_{n:02d}.mp4"
        render.render_clip(src, words, clip, job.dir / name, job.dir, o.get("layout", "auto"), ctx,
                           f"Clip {n}/{len(picks)}")
        clip["file"] = name
        thumb = name.replace(".mp4", ".jpg")
        try:
            ffmpeg("-ss", min(1.5, (clip["end"] - clip["start"]) / 2), "-i", job.dir / name, "-frames:v", "1",
                   "-vf", "scale=360:-2", "-q:v", "4", job.dir / thumb)
            clip["thumb"] = thumb
        except RuntimeError:
            pass
        job.clips.append(clip)
        ctx.log(f"Rendered {name} ({clip['end']-clip['start']:.0f}s, score {clip['score']}, {clip['layout']})")
        job.save(force=True)
    audio.unlink(missing_ok=True)
    export(job)


def _tc(t):
    t = int(t)
    return f"{t // 3600:02d}:{t % 3600 // 60:02d}:{t % 60:02d}"


def _safe(name, n=60):
    name = re.sub(r'[\\/:*?"<>|\n\r]+', " ", name).strip()
    return re.sub(r"\s+", " ", name)[:n].strip(" .") or "clip"


def export(job):
    """Copy finished clips somewhere people actually look (~/Movies/Clipworks in the app)."""
    dest = config.EXPORT_DIR / _safe(f"WO-{job.order} {job.title}", 80)
    dest.mkdir(parents=True, exist_ok=True)
    for n, c in enumerate(job.clips, 1):
        shutil.copy2(job.dir / c["file"], dest / f"{n:02d} {_safe(c.get('hook') or c.get('title') or 'clip')}.mp4")
    job.export_dir = str(dest)
