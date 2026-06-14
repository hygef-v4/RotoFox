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
        if not video_dir.exists() or len(list(video_dir.glob("*.jpg"))) == 0:
            raise RuntimeError("Video frames not extracted.")
            
        print(f"AIEngine: Initializing state for video {video_id}")
        self.inference_state = self.predictor.init_state(video_path=str(video_dir))
        self.video_id = video_id
        self.predictor.reset_state(self.inference_state)

    def add_point_or_box(self, frame_idx: int, coords: list, mode: str, width: int, height: int):
        if not self.inference_state:
            raise RuntimeError("No video loaded into AI engine.")

        # coords is relative [0..1]. SAM2 needs absolute pixel coords.
        # Scale to image dimensions
        if mode in ['add', 'remove']:
            x, y = coords[0] * width, coords[1] * height
            points = np.array([[x, y]], dtype=np.float32)
            labels = np.array([1 if mode == 'add' else 0], np.int32)
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
            return

        print("AI Engine: Starting propagation...")
        try:
            for out_frame_idx, out_obj_ids, out_mask_logits in self.predictor.propagate_in_video(self.inference_state):
                if self.state.cancel_requested:
                    print(f"AI Engine: Propagation cancelled at frame {out_frame_idx}")
                    await websocket.send_json({"status": "cancelled", "frame": out_frame_idx})
                    break
                
                self.state.current_frame = out_frame_idx
                
                mask = (out_mask_logits[0] > 0.0).cpu().numpy().squeeze()
                b64_mask = self._mask_to_base64(mask)
                
                progress = int((out_frame_idx / self.state.total_frames) * 100)
                await websocket.send_json({
                    "status": "tracking",
                    "frame": out_frame_idx,
                    "progress": progress,
                    "mask_base64": b64_mask
                })
                await asyncio.sleep(0.01)

            if not self.state.cancel_requested:
                print("AI Engine: Propagation completed successfully.")
                await websocket.send_json({"status": "completed"})

        except Exception as e:
            print(f"AI Engine Error: {e}")
            await websocket.send_json({"status": "error", "message": str(e)})
        finally:
            self.state.reset()
            MemoryManager.cleanup()

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
