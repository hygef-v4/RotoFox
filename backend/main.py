"""RotoFox API server entry point.

Boots logging, publishes a per-session authentication token, registers the API
and WebSocket routers, and starts Uvicorn bound to the loopback interface.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import logging
import os
import socket
import sys
from collections.abc import AsyncIterator

import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.core.logging_config import setup_logging
from app.core.paths import is_frozen, runtime_dir
from app.core.security import ALLOWED_ORIGINS, generate_session_token

setup_logging()
logger = logging.getLogger(__name__)

DEFAULT_PORT = 8000
HOST = "127.0.0.1"


@contextlib.asynccontextmanager
async def _lifespan(_app: FastAPI) -> AsyncIterator[None]:
    """Load the default SAM 2 checkpoint in the background after startup.

    Running model initialization after Uvicorn binds the HTTP/WebSocket socket
    lets the desktop UI connect in under two seconds instead of waiting for
    PyTorch and CUDA to finish reading a ~900 MB checkpoint from disk.
    """
    from app.api.connection import manager
    from app.api.websockets import ai_engine
    from app.services.model_manager import ModelManager

    async def _warm_up() -> None:
        try:
            await asyncio.to_thread(ai_engine.ensure_initialized)
            if manager.is_connected:
                info = ModelManager.get_system_info()
                info["active_model"] = ai_engine.active_model_id
                await manager.send({"status": "system_info", "system_info": info})
        except Exception as exc:  # noqa: BLE001
            logger.exception("Background model initialization failed: %s", exc)

    warmup_task = asyncio.create_task(_warm_up())
    try:
        yield
    finally:
        if not warmup_task.done():
            warmup_task.cancel()


app = FastAPI(title="RotoFox API", version="1.1.0", lifespan=_lifespan)

# Only the desktop shell and the dev server may call this API. The previous
# configuration combined allow_origins=["*"] with allow_credentials=True — a
# pairing the CORS specification forbids, and which invited every page the user
# had open to POST to this local server.
app.add_middleware(
    CORSMiddleware,
    allow_origins=sorted(ALLOWED_ORIGINS),
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

from app.api import routes, websockets  # noqa: E402 - imported after app creation

app.include_router(routes.router)
app.include_router(websockets.router)


def find_free_port(preferred: int = DEFAULT_PORT, attempts: int = 20) -> int:
    """Return a bindable port, starting at ``preferred``.

    On Windows ``SO_REUSEADDR`` permits binding to a port that another process
    is already listening on, which silently routes traffic to the old process.
    We therefore use ``SO_EXCLUSIVEADDRUSE`` on Windows and only enable
    ``SO_REUSEADDR`` on POSIX platforms.
    """
    for offset in range(attempts):
        candidate = preferred + offset
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
                probe.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            else:
                probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                probe.bind((HOST, candidate))
                return candidate
            except OSError:
                continue
    raise RuntimeError(
        f"No free port found in range {preferred}-{preferred + attempts - 1}."
    )


def publish_runtime_info(port: int, token: str) -> None:
    """Write connection details for the desktop shell to read."""
    payload = {"host": HOST, "port": port, "token": token}
    path = runtime_dir() / "backend.json"
    try:
        path.write_text(json.dumps(payload), encoding="utf-8")
        logger.info("Runtime info published to %s", path)
    except OSError as exc:
        logger.error("Could not publish runtime info: %s", exc)


def main() -> None:
    """Parse arguments and run the ASGI server."""
    env_port = int(os.getenv("ROTOFOX_PORT") or DEFAULT_PORT)
    env_token = os.getenv("ROTOFOX_TOKEN") or ""

    parser = argparse.ArgumentParser(description="RotoFox backend")
    parser.add_argument("--port", type=int, default=env_port, help="Preferred port")
    parser.add_argument("--token", type=str, default=env_token, help="Pre-shared session token")
    parser.add_argument("--no-auth", action="store_true", help="Disable the session token (development only)")
    parser.add_argument("--reload", action="store_true", help="Enable autoreload (development only)")
    args = parser.parse_args()

    port = find_free_port(args.port)

    token = ""
    if not args.no_auth:
        token = generate_session_token(args.token)
    else:
        logger.warning("Session authentication is DISABLED (--no-auth)")

    publish_runtime_info(port, token)

    logger.info("Starting RotoFox backend on http://%s:%d (frozen=%s)", HOST, port, is_frozen())

    use_reload = args.reload and not is_frozen()
    uvicorn.run(
        "main:app" if use_reload else app,
        host=HOST,
        port=port,
        reload=use_reload,
        reload_excludes=["cache_workspace/*", "**/cache_workspace/**"] if use_reload else None,
        log_config=None,        # keep our own logging configuration
        ws_ping_interval=30,
        ws_ping_timeout=300,
    )


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001 - last-resort diagnostics
        logger.exception("Backend failed to start: %s", exc)
        sys.exit(1)
