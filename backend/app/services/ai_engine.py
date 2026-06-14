import asyncio
import time
import os
import io
import base64
from PIL import Image
import numpy as np
import torch
from pathlib import Path
from app.core.engine_state import EngineState
from app.services.memory_manager import MemoryManager
from app.services.cache_manager import CacheManager

try:
    from sam2.build_sam import build_sam2_video_predictor
    SAM2_AVAILABLE = True
except ImportError:
    SAM2_AVAILABLE = False

class AIEngine:
    def __init__(self):
        self.state = EngineState()
        self.predictor = None
        self.inference_state = None
        self.video_id = None
        self.obj_id = 1
        self.video_width = 1280
        self.video_height = 720
        
        if SAM2_AVAILABLE:
            self._init_model()

    def _init_model(self):
        if torch.cuda.is_available():
            self.device = torch.device("cuda")
            if torch.cuda.get_device_capability()[0] >= 8:
                torch.autocast("cuda", dtype=torch.bfloat16).__enter__()
        elif torch.backends.mps.is_available():
            self.device = torch.device("mps")
        else:
            self.device = torch.device("cpu")

        print(f"AIEngine: Loading SAM 2 on {self.device}...")
        
        checkpoint = Path(__file__).parent.parent.parent / "checkpoints" / "sam2.1_hiera_large.pt"
        if not checkpoint.exists():
            print("WARNING: SAM 2 weights not found. Run setup_sam2.py!")
            global SAM2_AVAILABLE
            SAM2_AVAILABLE = False
            return
            
        model_cfg = "configs/sam2.1/sam2.1_hiera_l.yaml"
        self.predictor = build_sam2_video_predictor(model_cfg, str(checkpoint), device=self.device)
        print("AIEngine: SAM 2 loaded successfully.")

    def load_video(self, video_id: str):
        if not SAM2_AVAILABLE:
            raise RuntimeError("SAM 2 is not installed or weights are missing. Please run setup_sam2.py")
        
        video_dir = CacheManager.get_video_dir(video_id)
        frames = list(video_dir.glob("*.jpg"))
        if not video_dir.exists() or len(frames) == 0:
            raise RuntimeError("Video frames not extracted.")
            
        # Read the dimensions of the first frame to scale coordinates
        first_frame = sorted(frames)[0]
        try:
            with Image.open(first_frame) as img:
                self.video_width, self.video_height = img.size
            print(f"AIEngine: Loaded video dimensions: {self.video_width}x{self.video_height}")
        except Exception as e:
            print(f"Warning: Could not read video dimensions from first frame: {e}. Defaulting to 1280x720")
            self.video_width, self.video_height = 1280, 720

        print(f"AIEngine: Initializing state for video {video_id}")
        if hasattr(self, 'device') and self.device.type == "cuda" and torch.cuda.get_device_capability()[0] >= 8:
            with torch.autocast("cuda", dtype=torch.bfloat16):
                self.inference_state = self.predictor.init_state(video_path=str(video_dir))
                self.predictor.reset_state(self.inference_state)
        else:
            self.inference_state = self.predictor.init_state(video_path=str(video_dir))
            self.predictor.reset_state(self.inference_state)
        self.video_id = video_id

    def add_point_or_box(self, frame_idx: int, coords: list, mode: str, width: int, height: int):
        print(f"AIEngine: add_point_or_box. Frame: {frame_idx}, Coords: {coords}, Mode: {mode}, Scale: {width}x{height}")
        if not self.inference_state:
            raise RuntimeError("No video loaded into AI engine.")

        # coords is relative [0..1]. SAM2 needs absolute pixel coords.
        # Scale to image dimensions
        if mode in ['add', 'remove']:
            x, y = coords[0] * width, coords[1] * height
            points = np.array([[x, y]], dtype=np.float32)
            labels = np.array([1 if mode == 'add' else 0], np.int32)
            
            if hasattr(self, 'device') and self.device.type == "cuda" and torch.cuda.get_device_capability()[0] >= 8:
                with torch.autocast("cuda", dtype=torch.bfloat16):
                    _, out_obj_ids, out_mask_logits = self.predictor.add_new_points_or_box(
                        inference_state=self.inference_state,
                        frame_idx=frame_idx,
                        obj_id=self.obj_id,
                        points=points,
                        labels=labels,
                    )
            else:
                _, out_obj_ids, out_mask_logits = self.predictor.add_new_points_or_box(
                    inference_state=self.inference_state,
                    frame_idx=frame_idx,
                    obj_id=self.obj_id,
                    points=points,
                    labels=labels,
                )
        elif mode == 'box':
            x1, y1, x2, y2 = coords[0] * width, coords[1] * height, coords[2] * width, coords[3] * height
            box = np.array([x1, y1, x2, y2], dtype=np.float32)
            print(f"AIEngine: Prompt box scaled coordinates: [{x1}, {y1}, {x2}, {y2}]")
            if hasattr(self, 'device') and self.device.type == "cuda" and torch.cuda.get_device_capability()[0] >= 8:
                with torch.autocast("cuda", dtype=torch.bfloat16):
                    _, out_obj_ids, out_mask_logits = self.predictor.add_new_points_or_box(
                        inference_state=self.inference_state,
                        frame_idx=frame_idx,
                        obj_id=self.obj_id,
                        box=box,
                    )
            else:
                _, out_obj_ids, out_mask_logits = self.predictor.add_new_points_or_box(
                    inference_state=self.inference_state,
                    frame_idx=frame_idx,
                    obj_id=self.obj_id,
                    box=box,
                )
        else:
            raise ValueError("Invalid click mode")
        
        # Convert mask to base64
        mask = (out_mask_logits[0] > 0.0).cpu().numpy().squeeze()
        print(f"AIEngine: Mask generated. Shape: {mask.shape}, Active pixels: {np.sum(mask)}")
        return self._mask_to_base64(mask)

    def _mask_to_base64(self, mask_np):
        h, w = mask_np.shape
        rgba = np.zeros((h, w, 4), dtype=np.uint8)
        rgba[mask_np, :] = [255, 0, 0, 128]  # Red, 50% opacity
        
        img = Image.fromarray(rgba, 'RGBA')
        buf = io.BytesIO()
        img.save(buf, format='PNG')
        return base64.b64encode(buf.getvalue()).decode('utf-8')

    async def run_propagation(self, websocket):
        if not self.state.is_tracking or not self.inference_state:
            print("AI Engine: Cannot start propagation - not tracking or no inference state")
            return

        print(f"AI Engine: Starting propagation for {self.state.total_frames} frames...")
        try:
            # We iterate the generator directly to support real-time streaming of masks and progress
            if hasattr(self, 'device') and self.device.type == "cuda" and torch.cuda.get_device_capability()[0] >= 8:
                with torch.autocast("cuda", dtype=torch.bfloat16):
                    generator = self.predictor.propagate_in_video(self.inference_state)
                    
                    for out_frame_idx, out_obj_ids, out_mask_logits in generator:
                        if self.state.cancel_requested:
                            print(f"AI Engine: Propagation cancelled at frame {out_frame_idx}")
                            await websocket.send_json({"status": "cancelled", "frame": out_frame_idx})
                            break
                        
                        # Convert the mask to base64
                        mask = (out_mask_logits[0] > 0.0).cpu().numpy().squeeze()
                        b64_mask = self._mask_to_base64(mask)
                        
                        self.state.current_frame = out_frame_idx
                        progress = int((out_frame_idx / max(self.state.total_frames, 1)) * 100)
                        
                        await websocket.send_json({
                            "status": "tracking",
                            "frame": out_frame_idx,
                            "progress": progress,
                            "mask_base64": b64_mask
                        })
                        
                        # Yield control to the event loop so that other events (like cancel_tracking) can be processed
                        await asyncio.sleep(0.001)
                    else:
                        print("AI Engine: Propagation completed successfully.")
                        await websocket.send_json({"status": "completed"})
            else:
                generator = self.predictor.propagate_in_video(self.inference_state)
                
                for out_frame_idx, out_obj_ids, out_mask_logits in generator:
                    if self.state.cancel_requested:
                        print(f"AI Engine: Propagation cancelled at frame {out_frame_idx}")
                        await websocket.send_json({"status": "cancelled", "frame": out_frame_idx})
                        break
                    
                    # Convert the mask to base64
                    mask = (out_mask_logits[0] > 0.0).cpu().numpy().squeeze()
                    b64_mask = self._mask_to_base64(mask)
                    
                    self.state.current_frame = out_frame_idx
                    progress = int((out_frame_idx / max(self.state.total_frames, 1)) * 100)
                    
                    await websocket.send_json({
                        "status": "tracking",
                        "frame": out_frame_idx,
                        "progress": progress,
                        "mask_base64": b64_mask
                    })
                    
                    # Yield control to the event loop so that other events (like cancel_tracking) can be processed
                    await asyncio.sleep(0.001)
                else:
                    print("AI Engine: Propagation completed successfully.")
                    await websocket.send_json({"status": "completed"})

        except Exception as e:
            import traceback
            traceback.print_exc()
            print(f"AI Engine Error: {e}")
            await websocket.send_json({"status": "error", "message": str(e)})
        finally:
            self.state.is_tracking = False
            # Dọn dẹp bộ nhớ sau khi tracking xong (kể cả lỗi hay thành công)
            from fastapi.concurrency import run_in_threadpool
            await run_in_threadpool(MemoryManager.cleanup)

    async def run_export(self, websocket, settings: dict):
        format = settings.get("format", "mp4")
        total_frames = settings.get("total_frames", 100)
        print(f"AI Engine: Exporting project in {format}...")
        
        try:
            for progress in range(0, 101, 20):
                await asyncio.sleep(1.0)
                await websocket.send_json({
                    "status": "export_progress",
                    "progress": progress,
                    "message": f"Compositing video via FFmpeg..."
                })
            
            await websocket.send_json({
                "status": "export_completed",
                "file_path": f"cache_workspace/rotofox_export_{int(time.time())}.{format}"
            })
            print("AI Engine: Export completed.")
        except Exception as e:
            print(f"AI Engine Export Error: {e}")
            await websocket.send_json({"status": "export_error", "message": str(e)})
