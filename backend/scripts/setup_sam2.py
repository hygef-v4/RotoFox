import os
import subprocess
import sys
import urllib.request
from pathlib import Path

# Paths
BASE_DIR = Path(__file__).parent.parent
MODELS_DIR = BASE_DIR / "checkpoints"
SAM2_REPO = "https://github.com/facebookresearch/sam2.git"
SAM2_DIR = BASE_DIR / "sam2_src"

# Weights
# sam2.1_hiera_large.pt
WEIGHTS_URL = "https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_large.pt"
WEIGHTS_FILE = MODELS_DIR / "sam2.1_hiera_large.pt"

def run_command(cmd, env=None):
    print(f"Running: {cmd}")
    result = subprocess.run(cmd, shell=True, env=env)
    if result.returncode != 0:
        print(f"Error executing: {cmd}")
        sys.exit(1)

def setup_sam2():
    print("=== SAM 2 Setup ===")
    
    # 1. Ensure models dir exists
    MODELS_DIR.mkdir(exist_ok=True)
    
    # 2. Download weights if not exist
    if not WEIGHTS_FILE.exists():
        print(f"Downloading SAM 2 weights (~1.2GB) to {WEIGHTS_FILE}...")
        try:
            urllib.request.urlretrieve(WEIGHTS_URL, WEIGHTS_FILE)
            print("Download complete!")
        except Exception as e:
            print(f"Failed to download weights: {e}")
            sys.exit(1)
    else:
        print("SAM 2 weights already exist. Skipping download.")

    # 3. Check for CUDA
    try:
        import torch
        has_cuda = torch.cuda.is_available()
    except ImportError:
        has_cuda = False
        
    print(f"CUDA Available: {has_cuda}")
    
    env = os.environ.copy()
    if not has_cuda:
        print("Warning: CUDA not found. Compiling SAM 2 without CUDA extensions (will run slower on CPU).")
        env["SAM2_BUILD_CUDA"] = "0"
    
    # 4. Clone and Install
    if not SAM2_DIR.exists():
        print("Cloning SAM 2 repository...")
        run_command(f'git clone {SAM2_REPO} "{SAM2_DIR}"')
    
    print("Installing SAM 2 via pip...")
    run_command(f'"{sys.executable}" -m pip install -e "{SAM2_DIR}"', env=env)
    
    print("=== Setup Complete! ===")

if __name__ == "__main__":
    setup_sam2()
