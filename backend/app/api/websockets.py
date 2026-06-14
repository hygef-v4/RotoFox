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
                    if hasattr(ai_engine, "inference_state") and getattr(ai_engine, "frames_dir", None):
                        # Reset SAM 2 state to clear all points (prevents CUDA OOM)
                        ai_engine.predictor.reset_state(ai_engine.inference_state)
                        
                        # Clear old masks from disk so UI doesn't load stale data when scrubbing
                        mask_dir = CacheManager.get_video_dir(ai_engine.video_id) / "masks"
                        if mask_dir.exists():
                            import shutil
                            shutil.rmtree(mask_dir)
                            mask_dir.mkdir(parents=True, exist_ok=True)
                            
                        # We also send an empty mask back so the frontend clears visually if it didn't already
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
                    from app.services.cache_manager import CacheManager
                    import cv2
                    import numpy as np
                    from PIL import Image
                    import io
                    import base64
                    
                    mask_dir = CacheManager.get_video_dir(ai_engine.video_id) / "masks"
                    mask_path = mask_dir / f"{frame_idx:05d}.png"
                    
                    if mask_path.exists():
                        # Read the grayscale mask from disk
                        m = await run_in_threadpool(cv2.imread, str(mask_path), cv2.IMREAD_GRAYSCALE)
                        if m is not None:
                            # Convert to transparent white mask exactly like _mask_to_base64 does
                            rgba = np.zeros((m.shape[0], m.shape[1], 4), dtype=np.uint8)
                            rgba[m > 127, :] = [255, 255, 255, 255]
                            img = Image.fromarray(rgba, 'RGBA')
                            buf = io.BytesIO()
                            img.save(buf, format='PNG')
                            b64 = base64.b64encode(buf.getvalue()).decode("utf-8")
                            
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

