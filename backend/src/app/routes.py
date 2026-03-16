from flask import (
    Blueprint,
    current_app,
    jsonify,
    redirect,
    render_template,
    request,
    session,
    url_for,
)
from sync.state import playback_state
from sync.timebase import server_now_ms
from video.logging import log_video_selection
from video.validator import normalize_bilibili_url

from app import socketio
from app.auth import is_authenticated, login_with_password, require_auth

bp = Blueprint("app", __name__)
SYNC_ROOM = "shared-room"

try:
    # Optional import; chat routes may not exist in every feature set.
    from sync.chat.context import chat_store  # type: ignore
except Exception:  # pragma: no cover - fallback when chat not present
    chat_store = None


@bp.route("/", methods=["GET"])
@require_auth
def index():
    app_config = {
        "voice": {
            "iceServers": current_app.config.get("WEBRTC_ICE_SERVERS", []),
            "iceTransportPolicy": current_app.config.get(
                "WEBRTC_ICE_TRANSPORT_POLICY", "all"
            ),
        }
    }
    return render_template("index.html", app_config=app_config)


@bp.route("/login", methods=["GET", "POST"])
def login():
    if request.method == "POST":
        payload = request.get_json() or request.form
        password = payload.get("password") if payload else None
        if password and login_with_password(password):
            return jsonify({"ok": True}) if request.is_json else redirect(url_for("app.index"))
        return (jsonify({"ok": False, "error": "Invalid password"}), 401)
    if is_authenticated():
        return redirect(url_for("app.index"))
    return render_template("login.html")


@bp.route("/logout", methods=["POST"])
@require_auth
def logout():
    session.clear()
    return jsonify({"ok": True})


@bp.route("/video", methods=["POST"])
@require_auth
def set_video():
    # `/video` is the only HTTP endpoint that mutates playback state. The
    # actual player update still fans out through Socket.IO so every client,
    # including the initiator, applies the same authoritative `state` payload.
    payload = request.get_json() or {}
    url = payload.get("url")
    valid, embed_url, error = normalize_bilibili_url(url)
    if not valid or not embed_url:
        return jsonify({"ok": False, "error": error}), 400
    state_time_ms = server_now_ms()
    state = playback_state.set_video(
        embed_url,
        event_server_ms=state_time_ms,
        actor=request.remote_addr or "unknown",
    )
    socketio.emit("state", playback_state.snapshot(server_now_ms()), room=SYNC_ROOM)
    log_video_selection(request.remote_addr or "unknown", embed_url)
    return jsonify({"ok": True, "embed_url": embed_url, "state": state})


@bp.route("/api/chat/history", methods=["GET"])
@require_auth
def chat_history():
    if chat_store is None:
        return jsonify({"ok": False, "error": "chat_not_enabled"}), 404
    try:
        limit = int(request.args.get("limit", 50))
    except (TypeError, ValueError):
        limit = 50
    limit = min(max(1, limit), 50)
    messages = chat_store.latest(limit)
    return jsonify({"messages": messages})
