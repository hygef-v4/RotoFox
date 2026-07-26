"""Download AI model checkpoints from the command line.

Supports a non-interactive mode so it can run inside an automated build.
``setup_and_build.bat`` called this script and then blocked forever on an
``input()`` prompt, which meant the "fully automated setup and build" the README
advertises could never actually complete unattended.

Usage:
    python scripts/setup_models.py                    # interactive
    python scripts/setup_models.py --yes              # pick the recommended model
    python scripts/setup_models.py --sam small        # pick a specific model
    python scripts/setup_models.py --yes --skip-matanyone
"""

from __future__ import annotations

import argparse
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BASE_DIR))

from app.services.model_manager import MODELS, TRACKING_MODEL_IDS, ModelManager  # noqa: E402

BLOCK_SIZE = 1024 * 1024 * 2  # 2 MB


def download(model_id: str, checkpoints_dir: Path) -> bool:
    """Download one checkpoint, writing to a temporary file until it verifies.

    Returns:
        True when the checkpoint is present and valid afterwards.
    """
    info = MODELS[model_id]
    dest = checkpoints_dir / info["checkpoint"]
    part = dest.with_suffix(dest.suffix + ".part")

    if ModelManager.is_downloaded(model_id):
        print(f"[SKIP] {info['name']} is already installed.")
        return True

    if dest.exists():
        print(f"[WARN] {dest.name} exists but is incomplete. Re-downloading.")
        dest.unlink()

    print(f"\n[DOWNLOAD] {info['name']}  (~{info['approx_mb']} MB)")
    print(f"           {info['url']}")

    try:
        request = urllib.request.Request(info["url"], headers={"User-Agent": "RotoFoxSetup/1.0"})
        with urllib.request.urlopen(request, timeout=30) as response:
            total = int(response.info().get("Content-Length", 0))
            done = 0
            with open(part, "wb") as handle:
                while True:
                    chunk = response.read(BLOCK_SIZE)
                    if not chunk:
                        break
                    handle.write(chunk)
                    done += len(chunk)
                    if total > 0:
                        percent = int(done * 100 / total)
                        print(
                            f"\r           {percent:3d}%  "
                            f"({done // 1024**2} / {total // 1024**2} MB)",
                            end="", flush=True,
                        )
        print()

        if done < info["min_bytes"]:
            part.unlink(missing_ok=True)
            print(f"[ERROR] Download finished but is only {done / 1024**2:.1f} MB — too small to be valid.")
            return False

        os.replace(part, dest)
        print(f"[OK] {info['name']} installed.")
        return True

    except (urllib.error.URLError, OSError, TimeoutError) as exc:
        part.unlink(missing_ok=True)
        print(f"\n[ERROR] Could not download {info['name']}: {exc}")
        return False
    except KeyboardInterrupt:
        part.unlink(missing_ok=True)
        print("\n[CANCELLED] Download interrupted; the partial file was removed.")
        raise


def choose_sam_interactively(recommended: str) -> str | None:
    """Prompt for a SAM 2 variant. Returns None when the user skips."""
    print("\nAvailable tracking models:")
    for index, key in enumerate(TRACKING_MODEL_IDS, start=1):
        info = MODELS[key]
        marker = "  <- recommended for your hardware" if key == recommended else ""
        print(f"  [{index}] {info['name']:<20} {info['vram_req']} GB VRAM, ~{info['approx_mb']} MB{marker}")
    print(f"  [{len(TRACKING_MODEL_IDS) + 1}] Skip")

    default_index = TRACKING_MODEL_IDS.index(recommended) + 1

    while True:
        raw = input(f"\nChoose a model [1-{len(TRACKING_MODEL_IDS) + 1}, default {default_index}]: ").strip()
        if not raw:
            return TRACKING_MODEL_IDS[default_index - 1]
        if not raw.isdigit():
            print("Please enter a number.")
            continue
        choice = int(raw)
        if 1 <= choice <= len(TRACKING_MODEL_IDS):
            return TRACKING_MODEL_IDS[choice - 1]
        if choice == len(TRACKING_MODEL_IDS) + 1:
            return None
        print("That is not one of the options.")


def main() -> int:
    parser = argparse.ArgumentParser(description="Download RotoFox AI models")
    parser.add_argument("--yes", "-y", action="store_true",
                        help="Non-interactive: install the recommended tracking model")
    parser.add_argument("--sam", choices=TRACKING_MODEL_IDS,
                        help="Install a specific tracking model (implies --yes)")
    parser.add_argument("--skip-matanyone", action="store_true",
                        help="Do not download the optional refinement model")
    parser.add_argument("--skip-sam", action="store_true",
                        help="Do not download a tracking model")
    args = parser.parse_args()

    non_interactive = args.yes or args.sam is not None

    print("=== RotoFox model setup ===")
    checkpoints_dir = ModelManager.get_checkpoints_dir()
    checkpoints_dir.mkdir(parents=True, exist_ok=True)
    print(f"Checkpoints folder: {checkpoints_dir}")

    info = ModelManager.get_system_info()
    print(f"GPU: {info['gpu_name']}"
          + (f" ({info['total_vram_gb']} GB VRAM)" if info["total_vram_gb"] else ""))
    print(f"RAM: {info['system_ram_gb'] or 'unknown'} GB")

    recommended = info["recommended_model"]
    failures = []

    # The tracking model is what the application actually needs to function, so
    # it comes first. Refinement is a quality improvement on export only.
    if not args.skip_sam:
        if args.sam:
            target = args.sam
        elif non_interactive:
            target = recommended
        else:
            target = choose_sam_interactively(recommended)

        if target and not download(target, checkpoints_dir):
            failures.append(MODELS[target]["name"])
    else:
        print("\n[SKIP] Tracking model skipped by request.")

    if not args.skip_matanyone:
        print("\nOptional: MatAnyone 2 refines hair and fine edges during export.")
        want = True
        if not non_interactive:
            want = input("Download MatAnyone 2? [Y/n]: ").strip().lower() not in {"n", "no"}
        if want and not download("matanyone", checkpoints_dir):
            failures.append(MODELS["matanyone"]["name"])
    else:
        print("\n[SKIP] MatAnyone 2 skipped by request.")

    print("\n=== Summary ===")
    for model_id in MODELS:
        state = "installed" if ModelManager.is_downloaded(model_id) else "missing"
        print(f"  {MODELS[model_id]['name']:<34} {state}")

    if failures:
        print(f"\n[WARNING] These downloads failed: {', '.join(failures)}")
        print("You can retry from the Model Hub inside the application.")
        return 1

    print("\nSetup complete.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
