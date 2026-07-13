"""Engine State Management.

This module provides a thread-safe Singleton to monitor and control
the active state, progress, and cancellation requests of the AI tracking engine.
"""

import threading
from typing import Optional


class EngineState:
    """Thread-safe Singleton to manage the state of the AI propagation engine."""

    _instance: Optional["EngineState"] = None
    _lock: threading.Lock = threading.Lock()

    is_tracking: bool
    cancel_requested: bool
    current_video_id: Optional[str]
    current_frame: int
    total_frames: int

    def __new__(cls) -> "EngineState":
        with cls._lock:
            if cls._instance is None:
                cls._instance = super(EngineState, cls).__new__(cls)
                cls._instance.is_tracking = False
                cls._instance.cancel_requested = False
                cls._instance.current_video_id = None
                cls._instance.current_frame = 0
                cls._instance.total_frames = 0
        return cls._instance

    def start_tracking(self, video_id: str, total_frames: int) -> None:
        """Initialize parameters for starting a new tracking session.

        Args:
            video_id (str): The target video identifier.
            total_frames (int): Total number of frames to track.
        """
        self.is_tracking = True
        self.cancel_requested = False
        self.current_video_id = video_id
        self.total_frames = total_frames
        self.current_frame = 0

    def request_cancel(self) -> None:
        """Flag a request to cancel the active tracking session."""
        if self.is_tracking:
            self.cancel_requested = True

    def reset(self) -> None:
        """Reset the engine state parameters to their default idle values."""
        self.is_tracking = False
        self.cancel_requested = False
        self.current_video_id = None
        self.current_frame = 0
        self.total_frames = 0

