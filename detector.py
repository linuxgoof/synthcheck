import os
import logging
import subprocess
import numpy as np
from pathlib import Path
from PIL import Image
import cv2

logger = logging.getLogger(__name__)


# ── Overlay helpers ────────────────────────────────────────────────────────────

def _score_to_color(score: float) -> tuple:
    """Map AI probability (0.0=real, 1.0=AI) to a BGR color (green→yellow→red)."""
    score = max(0.0, min(1.0, score))
    if score <= 0.5:
        t = score * 2.0
        return (0, 200, int(t * 200))           # green → yellow
    else:
        t = (score - 0.5) * 2.0
        return (0, int((1.0 - t) * 200), 200)   # yellow → red


def _draw_meter_overlay(frame: np.ndarray, ai_score: float) -> np.ndarray:
    """Draw the AI probability meter HUD onto a BGR frame. Returns the frame."""
    h, w = frame.shape[:2]
    shorter = min(w, h)

    # Scale everything off the shorter edge so portrait & landscape both look right
    panel_w  = max(100, min(220, int(shorter * 0.13)))
    bar_h    = max(180, min(420, int(h    * 0.30)))
    bar_w_px = max(24,  int(panel_w * 0.26))
    lbl_h    = max(36,  int(panel_w * 0.32))   # space for each text label
    panel_h  = bar_h + lbl_h * 2
    margin   = max(14, int(shorter * 0.018))
    px = w - panel_w - margin
    py = h - panel_h - margin

    if px < 4 or py < 4:
        return frame  # video too small

    # Semi-transparent dark panel
    roi = frame[py:py + panel_h, px:px + panel_w]
    bg  = np.full_like(roi, (18, 18, 28))
    frame[py:py + panel_h, px:px + panel_w] = cv2.addWeighted(roi, 0.2, bg, 0.8, 0)
    cv2.rectangle(frame, (px, py), (px + panel_w - 1, py + panel_h - 1), (55, 55, 75), 1)

    font = cv2.FONT_HERSHEY_SIMPLEX
    fscl = max(0.5, panel_w / 200.0)
    thk  = max(1, int(fscl * 1.6))   # text thickness scales with font

    # "AI" label at top
    lbl_offset = max(18, int(lbl_h * 0.75))
    cv2.putText(frame, "AI",
                (px + panel_w // 2 - int(fscl * 14), py + lbl_offset),
                font, fscl, (110, 110, 235), thk, cv2.LINE_AA)

    # Gradient bar
    bar_x = px + panel_w // 2 - bar_w_px // 2
    bar_y = py + lbl_h

    for i in range(bar_h):
        row_score = 1.0 - (i / (bar_h - 1))
        color    = _score_to_color(row_score)
        needle_i = int((1.0 - ai_score) * (bar_h - 1))
        dist     = abs(i - needle_i) / bar_h
        alpha    = max(0.25, 1.0 - dist * 2.5)
        frame[bar_y + i, bar_x: bar_x + bar_w_px] = tuple(int(c * alpha) for c in color)

    cv2.rectangle(frame, (bar_x - 1, bar_y), (bar_x + bar_w_px, bar_y + bar_h), (55, 55, 75), 1)

    # Needle
    needle_row   = bar_y + int((1.0 - ai_score) * (bar_h - 1))
    needle_color = _score_to_color(ai_score)
    n_thk        = max(2, bar_w_px // 8)
    dot_r        = max(5, bar_w_px // 4)
    cv2.line(frame,   (bar_x - dot_r, needle_row), (bar_x + bar_w_px + dot_r, needle_row), needle_color, n_thk)
    cv2.circle(frame, (bar_x - dot_r - 2, needle_row), dot_r, needle_color, -1)

    # Score percentage (clamped inside bar area)
    pct_text = f"{int(ai_score * 100)}%"
    txt_y    = max(bar_y + int(fscl * 14), min(bar_y + bar_h - 4, needle_row + int(fscl * 6)))
    cv2.putText(frame, pct_text, (px + 4, txt_y), font, fscl * 0.88, needle_color, thk, cv2.LINE_AA)

    # "REAL" label at bottom
    cv2.putText(frame, "REAL",
                (px + panel_w // 2 - int(fscl * 22), py + panel_h - int(lbl_h * 0.22)),
                font, fscl * 0.9, (75, 200, 75), thk, cv2.LINE_AA)

    # SynthCheck watermark bottom-left
    wm_scale = max(0.4, min(0.7, shorter / 1400.0))
    cv2.putText(frame, "SynthCheck", (8, h - 10), font, wm_scale, (90, 90, 90), 1, cv2.LINE_AA)

    return frame


def _remux_with_ffmpeg(original: str, video_only: str, output: str) -> bool:
    """Use ffmpeg to combine the rendered video with the original audio track."""
    def run(cmd: list) -> bool:
        try:
            r = subprocess.run(cmd, capture_output=True, timeout=600)
            return r.returncode == 0 and os.path.exists(output) and os.path.getsize(output) > 0
        except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
            return False

    base = ["ffmpeg", "-y", "-i", video_only, "-i", original,
            "-c:v", "libx264", "-preset", "ultrafast", "-crf", "22"]

    # Try with audio first
    if run(base + ["-c:a", "aac", "-map", "0:v:0", "-map", "1:a:0", "-shortest", output]):
        return True

    # No audio track — encode video only
    if os.path.exists(output):
        os.unlink(output)
    return run(["ffmpeg", "-y", "-i", video_only,
                "-c:v", "libx264", "-preset", "ultrafast", "-crf", "22", output])

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

    def export_video_overlay(self, video_path: str, output_path: str, max_frames: int = 12) -> dict:
        """
        Analyze a video and re-export it with a live AI probability meter overlaid.
        Returns the analysis result dict.
        """
        logger.info("Running frame analysis for overlay export...")
        result    = self.analyze_video(video_path, max_frames=max_frames)
        frames    = result["frame_results"]
        ts_array  = np.array([f["timestamp"]      for f in frames], dtype=float)
        ai_array  = np.array([f["ai_probability"]  for f in frames], dtype=float)

        cap = cv2.VideoCapture(video_path)
        if not cap.isOpened():
            raise ValueError(f"Cannot open video: {video_path}")

        fps          = cap.get(cv2.CAP_PROP_FPS) or 24.0
        width        = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        height       = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

        tmp_video = output_path + ".noaudio.mp4"
        fourcc    = cv2.VideoWriter_fourcc(*"mp4v")
        writer    = cv2.VideoWriter(tmp_video, fourcc, fps, (width, height))

        logger.info(f"Rendering {total_frames} frames with overlay...")
        frame_idx = 0
        while True:
            ret, frame = cap.read()
            if not ret:
                break
            current_time = frame_idx / fps
            ai_score     = float(np.interp(current_time, ts_array, ai_array))
            writer.write(_draw_meter_overlay(frame, ai_score))
            frame_idx += 1

        cap.release()
        writer.release()
        logger.info("Frame rendering complete. Running ffmpeg...")

        if _remux_with_ffmpeg(video_path, tmp_video, output_path):
            if os.path.exists(tmp_video):
                os.unlink(tmp_video)
        else:
            logger.warning("ffmpeg unavailable or failed; serving mp4v output (no audio remux).")
            os.rename(tmp_video, output_path)

        logger.info(f"Export complete: {output_path}")
        return result

    def extract_thumbnail(self, file_path: str, output_path: str, file_type: str) -> bool:
        """Extract a small JPEG thumbnail from an image or video. Returns True on success."""
        try:
            if file_type == "image":
                img = Image.open(file_path).convert("RGB")
                w, h = img.size
                if w > 320:
                    img = img.resize((320, int(h * 320 / w)), Image.LANCZOS)
                img.save(output_path, "JPEG", quality=80)
                return True
            elif file_type == "video":
                cap = cv2.VideoCapture(file_path)
                if not cap.isOpened():
                    return False
                total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
                cap.set(cv2.CAP_PROP_POS_FRAMES, max(0, total // 2))
                ret, frame = cap.read()
                cap.release()
                if not ret:
                    return False
                h, w = frame.shape[:2]
                if w > 320:
                    frame = cv2.resize(frame, (320, int(h * 320 / w)))
                cv2.imwrite(output_path, frame, [cv2.IMWRITE_JPEG_QUALITY, 80])
                return True
        except Exception as e:
            logger.warning(f"Thumbnail extraction failed: {e}")
        return False

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
