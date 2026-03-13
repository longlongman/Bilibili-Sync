"""Socket.IO chat event handlers."""

from __future__ import annotations

import logging
from flask import request

from app import socketio
from app.auth import is_authenticated
from sync.chat.context import chat_store, rate_limiter
from sync.chat.schema import ValidationError, normalize_message_payload
from sync import metrics

CHAT_ROOM = "shared-room"
logger = logging.getLogger(__name__)

def _sender_label() -> str:
    sid = request.sid or "anonymous"
    return f"User-{sid[-6:]}"


@socketio.on("chat:send")
def handle_chat_send(payload):
    if not is_authenticated():
        return {"ok": False, "error": "unauthorized"}

    payload = payload or {}
    sender_id = request.sid or "anonymous"
    sender_label = payload.get("sender_label") or _sender_label()

    try:
        normalized = normalize_message_payload(payload, sender_id=sender_id, sender_label=sender_label)
    except ValidationError as err:
        metrics.record_chat_error(str(err), detail="validation")
        return {"ok": False, "error": str(err)}

    rate = rate_limiter.check(sender_id)
    if not rate.allowed:
        metrics.record_chat_error(rate.code or "rate_limit", detail="chat_send")
        return {
            "ok": False,
            "error": "rate_limited",
            "code": rate.code,
            "retry_after_s": rate.retry_after_s,
        }

    message = normalized.to_dict()
    stored = chat_store.append(message)
    if stored is not message:
        metrics.record_chat_error("duplicate_message", detail=stored.get("message_id"))
    socketio.emit("chat:message", stored, room=CHAT_ROOM)
    metrics.record_chat_send(message_id=stored["message_id"], sender_id=sender_id)
    return {"ok": True, "message": stored}
