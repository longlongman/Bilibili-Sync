#!/usr/bin/env bash
# Launch the Flask/Socket.IO app with sensible defaults.
# Uses conda environment: bilibili-sync

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="${SCRIPT_DIR}/backend"
SRC_DIR="${BACKEND_DIR}/src"

# Activate conda environment
if [ -f "/root/miniconda3/etc/profile.d/conda.sh" ]; then
  source /root/miniconda3/etc/profile.d/conda.sh
  conda activate bilibili-sync
fi

cd "${BACKEND_DIR}"

# Ensure Python can import the backend/src directory
export PYTHONPATH="${SRC_DIR}:${PYTHONPATH:-}"

: "${APP_SHARED_PASSWORD:=changeme}"
: "${APP_HOST:=0.0.0.0}"
: "${APP_PORT:=5050}"
: "${APP_LOG_LEVEL:=INFO}"
: "${SOCKETIO_ASYNC_MODE:=gevent}"
: "${WORKERS:=1}"
: "${WORKER_CONNECTIONS:=1000}"
: "${USE_HTTPS:=1}"

# SSL certificate paths
SSL_DIR="${BACKEND_DIR}/ssl"
SSL_CERT="${SSL_DIR}/cert.pem"
SSL_KEY="${SSL_DIR}/key.pem"

if [[ "${USE_HTTPS:=1}" == "1" && -f "${SSL_CERT}" && -f "${SSL_KEY}" ]]; then
  echo "  - HTTPS enabled (self-signed)"
  USE_HTTPS=1
else
  USE_HTTPS=0
fi

echo "Starting VideoTogether (gunicorn + gevent) on ${APP_HOST}:${APP_PORT}"
echo "  - APP_SHARED_PASSWORD=${APP_SHARED_PASSWORD}"
echo "  - APP_LOG_LEVEL=${APP_LOG_LEVEL}"
echo "  - SOCKETIO_ASYNC_MODE=${SOCKETIO_ASYNC_MODE}"
echo "  - WORKERS=${WORKERS} worker_connections=${WORKER_CONNECTIONS}"
echo "  - PYTHONPATH=${PYTHONPATH}"
echo "  - Using Python: $(which python)"

if [[ "${USE_DEV_SERVER:-0}" == "1" ]]; then
  echo "USE_DEV_SERVER=1 set; running python -m app (Werkzeug dev server)."
  if [[ "${USE_HTTPS}" == "1" ]]; then
    echo "HTTPS not supported in dev server mode, use USE_HTTPS=0 or run with gunicorn"
  fi
  APP_SHARED_PASSWORD="${APP_SHARED_PASSWORD}" \
  APP_HOST="${APP_HOST}" \
  APP_PORT="${APP_PORT}" \
  APP_LOG_LEVEL="${APP_LOG_LEVEL}" \
  SOCKETIO_ASYNC_MODE="${SOCKETIO_ASYNC_MODE}" \
  python -m app
else
  # Build gunicorn command
  GUNICORN_CMD="gunicorn \
    --worker-class geventwebsocket.gunicorn.workers.GeventWebSocketWorker \
    --workers ${WORKERS} \
    --worker-connections ${WORKER_CONNECTIONS} \
    --bind ${APP_HOST}:${APP_PORT} \
    'app:create_app()'"

  if [[ "${USE_HTTPS}" == "1" ]]; then
    echo "  - Using HTTPS with self-signed certificate"
    GUNICORN_CMD="${GUNICORN_CMD} --certfile=${SSL_CERT} --keyfile=${SSL_KEY}"
  fi

  APP_SHARED_PASSWORD="${APP_SHARED_PASSWORD}" \
  APP_HOST="${APP_HOST}" \
  APP_PORT="${APP_PORT}" \
  APP_LOG_LEVEL="${APP_LOG_LEVEL}" \
  SOCKETIO_ASYNC_MODE="${SOCKETIO_ASYNC_MODE}" \
  eval ${GUNICORN_CMD}
fi
