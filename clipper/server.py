import os
import platform
import shutil
import subprocess
import time
from pathlib import Path

import requests
from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.background import BackgroundTask

from . import config, setup_tasks, sources
from .jobs import Manager

app = FastAPI(title=config.APP_NAME)
manager = Manager()
if not os.environ.get("CLIPWORKS_NO_SETUP"):  # the selftest drives setup steps itself
    setup_tasks.start()

STATIC = Path(__file__).parent / "static"
app.mount("/files", StaticFiles(directory=config.JOBS_DIR), name="files")
app.mount("/static", StaticFiles(directory=STATIC), name="static")


class ProbeReq(BaseModel):
    source: str


class OrderReq(BaseModel):
    source: str
    start: float
    end: float
    max_clips: int = 4
    min_len: int = 20
    max_len: int = 60
    layout: str = "auto"
    title: str = ""


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-store"})


@app.get("/api/state")
def get_state():
    return {
        "setup": setup_tasks.state, "ready": setup_tasks.ready(), "jobs": manager.list(),
        "app": {"name": config.APP_NAME, "version": config.VERSION, "llm": config.LLM_MODEL,
                "whisper": config.WHISPER_MODEL, "data": str(config.DATA), "exports": str(config.EXPORT_DIR),
                "apple_silicon": config.IS_APPLE_SILICON},
    }


@app.post("/api/setup/retry")
def retry_setup():
    setup_tasks.start()
    return {"ok": True}


@app.post("/api/probe")
def probe(body: ProbeReq):
    if not body.source.strip():
        raise HTTPException(400, "Paste a link or pick a file")
    try:
        return sources.probe(body.source)
    except FileNotFoundError as ex:
        raise HTTPException(404, str(ex))
    except Exception as ex:
        raise HTTPException(422, f"Couldn't load that source: {str(ex).splitlines()[0][:300]}")


@app.get("/api/recent")
def recent():
    return sources.recent()


@app.get("/api/heatmap/{key}")
def heatmap(key: str):
    try:
        return sources.heatmap(key)
    except KeyError:
        raise HTTPException(404, "Load the source again")


@app.get("/api/preview/{key}")
def preview(key: str, request: Request, u: str = ""):
    try:
        info = sources.upstream(key)
    except KeyError:
        raise HTTPException(404, "Load the source again")
    if info["preview_type"] == "file" and not u:
        return FileResponse(info["upstream"])
    url = u or info["upstream"]
    if not url.startswith(("http://", "https://")):
        raise HTTPException(400)
    headers = dict(info["headers"])
    if request.headers.get("range"):
        headers["Range"] = request.headers["range"]
    r = requests.get(url, headers=headers, stream=True, timeout=30)
    ctype = r.headers.get("content-type", "")
    if url.split("?")[0].endswith(".m3u8") or "mpegurl" in ctype.lower():
        text = r.text
        r.close()
        return Response(sources.rewrite_m3u8(key, url, text), media_type="application/vnd.apple.mpegurl")
    keep = {k: v for k, v in r.headers.items()
            if k.lower() in ("content-type", "content-length", "content-range", "accept-ranges")}
    return StreamingResponse(r.iter_content(256 * 1024), status_code=r.status_code, headers=keep,
                             background=BackgroundTask(r.close))


@app.post("/api/upload")
def upload(file: UploadFile = File(...)):
    """Browser fallback for opening a local file (the Mac app uses a native picker instead)."""
    name = Path(file.filename or "upload.mp4").name
    dest = config.UPLOADS_DIR / f"{time.strftime('%Y%m%d-%H%M%S')}-{name}"
    with dest.open("wb") as f:
        shutil.copyfileobj(file.file, f, 1024 * 1024)
    return sources.probe(str(dest))


@app.post("/api/orders")
def create_order(body: OrderReq):
    if body.end - body.start < 10:
        raise HTTPException(400, "Select at least 10 seconds")
    if body.layout not in ("auto", "track", "split", "zoom", "fit", "center"):
        raise HTTPException(400, "Unknown layout")
    min_len = max(5, body.min_len)
    max_len = max(min_len + 5, body.max_len)
    opts = {"section": f"{body.start:.2f}-{body.end:.2f}", "start": body.start, "end": body.end,
            "max_clips": max(1, min(20, body.max_clips)), "min_len": min_len, "max_len": max_len,
            "layout": body.layout, "source_title": body.title}
    return manager.submit(body.source.strip(), opts).to_dict()


@app.post("/api/orders/{jid}/cancel")
def cancel(jid: str):
    manager.cancel(jid)
    return {"ok": True}


@app.post("/api/orders/{jid}/retry")
def retry(jid: str):
    if not manager.retry(jid):
        raise HTTPException(400, "Only failed or cancelled orders can be re-run")
    return {"ok": True}


@app.delete("/api/orders/{jid}")
def delete(jid: str):
    if not manager.delete(jid):
        raise HTTPException(400, "Can't delete an order that's still in production")
    return {"ok": True}


def _reveal(path):
    if platform.system() == "Darwin":
        subprocess.Popen(["open", str(path)])


@app.post("/api/orders/{jid}/reveal")
def reveal(jid: str):
    j = manager.jobs.get(jid)
    if not j:
        raise HTTPException(404)
    path = Path(j.export_dir) if j.export_dir and Path(j.export_dir).exists() else j.dir
    _reveal(path)
    return {"path": str(path)}


@app.post("/api/reveal-exports")
def reveal_exports():
    _reveal(config.EXPORT_DIR)
    return {"path": str(config.EXPORT_DIR)}
