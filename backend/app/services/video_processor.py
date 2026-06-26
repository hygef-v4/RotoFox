import os
import cv2
from pathlib import Path
from app.services.cache_manager import CacheManager

class VideoProcessor:
    @staticmethod
    def extract_frames(video_path: str, video_id: str, fps_limit: int = None) -> tuple:
        """
        Extract frames from a video and save to the SSD cache directory using OpenCV.
        Returns (frame_count, source_fps) tuple.
        """
        video_dir = CacheManager.get_video_dir(video_id)
        
        cap = cv2.VideoCapture(video_path)
        if not cap.isOpened():
            raise RuntimeError(f"Failed to open video: {video_path}")
        
        source_fps = cap.get(cv2.CAP_PROP_FPS)
        if source_fps <= 0:
            source_fps = 25.0  # Fallback if FPS metadata is missing
        total_source_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        
        # Calculate frame skip interval if fps_limit is set
        frame_interval = 1
        if fps_limit and source_fps > fps_limit:
            frame_interval = int(round(source_fps / fps_limit))
        
        print(f"VideoProcessor: Extracting frames from {video_path}")
        print(f"  Source FPS: {source_fps}, Total source frames: {total_source_frames}")
        if fps_limit:
            print(f"  FPS limit: {fps_limit}, Frame interval: {frame_interval}")
        
        frame_count = 0
        source_frame_idx = 0
        
        while True:
            ret, frame = cap.read()
            if not ret:
                break
            
            if source_frame_idx % frame_interval == 0:
                frame_filename = f"{frame_count:05d}.jpg"
                frame_path = str(video_dir / frame_filename)
                cv2.imwrite(frame_path, frame, [cv2.IMWRITE_JPEG_QUALITY, 95])
                frame_count += 1
            
            source_frame_idx += 1
        
        cap.release()
        print(f"VideoProcessor: Extracted {frame_count} frames to {video_dir} (source FPS: {source_fps})")
        return frame_count, source_fps
