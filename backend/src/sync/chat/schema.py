"""Validation and normalization helpers for chat messages."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

MAX_CONTENT_LENGTH = 500
MIN_CONTENT_LENGTH = 1


class ValidationError(Exception):
    """Raised when chat payload fails validation."""


@dataclass(frozen=True)
class NormalizedMessage:
    """Normalized chat message payload after validation."""

    message_id: str
    sender_id: str
    sender_label: str
    content: str
    sent_at: str
    client_reported_at: str | None

    def to_dict(self) -> dict[str, Any]:
        return {
            "message_id": self.message_id,
            "sender_id": self.sender_id,
            "sender_label": self.sender_label,
            "content": self.content,
            "sent_at": self.sent_at,
            "client_reported_at": self.client_reported_at,
            "delivery_status": "sent",
        }


def _validate_content(raw: Any) -> str:
    if raw is None:
        raise ValidationError("content_missing")
    content = str(raw).strip()
    length = len(content)
    if length < MIN_CONTENT_LENGTH:
        raise ValidationError("content_empty")
    if length > MAX_CONTENT_LENGTH:
        raise ValidationError("content_too_long")
    return content


def normalize_message_payload(
    payload: dict[str, Any],
    sender_id: str,
    sender_label: str,
    *,
    message_id: str | None = None,
    clock: datetime | None = None,
) -> NormalizedMessage:
    """Validate and normalize an incoming chat payload."""
    content = _validate_content(payload.get("content"))
    msg_id = message_id or payload.get("message_id") or str(uuid4())
    client_ts = payload.get("client_reported_at")
    if client_ts is not None:
        client_ts = str(client_ts)

    now = clock or datetime.now(timezone.utc)
    sent_at = now.isoformat().replace("+00:00", "Z")

    return NormalizedMessage(
        message_id=str(msg_id),
        sender_id=sender_id,
        sender_label=sender_label,
        content=content,
        sent_at=sent_at,
        client_reported_at=client_ts,
    )
