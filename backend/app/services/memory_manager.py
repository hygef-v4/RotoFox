"""Memory and VRAM Management.

This module provides garbage collection and CUDA cache clearing utilities
to prevent resource exhaustion during complex segmentation tasks.
"""

import gc
import torch


class MemoryManager:
    """Manages system memory garbage collection and GPU VRAM purging."""

    @staticmethod
    def cleanup() -> None:
        """Collect garbage in system RAM and purge unused CUDA memory allocations."""
        print("MemoryManager: Running garbage collection...")
        gc.collect()

        if torch.cuda.is_available():
            print("MemoryManager: Emptying CUDA cache...")
            torch.cuda.empty_cache()

        print("MemoryManager: Cleanup finished. AI Engine is idle and ready.")

