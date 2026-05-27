#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE_ROOT="${REMOTE_ROOT:-/home/rz/Agent-Foundry}"
REMOTE_USER="${REMOTE_USER:-rz}"
REMOTE_GROUP="${REMOTE_GROUP:-rz}"
SYNC_USER="${SYNC_USER:-rz}"
BACKEND_SERVICE="${BACKEND_SERVICE:-agent-foundry-backend}"
SYNC_SERVICE="${SYNC_SERVICE:-agent-foundry-hermes-cron-sync}"

sudo install -d -o "${REMOTE_USER}" -g "${REMOTE_GROUP}" -m 0755 "${REMOTE_ROOT}/bin" "${REMOTE_ROOT}/data"
if [[ ! -x "${REPO_ROOT}/target/release/agent-foundry-backend" ]]; then
  cargo build --release --manifest-path "${REPO_ROOT}/Cargo.toml"
fi
sudo install -o "${REMOTE_USER}" -g "${REMOTE_GROUP}" -m 0755 \
  "${REPO_ROOT}/target/release/agent-foundry-backend" \
  "${REMOTE_ROOT}/bin/agent-foundry-backend"
sudo install -o root -g root -m 0644 \
  "${REPO_ROOT}/deploy/agent-foundry-backend.service" \
  "/etc/systemd/system/${BACKEND_SERVICE}.service"
sudo install -d -o "${SYNC_USER}" -g "${REMOTE_GROUP}" -m 2750 "${REMOTE_ROOT}/data/hermes-cron"
sudo install -o "${REMOTE_USER}" -g "${REMOTE_GROUP}" -m 0755 \
  "${REPO_ROOT}/deploy/sync-hermes-cron-jobs.sh" \
  "${REMOTE_ROOT}/bin/sync-hermes-cron-jobs.sh"

sudo install -o root -g root -m 0644 \
  "${REPO_ROOT}/deploy/agent-foundry-hermes-cron-sync.service" \
  "/etc/systemd/system/${SYNC_SERVICE}.service"
sudo install -o root -g root -m 0644 \
  "${REPO_ROOT}/deploy/agent-foundry-hermes-cron-sync.path" \
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
