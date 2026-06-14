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
    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=True)
