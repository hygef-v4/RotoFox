"""Stage lightweight backend Python sources into frontend/src-tauri/resources/backend.

This enables a compact (~10 MB) standalone NSIS installer (`RotoFox_1.0.0_x64-setup.exe`)
that bundles the pure-Python backend + SAM 2 + MatAnyone 2 sources and downloads
the Python/PyTorch runtime + model checkpoints into the user-selected folder
during the first-run Setup Wizard.
"""

from __future__ import annotations

import shutil
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent
PROJECT_ROOT = BACKEND_DIR.parent
DEST_DIR = PROJECT_ROOT / "frontend" / "src-tauri" / "resources" / "backend"


def _ignore(directory: str, contents: list[str]) -> list[str]:
    ignored: list[str] = []
    for item in contents:
        if item in {"__pycache__", ".pytest_cache", ".ruff_cache", ".git", "csrc"} or item.endswith(
            (".pyc", ".pyo", ".pyd", ".so", ".cu", ".cpp")
        ):
            ignored.append(item)
    return ignored


def _patch_sam2_connected_components(misc_file: Path) -> None:
    """Add an OpenCV fallback to get_connected_components when sam2._C is absent."""
    if not misc_file.is_file():
        return
    text = misc_file.read_text(encoding="utf-8")
    target = (
        "    from sam2 import _C\n\n"
        "    return _C.get_connected_componnets(mask.to(torch.uint8).contiguous())"
    )
    replacement = (
        "    try:\n"
        "        from sam2 import _C\n\n"
        "        return _C.get_connected_componnets(mask.to(torch.uint8).contiguous())\n"
        "    except ImportError:\n"
        "        import cv2\n\n"
        "        mask_np = mask.detach().to(torch.uint8).cpu().numpy()\n"
        "        n, _, h, w = mask_np.shape\n"
        "        labels_out = np.zeros((n, 1, h, w), dtype=np.int32)\n"
        "        counts_out = np.zeros((n, 1, h, w), dtype=np.int32)\n"
        "        for i in range(n):\n"
        "            num_labels, labels, stats, _ = cv2.connectedComponentsWithStats(\n"
        "                mask_np[i, 0], connectivity=8\n"
        "            )\n"
        "            labels_out[i, 0] = labels\n"
        "            if num_labels > 1:\n"
        "                areas = stats[:, cv2.CC_STAT_AREA]\n"
        "                areas[0] = 0\n"
        "                counts_out[i, 0] = areas[labels]\n"
        "        return (\n"
        "            torch.from_numpy(labels_out).to(mask.device),\n"
        "            torch.from_numpy(counts_out).to(mask.device),\n"
        "        )"
    )
    if target in text:
        misc_file.write_text(text.replace(target, replacement), encoding="utf-8")


def stage() -> None:
    if DEST_DIR.exists():
        shutil.rmtree(DEST_DIR)
    DEST_DIR.mkdir(parents=True, exist_ok=True)

    shutil.copy2(BACKEND_DIR / "main.py", DEST_DIR / "main.py")
    shutil.copy2(BACKEND_DIR / "requirements.txt", DEST_DIR / "requirements.txt")
    shutil.copytree(BACKEND_DIR / "app", DEST_DIR / "app", ignore=_ignore)

    sam2_pkg = BACKEND_DIR / "sam2_src" / "sam2"
    if sam2_pkg.is_dir():
        shutil.copytree(sam2_pkg, DEST_DIR / "sam2", ignore=_ignore)
        _patch_sam2_connected_components(DEST_DIR / "sam2" / "utils" / "misc.py")

    matanyone_pkg = BACKEND_DIR / "third_party" / "MatAnyone2" / "matanyone2"
    if matanyone_pkg.is_dir():
        shutil.copytree(matanyone_pkg, DEST_DIR / "matanyone2", ignore=_ignore)

    print(f"[OK] Staged backend sources to: {DEST_DIR}")


if __name__ == "__main__":
    stage()
