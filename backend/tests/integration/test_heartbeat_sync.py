from app import create_app, socketio
from app.auth import SESSION_AUTH_KEY
from sync.state import playback_state


def make_client(app):
    flask_client = app.test_client()
    with flask_client.session_transaction() as sess:
        sess[SESSION_AUTH_KEY] = True
    return socketio.test_client(app, flask_test_client=flask_client)


def test_heartbeat_ack_returns_server_timing(monkeypatch):
    monkeypatch.setenv("APP_SHARED_PASSWORD", "secret")
    playback_state.reset()
    app = create_app()
    client = make_client(app)

    ack = client.emit(
        "heartbeat",
        {
            "client_sent_mono_ms": 1000,
            "observed_server_ms_est": 2000,
            "position_ms": 0,
        },
        callback=True,
    )
    ack = ack[0] if isinstance(ack, list) else ack

    assert ack["ok"] is True
    assert ack["client_sent_mono_ms"] == 1000
    assert ack["server_send_ms"] >= ack["server_recv_ms"]
    client.disconnect()


def test_heartbeat_returns_correction_on_large_drift(monkeypatch):
    monkeypatch.setenv("APP_SHARED_PASSWORD", "secret")
    playback_state.reset()
    playback_state.set_video("https://player.bilibili.com/player.html?bvid=BV1xx", event_server_ms=1000)
    playback_state.apply("play", 0, actor="seed", event_server_ms=2000)
    app = create_app()
    client = make_client(app)

    ack = client.emit(
        "heartbeat",
        {
            "client_sent_mono_ms": 1000,
            "observed_server_ms_est": 2500,
            "position_ms": 9000,
        },
        callback=True,
    )
    ack = ack[0] if isinstance(ack, list) else ack

    assert ack["ok"] is True
    assert ack["correction"]["revision"] == playback_state.revision
    assert ack["correction"]["server_state_at_ms"] == 2000
    client.disconnect()
