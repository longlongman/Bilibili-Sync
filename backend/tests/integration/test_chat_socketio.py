import time

import pytest
from app import create_app, socketio
from app.auth import SESSION_AUTH_KEY
from sync.chat.context import chat_store


def make_client(app):
    flask_client = app.test_client()
    with flask_client.session_transaction() as sess:
        sess[SESSION_AUTH_KEY] = True
    return socketio.test_client(app, flask_test_client=flask_client)


@pytest.fixture
def authed_clients(monkeypatch):
    monkeypatch.setenv("APP_SHARED_PASSWORD", "secret")
    chat_store.clear()
    app = create_app()
    c1 = make_client(app)
    c2 = make_client(app)
    yield c1, c2
    c1.disconnect()
    c2.disconnect()


def _received(event_name, client):
    return [e for e in client.get_received() if e["name"] == event_name]


def test_chat_send_ack_and_broadcast(authed_clients):
    c1, c2 = authed_clients
    ack_args = c1.emit("chat:send", {"content": "hello world"}, callback=True)
    ack = ack_args[0] if isinstance(ack_args, list) else ack_args
    assert ack["ok"] is True
    assert ack["message"]["content"] == "hello world"
    time.sleep(0.05)
    messages = _received("chat:message", c2)
    assert messages
    payload = messages[-1]["args"][0]
    assert payload["content"] == "hello world"
    assert payload["message_id"]
    assert payload["delivery_status"] == "sent"


def test_chat_rate_limit_and_validation(authed_clients):
    c1, _ = authed_clients
    ack1_args = c1.emit("chat:send", {"content": "first"}, callback=True)
    ack1 = ack1_args[0] if isinstance(ack1_args, list) else ack1_args
    assert ack1["ok"] is True
    ack_fast_args = c1.emit("chat:send", {"content": "too fast"}, callback=True)
    ack_fast = ack_fast_args[0] if isinstance(ack_fast_args, list) else ack_fast_args
    assert ack_fast["ok"] is False
    assert ack_fast["code"] == "rate_limit_min_interval"
    ack_invalid_args = c1.emit("chat:send", {"content": "   "}, callback=True)
    ack_invalid = ack_invalid_args[0] if isinstance(ack_invalid_args, list) else ack_invalid_args
    assert ack_invalid["ok"] is False
    assert ack_invalid["error"] in {"content_empty", "content_missing"}
