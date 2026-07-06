import os
import subprocess
import sys
import shutil
from pathlib import Path


def package():
    print("=== RotoFox: Backend Packaging ===")

    # Check if pyinstaller is installed
    try:
        import PyInstaller
    except ImportError:
        print("[INFO] PyInstaller is not installed. Installing it now...")
        subprocess.run([sys.executable, "-m", "pip", "install", "pyinstaller"])

    base_dir = Path(__file__).parent.parent
    main_py = base_dir / "main.py"

    if not main_py.exists():
        print(f"[ERROR] main.py not found at {main_py}")
        sys.exit(1)

    # Output directories
    dist_dir = base_dir / "dist"
    build_dir = base_dir / "build"

    # --onedir: produces a folder (dist/rotofox-backend/) instead of a single huge .exe
    # This avoids NSIS 32-bit mmap limit (~2GB) caused by bundling PyTorch+CUDA
    cmd = [
        sys.executable,
        "-m",
        "PyInstaller",
        "--onedir",                      # folder mode — avoids 2GB NSIS limit
        "--name=rotofox-backend",
        # uvicorn hidden imports
        "--hidden-import=uvicorn.logging",
        "--hidden-import=uvicorn.loops",
        "--hidden-import=uvicorn.loops.auto",
        "--hidden-import=uvicorn.protocols",
        "--hidden-import=uvicorn.protocols.http",
        "--hidden-import=uvicorn.protocols.http.auto",
        "--hidden-import=uvicorn.protocols.websockets",
        "--hidden-import=uvicorn.protocols.websockets.auto",
        "--hidden-import=uvicorn.lifespan",
        "--hidden-import=uvicorn.lifespan.on",
        # websockets hidden imports
        "--hidden-import=websockets.legacy",
        "--hidden-import=websockets.legacy.server",
        # output configuration
        f"--distpath={str(dist_dir)}",
        f"--workpath={str(build_dir)}",
        str(main_py)
    ]

    print(f"Running command: {' '.join(cmd)}")
    result = subprocess.run(cmd)
    if result.returncode != 0:
        print("[ERROR] PyInstaller build failed.")
        sys.exit(1)

    # With --onedir, output is dist/rotofox-backend/ folder
    onedir_folder = dist_dir / "rotofox-backend"
    exe_file = onedir_folder / "rotofox-backend.exe"

    if not exe_file.exists():
        print(f"[ERROR] PyInstaller build failed to generate {exe_file}")
        sys.exit(1)

    print(f"\n[OK] Successfully packaged backend folder to: {onedir_folder}")

    # Copy the entire onedir folder to frontend/src-tauri/binaries/rotofox-backend/
    tauri_bin_dir = base_dir.parent / "frontend" / "src-tauri" / "binaries"
    sidecar_dir = tauri_bin_dir / "rotofox-backend"

    # Clean old sidecar directory before copying
    if sidecar_dir.exists():
        print(f"[INFO] Removing old sidecar directory: {sidecar_dir}")
        shutil.rmtree(sidecar_dir)

    tauri_bin_dir.mkdir(exist_ok=True)
    shutil.copytree(onedir_folder, sidecar_dir)
    print(f"[OK] Copied sidecar backend folder to: {sidecar_dir}")

    # Also place the stub launcher .exe at the expected sidecar path for Tauri:
    # Tauri sidecar name must match: rotofox-backend-x86_64-pc-windows-msvc.exe
    sidecar_exe = tauri_bin_dir / "rotofox-backend-x86_64-pc-windows-msvc.exe"
    shutil.copy2(exe_file, sidecar_exe)
    print(f"[OK] Copied launcher EXE to sidecar path: {sidecar_exe}")

    print("=== Backend Packaging Complete ===")


if __name__ == "__main__":
    package()
