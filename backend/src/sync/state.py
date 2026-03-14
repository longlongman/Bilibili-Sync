from __future__ import annotations

from dataclasses import dataclass
from typing import Optional


@dataclass
class PlaybackState:
    """Single-room playback state tracked on the server timeline."""

    video_url: Optional[str] = None
    status: str = "paused"
    position_ms: int = 0
    last_actor: Optional[str] = None
    last_event_server_ms: Optional[int] = None
    revision: int = 0

    def reset(self) -> None:
        """Clear all state so tests can start from a known baseline."""
        self.video_url = None
        self.status = "paused"
        self.position_ms = 0
        self.last_actor = None
        self.last_event_server_ms = None
        self.revision = 0

    def snapshot(self, emitted_server_ms: int) -> dict:
        """Serialize the last authoritative event plus emission metadata.

        `position_ms` is the position at `server_state_at_ms`, not "right now".
        Clients project it forward to their current server-time estimate before
        rendering so network delay does not make every viewer start behind.
        """
        return {
            "url": self.video_url,
            "status": self.status,
            "position_ms": self.position_ms,
            "actor": self.last_actor,
            "server_state_at_ms": self.last_event_server_ms,
            "server_sent_ms": emitted_server_ms,
            "revision": self.revision,
        }

    def set_video(self, url: str, event_server_ms: int, actor: Optional[str] = None) -> dict:
        """Reset playback around a newly selected video."""
        self.video_url = url
        self.position_ms = 0
        self.status = "paused"
        self.last_actor = actor
        self.last_event_server_ms = event_server_ms
        self.revision += 1
        return self.snapshot(event_server_ms)

    def position_at(self, target_server_ms: Optional[int]) -> int:
        """Project the known state to another point on the server timeline.

        When the room is playing we treat `position_ms` as the base position at
        `last_event_server_ms` and add elapsed server time. When paused, the
        base position is already the current position.
        """
        position = self.position_ms or 0
        if (
            self.status == "playing"
            and self.last_event_server_ms is not None
            and target_server_ms is not None
        ):
            elapsed_ms = target_server_ms - self.last_event_server_ms
            if elapsed_ms > 0:
                position += elapsed_ms
        return int(max(0, position))

    def apply(
        self,
        event_type: str,
        position_ms: Optional[int],
        actor: Optional[str],
        event_server_ms: int,
    ) -> Optional[dict]:
        """Apply a control event that has already been projected onto server time.

        The caller is responsible for translating client observations to the
        server time axis. Once we get here, state mutation is intentionally
        simple: accept the new position/status, stamp it with server time, and
        bump the revision used by clients for stale-state protection.
        """
        if event_type not in {"play", "pause", "seek"}:
            return None
        if self.video_url is None:
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
        self.last_event_server_ms = event_server_ms
        self.revision += 1
        return self.snapshot(event_server_ms)

playback_state = PlaybackState()
