import os
import time
from fastapi import APIRouter, UploadFile, File
from fastapi.concurrency import run_in_threadpool
from app.services.video_processor import VideoProcessor
from app.services.cache_manager import CacheManager
from app.services.model_manager import ModelManager
from app.api.websockets import ai_engine

router = APIRouter()


@router.get("/")
def read_root():
    return {"status": "ok", "message": "RotoFox AI Engine is running."}


@router.get("/api/setup-status")
def get_setup_status():
    """Check whether required models are downloaded for the First-Run Wizard."""
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
async def upload_video(file: UploadFile = File(...)):
    video_id = f"video_{int(time.time())}"

    # ISSUE-09 FIX: Clear all previous cache before creating a new session.
    # Without this, each upload creates a new timestamped folder that never gets deleted.
    await run_in_threadpool(CacheManager.clear_all_cache)

    video_dir = CacheManager.get_video_dir(video_id)
    video_path = video_dir / file.filename

    # Save the uploaded file
    with open(video_path, "wb") as f:
        content = await file.read()
        f.write(content)

    # Extract frames using OpenCV (runs in threadpool to avoid blocking event loop)
    try:
        frames_count, source_fps = await run_in_threadpool(VideoProcessor.extract_frames, str(video_path), video_id)

        # Load the extracted video frames into AIEngine (runs in threadpool)
        # This will fail gracefully if SAM2 is not available
        try:
            await run_in_threadpool(ai_engine.load_video, video_id, source_fps)
        except Exception as e:
            print(f"Warning: Could not load video into SAM 2: {e}")

        return {
            "status": "success",
            "video_id": video_id,
            "frames_count": frames_count,
            "fps": source_fps,
            "message": "Video uploaded and frames extracted successfully."
        }
    except Exception as e:
        return {"status": "error", "message": str(e)}
