"""In-memory ring buffer for chat messages."""

from __future__ import annotations

import threading
from collections import deque
from typing import Iterable

DEFAULT_CAPACITY = 200
DEFAULT_HISTORY_LIMIT = 50


class ChatStore:
    """Stores recent chat messages in-memory with dedupe and bounded capacity."""

    def __init__(self, capacity: int = DEFAULT_CAPACITY):
        self.capacity = max(1, capacity)
        self._messages: deque[dict] = deque()
        self._by_id: dict[str, dict] = {}
        self._lock = threading.Lock()

    def append(self, message: dict) -> dict:
        """Append a message unless its id already exists. Returns stored message."""
        message_id = str(message.get("message_id"))
        if not message_id:
            raise ValueError("message_id required")

        with self._lock:
            if message_id in self._by_id:
                return self._by_id[message_id]

            if len(self._messages) >= self.capacity:
                oldest = self._messages.popleft()
                self._by_id.pop(str(oldest.get("message_id")), None)

            self._messages.append(message)
            self._by_id[message_id] = message
            return message

    def latest(self, limit: int = DEFAULT_HISTORY_LIMIT) -> list[dict]:
        """Return newest-last list of recent messages up to limit."""
        limit = max(0, limit)
        with self._lock:
            if limit == 0:
                return []
            slice_start = max(0, len(self._messages) - limit)
            return list(self._messages)[slice_start:]

    def __len__(self) -> int:  # pragma: no cover - convenience
        with self._lock:
            return len(self._messages)

    def all_ids(self) -> set[str]:  # pragma: no cover - debug aid
        with self._lock:
            return set(self._by_id.keys())

    def clear(self) -> None:
        with self._lock:
            self._messages.clear()
            self._by_id.clear()


def append_many(store: ChatStore, messages: Iterable[dict]) -> None:
    """Append a batch of messages (helper for tests/initialization)."""
    for msg in messages:
        store.append(msg)
