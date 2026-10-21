import os
import platform
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = Path(os.environ.get("CLIPPER_DATA", ROOT / "workspace")).expanduser()
JOBS_DIR = DATA / "jobs"
UPLOADS_DIR = DATA / "uploads"

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

for d in (JOBS_DIR, UPLOADS_DIR):
    d.mkdir(parents=True, exist_ok=True)
