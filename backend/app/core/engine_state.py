import threading

class EngineState:
    _instance = None
    _lock = threading.Lock()

    def __new__(cls):
        with cls._lock:
            if cls._instance is None:
                cls._instance = super(EngineState, cls).__new__(cls)
                cls._instance.is_tracking = False
                cls._instance.cancel_requested = False
                cls._instance.current_video_id = None
                cls._instance.current_frame = 0
                cls._instance.total_frames = 0
        return cls._instance

    def start_tracking(self, video_id: str, total_frames: int):
        self.is_tracking = True
        self.cancel_requested = False
        self.current_video_id = video_id
        self.total_frames = total_frames
        self.current_frame = 0

    def request_cancel(self):
        """Hủy bỏ luồng tracking hiện tại."""
        if self.is_tracking:
            self.cancel_requested = True

    def reset(self):
        """Khôi phục trạng thái mặc định."""
        self.is_tracking = False
        self.cancel_requested = False
        self.current_video_id = None
        self.current_frame = 0
        self.total_frames = 0
