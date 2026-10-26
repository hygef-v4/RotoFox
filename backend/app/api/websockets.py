"""WebSocket communication for RotoFox.

Carries every real-time interaction between the editor UI and the AI engine:
prompts, propagation, model management and export.

Two protections wrap the handler, both absent before:

* **Authentication.** Browsers do not apply the same-origin policy to
  WebSocket *connect* attempts, so any page the user had open could reach
  ``ws://127.0.0.1:8000/ws/editor`` while RotoFox was running and drive the
  backend — writing exports to arbitrary paths, opening arbitrary folders,
  starting multi-gigabyte downloads or deleting the user's masks. Connections
  now require the per-session token and an allowed ``Origin``.

* **Job serialisation.** ``track_forward`` and ``export`` used to spawn a task
  unconditionally. Two propagations over one SAM 2 inference state interleaved
  writes into its memory bank and produced corrupt masks.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import logging
import os
import platform
import subprocess
from pathlib import Path
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.api.connection import manager
from app.core.logging_config import tail_log
from app.core.security import is_origin_allowed, verify_token
from app.services.ai_engine import AIEngine
from app.services.cache_manager import CacheManager
from app.services.model_manager import TRACKING_MODEL_IDS, DownloadCancelled, ModelManager

logger = logging.getLogger(__name__)
router = APIRouter()

ai_engine = AIEngine(auto_init=False)

# Close codes
CLOSE_POLICY_VIOLATION = 1008
CLOSE_TRY_AGAIN_LATER = 1013


def _open_in_file_manager(path: Path) -> None:
    """Reveal a directory in the host file manager."""
    system = platform.system()
    if system == "Windows":
        os.startfile(str(path))  # noqa: S606 - directory, validated by the caller
    elif system == "Darwin":
        subprocess.run(["open", str(path)], check=False)
    else:
        subprocess.run(["xdg-open", str(path)], check=False)


def _resolve_openable_directory(raw: str) -> Path:
    """Validate a directory the client asked to reveal.

    Only directories may be opened, and only ones the user could plausibly have
    chosen. On Windows ``os.startfile`` on a *file* launches it with its default
    application, so accepting an arbitrary path here would turn "reveal folder"
    into "execute this".

    Raises:
        ValueError: If the path is missing, is not a directory, or is not
            inside an allowed root.
    """
    checkpoints_dir = ModelManager.get_checkpoints_dir().resolve()
    if not raw:
        return checkpoints_dir

    candidate = Path(raw).expanduser().resolve()
    if not candidate.is_dir():
        raise ValueError(f"Not a directory: {candidate}")

    allowed_roots = [
        checkpoints_dir,
        Path.home().resolve(),
        CacheManager.base_dir().resolve(),
    ]
    for root in allowed_roots:
        try:
            candidate.relative_to(root)
            return candidate
        except ValueError:
            continue

    raise ValueError(f"Refusing to open a folder outside your home directory: {candidate}")


@router.websocket("/ws/editor")
async def websocket_endpoint(websocket: WebSocket) -> None:
    """Handle the editor's WebSocket session."""
    origin = websocket.headers.get("origin")
    if not is_origin_allowed(origin):
        logger.warning("Rejected WebSocket connection from origin %s", origin)
        await websocket.close(code=CLOSE_POLICY_VIOLATION)
        return

    token = websocket.query_params.get("token")
    if not verify_token(token):
        logger.warning("Rejected WebSocket connection with an invalid session token")
        await websocket.close(code=CLOSE_POLICY_VIOLATION)
        return

    await websocket.accept()

    if not await manager.register(websocket):
        logger.warning("Refused a second editor connection")
        await websocket.send_json({
            "status": "error",
            "code": "session_in_use",
            "message": "Another RotoFox editor window is already connected to this backend.",
        })
        await websocket.close(code=CLOSE_TRY_AGAIN_LATER)
        return

    logger.info("Editor connected")
    session_video_id: str | None = None

    async def send(payload: dict[str, Any]) -> None:
        await websocket.send_json(payload)

    try:
        while True:
            data = await websocket.receive_json()
            action = data.get("action")
            logger.debug("Action received: %s", action)

            # ── Session ───────────────────────────────────────────────────
            if action == "set_video_id":
                video_id = data.get("video_id")
                if not video_id:
                    continue
                session_video_id = video_id
                try:
                    await asyncio.to_thread(ai_engine.ensure_initialized)
                    if ai_engine.predictor is None:
                        await send({
                            "status": "error",
                            "message": "No SAM 2 model is active. Activate one in the Model Hub.",
                        })
                    elif ai_engine.inference_state is None or ai_engine.video_id != video_id:
                        await asyncio.to_thread(ai_engine.load_video, video_id)
                    await send({
                        "status": "video_loaded",
                        "video_id": video_id,
                        "width": ai_engine.video_width,
                        "height": ai_engine.video_height,
                        "frames_count": ai_engine.frame_count,
                    })
                except (RuntimeError, ValueError) as exc:
                    logger.error("Could not load video state: %s", exc)
                    await send({"status": "error", "message": str(exc)})

            # ── Model hub ─────────────────────────────────────────────────
            elif action == "get_system_info":
                try:
                    info = ModelManager.get_system_info()
                    info["active_model"] = ai_engine.active_model_id
                    await send({"status": "system_info", "system_info": info})
                except Exception as exc:  # noqa: BLE001
                    logger.exception("get_system_info failed")
                    await send({"status": "error", "message": str(exc)})

            elif action == "download_model":
                model_id = data.get("model_id")

                async def report(percent: int, done: int, total: int, _mid=model_id) -> None:
                    await send({
                        "status": "download_progress",
                        "model_id": _mid,
                        "progress": percent,
                        "downloaded_mb": round(done / 1024 ** 2, 1),
                        "total_mb": round(total / 1024 ** 2, 1),
                    })

                async def do_download(_mid=model_id) -> None:
                    try:
                        await ModelManager.download_model_async(_mid, report)
                        if ai_engine.predictor is None and _mid in TRACKING_MODEL_IDS:
                            with contextlib.suppress(Exception):
                                await asyncio.to_thread(ai_engine.load_model, _mid)
                        await send({"status": "download_completed", "model_id": _mid})
                    except DownloadCancelled:
                        await send({"status": "download_cancelled", "model_id": _mid})
                    except Exception as exc:  # noqa: BLE001
                        logger.exception("Download of %s failed", _mid)
                        await send({
                            "status": "download_error",
                            "model_id": _mid,
                            "message": str(exc),
                        })

                asyncio.create_task(do_download())

            elif action == "cancel_download":
                ModelManager.cancel_download()

            elif action == "load_model":
                model_id = data.get("model_id")
                try:
                    await asyncio.to_thread(ai_engine.load_model, model_id)
                    if ai_engine.video_id:
                        try:
                            await asyncio.to_thread(ai_engine.load_video, ai_engine.video_id)
                        except RuntimeError as exc:
                            logger.warning("Could not re-init video after model swap: %s", exc)
                    await send({"status": "model_loaded", "model_id": model_id})
                except (RuntimeError, ValueError, FileNotFoundError) as exc:
                    logger.error("load_model failed: %s", exc)
                    await send({"status": "error", "message": str(exc)})

            elif action == "set_checkpoints_dir":
                try:
                    ModelManager.save_config(data.get("checkpoints_dir", ""))
                    ai_engine._init_model()  # noqa: SLF001 - deliberate re-scan
                    info = ModelManager.get_system_info()
                    info["active_model"] = ai_engine.active_model_id
                    await send({"status": "system_info", "system_info": info})
                except (ValueError, OSError) as exc:
                    logger.error("set_checkpoints_dir failed: %s", exc)
                    await send({"status": "error", "message": str(exc)})

            elif action == "open_directory":
                try:
                    target = _resolve_openable_directory(str(data.get("directory", "") or ""))
                    await asyncio.to_thread(_open_in_file_manager, target)
                except (ValueError, OSError) as exc:
                    logger.warning("open_directory refused: %s", exc)
                    await send({"status": "error", "message": str(exc)})

            # ── Prompting ─────────────────────────────────────────────────
            elif action == "click":
                if not session_video_id:
                    await send({
                        "status": "error",
                        "message": "No video is linked to this session. Import a video first.",
                    })
                    continue
                if ai_engine.state.is_busy:
                    await send({
                        "status": "error",
                        "message": "Please wait for the current job to finish.",
                    })
                    continue

                try:
                    mask_b64 = await asyncio.to_thread(
                        ai_engine.add_point_or_box,
                        frame_idx=int(data.get("frame_idx", 0)),
                        obj_id=int(data.get("obj_id", 1)),
                        points=data.get("points") or [],
                        labels=data.get("labels") or [],
                        box=data.get("box"),
                    )
                    await send({
                        "status": "received",
                        "frame": int(data.get("frame_idx", 0)),
                        "obj_id": int(data.get("obj_id", 1)),
                        "mask_base64": mask_b64,
                    })
                except (RuntimeError, ValueError) as exc:
                    logger.error("click failed: %s", exc)
                    await send({"status": "error", "message": str(exc)})

            elif action == "clear_clicks":
                try:
                    await asyncio.to_thread(ai_engine.clear_all_prompts)
                    await send({
                        "status": "mask_update",
                        "frame": int(data.get("frame_idx", 0)),
                        "mask_base64": None,
                        "cleared": True,
                    })
                except Exception as exc:  # noqa: BLE001
                    logger.exception("clear_clicks failed")
                    await send({"status": "error", "message": str(exc)})

            elif action == "remove_object":
                frame_idx = int(data.get("frame_idx", 0))
                try:
                    mask_b64, remaining = await asyncio.to_thread(
                        ai_engine.remove_object, int(data.get("obj_id", 1)), frame_idx
                    )
                    # Always sent, including when the mask is None, so the canvas
                    # clears the removed layer instead of leaving it on screen.
                    await send({
                        "status": "mask_update",
                        "frame": frame_idx,
                        "mask_base64": mask_b64,
                        "remaining_objects": remaining,
                    })
                except Exception as exc:  # noqa: BLE001
                    logger.exception("remove_object failed")
                    await send({"status": "error", "message": str(exc)})

            # ── Tracking ──────────────────────────────────────────────────
            elif action == "track_forward":
                if ai_engine.state.is_busy:
                    await send({
                        "status": "error",
                        "message": "A job is already running. Stop it before starting another.",
                    })
                    continue
                if ai_engine.inference_state is None:
                    await send({
                        "status": "error",
                        "message": "No video is loaded. Import a video and click your subject first.",
                    })
                    continue

                reverse = bool(data.get("reverse", False))
                total_frames = int(data.get("total_frames") or ai_engine.frame_count or 0)
                start_frame = data.get("start_frame")
                start_frame = int(start_frame) if start_frame is not None else None

                ai_engine.state.start_tracking(data.get("video_id"), total_frames)
                asyncio.create_task(ai_engine.run_propagation(send, start_frame, reverse))

            elif action == "cancel_tracking":
                ai_engine.state.request_cancel()

            # ── Export ────────────────────────────────────────────────────
            elif action == "export":
                if ai_engine.state.is_busy:
                    await send({
                        "status": "export_error",
                        "message": "A job is already running. Wait for it to finish.",
                    })
                    continue
                ai_engine.state.start_export()
                asyncio.create_task(ai_engine.run_export(send, data))

            elif action == "cancel_export":
                ai_engine.state.request_cancel()

            # ── Masks ─────────────────────────────────────────────────────
            elif action == "get_mask":
                frame_idx = int(data.get("frame_idx", 0))
                if not ai_engine.video_id:
                    await send({"status": "mask_update", "frame": frame_idx, "mask_base64": None})
                    continue

                mask_path = CacheManager.get_mask_dir(ai_engine.video_id) / f"{frame_idx:05d}.png"

                def read_mask(path: Path = mask_path) -> str | None:
                    if not path.exists():
                        return None
                    with open(path, "rb") as handle:
                        return base64.b64encode(handle.read()).decode("utf-8")

                try:
                    payload = await asyncio.to_thread(read_mask)
                    await send({"status": "mask_update", "frame": frame_idx, "mask_base64": payload})
                except OSError as exc:
                    logger.error("get_mask failed: %s", exc)
                    await send({"status": "mask_update", "frame": frame_idx, "mask_base64": None})

            # ── Diagnostics ───────────────────────────────────────────────
            elif action == "get_logs":
                await send({"status": "logs", "content": await asyncio.to_thread(tail_log, 300)})

            else:
                logger.warning("Unknown action: %s", action)

    except WebSocketDisconnect:
        logger.info("Editor disconnected")
    except Exception as exc:  # noqa: BLE001
        logger.exception("WebSocket handler crashed: %s", exc)
    finally:
        ai_engine.state.request_cancel()
        await manager.unregister(websocket)
