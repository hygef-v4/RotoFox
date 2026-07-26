"""Clone and install the SAM 2 framework into the active environment.

This script no longer downloads a checkpoint. It used to fetch SAM 2.1 Large
(1.2 GB) before the user had been asked anything, and then ``setup_models.py``
asked which variant they wanted — so anyone on a 4 GB GPU who sensibly chose
Small had already spent 1.2 GB of bandwidth on a model they would never load.

Weight downloads now belong solely to ``setup_models.py``, which asks first.
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
SAM2_DIR = BASE_DIR / "sam2_src"
SAM2_REPO = "https://github.com/facebookresearch/sam2.git"


def run(command: list[str], env: dict | None = None) -> None:
    """Run a subprocess and abort the script if it fails."""
    print(f"[RUN] {' '.join(command)}")
    result = subprocess.run(command, env=env, check=False)
    if result.returncode != 0:
        sys.exit(f"[ERROR] Command failed: {' '.join(command)}")


def setup(skip_clone: bool = False) -> None:
    print("=== SAM 2 setup ===")

    if not SAM2_DIR.exists():
        if skip_clone:
            sys.exit(f"[ERROR] {SAM2_DIR} does not exist and --skip-clone was given.")
        print(f"Cloning SAM 2 into {SAM2_DIR}...")
        run(["git", "clone", "--depth", "1", SAM2_REPO, str(SAM2_DIR)])
    else:
        print(f"[SKIP] SAM 2 sources already present at {SAM2_DIR}")

    try:
        import torch

        has_cuda = torch.cuda.is_available()
    except ImportError:
        has_cuda = False
        print("[WARN] PyTorch is not installed yet. Install requirements.txt first "
              "for a CUDA-enabled build.")

    print(f"CUDA available: {has_cuda}")

    env = os.environ.copy()
    if not has_cuda:
        # Building the CUDA extension without a toolchain fails the whole install.
        print("[INFO] Building SAM 2 without its CUDA extension (CPU inference will be slow).")
        env["SAM2_BUILD_CUDA"] = "0"

    run([sys.executable, "-m", "pip", "install", "-e", str(SAM2_DIR)], env=env)

    print("\n=== SAM 2 setup complete ===")
    print("Next: python scripts/setup_models.py    (downloads the model weights)")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Install the SAM 2 framework")
    parser.add_argument("--skip-clone", action="store_true",
                        help="Assume sam2_src already exists")
    setup(skip_clone=parser.parse_args().skip_clone)
