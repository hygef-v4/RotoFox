"""WebSocket communication for RotoFox.

This module handles real-time bidirectional communication between the React frontend
and the Python backend, processing click events, starting propagation tracking,
and streaming export logs.
"""

import asyncio
import os
import shutil
import base64
import platform
import subprocess
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from fastapi.concurrency import run_in_threadpool
from app.services.ai_engine import AIEngine
from app.services.cache_manager import CacheManager
from app.services.model_manager import ModelManager

router = APIRouter()
ai_engine = AIEngine()


@router.websocket("/ws/editor")
async def websocket_endpoint(websocket: WebSocket) -> None:
    """Accept and handle incoming WebSocket connections from the editor UI.

    Args:
        websocket (WebSocket): The active WebSocket connection.
    """
    await websocket.accept()
    print("WebSocket connection established with client")
    session_video_id = None  # Per-connection session tracking to avoid contamination

    try:
        while True:
            data = await websocket.receive_json()
            action = data.get("action")
            print(f"WebSocket action received: {action}")

            if action == "set_video_id":
                video_id = data.get("video_id")
                if video_id:
                    session_video_id = video_id

                    # Initialize video state if no state is loaded or video changed
                    if ai_engine.inference_state is None or ai_engine.video_id != video_id:
                        if ai_engine.predictor is not None:
                            try:
                                print(f"WebSocket: Initializing video state for {video_id} in threadpool...")
                                await run_in_threadpool(ai_engine.load_video, video_id)
                            except Exception as e:
                                print(f"Error loading video state: {e}")
                                await websocket.send_json({
                                    "status": "error",
                                    "message": f"Failed to initialize video state: {str(e)}"
                                })
                        else:
                            print("WebSocket: SAM2 predictor is not loaded yet. Skipping load_video.")

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
                    async def report_progress(percent: int) -> None:
                        await websocket.send_json({
                            "status": "download_progress",
                            "model_id": model_id,
                            "progress": percent
                        })

                    async def do_download() -> None:
                        try:
                            await ModelManager.download_model_async(model_id, report_progress)
                            await websocket.send_json({
                                "status": "download_completed",
                                "model_id": model_id
                            })
                        except Exception as de:
                            import traceback
                            traceback.print_exc()
                            await websocket.send_json({
                                "status": "download_error",
                                "model_id": model_id,
                                "message": str(de)
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
                    # Automatically initialize video state if a video ID is already selected
                    if ai_engine.video_id:
                        try:
                            print(f"WebSocket: Auto-initializing video state for {ai_engine.video_id}...")
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
                    # Refresh the active model using checkpoints in the new directory
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

                def open_folder(path: str) -> None:
                    try:
                        if platform.system() == "Windows":
                            os.startfile(path)
                        elif platform.system() == "Darwin":
                            subprocess.run(["open", path])
                        else:
                            subprocess.run(["xdg-open", path])
                    except Exception as oe:
                        print(f"Failed to open directory {path}: {oe}")

                asyncio.create_task(run_in_threadpool(open_folder, directory))

            elif action == "track_forward":
                video_id = data.get("video_id")
                total_frames = data.get("total_frames", 50)
                start_frame = data.get("start_frame", None)
                print(f"[track_forward] start_frame={start_frame}, "
                      f"interaction_frames={sorted(ai_engine.interaction_frames)}")

                ai_engine.state.start_tracking(video_id, total_frames)
                # Run propagation asynchronously in background
                asyncio.create_task(ai_engine.run_propagation(websocket, start_frame))

            elif action == "cancel_tracking":
                ai_engine.state.request_cancel()

            elif action == "click":
                # Ensure the connection session is active and linked to a video ID
                if not session_video_id:
                    print("Warning: click received but no video_id linked to this connection. Ignoring.")
                    await websocket.send_json({
                        "status": "error",
                        "message": "No video_id linked to this WebSocket connection. Send set_video_id first."
                    })
                    continue

                points = data.get("points", [])
                labels = data.get("labels", [])
                box = data.get("box", None)
                frame_idx = data.get("frame_idx", 0)
                obj_id = data.get("obj_id", 1)

                try:
                    # Run PyTorch operation in threadpool to prevent blocking the event loop
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
                    if ai_engine.inference_state is not None and ai_engine.predictor is not None:
                        # Clear points and memory in the active SAM 2 state
                        await run_in_threadpool(ai_engine.predictor.reset_state, ai_engine.inference_state)

                        # Delete stale masks from disk to prevent UI reload issues
                        if ai_engine.video_id:
                            mask_dir = CacheManager.get_video_dir(ai_engine.video_id) / "masks"
                            if mask_dir.exists():
                                shutil.rmtree(mask_dir)
                                mask_dir.mkdir(parents=True, exist_ok=True)
                            print(f"WebSocket: SAM2 state reset and masks cleared for {ai_engine.video_id}.")

                        ai_engine.interaction_frames.clear()

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
                # Start export process in background task
                asyncio.create_task(ai_engine.run_export(websocket, data))

            elif action == "get_mask":
                frame_idx = data.get("frame_idx", 0)
                try:
                    if not ai_engine.video_id:
                        await websocket.send_json({"status": "mask_update", "frame": frame_idx, "mask_base64": None})
                        continue

                    mask_dir = CacheManager.get_video_dir(ai_engine.video_id) / "masks"
                    mask_path = mask_dir / f"{frame_idx:05d}.png"

                    if mask_path.exists():
                        # Read RGBA PNG as-is and encode to base64
                        def read_and_encode(path: str) -> str:
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


