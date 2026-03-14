from datetime import datetime, timedelta, timezone

import pytest
from sync.chat.rate_limit import RateLimiter
from sync.chat.schema import ValidationError, normalize_message_payload
from sync.chat.store import ChatStore


def test_normalize_message_payload_trims_and_sets_defaults():
    now = datetime(2024, 1, 1, tzinfo=timezone.utc)
    msg = normalize_message_payload(
        {"content": "  hello  "},
        sender_id="sid-1",
        sender_label="Alice",
        clock=now,
    )
    data = msg.to_dict()
    assert data["content"] == "hello"
    assert data["sender_id"] == "sid-1"
    assert data["sender_label"] == "Alice"
    assert data["delivery_status"] == "sent"
    assert data["sent_at"] == "2024-01-01T00:00:00+00:00".replace("+00:00", "Z")
    assert data["message_id"]


@pytest.mark.parametrize(
    "payload,code",
    [
        ({}, "content_missing"),
        ({"content": "   "}, "content_empty"),
        ({"content": "x" * 501}, "content_too_long"),
    ],
)
def test_normalize_message_payload_validation_errors(payload, code):
    with pytest.raises(ValidationError) as err:
        normalize_message_payload(payload, sender_id="sid", sender_label="Bob")
    assert err.match(code)


def test_chat_store_caps_and_dedupes():
    store = ChatStore(capacity=3)
    a = {"message_id": "a"}
    b = {"message_id": "b"}
    c = {"message_id": "c"}
    d = {"message_id": "d"}
    store.append(a)
    store.append(b)
    store.append(c)
    # Deduplicate
    again = store.append(a)
    assert again is a
    # Capacity cap should evict oldest when adding d
    store.append(d)
    latest_ids = [m["message_id"] for m in store.latest(limit=10)]
    assert latest_ids == ["b", "c", "d"]


def test_rate_limiter_enforces_min_interval_and_per_minute():
    limiter = RateLimiter(min_interval_s=1.0, max_per_minute=3)
    now = datetime(2024, 1, 1, tzinfo=timezone.utc)

    assert limiter.check("u1", now=now).allowed
    too_fast = limiter.check("u1", now=now + timedelta(milliseconds=200))
    assert too_fast.allowed is False
    assert too_fast.code == "rate_limit_min_interval"

    # Hit per-minute cap
    limiter.check("u1", now=now + timedelta(seconds=2))
    limiter.check("u1", now=now + timedelta(seconds=3))
    over_cap = limiter.check("u1", now=now + timedelta(seconds=4))
    assert over_cap.allowed is False
    assert over_cap.code == "rate_limit_per_minute"
    assert over_cap.retry_after_s >= 0
