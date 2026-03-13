"""Voice chat Socket.IO event handlers."""

from __future__ import annotations

import logging

from flask import request

from app import socketio
from app.auth import is_authenticated
from sync.voice.state import voice_state

logger = logging.getLogger(__name__)


def _sender_label() -> str:
    sid = request.sid or "anonymous"
    return f"User-{sid[-6:]}"


@socketio.on("voice:join")
def handle_voice_join(payload=None):
    """Handle user joining voice chat."""
    if not is_authenticated():
        return {"ok": False, "error": "unauthorized"}

    sid = request.sid
    label = _sender_label()

    if voice_state.is_in_voice(sid):
        # Already in voice, return current participants
        participants = [
            {"sid": p.sid, "label": p.label}
            for p in voice_state.get_all_participants()
        ]
        return {"ok": True, "participants": participants}

    voice_state.add_participant(sid, label)
    participants = [
        {"sid": p.sid, "label": p.label}
        for p in voice_state.get_all_participants()
    ]

    # Broadcast to all users that someone joined
    socketio.emit(
        "voice:user_joined",
        {"sid": sid, "label": label, "participants": participants},
    )

    logger.info("User %s joined voice chat", label)
    return {"ok": True, "participants": participants}


@socketio.on("voice:leave")
def handle_voice_leave(payload=None):
    """Handle user leaving voice chat."""
    if not is_authenticated():
        return {"ok": False, "error": "unauthorized"}

    sid = request.sid
    participant = voice_state.remove_participant(sid)

    if participant is None:
        return {"ok": True, "message": "not in voice"}

    participants = [
        {"sid": p.sid, "label": p.label}
        for p in voice_state.get_all_participants()
    ]

    # Broadcast to all users that someone left
    socketio.emit(
        "voice:user_left",
        {"sid": sid, "label": participant.label, "participants": participants},
    )

    logger.info("User %s left voice chat", participant.label)
    return {"ok": True, "participants": participants}


@socketio.on("voice:signal")
def handle_voice_signal(payload):
    """Handle WebRTC signaling - forward to target user."""
    if not is_authenticated():
        return {"ok": False, "error": "unauthorized"}

    target_sid = payload and payload.get("target_sid")
    signal_data = payload and payload.get("data")

    if not target_sid or not signal_data:
        return {"ok": False, "error": "invalid payload"}

    logger.info("Voice signal: from=%s to=%s type=%s", request.sid, target_sid, signal_data.get("type") if signal_data else "unknown")

    # Validate target is in voice
    if not voice_state.is_in_voice(target_sid):
        logger.warning("Voice signal target not in voice: %s", target_sid)
        return {"ok": False, "error": "target not in voice"}

    # Forward the signal to the target user
    socketio.emit(
        "voice:signal",
        {
            "from_sid": request.sid,
            "data": signal_data,
        },
        room=target_sid,
    )

    return {"ok": True}