"""Memory and VRAM Management.

Garbage collection and CUDA cache purging, used between heavy model swaps to
avoid out-of-memory errors when two networks would otherwise share the GPU.
"""

from __future__ import annotations

import gc
import logging

import torch

logger = logging.getLogger(__name__)


class MemoryManager:
    """System memory and GPU VRAM housekeeping."""

    @staticmethod
    def cleanup() -> None:
        """Collect garbage and release cached CUDA allocations."""
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            torch.cuda.synchronize()
        logger.debug("Memory cleanup complete")

    @staticmethod
    def vram_usage_gb() -> float | None:
        """Return currently reserved VRAM in GB, or None when running on CPU."""
        if not torch.cuda.is_available():
            return None
        try:
            return round(torch.cuda.memory_reserved() / (1024 ** 3), 2)
        except RuntimeError:  # pragma: no cover - driver dependent
            return None
