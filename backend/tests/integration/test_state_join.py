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
    time.sleep(0.05)

    client = make_socket_client(app)
    received = client.get_received()
    state_events = [p for p in received if p["name"] == "state"]
    assert state_events, "Should receive state on connect"
    data = state_events[-1]["args"][0]
    assert data["url"]
    assert data["status"] == "playing"
    assert data["position_ms"] > 5000
    assert isinstance(data["state_at_ms"], int)


def test_control_broadcast_reaches_other_clients(monkeypatch):
    monkeypatch.setenv("APP_SHARED_PASSWORD", "secret")
    app = create_app()
    client_a = make_socket_client(app)
    client_b = make_socket_client(app)

    client_a.emit(
        "control",
        {
            "type": "play",
            "position_ms": 1000,
        },
    )
    time.sleep(0.1)
    events_b = client_b.get_received()
    states = [e for e in events_b if e["name"] == "state"]
    assert states, "Client B should receive state broadcast"
    latest = states[-1]["args"][0]
    assert latest["status"] == "playing"
    assert latest["position_ms"] >= 1000
    assert isinstance(latest["state_at_ms"], int)
    assert playback_state.last_event_at is not None

    client_a.disconnect()
    client_b.disconnect()


def test_heartbeat_returns_server_now_ack_without_resync(monkeypatch):
    monkeypatch.setenv("APP_SHARED_PASSWORD", "secret")
    app = create_app()
    playback_state.set_video("https://player.bilibili.com/player.html?bvid=BV1xx")
    playback_state.apply("play", 4000, actor="seed")

    client = make_socket_client(app)
    client.get_received()

    ack = client.emit(
        "heartbeat",
        {
            "url": playback_state.video_url,
            "status": "playing",
            "position_ms": 0,
            "client_perf_sent_ms": 123.0,
        },
        callback=True,
    )

    assert isinstance(ack["server_now_ms"], int)

    events = client.get_received()
    states = [event for event in events if event["name"] == "state"]
    assert not states, "Heartbeat ack should not proactively emit state"

    client.disconnect()


def test_sync_resync_returns_current_state(monkeypatch):
    monkeypatch.setenv("APP_SHARED_PASSWORD", "secret")
    app = create_app()
    playback_state.set_video("https://player.bilibili.com/player.html?bvid=BV1xx")
    playback_state.apply("play", 2500, actor="seed")
    time.sleep(0.02)

    client = make_socket_client(app)
    client.get_received()

    ack = client.emit("sync:resync", {}, callback=True)
    assert ack["ok"] is True

    events = client.get_received()
    states = [event for event in events if event["name"] == "state"]
    assert states, "Resync request should emit a fresh state"
    latest = states[-1]["args"][0]
    assert latest["status"] == "playing"
    assert latest["position_ms"] > 2500
    assert isinstance(latest["state_at_ms"], int)

    client.disconnect()
