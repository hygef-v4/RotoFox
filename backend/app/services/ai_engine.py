"""AI Engine Orchestration for RotoFox.

Wraps the SAM 2 video predictor and the MatAnyone 2 refinement pass, and owns
model loading, prompt handling, mask propagation and export.

Two storage formats are produced for every tracked frame, because they serve
different consumers and conflating them corrupted exports:

* ``masks/{frame}.png`` — colourised RGBA overlay with alpha 150, drawn on the
  canvas so the user can see the video through it.
* ``alpha/{frame}.png`` — 8-bit binary matte, 0 or 255, used by the exporter.
  Previously the exporter reused the overlay and read its alpha channel, so
  every "Alpha Matte" export came out at 150/255 grey. Dropped into an NLE as a
  track matte, the subject rendered at 59% opacity instead of fully opaque.

``alpha/obj{id}/{frame}.png`` holds the same matte split per object, which is
what MatAnyone needs to refine layers independently.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import io
import logging
import time
from collections.abc import Iterator, Sequence
from pathlib import Path
from typing import Any

import cv2
import numpy as np
import torch
from PIL import Image

from app.core.engine_state import EngineState
from app.services.cache_manager import CacheManager
from app.services.exporters import (
    ExportWriterError,
    FFmpegWriter,
    OpenCvWriter,
    PngSequenceWriter,
    find_ffmpeg,
)
from app.services.matting_engine import MatAnyoneUnavailable, MattingEngine
from app.services.memory_manager import MemoryManager
from app.services.model_manager import MODELS, ModelManager

logger = logging.getLogger(__name__)

try:
    from sam2.build_sam import build_sam2_video_predictor

    SAM2_AVAILABLE = True
except ImportError as _exc:  # pragma: no cover - depends on installation
    logger.error("SAM 2 is not importable: %s", _exc)
    SAM2_AVAILABLE = False

# Overlay colours for up to 7 mask layers. The alpha of 150 is a *display*
# choice; it must never reach the exporter.
PALETTE: dict[int, list[int]] = {
    1: [255, 59, 48, 150],   # Red
    2: [0, 122, 255, 150],   # Blue
    3: [52, 199, 89, 150],   # Green
    4: [255, 149, 0, 150],   # Orange
    5: [175, 82, 222, 150],  # Purple
    6: [90, 200, 250, 150],  # Cyan
    7: [255, 204, 0, 150],   # Yellow
}

VIDEO_EXTENSIONS = frozenset({".mp4", ".mov", ".webm", ".avi", ".mkv", ".m4v", ".ogv"})

# Resolution used for MatAnyone inference. -1 keeps the source resolution,
# which is the point of running a hair-level matting model at all.
MATANYONE_MAX_SIZE = -1


class AIEngine:
    """Orchestrates SAM 2 and MatAnyone 2 for video segmentation."""

    def __init__(self) -> None:
        self.state: EngineState = EngineState()
        self.predictor: Any | None = None
        self.inference_state: Any | None = None
        self.video_id: str | None = None
        self.video_width: int = 1280
        self.video_height: int = 720
        self.video_fps: float = 25.0
        self.frame_count: int = 0
        self.interaction_frames: set[int] = set()
        self.tracked_objects: set[int] = set()
        self.active_model_id: str | None = None
        self.device: torch.device = self._select_device()
        self.matting: MattingEngine = MattingEngine(self.device)

        if SAM2_AVAILABLE:
            self._init_model()

    # ── Device and precision ──────────────────────────────────────────────

    @staticmethod
    def _select_device() -> torch.device:
        """Pick the best available compute device."""
        if torch.cuda.is_available():
            return torch.device("cuda")
        if getattr(torch.backends, "mps", None) is not None and torch.backends.mps.is_available():
            return torch.device("mps")
        return torch.device("cpu")

    def _supports_bf16(self) -> bool:
        """Check whether the device benefits from bfloat16 autocast."""
        if self.device.type != "cuda":
            return False
        try:
            return torch.cuda.get_device_capability()[0] >= 8
        except (RuntimeError, AssertionError):
            return False

    @contextlib.contextmanager
    def _amp(self) -> Iterator[None]:
        """Enable bfloat16 autocast on capable GPUs, as a scoped context.

        The previous code called ``torch.autocast(...).__enter__()`` once during
        startup and never exited it, leaving autocast permanently enabled for
        every tensor operation in the process — including MatAnyone's, whose
        alpha output is precision-sensitive. It then *also* nested explicit
        ``with torch.autocast(...)`` blocks in four places, duplicating roughly
        sixty lines of otherwise identical code.
        """
        if self._supports_bf16():
            with torch.autocast("cuda", dtype=torch.bfloat16):
                yield
        else:
            yield

    # ── Model lifecycle ───────────────────────────────────────────────────

    def _init_model(self) -> None:
        """Load the best checkpoint present on disk, largest first."""
        found_model = next(
            (mid for mid in ("large", "base", "small", "tiny") if ModelManager.is_downloaded(mid)),
            None,
        )

        if not found_model:
            logger.warning("No SAM 2 checkpoint found in %s", ModelManager.get_checkpoints_dir())
            self.predictor = None
            self.active_model_id = None
            return

        try:
            self._build_predictor(found_model)
        except Exception as exc:
            logger.exception("Could not load initial model %s: %s", found_model, exc)
            self.predictor = None
            self.active_model_id = None

    def _build_predictor(self, model_id: str) -> None:
        """Construct the SAM 2 video predictor for a given model id."""
        info = MODELS[model_id]
        checkpoint = ModelManager.checkpoint_path(model_id)
        logger.info("Loading %s on %s", info["name"], self.device)

        self.predictor = build_sam2_video_predictor(
            info["config"], str(checkpoint), device=self.device
        )
        # A frame that receives a correction click becomes a conditioning frame,
        # so later corrections actually influence propagation.
        self.predictor.add_all_frames_to_correct_as_cond = True
        self.active_model_id = model_id
        logger.info("%s loaded successfully", info["name"])

    def load_model(self, model_id: str) -> None:
        """Swap the active tracking model, freeing the previous one first.

        Args:
            model_id: Identifier of the model to activate.

        Raises:
            RuntimeError: If SAM 2 is not installed.
            ValueError: If the id is unknown or refers to the refinement model.
            FileNotFoundError: If the checkpoint is missing or truncated.
        """
        if not SAM2_AVAILABLE:
            raise RuntimeError(
                "The SAM 2 framework is not installed. Run "
                "'python scripts/setup_sam2.py' in the backend folder."
            )
        if model_id not in MODELS:
            raise ValueError(f"Unknown model id: {model_id}")
        if model_id == "matanyone":
            raise ValueError(
                "MatAnyone 2 is a refinement model and cannot be used for tracking. "
                "It runs automatically during export when its checkpoint is present."
            )
        if not ModelManager.is_downloaded(model_id):
            raise FileNotFoundError(
                f"The checkpoint for {MODELS[model_id]['name']} is missing or incomplete. "
                "Download it from the Model Hub first."
            )

        logger.info("Unloading current model to free RAM/VRAM")
        self.predictor = None
        self.inference_state = None
        MemoryManager.cleanup()

        self._build_predictor(model_id)

    def load_video(self, video_id: str, fps: float | None = None) -> None:
        """Initialise SAM 2 inference state for a cached video session.

        Args:
            video_id: Session identifier.
            fps: Effective frame rate after extraction. Retained when omitted.

        Raises:
            RuntimeError: If no model is loaded or the frame cache is empty.
        """
        if not SAM2_AVAILABLE or self.predictor is None:
            raise RuntimeError(
                "No SAM 2 model is active. Download and activate one in the Model Hub."
            )

        video_dir = CacheManager.get_video_dir(video_id)
        frames = sorted(video_dir.glob("*.jpg"))
        if not frames:
            raise RuntimeError(
                "No extracted frames were found for this video. Please import it again."
            )

        try:
            with Image.open(frames[0]) as img:
                self.video_width, self.video_height = img.size
        except (OSError, ValueError) as exc:
            logger.warning("Could not read frame dimensions (%s); assuming 1280x720", exc)
            self.video_width, self.video_height = 1280, 720

        self.frame_count = len(frames)
        if fps and fps > 0:
            self.video_fps = fps

        self.interaction_frames = set()
        self.tracked_objects = set()

        # Release the previous state before allocating a new one, or peak VRAM
        # briefly holds two full videos' worth of image features.
        if self.inference_state is not None:
            self.inference_state = None
            MemoryManager.cleanup()

        logger.info(
            "Initialising SAM 2 state for %s (%d frames, %dx%d, %.2f fps)",
            video_id, self.frame_count, self.video_width, self.video_height, self.video_fps,
        )

        with self._amp():
            self.inference_state = self.predictor.init_state(video_path=str(video_dir))
            self.predictor.reset_state(self.inference_state)

        self.video_id = video_id

    def reload_after_export(self) -> None:
        """Restore the tracking model and video state after an export.

        Export unloads SAM 2 so MatAnyone can have the GPU to itself. Without
        this call the engine stayed unloaded: the next canvas click raised
        "No video loaded into AI engine" and the only way back was to reactivate
        a model from the Model Hub — which no user would guess.
        """
        if self.active_model_id is None:
            return
        try:
            if self.predictor is None:
                self._build_predictor(self.active_model_id)
            if self.video_id and self.inference_state is None:
                self.load_video(self.video_id, self.video_fps)
                logger.info("Engine restored after export")
        except Exception as exc:
            logger.exception("Could not restore the engine after export: %s", exc)

    # ── Prompting ─────────────────────────────────────────────────────────

    def add_point_or_box(
        self,
        frame_idx: int,
        obj_id: int,
        points: Sequence[Sequence[float]] | None,
        labels: Sequence[int] | None,
        box: Sequence[float] | None,
    ) -> str | None:
        """Add point or box prompts to a frame and return the predicted overlay.

        Args:
            frame_idx: Timeline index of the frame being annotated.
            obj_id: Mask layer identifier.
            points: Normalised ``[x, y]`` pairs in the range 0..1.
            labels: 1 for include, 0 for exclude. Must match ``points``.
            box: Normalised ``[x1, y1, x2, y2]``.

        Returns:
            Base64 PNG of the colourised overlay, or None when nothing was predicted.

        Raises:
            RuntimeError: If no video is loaded.
            ValueError: If neither points nor a box were supplied, or the
                point and label counts disagree.
        """
        if not self.inference_state:
            raise RuntimeError("No video is loaded into the AI engine.")

        abs_points = abs_labels = abs_box = None

        if points:
            if labels is None or len(labels) != len(points):
                raise ValueError("Each point needs exactly one label.")
            abs_points = np.array(
                [[p[0] * self.video_width, p[1] * self.video_height] for p in points],
                dtype=np.float32,
            )
            abs_labels = np.array(labels, dtype=np.int32)

        if box and len(box) == 4:
            abs_box = np.array(
                [
                    box[0] * self.video_width,
                    box[1] * self.video_height,
                    box[2] * self.video_width,
                    box[3] * self.video_height,
                ],
                dtype=np.float32,
            )

        if abs_points is None and abs_box is None:
            raise ValueError("No valid points or box were provided.")

        self.interaction_frames.add(frame_idx)
        self.tracked_objects.add(obj_id)

        with self._amp():
            _, out_obj_ids, out_mask_logits = self.predictor.add_new_points_or_box(
                inference_state=self.inference_state,
                frame_idx=frame_idx,
                obj_id=obj_id,
                points=abs_points,
                labels=abs_labels,
                box=abs_box,
                clear_old_points=True,
            )

        overlay, _, _ = self._render_masks(out_obj_ids, out_mask_logits)
        return overlay

    def remove_object(self, obj_id: int, frame_idx: int | None = None) -> tuple[str | None, list[int]]:
        """Remove a mask layer and return the refreshed overlay for a frame.

        Args:
            obj_id: Layer to remove.
            frame_idx: Frame whose overlay should be returned.

        Returns:
            ``(overlay_base64_or_None, remaining_object_ids)``. The overlay is
            None when the frame has no masks left, which the caller must
            forward so the canvas clears itself.
        """
        if not self.inference_state or self.predictor is None:
            return None, []

        try:
            remaining_ids, updated_frames = self.predictor.remove_object(
                self.inference_state, obj_id
            )
        except Exception as exc:
            logger.exception("Could not remove object %s: %s", obj_id, exc)
            return None, sorted(self.tracked_objects)

        self.tracked_objects.discard(obj_id)
        logger.info("Removed object %s; %s remaining", obj_id, list(remaining_ids))

        self._delete_object_alpha(obj_id)

        # SAM 2 returns a *list* of (frame_idx, masks) tuples. The original code
        # tested `isinstance(updated_frames, dict)`, which is never true, so this
        # method always returned None and the canvas kept showing the deleted
        # object until the user navigated away.
        if frame_idx is not None:
            for updated_idx, masks in updated_frames or []:
                if updated_idx == frame_idx:
                    overlay, _, _ = self._render_masks(list(remaining_ids), masks)
                    return overlay, list(remaining_ids)

        # Removing the final object clears the whole state and yields an empty
        # list; the caller still needs to be told to wipe the overlay.
        return None, list(remaining_ids)

    def clear_all_prompts(self) -> None:
        """Reset SAM 2 state and delete every generated mask for this video."""
        if self.inference_state is not None and self.predictor is not None:
            self.predictor.reset_state(self.inference_state)
        if self.video_id:
            CacheManager.clear_masks(self.video_id)
        self.interaction_frames.clear()
        self.tracked_objects.clear()
        logger.info("Cleared prompts and masks for %s", self.video_id)

    # ── Mask rendering and persistence ────────────────────────────────────

    def _render_masks(
        self, out_obj_ids: Sequence[int], out_mask_logits: Any
    ) -> tuple[str | None, np.ndarray | None, dict[int, np.ndarray]]:
        """Convert SAM 2 logits into an overlay, a combined matte and per-object mattes.

        Args:
            out_obj_ids: Object ids matching the first axis of the logits.
            out_mask_logits: Tensor of raw logits.

        Returns:
            ``(overlay_base64, combined_alpha, {obj_id: alpha})``. All three are
            empty when there are no objects.
        """
        if out_obj_ids is None or len(out_obj_ids) == 0:
            return None, None, {}

        # One device-to-host transfer for the whole batch. The original code
        # converted object 0 twice: once just to read its shape.
        binary = (out_mask_logits > 0.0).detach().cpu().numpy()
        binary = binary.reshape(len(out_obj_ids), *binary.shape[-2:])

        height, width = binary.shape[-2:]
        rgba = np.zeros((height, width, 4), dtype=np.uint8)
        combined = np.zeros((height, width), dtype=np.uint8)
        per_object: dict[int, np.ndarray] = {}

        for index, obj_id in enumerate(out_obj_ids):
            mask = binary[index]
            colour = PALETTE.get(((int(obj_id) - 1) % 7) + 1, [255, 255, 255, 150])
            rgba[mask] = colour

            alpha = np.zeros((height, width), dtype=np.uint8)
            alpha[mask] = 255
            per_object[int(obj_id)] = alpha
            combined[mask] = 255

        buffer = io.BytesIO()
        Image.fromarray(rgba, "RGBA").save(buffer, format="PNG", optimize=False)
        overlay_b64 = base64.b64encode(buffer.getvalue()).decode("utf-8")

        return overlay_b64, combined, per_object

    def _persist_masks(
        self,
        frame_idx: int,
        overlay_b64: str | None,
        combined: np.ndarray | None,
        per_object: dict[int, np.ndarray],
    ) -> None:
        """Write the overlay and mattes for one frame to the session cache."""
        if not self.video_id or overlay_b64 is None or combined is None:
            return

        mask_dir = CacheManager.get_mask_dir(self.video_id)
        alpha_dir = CacheManager.get_alpha_dir(self.video_id)

        with open(mask_dir / f"{frame_idx:05d}.png", "wb") as handle:
            handle.write(base64.b64decode(overlay_b64))

        cv2.imwrite(str(alpha_dir / f"{frame_idx:05d}.png"), combined)

        for obj_id, alpha in per_object.items():
            obj_dir = alpha_dir / f"obj{obj_id}"
            obj_dir.mkdir(parents=True, exist_ok=True)
            cv2.imwrite(str(obj_dir / f"{frame_idx:05d}.png"), alpha)

    def _delete_object_alpha(self, obj_id: int) -> None:
        """Delete the per-object matte directory for a removed layer."""
        if not self.video_id:
            return
        import shutil

        obj_dir = CacheManager.get_alpha_dir(self.video_id) / f"obj{obj_id}"
        if obj_dir.exists():
            shutil.rmtree(obj_dir, ignore_errors=True)

    def _clear_stale_non_cond_memory(self, start_frame: int) -> None:
        """Drop cached non-conditioning outputs at or after a frame.

        Forces propagation to recompute those frames from the user's updated
        annotations rather than reusing tracking results from before the edit.
        """
        if not self.inference_state:
            return

        cleared = 0
        for obj_state in self.inference_state.get("output_dict_per_obj", {}).values():
            non_cond = obj_state.get("non_cond_frame_outputs", {})
            for frame in [f for f in list(non_cond) if f >= start_frame]:
                del non_cond[frame]
                cleared += 1

        for tracked in self.inference_state.get("frames_tracked_per_obj", {}).values():
            for frame in [f for f in list(tracked) if f >= start_frame]:
                del tracked[frame]

        logger.info("Cleared %d stale memory entries from frame %d", cleared, start_frame)

    # ── Propagation ───────────────────────────────────────────────────────

    async def run_propagation(
        self,
        send_json,
        start_frame: int | None = None,
        reverse: bool = False,
    ) -> None:
        """Propagate masks across the timeline, streaming results to the client.

        The SAM 2 generator is a synchronous, GPU-bound loop. It used to run
        directly on the asyncio event loop with a 1 ms sleep between frames,
        which meant every other WebSocket message — including ``cancel_tracking``
        — waited behind 50-200 ms of GPU work per frame. Here the generator runs
        on a worker thread and results arrive through a bounded queue, so the
        Stop button responds immediately and disk writes stay off the event loop.

        Args:
            send_json: Coroutine accepting one dict, used to reach the client.
            start_frame: Frame to start from. Defaults to the earliest annotation.
            reverse: Track backwards through the timeline instead of forwards.
        """
        if not self.state.is_tracking or not self.inference_state:
            logger.warning("Propagation requested while not tracking or with no state")
            return

        if start_frame is not None and start_frame > 0 and not reverse:
            self._clear_stale_non_cond_memory(start_frame)

        logger.info(
            "Starting propagation from frame %s (%s)",
            start_frame, "backward" if reverse else "forward",
        )

        loop = asyncio.get_running_loop()
        queue: asyncio.Queue = asyncio.Queue(maxsize=32)
        SENTINEL = object()

        def publish(item) -> None:
            """Hand an item to the event loop, blocking when the queue is full."""
            asyncio.run_coroutine_threadsafe(queue.put(item), loop).result()

        def worker() -> None:
            try:
                with self._amp():
                    generator = self.predictor.propagate_in_video(
                        self.inference_state,
                        start_frame_idx=start_frame,
                        reverse=reverse,
                    )
                    for frame_idx, obj_ids, mask_logits in generator:
                        if self.state.cancel_requested:
                            publish(("cancelled", frame_idx))
                            return
                        overlay, combined, per_object = self._render_masks(obj_ids, mask_logits)
                        self._persist_masks(frame_idx, overlay, combined, per_object)
                        publish(("frame", frame_idx, [int(o) for o in obj_ids], overlay))
                publish(("completed", None))
            except BaseException as exc:  # noqa: BLE001 - forwarded to the client
                logger.exception("Propagation failed: %s", exc)
                publish(("error", exc))
            finally:
                asyncio.run_coroutine_threadsafe(queue.put(SENTINEL), loop)

        task = loop.run_in_executor(None, worker)

        try:
            while True:
                item = await queue.get()
                if item is SENTINEL:
                    break

                kind = item[0]
                if kind == "frame":
                    _, frame_idx, obj_ids, overlay = item
                    self.state.current_frame = frame_idx
                    total = max(self.state.total_frames, 1)
                    await send_json({
                        "status": "tracking",
                        "frame": frame_idx,
                        "obj_ids": obj_ids,
                        "progress": min(100, int((frame_idx + 1) / total * 100)),
                        "mask_base64": overlay,
                    })
                elif kind == "cancelled":
                    await send_json({"status": "cancelled", "frame": item[1]})
                elif kind == "completed":
                    await send_json({"status": "completed"})
                elif kind == "error":
                    await send_json({"status": "error", "message": str(item[1])})
        finally:
            await task
            self.state.finish_tracking()
            MemoryManager.cleanup()

    # ── Export ────────────────────────────────────────────────────────────

    @staticmethod
    def _read_matte(path: Path, target_shape: tuple[int, int]) -> np.ndarray | None:
        """Read an alpha matte of any channel layout and fit it to a frame.

        MatAnyone writes single-channel PNGs while SAM 2 overlays are RGBA. The
        original exporter assumed the RGBA layout and called
        ``cv2.cvtColor(m, COLOR_BGR2GRAY)`` on anything else, which raises
        "Source image must have 3 or 4 channels" on a 2-D array. Sizes are also
        normalised here rather than only inside the resolution-change branch,
        so a downscaled matte can never be silently composited against a
        full-size frame.

        Args:
            path: Matte file to read.
            target_shape: ``(height, width)`` of the frame it accompanies.

        Returns:
            An 8-bit single-channel matte, or None when the file is missing.
        """
        if not path.exists():
            return None

        raw = cv2.imread(str(path), cv2.IMREAD_UNCHANGED)
        if raw is None:
            return None

        if raw.ndim == 2:
            matte = raw
        elif raw.shape[2] == 4:
            matte = raw[:, :, 3]
        elif raw.shape[2] == 3:
            matte = cv2.cvtColor(raw, cv2.COLOR_BGR2GRAY)
        else:
            matte = raw[:, :, 0]

        if matte.dtype != np.uint8:
            matte = cv2.normalize(matte, None, 0, 255, cv2.NORM_MINMAX).astype(np.uint8)

        if matte.shape[:2] != target_shape:
            matte = cv2.resize(
                matte, (target_shape[1], target_shape[0]), interpolation=cv2.INTER_LINEAR
            )
        return matte

    def _build_writer(
        self,
        export_format: str,
        export_type: str,
        output_dir: Path,
        stem: str,
        width: int,
        height: int,
        fps: float,
    ):
        """Choose and construct an output writer for the requested format.

        Returns:
            ``(writer, needs_alpha)``.

        Raises:
            ExportWriterError: If the format cannot be produced on this machine.
        """
        wants_alpha = export_type == "transparent"
        ffmpeg = find_ffmpeg()

        if export_format == "png":
            target = output_dir / stem
            return PngSequenceWriter(target, matte_only=(export_type == "alpha")), wants_alpha

        if export_format == "mov":
            if not ffmpeg:
                raise ExportWriterError(
                    "ProRes 4444 (.mov) requires FFmpeg, which was not found. "
                    "Install FFmpeg and add it to PATH, place ffmpeg.exe next to "
                    "RotoFox.exe, or export as PNG Sequence instead."
                )
            return (
                FFmpegWriter(ffmpeg, output_dir / f"{stem}.mov", width, height, fps,
                             with_alpha=wants_alpha, codec="prores"),
                wants_alpha,
            )

        if export_format == "webm":
            if ffmpeg:
                return (
                    FFmpegWriter(ffmpeg, output_dir / f"{stem}.webm", width, height, fps,
                                 with_alpha=wants_alpha, codec="vp9"),
                    wants_alpha,
                )
            if wants_alpha:
                raise ExportWriterError(
                    "Transparent WebM requires FFmpeg, which was not found. "
                    "Export as PNG Sequence instead."
                )
            return OpenCvWriter(output_dir / f"{stem}.webm", width, height, fps, "vp80"), False

        # Default: MP4, which cannot carry alpha in any widely supported codec.
        if wants_alpha:
            raise ExportWriterError(
                "MP4 cannot store transparency. Choose MOV (ProRes 4444), "
                "WebM, or PNG Sequence for a transparent export."
            )
        if ffmpeg:
            return (
                FFmpegWriter(ffmpeg, output_dir / f"{stem}.mp4", width, height, fps,
                             with_alpha=False, codec="h264"),
                False,
            )
        return OpenCvWriter(output_dir / f"{stem}.mp4", width, height, fps, "mp4v"), False

    async def _refine_with_matanyone(self, send_json, video_dir: Path) -> Path | None:
        """Run MatAnyone 2 over every tracked object and merge the results.

        Returns:
            Directory of merged refined mattes, or None when refinement was not
            possible. Failures are reported to the client instead of being
            swallowed: the previous code caught every exception and quietly fell
            back to raw masks, which is why a Hydra initialisation error made
            MatAnyone appear to work while doing nothing at all.
        """
        checkpoint = ModelManager.checkpoint_path("matanyone")
        if not ModelManager.is_downloaded("matanyone"):
            return None
        if not MattingEngine.is_available():
            logger.warning("MatAnyone checkpoint present but its source tree is missing")
            return None

        alpha_dir = CacheManager.get_alpha_dir(self.video_id)
        object_dirs = sorted(
            (p for p in alpha_dir.iterdir() if p.is_dir() and p.name.startswith("obj")),
            key=lambda p: p.name,
        )
        if not object_dirs:
            return None

        frames = sorted(video_dir.glob("*.jpg"))
        if not frames:
            return None

        refined_root = video_dir / "refined"
        merged_dir = refined_root / "merged"
        merged_dir.mkdir(parents=True, exist_ok=True)

        await send_json({
            "status": "export_progress",
            "progress": 0,
            "message": "Loading MatAnyone 2 for edge refinement...",
        })

        # Free the tracking model so both networks never share VRAM.
        self.predictor = None
        self.inference_state = None
        MemoryManager.cleanup()

        try:
            await asyncio.to_thread(self.matting.load, checkpoint)
        except MatAnyoneUnavailable as exc:
            logger.error("MatAnyone 2 unavailable: %s", exc)
            await send_json({
                "status": "export_warning",
                "message": f"Edge refinement skipped: {exc}. Exporting with SAM 2 masks.",
            })
            return None

        loop = asyncio.get_running_loop()

        try:
            per_object_dirs: list[Path] = []

            for position, obj_dir in enumerate(object_dirs, start=1):
                mattes = sorted(obj_dir.glob("*.png"))
                if not mattes:
                    continue

                seed_index = int(mattes[0].stem)
                seed = cv2.imread(str(mattes[0]), cv2.IMREAD_GRAYSCALE)
                if seed is None:
                    continue

                # Refine from the first annotated frame onwards. Seeding frame 0
                # with a mask that belongs to frame 200 produced nonsense.
                sequence = [f for f in frames if int(f.stem) >= seed_index]
                if not sequence:
                    continue

                out_dir = refined_root / obj_dir.name
                label = f"object {position}/{len(object_dirs)}"

                async def report(done: int, total: int, _label=label) -> None:
                    await send_json({
                        "status": "export_progress",
                        "progress": int(done / max(total, 1) * 40),
                        "message": f"Refining edges ({_label}): frame {done}/{total}",
                    })

                # `report` is bound as a default argument so each iteration's
                # callback keeps its own reference rather than the loop variable.
                def on_progress(done: int, total: int, _report=report) -> None:
                    asyncio.run_coroutine_threadsafe(_report(done, total), loop)

                await asyncio.to_thread(
                    self.matting.refine_sequence,
                    frame_paths=sequence,
                    seed_mask=seed,
                    output_dir=out_dir,
                    start_index=seed_index,
                    max_size=MATANYONE_MAX_SIZE,
                    should_cancel=lambda: self.state.cancel_requested,
                    on_progress=on_progress,
                )
                per_object_dirs.append(out_dir)

            if not per_object_dirs:
                return None

            # Merge layers by taking the strongest alpha at each pixel.
            def merge() -> None:
                frame_names = sorted(
                    {p.name for d in per_object_dirs for p in d.glob("*.png")}
                )
                for name in frame_names:
                    accumulator: np.ndarray | None = None
                    for directory in per_object_dirs:
                        candidate = directory / name
                        if not candidate.exists():
                            continue
                        matte = cv2.imread(str(candidate), cv2.IMREAD_GRAYSCALE)
                        if matte is None:
                            continue
                        accumulator = matte if accumulator is None else np.maximum(accumulator, matte)
                    if accumulator is not None:
                        cv2.imwrite(str(merged_dir / name), accumulator)

            await asyncio.to_thread(merge)
            logger.info("MatAnyone refinement complete: %s", merged_dir)
            return merged_dir
        finally:
            self.matting.unload()
            MemoryManager.cleanup()

    async def run_export(self, send_json, settings: dict[str, Any]) -> None:
        """Composite frames and mattes into the requested output format.

        Args:
            send_json: Coroutine accepting one dict, used to reach the client.
            settings: Export options from the UI.
        """
        if not self.video_id:
            await send_json({"status": "export_error", "message": "No video is loaded."})
            return

        export_format = str(settings.get("format", "mp4")).lower()
        export_type = str(settings.get("type", "alpha")).lower()
        bg_color_name = str(settings.get("bg_color", "green")).lower()
        resolution = str(settings.get("resolution", "original")).lower()
        export_path_str = str(settings.get("export_path", "") or "").strip()

        try:
            fps = float(settings.get("fps", "original"))
        except (TypeError, ValueError):
            fps = self.video_fps
        if fps <= 0:
            fps = self.video_fps

        video_dir = CacheManager.get_video_dir(self.video_id)
        frame_paths = sorted(video_dir.glob("*.jpg"))
        total_frames = len(frame_paths)
        if total_frames == 0:
            await send_json({"status": "export_error", "message": "No frames to export."})
            return

        export_w, export_h = self.video_width, self.video_height
        if resolution == "1080p":
            export_w, export_h = 1920, 1080
        elif resolution == "720p":
            export_w, export_h = 1280, 720

        bg_colors = {
            "green": (0, 255, 0),
            "blue": (255, 0, 0),
            "black": (0, 0, 0),
            "white": (255, 255, 255),
        }
        bgr_color = np.array(bg_colors.get(bg_color_name, (0, 255, 0)), dtype=np.uint8)

        export_dir = Path(export_path_str) if export_path_str else Path.home() / "Downloads" / "RotoFox Exports"
        try:
            export_dir.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            await send_json({
                "status": "export_error",
                "message": f"Cannot write to the export folder {export_dir}: {exc}",
            })
            return

        stem = f"rotofox_export_{int(time.time())}"
        writer = None

        try:
            refined_dir = await self._refine_with_matanyone(send_json, video_dir)
            alpha_dir = CacheManager.get_alpha_dir(self.video_id)

            writer, needs_alpha = self._build_writer(
                export_format, export_type, export_dir, stem, export_w, export_h, fps
            )

            report_every = max(1, total_frames // 50)

            for index, frame_path in enumerate(frame_paths):
                if self.state.cancel_requested:
                    await send_json({"status": "export_cancelled"})
                    return

                frame = cv2.imread(str(frame_path), cv2.IMREAD_COLOR)
                if frame is None:
                    frame = np.zeros((self.video_height, self.video_width, 3), dtype=np.uint8)

                name = f"{int(frame_path.stem):05d}.png"
                matte = None
                if refined_dir is not None:
                    matte = self._read_matte(refined_dir / name, frame.shape[:2])
                if matte is None:
                    matte = self._read_matte(alpha_dir / name, frame.shape[:2])
                if matte is None:
                    matte = np.zeros(frame.shape[:2], dtype=np.uint8)

                if (export_h, export_w) != frame.shape[:2]:
                    frame = cv2.resize(frame, (export_w, export_h), interpolation=cv2.INTER_AREA)
                    matte = cv2.resize(matte, (export_w, export_h), interpolation=cv2.INTER_LINEAR)

                out_frame, out_alpha = self._composite(frame, matte, export_type, bgr_color)
                writer.write(out_frame, out_alpha if needs_alpha or export_format == "png" else None)

                if index % report_every == 0 or index == total_frames - 1:
                    await send_json({
                        "status": "export_progress",
                        # Refinement occupies the first 40% of the bar.
                        "progress": 40 + int((index + 1) / total_frames * 60)
                        if refined_dir else int((index + 1) / total_frames * 100),
                        "message": f"Rendering frame {index + 1}/{total_frames}...",
                    })
                    await asyncio.sleep(0)

            writer.close()
            writer = None

            await send_json({
                "status": "export_completed",
                "file_path": str(Path(export_dir / stem).resolve()),
            })
            logger.info("Export complete: %s", export_dir / stem)

        except ExportWriterError as exc:
            logger.error("Export failed: %s", exc)
            await send_json({"status": "export_error", "message": str(exc)})
        except Exception as exc:  # noqa: BLE001 - surfaced to the user
            logger.exception("Export failed: %s", exc)
            await send_json({"status": "export_error", "message": str(exc)})
        finally:
            if writer is not None:
                with contextlib.suppress(Exception):
                    writer.close()
            self.state.finish_export()
            # Bring the tracking model back so the user can keep editing.
            await asyncio.to_thread(self.reload_after_export)
            await send_json({"status": "engine_ready"})

    @staticmethod
    def _composite(
        frame: np.ndarray,
        matte: np.ndarray,
        export_type: str,
        bgr_color: np.ndarray,
    ) -> tuple[np.ndarray, np.ndarray]:
        """Combine a frame and its matte according to the chosen render type.

        Returns:
            ``(bgr_frame, alpha)``. The alpha plane is always returned so
            transparent formats can use it directly.
        """
        if export_type == "alpha":
            # A true luma matte: white where the subject is, black elsewhere.
            return cv2.cvtColor(matte, cv2.COLOR_GRAY2BGR), matte

        if export_type == "transparent":
            return frame, matte

        if export_type == "solid":
            normalised = (matte.astype(np.float32) / 255.0)[:, :, None]
            background = np.empty_like(frame)
            background[:] = bgr_color
            blended = frame.astype(np.float32) * normalised + background.astype(np.float32) * (1.0 - normalised)
            return blended.astype(np.uint8), matte

        # overlay: tint the subject so the mask is visible against the plate
        overlay = frame.copy()
        overlay[matte > 127] = (0, 0, 255)
        return cv2.addWeighted(overlay, 0.5, frame, 0.5, 0), matte
