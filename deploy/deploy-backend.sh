#!/usr/bin/env bash
set -euo pipefail

SSH_HOST="${SSH_HOST:-hermes-do}"
REMOTE_ROOT="${REMOTE_ROOT:-/home/rz/Agent-Foundry}"
REMOTE_USER="${REMOTE_USER:-rz}"
REMOTE_GROUP="${REMOTE_GROUP:-rz}"
SYNC_USER="${SYNC_USER:-rz}"
SERVICE_NAME="${SERVICE_NAME:-agent-foundry-backend}"
SYNC_SERVICE_NAME="${SYNC_SERVICE_NAME:-agent-foundry-hermes-cron-sync}"
REMOTE_UV_BIN="${REMOTE_UV_BIN:-/home/rz/.local/bin/uv}"
REMOTE_UV_DIR="$(dirname -- "${REMOTE_UV_BIN}")"
HERMES_CRON_SOURCE_PATH="${HERMES_CRON_SOURCE_PATH:-/home/${SYNC_USER}/.hermes/cron/jobs.json}"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
WEB_DIR="${REPO_ROOT}/web"

BINARY="${REPO_ROOT}/target/release/agent-foundry-backend"
SERVICE_FILE_SOURCE="${REPO_ROOT}/deploy/agent-foundry-backend.service"
RUNTIME_ENV_SOURCE="${REPO_ROOT}/deploy/agent-foundry-runtime.env"
SYNC_SCRIPT="${REPO_ROOT}/deploy/sync-hermes-cron-jobs.sh"
SYNC_SERVICE_FILE_SOURCE="${REPO_ROOT}/deploy/agent-foundry-hermes-cron-sync.service"
SYNC_PATH_FILE_SOURCE="${REPO_ROOT}/deploy/agent-foundry-hermes-cron-sync.path"
REMOTE_INSTALL_SCRIPT="${REPO_ROOT}/deploy/install-release-remote.sh"
PYTHON_PROJECT_DIR="${REPO_ROOT}/backend/python"
LOCAL_TMP_DIR="$(mktemp -d /tmp/agent-foundry-deploy-local.XXXXXX)"
SERVICE_FILE="${LOCAL_TMP_DIR}/agent-foundry-backend.service"
RUNTIME_ENV_FILE="${LOCAL_TMP_DIR}/agent-foundry-runtime.env"
SYNC_SERVICE_FILE="${LOCAL_TMP_DIR}/agent-foundry-hermes-cron-sync.service"
SYNC_PATH_FILE="${LOCAL_TMP_DIR}/agent-foundry-hermes-cron-sync.path"
PYTHON_DIST_DIR="${LOCAL_TMP_DIR}/python-dist"
PYTHON_REQUIREMENTS_FILE="${LOCAL_TMP_DIR}/python-requirements.txt"
FRONTEND_ARCHIVE="${LOCAL_TMP_DIR}/web-dist.tar.gz"
REVISION_FILE="${LOCAL_TMP_DIR}/REVISION"
PYTHON_WHEEL_FILE=""
PYTHON_WHEEL_BASENAME=""

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

cleanup_local() {
  rm -rf "${LOCAL_TMP_DIR}" >/dev/null 2>&1 || true
}
trap cleanup_local EXIT

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

echo "Building frontend..."
npm --prefix "${WEB_DIR}" run build
tar -C "${WEB_DIR}/dist" -czf "${FRONTEND_ARCHIVE}" .

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

render_systemd_unit "${SERVICE_FILE_SOURCE}" "${SERVICE_FILE}" "${REMOTE_USER}"
render_systemd_unit "${RUNTIME_ENV_SOURCE}" "${RUNTIME_ENV_FILE}" "${REMOTE_USER}"
render_systemd_unit "${SYNC_SERVICE_FILE_SOURCE}" "${SYNC_SERVICE_FILE}" "${SYNC_USER}"
render_systemd_unit "${SYNC_PATH_FILE_SOURCE}" "${SYNC_PATH_FILE}" "${SYNC_USER}"

TMP_DIR="$(ssh "${SSH_HOST}" 'mktemp -d /tmp/agent-foundry-deploy.XXXXXX')"
cleanup() {
  ssh "${SSH_HOST}" "rm -rf '${TMP_DIR}'" >/dev/null 2>&1 || true
  cleanup_local
}
trap cleanup EXIT

echo "Uploading release ${RELEASE_ID} to ${SSH_HOST}:${TMP_DIR}..."
scp "${BINARY}" "${SSH_HOST}:${TMP_DIR}/agent-foundry-backend"
scp "${SERVICE_FILE}" "${SSH_HOST}:${TMP_DIR}/agent-foundry-backend.service"
scp "${RUNTIME_ENV_FILE}" "${SSH_HOST}:${TMP_DIR}/agent-foundry-runtime.env"
scp "${SYNC_SCRIPT}" "${SSH_HOST}:${TMP_DIR}/sync-hermes-cron-jobs.sh"
scp "${SYNC_SERVICE_FILE}" "${SSH_HOST}:${TMP_DIR}/agent-foundry-hermes-cron-sync.service"
scp "${SYNC_PATH_FILE}" "${SSH_HOST}:${TMP_DIR}/agent-foundry-hermes-cron-sync.path"
scp "${PYTHON_WHEEL_FILE}" "${SSH_HOST}:${TMP_DIR}/${PYTHON_WHEEL_BASENAME}"
scp "${PYTHON_REQUIREMENTS_FILE}" "${SSH_HOST}:${TMP_DIR}/python-requirements.txt"
scp "${FRONTEND_ARCHIVE}" "${SSH_HOST}:${TMP_DIR}/web-dist.tar.gz"
scp "${REVISION_FILE}" "${SSH_HOST}:${TMP_DIR}/REVISION"
scp "${REMOTE_INSTALL_SCRIPT}" "${SSH_HOST}:${TMP_DIR}/install-release-remote.sh"

echo "Installing release on VPS..."
printf -v remote_command 'bash %q %q %q %q %q %q %q %q %q %q' \
  "${TMP_DIR}/install-release-remote.sh" \
  "${REMOTE_ROOT}" \
  "${REMOTE_USER}" \
  "${REMOTE_GROUP}" \
  "${SYNC_USER}" \
  "${SERVICE_NAME}" \
  "${SYNC_SERVICE_NAME}" \
  "${REMOTE_UV_BIN}" \
  "${TMP_DIR}" \
  "${RELEASE_ID}"
ssh -tt "${SSH_HOST}" "${remote_command}"

echo "Deployment complete: ${RELEASE_ID}"
