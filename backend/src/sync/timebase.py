"""Stable server-side time helpers for sync calculations.

The sync protocol needs a server-owned time axis that can be shared with
clients. We expose an epoch-like millisecond clock built on top of the
process monotonic clock so local NTP/clock jumps do not distort playback math.
"""

from __future__ import annotations

import time

_SERVER_TIME_ANCHOR_MS = int(time.time() * 1000) - int(time.monotonic() * 1000)


def server_now_ms() -> int:
    """Return the current server time in integer milliseconds."""
    return _SERVER_TIME_ANCHOR_MS + int(time.monotonic() * 1000)
