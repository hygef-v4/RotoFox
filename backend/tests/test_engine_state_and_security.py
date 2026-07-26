"""Tests for job serialisation, cancellation and local session authentication."""

from __future__ import annotations

import threading

import pytest

from app.core import security
from app.core.engine_state import EngineState


@pytest.fixture
def state() -> EngineState:
    engine_state = EngineState()
    engine_state.reset()
    return engine_state


class TestEngineState:
    def test_is_busy_blocks_a_second_job(self, state):
        # track_forward and export both used to spawn a task unconditionally.
        # Two propagations over one SAM 2 inference state interleave writes into
        # its memory bank and corrupt the masks.
        state.start_tracking("video_1", 100)
        assert state.is_busy

        state.finish_tracking()
        assert not state.is_busy

    def test_export_also_marks_the_engine_busy(self, state):
        state.start_export()
        assert state.is_busy
        state.finish_export()
        assert not state.is_busy

    def test_cancel_is_visible_from_another_thread(self, state):
        # The propagation loop now runs in a worker thread while cancel_tracking
        # arrives on the event loop, so this flag has to cross threads reliably.
        state.start_tracking("video_1", 10)
        observed = []

        def worker():
            for _ in range(1000):
                if state.cancel_requested:
                    observed.append(True)
                    return
        thread = threading.Thread(target=worker)

        state.request_cancel()
        thread.start()
        thread.join(timeout=5)

        assert observed == [True]

    def test_starting_a_job_clears_a_stale_cancel(self, state):
        state.start_tracking("video_1", 10)
        state.request_cancel()
        state.finish_tracking()

        state.start_tracking("video_2", 10)
        assert not state.cancel_requested

    def test_cancel_is_ignored_when_idle(self, state):
        state.request_cancel()
        assert not state.cancel_requested


class TestOriginAllowList:
    @pytest.mark.parametrize("origin", [
        "tauri://localhost",
        "http://localhost:1420",
        "http://127.0.0.1:1420",
        None,  # non-browser clients send no Origin at all
    ])
    def test_allows_the_desktop_shell_and_dev_server(self, origin):
        assert security.is_origin_allowed(origin)

    @pytest.mark.parametrize("origin", [
        "https://evil.example",
        "http://localhost:3000",
        "null",
        "http://127.0.0.1:8080",
    ])
    def test_rejects_arbitrary_web_pages(self, origin):
        # Browsers do not apply the same-origin policy to WebSocket connects, so
        # any page the user has open could otherwise reach the local backend.
        assert not security.is_origin_allowed(origin)


class TestSessionToken:
    def test_generated_token_verifies(self, monkeypatch):
        token = security.generate_session_token()
        assert security.verify_token(token)
        assert len(token) >= 32

    def test_wrong_token_is_rejected(self):
        security.generate_session_token()
        assert not security.verify_token("not-the-token")
        assert not security.verify_token("")
        assert not security.verify_token(None)

    def test_a_new_session_invalidates_the_previous_token(self):
        first = security.generate_session_token()
        security.generate_session_token()
        assert not security.verify_token(first)

    def test_token_file_is_written_for_the_shell_to_read(self):
        token = security.generate_session_token()
        path = security.runtime_dir() / security.TOKEN_FILE_NAME
        assert path.read_text(encoding="utf-8") == token
