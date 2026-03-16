import json

from app import create_app
from app.auth import SESSION_AUTH_KEY


def test_index_renders_voice_ice_servers(monkeypatch):
    monkeypatch.setenv(
        "APP_WEBRTC_ICE_SERVERS_JSON",
        json.dumps(
            [
                {"urls": "stun:turn.example.com:3478"},
                {
                    "urls": "turn:turn.example.com:3478?transport=udp",
                    "username": "family",
                    "credential": "secret",
                },
            ]
        ),
    )
    monkeypatch.setenv("APP_WEBRTC_ICE_TRANSPORT_POLICY", "relay")
    app = create_app()

    with app.test_client() as client:
        with client.session_transaction() as sess:
            sess[SESSION_AUTH_KEY] = True

        resp = client.get("/")
        body = resp.get_data(as_text=True)

    assert resp.status_code == 200
    assert "window.__APP_CONFIG__" in body
    assert '"voice"' in body
    assert '"turn:turn.example.com:3478?transport=udp"' in body
    assert '"iceTransportPolicy": "relay"' in body
