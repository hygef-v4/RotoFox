"""Package the RotoFox backend into a standalone sidecar for Tauri.

Builds from ``rotofox-backend.spec`` rather than assembling PyInstaller flags
here. Previously this script maintained its own ``--hidden-import`` list that
had drifted from the spec file and, critically, never passed ``--add-data`` for
``sam2/configs`` — so the packaged backend shipped without the YAML files SAM 2
needs and failed to build a predictor at runtime.

The output is copied to the Tauri sidecar location with the platform target
triple appended, which is the name ``tauri_plugin_shell::sidecar`` resolves.
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import sysconfig
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent
PROJECT_ROOT = BACKEND_DIR.parent
SPEC_FILE = BACKEND_DIR / "rotofox-backend.spec"


def target_triple() -> str:
    """Return the Rust target triple for the current interpreter's platform.

    Tauri looks for ``<name>-<target-triple>[.exe]`` beside the configured
    ``externalBin`` entry.
    """
    platform_name = sysconfig.get_platform()
    machine = "x86_64"
    if "arm64" in platform_name or "aarch64" in platform_name:
        machine = "aarch64"

    if sys.platform == "win32":
        return f"{machine}-pc-windows-msvc"
    if sys.platform == "darwin":
        return f"{machine}-apple-darwin"
    return f"{machine}-unknown-linux-gnu"


def ensure_pyinstaller() -> None:
    """Install PyInstaller into the active environment when it is missing."""
    try:
        import PyInstaller  # noqa: F401
        return
    except ImportError:
        pass

    print("[INFO] PyInstaller is not installed. Installing it now...")
    result = subprocess.run([sys.executable, "-m", "pip", "install", "pyinstaller"], check=False)
    if result.returncode != 0:
        sys.exit("[ERROR] Could not install PyInstaller.")


def package(clean: bool = False) -> None:
    """Run PyInstaller and stage the result for the Tauri bundler."""
    print("=== RotoFox: Backend Packaging ===")

    if not SPEC_FILE.exists():
        sys.exit(f"[ERROR] Spec file not found: {SPEC_FILE}")

    ensure_pyinstaller()

    dist_dir = BACKEND_DIR / "dist"
    build_dir = BACKEND_DIR / "build"

    command = [
        sys.executable, "-m", "PyInstaller",
        "-y",
        f"--distpath={dist_dir}",
        f"--workpath={build_dir}",
        str(SPEC_FILE),
    ]
    if clean:
        command.insert(3, "--clean")

    print(f"[INFO] Running: {' '.join(command)}")
    # cwd matters: the spec resolves paths relative to SPECPATH.
    result = subprocess.run(command, cwd=BACKEND_DIR, check=False)
    if result.returncode != 0:
        sys.exit("[ERROR] PyInstaller build failed.")

    onedir = dist_dir / "rotofox-backend"
    exe_name = "rotofox-backend.exe" if sys.platform == "win32" else "rotofox-backend"
    exe_file = onedir / exe_name

    if not exe_file.exists():
        sys.exit(f"[ERROR] Expected executable not found: {exe_file}")

    print(f"[OK] Packaged backend at: {onedir}")

    tauri_bin_dir = PROJECT_ROOT / "frontend" / "src-tauri" / "binaries"
    tauri_bin_dir.mkdir(parents=True, exist_ok=True)

    sidecar_dir = tauri_bin_dir / "rotofox-backend"
    if sidecar_dir.exists():
        print(f"[INFO] Removing previous sidecar folder: {sidecar_dir}")
        shutil.rmtree(sidecar_dir)
    shutil.copytree(onedir, sidecar_dir)
    print(f"[OK] Copied runtime folder to: {sidecar_dir}")

    triple = target_triple()
    suffix = ".exe" if sys.platform == "win32" else ""
    sidecar_exe = tauri_bin_dir / f"rotofox-backend-{triple}{suffix}"
    shutil.copy2(exe_file, sidecar_exe)
    if sys.platform != "win32":
        sidecar_exe.chmod(0o755)
    print(f"[OK] Staged sidecar entry point: {sidecar_exe.name}")

    print("=== Backend Packaging Complete ===")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Package the RotoFox backend")
    parser.add_argument("--clean", action="store_true", help="Discard PyInstaller caches first")
    package(clean=parser.parse_args().clean)
