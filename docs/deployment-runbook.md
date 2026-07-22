# Deployment Runbook

This document is the source of truth for agents changing or operating the
production deployment. The deployment model deliberately separates immutable
release artifacts from mutable production state.

## Scope and invariants

- Deploy from a local checkout with `deploy/deploy-backend.sh`; do not copy
  individual binaries or overwrite files under `current/` manually.
- Secrets and production configuration live only on the VPS in
  `shared/.env`. Never upload, render, or replace that file from a local
  `.env`, `.env.remote`, or `.env.example`.
- SQLite data, uploads, and the Hermes cron snapshot are persistent state in
  `shared/data/`, not release contents.
- uv and Playwright caches are disposable but shared between releases in
  `shared/cache/`.
- A release is activated only by atomically replacing the `current` symlink.
  On a failed service restart or health check, the remote installer restores
  the previous release when one exists.

The default remote root is `/home/rz/Agent-Foundry`:

```text
/home/rz/Agent-Foundry/
├── current -> releases/<release-id>
├── releases/
│   └── <release-id>/
│       ├── bin/                 # Rust backend and Hermes sync script
│       ├── python/.venv ->      # symlink to shared/python-envs/<env-id>
│       ├── web/dist/            # static frontend
│       ├── runtime.env          # paths into this release/shared state
│       └── REVISION             # Git revision, release ID, build timestamp
└── shared/
    ├── .env                     # VPS-only secrets and settings
    ├── data/                    # SQLite, uploads, Hermes cron snapshot
    ├── python-envs/             # immutable, content-addressed Python envs
    └── cache/                   # uv and Playwright caches
```

## Prerequisites

On the build machine:

- Rust, `uv`, Node/npm, `ssh`, and `scp` are available.
- The SSH host alias `cx33` works, or `SSH_HOST` is set.
- The checkout is at the intended revision. A dirty checkout is allowed, but
  the generated `REVISION` explicitly records `worktree_dirty=true`.

On the VPS:

- The deploy user can authenticate with `sudo` through an SSH TTY.
- `uv` is available at `/home/rz/.local/bin/uv`, unless `REMOTE_UV_BIN` is
  provided.
- Python 3.12 is discoverable through `uv python find 3.12`; its exact version
  participates in the shared environment identity.
- Chromium's Linux runtime libraries are installed. On Ubuntu 26.04,
  Playwright is automatically mapped to its Ubuntu 24.04 browser build until
  upstream publishes a native Ubuntu 26.04 build. Override the automatic
  choice with `REMOTE_PLAYWRIGHT_HOST_PLATFORM_OVERRIDE` when deploying from
  another machine.
- Before the first deployment, create the real server-side `.env` at either
  `<remote-root>/.env` (it will be migrated once) or
  `<remote-root>/shared/.env`. It must contain the application configuration
  and secrets required by the backend.

## Normal deployment

From the repository root, run:

```bash
./deploy/deploy-backend.sh
```

The script performs these steps:

1. Builds the Rust release binary, Python wheel/locked requirements, and Vite
   frontend bundle locally.
2. Creates a release ID from the current Git SHA and UTC timestamp, then
   uploads all artifacts plus rendered systemd units to a temporary VPS path.
3. On the VPS, creates a new `releases/<release-id>` directory and links it to
   an immutable Python environment keyed by effective requirements, wheel
   content, Python version, and CPU architecture. An existing matching
   environment is reused; otherwise it is built before activation. Playwright
   Chromium remains in the shared browser cache.
4. On the first migration only, moves legacy `<remote-root>/data` to
   `shared/data` after the new release has been fully prepared. It refuses to
   choose if both locations already contain data.
5. Installs the backend and Hermes sync systemd units, removes the obsolete
   `# agent-foundry-cron-data` crontab entry, atomically switches `current`,
   then restarts services.
6. Polls `http://127.0.0.1:8080/health` for up to 30 seconds. A failure
   restores the prior `current` symlink and restarts the prior backend.

Useful overrides are environment variables, for example:

```bash
SSH_HOST=my-vps REMOTE_ROOT=/srv/agent-foundry \
REMOTE_USER=deploy REMOTE_GROUP=deploy \
./deploy/deploy-backend.sh
```

`RELEASE_ID` can also be supplied, but it may contain only letters, numbers,
periods, underscores, and hyphens. Avoid reusing an existing release ID.

For a server that has a checkout and must build locally, use the corresponding
release-aware installer instead:

```bash
./deploy/install-hermes-cron-sync-local.sh
```

It follows the same release/shared layout but requires local `sudo`, Rust,
`uv`, and npm on that server.

## Verification and inspection

On the VPS, inspect the active release and service health with:

```bash
readlink -f /home/rz/Agent-Foundry/current
cat /home/rz/Agent-Foundry/current/REVISION
curl -fsS http://127.0.0.1:8080/health
sudo systemctl status agent-foundry-backend
sudo systemctl status agent-foundry-hermes-cron-sync.path
```

The backend unit runs from `shared/`, reads `shared/.env` and the active
release's `runtime.env`, and is permitted to write only under `shared/`.
`runtime.env` provides release-specific commands for PDF extraction, macro
analysis, structured-products enrichment, plus the shared cache paths.

## Manual rollback

Automatic rollback covers failed restart/health checks during a deployment.
For a later regression, pick a known-good release and switch back explicitly:

```bash
ssh cx33
sudo ln -sfn /home/rz/Agent-Foundry/releases/<known-good-release> \
  /home/rz/Agent-Foundry/current
sudo systemctl restart agent-foundry-backend
curl -fsS http://127.0.0.1:8080/health
```

Do not delete releases until the active release and a rollback candidate have
been identified. Release cleanup is intentionally manual; no deploy script
prunes historical releases. Python environment cleanup is also manual: never
delete a directory under `shared/python-envs/` while any retained release's
`python/.venv` symlink points to it.

## Loopback-only Caddy frontend

When no public domain is needed, Caddy serves the active frontend only on the
VPS loopback interface and proxies `/api/*` and `/data/*` to the backend.
Install or refresh that configuration from the local checkout:

```bash
./deploy/install-caddy-ssh-tunnel.sh
```

The script renders `deploy/Caddyfile.ssh-tunnel`, validates it with Caddy,
reloads the service, and verifies the loopback endpoint. It defaults to port
3000; select another unprivileged port when needed:

```bash
FRONTEND_PORT=3001 ./deploy/install-caddy-ssh-tunnel.sh
```

To browse it, keep a local SSH tunnel open:

```bash
ssh -N -L 3000:127.0.0.1:3000 cx33
```

Then open `http://127.0.0.1:3000`. Do not change the Caddy listener to a public
address unless public HTTP exposure has been explicitly approved.

## Agent checklist for deployment changes

Before modifying deployment code, verify that the change preserves all of the
following:

1. The activated release and its referenced content-addressed Python
   environment are immutable after activation.
2. No deployment command overwrites `shared/.env` or `shared/data`.
3. Systemd paths resolve through `current/` for release artifacts, through
   `shared/python-envs/` for immutable Python environments, and through the
   remaining `shared/` paths for mutable state.
4. A failed activation either leaves `current` untouched or restores the
   previous release.
5. `bash -n` passes for every changed deployment script; run a local frontend
   build if frontend packaging behavior changed.
6. Any new runtime path is added to `deploy/agent-foundry-runtime.env` and is
   compatible with `StructuredProductsService` cache environment variables.
