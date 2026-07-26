"""Tests for frame extraction and FPS decimation."""

from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np
import pytest

from app.services.cache_manager import CacheManager
from app.services.video_processor import VideoProcessor


def make_video(path: Path, frames: int, fps: float, size=(64, 48)) -> Path:
    """Write a short synthetic clip for the extractor to consume."""
    writer = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"mp4v"), fps, size)
    if not writer.isOpened():
        pytest.skip("This OpenCV build cannot write MP4 files")
    for index in range(frames):
        frame = np.full((size[1], size[0], 3), index % 256, dtype=np.uint8)
        writer.write(frame)
    writer.release()
    return path


class TestExtractFrames:
    def test_extracts_every_frame_below_the_fps_limit(self, tmp_path):
        source = make_video(tmp_path / "clip.mp4", frames=20, fps=24)

        count, effective_fps = VideoProcessor.extract_frames(str(source), "video_1", fps_limit=30)

        assert count == 20
        assert effective_fps == pytest.approx(24, abs=0.5)

    def test_decimates_above_the_fps_limit(self, tmp_path):
        source = make_video(tmp_path / "fast.mp4", frames=60, fps=60)

        count, effective_fps = VideoProcessor.extract_frames(str(source), "video_2", fps_limit=30)

        assert count == 30
        assert effective_fps == pytest.approx(30, abs=0.5)

    def test_writes_zero_padded_sequential_filenames(self, tmp_path):
        source = make_video(tmp_path / "names.mp4", frames=12, fps=24)
        VideoProcessor.extract_frames(str(source), "video_3", fps_limit=30)

        files = sorted(p.name for p in CacheManager.get_video_dir("video_3").glob("*.jpg"))
        assert files[0] == "00000.jpg"
        assert files[-1] == "00011.jpg"

    def test_reports_real_progress(self, tmp_path):
        # The UI previously animated its progress bar from Math.random() because
        # the backend published nothing at all.
        source = make_video(tmp_path / "progress.mp4", frames=40, fps=24)
        seen = []

        VideoProcessor.extract_frames(
            str(source), "video_4", fps_limit=30, on_progress=lambda d, t: seen.append((d, t)),
        )

        assert seen, "extract_frames must report progress"
        assert seen[-1][0] == 40
        assert all(done <= total for done, total in seen)

    def test_rejects_an_unopenable_file(self, tmp_path):
        broken = tmp_path / "broken.mp4"
        broken.write_bytes(b"not a video")

        with pytest.raises(RuntimeError):
            VideoProcessor.extract_frames(str(broken), "video_5")


class TestProbe:
    def test_reports_metadata(self, tmp_path):
        source = make_video(tmp_path / "probe.mp4", frames=15, fps=25, size=(80, 60))

        info = VideoProcessor.probe(str(source))

        assert info["width"] == 80
        assert info["height"] == 60
        assert info["fps"] == pytest.approx(25, abs=0.5)
