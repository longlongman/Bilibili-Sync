import logging
from datetime import datetime, timezone

from app import socketio
from app.auth import is_authenticated
from flask import request
from flask_socketio import join_room, leave_room

from sync.chat.history import emit_history
from sync.chat import handlers as chat_handlers  # noqa: F401
from sync.voice import handlers as voice_handlers  # noqa: F401
from sync.voice.state import voice_state
from sync.state import playback_state

ROOM = "shared-room"
logger = logging.getLogger(__name__)


@socketio.on("connect")
def handle_connect(auth=None):
    """Authenticate the socket, join the shared room, and send initial state."""
    if not is_authenticated():
        return False  # disconnect
    join_room(ROOM)
    socketio.emit("state", playback_state.snapshot(), room=request.sid)
    emit_history(request.sid)


@socketio.on("disconnect")
def handle_disconnect():
    """Leave the shared room and clean up any voice chat membership."""
    leave_room(ROOM)
    # Clean up voice state
    participant = voice_state.remove_participant(request.sid)
    if participant:
        participants = [
            {"sid": p.sid, "label": p.label}
            for p in voice_state.get_all_participants()
        ]
        socketio.emit(
            "voice:user_left",
            {"sid": request.sid, "label": participant.label, "participants": participants},
        )


@socketio.on("control")
def handle_control(payload):
    """Apply a playback control event and broadcast the resulting room state."""
    if not is_authenticated():
        return False
    payload = payload or {}
    event_type = payload.get("type")
    position_ms = payload.get("position_ms")
    update = playback_state.apply(event_type, position_ms, actor=request.sid)
    if update:
        socketio.emit("state", update, room=ROOM)


@socketio.on("heartbeat")
def handle_heartbeat(payload):
    """Acknowledge a heartbeat so the client can update its clock offset."""
    if not is_authenticated():
        return False
    payload = payload or {}

    heartbeat = _build_heartbeat(payload)
    logger.info(
        "playback_heartbeat heartbeat=%s",
        heartbeat,
    )
    return {
        "server_now_ms": _server_now_ms(),
    }


@socketio.on("sync:resync")
def handle_resync(payload=None):
    """Send the requester a fresh playback snapshot on explicit resync demand."""
    if not is_authenticated():
        return False
    snapshot = playback_state.snapshot()
    socketio.emit("state", snapshot, room=request.sid)
    return {"ok": True}


def _coerce_int(value):
    """Best-effort convert untrusted payload values into integers."""
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _build_heartbeat(payload: dict) -> dict:
    """Normalize the subset of heartbeat fields used for logging and debugging."""
    return {
        "actor": request.sid,
        "url": payload.get("url"),
        "status": payload.get("status"),
        "position_ms": _coerce_int(payload.get("position_ms")),
        "client_perf_sent_ms": payload.get("client_perf_sent_ms"),
    }


def _server_now_ms() -> int:
    """Return the current server time as a UTC millisecond timestamp."""
    return int(datetime.now(timezone.utc).timestamp() * 1000)
