#!/usr/bin/env bash
set -euo pipefail

remote_root="$1"
remote_user="$2"
remote_group="$3"
sync_user="$4"
service_name="$5"
sync_service_name="$6"
remote_uv_bin="$7"
tmp_dir="$8"
release_id="$9"
playwright_host_platform_override="${10:-}"

if [[ -z "${playwright_host_platform_override}" && -r /etc/os-release ]]; then
  # Playwright 1.60 does not yet publish Ubuntu 26.04 browser builds. Its
  # Ubuntu 24.04 Chromium build is compatible with Ubuntu 26.04 once the
  # browser's system libraries are installed.
  source /etc/os-release
  case "${ID:-}:${VERSION_ID:-}:$(uname -m)" in
    ubuntu:26.04:x86_64)
      playwright_host_platform_override="ubuntu24.04-x64"
      ;;
    ubuntu:26.04:aarch64)
      playwright_host_platform_override="ubuntu24.04-arm64"
      ;;
  esac
fi
if [[ -n "${playwright_host_platform_override}" && ! "${playwright_host_platform_override}" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "Invalid Playwright host platform override: ${playwright_host_platform_override}" >&2
  exit 1
fi

releases_dir="${remote_root}/releases"
shared_dir="${remote_root}/shared"
current_link="${remote_root}/current"
release_dir="${releases_dir}/${release_id}"
python_envs_dir="${shared_dir}/python-envs"
python_venv=""
previous_release=""

rollback() {
  local exit_code="$1"
  if [[ -n "${previous_release}" && -x "${previous_release}/bin/agent-foundry-backend" ]]; then
    echo "Deployment failed; restoring ${previous_release}." >&2
    sudo ln -sfn "${previous_release}" "${current_link}"
    sudo systemctl restart "${service_name}" || true
  fi
  exit "${exit_code}"
}

# The installer is executed from a real SSH TTY, so sudo can authenticate here
# without consuming deployment commands from standard input.
sudo -v

if ! id -u "${remote_user}" >/dev/null 2>&1; then
  sudo useradd --system --home "${remote_root}" --shell /usr/sbin/nologin "${remote_user}"
fi

sudo install -d -o "${remote_user}" -g "${remote_group}" -m 0755 "${releases_dir}" "${shared_dir}"
sudo install -d -o "${remote_user}" -g "${remote_group}" -m 0750 \
  "${shared_dir}/cache" "${python_envs_dir}"

# The only .env migration: retain the existing server-side file and never accept one from a deploy.
if [[ ! -f "${shared_dir}/.env" ]]; then
  if [[ -f "${remote_root}/.env" ]]; then
    sudo mv "${remote_root}/.env" "${shared_dir}/.env"
  else
    echo "Missing ${shared_dir}/.env. Create it on the VPS before deploying." >&2
    exit 1
  fi
fi
sudo chown "${remote_user}:${remote_group}" "${shared_dir}/.env"
sudo chmod 0600 "${shared_dir}/.env"

# Build with the existing cache first. This keeps the initial migration downtime to
# the final data move and systemd restart rather than the whole Python install.
legacy_data_present=0
uv_cache_dir="${shared_dir}/cache/uv"
playwright_cache_dir="${shared_dir}/cache/playwright"
if [[ -d "${remote_root}/data" && ! -e "${shared_dir}/data" ]]; then
  legacy_data_present=1
  uv_cache_dir="${remote_root}/data/uv-cache"
  playwright_cache_dir="${remote_root}/data/playwright-browsers"
elif [[ -d "${remote_root}/data" && -e "${shared_dir}/data" ]]; then
  echo "Both ${remote_root}/data and ${shared_dir}/data exist; refusing to choose between them." >&2
  exit 1
fi
if [[ "${legacy_data_present}" -eq 0 ]]; then
  sudo install -d -o "${remote_user}" -g "${remote_group}" -m 0750 \
    "${shared_dir}/data" "${shared_dir}/data/uploads" "${shared_dir}/data/hermes-cron" \
    "${uv_cache_dir}" "${playwright_cache_dir}"
fi

if [[ -e "${release_dir}" ]]; then
  echo "Release directory already exists: ${release_dir}" >&2
  exit 1
fi
sudo install -d -o "${remote_user}" -g "${remote_group}" -m 0755 \
  "${release_dir}/bin" "${release_dir}/python" "${release_dir}/web/dist"
sudo mv "${tmp_dir}/agent-foundry-backend" "${release_dir}/bin/agent-foundry-backend"
sudo mv "${tmp_dir}/sync-hermes-cron-jobs.sh" "${release_dir}/bin/sync-hermes-cron-jobs.sh"
sudo mv "${tmp_dir}/REVISION" "${release_dir}/REVISION"
sudo mv "${tmp_dir}/agent-foundry-runtime.env" "${release_dir}/runtime.env"
if [[ -n "${playwright_host_platform_override}" ]]; then
  printf 'PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=%s\n' "${playwright_host_platform_override}" | \
    sudo tee -a "${release_dir}/runtime.env" >/dev/null
fi
sudo mv "${tmp_dir}/python-requirements.txt" "${release_dir}/python/requirements.txt"
sudo mv "${tmp_dir}"/*.whl "${release_dir}/python/"
sudo tar -xzf "${tmp_dir}/web-dist.tar.gz" -C "${release_dir}/web/dist"
sudo chown -R "${remote_user}:${remote_group}" "${release_dir}"
sudo chmod +x "${release_dir}/bin/agent-foundry-backend" "${release_dir}/bin/sync-hermes-cron-jobs.sh"

mapfile -t python_wheels < <(find "${release_dir}/python" -maxdepth 1 -name '*.whl' -type f | sort)
if [[ "${#python_wheels[@]}" -ne 1 ]]; then
  echo "Expected exactly one Python wheel in ${release_dir}/python, found ${#python_wheels[@]}." >&2
  exit 1
fi
python_interpreter="$(sudo -u "${remote_user}" env UV_CACHE_DIR="${uv_cache_dir}" \
  "${remote_uv_bin}" python find 3.12)"
requirements_hash="$(sed '/^[[:space:]]*#/d; /^[[:space:]]*$/d' "${release_dir}/python/requirements.txt" | sha256sum | awk '{print $1}')"
wheel_hash="$(sha256sum "${python_wheels[0]}" | awk '{print $1}')"
python_version="$("${python_interpreter}" -VV 2>&1)"
python_env_id="$(printf '%s\n%s\n%s\n%s\n' \
  "${requirements_hash}" "${wheel_hash}" "${python_version}" "$(uname -m)" | sha256sum | awk '{print $1}')"
python_venv="${python_envs_dir}/${python_env_id}"
python_env_marker="${python_venv}/.agent-foundry-complete"

if [[ -x "${python_venv}/bin/python" && -f "${python_env_marker}" ]]; then
  echo "Reusing immutable Python environment ${python_env_id}."
else
  if [[ -e "${python_venv}" || -L "${python_venv}" ]]; then
    echo "Removing incomplete Python environment ${python_env_id}."
    sudo rm -rf "${python_venv}"
  fi
  echo "Creating immutable Python environment ${python_env_id}."
  sudo -u "${remote_user}" env UV_CACHE_DIR="${uv_cache_dir}" \
    "${remote_uv_bin}" venv --python "${python_interpreter}" "${python_venv}"
  sudo -u "${remote_user}" env UV_CACHE_DIR="${uv_cache_dir}" "${remote_uv_bin}" pip install \
    --python "${python_venv}/bin/python" \
    --exact --strict --reinstall-package agent-foundry-python \
    -r "${release_dir}/python/requirements.txt" \
    "${python_wheels[0]}"
  printf 'requirements=%s\nwheel=%s\npython=%s\narch=%s\n' \
    "${requirements_hash}" "${wheel_hash}" "${python_version}" "$(uname -m)" | \
    sudo tee "${python_env_marker}" >/dev/null
  sudo chown "${remote_user}:${remote_group}" "${python_env_marker}"
  sudo chmod 0444 "${python_env_marker}"
fi
sudo -u "${remote_user}" env \
  UV_CACHE_DIR="${uv_cache_dir}" \
  PLAYWRIGHT_BROWSERS_PATH="${playwright_cache_dir}" \
  PLAYWRIGHT_HOST_PLATFORM_OVERRIDE="${playwright_host_platform_override}" \
  "${python_venv}/bin/playwright" install chromium
sudo -u "${remote_user}" env \
  PLAYWRIGHT_BROWSERS_PATH="${playwright_cache_dir}" \
  PLAYWRIGHT_HOST_PLATFORM_OVERRIDE="${playwright_host_platform_override}" \
  "${python_venv}/bin/python" -c 'from playwright.sync_api import sync_playwright
with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    browser.close()'
sudo -u "${remote_user}" ln -s "${python_venv}" "${release_dir}/python/.venv"

# The initial data move is deliberately delayed until the release is fully built.
if [[ "${legacy_data_present}" -eq 1 ]]; then
  if systemctl is-active --quiet "${service_name}"; then
    sudo systemctl stop "${service_name}"
  fi
  sudo mv "${remote_root}/data" "${shared_dir}/data"
  sudo mv "${shared_dir}/data/uv-cache" "${shared_dir}/cache/uv"
  sudo mv "${shared_dir}/data/playwright-browsers" "${shared_dir}/cache/playwright"
fi
sudo install -d -o "${remote_user}" -g "${remote_group}" -m 0750 \
  "${shared_dir}/data" "${shared_dir}/data/uploads" "${shared_dir}/data/hermes-cron" \
  "${shared_dir}/cache/uv" "${shared_dir}/cache/playwright"
sudo chown -R "${remote_user}:${remote_group}" "${shared_dir}/data" "${shared_dir}/cache"

sudo mv "${tmp_dir}/agent-foundry-backend.service" "/etc/systemd/system/${service_name}.service"
sudo mv "${tmp_dir}/agent-foundry-hermes-cron-sync.service" "/etc/systemd/system/${sync_service_name}.service"
sudo mv "${tmp_dir}/agent-foundry-hermes-cron-sync.path" "/etc/systemd/system/${sync_service_name}.path"

# Remove the obsolete per-minute npm job without touching unrelated cron entries.
cron_file="$(mktemp)"
if crontab -l > "${cron_file}" 2>/dev/null; then
  if grep -q '# agent-foundry-cron-data[[:space:]]*$' "${cron_file}"; then
    sed -i '/# agent-foundry-cron-data[[:space:]]*$/d' "${cron_file}"
    crontab "${cron_file}"
  fi
fi
rm -f "${cron_file}"

previous_release="$(readlink -f "${current_link}" 2>/dev/null || true)"
next_link="${current_link}.next"
sudo rm -f "${next_link}"
sudo ln -s "${release_dir}" "${next_link}"
sudo mv -Tf "${next_link}" "${current_link}"

sudo systemctl disable --now agent-foundry-cron-data.timer agent-foundry-cron-data.service 2>/dev/null || true
sudo rm -f /etc/systemd/system/agent-foundry-cron-data.timer /etc/systemd/system/agent-foundry-cron-data.service
sudo systemctl daemon-reload
sudo systemctl enable --now "${sync_service_name}.path"
sudo systemctl start "${sync_service_name}.service" || true
sudo systemctl enable "${service_name}"
if ! sudo systemctl restart "${service_name}"; then
  rollback 1
fi

for attempt in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:8080/health; then
    echo
    exit 0
  fi
  sleep 1
done

sudo systemctl --no-pager --full status "${service_name}" || true
sudo journalctl -u "${service_name}" -n 80 --no-pager || true
rollback 1
