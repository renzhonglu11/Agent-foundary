#!/usr/bin/env bash
set -euo pipefail
umask 077

# Back up every SQLite database in the shared data directory as one set.
#   backup-sqlite-databases.sh daily
#   backup-sqlite-databases.sh pre-deploy <release-id>

KIND="${1:-}"
LABEL="${2:-}"
DATA_DIR="${AGENT_FOUNDRY_DATA_DIR:-/home/rz/Agent-Foundry/shared/data}"
BACKUP_ROOT="${AGENT_FOUNDRY_BACKUP_DIR:-/home/rz/Agent-Foundry/shared/backups}"

case "${KIND}" in
  daily) KEEP="${AGENT_FOUNDRY_BACKUP_KEEP:-14}" ;;
  pre-deploy) KEEP="${AGENT_FOUNDRY_BACKUP_KEEP:-10}" ;;
  *)
    echo "Usage: $0 daily|pre-deploy [label]" >&2
    exit 2
    ;;
esac
if [[ ! "${KEEP}" =~ ^[1-9][0-9]*$ ]]; then
  echo "AGENT_FOUNDRY_BACKUP_KEEP must be a positive integer." >&2
  exit 2
fi
if [[ ! "${LABEL}" =~ ^[A-Za-z0-9._-]*$ ]]; then
  echo "Backup label may contain only letters, numbers, '.', '_' and '-'." >&2
  exit 2
fi
command -v sqlite3 >/dev/null || { echo "sqlite3 is required." >&2; exit 1; }

shopt -s nullglob
databases=("${DATA_DIR}"/*.db "${DATA_DIR}"/*.sqlite3)
if [[ "${#databases[@]}" -eq 0 ]]; then
  echo "No SQLite databases in ${DATA_DIR}; nothing to back up."
  exit 0
fi

dest_dir="${BACKUP_ROOT}/${KIND}"
set_name="$(date -u +%Y%m%dT%H%M%SZ)${LABEL:+-${LABEL}}"
install -d -m 0700 "${dest_dir}"
work_dir="$(mktemp -d "${dest_dir}/.${set_name}.XXXXXX")"
trap 'rm -rf "${work_dir}"' EXIT

for database in "${databases[@]}"; do
  copy="${work_dir}/$(basename -- "${database}")"
  # The online backup API yields a consistent snapshot while the backend keeps writing.
  sqlite3 -cmd ".timeout 30000" "${database}" ".backup '${copy}'"
  integrity="$(sqlite3 "${copy}" 'PRAGMA integrity_check')"
  if [[ "${integrity}" != ok ]]; then
    echo "Backup integrity check failed for ${database}: ${integrity}" >&2
    exit 1
  fi
  gzip "${copy}"
done

# Publish the set only once every database is copied and verified.
mv -T "${work_dir}" "${dest_dir}/${set_name}"
trap - EXIT
echo "Backed up ${#databases[@]} database(s) to ${dest_dir}/${set_name}"

# Set names start with a UTC timestamp, so lexical order is chronological.
mapfile -t sets < <(find "${dest_dir}" -mindepth 1 -maxdepth 1 -type d ! -name '.*' -printf '%f\n' | sort)
for ((i = 0; i < ${#sets[@]} - KEEP; i++)); do
  rm -rf -- "${dest_dir:?}/${sets[i]}"
  echo "Pruned ${dest_dir}/${sets[i]}"
done
