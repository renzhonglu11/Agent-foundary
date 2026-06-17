#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
WEB_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
ROOT_DIR=$(CDPATH= cd -- "$WEB_DIR/.." && pwd)
BACKEND_PID=""

cleanup() {
  if [ -n "$BACKEND_PID" ] && kill -0 "$BACKEND_PID" 2>/dev/null; then
    kill "$BACKEND_PID" 2>/dev/null || true
    wait "$BACKEND_PID" 2>/dev/null || true
  fi
}

trap cleanup EXIT INT TERM

(
  cd "$ROOT_DIR"
  cargo run -p agent-foundry-backend
) &
BACKEND_PID=$!

echo "Waiting for Rust backend on http://127.0.0.1:8080 ..."
attempt=0
while ! curl -fsS http://127.0.0.1:8080/health >/dev/null 2>&1; do
  if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
    echo "Rust backend exited before becoming healthy." >&2
    wait "$BACKEND_PID" 2>/dev/null || true
    exit 1
  fi
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 120 ]; then
    echo "Timed out waiting for Rust backend." >&2
    exit 1
  fi
  sleep 1
done

cd "$WEB_DIR"
vite --host 0.0.0.0
