import os
import logging
import numpy as np
from pathlib import Path
from PIL import Image
import cv2

logger = logging.getLogger(__name__)

SUPPORTED_IMAGES = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".tiff", ".avif"}
SUPPORTED_VIDEOS = {".mp4", ".avi", ".mov", ".mkv", ".webm", ".flv", ".wmv", ".m4v"}

# Primary model: trained specifically to distinguish AI-generated vs real images
# Labels: "artificial" (AI) and "human" (real)
PRIMARY_MODEL = "umm-maybe/AI-image-detector"

# Secondary model: SDXL / general diffusion detector for ensemble
SECONDARY_MODEL = "Organika/sdxl-detector"


class AIDetector:
    def __init__(self, use_ensemble: bool = True):
        self.primary = None
        self.secondary = None
        self.use_ensemble = use_ensemble
        self._load_models()

    def _load_models(self):
        from transformers import pipeline

        logger.info("Loading primary detection model...")
        self.primary = pipeline(
            "image-classification",
            model=PRIMARY_MODEL,
            device=-1,
        )
        logger.info("Primary model loaded.")

        if self.use_ensemble:
            try:
                logger.info("Loading secondary detection model...")
                self.secondary = pipeline(
                    "image-classification",
                    model=SECONDARY_MODEL,
                    device=-1,
                )
                logger.info("Secondary model loaded.")
            except Exception as e:
                logger.warning(f"Secondary model failed to load: {e}. Continuing with primary only.")
                self.secondary = None

    def _run_primary(self, img: Image.Image) -> dict:
        results = self.primary(img)
        scores = {r["label"]: r["score"] for r in results}
        ai_score = scores.get("artificial", 0.0)
        real_score = scores.get("human", 0.0)
        total = ai_score + real_score
        if total > 0:
            ai_score /= total
            real_score /= total
        return {"ai": ai_score, "real": real_score}

    def _run_secondary(self, img: Image.Image) -> dict | None:
        if self.secondary is None:
            return None
        try:
            results = self.secondary(img)
            scores = {r["label"]: r["score"] for r in results}
            # sdxl-detector: "artificial" vs "real" or similar labels
            ai_score = scores.get("artificial", scores.get("AI", scores.get("fake", 0.0)))
            real_score = scores.get("real", scores.get("human", scores.get("genuine", 0.0)))
            # If neither found, use the highest label
            if ai_score == 0 and real_score == 0:
                sorted_results = sorted(results, key=lambda x: x["score"], reverse=True)
                top_label = sorted_results[0]["label"].lower()
                top_score = sorted_results[0]["score"]
                if any(w in top_label for w in ["ai", "fake", "artificial", "generated", "synthetic"]):
                    ai_score = top_score
                    real_score = 1 - top_score
                else:
                    real_score = top_score
                    ai_score = 1 - top_score
            total = ai_score + real_score
            if total > 0:
                ai_score /= total
                real_score /= total
            return {"ai": ai_score, "real": real_score}
        except Exception as e:
            logger.warning(f"Secondary model inference failed: {e}")
            return None

    def _classify_image(self, img: Image.Image) -> dict:
        img_rgb = img.convert("RGB")
        primary = self._run_primary(img_rgb)

        if self.use_ensemble and self.secondary:
            secondary = self._run_secondary(img_rgb)
            if secondary:
                # Weighted ensemble: primary 70%, secondary 30%
                ai_score = 0.7 * primary["ai"] + 0.3 * secondary["ai"]
                real_score = 0.7 * primary["real"] + 0.3 * secondary["real"]
            else:
                ai_score = primary["ai"]
                real_score = primary["real"]
        else:
            ai_score = primary["ai"]
            real_score = primary["real"]

        is_ai = ai_score > real_score
        return {
            "is_ai": is_ai,
            "verdict": "AI Generated" if is_ai else "Real / Authentic",
            "confidence": float(max(ai_score, real_score)),
            "ai_probability": float(ai_score),
            "real_probability": float(real_score),
        }

    def analyze_image(self, image_path: str) -> dict:
        img = Image.open(image_path)
        result = self._classify_image(img)
        result["type"] = "image"
        result["filename"] = Path(image_path).name
        return result

    def analyze_video(self, video_path: str, max_frames: int = 12) -> dict:
        cap = cv2.VideoCapture(video_path)
        if not cap.isOpened():
            raise ValueError(f"Cannot open video: {video_path}")

        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        fps = cap.get(cv2.CAP_PROP_FPS) or 24
        duration = total_frames / fps

        # Distribute sampled frames evenly across the video, skipping first/last 5%
        margin = int(total_frames * 0.05)
        start = max(0, margin)
        end = max(start + 1, total_frames - margin)
        n = min(max_frames, end - start)
        frame_indices = np.linspace(start, end - 1, n, dtype=int).tolist()

        frame_results = []
        for idx in frame_indices:
            cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
            ret, frame = cap.read()
            if not ret:
                continue
            frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            img = Image.fromarray(frame_rgb)
            try:
                fr = self._classify_image(img)
                fr["frame_index"] = int(idx)
                fr["timestamp"] = round(idx / fps, 2)
                frame_results.append(fr)
            except Exception as e:
                logger.warning(f"Frame {idx} analysis failed: {e}")

        cap.release()

        if not frame_results:
            raise ValueError("Could not extract any analyzable frames from the video.")

        ai_scores = [f["ai_probability"] for f in frame_results]
        real_scores = [f["real_probability"] for f in frame_results]
        avg_ai = float(np.mean(ai_scores))
        avg_real = float(np.mean(real_scores))
        is_ai = avg_ai > avg_real

        # Temporal consistency: low std = consistent, high std = mixed/uncertain
        consistency = float(1.0 - np.std(ai_scores))

        return {
            "type": "video",
            "filename": Path(video_path).name,
            "is_ai": is_ai,
            "verdict": "AI Generated" if is_ai else "Real / Authentic",
            "confidence": float(max(avg_ai, avg_real)),
            "ai_probability": avg_ai,
            "real_probability": avg_real,
            "temporal_consistency": round(consistency, 3),
            "duration_seconds": round(duration, 2),
            "total_frames": total_frames,
            "frames_analyzed": len(frame_results),
            "fps": round(fps, 2),
            "frame_results": frame_results,
        }
