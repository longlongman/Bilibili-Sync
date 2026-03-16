from app import create_app


def test_video_ui_template_renders(monkeypatch):
    monkeypatch.setenv("APP_SHARED_PASSWORD", "secret")
    app = create_app()
    with app.test_client() as client:
        client.post("/login", json={"password": "secret"})
        resp = client.get("/")
        assert resp.status_code == 200
        body = resp.get_data(as_text=True)
        assert "Bilibili Link" in body
        assert "Load Video" in body
        assert 'id="player-note"' in body
