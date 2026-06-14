import os
import time
from fastapi import APIRouter, UploadFile, File
from fastapi.concurrency import run_in_threadpool
from app.services.video_processor import VideoProcessor
from app.services.cache_manager import CacheManager
from app.api.websockets import ai_engine

router = APIRouter()

@router.get("/")
def read_root():
    return {"status": "ok", "message": "SmartMask AI Engine is running."}

@router.post("/upload")
async def upload_video(file: UploadFile = File(...)):
    video_id = f"video_{int(time.time())}"
    video_dir = CacheManager.get_video_dir(video_id)
    video_path = video_dir / file.filename
    
    # Save the uploaded file
    with open(video_path, "wb") as f:
        content = await file.read()
        f.write(content)
        
    # Extract frames using OpenCV (runs in threadpool to avoid blocking event loop)
    try:
        frames_count = await run_in_threadpool(VideoProcessor.extract_frames, str(video_path), video_id)
        
        # Load the extracted video frames into AIEngine (runs in threadpool)
        # This will fail gracefully if SAM2 is not available
        try:
            await run_in_threadpool(ai_engine.load_video, video_id)
        except Exception as e:
            print(f"Warning: Could not load video into SAM 2: {e}")
            
        return {
            "status": "success", 
            "video_id": video_id, 
            "frames_count": frames_count,
            "message": "Video uploaded and frames extracted successfully."
        }
    except Exception as e:
        return {"status": "error", "message": str(e)}
