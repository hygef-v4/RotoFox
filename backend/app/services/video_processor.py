"""Video Processing Utilities.

Decodes a source video into a directory of JPEG frames for SAM 2, optionally
downsampling the frame rate to keep memory use bounded.

Extraction reports real progress through an optional callback. The frontend
previously animated a progress bar from random numbers because the backend
offered nothing to display; that guess was wildly wrong for both very short
and very long clips.
"""

from __future__ import annotations

import gc
import logging
from collections.abc import Callable

import cv2

from app.services.cache_manager import CacheManager

logger = logging.getLogger(__name__)

# 95 is visually lossless but ~35% larger and slower to write than 90. SAM 2
# rescales its input to 1024px anyway, so the extra fidelity is not used.
JPEG_QUALITY = 90

ProgressCallback = Callable[[int, int], None]


class VideoProcessor:
    """Raw video file operations and frame extraction."""

    @staticmethod
    def probe(video_path: str) -> dict:
        """Read basic metadata without decoding the whole file.

        Args:
            video_path: Path to the source video.

        Returns:
            Dict with ``fps``, ``frame_count``, ``width`` and ``height``.

        Raises:
            RuntimeError: If OpenCV cannot open the file.
        """
        cap = cv2.VideoCapture(video_path)
        if not cap.isOpened():
            raise RuntimeError(f"Failed to open video: {video_path}")
        try:
            fps = cap.get(cv2.CAP_PROP_FPS)
            return {
                "fps": fps if fps and fps > 0 else 25.0,
                "frame_count": int(cap.get(cv2.CAP_PROP_FRAME_COUNT)),
                "width": int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)),
                "height": int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)),
            }
        finally:
            cap.release()

    @staticmethod
    def extract_frames(
        video_path: str,
        video_id: str,
        fps_limit: int = 30,
        on_progress: ProgressCallback | None = None,
    ) -> tuple[int, float]:
        """Extract frames to the session cache as JPEGs.

        Args:
            video_path: Path to the source video file.
            video_id: Session identifier.
            fps_limit: Target maximum frame rate; higher-rate sources are
                decimated by an integer stride. Pass 0 to disable.
            on_progress: Optional ``(frames_written, frames_expected)`` callback,
                invoked roughly 100 times over the whole extraction. Called from
                this worker thread, so implementations must be thread-safe.

        Returns:
            ``(frame_count, effective_fps)``.

        Raises:
            RuntimeError: If OpenCV cannot open the video or it contains no
                decodable frames.
        """
        video_dir = CacheManager.get_video_dir(video_id)

        cap = cv2.VideoCapture(video_path)
        if not cap.isOpened():
            raise RuntimeError(f"Failed to open video: {video_path}")

        try:
            source_fps = cap.get(cv2.CAP_PROP_FPS)
            if not source_fps or source_fps <= 0:
                source_fps = 25.0
                logger.warning("Video reports no FPS metadata; assuming 25.0")

            total_source_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

            frame_interval = 1
            if fps_limit and source_fps > fps_limit:
                frame_interval = max(1, int(round(source_fps / fps_limit)))
            effective_fps = source_fps / frame_interval

            expected = (
                max(1, total_source_frames // frame_interval)
                if total_source_frames > 0
                else 0
            )

            logger.info(
                "Extracting frames from %s (source %.2f fps, %d frames, "
                "stride %d, effective %.2f fps)",
                video_path, source_fps, total_source_frames, frame_interval, effective_fps,
            )

            encode_params = [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY]
            frame_count = 0
            source_frame_idx = 0
            # Report at most ~100 times regardless of clip length.
            report_every = max(1, expected // 100) if expected else 30

            while True:
                ret, frame = cap.read()
                if not ret:
                    break

                if source_frame_idx % frame_interval == 0:
                    frame_path = video_dir / f"{frame_count:05d}.jpg"
                    cv2.imwrite(str(frame_path), frame, encode_params)
                    frame_count += 1

                    if on_progress and frame_count % report_every == 0:
                        on_progress(frame_count, expected or frame_count)

                source_frame_idx += 1

            if frame_count == 0:
                raise RuntimeError(
                    "No frames could be decoded from this video. The file may be "
                    "corrupt or use a codec OpenCV does not support."
                )

            if on_progress:
                on_progress(frame_count, frame_count)

            logger.info(
                "Extracted %d frames to %s (effective %.2f fps)",
                frame_count, video_dir, effective_fps,
            )
            return frame_count, effective_fps
        finally:
            cap.release()
            del cap
            gc.collect()
