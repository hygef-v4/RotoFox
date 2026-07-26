"""Engine State Management.

Tracks whether a long-running job (propagation or export) is active, how far it
has progressed, and whether the user has asked to cancel it.

Cancellation is stored in a :class:`threading.Event` rather than a plain bool
because the flag is written from the asyncio event loop (a WebSocket handler)
and read from a worker thread (the propagation loop). A bare attribute happens
to work today thanks to the GIL, but breaks the moment the read side moves off
the event loop — which it does, deliberately, so that ``cancel_tracking``
stays responsive while the GPU is busy.
"""

from __future__ import annotations

import threading


class EngineState:
    """Thread-safe singleton describing the state of the AI engine."""

    _instance: EngineState | None = None
    _lock: threading.Lock = threading.Lock()

    def __new__(cls) -> EngineState:
        with cls._lock:
            if cls._instance is None:
                instance = super().__new__(cls)
                instance._cancel_event = threading.Event()
                instance.is_tracking = False
                instance.is_exporting = False
                instance.current_video_id = None
                instance.current_frame = 0
                instance.total_frames = 0
                cls._instance = instance
        return cls._instance

    # ── Tracking lifecycle ────────────────────────────────────────────────

    def start_tracking(self, video_id: str | None, total_frames: int) -> None:
        """Begin a tracking session, clearing any stale cancellation request.

        Args:
            video_id: Identifier of the video being tracked.
            total_frames: Total frames in the timeline, used for progress.
        """
        self._cancel_event.clear()
        self.is_tracking = True
        self.current_video_id = video_id
        self.total_frames = max(int(total_frames or 0), 0)
        self.current_frame = 0

    def finish_tracking(self) -> None:
        """Mark the tracking session as finished."""
        self.is_tracking = False
        self._cancel_event.clear()

    # ── Export lifecycle ──────────────────────────────────────────────────

    def start_export(self) -> None:
        """Begin an export job, clearing any stale cancellation request."""
        self._cancel_event.clear()
        self.is_exporting = True

    def finish_export(self) -> None:
        """Mark the export job as finished."""
        self.is_exporting = False
        self._cancel_event.clear()

    # ── Cancellation ──────────────────────────────────────────────────────

    def request_cancel(self) -> None:
        """Ask the active job to stop at the next safe point."""
        if self.is_tracking or self.is_exporting:
            self._cancel_event.set()

    @property
    def cancel_requested(self) -> bool:
        """True when a cancellation has been requested for the active job."""
        return self._cancel_event.is_set()

    @property
    def is_busy(self) -> bool:
        """True when either a tracking or an export job is running."""
        return self.is_tracking or self.is_exporting

    def reset(self) -> None:
        """Return the engine to an idle state."""
        self._cancel_event.clear()
        self.is_tracking = False
        self.is_exporting = False
        self.current_video_id = None
        self.current_frame = 0
        self.total_frames = 0
