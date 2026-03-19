# SynthCheck — AI Content Detector

Detect whether an image or video is **AI-generated** or **real/authentic** using a dual-model ensemble.

## How it works

- **Primary model** — [`umm-maybe/AI-image-detector`](https://huggingface.co/umm-maybe/AI-image-detector): a ViT-based classifier trained on real images (LAION) and AI images (DALL-E, Stable Diffusion, MidJourney, etc.)
- **Secondary model** — [`Organika/sdxl-detector`](https://huggingface.co/Organika/sdxl-detector): a diffusion-specific detector
- Ensemble: 70% primary + 30% secondary weighted average
- **Video analysis**: evenly samples up to 12 frames across the video, runs both models on each frame, then aggregates results with a temporal consistency score
- **Video export**: re-renders the full video with a live AI probability meter burned into the corner — a green→yellow→red gauge whose needle tracks the AI score frame-by-frame

## Supported formats

| Type   | Extensions                                                      |
|--------|-----------------------------------------------------------------|
| Image  | `.jpg` `.jpeg` `.png` `.webp` `.gif` `.bmp` `.tiff` `.avif`    |
| Video  | `.mp4` `.avi` `.mov` `.mkv` `.webm` `.flv` `.wmv` `.m4v`       |

## Quick start

```bash
git clone https://github.com/linuxgoof/synthcheck.git
cd synthcheck
./start.sh
```

Then open [http://localhost:8000](http://localhost:8000) in your browser.

> **First run**: the models (~1–2 GB) will be downloaded automatically from HuggingFace and cached in `~/.cache/huggingface/`.

## Manual setup

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python app.py
```

## Library & result caching

Every analyzed file is stored in a local SQLite database (in `data/`). When the same file is uploaded again it's recognized by SHA-256 hash and the stored result is returned instantly — no re-running the models.

- **Library view** — click the **Library** button in the header to browse all previously analyzed files as a card grid with thumbnails, verdict badges, and AI scores
- **Instant cache hits** — re-uploading a known file shows an "Instant result" banner with the original analysis date
- **Overlay caching** — exported overlay videos are stored in `data/overlays/` and served directly on subsequent requests; the export button becomes **Download Overlay** once a file has been exported

All data lives in `data/` (gitignored). Delete that directory to clear the library.

## Video export

After analyzing a video, an **Export with Overlay** button appears in the results. Clicking it re-uploads the video, renders every frame with the AI meter HUD burned in, and downloads the result as `synthcheck_<filename>.mp4`.

The meter shows a vertical green→yellow→red gradient bar with a moving needle indicating the current frame's AI probability. Scores are interpolated smoothly between the analyzed keyframes. Audio is preserved via `ffmpeg` if available on the server.

> **Note:** Export re-analyzes the video, so processing time scales with video length. A 1-minute 30fps video typically takes 15–30 seconds on a CPU.

## Environment variables

| Variable           | Default | Description                  |
|--------------------|---------|------------------------------|
| `PORT`             | `8000`  | HTTP port                    |
| `MAX_FILE_SIZE_MB` | `2048`  | Maximum upload size in MB    |
| `MAX_VIDEO_FRAMES` | `12`    | Max frames sampled per video |

## Project structure

```
synthcheck/
├── app.py           # FastAPI backend — all API routes
├── detector.py      # Detection logic (models, image/video analysis, overlay renderer)
├── database.py      # SQLite library — hash dedup, thumbnail & overlay caching
├── requirements.txt
├── start.sh         # One-command launcher
├── data/            # Runtime data — gitignored (db, thumbnails, overlays)
└── static/
    ├── index.html
    ├── style.css
    └── app.js
```

## Credits

This project is built on the work of the following HuggingFace authors:

- **[umm-maybe](https://huggingface.co/umm-maybe)** — [`umm-maybe/AI-image-detector`](https://huggingface.co/umm-maybe/AI-image-detector)
  ViT-based classifier trained to distinguish real vs. AI-generated images across DALL-E, Stable Diffusion, MidJourney, and more.

- **[Organika](https://huggingface.co/Organika)** — [`Organika/sdxl-detector`](https://huggingface.co/Organika/sdxl-detector)
  Fine-tuned detector specialized for SDXL and diffusion-model outputs.

## License

MIT
