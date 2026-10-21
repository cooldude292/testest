import platform
import shutil
import subprocess
import time
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import config, setup_tasks
from .download import parse_section
from .jobs import Manager

app = FastAPI(title="Clipper")
manager = Manager()
setup_tasks.start()

app.mount("/files", StaticFiles(directory=config.JOBS_DIR), name="files")


class NewJob(BaseModel):
    source: str
    section: str = ""
    max_clips: int = 5
    min_len: int = 20
    max_len: int = 60
    layout: str = "auto"


def _options(section, max_clips, min_len, max_len, layout):
    try:
        parse_section(section)
    except ValueError as ex:
        raise HTTPException(400, str(ex))
    if layout not in ("auto", "track", "split", "zoom", "fit", "center"):
        raise HTTPException(400, "layout must be auto, track, split, zoom, fit or center")
    min_len, max_len = max(5, min_len), max(min_len + 5, max_len)
    return {"section": section, "max_clips": max(1, min(30, max_clips)), "min_len": min_len,
            "max_len": max_len, "layout": layout}


@app.get("/")
def index():
    return FileResponse(Path(__file__).parent / "static" / "index.html")


@app.get("/api/state")
def get_state():
    return {"setup": setup_tasks.state, "ready": setup_tasks.ready(), "jobs": manager.list(),
            "llm": config.LLM_MODEL, "whisper": config.WHISPER_MODEL}


@app.post("/api/setup/retry")
def retry_setup():
    setup_tasks.start()
    return {"ok": True}


@app.post("/api/jobs")
def create_job(body: NewJob):
    if not body.source.strip():
        raise HTTPException(400, "Paste a link or a file path")
    opts = _options(body.section, body.max_clips, body.min_len, body.max_len, body.layout)
    return manager.submit(body.source.strip(), opts).to_dict()


@app.post("/api/upload")
def upload(file: UploadFile = File(...), section: str = Form(""), max_clips: int = Form(5),
           min_len: int = Form(20), max_len: int = Form(60), layout: str = Form("auto")):
    opts = _options(section, max_clips, min_len, max_len, layout)
    name = Path(file.filename or "upload.mp4").name
    dest = config.UPLOADS_DIR / f"{time.strftime('%Y%m%d-%H%M%S')}-{name}"
    with dest.open("wb") as f:
        shutil.copyfileobj(file.file, f, 1024 * 1024)
    return manager.submit(str(dest), opts).to_dict()


@app.post("/api/jobs/{jid}/cancel")
def cancel(jid: str):
    manager.cancel(jid)
    return {"ok": True}


@app.post("/api/jobs/{jid}/retry")
def retry(jid: str):
    if not manager.retry(jid):
        raise HTTPException(400, "Only failed or cancelled jobs can be retried")
    return {"ok": True}


@app.post("/api/jobs/{jid}/reveal")
def reveal(jid: str):
    d = config.JOBS_DIR / jid
    if not d.is_dir():
        raise HTTPException(404)
    if platform.system() == "Darwin":
        subprocess.Popen(["open", str(d)])
    return {"path": str(d)}
