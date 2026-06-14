import asyncio
import time
import os
import io
import base64
from PIL import Image
import numpy as np
import torch
import cv2
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
        
        # Free up previous state memory before loading new one
        if self.inference_state is not None:
            print("AIEngine: Clearing previous inference state to free VRAM.")
            del self.inference_state
            self.inference_state = None
            if hasattr(self, 'device') and self.device.type == "cuda":
                torch.cuda.empty_cache()

        if hasattr(self, 'device') and self.device.type == "cuda" and torch.cuda.get_device_capability()[0] >= 8:
            with torch.autocast("cuda", dtype=torch.bfloat16):
                self.inference_state = self.predictor.init_state(video_path=str(video_dir))
                self.predictor.reset_state(self.inference_state)
        else:
            self.inference_state = self.predictor.init_state(video_path=str(video_dir))
            self.predictor.reset_state(self.inference_state)
        self.video_id = video_id

    def add_point_or_box(self, frame_idx: int, points: list, labels: list, box: list, width: int, height: int):
        print(f"AIEngine: add_point_or_box. Frame: {frame_idx}, Points: {len(points) if points else 0}, Box: {'Yes' if box else 'No'}, Scale: {width}x{height}")
        if not self.inference_state:
            raise RuntimeError("No video loaded into AI engine.")

        abs_points, abs_labels, abs_box = None, None, None

        if points and labels and len(points) > 0:
            abs_points = np.array([[p[0] * width, p[1] * height] for p in points], dtype=np.float32)
            abs_labels = np.array(labels, np.int32)
            
        if box and len(box) == 4:
            abs_box = np.array([box[0] * width, box[1] * height, box[2] * width, box[3] * height], dtype=np.float32)

        if abs_points is None and abs_box is None:
            raise ValueError("No valid points or box provided")

        if hasattr(self, 'device') and self.device.type == "cuda" and torch.cuda.get_device_capability()[0] >= 8:
            with torch.autocast("cuda", dtype=torch.bfloat16):
                _, out_obj_ids, out_mask_logits = self.predictor.add_new_points_or_box(
                    inference_state=self.inference_state,
                    frame_idx=frame_idx,
                    obj_id=self.obj_id,
                    points=abs_points,
                    labels=abs_labels,
                    box=abs_box,
                    clear_old_points=True
                )
        else:
            _, out_obj_ids, out_mask_logits = self.predictor.add_new_points_or_box(
                inference_state=self.inference_state,
                frame_idx=frame_idx,
                obj_id=self.obj_id,
                points=abs_points,
                labels=abs_labels,
                box=abs_box,
                clear_old_points=True
            )
        
        # Convert mask to base64
        mask = (out_mask_logits[0] > 0.0).cpu().numpy().squeeze()
        print(f"AIEngine: Mask generated. Shape: {mask.shape}, Active pixels: {np.sum(mask)}")
        return self._mask_to_base64(mask)

    def _mask_to_base64(self, mask_np):
        h, w = mask_np.shape
        rgba = np.zeros((h, w, 4), dtype=np.uint8)
        # White color, fully opaque where mask is True, transparent where False
        rgba[mask_np, :] = [255, 255, 255, 255]
        
        img = Image.fromarray(rgba, 'RGBA')
        buf = io.BytesIO()
        img.save(buf, format='PNG')
        return base64.b64encode(buf.getvalue()).decode('utf-8')

    async def run_propagation(self, websocket):
        if not self.state.is_tracking or not self.inference_state:
            print("AI Engine: Cannot start propagation - not tracking or no inference state")
            return

        print(f"AI Engine: Starting propagation for {self.state.total_frames} frames...")
        video_dir = CacheManager.get_video_dir(self.video_id)
        mask_dir = video_dir / "masks"
        mask_dir.mkdir(exist_ok=True)
        
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
                        
                        # Save mask to disk for export
                        mask_filename = f"{out_frame_idx:05d}.png"
                        cv2.imwrite(str(mask_dir / mask_filename), (mask.astype(np.uint8) * 255))
                        
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
                    
                    # Save mask to disk for export
                    mask_filename = f"{out_frame_idx:05d}.png"
                    cv2.imwrite(str(mask_dir / mask_filename), (mask.astype(np.uint8) * 255))
                        
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
        export_format = settings.get("format", "mp4")
        export_type = settings.get("type", "alpha")
        bg_color_str = settings.get("bg_color", "green")
        total_frames = settings.get("total_frames", self.state.total_frames or 100)
        
        # Parse background color for Solid mode (OpenCV uses BGR)
        bg_colors = {
            "green": [0, 255, 0],
            "blue": [255, 0, 0],
            "black": [0, 0, 0],
            "white": [255, 255, 255]
        }
        bgr_color = bg_colors.get(bg_color_str, [0, 255, 0])
        
        if not self.video_id:
            await websocket.send_json({"status": "export_error", "message": "No video loaded."})
            return
            
        output_filename = f"rotofox_export_{int(time.time())}.{export_format}"
        output_path = str(CacheManager.get_video_dir(self.video_id).parent / output_filename)
        
        video_dir = CacheManager.get_video_dir(self.video_id)
        mask_dir = video_dir / "masks"
        
        print(f"AI Engine: Exporting project to {output_path} (Type: {export_type}, BG: {bg_color_str})...")
        
        try:
            # Assume 25 FPS as default for export
            fps = 25.0
            
            if export_format == "webm":
                fourcc = cv2.VideoWriter_fourcc(*'vp80')
            else:
                fourcc = cv2.VideoWriter_fourcc(*'mp4v')
                
            writer = cv2.VideoWriter(output_path, fourcc, fps, (self.video_width, self.video_height))
            
            for i in range(total_frames):
                frame_path = video_dir / f"{i:05d}.jpg"
                mask_path = mask_dir / f"{i:05d}.png"
                
                # Default frame is black if missing
                out_frame = np.zeros((self.video_height, self.video_width, 3), dtype=np.uint8)
                
                if frame_path.exists():
                    img = cv2.imread(str(frame_path))
                    if img is not None:
                        out_frame = img

                # Read mask
                mask = np.zeros((self.video_height, self.video_width), dtype=np.uint8)
                if mask_path.exists():
                    m = cv2.imread(str(mask_path), cv2.IMREAD_GRAYSCALE)
                    if m is not None:
                        mask = m

                # Render logic
                if export_type == "alpha":
                    # Grayscale mask to BGR (black and white video)
                    out_frame = cv2.cvtColor(mask, cv2.COLOR_GRAY2BGR)
                elif export_type == "solid":
                    # Fill background with solid color, keep object
                    out_frame[mask < 127] = bgr_color
                else:
                    # Video Overlay: add red tint at 50% opacity
                    overlay = out_frame.copy()
                    overlay[mask > 127] = [0, 0, 255] # BGR for red
                    out_frame = cv2.addWeighted(overlay, 0.5, out_frame, 0.5, 0)
                
                writer.write(out_frame)
                
                # Progress update
                if i % max(1, total_frames // 20) == 0:
                    progress = int((i / max(total_frames, 1)) * 100)
                    await websocket.send_json({
                        "status": "export_progress",
                        "progress": progress,
                        "message": f"Rendering frame {i}/{total_frames}..."
                    })
                    await asyncio.sleep(0.001)

            writer.release()
            
            await websocket.send_json({
                "status": "export_completed",
                "file_path": str(Path(output_path).resolve())
            })
            print("AI Engine: Export completed.")
        except Exception as e:
            import traceback
            traceback.print_exc()
            print(f"AI Engine Export Error: {e}")
            await websocket.send_json({"status": "export_error", "message": str(e)})
