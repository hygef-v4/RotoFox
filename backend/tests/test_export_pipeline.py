"""Regression tests for the export pipeline.

Every case here corresponds to a bug that shipped. None of them raised an
exception in production — they produced wrong output silently, which is exactly
the class of defect that needs a test rather than a code review.
"""

from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np
import pytest

from app.services.ai_engine import AIEngine


@pytest.fixture
def matte() -> np.ndarray:
    """A 64x64 binary matte with a solid 32x32 subject in the top-left."""
    data = np.zeros((64, 64), dtype=np.uint8)
    data[:32, :32] = 255
    return data


@pytest.fixture
def frame() -> np.ndarray:
    """A 64x64 mid-grey BGR frame."""
    return np.full((64, 64, 3), 128, dtype=np.uint8)


class TestLumaMatte:
    """The exported luma matte must be fully opaque white, not a grey tint."""

    def test_foreground_is_pure_white(self, frame, matte):
        # The overlay written for the UI uses alpha 150 so the user can see the
        # video through it. Reusing that value for the export produced a matte at
        # 150/255, and a subject that composited at 59% opacity in an NLE.
        out_frame, out_alpha = AIEngine._composite(frame, matte, "alpha", np.array([0, 255, 0]))

        assert out_frame[10, 10].tolist() == [255, 255, 255], (
            "Luma matte foreground must be 255, not the overlay's display alpha"
        )
        assert out_alpha[10, 10] == 255

    def test_background_is_pure_black(self, frame, matte):
        out_frame, _ = AIEngine._composite(frame, matte, "alpha", np.array([0, 255, 0]))
        assert out_frame[50, 50].tolist() == [0, 0, 0]

    def test_matte_is_three_channel(self, frame, matte):
        out_frame, _ = AIEngine._composite(frame, matte, "alpha", np.array([0, 255, 0]))
        assert out_frame.shape == (64, 64, 3)


class TestSolidComposite:
    def test_background_replaced_with_key_colour(self, frame, matte):
        green = np.array([0, 255, 0], dtype=np.uint8)
        out_frame, _ = AIEngine._composite(frame, matte, "solid", green)
        assert out_frame[50, 50].tolist() == [0, 255, 0]

    def test_foreground_preserved(self, frame, matte):
        green = np.array([0, 255, 0], dtype=np.uint8)
        out_frame, _ = AIEngine._composite(frame, matte, "solid", green)
        assert out_frame[10, 10].tolist() == [128, 128, 128]


class TestTransparentComposite:
    def test_alpha_plane_is_the_matte(self, frame, matte):
        out_frame, out_alpha = AIEngine._composite(frame, matte, "transparent", np.array([0, 0, 0]))
        assert np.array_equal(out_alpha, matte)
        assert np.array_equal(out_frame, frame)


class TestReadMatte:
    """`_read_matte` must accept every layout the pipeline can produce."""

    def test_single_channel_png_does_not_raise(self, tmp_path: Path):
        # MatAnyone writes 1-channel PNGs. The old exporter fell through to
        # cv2.cvtColor(m, COLOR_BGR2GRAY), which rejects a 2-D array with
        # "Source image must have 3 or 4 channels" — killing every refined
        # export on its first frame.
        path = tmp_path / "00000.png"
        cv2.imwrite(str(path), np.full((32, 32), 200, np.uint8))

        result = AIEngine._read_matte(path, (32, 32))

        assert result is not None
        assert result.ndim == 2
        assert result[0, 0] == 200

    def test_rgba_png_uses_alpha_channel(self, tmp_path: Path):
        path = tmp_path / "00001.png"
        rgba = np.zeros((32, 32, 4), np.uint8)
        rgba[:, :, 3] = 255
        cv2.imwrite(str(path), rgba)

        result = AIEngine._read_matte(path, (32, 32))

        assert result is not None
        assert result[0, 0] == 255

    def test_bgr_png_converts_to_grayscale(self, tmp_path: Path):
        path = tmp_path / "00002.png"
        cv2.imwrite(str(path), np.full((32, 32, 3), 255, np.uint8))

        result = AIEngine._read_matte(path, (32, 32))

        assert result is not None
        assert result.ndim == 2

    def test_downscaled_matte_is_resized_to_the_frame(self, tmp_path: Path):
        # MatAnyone may run at a reduced resolution. The old exporter only
        # resized inside the "user changed the output resolution" branch, so an
        # export at original resolution mixed a small matte with a large frame.
        path = tmp_path / "00003.png"
        cv2.imwrite(str(path), np.full((32, 32), 255, np.uint8))

        result = AIEngine._read_matte(path, (128, 256))

        assert result.shape == (128, 256)

    def test_missing_file_returns_none(self, tmp_path: Path):
        assert AIEngine._read_matte(tmp_path / "nope.png", (16, 16)) is None
