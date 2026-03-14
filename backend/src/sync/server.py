import logging

from app import socketio
from app.auth import is_authenticated
from flask import request
from flask_socketio import join_room, leave_room

from sync.chat import handlers as chat_handlers  # noqa: F401
from sync.chat.history import emit_history
from sync.state import playback_state
from sync.timebase import server_now_ms
from sync.voice import handlers as voice_handlers  # noqa: F401
from sync.voice.state import voice_state

ROOM = "shared-room"
logger = logging.getLogger(__name__)
MAX_EVENT_AGE_MS = 5000
MAX_FUTURE_EVENT_MS = 250
HEARTBEAT_CORRECTION_THRESHOLD_MS = 2000


@socketio.on("connect")
def handle_connect(auth=None):
    if not is_authenticated():
        return False  # disconnect
    join_room(ROOM)
    # New joiners always start from the server's latest snapshot, then project
    # it locally on the client. This keeps late joiners aligned with the room.
    socketio.emit("state", playback_state.snapshot(server_now_ms()), room=request.sid)
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
    payload = payload or {}
    event_type = payload.get("type")
    position_ms = _coerce_int(payload.get("position_ms"))
    server_recv_ms = server_now_ms()

    # Clients estimate when the event happened on the server timeline using
    # heartbeat-derived clock offset. Clamp the estimate so a bad client clock
    # cannot inject implausible timestamps.
    event_server_ms = _clamp_event_server_ms(
        _coerce_int(payload.get("event_server_ms_est")),
        server_recv_ms,
    )
    if _is_stale_control(event_server_ms):
        logger.info(
            "dropping_stale_control sid=%s type=%s event_server_ms=%s last_event_server_ms=%s",
            request.sid,
            event_type,
            event_server_ms,
            playback_state.last_event_server_ms,
        )
        return None
    update = playback_state.apply(
        event_type,
        position_ms,
        actor=request.sid,
        event_server_ms=event_server_ms,
    )
    if update:
        # Control messages do not return state through the ack path anymore.
        # The room broadcast is the single source of truth for every client.
        emitted_state = playback_state.snapshot(server_now_ms())
        socketio.emit("state", emitted_state, room=ROOM)
        return None
    return None


@socketio.on("heartbeat")
def handle_heartbeat(payload):
    if not is_authenticated():
        return False
    payload = payload or {}

    server_recv_ms = server_now_ms()
    heartbeat = _build_heartbeat(payload)
    drift_ms = _position_drift_ms(heartbeat)
    snapshot = playback_state.snapshot(server_recv_ms)
    logger.info(
        "playback_heartbeat drift_ms=%s heartbeat=%s state=%s",
        drift_ms,
        heartbeat,
        snapshot,
    )
    ack = {
        "ok": True,
        "client_sent_mono_ms": heartbeat.get("client_sent_mono_ms"),
        "server_recv_ms": server_recv_ms,
        "server_send_ms": server_now_ms(),
    }
    if drift_ms is not None and abs(drift_ms) > HEARTBEAT_CORRECTION_THRESHOLD_MS:
        ack["correction"] = snapshot
    return ack


def _coerce_int(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _build_heartbeat(payload: dict) -> dict:
    # Heartbeats carry both playback observations and the local monotonic clock
    # sample used to solve the client->server time mapping.
    return {
        "actor": request.sid,
        "url": payload.get("url"),
        "status": payload.get("status"),
        "position_ms": _coerce_int(payload.get("position_ms")),
        "observed_server_ms_est": _coerce_int(payload.get("observed_server_ms_est")),
        "client_sent_mono_ms": _coerce_int(payload.get("client_sent_mono_ms")),
    }


def _position_drift_ms(heartbeat: dict) -> int | None:
    heartbeat_pos = heartbeat.get("position_ms")
    observed_server_ms = heartbeat.get("observed_server_ms_est")
    if observed_server_ms is None or heartbeat_pos is None or playback_state.video_url is None:
        return None

    # Compare the client's observed position against where the room should be
    # on the same server timeline, not against "server receive time".
    expected_pos = playback_state.position_at(observed_server_ms)
    return int(heartbeat_pos - expected_pos)


def _clamp_event_server_ms(event_server_ms: int | None, server_recv_ms: int) -> int:
    if event_server_ms is None:
        return server_recv_ms
    lower_bound = server_recv_ms - MAX_EVENT_AGE_MS
    upper_bound = server_recv_ms + MAX_FUTURE_EVENT_MS
    return max(lower_bound, min(upper_bound, event_server_ms))


def _is_stale_control(event_server_ms: int) -> bool:
    last_event_server_ms = playback_state.last_event_server_ms
    if last_event_server_ms is None:
        return False
    return event_server_ms < last_event_server_ms
