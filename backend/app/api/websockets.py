from fastapi import APIRouter, WebSocket, WebSocketDisconnect
import asyncio
import os
from fastapi.concurrency import run_in_threadpool
from app.services.ai_engine import AIEngine
from app.services.cache_manager import CacheManager
from app.services.model_manager import ModelManager

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
                if video_id:
                    session_video_id = video_id        # link this connection to the video
                    
                    # If inference_state is None, or it's for a different video, load/initialize it!
                    if ai_engine.inference_state is None or ai_engine.video_id != video_id:
                        if ai_engine.predictor is not None:
                            try:
                                print(f"WebSocket: Initializing video state for {video_id} in threadpool...")
                                await run_in_threadpool(ai_engine.load_video, video_id)
                            except Exception as e:
                                print(f"Error loading video state: {e}")
                                await websocket.send_json({"status": "error", "message": f"Failed to initialize video state: {str(e)}"})
                        else:
                            print("WebSocket: SAM2 predictor is not loaded yet. Skipping load_video until model is loaded.")
                    
                    ai_engine.video_id = video_id
                    print(f"WebSocket session linked to video_id: {video_id}")
                    await websocket.send_json({"status": "video_loaded", "video_id": video_id})

            elif action == "get_system_info":
                try:
                    info = ModelManager.get_system_info()
                    info["active_model"] = ai_engine.active_model_id
                    await websocket.send_json({
                        "status": "system_info",
                        "system_info": info
                    })
                except Exception as e:
                    await websocket.send_json({"status": "error", "message": f"Failed to get system info: {str(e)}"})

            elif action == "download_model":
                model_id = data.get("model_id")
                try:
                    async def report_progress(percent):
                        await websocket.send_json({
                            "status": "download_progress",
                            "model_id": model_id,
                            "progress": percent
                        })
                    
                    async def do_download():
                        try:
                            await ModelManager.download_model_async(model_id, report_progress)
                            await websocket.send_json({
                                "status": "download_completed",
                                "model_id": model_id
                            })
                        except Exception as e:
                            import traceback
                            traceback.print_exc()
                            await websocket.send_json({
                                "status": "download_error",
                                "model_id": model_id,
                                "message": str(e)
                            })
                    
                    asyncio.create_task(do_download())
                except Exception as e:
                    await websocket.send_json({
                        "status": "download_error",
                        "model_id": model_id,
                        "message": str(e)
                    })

            elif action == "load_model":
                model_id = data.get("model_id")
                try:
                    await run_in_threadpool(ai_engine.load_model, model_id)
                    # If a video was already selected/set, initialize its state now that the model is loaded!
                    if ai_engine.video_id:
                        try:
                            print(f"WebSocket: Auto-initializing video state for {ai_engine.video_id} after loading model...")
                            await run_in_threadpool(ai_engine.load_video, ai_engine.video_id)
                        except Exception as ve:
                            print(f"Warning: Failed to auto-initialize video state after loading model: {ve}")
                    await websocket.send_json({
                        "status": "model_loaded",
                        "model_id": model_id
                    })
                except Exception as e:
                    import traceback
                    traceback.print_exc()
                    await websocket.send_json({"status": "error", "message": f"Failed to load model: {str(e)}"})

            elif action == "set_checkpoints_dir":
                checkpoints_dir = data.get("checkpoints_dir", "")
                try:
                    ModelManager.save_config(checkpoints_dir)
                    # Recheck available checkpoints in the new directory and load the best one if possible
                    ai_engine._init_model()
                    
                    info = ModelManager.get_system_info()
                    info["active_model"] = ai_engine.active_model_id
                    await websocket.send_json({
                        "status": "system_info",
                        "system_info": info
                    })
                except Exception as e:
                    print(f"Error setting checkpoints directory: {e}")
                    await websocket.send_json({"status": "error", "message": f"Failed to update model folder: {str(e)}"})
            elif action == "open_directory":
                directory = data.get("directory", "")
                if not directory:
                    directory = str(ModelManager.get_checkpoints_dir().resolve())
                
                def open_folder(path):
                    import platform
                    import subprocess
                    try:
                        if platform.system() == "Windows":
                            os.startfile(path)
                        elif platform.system() == "Darwin":
                            subprocess.run(["open", path])
                        else:
                            subprocess.run(["xdg-open", path])
                    except Exception as e:
                        print(f"Failed to open directory {path}: {e}")
                        
                asyncio.create_task(run_in_threadpool(open_folder, directory))



            elif action == "track_forward":
                video_id = data.get("video_id")
                total_frames = data.get("total_frames", 50)
                start_frame = data.get("start_frame", None)
                print(f"[track_forward] start_frame={start_frame}, "
                      f"interaction_frames={sorted(ai_engine.interaction_frames)}")
                
                # Always respect the frontend's start_frame.
                # SAM2 retains its memory bank from previous propagation runs, so:
                #   - Forward track: propagate_in_video(start_frame_idx=200) works because
                #     SAM2 already has memory for frames 0-199.
                #   - Correction: user changes annotation at frame 50, clicks Track from 50.
                #     propagate_in_video(start_frame_idx=50) re-predicts 50+ using
                #     memory[0-49] + updated annotation[50] — correct result, no restart needed.
                
                # Use ai_engine's own state so propagation sees is_tracking=True
                ai_engine.state.start_tracking(video_id, total_frames)
                
                # Propagation is a long-running generator with awaits inside.
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
                        
                        # Also clear interaction history so correction logic starts fresh
                        ai_engine.interaction_frames.clear()
                        
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

