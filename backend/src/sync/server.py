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
    if not is_authenticated():
        return False  # disconnect
    join_room(ROOM)
    socketio.emit("state", playback_state.snapshot(), room=request.sid)
    emit_history(request.sid)


@socketio.on("disconnect")
def handle_disconnect():
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
    if not is_authenticated():
        return False
    event_type = payload.get("type")
    position_ms = payload.get("position_ms")
    reported_at = payload.get("reported_at")
    update = playback_state.apply(event_type, position_ms, actor=request.sid, reported_at=reported_at)
    if update:
        socketio.emit("state", update, room=ROOM)


@socketio.on("heartbeat")
def handle_heartbeat(payload):
    if not is_authenticated():
        return False
    payload = payload or {}

    heartbeat = _build_heartbeat(payload)
    drift_ms = _position_drift_ms(heartbeat)
    snapshot = playback_state.snapshot()
    logger.info(
        "playback_heartbeat drift_ms=%s heartbeat=%s state=%s",
        drift_ms,
        heartbeat,
        snapshot,
    )
    if drift_ms is not None and abs(drift_ms) > 2000:
        corrected_at = datetime.now(timezone.utc)
        corrected_snapshot = dict(snapshot)
        corrected_snapshot["position_ms"] = _expected_position_ms_at(corrected_at)
        corrected_snapshot["reported_at"] = corrected_at.isoformat().replace("+00:00", "Z")
        socketio.emit("state", corrected_snapshot, room=request.sid)


def _coerce_int(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _parse_iso8601(timestamp: str | None) -> datetime | None:
    if not timestamp:
        return None
    try:
        ts = timestamp
        if isinstance(ts, str) and ts.endswith("Z"):
            ts = ts.replace("Z", "+00:00")
        dt = datetime.fromisoformat(ts)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except ValueError:
        return None


def _build_heartbeat(payload: dict) -> dict:
    return {
        "actor": request.sid,
        "url": payload.get("url"),
        "status": payload.get("status"),
        "position_ms": _coerce_int(payload.get("position_ms")),
        "reported_at": payload.get("reported_at"),
    }


def _position_drift_ms(heartbeat: dict) -> int | None:
    heartbeat_at = _parse_iso8601(heartbeat.get("reported_at"))
    heartbeat_pos = heartbeat.get("position_ms")
    state_at = _parse_iso8601(playback_state.last_event_at)
    if heartbeat_at is None or heartbeat_pos is None or state_at is None:
        return None

    expected_pos = _expected_position_ms_at(heartbeat_at)

    return int(heartbeat_pos - expected_pos)


def _expected_position_ms_at(target_time: datetime | None) -> int:
    position = playback_state.position_ms or 0
    state_at = _parse_iso8601(playback_state.last_event_at)
    if playback_state.status == "playing" and state_at and target_time:
        elapsed_ms = (target_time - state_at).total_seconds() * 1000
        if elapsed_ms > 0:
            position += elapsed_ms
    return int(max(0, position))
