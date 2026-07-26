"""Single-session WebSocket registry.

RotoFox is a single-user desktop application backed by one shared
:class:`~app.services.ai_engine.AIEngine`. Two editors connected at once would
share one SAM 2 inference state, so opening a second window silently corrupted
the first one's session. This registry keeps exactly one active editor and
lets the second connection be refused with a clear message.

It also gives the HTTP layer a way to push progress. Frame extraction happens
during a ``POST /upload``, but the client cannot see inside that request, so
the frontend previously animated its progress bar from random numbers.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from fastapi import WebSocket

logger = logging.getLogger(__name__)


class ConnectionManager:
    """Tracks the one active editor WebSocket and forwards messages to it."""

    def __init__(self) -> None:
        self._socket: WebSocket | None = None
        self._lock = asyncio.Lock()

    async def register(self, websocket: WebSocket) -> bool:
        """Claim the editor slot.

        Returns:
            True when the slot was free, False when another editor holds it.
        """
        async with self._lock:
            if self._socket is not None:
                return False
            self._socket = websocket
            return True

    async def unregister(self, websocket: WebSocket) -> None:
        """Release the editor slot if this socket owns it."""
        async with self._lock:
            if self._socket is websocket:
                self._socket = None

    @property
    def is_connected(self) -> bool:
        """True when an editor is currently attached."""
        return self._socket is not None

    async def send(self, payload: dict[str, Any]) -> None:
        """Send a payload to the active editor, ignoring a dropped connection.

        Progress updates must never take down the operation that produced them,
        so a closed socket is logged and swallowed rather than raised.
        """
        socket = self._socket
        if socket is None:
            return
        try:
            await socket.send_json(payload)
        except (RuntimeError, ConnectionError) as exc:
            logger.debug("Dropping message for a closed socket: %s", exc)


manager = ConnectionManager()
