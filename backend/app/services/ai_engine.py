"""AI Engine Orchestration for RotoFox.

This module encapsulates the Segment Anything Model 2 (SAM 2) video predictor
and MatAnyone 2 edge refinement pipeline, orchestrating model loading,
point/box prompts addition, mask propagation, and transparent video export.
"""

import asyncio
import base64
import io
import os
import shutil
import time
from pathlib import Path
from typing import Optional, List, Dict, Any, Set, Tuple
import cv2
import numpy as np
import torch
from PIL import Image
from fastapi import WebSocket
from fastapi.concurrency import run_in_threadpool

from app.core.engine_state import EngineState
from app.services.cache_manager import CacheManager
from app.services.memory_manager import MemoryManager
from app.services.model_manager import ModelManager, MODELS

try:
    from sam2.build_sam import build_sam2_video_predictor
    SAM2_AVAILABLE = True
except ImportError:
    SAM2_AVAILABLE = False

# Color palette for rendering up to 7 distinct color-coded mask layers
PALETTE: Dict[int, List[int]] = {
    1: [255, 59, 48, 150],   # Red
    2: [0, 122, 255, 150],   # Blue
    3: [52, 199, 89, 150],   # Green
    4: [255, 149, 0, 150],   # Orange
    5: [175, 82, 222, 150],  # Purple
    6: [90, 200, 250, 150],  # Cyan
    7: [255, 204, 0, 150],   # Yellow
}


class AIEngine:
    """Orchestrates SAM 2 and MatAnyone 2 models for video segmentation and rotoscoping."""

    def __init__(self) -> None:
        self.state: EngineState = EngineState()
        self.predictor: Optional[Any] = None
        self.inference_state: Optional[Any] = None
        self.video_id: Optional[str] = None
        self.video_width: int = 1280
        self.video_height: int = 720
        self.video_fps: float = 25.0
        self.interaction_frames: Set[int] = set()
        self.active_model_id: Optional[str] = None
        self.device: torch.device = torch.device("cpu")

        if SAM2_AVAILABLE:
            self._init_model()

    def _init_model(self) -> None:
        """Resolve and initialize the best available SAM 2 checkpoint on CUDA, MPS, or CPU."""
        if torch.cuda.is_available():
            self.device = torch.device("cuda")
            if torch.cuda.get_device_capability()[0] >= 8:
                torch.autocast("cuda", dtype=torch.bfloat16).__enter__()
        elif torch.backends.mps.is_available():
            self.device = torch.device("mps")
        else:
            self.device = torch.device("cpu")

        # Automatically locate the highest priority checkpoint on disk
        checkpoints_dir = ModelManager.get_checkpoints_dir()
        found_model = None

        for model_id in ["large", "base", "small", "tiny"]:
            info = MODELS[model_id]
            if (checkpoints_dir / info["checkpoint"]).exists():
                found_model = model_id
                break

        if not found_model:
            print("AIEngine: WARNING: No SAM 2 checkpoints found in checkpoints/ directory.")
            self.predictor = None
            self.active_model_id = None
            return

        print(f"AIEngine: Loading {MODELS[found_model]['name']} on {self.device}...")
        try:
            checkpoint = checkpoints_dir / MODELS[found_model]["checkpoint"]
            model_cfg = MODELS[found_model]["config"]
            self.predictor = build_sam2_video_predictor(model_cfg, str(checkpoint), device=self.device)
            self.predictor.add_all_frames_to_correct_as_cond = True
            self.active_model_id = found_model
            print(f"AIEngine: {MODELS[found_model]['name']} loaded successfully.")
        except Exception as e:
            print(f"AIEngine: Error loading initial model {found_model}: {e}")
            self.predictor = None
            self.active_model_id = None

    def load_model(self, model_id: str) -> None:
        """Unload the active SAM 2 model and dynamically load a different checkpoint.

        Args:
            model_id (str): The identifier of the model to load (e.g., 'large', 'small').

        Raises:
            RuntimeError: If the SAM 2 framework is not installed.
            ValueError: If the model_id is invalid or refers to a refinement model.
            FileNotFoundError: If the checkpoint file is missing from disk.
        """
        global SAM2_AVAILABLE
        if not SAM2_AVAILABLE:
            raise RuntimeError("SAM 2 framework is not installed.")

        if model_id not in MODELS:
            raise ValueError(f"Unknown model id: {model_id}")

        if model_id == "matanyone":
            raise ValueError(
                "MatAnyone 2 is a refinement model and cannot be loaded as a tracking model. "
                "It will be used automatically during project export."
            )

        checkpoints_dir = ModelManager.get_checkpoints_dir()
        info = MODELS[model_id]
        checkpoint_path = checkpoints_dir / info["checkpoint"]

        if not checkpoint_path.exists():
            raise FileNotFoundError(f"Checkpoint file {info['checkpoint']} does not exist. Please download it first.")

        print("AIEngine: Unloading model and clearing RAM/VRAM cache...")
        self.predictor = None
        if self.inference_state is not None:
            del self.inference_state
            self.inference_state = None
        MemoryManager.cleanup()

        print(f"AIEngine: Loading {info['name']} dynamically...")
        self.predictor = build_sam2_video_predictor(info["config"], str(checkpoint_path), device=self.device)
        self.predictor.add_all_frames_to_correct_as_cond = True
        self.active_model_id = model_id

        SAM2_AVAILABLE = True
        print(f"AIEngine: Dynamic load of {info['name']} complete.")

    def load_video(self, video_id: str, fps: float = 25.0) -> None:
        """Initialize the SAM 2 inference state for a newly uploaded video cache.

        Args:
            video_id (str): Unique identifier of the cached video session.
            fps (float, optional): The effective FPS of the video. Defaults to 25.0.

        Raises:
            RuntimeError: If SAM 2 model is not loaded or cache frames are missing.
        """
        if not SAM2_AVAILABLE or self.predictor is None:
            raise RuntimeError("SAM 2 model is not loaded. Please download/activate a model in the Model Hub.")

        video_dir = CacheManager.get_video_dir(video_id)
        frames = list(video_dir.glob("*.jpg"))
        if not video_dir.exists() or len(frames) == 0:
            raise RuntimeError("Video frames not extracted.")

        # Read dimensions of the first frame to scale normalized canvas coordinates
        first_frame = sorted(frames)[0]
        try:
            with Image.open(first_frame) as img:
                self.video_width, self.video_height = img.size
            print(f"AIEngine: Loaded video dimensions: {self.video_width}x{self.video_height}")
        except Exception as e:
            print(f"Warning: Could not read video dimensions from first frame: {e}. Defaulting to 1280x720")
            self.video_width, self.video_height = 1280, 720

        self.video_fps = fps if fps and fps > 0 else 25.0
        print(f"AIEngine: Video FPS stored as {self.video_fps}")

        self.interaction_frames = set()

        print(f"AIEngine: Initializing state for video {video_id}")

        # Free previous VRAM allocations before loading a new state
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

    def add_point_or_box(
        self,
        frame_idx: int,
        obj_id: int,
        points: Optional[List[List[float]]],
        labels: Optional[List[int]],
        box: Optional[List[float]],
        width: int,
        height: int
    ) -> Optional[str]:
        """Add positive/negative point prompts or box annotations on a frame and predict masks.

        Args:
            frame_idx (int): The current frame index.
            obj_id (int): Identifier of the mask object layer.
            points (list, optional): List of normalized [X, Y] click coordinates.
            labels (list, optional): List of click labels (1: Include, 0: Exclude).
            box (list, optional): Bounding box coordinates [X1, Y1, X2, Y2].
            width (int): Current Canvas width.
            height (int): Current Canvas height.

        Raises:
            RuntimeError: If no video inference state is loaded.
            ValueError: If neither points nor boxes are provided.

        Returns:
            str, optional: Base64-encoded RGBA PNG representing the predicted overlay.
        """
        print(f"AIEngine: add_point_or_box. Frame: {frame_idx}, Obj: {obj_id}")
        if not self.inference_state:
            raise RuntimeError("No video loaded into AI engine.")

        # Log frame interactions to help track_forward calculate correction propagation ranges
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

    def _masks_to_base64(self, out_obj_ids: List[int], out_mask_logits: Any, width: int, height: int) -> Optional[str]:
        """Convert predicted torch mask logits into a colorized RGBA Base64 string.

        Args:
            out_obj_ids (list): Predicted object IDs.
            out_mask_logits (Tensor): Predicted raw logits.
            width (int): Canvas target width.
            height (int): Canvas target height.

        Returns:
            str, optional: Base64-encoded overlay image string.
        """
        if len(out_obj_ids) == 0:
            return None

        # Convert logits into a binary mask
        mask_np = (out_mask_logits[0] > 0.0).cpu().numpy().squeeze()
        h, w = mask_np.shape
        rgba = np.zeros((h, w, 4), dtype=np.uint8)

        # Loop through objects and apply color overlays based on their IDs
        for idx, obj_id in enumerate(out_obj_ids):
            mask = (out_mask_logits[idx] > 0.0).cpu().numpy().squeeze()
            color_key = ((obj_id - 1) % 7) + 1
            color = PALETTE.get(color_key, [255, 255, 255, 150])
            rgba[mask] = color

        img = Image.fromarray(rgba, 'RGBA')
        buf = io.BytesIO()
        img.save(buf, format='PNG')
        return base64.b64encode(buf.getvalue()).decode('utf-8')

    def _clear_stale_non_cond_memory(self, start_frame: int) -> None:
        """Clear SAM2 non-conditioning cached features for all frames >= start_frame.

        This forces the propagation algorithm to re-calculate features using the updated
        user annotations (conditioning inputs) instead of reusing stale tracking cache.

        Args:
            start_frame (int): The boundary frame index from which to purge the cache.
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

        # Also clean frames_tracked_per_obj to keep SAM 2 tracking history synchronized
        frames_tracked = self.inference_state.get("frames_tracked_per_obj", {})
        for obj_idx in frames_tracked:
            stale_tracked = [f for f in list(frames_tracked[obj_idx].keys()) if f >= start_frame]
            for f in stale_tracked:
                del frames_tracked[obj_idx][f]

        if cleared:
            print(f"AIEngine: Cleared {cleared} stale non-cond memory entries for frames >= {start_frame}")
        else:
            print(f"AIEngine: No stale non-cond memory to clear for frames >= {start_frame}")

    async def run_propagation(self, websocket: WebSocket, start_frame: Optional[int] = None) -> None:
        """Run SAM 2 video mask propagation and stream predictions to the client.

        Args:
            websocket (WebSocket): The active client WebSocket connection.
            start_frame (int, optional): The frame index from which to begin propagation.
        """
        if not self.state.is_tracking or not self.inference_state:
            print("AI Engine: Cannot start propagation - not tracking or no inference state")
            return

        # Purge stale memory slots to force propagation recalculations based on fresh annotations
        if start_frame is not None and start_frame > 0:
            self._clear_stale_non_cond_memory(start_frame)

        print(f"AI Engine: Starting propagation from frame {start_frame}...")
        video_dir = CacheManager.get_video_dir(self.video_id)
        mask_dir = video_dir / "masks"
        mask_dir.mkdir(exist_ok=True)

        try:
            completed = False

            if hasattr(self, 'device') and self.device.type == "cuda" and torch.cuda.get_device_capability()[0] >= 8:
                with torch.autocast("cuda", dtype=torch.bfloat16):
                    generator = self.predictor.propagate_in_video(self.inference_state, start_frame_idx=start_frame)

                    for out_frame_idx, out_obj_ids, out_mask_logits in generator:
                        if self.state.cancel_requested:
                            print(f"AI Engine: Propagation cancelled at frame {out_frame_idx}")
                            await websocket.send_json({"status": "cancelled", "frame": out_frame_idx})
                            break

                        b64_mask = self._masks_to_base64(
                            out_obj_ids, out_mask_logits, self.video_width, self.video_height
                        )

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

                    b64_mask = self._masks_to_base64(
                        out_obj_ids, out_mask_logits, self.video_width, self.video_height
                    )

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
            await run_in_threadpool(MemoryManager.cleanup)

    def remove_object(self, obj_id: int, frame_idx: Optional[int] = None) -> Optional[str]:
        """Remove a designated object from tracking history.

        Args:
            obj_id (int): ID of the object to delete.
            frame_idx (int, optional): Current frame index.

        Returns:
            str, optional: Updated base64 overlay of the current frame.
        """
        if not self.inference_state:
            return None
        try:
            _, updated_frames = self.predictor.remove_object(self.inference_state, obj_id)
            print(f"AIEngine: Object {obj_id} removed.")

            if frame_idx is not None and isinstance(updated_frames, dict) and frame_idx in updated_frames:
                out_obj_ids, out_mask_logits = updated_frames[frame_idx]
                return self._masks_to_base64(out_obj_ids, out_mask_logits, self.video_width, self.video_height)
            return None
        except Exception as e:
            print(f"AIEngine: Error removing object {obj_id}: {e}")
            return None

    async def run_export(self, websocket: WebSocket, settings: Dict[str, Any]) -> None:
        """Composite mask overlays onto frames and render the final transparent output video.

        Args:
            websocket (WebSocket): Client WebSocket connection.
            settings (dict): Target resolution, background color, format, and FPS settings.
        """
        export_format = settings.get("format", "mp4")
        export_type = settings.get("type", "alpha")
        bg_color_str = settings.get("bg_color", "green")
        total_frames = settings.get("total_frames", self.state.total_frames or 100)
        export_path_str = settings.get("export_path", "").strip()
        resolution_str = settings.get("resolution", "original")
        fps_str = settings.get("fps", "original")

        try:
            fps = float(fps_str) if fps_str != "original" else self.video_fps
        except ValueError:
            fps = self.video_fps

        export_w, export_h = self.video_width, self.video_height
        if resolution_str == "1080p":
            export_w, export_h = 1920, 1080
        elif resolution_str == "720p":
            export_w, export_h = 1280, 720

        # Background color BGR dictionary for solid color fills
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
            export_dir = Path.home() / "Downloads" / "RotoFox Exports"

        export_dir.mkdir(parents=True, exist_ok=True)
        output_path = str(export_dir / output_filename)

        video_dir = CacheManager.get_video_dir(self.video_id)
        mask_dir = video_dir / "masks"

        # Check if MatAnyone 2 checkpoint is present on local storage to activate edge refinement
        checkpoints_dir = ModelManager.get_checkpoints_dir()
        matanyone_checkpoint = checkpoints_dir / "matanyone2.pth"
        use_matanyone = matanyone_checkpoint.exists()

        refined_mask_dir = None

        if use_matanyone:
            try:
                await websocket.send_json({
                    "status": "export_progress",
                    "progress": 0,
                    "message": "Starting MatAnyone 2 edge refinement on GPU..."
                })

                # Copy raw frame JPGs to an isolated input directory
                temp_input_dir = video_dir / "matanyone_input"
                temp_input_dir.mkdir(exist_ok=True)
                for f in video_dir.glob("*.jpg"):
                    shutil.copy2(f, temp_input_dir / f.name)

                temp_output_dir = video_dir / "matanyone_output"
                temp_output_dir.mkdir(exist_ok=True)

                # Dynamically load the third-party MatAnyone2 script
                import sys
                repo_root = Path(__file__).parent.parent.parent.parent
                matanyone_src_dir = repo_root / "backend" / "third_party" / "MatAnyone2"
                if str(matanyone_src_dir) not in sys.path:
                    sys.path.insert(0, str(matanyone_src_dir))

                from inference_matanyone2 import main as matanyone2_inference

                masks_list = sorted(list(mask_dir.glob("*.png")))
                if not masks_list:
                    raise FileNotFoundError("No SAM 2 masks found for refinement.")
                first_mask_path = masks_list[0]

                # Unload SAM 2 to avoid VRAM Out Of Memory during MatAnyone 2 inference
                self.predictor = None
                if self.inference_state is not None:
                    del self.inference_state
                    self.inference_state = None
                MemoryManager.cleanup()

                # Run MatAnyone 2 inference on threadpool
                await run_in_threadpool(
                    matanyone2_inference,
                    input_path=str(temp_input_dir),
                    mask_path=str(first_mask_path),
                    output_path=str(temp_output_dir),
                    ckpt_path=str(matanyone_checkpoint),
                    save_image=True,
                    max_size=512
                )

                refined_mask_dir = temp_output_dir / "matanyone_input" / "pha"
                print(f"AIEngine: MatAnyone 2 refinement completed. Using masks: {refined_mask_dir}")

            except Exception as e:
                import traceback
                traceback.print_exc()
                print(f"AIEngine: WARNING: MatAnyone 2 refinement failed: {e}.")
                use_matanyone = False

        print(f"AI Engine: Exporting project to {output_path}...")

        try:
            if export_format == "webm":
                fourcc = cv2.VideoWriter_fourcc(*'vp80')
            else:
                fourcc = cv2.VideoWriter_fourcc(*'mp4v')

            writer = cv2.VideoWriter(output_path, fourcc, fps, (export_w, export_h))

            for i in range(total_frames):
                frame_path = video_dir / f"{i:05d}.jpg"

                if use_matanyone and refined_mask_dir is not None:
                    current_mask_path = refined_mask_dir / f"{i:04d}.png"
                else:
                    current_mask_path = mask_dir / f"{i:05d}.png"

                out_frame = np.zeros((self.video_height, self.video_width, 3), dtype=np.uint8)

                if frame_path.exists():
                    img = cv2.imread(str(frame_path))
                    if img is not None:
                        out_frame = img

                mask = np.zeros((self.video_height, self.video_width), dtype=np.uint8)
                if current_mask_path.exists():
                    m = cv2.imread(str(current_mask_path), cv2.IMREAD_UNCHANGED)
                    if m is not None and len(m.shape) == 3 and m.shape[2] == 4:
                        mask = m[:, :, 3]  # Get transparency channel
                    elif m is not None:
                        mask = cv2.cvtColor(m, cv2.COLOR_BGR2GRAY)

                if export_w != self.video_width or export_h != self.video_height:
                    out_frame = cv2.resize(out_frame, (export_w, export_h), interpolation=cv2.INTER_LINEAR)
                    mask = cv2.resize(mask, (export_w, export_h), interpolation=cv2.INTER_NEAREST)

                if export_type == "alpha":
                    out_frame = cv2.cvtColor(mask, cv2.COLOR_GRAY2BGR)
                elif export_type == "solid":
                    out_frame[mask < 127] = bgr_color
                else:
                    overlay = out_frame.copy()
                    overlay[mask > 127] = [0, 0, 255]
                    out_frame = cv2.addWeighted(overlay, 0.5, out_frame, 0.5, 0)

                writer.write(out_frame)

                # Report progress throttled to prevent flooding client
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
        finally:
            if use_matanyone:
                try:
                    temp_input_dir = video_dir / "matanyone_input"
                    temp_output_dir = video_dir / "matanyone_output"
                    if temp_input_dir.exists():
                        shutil.rmtree(temp_input_dir)
                    if temp_output_dir.exists():
                        shutil.rmtree(temp_output_dir)
                except Exception as e:
                    print(f"AIEngine: Cleanup warning: {e}")

