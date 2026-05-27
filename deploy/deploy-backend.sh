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

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

BINARY="${REPO_ROOT}/target/release/agent-foundry-backend"
ENV_SOURCE="${REPO_ROOT}/.env"
SERVICE_FILE="${REPO_ROOT}/deploy/agent-foundry-backend.service"
SYNC_SCRIPT="${REPO_ROOT}/deploy/sync-hermes-cron-jobs.sh"
SYNC_SERVICE_FILE="${REPO_ROOT}/deploy/agent-foundry-hermes-cron-sync.service"
SYNC_PATH_FILE="${REPO_ROOT}/deploy/agent-foundry-hermes-cron-sync.path"
PDF_EXTRACT_SCRIPT="${REPO_ROOT}/backend/scripts/extractPdfText.py"
PDF_EXTRACT_REQUIREMENTS="${REPO_ROOT}/backend/scripts/requirements.txt"
STRUCTURED_PRODUCTS_TOOL_DIR="${REPO_ROOT}/tools/tr-structured-products"

if [[ ! -f "${ENV_SOURCE}" ]]; then
  echo "Missing ${ENV_SOURCE}; create it from .env.example before deploying." >&2
  exit 1
fi

ENV_FILE="${ENV_SOURCE}"

echo "Building release binary..."
cargo build --release --manifest-path "${REPO_ROOT}/Cargo.toml"

TMP_DIR="$(ssh "${SSH_HOST}" 'mktemp -d /tmp/agent-foundry-deploy.XXXXXX')"
cleanup() {
  ssh "${SSH_HOST}" "rm -rf '${TMP_DIR}'" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "Uploading files to ${SSH_HOST}:${TMP_DIR}..."
ssh "${SSH_HOST}" "mkdir -p '${TMP_DIR}/tr-structured-products'"
scp "${BINARY}" "${SSH_HOST}:${TMP_DIR}/agent-foundry-backend"
scp "${ENV_FILE}" "${SSH_HOST}:${TMP_DIR}/agent-foundry.env"
scp "${SERVICE_FILE}" "${SSH_HOST}:${TMP_DIR}/agent-foundry-backend.service"
scp "${SYNC_SCRIPT}" "${SSH_HOST}:${TMP_DIR}/sync-hermes-cron-jobs.sh"
scp "${SYNC_SERVICE_FILE}" "${SSH_HOST}:${TMP_DIR}/agent-foundry-hermes-cron-sync.service"
scp "${SYNC_PATH_FILE}" "${SSH_HOST}:${TMP_DIR}/agent-foundry-hermes-cron-sync.path"
scp "${PDF_EXTRACT_SCRIPT}" "${SSH_HOST}:${TMP_DIR}/extractPdfText.py"
scp "${PDF_EXTRACT_REQUIREMENTS}" "${SSH_HOST}:${TMP_DIR}/requirements.txt"
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
  "${STRUCTURED_PRODUCTS_TOOL_DIR}/" \
  "${SSH_HOST}:${TMP_DIR}/tr-structured-products/"

echo "Installing on VPS..."
ssh -tt "${SSH_HOST}" "
  set -euo pipefail
  sudo mkdir -p '${REMOTE_ROOT}/bin' '${REMOTE_ROOT}/data' '${REMOTE_ROOT}/scripts' '${REMOTE_ROOT}/tools'
  if [ -d '${LEGACY_REMOTE_ROOT}/data' ] && ! find '${REMOTE_ROOT}/data' -mindepth 1 -print -quit | grep -q .; then
    sudo cp -a '${LEGACY_REMOTE_ROOT}/data/.' '${REMOTE_ROOT}/data/'
  fi
  if [ ! -f '${REMOTE_ROOT}/data/portfolio-transactions.csv' ]; then
    if [ -f '${REMOTE_ROOT}/data/Transaktionsexport.csv' ]; then
      sudo cp -a '${REMOTE_ROOT}/data/Transaktionsexport.csv' '${REMOTE_ROOT}/data/portfolio-transactions.csv'
    elif [ -f '${REMOTE_ROOT}/data/Transaktionsexport(2).csv' ]; then
      sudo cp -a '${REMOTE_ROOT}/data/Transaktionsexport(2).csv' '${REMOTE_ROOT}/data/portfolio-transactions.csv'
    fi
  fi
  if [ ! -f '${REMOTE_ROOT}/data/asset-overview.pdf' ] && [ -f '${REMOTE_ROOT}/data/Vermögensübersicht.pdf' ]; then
    sudo cp -a '${REMOTE_ROOT}/data/Vermögensübersicht.pdf' '${REMOTE_ROOT}/data/asset-overview.pdf'
  fi
  if ! id -u '${REMOTE_USER}' >/dev/null 2>&1; then
    sudo useradd --system --home '${REMOTE_ROOT}' --shell /usr/sbin/nologin '${REMOTE_USER}'
  fi
  sudo mv '${TMP_DIR}/agent-foundry-backend' '${REMOTE_ROOT}/bin/agent-foundry-backend'
  sudo mv '${TMP_DIR}/agent-foundry.env' '${REMOTE_ROOT}/.env'
  sudo mv '${TMP_DIR}/extractPdfText.py' '${REMOTE_ROOT}/scripts/extractPdfText.py'
  sudo mv '${TMP_DIR}/requirements.txt' '${REMOTE_ROOT}/scripts/requirements.txt'
  sudo rm -rf '${REMOTE_ROOT}/tools/tr-structured-products'
  sudo mkdir -p '${REMOTE_ROOT}/tools/tr-structured-products'
  sudo cp -a '${TMP_DIR}/tr-structured-products/.' '${REMOTE_ROOT}/tools/tr-structured-products/'
  sudo find '${REMOTE_ROOT}/tools/tr-structured-products' \
    \( -name '.venv' -o -name '__pycache__' -o -name '.pytest_cache' -o -name '.mypy_cache' -o -name '.ruff_cache' -o -name 'htmlcov' -o -name 'dist' -o -name 'build' -o -name '*.egg-info' \) \
    -prune -exec rm -rf {} +
  sudo find '${REMOTE_ROOT}/tools/tr-structured-products' \
    \( -name '*.pyc' -o -name '.coverage' \) \
    -type f -delete
  sudo mv '${TMP_DIR}/sync-hermes-cron-jobs.sh' '${REMOTE_ROOT}/bin/sync-hermes-cron-jobs.sh'
  sudo mv '${TMP_DIR}/agent-foundry-backend.service' '/etc/systemd/system/${SERVICE_NAME}.service'
  sudo mv '${TMP_DIR}/agent-foundry-hermes-cron-sync.service' '/etc/systemd/system/${SYNC_SERVICE_NAME}.service'
  sudo mv '${TMP_DIR}/agent-foundry-hermes-cron-sync.path' '/etc/systemd/system/${SYNC_SERVICE_NAME}.path'
  sudo python3 -m venv '${REMOTE_ROOT}/.venv'
  sudo '${REMOTE_ROOT}/.venv/bin/python' -m pip install -r '${REMOTE_ROOT}/scripts/requirements.txt'
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
