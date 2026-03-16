import pytest
from app.config import (
    DEFAULT_WEBRTC_ICE_SERVERS,
    _normalize_webrtc_ice_servers,
    _normalize_webrtc_ice_transport_policy,
)


def test_normalize_webrtc_ice_servers_uses_defaults():
    assert _normalize_webrtc_ice_servers(None) == DEFAULT_WEBRTC_ICE_SERVERS


def test_normalize_webrtc_ice_servers_accepts_custom_turn_config():
    raw_value = """
    [
      {"urls": "stun:turn.example.com:3478"},
      {
        "urls": ["turn:turn.example.com:3478?transport=udp", "turn:turn.example.com:3478?transport=tcp"],
        "username": "family",
        "credential": "secret"
      }
    ]
    """

    normalized = _normalize_webrtc_ice_servers(raw_value)

    assert normalized[0]["urls"] == "stun:turn.example.com:3478"
    assert normalized[1]["username"] == "family"
    assert normalized[1]["credential"] == "secret"


def test_normalize_webrtc_ice_servers_rejects_invalid_json():
    with pytest.raises(ValueError):
        _normalize_webrtc_ice_servers("{not-json}")


def test_normalize_webrtc_ice_transport_policy_uses_default():
    assert _normalize_webrtc_ice_transport_policy(None) == "all"


def test_normalize_webrtc_ice_transport_policy_accepts_relay():
    assert _normalize_webrtc_ice_transport_policy("relay") == "relay"


def test_normalize_webrtc_ice_transport_policy_rejects_invalid_value():
    with pytest.raises(ValueError):
        _normalize_webrtc_ice_transport_policy("host")
