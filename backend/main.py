from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

from app.api import routes, websockets

app = FastAPI(title="SmartMask Local API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # In production, restrict this to Tauri's local origin
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(routes.router)
app.include_router(websockets.router)

if __name__ == "__main__":
    import sys
    is_frozen = getattr(sys, 'frozen', False)
    uvicorn.run(
        "main:app", 
        host="127.0.0.1", 
        port=8000, 
        reload=not is_frozen,
        reload_excludes=["cache_workspace/*", "**/cache_workspace/**"] if not is_frozen else None,
        ws_ping_interval=30,
        ws_ping_timeout=300
    )
