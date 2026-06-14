from fastapi import APIRouter, WebSocket, WebSocketDisconnect
import asyncio
from app.core.engine_state import EngineState
from app.services.ai_engine import AIEngine

router = APIRouter()
ai_engine = AIEngine()
state = EngineState()

@router.websocket("/ws/editor")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    try:
        while True:
            data = await websocket.receive_json()
            action = data.get("action")
            
            if action == "set_video_id":
                ai_engine.video_id = data.get("video_id")
                print(f"WebSocket session linked to video_id: {ai_engine.video_id}")

            elif action == "track_forward":
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
                coords = data.get("coords")
                mode = data.get("type", "add")
                frame_idx = data.get("frame_idx", 0)
                
                # Assume standard 1280x720 internal representation, or pass from frontend.
                # Currently frontend sends normalized [0..1] coords, we will use 1280x720.
                try:
                    mask_b64 = ai_engine.add_point_or_box(
                        frame_idx=frame_idx, 
                        coords=coords, 
                        mode=mode, 
                        width=1280, 
                        height=720
                    )
                    await websocket.send_json({
                        "status": "received", 
                        "echo": data,
                        "mask_base64": mask_b64
                    })
                except Exception as e:
                    print(f"Error handling click: {e}")
                    await websocket.send_json({"status": "error", "message": str(e)})
                
            elif action == "export":
                settings = data.get("settings", {})
                asyncio.create_task(ai_engine.run_export(websocket, settings))
                
    except WebSocketDisconnect:
        print("Client disconnected from Editor UI")
        state.request_cancel()
