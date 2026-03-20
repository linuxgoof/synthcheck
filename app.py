import os
import secrets
import hashlib
import tempfile
import logging
from pathlib import Path
from contextlib import asynccontextmanager

from fastapi import FastAPI, File, UploadFile, HTTPException, Depends, Header
from fastapi.staticfiles import StaticFiles
from fastapi.responses import JSONResponse, FileResponse
from starlette.background import BackgroundTask
from pydantic import BaseModel

import database as db
from detector import AIDetector, generate_tags, SUPPORTED_IMAGES, SUPPORTED_VIDEOS

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

MAX_FILE_SIZE_MB = int(os.getenv("MAX_FILE_SIZE_MB", "2048"))
MAX_VIDEO_FRAMES = int(os.getenv("MAX_VIDEO_FRAMES", "12"))

detector: AIDetector | None = None

# ── Admin key ─────────────────────────────────────────────────────────────────

def _load_or_create_admin_key() -> str:
    env_key = os.getenv("ADMIN_KEY", "").strip()
    if env_key:
        return env_key
    key_file = db.DATA_DIR / ".admin_key"
    db.DATA_DIR.mkdir(parents=True, exist_ok=True)
    if key_file.exists():
        return key_file.read_text().strip()
    new_key = secrets.token_urlsafe(20)
    key_file.write_text(new_key)
    return new_key

ADMIN_KEY: str = ""   # set in lifespan


def _require_admin(x_admin_key: str = Header(default=None)):
    if not ADMIN_KEY or x_admin_key != ADMIN_KEY:
        raise HTTPException(status_code=401, detail="Unauthorized")


# ── App lifecycle ──────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    global detector, ADMIN_KEY
    db.init_db()
    ADMIN_KEY = _load_or_create_admin_key()
    logger.info("=" * 60)
    logger.info(f"  Admin key  : {ADMIN_KEY}")
    logger.info(f"  Admin panel: http://localhost:8000/lzxvven8.html")
    logger.info("=" * 60)
    logger.info("Initializing AI detector models (this may take a minute on first run)…")
    detector = AIDetector(use_ensemble=True)
    logger.info("Models ready. Server is up.")
    yield
    logger.info("Shutting down.")


app = FastAPI(
    title="SynthCheck",
    description="Detect whether images and videos are AI-generated or real.",
    version="1.0.0",
    lifespan=lifespan,
)


# ── Upload helper ──────────────────────────────────────────────────────────────

async def _save_upload(file: UploadFile, suffix: str) -> tuple[str, str]:
    hasher     = hashlib.sha256()
    chunk_size = 1024 * 1024
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        tmp_path   = tmp.name
        size_bytes = 0
        while True:
            chunk = await file.read(chunk_size)
            if not chunk:
                break
            size_bytes += len(chunk)
            if size_bytes > MAX_FILE_SIZE_MB * 1024 * 1024:
                os.unlink(tmp_path)
                raise HTTPException(
                    status_code=413,
                    detail=f"File too large. Maximum allowed size is {MAX_FILE_SIZE_MB} MB.",
                )
            hasher.update(chunk)
            tmp.write(chunk)
    return tmp_path, hasher.hexdigest()


# ── Public endpoints ───────────────────────────────────────────────────────────

@app.get("/api/health")
async def health():
    return {"status": "ok", "models_loaded": detector is not None}


@app.get("/api/library")
async def get_library():
    return JSONResponse(content=db.get_library())


@app.get("/api/result/{file_hash}")
async def get_result(file_hash: str):
    result = db.get_result(file_hash)
    if result is None:
        raise HTTPException(status_code=404, detail="Not found.")
    return JSONResponse(content=result)


@app.get("/api/thumbnail/{file_hash}")
async def get_thumbnail(file_hash: str):
    path = db.THUMBS_DIR / f"{file_hash}.jpg"
    if not path.exists():
        raise HTTPException(status_code=404, detail="Thumbnail not found.")
    return FileResponse(str(path), media_type="image/jpeg")


@app.get("/api/overlay/{file_hash}")
async def get_overlay(file_hash: str):
    overlay_path = db.get_overlay_path(file_hash)
    if not overlay_path:
        raise HTTPException(status_code=404, detail="Overlay not found.")
    return FileResponse(overlay_path, media_type="video/mp4")


@app.get("/api/tags/all")
async def tags_all():
    return JSONResponse(content=db.all_tags_with_counts())


@app.get("/api/tags/{file_hash}")
async def tags_for_item(file_hash: str):
    return JSONResponse(content={"tags": db.get_tags(file_hash)})


class TagsPayload(BaseModel):
    tags: list[str]


@app.post("/api/tags/{file_hash}")
async def save_tags(file_hash: str, payload: TagsPayload):
    if db.get_result(file_hash) is None:
        raise HTTPException(status_code=404, detail="Item not found.")
    clean = [t.strip().lower() for t in payload.tags if t.strip()][:20]
    db.save_tags(file_hash, clean, source="user")
    return JSONResponse(content={"tags": db.get_tags(file_hash)})


@app.delete("/api/tags/{file_hash}/{tag}")
async def delete_tag(file_hash: str, tag: str):
    db.delete_tag(file_hash, tag)
    return JSONResponse(content={"tags": db.get_tags(file_hash)})


@app.post("/api/analyze")
async def analyze(file: UploadFile = File(...)):
    if detector is None:
        raise HTTPException(status_code=503, detail="Models are still loading. Please retry in a moment.")

    suffix = Path(file.filename or "").suffix.lower()
    if suffix not in (SUPPORTED_IMAGES | SUPPORTED_VIDEOS):
        raise HTTPException(status_code=400, detail=f"Unsupported file type '{suffix}'.")

    tmp_path, file_hash = await _save_upload(file, suffix)

    cached = db.get_by_hash(file_hash)
    if cached:
        os.unlink(tmp_path)
        cached["filename"]       = file.filename
        cached["suggested_tags"] = []   # already accepted
        return JSONResponse(content=cached)

    try:
        file_type = "image" if suffix in SUPPORTED_IMAGES else "video"
        if file_type == "image":
            result = detector.analyze_image(tmp_path)
        else:
            result = detector.analyze_video(tmp_path, max_frames=MAX_VIDEO_FRAMES)

        suggested = generate_tags(tmp_path, file_type)

        result["filename"]       = file.filename
        result["file_hash"]      = file_hash
        result["cached"]         = False
        result["overlay_ready"]  = False
        result["suggested_tags"] = suggested
        result["tags"]           = []

        thumb_path = db.THUMBS_DIR / f"{file_hash}.jpg"
        if detector.extract_thumbnail(tmp_path, str(thumb_path), file_type):
            result["thumbnail_url"] = f"/api/thumbnail/{file_hash}"
        else:
            result["thumbnail_url"] = None

        db.save_analysis(
            file_hash, file.filename or "unknown", result,
            str(thumb_path) if thumb_path.exists() else None,
        )
        return JSONResponse(content=result)

    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:
        logger.exception("Analysis failed")
        raise HTTPException(status_code=500, detail=f"Analysis failed: {str(e)}")
    finally:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)


@app.post("/api/export-video")
async def export_video(file: UploadFile = File(...)):
    if detector is None:
        raise HTTPException(status_code=503, detail="Models are still loading. Please retry in a moment.")

    suffix = Path(file.filename or "").suffix.lower()
    if suffix not in SUPPORTED_VIDEOS:
        raise HTTPException(status_code=400, detail=f"Only video files supported. Got '{suffix}'.")

    tmp_path, file_hash = await _save_upload(file, suffix)
    stem = Path(file.filename or "video").stem

    cached_overlay = db.get_overlay_path(file_hash)
    if cached_overlay:
        os.unlink(tmp_path)
        return FileResponse(cached_overlay, media_type="video/mp4",
                            filename=f"synthcheck_{stem}.mp4")

    out_path = str(db.OVERLAYS_DIR / f"{file_hash}.mp4")

    def cleanup_tmp():
        try:
            if os.path.exists(tmp_path):
                os.unlink(tmp_path)
        except OSError:
            pass

    try:
        detector.export_video_overlay(tmp_path, out_path, max_frames=MAX_VIDEO_FRAMES)
        db.save_overlay_path(file_hash, out_path)
        return FileResponse(out_path, media_type="video/mp4",
                            filename=f"synthcheck_{stem}.mp4",
                            background=BackgroundTask(cleanup_tmp))
    except ValueError as e:
        cleanup_tmp()
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:
        cleanup_tmp()
        logger.exception("Video export failed")
        raise HTTPException(status_code=500, detail=f"Export failed: {str(e)}")


# ── Admin endpoints ────────────────────────────────────────────────────────────

@app.get("/api/admin/library")
async def admin_library(_: None = Depends(_require_admin)):
    return JSONResponse(content=db.get_library(limit=2000))


@app.get("/api/admin/tags")
async def admin_all_tags(_: None = Depends(_require_admin)):
    return JSONResponse(content=db.all_tags_with_counts())


@app.delete("/api/admin/item/{file_hash}")
async def admin_delete_item(file_hash: str, _: None = Depends(_require_admin)):
    paths = db.delete_item(file_hash)
    if not paths:
        raise HTTPException(status_code=404, detail="Item not found.")
    for key in ("thumbnail_path", "overlay_path"):
        p = paths.get(key)
        if p:
            try:
                Path(p).unlink(missing_ok=True)
            except OSError:
                pass
    return JSONResponse(content={"deleted": file_hash})


@app.delete("/api/admin/tag/{file_hash}/{tag}")
async def admin_delete_tag(file_hash: str, tag: str, _: None = Depends(_require_admin)):
    db.delete_tag(file_hash, tag)
    return JSONResponse(content={"tags": db.get_tags(file_hash)})


@app.post("/api/admin/tags/{file_hash}")
async def admin_save_tags(file_hash: str, payload: TagsPayload, _: None = Depends(_require_admin)):
    clean = [t.strip().lower() for t in payload.tags if t.strip()][:30]
    db.save_tags(file_hash, clean, source="admin")
    return JSONResponse(content={"tags": db.get_tags(file_hash)})


# ── Static frontend (mounted last) ─────────────────────────────────────────────
static_dir = Path(__file__).parent / "static"
app.mount("/", StaticFiles(directory=str(static_dir), html=True), name="static")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "app:app",
        host="0.0.0.0",
        port=int(os.getenv("PORT", "8000")),
        reload=False,
    )
