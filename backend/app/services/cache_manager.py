"""Cache Workspace Management.

Manages the on-disk working directories for extracted video frames (JPEG),
colourised mask overlays (RGBA PNG, for the UI) and binary alpha mattes
(grayscale PNG, for export).

Two behaviours changed here relative to the original implementation:

* The cache root now comes from :mod:`app.core.paths`, so a packaged build
  writes to the per-user data directory instead of somewhere inside its own
  installation folder (or a temp directory that Windows later deletes).
* Uploading a new video no longer wipes every previous session. Old sessions
  are pruned least-recently-used, keeping the most recent few so that a user
  who reopens an earlier clip still finds their masks.
"""

from __future__ import annotations

import logging
import shutil
from pathlib import Path

from app.core.paths import cache_dir, safe_id

logger = logging.getLogger(__name__)

# How many previous video sessions to keep on disk.
MAX_CACHED_SESSIONS = 3

# Sub-directory names inside a session directory.
MASK_SUBDIR = "masks"    # RGBA overlay, colourised per object — used by the UI
ALPHA_SUBDIR = "alpha"   # 8-bit binary matte (0 or 255) — used by the exporter


class CacheManager:
    """Disk cache for video frames and segmentation masks."""

    @staticmethod
    def base_dir() -> Path:
        """Return the root directory holding every cached session."""
        return cache_dir()

    @staticmethod
    def get_video_dir(video_id: str) -> Path:
        """Return (creating if needed) the working directory for a video session.

        Args:
            video_id: Session identifier. Validated, since it becomes a path
                component and would otherwise permit directory traversal.

        Returns:
            Path to the session directory.

        Raises:
            ValueError: If ``video_id`` is not a safe identifier.
        """
        video_dir = CacheManager.base_dir() / safe_id(video_id)
        video_dir.mkdir(parents=True, exist_ok=True)
        return video_dir

    @staticmethod
    def get_mask_dir(video_id: str) -> Path:
        """Return the directory holding colourised RGBA mask overlays."""
        path = CacheManager.get_video_dir(video_id) / MASK_SUBDIR
        path.mkdir(parents=True, exist_ok=True)
        return path

    @staticmethod
    def get_alpha_dir(video_id: str) -> Path:
        """Return the directory holding binary alpha mattes used for export."""
        path = CacheManager.get_video_dir(video_id) / ALPHA_SUBDIR
        path.mkdir(parents=True, exist_ok=True)
        return path

    @staticmethod
    def get_frame_path(video_id: str, frame_idx: int) -> Path:
        """Return the path of a cached source frame."""
        return CacheManager.get_video_dir(video_id) / f"{frame_idx:05d}.jpg"

    @staticmethod
    def clear_masks(video_id: str) -> None:
        """Delete every generated mask and matte for a session, keeping frames.

        Used when the user resets their selection; re-extracting frames would be
        wasteful since the source video has not changed.
        """
        for subdir in (MASK_SUBDIR, ALPHA_SUBDIR):
            path = CacheManager.get_video_dir(video_id) / subdir
            if path.exists():
                shutil.rmtree(path, ignore_errors=True)
            path.mkdir(parents=True, exist_ok=True)

    @staticmethod
    def clear_cache(video_id: str) -> None:
        """Delete one session directory entirely."""
        video_dir = CacheManager.base_dir() / safe_id(video_id)
        if video_dir.exists():
            shutil.rmtree(video_dir, ignore_errors=True)

    @staticmethod
    def clear_all_cache() -> None:
        """Delete every cached session. Only used by an explicit user action."""
        base = CacheManager.base_dir()
        if base.exists():
            shutil.rmtree(base, ignore_errors=True)
        base.mkdir(parents=True, exist_ok=True)

    @staticmethod
    def list_sessions() -> list[Path]:
        """Return cached session directories, newest first."""
        base = CacheManager.base_dir()
        if not base.exists():
            return []
        sessions = [p for p in base.iterdir() if p.is_dir()]
        return sorted(sessions, key=lambda p: p.stat().st_mtime, reverse=True)

    @staticmethod
    def prune_sessions(keep: int = MAX_CACHED_SESSIONS, exclude: str | None = None) -> int:
        """Delete the oldest sessions, keeping the most recent ones.

        Args:
            keep: Number of recent sessions to retain.
            exclude: A session that must never be deleted (typically the one
                being created right now).

        Returns:
            Number of session directories removed.
        """
        sessions = CacheManager.list_sessions()
        if exclude:
            sessions = [p for p in sessions if p.name != exclude]

        removed = 0
        for stale in sessions[max(keep, 0):]:
            try:
                shutil.rmtree(stale, ignore_errors=True)
                removed += 1
                logger.info("Pruned stale cache session: %s", stale.name)
            except OSError as exc:  # pragma: no cover - filesystem dependent
                logger.warning("Could not prune %s: %s", stale.name, exc)
        return removed

    @staticmethod
    def total_size_bytes() -> int:
        """Return the total size of the cache, for diagnostics."""
        base = CacheManager.base_dir()
        if not base.exists():
            return 0
        return sum(f.stat().st_size for f in base.rglob("*") if f.is_file())
