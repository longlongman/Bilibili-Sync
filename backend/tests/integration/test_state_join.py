import time

from app import create_app, socketio
from app.auth import SESSION_AUTH_KEY
from sync.state import playback_state


def make_socket_client(app, auth=True):
    flask_client = app.test_client()
    if auth:
        with flask_client.session_transaction() as sess:
            sess[SESSION_AUTH_KEY] = True
    return socketio.test_client(app, flask_test_client=flask_client)


def test_join_receives_current_state(monkeypatch):
    monkeypatch.setenv("APP_SHARED_PASSWORD", "secret")
    app = create_app()
    playback_state.set_video("https://player.bilibili.com/player.html?bvid=BV1xx")
    playback_state.apply("play", 5000, actor="seed")

    client = make_socket_client(app)
    received = client.get_received()
    state_events = [p for p in received if p["name"] == "state"]
    assert state_events, "Should receive state on connect"
    data = state_events[-1]["args"][0]
    assert data["url"]
    assert data["status"] in {"playing", "paused"}
    assert data["position_ms"] >= 0


def test_control_broadcast_reaches_other_clients(monkeypatch):
    monkeypatch.setenv("APP_SHARED_PASSWORD", "secret")
    app = create_app()
    client_a = make_socket_client(app)
    client_b = make_socket_client(app)

    client_a.emit("control", {"type": "play", "position_ms": 1000})
    time.sleep(0.1)
    events_b = client_b.get_received()
    states = [e for e in events_b if e["name"] == "state"]
    assert states, "Client B should receive state broadcast"
    latest = states[-1]["args"][0]
    assert latest["status"] == "playing"
    assert latest["position_ms"] == 1000

    client_a.disconnect()
    client_b.disconnect()
