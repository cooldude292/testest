"""Job state, persistence, and the single worker thread that runs the pipeline."""
import json
import queue
import subprocess
import threading
import time
import traceback
import uuid

from . import config, download, moments, render, setup_tasks, transcribe

STAGES = ["download", "audio", "transcribe", "moments", "render"]


class Cancelled(Exception):
    pass


class Job:
    def __init__(self, source, options, jid=None):
        self.id = jid or time.strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:4]
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
            "id": self.id, "source": self.source, "options": self.options, "title": self.title,
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
            j = Job(d["source"], d.get("options", {}), d["id"])
            j.title, j.status, j.stage = d.get("title", ""), d.get("status"), d.get("stage", "")
            j.progress, j.message = d.get("progress"), d.get("message", "")
            j.log_lines, j.clips, j.error = d.get("log", []), d.get("clips", []), d.get("error", "")
            j.created = d.get("created", 0)
            if j.status in ("queued", "running"):
                j.status, j.message = "failed", "Interrupted (app was closed). Submit it again."
                j.save(force=True)
            self.jobs[j.id] = j

    def submit(self, source, options):
        j = Job(source, options)
        j.log(f"Queued: {source}")
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

    src, title = download.fetch(job.source, job.dir, o.get("section"), ctx)
    job.title = title
    duration = media_duration(src)
    ctx.log(f"Got video: {title} ({duration/60:.1f} min)")

    ctx.stage("audio", None, "Pulling audio out")
    audio = job.dir / "audio.wav"
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", str(src), "-vn", "-ac", "1", "-ar", "16000",
                    str(audio)], check=True)

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

    picks = moments.find_moments(words, int(o.get("max_clips", 5)), float(o.get("min_len", 20)),
                                 float(o.get("max_len", 60)), ctx)
    if not picks:
        raise RuntimeError("The LLM didn't find any clip-worthy moments")
    ctx.log(f"Picked {len(picks)} moment(s)")
    (job.dir / "moments.json").write_text(json.dumps(picks, indent=2))

    for n, clip in enumerate(picks, 1):
        name = f"clip_{n:02d}.mp4"
        render.render_clip(src, words, clip, job.dir / name, job.dir, o.get("layout", "auto"), ctx,
                           f"Clip {n}/{len(picks)}")
        clip["file"] = name
        job.clips.append(clip)
        ctx.log(f"Rendered {name} ({clip['end']-clip['start']:.0f}s, score {clip['score']}, {clip['layout']})")
        job.save(force=True)
    audio.unlink(missing_ok=True)
