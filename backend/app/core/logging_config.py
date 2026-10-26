"""Logging configuration for RotoFox.

The backend previously used bare ``print()`` calls. In a packaged build the
console window is hidden by the Tauri wrapper, so every one of those messages
was lost — leaving no way to diagnose a user's problem after the fact.

This module writes to a rotating log file inside the per-user data directory
and mirrors output to stderr for development.
"""

from __future__ import annotations

import logging
import logging.handlers
import sys

from app.core.paths import logs_dir

_CONFIGURED = False

LOG_FORMAT = "%(asctime)s %(levelname)-8s [%(name)s] %(message)s"
DATE_FORMAT = "%Y-%m-%d %H:%M:%S"


def setup_logging(level: int = logging.INFO) -> None:
    """Configure root logging with a rotating file handler and a stream handler.

    Safe to call more than once; subsequent calls are ignored.

    Args:
        level: Minimum level to emit.
    """
    global _CONFIGURED
    if _CONFIGURED:
        return

    root = logging.getLogger()
    root.setLevel(level)

    formatter = logging.Formatter(LOG_FORMAT, datefmt=DATE_FORMAT)

    try:
        file_handler = logging.handlers.RotatingFileHandler(
            logs_dir() / "backend.log",
            maxBytes=5 * 1024 * 1024,
            backupCount=3,
            encoding="utf-8",
        )
        file_handler.setFormatter(formatter)
        root.addHandler(file_handler)
    except OSError as exc:  # pragma: no cover - depends on filesystem permissions
        print(f"Warning: could not open log file: {exc}", file=sys.stderr)

    if sys.stderr is not None:
        stream_handler = logging.StreamHandler(sys.stderr)
        stream_handler.setFormatter(formatter)
        root.addHandler(stream_handler)

    # These libraries log one line per request/frame at INFO, which drowns out
    # everything else during propagation.
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)
    logging.getLogger("matplotlib").setLevel(logging.WARNING)
    logging.getLogger("PIL").setLevel(logging.WARNING)

    _CONFIGURED = True


def tail_log(max_lines: int = 200) -> str:
    """Return the last lines of the backend log, for display in the UI.

    Args:
        max_lines: Maximum number of trailing lines to return.

    Returns:
        The log tail, or an explanatory message when it cannot be read.
    """
    path = logs_dir() / "backend.log"
    if not path.exists():
        return "No log file yet."
    try:
        with open(path, encoding="utf-8", errors="replace") as handle:
            return "".join(handle.readlines()[-max_lines:])
    except OSError as exc:
        return f"Could not read log file: {exc}"
