"""First-run setup that shows up on the status page: Ollama, the LLM, Whisper, face model."""
import json
import shutil
import subprocess
import threading
import time

import requests

from . import config

STEPS = [
    ("ffmpeg", "ffmpeg"),
    ("faces", "Face detection model"),
    ("ollama", "Ollama server"),
    ("llm", f"LLM ({config.LLM_MODEL})"),
    ("whisper", f"Whisper ({config.WHISPER_MODEL})"),
]

state = {k: {"label": label, "status": "pending", "progress": None, "message": ""} for k, label in STEPS}
_lock = threading.Lock()
_running = False


def _set(key, status=None, progress=None, message=None):
    s = state[key]
    if status is not None:
        s["status"] = status
    s["progress"] = progress
    if message is not None:
        s["message"] = message


def ready():
    return all(s["status"] == "ok" for s in state.values())


def start():
    global _running
    with _lock:
        if _running:
            return
        _running = True
    threading.Thread(target=_run_all, daemon=True).start()


def _run_all():
    global _running
    try:
        for key, fn in (("ffmpeg", _ffmpeg), ("faces", _faces), ("ollama", _ollama),
                        ("llm", _llm), ("whisper", _whisper)):
            if state[key]["status"] == "ok":
                continue
            _set(key, "running", None, "Checking")
            try:
                fn(key)
                _set(key, "ok", 1.0)
            except Exception as ex:
                _set(key, "error", None, f"{type(ex).__name__}: {ex}")
    finally:
        _running = False


def _ffmpeg(key):
    missing = [b for b in ("ffmpeg", "ffprobe") if not shutil.which(b)]
    if missing:
        raise RuntimeError(f"Not installed: {', '.join(missing)}. Run start.sh again.")
    _set(key, message="Found")


def _faces(key):
    if config.FACE_MODEL.exists() and config.FACE_MODEL.stat().st_size > 100_000:
        _set(key, message="Found")
        return
    _set(key, message="Downloading")
    r = requests.get(config.FACE_MODEL_URL, timeout=60)
    r.raise_for_status()
    config.FACE_MODEL.write_bytes(r.content)
    _set(key, message="Downloaded")


def _ollama_up():
    try:
        return requests.get(f"{config.OLLAMA_URL}/api/version", timeout=2).ok
    except requests.RequestException:
        return False


def _ollama(key):
    if _ollama_up():
        _set(key, message="Running")
        return
    exe = shutil.which("ollama")
    if not exe:
        raise RuntimeError("Ollama isn't installed. On a Mac: brew install ollama")
    _set(key, message="Starting ollama serve")
    log = open(config.DATA / "ollama.log", "ab")
    subprocess.Popen([exe, "serve"], stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    for _ in range(60):
        if _ollama_up():
            _set(key, message="Running")
            return
        time.sleep(0.5)
    raise RuntimeError(f"Ollama didn't start. Check {config.DATA / 'ollama.log'}")


def _llm(key):
    want = config.LLM_MODEL if ":" in config.LLM_MODEL else config.LLM_MODEL + ":latest"
    tags = requests.get(f"{config.OLLAMA_URL}/api/tags", timeout=10).json().get("models", [])
    if any(m.get("name") == want or m.get("model") == want for m in tags):
        _set(key, message="Already downloaded")
        return
    layers = {}
    with requests.post(f"{config.OLLAMA_URL}/api/pull", json={"model": config.LLM_MODEL, "stream": True},
                       stream=True, timeout=(10, 600)) as r:
        r.raise_for_status()
        for line in r.iter_lines():
            if not line:
                continue
            d = json.loads(line)
            if d.get("error"):
                raise RuntimeError(d["error"])
            if d.get("digest") and d.get("total"):
                layers[d["digest"]] = (d["total"], d.get("completed") or 0)
            total = sum(t for t, _ in layers.values())
            done = sum(c for _, c in layers.values())
            msg = d.get("status", "")
            if total:
                msg = f"Downloading {done/1e9:.2f} / {total/1e9:.2f} GB"
            _set(key, progress=(done / total) if total else None, message=msg)
    _set(key, message="Downloaded")


def _whisper_repo():
    if config.IS_APPLE_SILICON:
        return config.WHISPER_MODEL
    from faster_whisper.utils import _MODELS
    return _MODELS.get(config.WHISPER_MODEL, config.WHISPER_MODEL)


def _whisper(key):
    from huggingface_hub import HfApi, snapshot_download
    from huggingface_hub.constants import HF_HUB_CACHE
    from pathlib import Path

    repo = _whisper_repo()
    if Path(repo).exists():
        _set(key, message="Using local model folder")
        return
    try:
        snapshot_download(repo, local_files_only=True)
        _set(key, message="Already downloaded")
        return
    except Exception:
        pass

    try:
        info = HfApi().model_info(repo, files_metadata=True)
        total = sum(s.size or 0 for s in info.siblings)
    except Exception:
        total = 0
    blobs = Path(HF_HUB_CACHE) / f"models--{repo.replace('/', '--')}" / "blobs"
    done_flag = threading.Event()

    def watch():
        while not done_flag.is_set():
            size = sum(f.stat().st_size for f in blobs.glob("*") if f.is_file()) if blobs.exists() else 0
            frac = min(0.99, size / total) if total else None
            _set(key, progress=frac, message=f"Downloading {size/1e6:.0f}" + (f" / {total/1e6:.0f} MB" if total else " MB"))
            time.sleep(0.5)

    threading.Thread(target=watch, daemon=True).start()
    try:
        if config.IS_APPLE_SILICON:
            snapshot_download(repo)
        else:
            from faster_whisper.utils import download_model
            download_model(config.WHISPER_MODEL)
    finally:
        done_flag.set()
    _set(key, message="Downloaded")


def ensure_ollama():
    """Ollama can quit between jobs (laptop sleep, app closed). Bring it back if so."""
    if not _ollama_up():
        _ollama("ollama")
