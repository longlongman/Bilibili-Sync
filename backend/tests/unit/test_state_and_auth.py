from app.auth import login_with_password
from sync.state import PlaybackState


def test_playback_state_apply_updates_status_and_position():
    state = PlaybackState()
    state.set_video("https://player.bilibili.com/player.html?bvid=BV1xx", event_server_ms=1000)
    result = state.apply("play", 5000, actor="user1", event_server_ms=1500)
    assert result["status"] == "playing"
    assert result["position_ms"] == 5000
    assert result["actor"] == "user1"


def test_login_with_password_matches_config(monkeypatch):
    monkeypatch.setenv("APP_SHARED_PASSWORD", "secret")
    # Reimport config to pick up env
    from app import config  # type: ignore

    app_config = config.Config()
    # Monkeypatch current_app not used directly in login_with_password test; simulate
    from flask import Flask

    app = Flask(__name__)
    app.config.from_object(app_config)

    with app.app_context():
        assert login_with_password("secret") is True
        assert login_with_password("wrong") is False
