#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE_ROOT="${REMOTE_ROOT:-/home/rz/Agent-Foundry}"
REMOTE_USER="${REMOTE_USER:-rz}"
REMOTE_GROUP="${REMOTE_GROUP:-rz}"
SYNC_USER="${SYNC_USER:-rz}"
BACKEND_SERVICE="${BACKEND_SERVICE:-agent-foundry-backend}"
SYNC_SERVICE="${SYNC_SERVICE:-agent-foundry-hermes-cron-sync}"
REMOTE_UV_BIN="${REMOTE_UV_BIN:-/home/rz/.local/bin/uv}"
REMOTE_UV_DIR="$(dirname -- "${REMOTE_UV_BIN}")"
HERMES_CRON_SOURCE_PATH="${HERMES_CRON_SOURCE_PATH:-/home/${SYNC_USER}/.hermes/cron/jobs.json}"
PYTHON_PROJECT_DIR="${REPO_ROOT}/backend/python"
LOCAL_TMP_DIR="$(mktemp -d /tmp/agent-foundry-local-install.XXXXXX)"

cleanup() {
  rm -rf "${LOCAL_TMP_DIR}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

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

BACKEND_UNIT="${LOCAL_TMP_DIR}/agent-foundry-backend.service"
SYNC_UNIT="${LOCAL_TMP_DIR}/agent-foundry-hermes-cron-sync.service"
SYNC_PATH_UNIT="${LOCAL_TMP_DIR}/agent-foundry-hermes-cron-sync.path"

cargo build --release --manifest-path "${REPO_ROOT}/Cargo.toml"
render_systemd_unit "${REPO_ROOT}/deploy/agent-foundry-backend.service" "${BACKEND_UNIT}" "${REMOTE_USER}"
render_systemd_unit "${REPO_ROOT}/deploy/agent-foundry-hermes-cron-sync.service" "${SYNC_UNIT}" "${SYNC_USER}"
render_systemd_unit "${REPO_ROOT}/deploy/agent-foundry-hermes-cron-sync.path" "${SYNC_PATH_UNIT}" "${SYNC_USER}"

sudo install -d -o "${REMOTE_USER}" -g "${REMOTE_GROUP}" -m 0755 "${REMOTE_ROOT}/bin" "${REMOTE_ROOT}/data" "${REMOTE_ROOT}/backend"
sudo install -o "${REMOTE_USER}" -g "${REMOTE_GROUP}" -m 0755 \
  "${REPO_ROOT}/target/release/agent-foundry-backend" \
  "${REMOTE_ROOT}/bin/agent-foundry-backend"
sudo install -o root -g root -m 0644 \
  "${BACKEND_UNIT}" \
  "/etc/systemd/system/${BACKEND_SERVICE}.service"
sudo mkdir -p "${REMOTE_ROOT}/backend/python"
sudo rsync -a --delete \
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
  "${REMOTE_ROOT}/backend/python/"
sudo install -d -o "${REMOTE_USER}" -g "${REMOTE_GROUP}" -m 2750 "${REMOTE_ROOT}/data/uv-cache" "${REMOTE_ROOT}/data/playwright-browsers"
sudo chown -R "${REMOTE_USER}:${REMOTE_GROUP}" "${REMOTE_ROOT}/backend/python" "${REMOTE_ROOT}/data/uv-cache" "${REMOTE_ROOT}/data/playwright-browsers"
sudo -u "${REMOTE_USER}" env UV_CACHE_DIR="${REMOTE_ROOT}/data/uv-cache" "${REMOTE_UV_BIN}" sync --directory "${REMOTE_ROOT}/backend/python" --frozen --no-dev
sudo -u "${REMOTE_USER}" env UV_CACHE_DIR="${REMOTE_ROOT}/data/uv-cache" PLAYWRIGHT_BROWSERS_PATH="${REMOTE_ROOT}/data/playwright-browsers" "${REMOTE_UV_BIN}" run --directory "${REMOTE_ROOT}/backend/python" playwright install chromium
sudo install -d -o "${SYNC_USER}" -g "${REMOTE_GROUP}" -m 2750 "${REMOTE_ROOT}/data/hermes-cron"
sudo install -o "${REMOTE_USER}" -g "${REMOTE_GROUP}" -m 0755 \
  "${REPO_ROOT}/deploy/sync-hermes-cron-jobs.sh" \
  "${REMOTE_ROOT}/bin/sync-hermes-cron-jobs.sh"

sudo install -o root -g root -m 0644 \
  "${SYNC_UNIT}" \
  "/etc/systemd/system/${SYNC_SERVICE}.service"
sudo install -o root -g root -m 0644 \
  "${SYNC_PATH_UNIT}" \
  "/etc/systemd/system/${SYNC_SERVICE}.path"

sudo touch "${REMOTE_ROOT}/.env"
if sudo grep -q '^HERMES_CRON_JOBS_PATH=' "${REMOTE_ROOT}/.env"; then
  sudo sed -i 's#^HERMES_CRON_JOBS_PATH=.*#HERMES_CRON_JOBS_PATH=data/hermes-cron/jobs.json#' "${REMOTE_ROOT}/.env"
else
  echo 'HERMES_CRON_JOBS_PATH=data/hermes-cron/jobs.json' | sudo tee -a "${REMOTE_ROOT}/.env" >/dev/null
fi
sudo chown "${REMOTE_USER}:${REMOTE_GROUP}" "${REMOTE_ROOT}/.env"

sudo systemctl disable --now agent-foundry-cron-data.timer agent-foundry-cron-data.service 2>/dev/null || true
sudo rm -f /etc/systemd/system/agent-foundry-cron-data.timer /etc/systemd/system/agent-foundry-cron-data.service
sudo systemctl daemon-reload
sudo systemctl enable --now "${SYNC_SERVICE}.path"
sudo systemctl start "${SYNC_SERVICE}.service"
sudo systemctl restart "${BACKEND_SERVICE}"

systemctl --no-pager --full status "${SYNC_SERVICE}.path" "${SYNC_SERVICE}.service" "${BACKEND_SERVICE}"
curl -fsS http://127.0.0.1:8080/data/hermes-cron-status.json | python3 -m json.tool | sed -n '1,80p'
