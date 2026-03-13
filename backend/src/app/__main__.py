import os

from app import create_app, socketio


def main() -> None:
    app = create_app()
    host = os.getenv("APP_HOST", "0.0.0.0")
    port = int(os.getenv("APP_PORT", "5000"))
    # Use Socket.IO's server to ensure WebSocket/event polling works in dev.
    socketio.run(app, host=host, port=port, allow_unsafe_werkzeug=True)


if __name__ == "__main__":
    main()
