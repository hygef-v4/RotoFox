from fastapi import APIRouter, WebSocket, WebSocketDisconnect
import asyncio
from fastapi.concurrency import run_in_threadpool
from app.services.ai_engine import AIEngine
from app.services.cache_manager import CacheManager

router = APIRouter()
ai_engine = AIEngine()

@router.websocket("/ws/editor")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    print("WebSocket connection established with client")
    session_video_id = None   # per-connection state – prevents cross-connection contamination
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
                    session_video_id = video_id        # link this connection to the video
                    ai_engine.video_id = video_id
                    print(f"WebSocket session linked to video_id: {video_id}")
                    await websocket.send_json({"status": "video_loaded", "video_id": video_id})

            elif action == "track_forward":
                video_id = data.get("video_id")
                total_frames = data.get("total_frames", 50)
                start_frame = data.get("start_frame", None)
                
                # Use ai_engine's own state so propagation sees is_tracking=True
                ai_engine.state.start_tracking(video_id, total_frames)
                
                # Propagation is a long-running generator with awaits inside, so we don't run_in_threadpool it completely.
                # However, it contains its own asyncio.sleep to yield control.
                asyncio.create_task(ai_engine.run_propagation(websocket, start_frame))
                
            elif action == "cancel_tracking":
                ai_engine.state.request_cancel()
                
            elif action == "click":
                # Guard: ensure this connection is linked to a video before processing
                if not session_video_id:
                    print(f"Warning: click received but no video_id linked to this connection. Ignoring.")
                    await websocket.send_json({"status": "error", "message": "No video_id linked to this WebSocket connection. Send set_video_id first."})
                    continue

                points = data.get("points", [])
                labels = data.get("labels", [])
                box = data.get("box", None)
                frame_idx = data.get("frame_idx", 0)
                obj_id = data.get("obj_id", 1)
                
                try:
                    # Run PyTorch operation in threadpool so it doesn't block websocket pings
                    mask_b64 = await run_in_threadpool(
                        ai_engine.add_point_or_box,
                        frame_idx=frame_idx, 
                        obj_id=obj_id,
                        points=points,
                        labels=labels,
                        box=box, 
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

            elif action == "clear_clicks":
                try:
                    # BUG-01 FIX: was checking `frames_dir` which doesn't exist on AIEngine.
                    # Now checks inference_state directly.
                    if ai_engine.inference_state is not None and ai_engine.predictor is not None:
                        # Reset SAM 2 state to clear all points and memory
                        await run_in_threadpool(ai_engine.predictor.reset_state, ai_engine.inference_state)
                        
                        # Clear old masks from disk so UI doesn't load stale data when scrubbing
                        if ai_engine.video_id:
                            mask_dir = CacheManager.get_video_dir(ai_engine.video_id) / "masks"
                            if mask_dir.exists():
                                import shutil
                                shutil.rmtree(mask_dir)
                                mask_dir.mkdir(parents=True, exist_ok=True)
                            print(f"WebSocket: SAM2 state reset and masks cleared for video {ai_engine.video_id}.")
                            
                    # Always send an empty mask back so the frontend clears visually
                    await websocket.send_json({
                        "status": "mask_update",
                        "frame": data.get("frame_idx", 0),
                        "mask_base64": None
                    })
                except Exception as e:
                    print(f"Error clearing clicks: {e}")
                
            elif action == "remove_object":
                obj_id = data.get("obj_id", 1)
                frame_idx = data.get("frame_idx", 0)
                try:
                    b64_mask = await run_in_threadpool(ai_engine.remove_object, obj_id, frame_idx)
                    if b64_mask is not None:
                        await websocket.send_json({
                            "status": "mask_update",
                            "frame": frame_idx,
                            "mask_base64": b64_mask
                        })
                except Exception as e:
                    print(f"Error removing object: {e}")

            elif action == "export":
                # Data is now sent flat from frontend
                asyncio.create_task(ai_engine.run_export(websocket, data))

            elif action == "get_mask":
                frame_idx = data.get("frame_idx", 0)
                try:
                    import base64
                    
                    if not ai_engine.video_id:
                        await websocket.send_json({"status": "mask_update", "frame": frame_idx, "mask_base64": None})
                        continue

                    mask_dir = CacheManager.get_video_dir(ai_engine.video_id) / "masks"
                    mask_path = mask_dir / f"{frame_idx:05d}.png"
                    
                    if mask_path.exists():
                        # BUG-02 FIX: Read RGBA PNG as-is and re-encode to base64.
                        # Previous code converted to grayscale and lost multi-object color data.
                        def read_and_encode(path):
                            with open(path, "rb") as f:
                                return base64.b64encode(f.read()).decode("utf-8")

                        b64 = await run_in_threadpool(read_and_encode, str(mask_path))
                        await websocket.send_json({
                            "status": "mask_update",
                            "frame": frame_idx,
                            "mask_base64": b64
                        })
                    else:
                        await websocket.send_json({
                            "status": "mask_update",
                            "frame": frame_idx,
                            "mask_base64": None
                        })
                except Exception as e:
                    print(f"Error fetching mask: {e}")
                
    except WebSocketDisconnect:
        print("Client disconnected from Editor UI")
        ai_engine.state.request_cancel()

