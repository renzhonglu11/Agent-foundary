#!/usr/bin/env bash
set -euo pipefail

SSH_HOST="${SSH_HOST:-hermes-do}"
REMOTE_ROOT="${REMOTE_ROOT:-/opt/agent-foundry}"
REMOTE_USER="${REMOTE_USER:-agentfoundry}"
REMOTE_GROUP="${REMOTE_GROUP:-agentfoundry}"
SERVICE_NAME="${SERVICE_NAME:-agent-foundry-backend}"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

BINARY="${REPO_ROOT}/target/release/agent-foundry-backend"
ENV_SOURCE="${REPO_ROOT}/.env"
ENV_FALLBACK="${REPO_ROOT}/.env.example"
SERVICE_FILE="${REPO_ROOT}/deploy/agent-foundry-backend.service"
PDF_EXTRACT_SCRIPT="${REPO_ROOT}/backend/scripts/extractPdfText.py"
PDF_EXTRACT_REQUIREMENTS="${REPO_ROOT}/backend/scripts/requirements.txt"

if [[ -f "${ENV_SOURCE}" ]]; then
  ENV_FILE="${ENV_SOURCE}"
else
  ENV_FILE="${ENV_FALLBACK}"
fi

echo "Building release binary..."
cargo build --release --manifest-path "${REPO_ROOT}/Cargo.toml"

TMP_DIR="$(ssh "${SSH_HOST}" 'mktemp -d /tmp/agent-foundry-deploy.XXXXXX')"
cleanup() {
  ssh "${SSH_HOST}" "rm -rf '${TMP_DIR}'" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "Uploading files to ${SSH_HOST}:${TMP_DIR}..."
scp "${BINARY}" "${SSH_HOST}:${TMP_DIR}/agent-foundry-backend"
scp "${ENV_FILE}" "${SSH_HOST}:${TMP_DIR}/agent-foundry.env"
scp "${SERVICE_FILE}" "${SSH_HOST}:${TMP_DIR}/agent-foundry-backend.service"
scp "${PDF_EXTRACT_SCRIPT}" "${SSH_HOST}:${TMP_DIR}/extractPdfText.py"
scp "${PDF_EXTRACT_REQUIREMENTS}" "${SSH_HOST}:${TMP_DIR}/requirements.txt"

echo "Installing on VPS..."
ssh -tt "${SSH_HOST}" "
  set -euo pipefail
  sudo mkdir -p '${REMOTE_ROOT}/bin' '${REMOTE_ROOT}/data' '${REMOTE_ROOT}/scripts'
  sudo useradd --system --home '${REMOTE_ROOT}' --shell /usr/sbin/nologin '${REMOTE_USER}' 2>/dev/null || true
  sudo mv '${TMP_DIR}/agent-foundry-backend' '${REMOTE_ROOT}/bin/agent-foundry-backend'
  sudo mv '${TMP_DIR}/agent-foundry.env' '${REMOTE_ROOT}/.env'
  sudo rm -f '${REMOTE_ROOT}/data/Transaktionsexport.csv'
  sudo mv '${TMP_DIR}/extractPdfText.py' '${REMOTE_ROOT}/scripts/extractPdfText.py'
  sudo mv '${TMP_DIR}/requirements.txt' '${REMOTE_ROOT}/scripts/requirements.txt'
  sudo mv '${TMP_DIR}/agent-foundry-backend.service' '/etc/systemd/system/${SERVICE_NAME}.service'
  sudo python3 -m venv '${REMOTE_ROOT}/.venv'
  sudo '${REMOTE_ROOT}/.venv/bin/python' -m pip install -r '${REMOTE_ROOT}/scripts/requirements.txt'
  sudo grep -q '^PDF_TEXT_EXTRACTOR_SCRIPT=' '${REMOTE_ROOT}/.env' \
    && sudo sed -i 's#^PDF_TEXT_EXTRACTOR_SCRIPT=.*#PDF_TEXT_EXTRACTOR_SCRIPT=scripts/extractPdfText.py#' '${REMOTE_ROOT}/.env' \
    || echo 'PDF_TEXT_EXTRACTOR_SCRIPT=scripts/extractPdfText.py' | sudo tee -a '${REMOTE_ROOT}/.env' >/dev/null
  sudo grep -q '^PDF_EXTRACT_PYTHON=' '${REMOTE_ROOT}/.env' \
    && sudo sed -i 's#^PDF_EXTRACT_PYTHON=.*#PDF_EXTRACT_PYTHON=.venv/bin/python#' '${REMOTE_ROOT}/.env' \
    || echo 'PDF_EXTRACT_PYTHON=.venv/bin/python' | sudo tee -a '${REMOTE_ROOT}/.env' >/dev/null
  sudo chown -R '${REMOTE_USER}:${REMOTE_GROUP}' '${REMOTE_ROOT}'
  sudo chmod +x '${REMOTE_ROOT}/bin/agent-foundry-backend'
  sudo systemctl daemon-reload
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
