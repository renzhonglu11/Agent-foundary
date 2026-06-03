#!/usr/bin/env bash
set -euo pipefail

SSH_HOST="${SSH_HOST:-hermes-do}"
REMOTE_ROOT="${REMOTE_ROOT:-/home/rz/Agent-Foundry}"
LEGACY_REMOTE_ROOT="${LEGACY_REMOTE_ROOT:-/opt/agent-foundry}"
REMOTE_USER="${REMOTE_USER:-rz}"
REMOTE_GROUP="${REMOTE_GROUP:-rz}"
SYNC_USER="${SYNC_USER:-rz}"
SERVICE_NAME="${SERVICE_NAME:-agent-foundry-backend}"
SYNC_SERVICE_NAME="${SYNC_SERVICE_NAME:-agent-foundry-hermes-cron-sync}"
REMOTE_UV_BIN="${REMOTE_UV_BIN:-/home/rz/.local/bin/uv}"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

BINARY="${REPO_ROOT}/target/release/agent-foundry-backend"
DEFAULT_ENV_SOURCE="${REPO_ROOT}/.env.remote"
if [[ ! -f "${DEFAULT_ENV_SOURCE}" ]]; then
  DEFAULT_ENV_SOURCE="${REPO_ROOT}/.env"
fi
ENV_SOURCE="${ENV_SOURCE:-${DEFAULT_ENV_SOURCE}}"
SERVICE_FILE="${REPO_ROOT}/deploy/agent-foundry-backend.service"
SYNC_SCRIPT="${REPO_ROOT}/deploy/sync-hermes-cron-jobs.sh"
SYNC_SERVICE_FILE="${REPO_ROOT}/deploy/agent-foundry-hermes-cron-sync.service"
SYNC_PATH_FILE="${REPO_ROOT}/deploy/agent-foundry-hermes-cron-sync.path"
PYTHON_PROJECT_DIR="${REPO_ROOT}/backend/python"

if [[ ! -f "${ENV_SOURCE}" ]]; then
  echo "Missing ${ENV_SOURCE}; create .env.remote for VPS deploys or .env for local defaults." >&2
  exit 1
fi

ENV_FILE="${ENV_SOURCE}"
echo "Using env file: ${ENV_FILE}"

echo "Building release binary..."
cargo build --release --manifest-path "${REPO_ROOT}/Cargo.toml"

TMP_DIR="$(ssh "${SSH_HOST}" 'mktemp -d /tmp/agent-foundry-deploy.XXXXXX')"
cleanup() {
  ssh "${SSH_HOST}" "rm -rf '${TMP_DIR}'" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "Uploading files to ${SSH_HOST}:${TMP_DIR}..."
ssh "${SSH_HOST}" "mkdir -p '${TMP_DIR}/backend-python'"
scp "${BINARY}" "${SSH_HOST}:${TMP_DIR}/agent-foundry-backend"
scp "${ENV_FILE}" "${SSH_HOST}:${TMP_DIR}/agent-foundry.env"
scp "${SERVICE_FILE}" "${SSH_HOST}:${TMP_DIR}/agent-foundry-backend.service"
scp "${SYNC_SCRIPT}" "${SSH_HOST}:${TMP_DIR}/sync-hermes-cron-jobs.sh"
scp "${SYNC_SERVICE_FILE}" "${SSH_HOST}:${TMP_DIR}/agent-foundry-hermes-cron-sync.service"
scp "${SYNC_PATH_FILE}" "${SSH_HOST}:${TMP_DIR}/agent-foundry-hermes-cron-sync.path"
rsync -az --delete \
  --exclude '.venv/' \
  --exclude '__pycache__/' \
  --exclude '*.pyc' \
  --exclude '.pytest_cache/' \
  --exclude '.mypy_cache/' \
  --exclude '.ruff_cache/' \
  --exclude '.coverage' \
  --exclude 'htmlcov/' \
  --exclude 'dist/' \
  --exclude 'build/' \
  --exclude '*.egg-info/' \
  "${PYTHON_PROJECT_DIR}/" \
  "${SSH_HOST}:${TMP_DIR}/backend-python/"

echo "Installing on VPS..."
ssh -tt "${SSH_HOST}" "
  set -euo pipefail
  sudo mkdir -p '${REMOTE_ROOT}/bin' '${REMOTE_ROOT}/data/uploads' '${REMOTE_ROOT}/backend'
  if [ -d '${LEGACY_REMOTE_ROOT}/data' ] && ! find '${REMOTE_ROOT}/data' -mindepth 1 -print -quit | grep -q .; then
    sudo cp -a '${LEGACY_REMOTE_ROOT}/data/.' '${REMOTE_ROOT}/data/'
  fi
  if ! id -u '${REMOTE_USER}' >/dev/null 2>&1; then
    sudo useradd --system --home '${REMOTE_ROOT}' --shell /usr/sbin/nologin '${REMOTE_USER}'
  fi
  sudo mv '${TMP_DIR}/agent-foundry-backend' '${REMOTE_ROOT}/bin/agent-foundry-backend'
  sudo mv '${TMP_DIR}/agent-foundry.env' '${REMOTE_ROOT}/.env'
  sudo rm -rf '${REMOTE_ROOT}/backend/python'
  sudo mkdir -p '${REMOTE_ROOT}/backend/python'
  sudo cp -a '${TMP_DIR}/backend-python/.' '${REMOTE_ROOT}/backend/python/'
  sudo rm -rf '${REMOTE_ROOT}/tools/tr-structured-products'
  sudo find '${REMOTE_ROOT}/backend/python' \
    \( -name '.venv' -o -name '__pycache__' -o -name '.pytest_cache' -o -name '.mypy_cache' -o -name '.ruff_cache' -o -name 'htmlcov' -o -name 'dist' -o -name 'build' -o -name '*.egg-info' \) \
    -prune -exec rm -rf {} +
  sudo find '${REMOTE_ROOT}/backend/python' \
    \( -name '*.pyc' -o -name '.coverage' \) \
    -type f -delete
  sudo mv '${TMP_DIR}/sync-hermes-cron-jobs.sh' '${REMOTE_ROOT}/bin/sync-hermes-cron-jobs.sh'
  sudo mv '${TMP_DIR}/agent-foundry-backend.service' '/etc/systemd/system/${SERVICE_NAME}.service'
  sudo mv '${TMP_DIR}/agent-foundry-hermes-cron-sync.service' '/etc/systemd/system/${SYNC_SERVICE_NAME}.service'
  sudo mv '${TMP_DIR}/agent-foundry-hermes-cron-sync.path' '/etc/systemd/system/${SYNC_SERVICE_NAME}.path'
  sudo install -d -o '${REMOTE_USER}' -g '${REMOTE_GROUP}' -m 2750 '${REMOTE_ROOT}/data/uv-cache'
  sudo chown -R '${REMOTE_USER}:${REMOTE_GROUP}' '${REMOTE_ROOT}/backend/python' '${REMOTE_ROOT}/data/uv-cache'
  sudo -u '${REMOTE_USER}' env UV_CACHE_DIR='${REMOTE_ROOT}/data/uv-cache' '${REMOTE_UV_BIN}' sync --directory '${REMOTE_ROOT}/backend/python' --frozen --no-dev
  sudo chown -R '${REMOTE_USER}:${REMOTE_GROUP}' '${REMOTE_ROOT}'
  sudo install -d -o '${SYNC_USER}' -g '${REMOTE_GROUP}' -m 2750 '${REMOTE_ROOT}/data/hermes-cron'
  sudo chmod +x '${REMOTE_ROOT}/bin/agent-foundry-backend' '${REMOTE_ROOT}/bin/sync-hermes-cron-jobs.sh'
  sudo systemctl disable --now agent-foundry-cron-data.timer agent-foundry-cron-data.service 2>/dev/null || true
  sudo rm -f /etc/systemd/system/agent-foundry-cron-data.timer /etc/systemd/system/agent-foundry-cron-data.service
  sudo systemctl daemon-reload
  sudo systemctl enable --now '${SYNC_SERVICE_NAME}.path'
  sudo systemctl start '${SYNC_SERVICE_NAME}.service'
  sudo systemctl enable --now '${SERVICE_NAME}'
  sudo systemctl restart '${SERVICE_NAME}'
  sudo systemctl --no-pager --full status '${SERVICE_NAME}'
"

echo "Verifying backend health..."
ssh "${SSH_HOST}" "
  set -euo pipefail
  for attempt in \$(seq 1 30); do
    if curl -fsS http://127.0.0.1:8080/health; then
      exit 0
    fi
    sleep 1
  done

  sudo systemctl --no-pager --full status '${SERVICE_NAME}' || true
  sudo journalctl -u '${SERVICE_NAME}' -n 80 --no-pager || true
  exit 1
"
echo
echo "Deployment complete."
