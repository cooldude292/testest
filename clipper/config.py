import os
import platform
import sys
from pathlib import Path

APP_NAME = "Clipworks"
VERSION = "2026.10"

ROOT = Path(__file__).resolve().parent.parent
FROZEN = getattr(sys, "frozen", False)          # running inside the packaged .app
APP_MODE = FROZEN or os.environ.get("CLIPWORKS_APP") == "1"

if APP_MODE and platform.system() == "Darwin":
    DATA = Path.home() / "Library" / "Application Support" / APP_NAME
else:
    DATA = ROOT / "workspace"
if os.environ.get("CLIPPER_DATA"):
    DATA = Path(os.environ["CLIPPER_DATA"]).expanduser()
DOWNLOADS = Path(os.environ.get("CLIPPER_DOWNLOADS", Path.home() / "Downloads")).expanduser()  # where Shipping delivers
JOBS_DIR = DATA / "jobs"
UPLOADS_DIR = DATA / "uploads"
CACHE_DIR = DATA / "cache"
BIN_DIR = DATA / "bin"                         # tools downloaded at runtime (Ollama)

PORT = int(os.environ.get("CLIPPER_PORT", "8765"))

IS_APPLE_SILICON = platform.system() == "Darwin" and platform.machine() == "arm64"

# Local LLM served by Ollama. Biggest model the Mac's memory takes, unless the user picked one
# on the System page (saved in settings.json) or set CLIPPER_LLM.
OLLAMA_URL = os.environ.get("CLIPPER_OLLAMA_URL", "http://127.0.0.1:11434").rstrip("/")
LLM_CHOICES = [  # (ollama tag, download GB, label)
    ("qwen3.5:35b-a3b", 22.1, "Qwen3.5 35B-A3B · smartest, fast for its size"),
    ("qwen3:30b-a3b", 18.6, "Qwen3 30B-A3B"),
    ("qwen3:14b", 9.3, "Qwen3 14B · safe on 16-24 GB"),
    ("qwen3:8b", 5.2, "Qwen3 8B · light"),
]
FALLBACK_LLM = "qwen3:14b"   # used automatically if the chosen model won't load


def _ram_gb():
    try:
        if platform.system() == "Darwin":
            import subprocess
            return int(subprocess.run(["sysctl", "-n", "hw.memsize"], capture_output=True, text=True).stdout) / 2**30
        return os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES") / 2**30
    except Exception:
        return 16.0


RAM_GB = _ram_gb()


def _default_llm():
    if RAM_GB >= 23:
        return "qwen3.5:35b-a3b"
    return "qwen3:14b" if RAM_GB >= 15 else "qwen3:8b"


def _saved_llm():
    import json
    try:
        return json.loads((DATA / "settings.json").read_text()).get("llm")
    except Exception:
        return None


LLM_MODEL = os.environ.get("CLIPPER_LLM") or _saved_llm() or _default_llm()


def save_setting(key, value):
    import json
    f = DATA / "settings.json"
    try:
        d = json.loads(f.read_text())
    except Exception:
        d = {}
    d[key] = value
    f.write_text(json.dumps(d))
LLM_CONTEXT = int(os.environ.get("CLIPPER_LLM_CTX", "16384"))
JUDGE_THINK = os.environ.get("CLIPPER_JUDGE_THINK", "1") != "0"   # let the model reason before judging a moment

# Whisper: MLX build on Apple Silicon, faster-whisper everywhere else.
WHISPER_MODEL = os.environ.get(
    "CLIPPER_WHISPER",
    "mlx-community/whisper-large-v3-turbo" if IS_APPLE_SILICON else "small",
)

FACE_MODEL = Path(__file__).parent / "models" / "face_detection_yunet_2023mar.onnx"
FACE_MODEL_URL = (
    "https://huggingface.co/opencv/face_detection_yunet/resolve/main/"
    "face_detection_yunet_2023mar.onnx"
)

OUT_W, OUT_H = 1080, 1920

for d in (JOBS_DIR, UPLOADS_DIR, CACHE_DIR, BIN_DIR):
    d.mkdir(parents=True, exist_ok=True)

# Tools shipped inside the .app (ffmpeg, ffprobe, deno) and ones fetched later (ollama)
# are found through PATH, which is also how yt-dlp looks for ffmpeg and deno.
_extra = [str(BIN_DIR)]
if FROZEN:
    _extra.insert(0, str(Path(sys._MEIPASS) / "bin"))
os.environ["PATH"] = os.pathsep.join(_extra + [os.environ.get("PATH", ""),
                                               "/opt/homebrew/bin", "/usr/local/bin"])
