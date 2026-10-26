"""Filesystem path resolution for RotoFox.

Single source of truth for every directory the backend writes to. This matters
because the backend runs in two very different modes:

* **Development** — plain ``python main.py`` from the ``backend/`` folder.
  ``__file__`` points at the real source tree, so data lives beside the source.

* **Packaged (PyInstaller)** — ``sys.frozen`` is set and ``__file__`` points
  inside the bundle (``_internal/`` for ``--onedir``, a temp ``_MEIxxxx``
  directory for ``--onefile``). Writing user data there either pollutes the
  install directory or silently loses it when Windows clears the temp folder.
  Worse, an app installed to ``C:\\Program Files`` cannot write there at all
  for a non-elevated user.

Packaged builds therefore keep user data under the per-user application data
directory (``%LOCALAPPDATA%\\RotoFox`` on Windows, ``~/.local/share/RotoFox``
elsewhere), which is always writable and survives upgrades.
"""

from __future__ import annotations

import os
import re
import sys
from pathlib import Path

APP_NAME = "RotoFox"

# video_id values become directory names, so they must never contain path
# separators or traversal sequences. Anything not matching is rejected.
_SAFE_ID_RE = re.compile(r"^[A-Za-z0-9_\-]{1,64}$")


def is_frozen() -> bool:
    """Return True when running from a PyInstaller bundle."""
    return bool(getattr(sys, "frozen", False))


def bundle_dir() -> Path:
    """Directory containing the running executable (packaged) or the backend source root.

    Use this for *read-only* resources that ship with the application, such as
    the checkpoints folder placed next to the .exe by the portable builder.
    """
    if is_frozen():
        return Path(sys.executable).resolve().parent
    # paths.py -> core -> app -> backend
    return Path(__file__).resolve().parents[2]


def app_data_dir() -> Path:
    """Writable per-user directory for caches, logs and configuration.

    If ``ROTOFOX_DATA_DIR`` is set by the desktop shell (pointing at the storage
    folder chosen by the user during setup), that directory is used directly.
    In development this is the backend source root so the existing developer
    workflow (inspecting ``backend/cache_workspace``) keeps working unchanged.
    """
    custom_data_dir = os.getenv("ROTOFOX_DATA_DIR", "").strip()
    if custom_data_dir:
        base = Path(custom_data_dir).expanduser().resolve()
    elif not is_frozen():
        base = bundle_dir()
    elif sys.platform == "win32":
        base = Path(os.getenv("LOCALAPPDATA") or Path.home() / "AppData" / "Local") / APP_NAME
    elif sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support" / APP_NAME
    else:
        base = Path(os.getenv("XDG_DATA_HOME") or Path.home() / ".local" / "share") / APP_NAME

    base.mkdir(parents=True, exist_ok=True)
    return base


def cache_dir() -> Path:
    """Directory holding extracted frames and generated masks."""
    path = app_data_dir() / "cache_workspace"
    path.mkdir(parents=True, exist_ok=True)
    return path


def logs_dir() -> Path:
    """Directory holding rotating backend log files."""
    path = app_data_dir() / "logs"
    path.mkdir(parents=True, exist_ok=True)
    return path


def runtime_dir() -> Path:
    """Directory holding ephemeral runtime state (session token, bound port)."""
    path = app_data_dir() / "runtime"
    path.mkdir(parents=True, exist_ok=True)
    return path


def config_file() -> Path:
    """Path of the user configuration file."""
    return app_data_dir() / "rotofox_config.json"


def default_checkpoints_dir() -> Path:
    """Directory searched for model weights when no custom folder is configured.

    When ``ROTOFOX_DATA_DIR`` is active, weights live inside
    ``<ROTOFOX_DATA_DIR>/checkpoints``. Otherwise packaged builds look next to
    the executable first (for portable builds) and fall back to ``app_data_dir()``.
    """
    if os.getenv("ROTOFOX_DATA_DIR", "").strip():
        custom = app_data_dir() / "checkpoints"
        custom.mkdir(parents=True, exist_ok=True)
        return custom

    candidate = bundle_dir() / "checkpoints"
    try:
        candidate.mkdir(parents=True, exist_ok=True)
        if os.access(candidate, os.W_OK):
            return candidate
    except OSError:
        pass

    fallback = app_data_dir() / "checkpoints"
    fallback.mkdir(parents=True, exist_ok=True)
    return fallback


def safe_id(value: str) -> str:
    """Validate an identifier that will be used as a directory name.

    Args:
        value: Untrusted identifier received from a client.

    Returns:
        The identifier unchanged when it is safe.

    Raises:
        ValueError: If the identifier contains path separators, traversal
            sequences or any character outside ``[A-Za-z0-9_-]``.
    """
    if not isinstance(value, str) or not _SAFE_ID_RE.match(value):
        raise ValueError(f"Unsafe identifier: {value!r}")
    return value


def safe_suffix(filename: str, allowed: frozenset[str]) -> str:
    """Extract a whitelisted file extension from an untrusted filename.

    The original filename is never used to build a path — only its extension,
    and only when that extension is explicitly allowed.

    Args:
        filename: Untrusted filename from a client upload.
        allowed: Lowercase extensions including the leading dot.

    Returns:
        The lowercase extension, or the first allowed extension as a fallback.
    """
    suffix = Path(filename or "").suffix.lower()
    if suffix in allowed:
        return suffix
    return sorted(allowed)[0]
