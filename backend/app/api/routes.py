"""HTTP REST routes for RotoFox.

Covers the health check, the first-run setup status used by the wizard, and
video upload with frame extraction.
"""

from __future__ import annotations

import asyncio
import logging
import shutil
import time
from typing import Any

from fastapi import APIRouter, File, HTTPException, Request, UploadFile
from fastapi.concurrency import run_in_threadpool

from app.api.connection import manager
from app.core.paths import safe_suffix
from app.core.security import get_session_token, verify_token
from app.services.cache_manager import CacheManager
from app.services.model_manager import TRACKING_MODEL_IDS, ModelManager
from app.services.video_processor import VideoProcessor

logger = logging.getLogger(__name__)
router = APIRouter()

ALLOWED_VIDEO_SUFFIXES = frozenset({".mp4", ".mov", ".webm", ".ogv", ".ogg", ".avi", ".mkv", ".m4v"})

# Refuse absurdly large uploads rather than filling the user's disk.
MAX_UPLOAD_BYTES = 16 * 1024 * 1024 * 1024  # 16 GB

UPLOAD_CHUNK = 4 * 1024 * 1024  # 4 MB


def _require_token(request: Request) -> None:
    """Reject requests that do not carry the session token.

    The token is supplied as ``X-RotoFox-Token`` or ``?token=``. Without it any
    web page the user has open could POST to this local server.
    """
    if get_session_token() is None:
        return
    supplied = request.headers.get("x-rotofox-token") or request.query_params.get("token")
    if not verify_token(supplied):
        raise HTTPException(status_code=401, detail="Invalid or missing session token.")


@router.get("/")
def read_root() -> dict[str, str]:
    """Health check used by the frontend to detect a live backend."""
    return {"status": "ok", "message": "RotoFox AI Engine is running."}


@router.get("/api/setup-status")
def get_setup_status() -> dict[str, Any]:
    """Report what the first-run wizard still needs to install.

    A SAM 2 tracking model is **required** — without one every canvas click
    raises and the application does nothing. MatAnyone 2 is **optional**: when
    it is absent the exporter falls back to raw SAM 2 masks.

    The original implementation had these the wrong way round. It blocked the
    wizard until MatAnyone finished downloading while offering a "Skip for now"
    button for SAM, so a user on a slow connection could skip the one model that
    the app cannot run without.
    """
    info = ModelManager.get_system_info()
    sam_ready = any(ModelManager.is_downloaded(mid) for mid in TRACKING_MODEL_IDS)
    matanyone_ready = ModelManager.is_downloaded("matanyone")

    return {
        "needs_setup": not sam_ready,
        "sam_ready": sam_ready,
        "sam_required": True,
        "matanyone_ready": matanyone_ready,
        "matanyone_required": False,
        "recommended_sam": info["recommended_model"],
        "gpu_name": info["gpu_name"],
        "total_vram_gb": info["total_vram_gb"],
        "gpu_available": info["gpu_available"],
        "system_ram_gb": info["system_ram_gb"],
        "checkpoints_dir": info["checkpoints_dir"],
        "models": info["models"],
    }


@router.post("/upload")
async def upload_video(request: Request, file: UploadFile = File(...)) -> dict[str, Any]:
    """Store an uploaded video and extract its frames into the session cache.

    Args:
        request: Incoming request, checked for the session token.
        file: Uploaded video.

    Returns:
        Session metadata, or an error description.
    """
    _require_token(request)

    from app.api.websockets import ai_engine

    if ai_engine.state.is_busy:
        raise HTTPException(
            status_code=409,
            detail="A tracking or export job is still running. Stop it before importing a new video.",
        )

    video_id = f"video_{int(time.time())}"
    video_dir = CacheManager.get_video_dir(video_id)

    # The client-supplied filename is never used to build a path. Only a
    # whitelisted extension is taken from it, so "../../evil.bat" cannot
    # escape the cache directory.
    suffix = safe_suffix(file.filename or "", ALLOWED_VIDEO_SUFFIXES)
    video_path = video_dir / f"source{suffix}"

    # Stream to disk. Reading the whole upload into memory first meant a 5 GB
    # clip needed 5 GB of RAM on a machine already hosting PyTorch.
    written = 0
    try:
        with open(video_path, "wb") as handle:
            while True:
                chunk = await file.read(UPLOAD_CHUNK)
                if not chunk:
                    break
                written += len(chunk)
                if written > MAX_UPLOAD_BYTES:
                    raise HTTPException(status_code=413, detail="This video exceeds the 16 GB limit.")
                await run_in_threadpool(handle.write, chunk)
    except HTTPException:
        shutil.rmtree(video_dir, ignore_errors=True)
        raise
    except OSError as exc:
        shutil.rmtree(video_dir, ignore_errors=True)
        logger.exception("Could not save the upload: %s", exc)
        return {"status": "error", "message": f"Could not save the uploaded file: {exc}"}
    finally:
        await file.close()

    logger.info("Stored upload %s (%.1f MB)", video_path.name, written / 1024 ** 2)

    loop = asyncio.get_running_loop()

    def on_progress(done: int, total: int) -> None:
        """Forward real extraction progress from the worker thread."""
        asyncio.run_coroutine_threadsafe(
            manager.send({
                "status": "extract_progress",
                "video_id": video_id,
                "current": done,
                "total": total,
                "progress": int(done / max(total, 1) * 100),
            }),
            loop,
        )

    try:
        frames_count, effective_fps = await run_in_threadpool(
            VideoProcessor.extract_frames, str(video_path), video_id, 30, on_progress
        )
    except RuntimeError as exc:
        shutil.rmtree(video_dir, ignore_errors=True)
        logger.error("Frame extraction failed: %s", exc)
        return {"status": "error", "message": str(exc)}

    # Keep a few previous sessions instead of wiping every one on each import,
    # so reopening an earlier clip still finds its masks.
    await run_in_threadpool(CacheManager.prune_sessions, 3, video_id)

    warning = None
    try:
        await run_in_threadpool(ai_engine.load_video, video_id, effective_fps)
    except RuntimeError as exc:
        warning = str(exc)
        logger.warning("Video stored but SAM 2 could not initialise: %s", exc)

    return {
        "status": "success",
        "video_id": video_id,
        "frames_count": frames_count,
        "fps": effective_fps,
        "width": ai_engine.video_width,
        "height": ai_engine.video_height,
        "warning": warning,
        "message": "Video uploaded and frames extracted successfully.",
    }
