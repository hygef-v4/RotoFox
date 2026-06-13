from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

app = FastAPI(title="SmartMask Local API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # In production, restrict this to Tauri's local origin
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/")
def read_root():
    return {"status": "ok", "message": "SmartMask AI Engine is running."}

@app.websocket("/ws/editor")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    try:
        while True:
            data = await websocket.receive_json()
            # To-do: Handle incoming coordinates, trigger SAM 2 prediction
            await websocket.send_json({"status": "received", "data": data})
    except WebSocketDisconnect:
        print("Client disconnected from Editor UI")

if __name__ == "__main__":
    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=True)
