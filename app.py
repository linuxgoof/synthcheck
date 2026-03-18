import os
import shutil
import tempfile
import logging
from pathlib import Path
from contextlib import asynccontextmanager

from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import JSONResponse

from detector import AIDetector, SUPPORTED_IMAGES, SUPPORTED_VIDEOS

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

MAX_FILE_SIZE_MB = int(os.getenv("MAX_FILE_SIZE_MB", "2048"))
MAX_VIDEO_FRAMES = int(os.getenv("MAX_VIDEO_FRAMES", "12"))

detector: AIDetector | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global detector
    logger.info("Initializing AI detector models (this may take a minute on first run)...")
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


@app.get("/api/health")
async def health():
    return {"status": "ok", "models_loaded": detector is not None}


@app.post("/api/analyze")
async def analyze(file: UploadFile = File(...)):
    if detector is None:
        raise HTTPException(status_code=503, detail="Models are still loading. Please retry in a moment.")

    suffix = Path(file.filename or "").suffix.lower()
    all_supported = SUPPORTED_IMAGES | SUPPORTED_VIDEOS
    if suffix not in all_supported:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file type '{suffix}'. Supported: {', '.join(sorted(all_supported))}",
        )

    # Stream to temp file, checking size
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        tmp_path = tmp.name
        size_bytes = 0
        chunk_size = 1024 * 1024  # 1 MB
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
            tmp.write(chunk)

    try:
        if suffix in SUPPORTED_IMAGES:
            result = detector.analyze_image(tmp_path)
        else:
            result = detector.analyze_video(tmp_path, max_frames=MAX_VIDEO_FRAMES)
        result["filename"] = file.filename
        return JSONResponse(content=result)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:
        logger.exception("Analysis failed")
        raise HTTPException(status_code=500, detail=f"Analysis failed: {str(e)}")
    finally:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)


# Serve frontend — must be mounted AFTER API routes
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
