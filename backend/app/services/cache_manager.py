import os
import shutil
from pathlib import Path

# Thư mục gốc chứa toàn bộ cache
CACHE_BASE_DIR = Path(__file__).resolve().parent.parent.parent / "cache_workspace"

class CacheManager:
    @staticmethod
    def get_video_dir(video_id: str) -> Path:
        """Lấy đường dẫn thư mục cache của một video cụ thể."""
        video_dir = CACHE_BASE_DIR / video_id
        video_dir.mkdir(parents=True, exist_ok=True)
        return video_dir

    @staticmethod
    def store_frame(video_id: str, frame_idx: int, frame_data: bytes) -> str:
        """Lưu một frame ảnh (nhị phân) vào ổ SSD."""
        video_dir = CacheManager.get_video_dir(video_id)
        # Định dạng tên file: frame_00001.jpg
        frame_filename = f"frame_{frame_idx:05d}.jpg"
        frame_path = video_dir / frame_filename
        
        with open(frame_path, "wb") as f:
            f.write(frame_data)
            
        return str(frame_path)

    @staticmethod
    def get_frame_path(video_id: str, frame_idx: int) -> str:
        """Lấy đường dẫn tĩnh của một frame đã lưu."""
        video_dir = CACHE_BASE_DIR / video_id
        frame_filename = f"frame_{frame_idx:05d}.jpg"
        return str(video_dir / frame_filename)

    @staticmethod
    def clear_cache(video_id: str):
        """Xóa toàn bộ cache của một video để giải phóng SSD."""
        video_dir = CACHE_BASE_DIR / video_id
        if video_dir.exists():
            shutil.rmtree(video_dir)

    @staticmethod
    def clear_all_cache():
        """Xóa toàn bộ thư mục cache (Dùng khi app tắt/khởi động lại)."""
        if CACHE_BASE_DIR.exists():
            shutil.rmtree(CACHE_BASE_DIR)
        CACHE_BASE_DIR.mkdir(parents=True, exist_ok=True)
