#!/usr/bin/env bash
set -euo pipefail

# Install a release on the current machine. This is useful when the repository is
# checked out directly on a server; normal VPS deployments should use
# deploy-backend.sh from the build machine instead.

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
WEB_DIR="${REPO_ROOT}/web"
LOCAL_TMP_DIR="$(mktemp -d /tmp/agent-foundry-local-install.XXXXXX)"
PYTHON_DIST_DIR="${LOCAL_TMP_DIR}/python-dist"
PYTHON_REQUIREMENTS_FILE="${LOCAL_TMP_DIR}/python-requirements.txt"
FRONTEND_ARCHIVE="${LOCAL_TMP_DIR}/web-dist.tar.gz"
REVISION_FILE="${LOCAL_TMP_DIR}/REVISION"
RUNTIME_ENV_FILE="${LOCAL_TMP_DIR}/agent-foundry-runtime.env"

cleanup() {
  rm -rf "${LOCAL_TMP_DIR}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

GIT_REVISION="$(git -C "${REPO_ROOT}" rev-parse --verify HEAD)"
RELEASE_ID="${RELEASE_ID:-${GIT_REVISION:0:12}-$(date -u +%Y%m%d%H%M%S)}"
if [[ ! "${RELEASE_ID}" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "RELEASE_ID may contain only letters, numbers, '.', '_' and '-'." >&2
  exit 1
fi

render_systemd_unit() {
  local source_file="$1"
  local output_file="$2"
  local unit_user="$3"
  sed \
    -e "s#/home/rz/Agent-Foundry#${REMOTE_ROOT}#g" \
    -e "s#User=rz#User=${unit_user}#g" \
    -e "s#Group=rz#Group=${REMOTE_GROUP}#g" \
    -e "s#/home/rz/.local/bin#${REMOTE_UV_DIR}#g" \
    -e "s#HERMES_SOURCE_CRON_JOBS_PATH=/home/rz/.hermes/cron/jobs.json#HERMES_SOURCE_CRON_JOBS_PATH=${HERMES_CRON_SOURCE_PATH}#g" \
    "${source_file}" > "${output_file}"
}

echo "Building release artifacts..."
cargo build --release --manifest-path "${REPO_ROOT}/Cargo.toml"
uv build --wheel --out-dir "${PYTHON_DIST_DIR}" "${PYTHON_PROJECT_DIR}"
uv export --quiet --directory "${PYTHON_PROJECT_DIR}" --frozen --no-dev --no-emit-project --format requirements.txt --output-file "${PYTHON_REQUIREMENTS_FILE}"
npm --prefix "${WEB_DIR}" run build
tar -C "${WEB_DIR}/dist" -czf "${FRONTEND_ARCHIVE}" .

mapfile -t wheel_files < <(find "${PYTHON_DIST_DIR}" -maxdepth 1 -name '*.whl' -type f | sort)
if [[ "${#wheel_files[@]}" -ne 1 ]]; then
  echo "Expected exactly one Python wheel in ${PYTHON_DIST_DIR}, found ${#wheel_files[@]}." >&2
  exit 1
fi

{
  printf 'revision=%s\n' "${GIT_REVISION}"
  printf 'release_id=%s\n' "${RELEASE_ID}"
  printf 'built_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  if git -C "${REPO_ROOT}" diff --quiet && git -C "${REPO_ROOT}" diff --cached --quiet; then
    printf 'worktree_dirty=false\n'
  else
    printf 'worktree_dirty=true\n'
  fi
} > "${REVISION_FILE}"

BACKEND_UNIT="${LOCAL_TMP_DIR}/agent-foundry-backend.service"
SYNC_UNIT="${LOCAL_TMP_DIR}/agent-foundry-hermes-cron-sync.service"
SYNC_PATH_UNIT="${LOCAL_TMP_DIR}/agent-foundry-hermes-cron-sync.path"
render_systemd_unit "${REPO_ROOT}/deploy/agent-foundry-backend.service" "${BACKEND_UNIT}" "${REMOTE_USER}"
render_systemd_unit "${REPO_ROOT}/deploy/agent-foundry-runtime.env" "${RUNTIME_ENV_FILE}" "${REMOTE_USER}"
render_systemd_unit "${REPO_ROOT}/deploy/agent-foundry-hermes-cron-sync.service" "${SYNC_UNIT}" "${SYNC_USER}"
render_systemd_unit "${REPO_ROOT}/deploy/agent-foundry-hermes-cron-sync.path" "${SYNC_PATH_UNIT}" "${SYNC_USER}"

RELEASES_DIR="${REMOTE_ROOT}/releases"
SHARED_DIR="${REMOTE_ROOT}/shared"
CURRENT_LINK="${REMOTE_ROOT}/current"
RELEASE_DIR="${RELEASES_DIR}/${RELEASE_ID}"
PYTHON_VENV="${RELEASE_DIR}/python/.venv"

sudo install -d -o "${REMOTE_USER}" -g "${REMOTE_GROUP}" -m 0755 "${RELEASES_DIR}" "${SHARED_DIR}"
sudo install -d -o "${REMOTE_USER}" -g "${REMOTE_GROUP}" -m 0750 "${SHARED_DIR}/cache"

if [[ ! -f "${SHARED_DIR}/.env" ]]; then
  if [[ -f "${REMOTE_ROOT}/.env" ]]; then
    sudo mv "${REMOTE_ROOT}/.env" "${SHARED_DIR}/.env"
  else
    echo "Missing ${SHARED_DIR}/.env. Create it on this server before installing." >&2
    exit 1
  fi
fi
sudo chown "${REMOTE_USER}:${REMOTE_GROUP}" "${SHARED_DIR}/.env"
sudo chmod 0600 "${SHARED_DIR}/.env"

legacy_data_present=0
UV_CACHE_DIR="${SHARED_DIR}/cache/uv"
PLAYWRIGHT_BROWSERS_PATH="${SHARED_DIR}/cache/playwright"
if [[ -d "${REMOTE_ROOT}/data" && ! -e "${SHARED_DIR}/data" ]]; then
  legacy_data_present=1
  UV_CACHE_DIR="${REMOTE_ROOT}/data/uv-cache"
  PLAYWRIGHT_BROWSERS_PATH="${REMOTE_ROOT}/data/playwright-browsers"
elif [[ -d "${REMOTE_ROOT}/data" && -e "${SHARED_DIR}/data" ]]; then
  echo "Both ${REMOTE_ROOT}/data and ${SHARED_DIR}/data exist; refusing to choose between them." >&2
  exit 1
else
  sudo install -d -o "${REMOTE_USER}" -g "${REMOTE_GROUP}" -m 0750 \
    "${SHARED_DIR}/data" "${SHARED_DIR}/data/uploads" "${SHARED_DIR}/data/hermes-cron" \
    "${UV_CACHE_DIR}" "${PLAYWRIGHT_BROWSERS_PATH}"
fi

if [[ -e "${RELEASE_DIR}" ]]; then
  echo "Release directory already exists: ${RELEASE_DIR}" >&2
  exit 1
fi
sudo install -d -o "${REMOTE_USER}" -g "${REMOTE_GROUP}" -m 0755 \
  "${RELEASE_DIR}/bin" "${RELEASE_DIR}/python" "${RELEASE_DIR}/web/dist"
sudo install -o "${REMOTE_USER}" -g "${REMOTE_GROUP}" -m 0755 \
  "${REPO_ROOT}/target/release/agent-foundry-backend" \
  "${RELEASE_DIR}/bin/agent-foundry-backend"
sudo install -o "${REMOTE_USER}" -g "${REMOTE_GROUP}" -m 0755 \
  "${REPO_ROOT}/deploy/sync-hermes-cron-jobs.sh" \
  "${RELEASE_DIR}/bin/sync-hermes-cron-jobs.sh"
sudo install -o "${REMOTE_USER}" -g "${REMOTE_GROUP}" -m 0644 \
  "${wheel_files[0]}" "${RELEASE_DIR}/python/"
sudo install -o "${REMOTE_USER}" -g "${REMOTE_GROUP}" -m 0644 \
  "${PYTHON_REQUIREMENTS_FILE}" "${RELEASE_DIR}/python/requirements.txt"
sudo install -o "${REMOTE_USER}" -g "${REMOTE_GROUP}" -m 0644 \
  "${REVISION_FILE}" "${RELEASE_DIR}/REVISION"
sudo install -o "${REMOTE_USER}" -g "${REMOTE_GROUP}" -m 0644 \
  "${RUNTIME_ENV_FILE}" "${RELEASE_DIR}/runtime.env"
sudo tar -xzf "${FRONTEND_ARCHIVE}" -C "${RELEASE_DIR}/web/dist"
sudo chown -R "${REMOTE_USER}:${REMOTE_GROUP}" "${RELEASE_DIR}"

sudo -u "${REMOTE_USER}" env UV_CACHE_DIR="${UV_CACHE_DIR}" "${REMOTE_UV_BIN}" venv "${PYTHON_VENV}"
sudo -u "${REMOTE_USER}" env UV_CACHE_DIR="${UV_CACHE_DIR}" "${REMOTE_UV_BIN}" pip install \
  --python "${PYTHON_VENV}/bin/python" \
  --exact --strict --reinstall-package agent-foundry-python \
  -r "${RELEASE_DIR}/python/requirements.txt" \
  "${RELEASE_DIR}/python/"*.whl
sudo -u "${REMOTE_USER}" env \
  UV_CACHE_DIR="${UV_CACHE_DIR}" \
  PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH}" \
  "${PYTHON_VENV}/bin/playwright" install chromium

if [[ "${legacy_data_present}" -eq 1 ]]; then
  sudo systemctl stop "${BACKEND_SERVICE}" || true
  sudo mv "${REMOTE_ROOT}/data" "${SHARED_DIR}/data"
  sudo mv "${SHARED_DIR}/data/uv-cache" "${SHARED_DIR}/cache/uv"
  sudo mv "${SHARED_DIR}/data/playwright-browsers" "${SHARED_DIR}/cache/playwright"
fi
sudo install -d -o "${REMOTE_USER}" -g "${REMOTE_GROUP}" -m 0750 \
  "${SHARED_DIR}/data" "${SHARED_DIR}/data/uploads" "${SHARED_DIR}/data/hermes-cron" \
  "${SHARED_DIR}/cache/uv" "${SHARED_DIR}/cache/playwright"
sudo chown -R "${REMOTE_USER}:${REMOTE_GROUP}" "${SHARED_DIR}/data" "${SHARED_DIR}/cache"

sudo install -o root -g root -m 0644 "${BACKEND_UNIT}" "/etc/systemd/system/${BACKEND_SERVICE}.service"
sudo install -o root -g root -m 0644 "${SYNC_UNIT}" "/etc/systemd/system/${SYNC_SERVICE}.service"
sudo install -o root -g root -m 0644 "${SYNC_PATH_UNIT}" "/etc/systemd/system/${SYNC_SERVICE}.path"

cron_file="$(mktemp)"
if crontab -l > "${cron_file}" 2>/dev/null; then
  if grep -q '# agent-foundry-cron-data[[:space:]]*$' "${cron_file}"; then
    sed -i '/# agent-foundry-cron-data[[:space:]]*$/d' "${cron_file}"
    crontab "${cron_file}"
  fi
fi
rm -f "${cron_file}"

next_link="${CURRENT_LINK}.next"
sudo rm -f "${next_link}"
sudo ln -s "${RELEASE_DIR}" "${next_link}"
sudo mv -Tf "${next_link}" "${CURRENT_LINK}"

sudo systemctl disable --now agent-foundry-cron-data.timer agent-foundry-cron-data.service 2>/dev/null || true
sudo rm -f /etc/systemd/system/agent-foundry-cron-data.timer /etc/systemd/system/agent-foundry-cron-data.service
sudo systemctl daemon-reload
sudo systemctl enable --now "${SYNC_SERVICE}.path"
sudo systemctl start "${SYNC_SERVICE}.service" || true
sudo systemctl enable "${BACKEND_SERVICE}"
sudo systemctl restart "${BACKEND_SERVICE}"

for attempt in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:8080/health; then
    echo
    echo "Installed release ${RELEASE_ID}."
    exit 0
  fi
  sleep 1
done

sudo systemctl --no-pager --full status "${BACKEND_SERVICE}" || true
sudo journalctl -u "${BACKEND_SERVICE}" -n 80 --no-pager || true
exit 1
