"""History helpers for chat messages."""

from __future__ import annotations

from typing import Any

from app import socketio
from sync.chat.context import chat_store

DEFAULT_HISTORY_LIMIT = 50


def _coerce_limit(raw: Any) -> int:
    """Clamp an arbitrary history limit to the supported range."""
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return DEFAULT_HISTORY_LIMIT
    return min(max(1, value), DEFAULT_HISTORY_LIMIT)


def get_history(limit: Any = DEFAULT_HISTORY_LIMIT) -> list[dict]:
    """Fetch recent room history with the same limit coercion as the API."""
    return chat_store.latest(_coerce_limit(limit))


def emit_history(sid: str, limit: Any = DEFAULT_HISTORY_LIMIT) -> None:
    """Emit recent chat history to a single socket connection."""
    messages = get_history(limit)
    socketio.emit("chat:history", {"messages": messages}, room=sid)
