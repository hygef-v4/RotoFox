"""MatAnyone 2 edge refinement, driven directly instead of through its CLI.

The previous implementation imported ``inference_matanyone2.main()`` from the
vendored MatAnyone repository. That entry point is a demo script, and using it
as a library caused four separate failures:

1. **It re-downloaded the model on every export.** Its first statement is
   ``ckpt_path = load_file_from_url(...)``, which unconditionally overwrites
   the checkpoint path passed in. RotoFox's own Model Hub download was ignored
   and the app phoned home to GitHub — breaking the "works fully offline"
   guarantee, and failing outright with no network.

2. **It could never load its model in this process.** ``get_matanyone2_model``
   calls ``hydra.initialize()`` as a plain function, and ``sam2/__init__.py``
   has already initialised Hydra's global singleton at import time. Hydra
   raises ``ValueError: GlobalHydra is already initialized``. Because the
   caller wrapped the whole refinement block in a broad ``except Exception``,
   this was swallowed and silently downgraded to "use raw SAM 2 masks" — so
   MatAnyone had in practice never run at all. This module saves, clears and
   restores the Hydra singleton around the config load.

3. **It loaded the entire clip into RAM.** ``read_frame_from_videos`` decodes
   every frame into one float tensor: roughly 74 GB for 3,000 frames of 1080p.
   This module streams frames one at a time.

4. **It flattened every object into one blob.** The colourised RGBA overlay was
   converted to luminance and then binarised, merging all seven mask layers.
   This module refines each object separately from its own binary matte.
"""

from __future__ import annotations

import contextlib
import logging
import sys
from collections.abc import Callable, Iterator
from pathlib import Path

import cv2
import numpy as np
import torch

logger = logging.getLogger(__name__)

# Frames of "warm-up" fed to the network before the first real frame, so its
# recurrent memory stabilises. Matches the MatAnyone reference implementation.
DEFAULT_WARMUP = 10
DEFAULT_ERODE = 10
DEFAULT_DILATE = 10

ProgressCallback = Callable[[int, int], None]


class MatAnyoneUnavailable(RuntimeError):
    """Raised when MatAnyone 2 cannot be imported or its weights are missing."""


def _matanyone_root() -> Path:
    """Locate the vendored MatAnyone 2 source tree."""
    # matting_engine.py -> services -> app -> backend
    backend_root = Path(__file__).resolve().parents[2]
    return backend_root / "third_party" / "MatAnyone2"


@contextlib.contextmanager
def _isolated_hydra(config_dir: Path, job_name: str) -> Iterator[None]:
    """Compose a Hydra config without disturbing SAM 2's global Hydra state.

    SAM 2 registers its config module in Hydra's process-wide singleton when it
    is imported. MatAnyone needs a different config search path, and Hydra
    refuses to initialise twice. This context manager parks SAM 2's
    registration, runs the body with MatAnyone's config directory, then puts
    SAM 2's registration back exactly as it was.
    """
    from hydra import initialize_config_dir, initialize_config_module
    from hydra.core.global_hydra import GlobalHydra

    was_initialized = GlobalHydra.instance().is_initialized()
    if was_initialized:
        GlobalHydra.instance().clear()

    try:
        with initialize_config_dir(
            version_base="1.3.2", config_dir=str(config_dir), job_name=job_name
        ):
            yield
    finally:
        if GlobalHydra.instance().is_initialized():
            GlobalHydra.instance().clear()
        if was_initialized:
            try:
                initialize_config_module("sam2", version_base="1.2")
            except Exception as exc:  # pragma: no cover - defensive
                logger.error("Could not restore SAM 2 Hydra config module: %s", exc)


class MattingEngine:
    """Loads MatAnyone 2 on demand and refines binary masks into alpha mattes."""

    def __init__(self, device: torch.device) -> None:
        self.device = device
        self._model = None
        self._cfg = None

    # ── Model lifecycle ───────────────────────────────────────────────────

    @staticmethod
    def is_available() -> bool:
        """Check whether the vendored MatAnyone 2 source tree is present."""
        return (_matanyone_root() / "matanyone2").is_dir()

    def load(self, checkpoint_path: Path) -> None:
        """Load MatAnyone 2 weights onto the configured device.

        Args:
            checkpoint_path: Path to ``matanyone2.pth``.

        Raises:
            MatAnyoneUnavailable: If the source tree or the weights are missing,
                or the model cannot be constructed.
        """
        if self._model is not None:
            return

        root = _matanyone_root()
        if not root.is_dir():
            raise MatAnyoneUnavailable(f"MatAnyone 2 source not found at {root}")
        if not Path(checkpoint_path).is_file():
            raise MatAnyoneUnavailable(f"MatAnyone 2 checkpoint not found: {checkpoint_path}")

        if str(root) not in sys.path:
            sys.path.insert(0, str(root))

        try:
            from hydra import compose
            from matanyone2.model.matanyone2 import MatAnyone2
            from omegaconf import open_dict

            config_dir = root / "matanyone2" / "config"
            with _isolated_hydra(config_dir, "rotofox_matanyone"):
                cfg = compose(config_name="eval_matanyone_config")
                with open_dict(cfg):
                    cfg["weights"] = str(checkpoint_path)

            model = MatAnyone2(cfg, single_object=True).to(self.device).eval()
            weights = torch.load(str(checkpoint_path), map_location=self.device)
            model.load_weights(weights)

            self._model = model
            self._cfg = cfg
            logger.info("MatAnyone 2 loaded on %s", self.device)
        except MatAnyoneUnavailable:
            raise
        except Exception as exc:
            raise MatAnyoneUnavailable(f"Failed to load MatAnyone 2: {exc}") from exc

    def unload(self) -> None:
        """Release the model and its VRAM."""
        self._model = None
        self._cfg = None
        if torch.cuda.is_available():
            torch.cuda.empty_cache()

    # ── Refinement ────────────────────────────────────────────────────────

    @torch.inference_mode()
    def refine_sequence(
        self,
        frame_paths: list[Path],
        seed_mask: np.ndarray,
        output_dir: Path,
        start_index: int,
        max_size: int = -1,
        n_warmup: int = DEFAULT_WARMUP,
        erode: int = DEFAULT_ERODE,
        dilate: int = DEFAULT_DILATE,
        should_cancel: Callable[[], bool] | None = None,
        on_progress: ProgressCallback | None = None,
    ) -> int:
        """Refine one object across a run of frames, writing 8-bit alpha PNGs.

        Args:
            frame_paths: Source frames in timeline order. ``frame_paths[0]`` is
                the frame the ``seed_mask`` belongs to.
            seed_mask: Binary mask (0 or 255, ``uint8``) for the first frame.
            output_dir: Directory that receives ``{start_index + i:05d}.png``.
            start_index: Timeline index of ``frame_paths[0]``, used for naming
                so the exporter can match mattes to frames directly.
            max_size: When positive, downscale so the shorter side equals this
                value during inference. Output is always written back at the
                source resolution. ``-1`` disables downscaling.
            n_warmup: Warm-up repetitions of the first frame.
            erode: Erosion kernel applied to the seed mask.
            dilate: Dilation kernel applied to the seed mask.
            should_cancel: Polled once per frame; refinement stops when it
                returns True.
            on_progress: ``(frames_done, frames_total)`` callback.

        Returns:
            Number of alpha frames written.

        Raises:
            MatAnyoneUnavailable: If :meth:`load` has not been called.
            ValueError: If ``frame_paths`` is empty or the first frame is unreadable.
        """
        if self._model is None:
            raise MatAnyoneUnavailable("MatAnyone 2 is not loaded.")
        if not frame_paths:
            raise ValueError("refine_sequence requires at least one frame.")

        import torch.nn.functional as F
        from matanyone2.inference.inference_core import InferenceCore
        from matanyone2.utils.inference_utils import gen_dilate, gen_erosion

        processor = InferenceCore(self._model, cfg=self._cfg)

        output_dir.mkdir(parents=True, exist_ok=True)

        first = cv2.imread(str(frame_paths[0]), cv2.IMREAD_COLOR)
        if first is None:
            raise ValueError(f"Could not read frame {frame_paths[0]}")
        src_h, src_w = first.shape[:2]

        # Inference resolution
        proc_h, proc_w = src_h, src_w
        if max_size > 0:
            shorter = min(src_h, src_w)
            if shorter > max_size:
                proc_h = int(src_h / shorter * max_size)
                proc_w = int(src_w / shorter * max_size)
                logger.info(
                    "MatAnyone processing at %dx%d (source %dx%d)",
                    proc_w, proc_h, src_w, src_h,
                )

        # Prepare the seed mask. gen_dilate/gen_erosion binarise internally, so
        # feeding them a clean 0/255 mask keeps object identity unambiguous.
        mask = seed_mask.astype(np.uint8)
        if mask.shape[:2] != (src_h, src_w):
            mask = cv2.resize(mask, (src_w, src_h), interpolation=cv2.INTER_NEAREST)
        if dilate > 0:
            mask = gen_dilate(mask, dilate, dilate)
        if erode > 0:
            mask = gen_erosion(mask, erode, erode)

        mask_t = torch.from_numpy(np.asarray(mask, dtype=np.float32)).to(self.device)
        if (proc_h, proc_w) != (src_h, src_w):
            mask_t = F.interpolate(
                mask_t.unsqueeze(0).unsqueeze(0), size=(proc_h, proc_w), mode="nearest"
            )[0, 0]

        total = len(frame_paths)
        written = 0

        def load_frame(index: int) -> torch.Tensor:
            """Read one BGR frame and return it as a normalised RGB CHW tensor."""
            bgr = cv2.imread(str(frame_paths[index]), cv2.IMREAD_COLOR)
            if bgr is None:
                raise ValueError(f"Could not read frame {frame_paths[index]}")
            rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
            tensor = torch.from_numpy(rgb).permute(2, 0, 1).float()
            if (proc_h, proc_w) != (src_h, src_w):
                tensor = F.interpolate(
                    tensor.unsqueeze(0), size=(proc_h, proc_w), mode="area"
                )[0]
            return (tensor / 255.0).to(self.device)

        first_tensor = load_frame(0)

        for step in range(n_warmup + total):
            if should_cancel is not None and should_cancel():
                logger.info("MatAnyone refinement cancelled at step %d", step)
                break

            is_warmup = step < n_warmup
            image = first_tensor if is_warmup else load_frame(step - n_warmup)

            if step == 0:
                processor.step(image, mask_t, objects=[1])
                output_prob = processor.step(image, first_frame_pred=True)
            elif step <= n_warmup:
                output_prob = processor.step(image, first_frame_pred=True)
            else:
                output_prob = processor.step(image)

            if is_warmup:
                continue

            pha = processor.output_prob_to_mask(output_prob)
            pha_np = pha.detach().float().cpu().numpy()
            pha_u8 = np.clip(np.round(pha_np * 255.0), 0, 255).astype(np.uint8)

            # Always restore the source resolution so the exporter never has to
            # guess whether a matte was downscaled.
            if pha_u8.shape[:2] != (src_h, src_w):
                pha_u8 = cv2.resize(pha_u8, (src_w, src_h), interpolation=cv2.INTER_LINEAR)

            frame_index = start_index + (step - n_warmup)
            cv2.imwrite(str(output_dir / f"{frame_index:05d}.png"), pha_u8)
            written += 1

            if on_progress is not None and (written % 10 == 0 or written == total):
                on_progress(written, total)

        return written
