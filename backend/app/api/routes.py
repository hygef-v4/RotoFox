from fastapi import APIRouter

router = APIRouter()

@router.get("/")
def read_root():
    return {"status": "ok", "message": "SmartMask AI Engine is running."}

@router.post("/upload")
def upload_video():
    # To-do: Handle video upload and extract frames
    return {"status": "success", "message": "Video uploaded successfully."}
