"""Shared pytest fixtures.

Every test redirects the application data directory into a temporary folder, so
running the suite never touches a developer's real cache, logs or checkpoints.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

BACKEND_ROOT = Path(__file__).resolve().parent.parent
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))


@pytest.fixture(autouse=True)
def isolated_app_data(tmp_path, monkeypatch):
    """Point every path helper at a per-test temporary directory."""
    from app.core import paths

    data_dir = tmp_path / "appdata"
    data_dir.mkdir(parents=True, exist_ok=True)

    monkeypatch.setattr(paths, "app_data_dir", lambda: data_dir)

    def _sub(name):
        target = data_dir / name
        target.mkdir(parents=True, exist_ok=True)
        return target

    monkeypatch.setattr(paths, "cache_dir", lambda: _sub("cache_workspace"))
    monkeypatch.setattr(paths, "logs_dir", lambda: _sub("logs"))
    monkeypatch.setattr(paths, "runtime_dir", lambda: _sub("runtime"))
    monkeypatch.setattr(paths, "default_checkpoints_dir", lambda: _sub("checkpoints"))
    monkeypatch.setattr(paths, "config_file", lambda: data_dir / "rotofox_config.json")

    # Modules that did `from app.core.paths import X` hold their own reference
    # bound at import time, so patching `paths.X` alone would not redirect them.
    from app.core import security
    from app.services import cache_manager

    monkeypatch.setattr(cache_manager, "cache_dir", lambda: _sub("cache_workspace"))
    monkeypatch.setattr(security, "runtime_dir", lambda: _sub("runtime"))

    return data_dir
