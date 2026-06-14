import os
import subprocess
from pathlib import Path
from app.services.cache_manager import CacheManager

class VideoProcessor:
    @staticmethod
    def extract_frames(video_path: str, video_id: str, fps_limit: int = None) -> int:
        """
        Trích xuất các frame từ video và lưu vào SSD cache sử dụng FFmpeg.
        Trả về số lượng frame đã được trích xuất.
        """
        video_dir = CacheManager.get_video_dir(video_id)
        
        # FFmpeg command để lấy frame (giữ chất lượng tốt nhất)
        # Sử dụng output pattern frame_%05d.jpg
        output_pattern = str(video_dir / "frame_%05d.jpg")
        
        command = [
            "ffmpeg",
            "-y",                   # Overwrite output files without asking
            "-i", video_path,       # Input file
            "-qscale:v", "2",       # High quality JPEG
        ]
        
        if fps_limit:
            command.extend(["-vf", f"fps={fps_limit}"])
            
        command.append(output_pattern)
        
        print(f"Running FFmpeg to extract frames: {' '.join(command)}")
        try:
            subprocess.run(command, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        except subprocess.CalledProcessError as e:
            print(f"FFmpeg extraction failed: {e.stderr.decode('utf-8')}")
            raise RuntimeError("Failed to extract frames using FFmpeg.")

        # Đếm số lượng frame đã tạo
        frames = list(video_dir.glob("frame_*.jpg"))
        return len(frames)
