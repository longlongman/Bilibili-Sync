from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _format_timestamp(value: datetime) -> str:
    return value.isoformat().replace("+00:00", "Z")


def _parse_timestamp(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        normalized = value.replace("Z", "+00:00")
        parsed = datetime.fromisoformat(normalized)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    except ValueError:
        return None


@dataclass
class PlaybackState:
    video_url: Optional[str] = None
    status: str = "paused"
    position_ms: int = 0
    last_actor: Optional[str] = None
    last_event_at: Optional[str] = None

    def current_position_ms(self, at_time: datetime | None = None) -> int:
        position = max(0, int(self.position_ms or 0))
        event_time = _parse_timestamp(self.last_event_at)
        target_time = at_time or _utcnow()
        if self.status != "playing" or event_time is None:
            return position
        elapsed_ms = (target_time - event_time).total_seconds() * 1000
        if elapsed_ms > 0:
            position += int(elapsed_ms)
        return max(0, position)

    def snapshot(self) -> dict:
        state_at = _utcnow()
        state_at_ms = int(state_at.timestamp() * 1000)
        position_ms = self.current_position_ms(state_at)
        return {
            "url": self.video_url,
            "status": self.status,
            "position_ms": position_ms,
            "actor": self.last_actor,
            "state_at_ms": state_at_ms,
            "state_at": _format_timestamp(state_at),
            "reported_at": _format_timestamp(state_at),
        }

    def set_video(self, url: str):
        self.video_url = url
        self.position_ms = 0
        self.status = "paused"
        self.last_actor = None
        self.last_event_at = _format_timestamp(_utcnow())

    def apply(
        self,
        event_type: str,
        position_ms: Optional[int],
        actor: Optional[str],
        reported_at: Optional[str] = None,
    ) -> Optional[dict]:
        if event_type not in {"play", "pause", "seek"}:
            return None
        if event_type == "seek" and position_ms is not None:
            self.position_ms = max(0, int(position_ms))
        if event_type in {"play", "pause"}:
            self.status = "playing" if event_type == "play" else "paused"
            if position_ms is not None:
                self.position_ms = max(0, int(position_ms))
        if position_ms is None and self.position_ms < 0:
            self.position_ms = 0
        self.last_actor = actor
        self.last_event_at = _format_timestamp(_utcnow())
        return self.snapshot()


playback_state = PlaybackState()
