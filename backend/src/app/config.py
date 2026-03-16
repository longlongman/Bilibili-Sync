import json
import os
from copy import deepcopy

DEFAULT_WEBRTC_ICE_SERVERS = [
    {"urls": "stun:stun.l.google.com:19302"},
    {"urls": "stun:stun1.l.google.com:19302"},
]
DEFAULT_WEBRTC_ICE_TRANSPORT_POLICY = "all"


def _normalize_webrtc_ice_servers(raw_value: str | None) -> list[dict[str, object]]:
    if not raw_value:
        return deepcopy(DEFAULT_WEBRTC_ICE_SERVERS)

    try:
        parsed = json.loads(raw_value)
    except json.JSONDecodeError as exc:
        raise ValueError("APP_WEBRTC_ICE_SERVERS_JSON must be valid JSON") from exc

    if not isinstance(parsed, list):
        raise ValueError("APP_WEBRTC_ICE_SERVERS_JSON must be a JSON array")

    normalized: list[dict[str, object]] = []
    for index, server in enumerate(parsed):
        if not isinstance(server, dict):
            raise ValueError(
                f"APP_WEBRTC_ICE_SERVERS_JSON entry {index} must be an object"
            )

        urls = server.get("urls")
        if not isinstance(urls, (str, list)):
            raise ValueError(
                f"APP_WEBRTC_ICE_SERVERS_JSON entry {index} must define 'urls'"
            )

        normalized_server: dict[str, object] = {"urls": urls}
        for key in ("username", "credential"):
            value = server.get(key)
            if value is not None:
                normalized_server[key] = value
        normalized.append(normalized_server)

    return normalized


def _normalize_webrtc_ice_transport_policy(raw_value: str | None) -> str:
    if not raw_value:
        return DEFAULT_WEBRTC_ICE_TRANSPORT_POLICY

    normalized = raw_value.strip().lower()
    if normalized not in {"all", "relay"}:
        raise ValueError("APP_WEBRTC_ICE_TRANSPORT_POLICY must be 'all' or 'relay'")
    return normalized


class Config:
    """Dynamic config pulled from environment each time an instance is created."""

    def __init__(self) -> None:
        self.SECRET_KEY = os.getenv("APP_SECRET_KEY", "dev-secret-key")
        self.SHARED_PASSWORD = os.getenv("APP_SHARED_PASSWORD", "changeme")
        self.SOCKETIO_MESSAGE_QUEUE = os.getenv("SOCKETIO_MESSAGE_QUEUE")
        self.LOG_LEVEL = os.getenv("APP_LOG_LEVEL", "INFO")
        # gevent works well with gunicorn and Flask-SocketIO for websocket support.
        self.SOCKETIO_ASYNC_MODE = os.getenv("SOCKETIO_ASYNC_MODE", "gevent")
        self.WEBRTC_ICE_SERVERS = _normalize_webrtc_ice_servers(
            os.getenv("APP_WEBRTC_ICE_SERVERS_JSON")
        )
        self.WEBRTC_ICE_TRANSPORT_POLICY = _normalize_webrtc_ice_transport_policy(
            os.getenv("APP_WEBRTC_ICE_TRANSPORT_POLICY")
        )
