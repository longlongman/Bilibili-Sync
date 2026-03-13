"""Per-participant chat rate limiting helpers."""

from __future__ import annotations

from collections import deque
from datetime import datetime, timedelta, timezone
from typing import Deque


class RateLimitResult:
    def __init__(self, allowed: bool, code: str | None = None, retry_after_s: float | None = None):
        self.allowed = allowed
        self.code = code
        self.retry_after_s = retry_after_s


class RateLimiter:
    """Track per-participant send cadence with min-interval and per-minute caps."""

    def __init__(self, min_interval_s: float = 1.0, max_per_minute: int = 10):
        self.min_interval = max(0.0, float(min_interval_s))
        self.max_per_minute = max(1, int(max_per_minute))
        self._events: dict[str, Deque[datetime]] = {}

    def check(self, participant_id: str, *, now: datetime | None = None) -> RateLimitResult:
        now = now or datetime.now(timezone.utc)
        history = self._events.setdefault(participant_id, deque())

        # Drop events older than 60s
        cutoff = now - timedelta(seconds=60)
        while history and history[0] < cutoff:
            history.popleft()

        if history:
            delta = (now - history[-1]).total_seconds()
            if delta < self.min_interval:
                return RateLimitResult(
                    allowed=False,
                    code="rate_limit_min_interval",
                    retry_after_s=max(0.0, self.min_interval - delta),
                )

        if len(history) >= self.max_per_minute:
            oldest = history[0]
            retry_after = max(0.0, 60 - (now - oldest).total_seconds())
            return RateLimitResult(
                allowed=False,
                code="rate_limit_per_minute",
                retry_after_s=retry_after,
            )

        history.append(now)
        return RateLimitResult(allowed=True)
