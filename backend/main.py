"""RotoFox API Server Entry Point.

This module initializes the FastAPI application, registers global middlewares (CORS),
includes API and WebSocket routers, and starts the Uvicorn ASGI server.
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

from app.api import routes, websockets

# Initialize FastAPI application
app = FastAPI(title="RotoFox API")

# Configure Cross-Origin Resource Sharing (CORS) middleware
# In production, restrict this to Tauri's local origin (e.g., tauri://localhost)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Register routers
app.include_router(routes.router)
app.include_router(websockets.router)

if __name__ == "__main__":
    import sys
    
    # Check if the application is running as a packaged PyInstaller executable
    is_frozen = getattr(sys, 'frozen', False)
    
    # Bypass string import in packaged executable to avoid import errors
    app_target = app if is_frozen else "main:app"
    
    # Start the Uvicorn ASGI server
    uvicorn.run(
        app_target, 
        host="127.0.0.1", 
        port=8000, 
        reload=not is_frozen,
        # Exclude temporary cache directory from reload trigger to prevent infinite loops
        reload_excludes=["cache_workspace/*", "**/cache_workspace/**"] if not is_frozen else None,
        ws_ping_interval=30,
        ws_ping_timeout=300
    )

