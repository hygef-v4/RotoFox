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

PALETTE = {
    1: [255, 59, 48, 150],   # Red
    2: [0, 122, 255, 150],   # Blue
    3: [52, 199, 89, 150],   # Green
    4: [255, 149, 0, 150],   # Orange
    5: [175, 82, 222, 150],  # Purple
    6: [90, 200, 250, 150],  # Cyan
    7: [255, 204, 0, 150],   # Yellow
}

class AIEngine:
    def __init__(self):
        self.state = EngineState()
        self.predictor = None
        self.inference_state = None
        self.video_id = None
        self.video_width = 1280
        self.video_height = 720
        self.video_fps = 25.0   # Actual FPS of the loaded video
        # Track which frames the user has interacted with.
        # Used to determine the correct propagation start frame for corrections.
        self.interaction_frames: set = set()
        
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

    def load_video(self, video_id: str, fps: float = 25.0):
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

        # Store actual video FPS for use as default in export
        self.video_fps = fps if fps and fps > 0 else 25.0
        print(f"AIEngine: Video FPS stored as {self.video_fps}")

        # Reset interaction history on new video
        self.interaction_frames = set()

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

    def add_point_or_box(self, frame_idx: int, obj_id: int, points: list, labels: list, box: list, width: int, height: int):
        print(f"AIEngine: add_point_or_box. Frame: {frame_idx}, Obj: {obj_id}, Points: {len(points) if points else 0}, Box: {'Yes' if box else 'No'}, Scale: {width}x{height}")
        if not self.inference_state:
            raise RuntimeError("No video loaded into AI engine.")

        # Record this interaction so track_forward can decide the correct start frame
        self.interaction_frames.add(frame_idx)

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
                    obj_id=obj_id,
                    points=abs_points,
                    labels=abs_labels,
                    box=abs_box,
                    clear_old_points=True
                )
        else:
            _, out_obj_ids, out_mask_logits = self.predictor.add_new_points_or_box(
                inference_state=self.inference_state,
                frame_idx=frame_idx,
                obj_id=obj_id,
                points=abs_points,
                labels=abs_labels,
                box=abs_box,
                clear_old_points=True
            )
        
        return self._masks_to_base64(out_obj_ids, out_mask_logits, self.video_width, self.video_height)

    def _masks_to_base64(self, out_obj_ids, out_mask_logits, width, height):
        # Create an empty RGBA image
        if len(out_obj_ids) == 0:
            return None
            
        # Get shape from the first mask
        mask_np = (out_mask_logits[0] > 0.0).cpu().numpy().squeeze()
        h, w = mask_np.shape
        rgba = np.zeros((h, w, 4), dtype=np.uint8)
        
        for idx, obj_id in enumerate(out_obj_ids):
            mask = (out_mask_logits[idx] > 0.0).cpu().numpy().squeeze()
            # Get color based on obj_id, wrap around if > 7
            color_key = ((obj_id - 1) % 7) + 1
            color = PALETTE.get(color_key, [255, 255, 255, 150])
            rgba[mask] = color
            
        img = Image.fromarray(rgba, 'RGBA')
        buf = io.BytesIO()
        img.save(buf, format='PNG')
        return base64.b64encode(buf.getvalue()).decode('utf-8')

    def _clear_stale_non_cond_memory(self, start_frame: int):
        """Clear SAM2 non-conditioning frame outputs for all frames >= start_frame.

        During propagation SAM2 caches per-frame predictions in
        ``non_cond_frame_outputs``.  On a *second* propagation run the model
        re-uses these cached features as memory context when predicting frames
        that come after the new annotation frame.  This causes the output to
        look like the *first* run even when the user has placed new/different
        clicks — the stale memory dominates the new conditioning signal.

        Deleting the cached entries for frames >= start_frame forces SAM2 to
        recompute them from scratch using the fresh annotation as context.
        The *conditioning* outputs (user clicks / boxes) are intentionally
        left untouched so that all annotations remain valid.
        """
        if not self.inference_state:
            return
        output_dict_per_obj = self.inference_state.get("output_dict_per_obj", {})
        cleared = 0
        for obj_idx in output_dict_per_obj:
            non_cond = output_dict_per_obj[obj_idx]["non_cond_frame_outputs"]
            stale = [f for f in list(non_cond.keys()) if f >= start_frame]
            for f in stale:
                del non_cond[f]
                cleared += 1
        if cleared:
            print(f"AIEngine: Cleared {cleared} stale non-cond memory entries "
                  f"for frames >= {start_frame}")
        else:
            print(f"AIEngine: No stale non-cond memory to clear for frames >= {start_frame}")


    async def run_propagation(self, websocket, start_frame=None):
        if not self.state.is_tracking or not self.inference_state:
            print("AI Engine: Cannot start propagation - not tracking or no inference state")
            return

        # Clear stale SAM2 memory BEFORE propagating so that any annotation
        # changes the user made at (or after) start_frame are reflected in the
        # output.  Without this, SAM2 reuses its cached non-conditioning
        # features from the previous propagation run as memory context for
        # frames after start_frame, causing the old mask to dominate even when
        # the user has placed new clicks.
        if start_frame is not None and start_frame > 0:
            self._clear_stale_non_cond_memory(start_frame)

        print(f"AI Engine: Starting propagation from frame {start_frame} "
              f"for {self.state.total_frames} total frames...")
        video_dir = CacheManager.get_video_dir(self.video_id)
        mask_dir = video_dir / "masks"
        mask_dir.mkdir(exist_ok=True)
        
        try:
            # BUG-04 FIX: Use a `completed` flag instead of for...else to correctly detect
            # natural completion vs break (cancel). for...else inside `with` blocks is error-prone.
            completed = False

            if hasattr(self, 'device') and self.device.type == "cuda" and torch.cuda.get_device_capability()[0] >= 8:
                with torch.autocast("cuda", dtype=torch.bfloat16):
                    generator = self.predictor.propagate_in_video(self.inference_state, start_frame_idx=start_frame)
                    
                    for out_frame_idx, out_obj_ids, out_mask_logits in generator:
                        if self.state.cancel_requested:
                            print(f"AI Engine: Propagation cancelled at frame {out_frame_idx}")
                            await websocket.send_json({"status": "cancelled", "frame": out_frame_idx})
                            break
                        
                        b64_mask = self._masks_to_base64(out_obj_ids, out_mask_logits, self.video_width, self.video_height)
                        
                        if b64_mask:
                            mask_filename = f"{out_frame_idx:05d}.png"
                            img_bytes = base64.b64decode(b64_mask)
                            with open(mask_dir / mask_filename, "wb") as f:
                                f.write(img_bytes)
                        
                        self.state.current_frame = out_frame_idx
                        progress = int((out_frame_idx / max(self.state.total_frames, 1)) * 100)
                        
                        await websocket.send_json({
                            "status": "tracking",
                            "frame": out_frame_idx,
                            "progress": progress,
                            "mask_base64": b64_mask
                        })
                        await asyncio.sleep(0.001)
                    else:
                        completed = True
            else:
                generator = self.predictor.propagate_in_video(self.inference_state, start_frame_idx=start_frame)
                
                for out_frame_idx, out_obj_ids, out_mask_logits in generator:
                    if self.state.cancel_requested:
                        print(f"AI Engine: Propagation cancelled at frame {out_frame_idx}")
                        await websocket.send_json({"status": "cancelled", "frame": out_frame_idx})
                        break
                    
                    b64_mask = self._masks_to_base64(out_obj_ids, out_mask_logits, self.video_width, self.video_height)
                    
                    if b64_mask:
                        mask_filename = f"{out_frame_idx:05d}.png"
                        img_bytes = base64.b64decode(b64_mask)
                        with open(mask_dir / mask_filename, "wb") as f:
                            f.write(img_bytes)
                    
                    self.state.current_frame = out_frame_idx
                    progress = int((out_frame_idx / max(self.state.total_frames, 1)) * 100)
                    
                    await websocket.send_json({
                        "status": "tracking",
                        "frame": out_frame_idx,
                        "progress": progress,
                        "mask_base64": b64_mask
                    })
                    await asyncio.sleep(0.001)
                else:
                    completed = True

            if completed:
                print("AI Engine: Propagation completed successfully.")
                await websocket.send_json({"status": "completed"})

        except Exception as e:
            import traceback
            traceback.print_exc()
            print(f"AI Engine Error: {e}")
            await websocket.send_json({"status": "error", "message": str(e)})
        finally:
            self.state.is_tracking = False
            from fastapi.concurrency import run_in_threadpool
            await run_in_threadpool(MemoryManager.cleanup)

    def remove_object(self, obj_id: int, frame_idx: int = None):
        if not self.inference_state:
            return None
        try:
            # SAM2's remove_object returns (inference_state, {frame_idx: (obj_ids, mask_logits)})
            _, updated_frames = self.predictor.remove_object(self.inference_state, obj_id)
            print(f"AIEngine: Object {obj_id} removed.")
            
            # BUG-05 FIX: updated_frames is a dict {frame_idx: (obj_ids, mask_logits)}
            # Previous code iterated it as a generator of tuples, which is incorrect.
            if frame_idx is not None and isinstance(updated_frames, dict) and frame_idx in updated_frames:
                out_obj_ids, out_mask_logits = updated_frames[frame_idx]
                return self._masks_to_base64(out_obj_ids, out_mask_logits, self.video_width, self.video_height)
            return None
        except Exception as e:
            print(f"AIEngine: Error removing object {obj_id}: {e}")
            return None

    async def run_export(self, websocket, settings: dict):
        export_format = settings.get("format", "mp4")
        export_type = settings.get("type", "alpha")
        bg_color_str = settings.get("bg_color", "green")
        total_frames = settings.get("total_frames", self.state.total_frames or 100)
        export_path_str = settings.get("export_path", "").strip()
        resolution_str = settings.get("resolution", "original")
        fps_str = settings.get("fps", "original")
        
        try:
            # ISSUE-10 FIX: use actual video FPS as default instead of hardcoded 25
            fps = float(fps_str) if fps_str != "original" else self.video_fps
        except ValueError:
            fps = self.video_fps
            
        export_w, export_h = self.video_width, self.video_height
        if resolution_str == "1080p":
            export_w, export_h = 1920, 1080
        elif resolution_str == "720p":
            export_w, export_h = 1280, 720
        
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
        
        if export_path_str:
            export_dir = Path(export_path_str)
        else:
            # Default to Downloads/RotoFox Exports
            export_dir = Path.home() / "Downloads" / "RotoFox Exports"
            
        export_dir.mkdir(parents=True, exist_ok=True)
        output_path = str(export_dir / output_filename)
        
        video_dir = CacheManager.get_video_dir(self.video_id)
        mask_dir = video_dir / "masks"
        
        print(f"AI Engine: Exporting project to {output_path} (Type: {export_type}, BG: {bg_color_str}, Res: {export_w}x{export_h}, FPS: {fps})...")
        
        try:
            if export_format == "webm":
                fourcc = cv2.VideoWriter_fourcc(*'vp80')
            else:
                fourcc = cv2.VideoWriter_fourcc(*'mp4v')
                
            writer = cv2.VideoWriter(output_path, fourcc, fps, (export_w, export_h))
            
            for i in range(total_frames):
                frame_path = video_dir / f"{i:05d}.jpg"
                mask_path = mask_dir / f"{i:05d}.png"
                
                # Default frame is black if missing
                out_frame = np.zeros((self.video_height, self.video_width, 3), dtype=np.uint8)
                
                if frame_path.exists():
                    img = cv2.imread(str(frame_path))
                    if img is not None:
                        out_frame = img

                # Read mask using alpha channel since it's an RGBA image
                mask = np.zeros((self.video_height, self.video_width), dtype=np.uint8)
                if mask_path.exists():
                    m = cv2.imread(str(mask_path), cv2.IMREAD_UNCHANGED)
                    if m is not None and len(m.shape) == 3 and m.shape[2] == 4:
                        mask = m[:, :, 3] # Extract alpha channel
                    elif m is not None:
                        mask = cv2.cvtColor(m, cv2.COLOR_BGR2GRAY)
                
                # Resize if needed
                if export_w != self.video_width or export_h != self.video_height:
                    out_frame = cv2.resize(out_frame, (export_w, export_h), interpolation=cv2.INTER_LINEAR)
                    mask = cv2.resize(mask, (export_w, export_h), interpolation=cv2.INTER_NEAREST)

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
                
                # ISSUE-06 FIX: update progress every frame (throttled by time to avoid flooding WS)
                if i % max(1, total_frames // 50) == 0 or i == total_frames - 1:
                    progress = int((i / max(total_frames, 1)) * 100)
                    await websocket.send_json({
                        "status": "export_progress",
                        "progress": progress,
                        "message": f"Rendering frame {i+1}/{total_frames}..."
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
