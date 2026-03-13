# VideoTogether: Bilibili Synced Playback

Password-gated Flask app that embeds Bilibili videos and keeps playback state (play, pause, seek, time) synchronized across all logged-in viewers in a single shared room via Socket.IO.

## Features
- Shared-password login gate; no registration or accounts.
- Paste a Bilibili link and the server normalizes it to an embeddable `player.bilibili.com` iframe.
- Realtime sync for play/pause/seek; new joiners receive the latest state immediately.
- Heartbeat-based drift detection to nudge clients back in sync if they fall behind.
- Lightweight logging hooks for video selection and sync latency/error metrics.

## Repository Layout
- `backend/` — Flask app, Socket.IO handlers, video validation, tests.
- `frontend/src/templates/` — Jinja2 templates for login and player screens.
- `frontend/src/static/` — JS for auth/video/sync flows and base styles.
- `specs/001-bilibili-sync-playback/` — Feature spec, plan, quickstart, and contracts.

## Prerequisites
- Python 3.11
- (Optional, for browser E2E tests) Playwright browsers: `python -m playwright install`

## Setup
```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
# Optional for E2E/browser tests
python -m playwright install
```

## Configuration
Environment variables (all read at startup in `backend/src/app/config.py`):
- `APP_SHARED_PASSWORD` (required): Password users must enter to access the site.
- `APP_SECRET_KEY` (default `dev-secret-key`): Flask session secret.
- `APP_HOST` (default `0.0.0.0`) and `APP_PORT` (default `5000`): Bind address/port.
- `APP_LOG_LEVEL` (default `INFO`): Root log level.
- `SOCKETIO_ASYNC_MODE` (default `gevent`): Socket.IO worker backend; keep `gevent` for gunicorn/websocket support.
- `SOCKETIO_MESSAGE_QUEUE` (optional): Redis/AMQP URL for scaling Socket.IO beyond one process.

## Run the App
```bash
cd backend
export APP_SHARED_PASSWORD="changeme"  # set your shared password
python -m app                          # or: make run
```
Open `http://localhost:5000/login`, enter the shared password, then:
1. Paste a Bilibili video link (any URL containing a `BV` id).
2. Click **Load Video** to embed it.
3. Use **Play / Pause / Seek**; other logged-in users mirror the state within ~1s.

State is in-memory and single-room; restarting the server clears the current video/position.

## Deploy with gunicorn + gevent
- Install deps (already in `backend/requirements.txt`): `pip install -r backend/requirements.txt`
- Export a strong shared password: `export APP_SHARED_PASSWORD="changeme"`
- Run gunicorn with gevent websocket worker (single process keeps in-memory sync state coherent):
```bash
cd backend
PYTHONPATH=src \
gunicorn \
  --worker-class geventwebsocket.gunicorn.workers.GeventWebSocketWorker \
  --workers 1 \
  --worker-connections 1000 \
  --bind 0.0.0.0:8000 \
  'app:create_app()'
```
- For multi-process scaling, set `SOCKETIO_MESSAGE_QUEUE` to Redis/AMQP **and** move playback state to shared storage; otherwise keep `--workers 1`.
- Put Nginx/another reverse proxy in front for TLS and static caching if deploying publicly.

## API and Realtime Surface
- `GET /login` — Render login form.  
- `POST /login` — JSON or form body `{ "password": "..." }`; sets session on success.  
- `POST /logout` — Clears session.  
- `POST /video` — Authenticated; body `{ "url": "<bilibili link>" }`; responds with `{ ok, embed_url }`.  
- Socket.IO (`/socket.io`):
  - `state` (server → client): Current playback snapshot on connect and after updates.
  - `control` (client → server): `{ type: "play"|"pause"|"seek", position_ms, reported_at }`.
  - `heartbeat` (client → server): `{ url, status, position_ms, reported_at }` for drift detection.

## Frontend Notes
- Templates: `frontend/src/templates/index.html` (player) and `login.html` (auth gate).
- Scripts: `frontend/src/static/js/auth.js` (login/logout), `video.js` (URL submit + iframe), `sync.js` (Socket.IO wiring).
- Styles: `frontend/src/static/css/style.css` (minimal, easy to extend).

## Tests
From `backend/`:
```bash
make lint    # ruff
make type    # mypy
make test    # pytest (unit + integration)
```

Browser sync E2E (requires running app and Playwright browsers):
```bash
export RUN_E2E=1
export APP_SHARED_PASSWORD="changeme"
export APP_URL="http://localhost:5000"
pytest backend/tests/e2e/test_sync_two_clients.py
```

## Development Tips
- Single-room design: all authenticated users share one playback state; introduce rooms + Redis via `SOCKETIO_MESSAGE_QUEUE` if scaling out.
- Logging helpers live in `backend/src/video/logging.py` and `backend/src/sync/metrics.py`; hook them to your log pipeline for observability.
- Specs and acceptance criteria: see `specs/001-bilibili-sync-playback/spec.md` and `quickstart.md` for constraints and latency budgets.
