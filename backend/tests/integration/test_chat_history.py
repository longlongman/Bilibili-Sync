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
def authed_app(monkeypatch):
    monkeypatch.setenv("APP_SHARED_PASSWORD", "secret")
    chat_store.clear()
    app = create_app()
    return app


def test_chat_history_emitted_on_connect(authed_app):
    sender = make_client(authed_app)
    receiver = make_client(authed_app)

    sender.emit("chat:send", {"content": "hello history"}, callback=True)
    time.sleep(0.05)

    # Simulate a late joiner
    late_client = make_client(authed_app)
    events = [e for e in late_client.get_received() if e["name"] == "chat:history"]
    assert events
    messages = events[-1]["args"][0]["messages"]
    assert messages
    assert messages[-1]["content"] == "hello history"

    sender.disconnect()
    receiver.disconnect()
    late_client.disconnect()


def test_chat_history_http_endpoint(authed_app):
    client = authed_app.test_client()
    with client.session_transaction() as sess:
        sess[SESSION_AUTH_KEY] = True

    # Ensure endpoint returns empty list initially
    resp = client.get("/api/chat/history")
    assert resp.status_code == 200
    assert resp.get_json()["messages"] == []
