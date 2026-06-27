import os
import subprocess
import sys
from pathlib import Path

def package():
    print("=== SmartMask Local: Backend Packaging ===")
    
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
        
    # Determine output directories
    dist_dir = base_dir / "dist"
    build_dir = base_dir / "build"
    
    cmd = [
        sys.executable,
        "-m",
        "PyInstaller",
        "--onefile",
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
    subprocess.run(cmd)
    
    # Check if build was successful
    exe_file = dist_dir / "rotofox-backend.exe"
    if exe_file.exists():
        print(f"\n[OK] Successfully packaged backend to: {exe_file}")
        
        # Create tauri binaries directory and copy sidecar there
        tauri_bin_dir = base_dir.parent / "frontend" / "src-tauri" / "binaries"
        tauri_bin_dir.mkdir(exist_ok=True)
        
        # Copy to tauri binaries as a sidecar format: rotofox-backend-x86_64-pc-windows-msvc.exe
        # For simplicity, we can also name it matching the target triple for windows.
        # Target triple for 64-bit Windows is x86_64-pc-windows-msvc
        sidecar_dest = tauri_bin_dir / "rotofox-backend-x86_64-pc-windows-msvc.exe"
        import shutil
        shutil.copy2(exe_file, sidecar_dest)
        print(f"[OK] Copied sidecar backend binary to: {sidecar_dest}")
    else:
        print("[ERROR] PyInstaller build failed to generate rotofox-backend.exe")
        sys.exit(1)

    print("=== Backend Packaging Complete ===")

if __name__ == "__main__":
    package()
