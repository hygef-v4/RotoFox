"""RotoFox API server entry point.

Boots logging, publishes a per-session authentication token, registers the API
and WebSocket routers, and starts Uvicorn bound to the loopback interface.
"""

from __future__ import annotations

import argparse
import json
import logging
import socket
import sys

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

app = FastAPI(title="RotoFox API", version="1.1.0")

# Only the desktop shell and the Vite dev server may call this API. The previous
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

    Hard-coding 8000 meant a single orphaned backend, or any unrelated program
    holding that port, left the app stuck on its loading screen for thirty
    seconds and then failing. The chosen port is published to the runtime
    directory so the desktop shell can find it.
    """
    for offset in range(attempts):
        candidate = preferred + offset
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
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
    parser = argparse.ArgumentParser(description="RotoFox backend")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help="Preferred port")
    parser.add_argument("--no-auth", action="store_true", help="Disable the session token (development only)")
    parser.add_argument("--reload", action="store_true", help="Enable autoreload (development only)")
    args = parser.parse_args()

    port = find_free_port(args.port)

    token = ""
    if not args.no_auth:
        token = generate_session_token()
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
