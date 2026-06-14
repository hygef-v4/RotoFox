from fastapi import APIRouter, WebSocket, WebSocketDisconnect
import asyncio
from fastapi.concurrency import run_in_threadpool
from app.services.ai_engine import AIEngine

router = APIRouter()
ai_engine = AIEngine()

@router.websocket("/ws/editor")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    print("WebSocket connection established with client")
    try:
        while True:
            data = await websocket.receive_json()
            action = data.get("action")
            print(f"WebSocket action received: {action}")
            
            if action == "set_video_id":
                video_id = data.get("video_id")
                # Removed redundant load_video call because it's already done in the POST endpoint
                # and calling it here blocks the websocket/event loop again causing infinite reconnect loops.
                if video_id:
                    ai_engine.video_id = video_id
                    print(f"WebSocket session linked to video_id: {video_id}")
                    await websocket.send_json({"status": "video_loaded", "video_id": video_id})

            elif action == "track_forward":
                video_id = data.get("video_id", ai_engine.video_id or "unknown")
                total_frames = data.get("total_frames", 50)
                
                # Use ai_engine's own state so propagation sees is_tracking=True
                ai_engine.state.start_tracking(video_id, total_frames)
                
                # Propagation is a long-running generator with awaits inside, so we don't run_in_threadpool it completely.
                # However, it contains its own asyncio.sleep to yield control.
                asyncio.create_task(ai_engine.run_propagation(websocket))
                
            elif action == "cancel_tracking":
                ai_engine.state.request_cancel()
                
            elif action == "click":
                coords = data.get("coords")
                mode = data.get("type", "add")
                frame_idx = data.get("frame_idx", 0)
                
                try:
                    # Run PyTorch operation in threadpool so it doesn't block websocket pings
                    mask_b64 = await run_in_threadpool(
                        ai_engine.add_point_or_box,
                        frame_idx=frame_idx, 
                        coords=coords, 
                        mode=mode, 
                        width=ai_engine.video_width, 
                        height=ai_engine.video_height
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
        ai_engine.state.request_cancel()

