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

from . import config, packaging, setup_tasks, sfx, sources
from .jobs import Manager

app = FastAPI(title=config.APP_NAME)
manager = Manager()
if not os.environ.get("CLIPWORKS_NO_SETUP"):  # the selftest drives setup steps itself
    setup_tasks.start()

STATIC = Path(__file__).parent / "static"
app.mount("/files", StaticFiles(directory=config.JOBS_DIR), name="files")
app.mount("/static", StaticFiles(directory=STATIC), name="static")
app.mount("/fonts", StaticFiles(directory=Path(__file__).parent / "fonts"), name="fonts")


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
    mode: str = "ai"          # "ai": find clips inside the range; "exact": the range is the clip
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
    if body.mode not in ("ai", "exact"):
        raise HTTPException(400, "Unknown mode")
    if body.mode == "ai" and body.end - body.start < 10:
        raise HTTPException(400, "Select at least 10 seconds")
    if body.mode == "exact" and not 3 <= body.end - body.start <= 180:
        raise HTTPException(400, "Exact cuts must be between 3 seconds and 3 minutes")
    if body.layout not in ("auto", "track", "split", "zoom", "fit", "center"):
        raise HTTPException(400, "Unknown layout")
    min_len = max(5, body.min_len)
    max_len = max(min_len + 5, body.max_len)
    opts = {"section": f"{body.start:.2f}-{body.end:.2f}", "start": body.start, "end": body.end,
            "max_clips": max(1, min(20, body.max_clips)), "min_len": min_len, "max_len": max_len,
            "layout": body.layout, "mode": body.mode, "source_title": body.title}
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


# ---------------- packaging ----------------

def _unit(jid, idx):
    try:
        return manager.unit(jid, idx)
    except KeyError:
        raise HTTPException(404, "Unit not found")


@app.get("/api/sfx")
def sfx_library():
    return sfx.library()


@app.get("/api/sfx/file/{sid:path}")
def sfx_file(sid: str):
    try:
        return FileResponse(sfx.path_for(sid))
    except FileNotFoundError:
        raise HTTPException(404)


@app.post("/api/sfx/import")
def sfx_import(file: UploadFile = File(...)):
    try:
        return {"id": sfx.import_file(file.filename or "sound", file.file)}
    except ValueError as ex:
        raise HTTPException(400, str(ex))


@app.post("/api/sfx/reveal")
def sfx_reveal():
    sfx.USER_DIR.mkdir(parents=True, exist_ok=True)
    _reveal(sfx.USER_DIR)
    return {"path": str(sfx.USER_DIR)}


@app.get("/api/units/{jid}/{idx}")
def unit_detail(jid: str, idx: int):
    j, c = _unit(jid, idx)
    words = manager.unit_words(j, c)
    spec = c.get("package") or packaging.default_spec(c)
    base = j.dir / c["file"].replace(".mp4", "_base.mp4")
    return {"spec": spec, "words": words, "duration": round(c["end"] - c["start"], 2),
            "base_url": f"/files/{jid}/{base.name}" if base.exists() else None, "layout": c.get("layout", "track")}


@app.put("/api/units/{jid}/{idx}/package")
def unit_save(jid: str, idx: int, spec: dict):
    _unit(jid, idx)
    return manager.save_package(jid, idx, spec)


@app.post("/api/units/{jid}/{idx}/retime")
def unit_retime(jid: str, idx: int, body: dict):
    j, c = _unit(jid, idx)
    return packaging.retime(manager.unit_words(j, c), str(body.get("text", "")))


@app.post("/api/units/{jid}/{idx}/suggest-sfx")
def unit_suggest(jid: str, idx: int, body: dict):
    j, c = _unit(jid, idx)
    words = body.get("words") or manager.unit_words(j, c)
    return packaging.suggest_sfx(words, str(body.get("hook", "")), c["end"] - c["start"])


@app.post("/api/units/{jid}/{idx}/render")
def unit_render(jid: str, idx: int):
    _unit(jid, idx)
    try:
        manager.queue_package(jid, idx)
    except ValueError as ex:
        raise HTTPException(400, str(ex))
    return {"ok": True}


# ---------------- shipping ----------------

UPLOAD_PAGES = {"tiktok": "https://www.tiktok.com/tiktokstudio/upload", "youtube": "https://www.youtube.com/upload",
                "instagram": "https://www.instagram.com/", "x": "https://x.com/compose/post"}


@app.get("/api/settings")
def get_settings():
    return packaging.load_settings()


@app.put("/api/settings")
def put_settings(body: dict):
    packaging.save_settings(body)
    return packaging.load_settings()


@app.post("/api/units/{jid}/{idx}/kit")
def unit_kit(jid: str, idx: int):
    _unit(jid, idx)
    return manager.make_kit(jid, idx, packaging.load_settings().get("campaign", ""))


@app.put("/api/units/{jid}/{idx}/ship")
def unit_ship(jid: str, idx: int, body: dict):
    _unit(jid, idx)
    return manager.update_ship(jid, idx, body)


@app.post("/api/units/{jid}/{idx}/reveal")
def unit_reveal(jid: str, idx: int):
    j, c = _unit(jid, idx)
    exp = (c.get("pkg") or {}).get("export")
    path = Path(exp) if exp and Path(exp).exists() else j.dir / c["file"]
    if platform.system() == "Darwin":
        subprocess.Popen(["open", "-R", str(path)])  # select the file in Finder, ready to drag
    return {"path": str(path)}


@app.post("/api/open-upload/{platform_id}")
def open_upload(platform_id: str):
    url = UPLOAD_PAGES.get(platform_id)
    if not url:
        raise HTTPException(404)
    if platform.system() == "Darwin":
        subprocess.Popen(["open", url])  # the user's own browser, where they're logged in
    return {"url": url}


@app.post("/api/clipboard")
def clipboard(body: dict):
    text = str(body.get("text", ""))
    if platform.system() != "Darwin" or not shutil.which("pbcopy"):
        raise HTTPException(501, "Clipboard helper only on macOS")
    subprocess.run(["pbcopy"], input=text.encode(), check=True)
    return {"ok": True}
