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
REMOTE_UV_DIR="$(dirname -- "${REMOTE_UV_BIN}")"
REMOTE_PYTHON_VENV="${REMOTE_PYTHON_VENV:-${REMOTE_ROOT}/backend/python/.venv}"
HERMES_CRON_SOURCE_PATH="${HERMES_CRON_SOURCE_PATH:-/home/${SYNC_USER}/.hermes/cron/jobs.json}"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

BINARY="${REPO_ROOT}/target/release/agent-foundry-backend"
DEFAULT_ENV_SOURCE="${REPO_ROOT}/.env.remote"
if [[ ! -f "${DEFAULT_ENV_SOURCE}" ]]; then
  DEFAULT_ENV_SOURCE="${REPO_ROOT}/.env"
fi
ENV_SOURCE="${ENV_SOURCE:-${DEFAULT_ENV_SOURCE}}"
SERVICE_FILE_SOURCE="${REPO_ROOT}/deploy/agent-foundry-backend.service"
SYNC_SCRIPT="${REPO_ROOT}/deploy/sync-hermes-cron-jobs.sh"
SYNC_SERVICE_FILE_SOURCE="${REPO_ROOT}/deploy/agent-foundry-hermes-cron-sync.service"
SYNC_PATH_FILE_SOURCE="${REPO_ROOT}/deploy/agent-foundry-hermes-cron-sync.path"
PYTHON_PROJECT_DIR="${REPO_ROOT}/backend/python"
LOCAL_TMP_DIR="$(mktemp -d /tmp/agent-foundry-deploy-local.XXXXXX)"
SERVICE_FILE="${LOCAL_TMP_DIR}/agent-foundry-backend.service"
SYNC_SERVICE_FILE="${LOCAL_TMP_DIR}/agent-foundry-hermes-cron-sync.service"
SYNC_PATH_FILE="${LOCAL_TMP_DIR}/agent-foundry-hermes-cron-sync.path"
PYTHON_DIST_DIR="${LOCAL_TMP_DIR}/python-dist"
PYTHON_REQUIREMENTS_FILE="${LOCAL_TMP_DIR}/python-requirements.txt"
PYTHON_WHEEL_FILE=""
PYTHON_WHEEL_BASENAME=""

render_systemd_unit() {
  local source_file="$1"
  local output_file="$2"
  local unit_user="$3"
  sed \
    -e "s#/home/rz/Agent-Foundry#${REMOTE_ROOT}#g" \
    -e "s#User=rz#User=${unit_user}#g" \
    -e "s#Group=rz#Group=${REMOTE_GROUP}#g" \
    -e "s#/home/rz/.local/bin#${REMOTE_UV_DIR}#g" \
    -e "s#/home/rz/.local/bin/uv#${REMOTE_UV_BIN}#g" \
    -e "s#/home/rz/.hermes/cron/jobs.json#${HERMES_CRON_SOURCE_PATH}#g" \
    "${source_file}" > "${output_file}"
}

cleanup_local() {
  rm -rf "${LOCAL_TMP_DIR}" >/dev/null 2>&1 || true
}
trap cleanup_local EXIT

if [[ ! -f "${ENV_SOURCE}" ]]; then
  echo "Missing ${ENV_SOURCE}; create .env.remote for VPS deploys or .env for local defaults." >&2
  exit 1
fi

ENV_FILE="${ENV_SOURCE}"
echo "Using env file: ${ENV_FILE}"

echo "Building release binary..."
cargo build --release --manifest-path "${REPO_ROOT}/Cargo.toml"
echo "Building Python wheel..."
uv build --wheel --out-dir "${PYTHON_DIST_DIR}" "${PYTHON_PROJECT_DIR}"
uv export --quiet --directory "${PYTHON_PROJECT_DIR}" --frozen --no-dev --no-emit-project --format requirements.txt --output-file "${PYTHON_REQUIREMENTS_FILE}"
mapfile -t wheel_files < <(find "${PYTHON_DIST_DIR}" -maxdepth 1 -name '*.whl' -type f | sort)
if [[ "${#wheel_files[@]}" -ne 1 ]]; then
  echo "Expected exactly one Python wheel in ${PYTHON_DIST_DIR}, found ${#wheel_files[@]}." >&2
  exit 1
fi
PYTHON_WHEEL_FILE="${wheel_files[0]}"
PYTHON_WHEEL_BASENAME="$(basename -- "${PYTHON_WHEEL_FILE}")"
render_systemd_unit "${SERVICE_FILE_SOURCE}" "${SERVICE_FILE}" "${REMOTE_USER}"
render_systemd_unit "${SYNC_SERVICE_FILE_SOURCE}" "${SYNC_SERVICE_FILE}" "${SYNC_USER}"
render_systemd_unit "${SYNC_PATH_FILE_SOURCE}" "${SYNC_PATH_FILE}" "${SYNC_USER}"

TMP_DIR="$(ssh "${SSH_HOST}" 'mktemp -d /tmp/agent-foundry-deploy.XXXXXX')"
cleanup() {
  ssh "${SSH_HOST}" "rm -rf '${TMP_DIR}'" >/dev/null 2>&1 || true
  cleanup_local
}
trap cleanup EXIT

echo "Uploading files to ${SSH_HOST}:${TMP_DIR}..."
scp "${BINARY}" "${SSH_HOST}:${TMP_DIR}/agent-foundry-backend"
scp "${ENV_FILE}" "${SSH_HOST}:${TMP_DIR}/agent-foundry.env"
scp "${SERVICE_FILE}" "${SSH_HOST}:${TMP_DIR}/agent-foundry-backend.service"
scp "${SYNC_SCRIPT}" "${SSH_HOST}:${TMP_DIR}/sync-hermes-cron-jobs.sh"
scp "${SYNC_SERVICE_FILE}" "${SSH_HOST}:${TMP_DIR}/agent-foundry-hermes-cron-sync.service"
scp "${SYNC_PATH_FILE}" "${SSH_HOST}:${TMP_DIR}/agent-foundry-hermes-cron-sync.path"
scp "${PYTHON_WHEEL_FILE}" "${SSH_HOST}:${TMP_DIR}/${PYTHON_WHEEL_BASENAME}"
scp "${PYTHON_REQUIREMENTS_FILE}" "${SSH_HOST}:${TMP_DIR}/python-requirements.txt"

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
  sudo find '${REMOTE_ROOT}/bin' -maxdepth 1 -type f \( -name 'agent_foundry_python-*.whl' -o -name 'agent-foundry-python*.whl' \) -delete
  sudo mv '${TMP_DIR}/${PYTHON_WHEEL_BASENAME}' '${REMOTE_ROOT}/bin/${PYTHON_WHEEL_BASENAME}'
  sudo mv '${TMP_DIR}/python-requirements.txt' '${REMOTE_ROOT}/bin/python-requirements.txt'
  sudo mv '${TMP_DIR}/agent-foundry.env' '${REMOTE_ROOT}/.env'
  sudo rm -rf '${REMOTE_ROOT}/tools/tr-structured-products'
  sudo install -d -o '${REMOTE_USER}' -g '${REMOTE_GROUP}' -m 0755 '${REMOTE_ROOT}/backend/python' '${REMOTE_PYTHON_VENV}'
  sudo mv '${TMP_DIR}/sync-hermes-cron-jobs.sh' '${REMOTE_ROOT}/bin/sync-hermes-cron-jobs.sh'
  sudo mv '${TMP_DIR}/agent-foundry-backend.service' '/etc/systemd/system/${SERVICE_NAME}.service'
  sudo mv '${TMP_DIR}/agent-foundry-hermes-cron-sync.service' '/etc/systemd/system/${SYNC_SERVICE_NAME}.service'
  sudo mv '${TMP_DIR}/agent-foundry-hermes-cron-sync.path' '/etc/systemd/system/${SYNC_SERVICE_NAME}.path'
  sudo install -d -o '${REMOTE_USER}' -g '${REMOTE_GROUP}' -m 2750 '${REMOTE_ROOT}/data/uv-cache'
  sudo install -d -o '${REMOTE_USER}' -g '${REMOTE_GROUP}' -m 2750 '${REMOTE_ROOT}/data/playwright-browsers'
  sudo chown -R '${REMOTE_USER}:${REMOTE_GROUP}' '${REMOTE_PYTHON_VENV}' '${REMOTE_ROOT}/data/uv-cache' '${REMOTE_ROOT}/data/playwright-browsers'
  sudo -u '${REMOTE_USER}' env UV_CACHE_DIR='${REMOTE_ROOT}/data/uv-cache' '${REMOTE_UV_BIN}' venv '${REMOTE_PYTHON_VENV}'
  sudo -u '${REMOTE_USER}' env UV_CACHE_DIR='${REMOTE_ROOT}/data/uv-cache' '${REMOTE_UV_BIN}' pip install --python '${REMOTE_PYTHON_VENV}/bin/python' --exact --strict --reinstall-package agent-foundry-python -r '${REMOTE_ROOT}/bin/python-requirements.txt' '${REMOTE_ROOT}/bin/${PYTHON_WHEEL_BASENAME}'
  sudo -u '${REMOTE_USER}' env UV_CACHE_DIR='${REMOTE_ROOT}/data/uv-cache' PLAYWRIGHT_BROWSERS_PATH='${REMOTE_ROOT}/data/playwright-browsers' '${REMOTE_PYTHON_VENV}/bin/playwright' install chromium
  if sudo grep -q '^PDF_EXTRACT_COMMAND=' '${REMOTE_ROOT}/.env'; then
    sudo sed -i 's#^PDF_EXTRACT_COMMAND=.*#PDF_EXTRACT_COMMAND=${REMOTE_PYTHON_VENV}/bin/agent-foundry-extract-pdf#' '${REMOTE_ROOT}/.env'
  else
    echo 'PDF_EXTRACT_COMMAND=${REMOTE_PYTHON_VENV}/bin/agent-foundry-extract-pdf' | sudo tee -a '${REMOTE_ROOT}/.env' >/dev/null
  fi
  if sudo grep -q '^MACRO_ANALYSIS_COMMAND=' '${REMOTE_ROOT}/.env'; then
    sudo sed -i 's#^MACRO_ANALYSIS_COMMAND=.*#MACRO_ANALYSIS_COMMAND=${REMOTE_PYTHON_VENV}/bin/agent-foundry-macro-analysis#' '${REMOTE_ROOT}/.env'
  else
    echo 'MACRO_ANALYSIS_COMMAND=${REMOTE_PYTHON_VENV}/bin/agent-foundry-macro-analysis' | sudo tee -a '${REMOTE_ROOT}/.env' >/dev/null
  fi
  if sudo grep -q '^STRUCTURED_PRODUCTS_ENRICHMENT_COMMAND=' '${REMOTE_ROOT}/.env'; then
    sudo sed -i 's#^STRUCTURED_PRODUCTS_ENRICHMENT_COMMAND=.*#STRUCTURED_PRODUCTS_ENRICHMENT_COMMAND=${REMOTE_PYTHON_VENV}/bin/agent-foundry-structured-products#' '${REMOTE_ROOT}/.env'
  else
    echo 'STRUCTURED_PRODUCTS_ENRICHMENT_COMMAND=${REMOTE_PYTHON_VENV}/bin/agent-foundry-structured-products' | sudo tee -a '${REMOTE_ROOT}/.env' >/dev/null
  fi
  if sudo grep -q '^STRUCTURED_PRODUCTS_ENRICHMENT_WORKDIR=' '${REMOTE_ROOT}/.env'; then
    sudo sed -i 's#^STRUCTURED_PRODUCTS_ENRICHMENT_WORKDIR=.*#STRUCTURED_PRODUCTS_ENRICHMENT_WORKDIR=${REMOTE_ROOT}#' '${REMOTE_ROOT}/.env'
  else
    echo 'STRUCTURED_PRODUCTS_ENRICHMENT_WORKDIR=${REMOTE_ROOT}' | sudo tee -a '${REMOTE_ROOT}/.env' >/dev/null
  fi
  if sudo grep -q '^HERMES_CRON_JOBS_PATH=' '${REMOTE_ROOT}/.env'; then
    sudo sed -i 's#^HERMES_CRON_JOBS_PATH=.*#HERMES_CRON_JOBS_PATH=data/hermes-cron/jobs.json#' '${REMOTE_ROOT}/.env'
  else
    echo 'HERMES_CRON_JOBS_PATH=data/hermes-cron/jobs.json' | sudo tee -a '${REMOTE_ROOT}/.env' >/dev/null
  fi
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
