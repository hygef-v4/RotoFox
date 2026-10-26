# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller specification for the RotoFox backend sidecar.

Paths are resolved relative to this file. The previous version hard-coded
``F:\\code\\git\\Smart Mask Local\\...``, so nobody but its author could build
the project.

This is now the single source of truth for packaging. ``scripts/package_backend.py``
invokes this spec instead of maintaining a second, divergent list of
``--hidden-import`` flags on the command line — a list which, notably, omitted
the SAM 2 config YAMLs, producing a bundle that could not construct a predictor.
"""

import os
from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files, collect_submodules

BACKEND_DIR = Path(os.path.abspath(SPECPATH))
SAM2_SRC = BACKEND_DIR / "sam2_src"
MATANYONE_SRC = BACKEND_DIR / "third_party" / "MatAnyone2"

datas = []
hiddenimports = [
    # uvicorn resolves these dynamically, so static analysis misses them
    "uvicorn.logging",
    "uvicorn.loops",
    "uvicorn.loops.auto",
    "uvicorn.protocols",
    "uvicorn.protocols.http",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.websockets",
    "uvicorn.protocols.websockets.auto",
    "uvicorn.lifespan",
    "uvicorn.lifespan.on",
    "websockets.legacy",
    "websockets.legacy.server",
    # FastAPI needs this to parse the video upload
    "multipart",
    "python_multipart",
    # Hydra/OmegaConf drive both SAM 2 and MatAnyone configuration
    "hydra",
    "hydra._internal.core_plugins",
    "omegaconf",
    "iopath",
    "psutil",
    "PIL",
]

# ── SAM 2 ─────────────────────────────────────────────────────────────────
pathex = []
if SAM2_SRC.is_dir():
    pathex.append(str(SAM2_SRC))
    # The YAML configs must ship, or build_sam2_video_predictor cannot resolve
    # its model definition at runtime.
    datas.append((str(SAM2_SRC / "sam2" / "configs"), os.path.join("sam2", "configs")))
    hiddenimports += collect_submodules("sam2")

# ── MatAnyone 2 ───────────────────────────────────────────────────────────
if MATANYONE_SRC.is_dir():
    pathex.append(str(MATANYONE_SRC))
    datas.append((
        str(MATANYONE_SRC / "matanyone2" / "config"),
        os.path.join("matanyone2", "config"),
    ))
    try:
        hiddenimports += collect_submodules("matanyone2")
    except Exception:
        # Not importable from this environment; the sources still ship via pathex.
        pass

datas += collect_data_files("hydra", includes=["**/*.yaml"])
try:
    datas += collect_data_files("imageio_ffmpeg")
    hiddenimports.append("imageio_ffmpeg")
except Exception:
    pass

a = Analysis(
    [str(BACKEND_DIR / "main.py")],
    pathex=pathex,
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        # Large, unused, and slow to bundle.
        "matplotlib",
        "tkinter",
        "IPython",
        "notebook",
        "pytest",
        "PySide6",
        "shiboken6",
        "gradio",
        "tensorboard",
        "pandas",
    ],
    noarchive=False,
    optimize=0,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="rotofox-backend",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    # UPX corrupts some CUDA and MKL DLLs, producing a binary that fails to load
    # with no useful diagnostic.
    upx=False,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="rotofox-backend",
)
