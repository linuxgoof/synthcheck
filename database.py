import json
import os
import sqlite3
import datetime
from pathlib import Path

_here        = Path(__file__).parent
DATA_DIR     = Path(os.getenv("DATA_DIR", str(_here / "data")))
DB_PATH      = DATA_DIR / "synthcheck.db"
THUMBS_DIR   = DATA_DIR / "thumbnails"
OVERLAYS_DIR = DATA_DIR / "overlays"


def init_db():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    THUMBS_DIR.mkdir(exist_ok=True)
    OVERLAYS_DIR.mkdir(exist_ok=True)
    with _conn() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS analyses (
                file_hash      TEXT PRIMARY KEY,
                filename       TEXT NOT NULL,
                analyzed_at    TEXT NOT NULL,
                result_json    TEXT NOT NULL,
                thumbnail_path TEXT,
                overlay_path   TEXT
            )
        """)
        conn.commit()


def _conn() -> sqlite3.Connection:
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    return conn


def get_by_hash(file_hash: str) -> dict | None:
    with _conn() as conn:
        row = conn.execute(
            "SELECT * FROM analyses WHERE file_hash = ?", (file_hash,)
        ).fetchone()
    if row is None:
        return None
    result = json.loads(row["result_json"])
    result["cached"]        = True
    result["analyzed_at"]   = row["analyzed_at"]
    result["file_hash"]     = file_hash
    result["thumbnail_url"] = f"/api/thumbnail/{file_hash}" if row["thumbnail_path"] else None
    result["overlay_ready"] = bool(row["overlay_path"] and Path(row["overlay_path"]).exists())
    return result


def save_analysis(file_hash: str, filename: str, result: dict, thumbnail_path: str | None = None):
    now   = datetime.datetime.utcnow().isoformat()
    clean = {k: v for k, v in result.items()
             if k not in ("cached", "analyzed_at", "file_hash", "thumbnail_url", "overlay_ready")}
    with _conn() as conn:
        conn.execute(
            """INSERT OR REPLACE INTO analyses
               (file_hash, filename, analyzed_at, result_json, thumbnail_path)
               VALUES (?, ?, ?, ?, ?)""",
            (file_hash, filename, now, json.dumps(clean),
             str(thumbnail_path) if thumbnail_path else None),
        )
        conn.commit()


def save_overlay_path(file_hash: str, overlay_path: str):
    with _conn() as conn:
        conn.execute(
            "UPDATE analyses SET overlay_path = ? WHERE file_hash = ?",
            (str(overlay_path), file_hash),
        )
        conn.commit()


def get_overlay_path(file_hash: str) -> str | None:
    with _conn() as conn:
        row = conn.execute(
            "SELECT overlay_path FROM analyses WHERE file_hash = ?", (file_hash,)
        ).fetchone()
    if row and row["overlay_path"] and Path(row["overlay_path"]).exists():
        return row["overlay_path"]
    return None


def get_result(file_hash: str) -> dict | None:
    with _conn() as conn:
        row = conn.execute(
            "SELECT * FROM analyses WHERE file_hash = ?", (file_hash,)
        ).fetchone()
    if row is None:
        return None
    result = json.loads(row["result_json"])
    result["cached"]        = True
    result["analyzed_at"]   = row["analyzed_at"]
    result["file_hash"]     = file_hash
    result["thumbnail_url"] = f"/api/thumbnail/{file_hash}" if row["thumbnail_path"] else None
    result["overlay_ready"] = bool(row["overlay_path"] and Path(row["overlay_path"]).exists())
    return result


def get_library(limit: int = 100) -> list[dict]:
    with _conn() as conn:
        rows = conn.execute(
            """SELECT file_hash, filename, analyzed_at, result_json, thumbnail_path, overlay_path
               FROM analyses ORDER BY analyzed_at DESC LIMIT ?""",
            (limit,),
        ).fetchall()
    items = []
    for row in rows:
        r = json.loads(row["result_json"])
        items.append({
            "file_hash":       row["file_hash"],
            "filename":        row["filename"],
            "analyzed_at":     row["analyzed_at"],
            "is_ai":           r.get("is_ai"),
            "ai_probability":  r.get("ai_probability"),
            "verdict":         r.get("verdict"),
            "type":            r.get("type"),
            "duration_seconds": r.get("duration_seconds"),
            "thumbnail_url":   f"/api/thumbnail/{row['file_hash']}" if row["thumbnail_path"] else None,
            "overlay_ready":   bool(row["overlay_path"] and Path(row["overlay_path"]).exists()),
        })
    return items
