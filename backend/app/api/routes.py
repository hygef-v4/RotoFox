"""HTTP REST Routes for RotoFox.

This module defines standard HTTP endpoints for application setup state
and video file uploading/frame extraction.
"""

import time
from typing import Dict, Any
from fastapi import APIRouter, UploadFile, File
from fastapi.concurrency import run_in_threadpool
from app.services.video_processor import VideoProcessor
from app.services.cache_manager import CacheManager
from app.services.model_manager import ModelManager
from app.api.websockets import ai_engine

router = APIRouter()


@router.get("/")
def read_root() -> Dict[str, str]:
    """Health check endpoint to verify backend status.

    Returns:
        dict: Status OK message.
    """
    return {"status": "ok", "message": "RotoFox AI Engine is running."}


@router.get("/api/setup-status")
def get_setup_status() -> Dict[str, Any]:
    """Retrieve setup progress and hardware capabilities for the First-Run Wizard.

    Returns:
        dict: Setup readiness indicators and profiled hardware properties.
    """
    info = ModelManager.get_system_info()
    matanyone_model = next((m for m in info["models"] if m["id"] == "matanyone"), None)
    sam_models = [m for m in info["models"] if m["id"] != "matanyone"]

    matanyone_ready = matanyone_model is not None and matanyone_model["downloaded"]
    sam_ready = any(m["downloaded"] for m in sam_models)

    return {
        "needs_setup": not matanyone_ready or not sam_ready,
        "matanyone_ready": matanyone_ready,
        "sam_ready": sam_ready,
        "recommended_sam": info["recommended_model"],
        "gpu_name": info["gpu_name"],
        "total_vram_gb": info["total_vram_gb"],
        "gpu_available": info["gpu_available"],
        "models": info["models"],
    }


@router.post("/upload")
async def upload_video(file: UploadFile = File(...)) -> Dict[str, Any]:
    """Upload a video file, clear previous session cache, and extract frames.

    Args:
        file (UploadFile): The uploaded raw video file.

    Returns:
        dict: Success details including video metadata or error message.
    """
    video_id = f"video_{int(time.time())}"

    # Clear all previous session caches to free disk space
    await run_in_threadpool(CacheManager.clear_all_cache)

    video_dir = CacheManager.get_video_dir(video_id)
    video_path = video_dir / file.filename

    # Save the uploaded file payload to local cache
    with open(video_path, "wb") as f:
        content = await file.read()
        f.write(content)

    # Extract frames using OpenCV on a threadpool to prevent blocking the event loop
    try:
        frames_count, effective_fps = await run_in_threadpool(
            VideoProcessor.extract_frames, str(video_path), video_id, 30
        )

        # Pre-initialize video frame features in SAM 2 video predictor
        try:
            await run_in_threadpool(ai_engine.load_video, video_id, effective_fps)
        except Exception as e:
            print(f"Warning: Could not load video into SAM 2: {e}")

        return {
            "status": "success",
            "video_id": video_id,
            "frames_count": frames_count,
            "fps": effective_fps,
            "message": "Video uploaded and frames extracted successfully."
        }
    except Exception as e:
        return {"status": "error", "message": str(e)}

