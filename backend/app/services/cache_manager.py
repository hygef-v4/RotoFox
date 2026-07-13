"""Cache Workspace Management.

This module provides utility classes to handle SSD/HDD caching directories
for raw video frames (JPG format) and computed binary masks (PNG format).
"""

import shutil
from pathlib import Path

# Base directory for all temporary caching operations
CACHE_BASE_DIR: Path = Path(__file__).resolve().parent.parent.parent / "cache_workspace"


class CacheManager:
    """Manages disk caching operations for video frames and segmentation masks."""

    @staticmethod
    def get_video_dir(video_id: str) -> Path:
        """Retrieve and create the cached working directory for a given video ID.

        Args:
            video_id (str): The unique video session identifier.

        Returns:
            Path: The resolved directory path.
        """
        video_dir = CACHE_BASE_DIR / video_id
        video_dir.mkdir(parents=True, exist_ok=True)
        return video_dir

    @staticmethod
    def store_frame(video_id: str, frame_idx: int, frame_data: bytes) -> str:
        """Store raw binary image frame data into cache storage as a JPG.

        Args:
            video_id (str): The unique video session identifier.
            frame_idx (int): The index of the frame.
            frame_data (bytes): The raw binary image payload.

        Returns:
            str: Absolute path to the saved image file.
        """
        video_dir = CacheManager.get_video_dir(video_id)
        frame_filename = f"{frame_idx:05d}.jpg"
        frame_path = video_dir / frame_filename

        with open(frame_path, "wb") as f:
            f.write(frame_data)

        return str(frame_path)

    @staticmethod
    def get_frame_path(video_id: str, frame_idx: int) -> str:
        """Get the cached static path of a specified frame image.

        Args:
            video_id (str): The unique video session identifier.
            frame_idx (int): The index of the frame.

        Returns:
            str: Absolute path string of the frame image.
        """
        video_dir = CACHE_BASE_DIR / video_id
        frame_filename = f"{frame_idx:05d}.jpg"
        return str(video_dir / frame_filename)

    @staticmethod
    def clear_cache(video_id: str) -> None:
        """Remove the caching directory for a specific video ID to release disk space.

        Args:
            video_id (str): The unique video session identifier.
        """
        video_dir = CACHE_BASE_DIR / video_id
        if video_dir.exists():
            shutil.rmtree(video_dir, ignore_errors=True)

    @staticmethod
    def clear_all_cache() -> None:
        """Clear all active and legacy sessions from the caching base directory."""
        if CACHE_BASE_DIR.exists():
            shutil.rmtree(CACHE_BASE_DIR, ignore_errors=True)
        CACHE_BASE_DIR.mkdir(parents=True, exist_ok=True)

