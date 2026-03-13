import logging
import time
from contextlib import contextmanager
from typing import Iterator

logger = logging.getLogger(__name__)


def record_latency(event: str, duration_ms: float) -> None:
    """Log a latency measurement for a named sync event."""
    logger.info("sync_latency", extra={"event": event, "duration_ms": duration_ms})


def record_error(event: str, detail: str) -> None:
    """Log a sync error with a short machine-readable detail string."""
    logger.warning("sync_error", extra={"event": event, "detail": detail})


@contextmanager
def timed(event: str) -> Iterator[None]:
    """Measure the duration of a block and log it under the given event name."""
    start = time.perf_counter()
    try:
        yield
    finally:
        end = time.perf_counter()
        record_latency(event, (end - start) * 1000)


def record_chat_send(message_id: str, sender_id: str) -> None:
    """Log successful chat message delivery metadata."""
    logger.info("chat_message_sent", extra={"message_id": message_id, "sender_id": sender_id})


def record_chat_error(code: str, detail: str | None = None) -> None:
    """Log chat-specific validation or rate-limit failures."""
    logger.warning("chat_error", extra={"code": code, "detail": detail})
