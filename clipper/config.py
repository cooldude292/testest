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
    EXPORT_DIR = Path.home() / "Movies" / APP_NAME      # finished clips, where people expect them
else:
    DATA = ROOT / "workspace"
    EXPORT_DIR = DATA / "exports"
if os.environ.get("CLIPPER_DATA"):
    DATA = Path(os.environ["CLIPPER_DATA"]).expanduser()
    EXPORT_DIR = DATA / "exports"
if os.environ.get("CLIPPER_EXPORT"):
    EXPORT_DIR = Path(os.environ["CLIPPER_EXPORT"]).expanduser()
JOBS_DIR = DATA / "jobs"
UPLOADS_DIR = DATA / "uploads"
CACHE_DIR = DATA / "cache"
BIN_DIR = DATA / "bin"                         # tools downloaded at runtime (Ollama)

PORT = int(os.environ.get("CLIPPER_PORT", "8765"))

IS_APPLE_SILICON = platform.system() == "Darwin" and platform.machine() == "arm64"

# Local LLM served by Ollama. qwen3:8b is ~5GB and runs well on a 24GB Mac.
OLLAMA_URL = os.environ.get("CLIPPER_OLLAMA_URL", "http://127.0.0.1:11434").rstrip("/")
LLM_MODEL = os.environ.get("CLIPPER_LLM", "qwen3:8b")
LLM_CONTEXT = int(os.environ.get("CLIPPER_LLM_CTX", "16384"))

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

for d in (JOBS_DIR, UPLOADS_DIR, CACHE_DIR, BIN_DIR, EXPORT_DIR):
    d.mkdir(parents=True, exist_ok=True)

# Tools shipped inside the .app (ffmpeg, ffprobe, deno) and ones fetched later (ollama)
# are found through PATH, which is also how yt-dlp looks for ffmpeg and deno.
_extra = [str(BIN_DIR)]
if FROZEN:
    _extra.insert(0, str(Path(sys._MEIPASS) / "bin"))
os.environ["PATH"] = os.pathsep.join(_extra + [os.environ.get("PATH", ""),
                                               "/opt/homebrew/bin", "/usr/local/bin"])
