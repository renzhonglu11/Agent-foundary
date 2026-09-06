#!/usr/bin/env bash
set -euo pipefail

SSH_HOST="${SSH_HOST:-cx33}"
REMOTE_ROOT="${REMOTE_ROOT:-/home/rz/Agent-Foundry}"
REMOTE_HOME="${REMOTE_HOME:-/home/rz}"
FRONTEND_PORT="${FRONTEND_PORT:-3000}"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_CONFIG="${SCRIPT_DIR}/Caddyfile.ssh-tunnel"
LOCAL_TMP_DIR="$(mktemp -d /tmp/agent-foundry-caddy-local.XXXXXX)"
RENDERED_CONFIG="${LOCAL_TMP_DIR}/Caddyfile"
REMOTE_TMP_DIR=""

cleanup() {
  if [[ -n "${REMOTE_TMP_DIR}" ]]; then
    ssh "${SSH_HOST}" "rm -rf '${REMOTE_TMP_DIR}'" >/dev/null 2>&1 || true
  fi
  rm -rf "${LOCAL_TMP_DIR}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

if [[ ! "${FRONTEND_PORT}" =~ ^[0-9]+$ ]] || (( FRONTEND_PORT < 1024 || FRONTEND_PORT > 65535 )); then
  echo "FRONTEND_PORT must be an unprivileged TCP port between 1024 and 65535." >&2
  exit 1
fi

sed \
  -e "s#/home/rz/Agent-Foundry#${REMOTE_ROOT}#g" \
  -e "s#127.0.0.1:3000#127.0.0.1:${FRONTEND_PORT}#g" \
  "${SOURCE_CONFIG}" > "${RENDERED_CONFIG}"

REMOTE_TMP_DIR="$(ssh "${SSH_HOST}" 'mktemp -d /tmp/agent-foundry-caddy.XXXXXX')"
scp "${RENDERED_CONFIG}" "${SSH_HOST}:${REMOTE_TMP_DIR}/Caddyfile"

printf -v remote_command \
  'set -euo pipefail; test -x /usr/bin/caddy; test -f %q; sudo chmod o+x %q; sudo install -o root -g caddy -m 0644 %q /etc/caddy/Caddyfile; sudo caddy fmt --overwrite /etc/caddy/Caddyfile; sudo caddy validate --config /etc/caddy/Caddyfile; sudo systemctl reload caddy; systemctl is-active caddy; curl -fsS http://127.0.0.1:%q/ >/dev/null' \
  "${REMOTE_ROOT}/current/web/dist/index.html" \
  "${REMOTE_HOME}" \
  "${REMOTE_TMP_DIR}/Caddyfile" \
  "${FRONTEND_PORT}"

echo "Installing loopback-only Caddy configuration on ${SSH_HOST}..."
ssh -tt "${SSH_HOST}" "${remote_command}"

echo
echo "Caddy is serving Agent Foundry at 127.0.0.1:${FRONTEND_PORT} on ${SSH_HOST}."
echo "Open the SSH tunnel with:"
echo "  ssh -N -L ${FRONTEND_PORT}:127.0.0.1:${FRONTEND_PORT} ${SSH_HOST}"
echo "Then browse to: http://127.0.0.1:${FRONTEND_PORT}"
