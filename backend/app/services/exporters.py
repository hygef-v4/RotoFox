"""Output writers for RotoFox exports.

The original exporter had a single path: ``cv2.VideoWriter`` with the ``mp4v``
or ``vp80`` fourcc. Neither carries an alpha channel, so the "transparent
ProRes 4444" and "Luma Matte Sequence" outputs promised in the README did not
exist. ``cv2.VideoWriter`` also fails *silently* — when a codec is missing it
returns an unopened writer whose ``write()`` is a no-op, so the app reported a
successful export for a zero-byte file.

This module provides three writers behind one interface:

* :class:`PngSequenceWriter` — numbered PNG frames. No codec, no dependency,
  and the format most editors actually prefer for mattes.
* :class:`FFmpegWriter` — pipes raw frames to FFmpeg. The only path that can
  produce real alpha (ProRes 4444, VP9 with ``yuva420p``).
* :class:`OpenCvWriter` — MP4/WebM without alpha, now with an ``isOpened``
  check so failures surface instead of being reported as success.
"""

from __future__ import annotations

import contextlib
import logging
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Protocol

import cv2
import numpy as np

from app.core.paths import bundle_dir

logger = logging.getLogger(__name__)


class ExportWriterError(RuntimeError):
    """Raised when an output file cannot be created or written."""


def find_ffmpeg() -> str | None:
    """Locate an FFmpeg binary.

    Looks beside the packaged executable first (the portable builder copies one
    there), then on PATH, then falls back to the binary bundled with
    ``imageio-ffmpeg`` if that package is installed.

    Returns:
        Path to an FFmpeg executable, or None when none is available.
    """
    exe_name = "ffmpeg.exe" if sys.platform == "win32" else "ffmpeg"

    local = bundle_dir() / exe_name
    if local.is_file():
        return str(local)

    on_path = shutil.which("ffmpeg")
    if on_path:
        return on_path

    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:  # pragma: no cover - optional dependency
        return None


class FrameWriter(Protocol):
    """Common interface for all export writers."""

    def write(self, frame_bgr: np.ndarray, alpha: np.ndarray | None) -> None:
        """Append one frame. ``alpha`` is an 8-bit matte or None."""

    def close(self) -> None:
        """Finish writing and release resources."""

    @property
    def output_path(self) -> str:
        """Path of the produced file or directory."""


class PngSequenceWriter:
    """Writes a numbered PNG sequence into a directory.

    With ``matte_only`` the alpha channel is written as a grayscale luma matte;
    otherwise frames are written as RGBA with straight (unpremultiplied) alpha.
    """

    def __init__(self, output_dir: Path, matte_only: bool) -> None:
        self._dir = Path(output_dir)
        self._dir.mkdir(parents=True, exist_ok=True)
        self._matte_only = matte_only
        self._index = 0

    def write(self, frame_bgr: np.ndarray, alpha: np.ndarray | None) -> None:
        path = self._dir / f"{self._index:05d}.png"
        if self._matte_only:
            matte = alpha if alpha is not None else np.zeros(frame_bgr.shape[:2], np.uint8)
            cv2.imwrite(str(path), matte)
        else:
            if alpha is None:
                alpha = np.full(frame_bgr.shape[:2], 255, np.uint8)
            bgra = np.dstack([frame_bgr, alpha])
            cv2.imwrite(str(path), bgra)
        self._index += 1

    def close(self) -> None:
        logger.info("Wrote %d PNG frames to %s", self._index, self._dir)

    @property
    def output_path(self) -> str:
        return str(self._dir)


class FFmpegWriter:
    """Pipes raw frames to FFmpeg, enabling codecs OpenCV cannot produce."""

    def __init__(
        self,
        ffmpeg_path: str,
        output_path: Path,
        width: int,
        height: int,
        fps: float,
        with_alpha: bool,
        codec: str = "prores",
    ) -> None:
        self._path = Path(output_path)
        self._with_alpha = with_alpha
        pix_fmt_in = "bgra" if with_alpha else "bgr24"

        command = [
            ffmpeg_path,
            "-y",
            "-hide_banner",
            "-loglevel", "error",
            "-f", "rawvideo",
            "-pix_fmt", pix_fmt_in,
            "-s", f"{width}x{height}",
            "-r", f"{fps:.6f}",
            "-i", "pipe:0",
        ]

        if codec == "prores":
            # profile 4444 is the only ProRes profile carrying an alpha plane.
            command += [
                "-c:v", "prores_ks",
                "-profile:v", "4444",
                "-pix_fmt", "yuva444p10le" if with_alpha else "yuv444p10le",
                "-alpha_bits", "16",
                "-vendor", "apl0",
            ]
        elif codec == "vp9":
            command += [
                "-c:v", "libvpx-vp9",
                "-pix_fmt", "yuva420p" if with_alpha else "yuv420p",
                "-b:v", "0",
                "-crf", "24",
            ]
        else:  # h264, no alpha
            command += [
                "-c:v", "libx264",
                "-pix_fmt", "yuv420p",
                "-crf", "18",
                "-preset", "medium",
            ]

        command.append(str(self._path))

        creation_flags = 0
        if sys.platform == "win32":
            # Keep the console window from flashing up in the packaged app.
            creation_flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)

        logger.info("Starting FFmpeg: %s", " ".join(command))
        try:
            self._process = subprocess.Popen(
                command,
                stdin=subprocess.PIPE,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                creationflags=creation_flags,
            )
        except OSError as exc:
            raise ExportWriterError(f"Could not start FFmpeg: {exc}") from exc

    def write(self, frame_bgr: np.ndarray, alpha: np.ndarray | None) -> None:
        if self._process.poll() is not None:
            stderr = b""
            if self._process.stderr is not None:
                stderr = self._process.stderr.read() or b""
            raise ExportWriterError(
                f"FFmpeg exited early: {stderr.decode('utf-8', 'replace')[:500]}"
            )

        if self._with_alpha:
            if alpha is None:
                alpha = np.full(frame_bgr.shape[:2], 255, np.uint8)
            payload = np.dstack([frame_bgr, alpha])
        else:
            payload = frame_bgr

        try:
            self._process.stdin.write(np.ascontiguousarray(payload).tobytes())
        except (BrokenPipeError, OSError) as exc:
            stderr = b""
            if self._process.stderr is not None:
                stderr = self._process.stderr.read() or b""
            raise ExportWriterError(
                f"FFmpeg stopped accepting frames: {stderr.decode('utf-8', 'replace')[:500] or exc}"
            ) from exc

    def close(self) -> None:
        if self._process.stdin:
            with contextlib.suppress(OSError):
                self._process.stdin.close()
        return_code = self._process.wait(timeout=120)
        stderr = b""
        if self._process.stderr is not None:
            stderr = self._process.stderr.read() or b""
        if return_code != 0:
            raise ExportWriterError(
                f"FFmpeg failed (exit {return_code}): "
                f"{stderr.decode('utf-8', 'replace')[:500]}"
            )
        logger.info("FFmpeg finished writing %s", self._path)

    @property
    def output_path(self) -> str:
        return str(self._path)


class OpenCvWriter:
    """MP4/WebM writer using OpenCV. Cannot carry alpha."""

    def __init__(self, output_path: Path, width: int, height: int, fps: float, fourcc: str) -> None:
        self._path = Path(output_path)
        self._writer = cv2.VideoWriter(
            str(self._path), cv2.VideoWriter_fourcc(*fourcc), fps, (width, height)
        )
        # cv2.VideoWriter never raises: a missing codec yields an unopened
        # writer whose write() silently discards every frame.
        if not self._writer.isOpened():
            raise ExportWriterError(
                f"OpenCV could not open a '{fourcc}' encoder for {self._path.name}. "
                "This codec is not available in your OpenCV build. Try MP4, or "
                "install FFmpeg for more format options."
            )

    def write(self, frame_bgr: np.ndarray, alpha: np.ndarray | None) -> None:
        self._writer.write(frame_bgr)

    def close(self) -> None:
        self._writer.release()

    @property
    def output_path(self) -> str:
        return str(self._path)
