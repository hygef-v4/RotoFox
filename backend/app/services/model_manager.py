import os
import torch
import json
import urllib.request
from pathlib import Path
from fastapi.concurrency import run_in_threadpool

MODELS = {
    "tiny": {
        "name": "SAM 2.1 Tiny",
        "url": "https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_tiny.pt",
        "checkpoint": "sam2.1_hiera_tiny.pt",
        "config": "configs/sam2.1/sam2.1_hiera_t.yaml",
        "vram_req": 2.0,
        "speed": "Fastest (~30 FPS)",
        "description": "Recommended for CPU or GPUs with less than 4GB VRAM. Extremely fast but less precise."
    },
    "small": {
        "name": "SAM 2.1 Small",
        "url": "https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_small.pt",
        "checkpoint": "sam2.1_hiera_small.pt",
        "config": "configs/sam2.1/sam2.1_hiera_s.yaml",
        "vram_req": 4.0,
        "speed": "Fast (~20 FPS)",
        "description": "Good balance of speed and accuracy. Works well on mid-range GPUs (GTX 1660, RTX 3050)."
    },
    "base": {
        "name": "SAM 2.1 Base+",
        "url": "https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_base_plus.pt",
        "checkpoint": "sam2.1_hiera_base_plus.pt",
        "config": "configs/sam2.1/sam2.1_hiera_b+.yaml",
        "vram_req": 6.0,
        "speed": "Medium (~15 FPS)",
        "description": "High accuracy tracking. Fits RTX 3060/4060 or any GPU with 6GB-8GB VRAM."
    },
    "large": {
        "name": "SAM 2.1 Large",
        "url": "https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_large.pt",
        "checkpoint": "sam2.1_hiera_large.pt",
        "config": "configs/sam2.1/sam2.1_hiera_l.yaml",
        "vram_req": 8.0,
        "speed": "Slowest (~10 FPS)",
        "description": "Maximum accuracy and edge precision. Recommended for high-end GPUs with 8GB+ VRAM."
    },
    "matanyone": {
        "name": "MatAnyone 2 Edge Refinement",
        "url": "https://github.com/pq-yang/MatAnyone2/releases/download/v1.0.0/matanyone2.pth",
        "checkpoint": "matanyone2.pth",
        "config": "",
        "vram_req": 4.0,
        "speed": "Refinement Matte",
        "description": "High-precision edge refinement model for hair and fine details. Used during project export."
    }
}

CONFIG_FILE = Path(__file__).parent.parent.parent / "rotofox_config.json"

class ModelManager:
    _custom_checkpoints_dir = None

    @classmethod
    def load_config(cls):
        if CONFIG_FILE.exists():
            try:
                with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    cls._custom_checkpoints_dir = data.get("checkpoints_dir", None)
            except Exception as e:
                print(f"ModelManager: Error loading config: {e}")

    @classmethod
    def save_config(cls, checkpoints_dir: str):
        cls._custom_checkpoints_dir = checkpoints_dir.strip() if checkpoints_dir and checkpoints_dir.strip() else None
        try:
            with open(CONFIG_FILE, "w", encoding="utf-8") as f:
                json.dump({"checkpoints_dir": cls._custom_checkpoints_dir}, f, indent=4)
            print(f"ModelManager: Config saved successfully. Custom dir: {cls._custom_checkpoints_dir}")
        except Exception as e:
            print(f"ModelManager: Error saving config: {e}")
            raise e

    @classmethod
    def get_checkpoints_dir(cls) -> Path:
        """Returns the checkpoints directory path."""
        # Initialize configuration if not loaded yet
        if cls._custom_checkpoints_dir is None and CONFIG_FILE.exists():
            cls.load_config()
            
        if cls._custom_checkpoints_dir:
            path = Path(cls._custom_checkpoints_dir)
            path.mkdir(exist_ok=True, parents=True)
            return path
            
        base_dir = Path(__file__).parent.parent.parent
        checkpoint_dir = base_dir / "checkpoints"
        checkpoint_dir.mkdir(exist_ok=True)
        return checkpoint_dir

    @classmethod
    def get_system_info(cls):
        """Profile GPU capabilities and System RAM to recommend the best model."""
        gpu_available = torch.cuda.is_available()
        gpu_name = torch.cuda.get_device_name(0) if gpu_available else "CPU"
        
        total_vram_gb = None
        if gpu_available:
            try:
                total_vram_gb = round(torch.cuda.get_device_properties(0).total_memory / (1024**3), 1)
            except Exception:
                pass
                
        system_ram_gb = None
        try:
            import psutil
            system_ram_gb = round(psutil.virtual_memory().total / (1024**3), 1)
        except Exception:
            pass

        # Determine recommended model based on available VRAM
        recommended_model = "tiny" # Fallback/CPU default
        if gpu_available and total_vram_gb is not None:
            if total_vram_gb >= 8.0:
                recommended_model = "large"
            elif total_vram_gb >= 6.0:
                recommended_model = "base"
            elif total_vram_gb >= 4.0:
                recommended_model = "small"
            else:
                recommended_model = "tiny"

        checkpoints_dir = cls.get_checkpoints_dir()
        
        # Build model status list
        model_list = []
        for model_id, info in MODELS.items():
            checkpoint_path = checkpoints_dir / info["checkpoint"]
            downloaded = checkpoint_path.exists()
            size_mb = 0
            if downloaded:
                try:
                    size_mb = round(checkpoint_path.stat().st_size / (1024**2), 1)
                except Exception:
                    pass
            
            model_list.append({
                "id": model_id,
                "name": info["name"],
                "downloaded": downloaded,
                "size_mb": size_mb,
                "vram_req": info["vram_req"],
                "speed": info["speed"],
                "description": info["description"],
                "recommended": (model_id == recommended_model)
            })

        return {
            "gpu_available": gpu_available,
            "gpu_name": gpu_name,
            "total_vram_gb": total_vram_gb,
            "system_ram_gb": system_ram_gb,
            "recommended_model": recommended_model,
            "checkpoints_dir": str(checkpoints_dir.resolve()),
            "is_custom_dir": cls._custom_checkpoints_dir is not None,
            "models": model_list
        }

    @classmethod
    async def download_model_async(cls, model_id: str, on_progress_callback):
        """Asynchronously download the model file and notify progress."""
        if model_id not in MODELS:
            raise ValueError(f"Unknown model: {model_id}")
            
        model_info = MODELS[model_id]
        url = model_info["url"]
        dest_path = cls.get_checkpoints_dir() / model_info["checkpoint"]

        def open_connection():
            req = urllib.request.Request(url, headers={'User-Agent': 'RotoFoxModelHub/1.0'})
            return urllib.request.urlopen(req)

        # Open connection in a threadpool so it doesn't block the event loop
        conn = await run_in_threadpool(open_connection)
        try:
            total_size = int(conn.info().get('Content-Length', -1))
            downloaded = 0
            block_size = 1024 * 256 # 256KB block size
            
            # Write file in threadpool chunk by chunk
            with open(dest_path, "wb") as f:
                while True:
                    chunk = await run_in_threadpool(conn.read, block_size)
                    if not chunk:
                        break
                    await run_in_threadpool(f.write, chunk)
                    downloaded += len(chunk)
                    if total_size > 0:
                        percent = int(downloaded * 100 / total_size)
                        await on_progress_callback(percent)
        finally:
            conn.close()
            
        print(f"ModelManager: Downloaded {model_id} checkpoint successfully to {dest_path}")
