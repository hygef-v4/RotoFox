"""Video Processing Utilities.

This module provides classes and routines to extract video frames
into cached folders, enforcing frame skip intervals if necessary to meet FPS limits.
"""

import cv2
from typing import Tuple
from app.services.cache_manager import CacheManager


class VideoProcessor:
    """Handles raw video file operations and frame extraction."""

    @staticmethod
    def extract_frames(video_path: str, video_id: str, fps_limit: int = 30) -> Tuple[int, float]:
        """Extract frames from a video file and save them to the cache directory as JPEGs.

        Args:
            video_path (str): The local path to the raw video file.
            video_id (str): The unique video session identifier.
            fps_limit (int, optional): Maximum target FPS limit. Defaults to 30.

        Raises:
            RuntimeError: If OpenCV fails to open the target video file.

        Returns:
            Tuple[int, float]: A tuple containing (frame_count, effective_fps).
        """
        video_dir = CacheManager.get_video_dir(video_id)

        cap = cv2.VideoCapture(video_path)
        if not cap.isOpened():
            raise RuntimeError(f"Failed to open video: {video_path}")

        try:
            source_fps = cap.get(cv2.CAP_PROP_FPS)
            if source_fps <= 0:
                source_fps = 25.0  # Fallback if FPS metadata is missing
            total_source_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

            # Calculate frame skip interval if the source FPS exceeds the target limit
            frame_interval = 1
            if fps_limit and source_fps > fps_limit:
                frame_interval = int(round(source_fps / fps_limit))

            # Determine the effective FPS after frame skip downsampling
            effective_fps = source_fps / frame_interval

            print(f"VideoProcessor: Extracting frames from {video_path}")
            print(f"  Source FPS: {source_fps}, Total source frames: {total_source_frames}")
            if fps_limit:
                print(f"  FPS limit: {fps_limit}, Frame interval: {frame_interval}, Effective FPS: {effective_fps}")

            frame_count = 0
            source_frame_idx = 0

            while True:
                ret, frame = cap.read()
                if not ret:
                    break

                if source_frame_idx % frame_interval == 0:
                    frame_filename = f"{frame_count:05d}.jpg"
                    frame_path = str(video_dir / frame_filename)
                    cv2.imwrite(frame_path, frame, [cv2.IMWRITE_JPEG_QUALITY, 95])
                    frame_count += 1

                source_frame_idx += 1

            print(f"VideoProcessor: Extracted {frame_count} frames to {video_dir} (Effective FPS: {effective_fps})")
            return frame_count, effective_fps
        finally:
            cap.release()
            del cap
            import gc
            gc.collect()

