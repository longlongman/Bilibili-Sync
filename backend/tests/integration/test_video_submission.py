from app import create_app
from sync.state import playback_state


def make_app(monkeypatch):
    monkeypatch.setenv("APP_SHARED_PASSWORD", "secret")
    playback_state.reset()
    return create_app()


def test_video_submission_success(monkeypatch):
    app = make_app(monkeypatch)
    with app.test_client() as client:
        client.post("/login", json={"password": "secret"})
        resp = client.post("/video", json={"url": "https://www.bilibili.com/video/BV1xx411c7mD"})
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["ok"] is True
        assert "embed_url" in data
        assert data["state"]["server_state_at_ms"] is not None
        assert data["state"]["revision"] == 1


def test_video_submission_rejects_invalid(monkeypatch):
    app = make_app(monkeypatch)
    with app.test_client() as client:
        client.post("/login", json={"password": "secret"})
        resp = client.post("/video", json={"url": "https://example.com"})
        assert resp.status_code == 400
        data = resp.get_json()
        assert data["ok"] is False
        assert data["error"]
