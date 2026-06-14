from fastapi import APIRouter, WebSocket, WebSocketDisconnect
import asyncio
from app.core.engine_state import EngineState
from app.services.ai_engine import AIEngineMock

router = APIRouter()
ai_engine = AIEngineMock()
state = EngineState()

@router.websocket("/ws/editor")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    try:
        while True:
            data = await websocket.receive_json()
            action = data.get("action")
            
            if action == "track_forward":
                # Giả lập tham số
                video_id = data.get("video_id", "test_video")
                total_frames = data.get("total_frames", 50)
                
                # Bắt đầu tracking
                state.start_tracking(video_id, total_frames)
                
                # Chạy propagation như một task chạy ngầm
                asyncio.create_task(ai_engine.run_propagation(websocket))
                
            elif action == "cancel_tracking":
                state.request_cancel()
                
            elif action == "click":
                # Xử lý click (Giả lập)
                print(f"User clicked at {data.get('coords')} on frame {data.get('frame_idx')}")
                await websocket.send_json({"status": "received", "echo": data})
                
    except WebSocketDisconnect:
        print("Client disconnected from Editor UI")
        state.request_cancel()
