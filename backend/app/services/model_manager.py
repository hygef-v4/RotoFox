"""Model Management Hub.

Profiles the host hardware, recommends a SAM 2 variant, tracks which
checkpoints are present on disk, and downloads missing weights.

Downloads are written to a temporary ``.part`` file and moved into place only
after the transfer completes and its size has been validated. The previous
implementation streamed straight to the final filename, so an interrupted
download left a truncated file that ``exists()`` happily reported as
"downloaded" — the Model Hub showed *Installed*, the wizard let the user
continue, and activating the model failed later with an opaque
``PytorchStreamReader`` error and no way to retry from the UI.
"""

from __future__ import annotations

import json
import logging
import os
import urllib.error
import urllib.request
from collections.abc import Callable
from pathlib import Path
from typing import Any

import torch
from fastapi.concurrency import run_in_threadpool

from app.core.paths import config_file, default_checkpoints_dir

logger = logging.getLogger(__name__)

# Registry of supported models.
# ``min_bytes`` is a conservative floor used to detect truncated downloads; it
# is deliberately below the true size so a minor upstream re-release does not
# start rejecting valid files.
MODELS: dict[str, dict[str, Any]] = {
    "tiny": {
        "name": "SAM 2.1 Tiny",
        "url": "https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_tiny.pt",
        "checkpoint": "sam2.1_hiera_tiny.pt",
        "config": "configs/sam2.1/sam2.1_hiera_t.yaml",
        "vram_req": 2.0,
        "min_bytes": 140_000_000,
        "approx_mb": 149,
        "speed": "Fastest (~30 FPS)",
        "description": "Recommended for CPU or GPUs with less than 4GB VRAM. Extremely fast but less precise.",
    },
    "small": {
        "name": "SAM 2.1 Small",
        "url": "https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_small.pt",
        "checkpoint": "sam2.1_hiera_small.pt",
        "config": "configs/sam2.1/sam2.1_hiera_s.yaml",
        "vram_req": 4.0,
        "min_bytes": 170_000_000,
        "approx_mb": 176,
        "speed": "Fast (~20 FPS)",
        "description": "Good balance of speed and accuracy. Works well on mid-range GPUs (GTX 1660, RTX 3050).",
    },
    "base": {
        "name": "SAM 2.1 Base+",
        "url": "https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_base_plus.pt",
        "checkpoint": "sam2.1_hiera_base_plus.pt",
        "config": "configs/sam2.1/sam2.1_hiera_b+.yaml",
        "vram_req": 6.0,
        "min_bytes": 300_000_000,
        "approx_mb": 309,
        "speed": "Medium (~15 FPS)",
        "description": "High accuracy tracking. Fits RTX 3060/4060 or any GPU with 6GB-8GB VRAM.",
    },
    "large": {
        "name": "SAM 2.1 Large",
        "url": "https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_large.pt",
        "checkpoint": "sam2.1_hiera_large.pt",
        "config": "configs/sam2.1/sam2.1_hiera_l.yaml",
        "vram_req": 8.0,
        "min_bytes": 850_000_000,
        "approx_mb": 898,
        "speed": "Slowest (~10 FPS)",
        "description": "Maximum accuracy and edge precision. Recommended for high-end GPUs with 8GB+ VRAM.",
    },
    "matanyone": {
        "name": "MatAnyone 2 Edge Refinement",
        "url": "https://github.com/pq-yang/MatAnyone2/releases/download/v1.0.0/matanyone2.pth",
        "checkpoint": "matanyone2.pth",
        "config": "",
        "vram_req": 4.0,
        "min_bytes": 130_000_000,
        "approx_mb": 135,
        "speed": "Refinement Matte",
        "description": "Optional. Refines hair and fine edges during export. Skip it to use raw SAM 2 masks.",
    },
}

# Only these can be activated as the tracking model.
TRACKING_MODEL_IDS = ("large", "base", "small", "tiny")

DOWNLOAD_BLOCK_SIZE = 1024 * 512  # 512 KB


class DownloadCancelled(Exception):
    """Raised when a download is aborted by the user."""


class ModelManager:
    """Model checkpoints, user settings and hardware recommendations."""

    _custom_checkpoints_dir: str | None = None
    _config_loaded: bool = False
    _cancel_requested: bool = False

    # ── Configuration ─────────────────────────────────────────────────────

    @classmethod
    def load_config(cls) -> None:
        """Load user configuration from disk, at most once per process."""
        cls._config_loaded = True
        path = config_file()
        if not path.exists():
            return
        try:
            with open(path, encoding="utf-8") as handle:
                data = json.load(handle)
            value = data.get("checkpoints_dir")
            cls._custom_checkpoints_dir = value.strip() if isinstance(value, str) and value.strip() else None
        except (OSError, json.JSONDecodeError) as exc:
            logger.error("Could not read config %s: %s", path, exc)

    @classmethod
    def save_config(cls, checkpoints_dir: str) -> None:
        """Persist a custom checkpoints directory.

        Args:
            checkpoints_dir: Target folder, or an empty string to reset to the
                default location.

        Raises:
            ValueError: If the path exists but is not a writable directory.
            OSError: If the configuration file cannot be written.
        """
        cleaned = checkpoints_dir.strip() if checkpoints_dir else ""

        if cleaned:
            candidate = Path(cleaned).expanduser()
            try:
                candidate.mkdir(parents=True, exist_ok=True)
            except OSError as exc:
                raise ValueError(f"Cannot create folder {candidate}: {exc}") from exc
            if not os.access(candidate, os.W_OK):
                raise ValueError(f"Folder is not writable: {candidate}")
            cls._custom_checkpoints_dir = str(candidate)
        else:
            cls._custom_checkpoints_dir = None

        cls._config_loaded = True
        with open(config_file(), "w", encoding="utf-8") as handle:
            json.dump({"checkpoints_dir": cls._custom_checkpoints_dir}, handle, indent=4)
        logger.info("Config saved. Custom checkpoints dir: %s", cls._custom_checkpoints_dir)

    @classmethod
    def get_checkpoints_dir(cls) -> Path:
        """Return the directory that holds model weights."""
        if not cls._config_loaded:
            cls.load_config()

        if cls._custom_checkpoints_dir:
            path = Path(cls._custom_checkpoints_dir)
            try:
                path.mkdir(parents=True, exist_ok=True)
                return path
            except OSError as exc:
                logger.error(
                    "Custom checkpoints dir %s is unusable (%s); falling back to default",
                    path, exc,
                )

        return default_checkpoints_dir()

    # ── Checkpoint inspection ─────────────────────────────────────────────

    @classmethod
    def checkpoint_path(cls, model_id: str) -> Path:
        """Return the on-disk path where a model's weights live."""
        return cls.get_checkpoints_dir() / MODELS[model_id]["checkpoint"]

    @classmethod
    def is_downloaded(cls, model_id: str) -> bool:
        """Check whether a complete, non-truncated checkpoint is present.

        A file smaller than the model's ``min_bytes`` is treated as absent — it
        is almost certainly the remains of an interrupted download.
        """
        info = MODELS.get(model_id)
        if info is None:
            return False
        path = cls.get_checkpoints_dir() / info["checkpoint"]
        try:
            return path.is_file() and path.stat().st_size >= info["min_bytes"]
        except OSError:
            return False

    @classmethod
    def get_system_info(cls) -> dict[str, Any]:
        """Profile the host and describe the state of every known model."""
        gpu_available = torch.cuda.is_available()
        gpu_name = "CPU"
        total_vram_gb: float | None = None

        if gpu_available:
            try:
                gpu_name = torch.cuda.get_device_name(0)
                total_vram_gb = round(
                    torch.cuda.get_device_properties(0).total_memory / (1024 ** 3), 1
                )
            except (RuntimeError, AssertionError) as exc:
                logger.warning("Could not query CUDA device: %s", exc)
                gpu_available = False

        system_ram_gb: float | None = None
        try:
            import psutil

            system_ram_gb = round(psutil.virtual_memory().total / (1024 ** 3), 1)
        except ImportError:
            logger.warning("psutil is not installed; system RAM will not be reported")
        except Exception as exc:  # pragma: no cover - platform dependent
            logger.warning("Could not read system memory: %s", exc)

        recommended_model = "tiny"
        if gpu_available and total_vram_gb is not None:
            if total_vram_gb >= 8.0:
                recommended_model = "large"
            elif total_vram_gb >= 6.0:
                recommended_model = "base"
            elif total_vram_gb >= 4.0:
                recommended_model = "small"

        checkpoints_dir = cls.get_checkpoints_dir()

        model_list: list[dict[str, Any]] = []
        for model_id, info in MODELS.items():
            path = checkpoints_dir / info["checkpoint"]
            downloaded = cls.is_downloaded(model_id)
            size_mb = 0.0
            partial = False
            try:
                if path.is_file():
                    size_mb = round(path.stat().st_size / (1024 ** 2), 1)
                    partial = not downloaded
            except OSError:
                pass

            model_list.append({
                "id": model_id,
                "name": info["name"],
                "downloaded": downloaded,
                "partial": partial,
                "size_mb": size_mb,
                "approx_mb": info["approx_mb"],
                "vram_req": info["vram_req"],
                "speed": info["speed"],
                "description": info["description"],
                "recommended": model_id == recommended_model,
                "role": "refinement" if model_id == "matanyone" else "tracking",
            })

        return {
            "gpu_available": gpu_available,
            "gpu_name": gpu_name,
            "total_vram_gb": total_vram_gb,
            "system_ram_gb": system_ram_gb,
            "recommended_model": recommended_model,
            "checkpoints_dir": str(checkpoints_dir.resolve()),
            "is_custom_dir": cls._custom_checkpoints_dir is not None,
            "models": model_list,
        }

    # ── Downloading ───────────────────────────────────────────────────────

    @classmethod
    def cancel_download(cls) -> None:
        """Ask the in-flight download to abort at the next chunk boundary."""
        cls._cancel_requested = True

    @classmethod
    async def download_model_async(
        cls,
        model_id: str,
        on_progress_callback: Callable[[int, int, int], Any],
    ) -> None:
        """Download a checkpoint, reporting throttled progress.

        The file is streamed to ``<name>.part`` and renamed into place only
        after the full transfer is verified, so a failure can never leave a
        truncated file that looks installed.

        Progress is reported when the percentage changes rather than on every
        chunk. The original code fired a WebSocket message per 256 KB, which is
        roughly 3,600 messages for the Large checkpoint.

        Args:
            model_id: Key into :data:`MODELS`.
            on_progress_callback: Awaitable ``(percent, downloaded, total)``.

        Raises:
            ValueError: If the model is unknown.
            DownloadCancelled: If the user aborted the download.
            RuntimeError: If the transfer completes but the file is too small.
        """
        if model_id not in MODELS:
            raise ValueError(f"Unknown model: {model_id}")

        info = MODELS[model_id]
        dest_path = cls.get_checkpoints_dir() / info["checkpoint"]
        part_path = dest_path.with_suffix(dest_path.suffix + ".part")
        cls._cancel_requested = False

        def open_connection():
            request = urllib.request.Request(
                info["url"], headers={"User-Agent": "RotoFoxModelHub/1.0"}
            )
            return urllib.request.urlopen(request, timeout=30)

        try:
            connection = await run_in_threadpool(open_connection)
        except (urllib.error.URLError, OSError) as exc:
            raise RuntimeError(
                f"Could not reach the download server for {info['name']}: {exc}"
            ) from exc

        downloaded = 0
        last_percent = -1

        try:
            try:
                total_size = int(connection.info().get("Content-Length", 0))
            except (TypeError, ValueError):
                total_size = 0

            with open(part_path, "wb") as handle:
                while True:
                    if cls._cancel_requested:
                        raise DownloadCancelled(f"Download of {info['name']} cancelled.")

                    chunk = await run_in_threadpool(connection.read, DOWNLOAD_BLOCK_SIZE)
                    if not chunk:
                        break

                    await run_in_threadpool(handle.write, chunk)
                    downloaded += len(chunk)

                    if total_size > 0:
                        percent = int(downloaded * 100 / total_size)
                        if percent != last_percent:
                            last_percent = percent
                            await on_progress_callback(percent, downloaded, total_size)

            if downloaded < info["min_bytes"]:
                raise RuntimeError(
                    f"Download of {info['name']} finished but the file is only "
                    f"{downloaded / 1024 ** 2:.1f} MB, which is too small to be valid. "
                    "The connection was probably interrupted. Please try again."
                )

            # Atomic on the same filesystem: either the old file or the new one.
            os.replace(part_path, dest_path)
            logger.info(
                "Downloaded %s (%.1f MB) to %s",
                model_id, downloaded / 1024 ** 2, dest_path,
            )
        except BaseException:
            part_path.unlink(missing_ok=True)
            raise
        finally:
            cls._cancel_requested = False
            connection.close()
