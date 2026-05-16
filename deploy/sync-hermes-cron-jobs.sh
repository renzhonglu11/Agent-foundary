#!/usr/bin/env bash
set -euo pipefail

SOURCE_PATH="${HERMES_SOURCE_CRON_JOBS_PATH:-/home/rz/.hermes/cron/jobs.json}"
DEST_PATH="${AGENT_FOUNDRY_CRON_JOBS_PATH:-/opt/agent-foundry/data/hermes-cron/jobs.json}"
DEST_DIR="$(dirname -- "${DEST_PATH}")"

if [[ ! -f "${SOURCE_PATH}" ]]; then
  echo "Hermes cron jobs source not found: ${SOURCE_PATH}" >&2
  exit 1
fi

install -d -m 2750 "${DEST_DIR}"

tmp="$(mktemp "${DEST_DIR}/jobs.json.tmp.XXXXXX")"
cleanup() {
  rm -f "${tmp}"
}
trap cleanup EXIT

install -m 0640 "${SOURCE_PATH}" "${tmp}"
mv -f "${tmp}" "${DEST_PATH}"
trap - EXIT

echo "Synced ${SOURCE_PATH} -> ${DEST_PATH}"
