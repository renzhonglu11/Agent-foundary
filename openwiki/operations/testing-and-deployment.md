---
type: Operations Guide
title: Testing, Deployment, and Runbook Notes
description: Local quality gates, test coverage, immutable release deployment, verification, rollback, and operational hazards for Agent Foundry.
tags: [operations, testing, deployment, runbook, systemd]
---

# Testing, deployment, and runbook notes

This page applies the runtime invariants from the [architecture overview](../architecture/overview.md) and the provider/runtime dependencies from [external systems](../integrations/external-systems.md). `docs/deployment-runbook.md` is the detailed production source of truth.

## Quality gates

### Rust

```bash
cargo fmt --all
cargo clippy --all-targets -- -D warnings
cargo test
cargo build --release
```

The workspace uses Rust 2024/MSRV 1.88, forbids unsafe code, and denies Clippy `unwrap_used` and `expect_used`. Tests concentrate on portfolio parsing/calculation, repositories, Alpaca helpers, calendar logic, FRED/ApeWisdom compatibility, P&L, and the WIP stress handler. Upload/subprocess/router/scheduler integration coverage is comparatively thin.

### Python

```bash
cd backend/python
uv sync --dev
uv run pytest
uv run python -m compileall -q src scripts tests
```

Provider, cache freshness/fallback, tiering, exposure, risk, storage, and migrations have mocked tests. Do not turn these into live-provider tests. Add a numbered yoyo migration for Python-cache schema changes.

### Frontend

```bash
npm --prefix web test
npm --prefix web run build
```

Node tests cover product calculations, watchlist grouping/FX/exposure fallbacks, stock-analysis UI helpers, and WIP stress logic. There are no component, accessibility, hook, API-mocking, or end-to-end tests. Visually verify responsive panels, compact DataGrid rows, loading/error/empty states, and polling after relevant changes.

### Deployment scripts

Run `bash -n` on every changed shell script. If packaging changes, also run Rust release build, Python tests/packaging, frontend build, and a Playwright Chromium launch smoke test. The deploy script builds artifacts but does not run all application tests automatically.

No application CI exists; `.github/workflows/openwiki-update.yml` only regenerates documentation. It installs an unpinned global OpenWiki package, so pinning that dependency is a future supply-chain hardening task.

## Production topology

```text
/home/rz/Agent-Foundry/
├── current -> releases/<release-id>
├── releases/<release-id>/
│   ├── bin/
│   ├── python/.venv -> shared/python-envs/<env-id>
│   ├── web/dist/
│   ├── runtime.env
│   └── REVISION
└── shared/
    ├── .env
    ├── data/
    ├── python-envs/
    └── cache/
```

Releases are immutable after activation. Secrets, SQLite, uploads, Hermes snapshots, and reusable caches are shared mutable state. The backend systemd unit starts through `current`, works from `shared`, loads `shared/.env` plus release `runtime.env`, and may write only under shared paths.

Caddy serves `current/web/dist`, proxies `/api/*` and `/data/*` to backend port 8080, and listens only on VPS `127.0.0.1:3000`. Users connect with `ssh -N -L 3000:127.0.0.1:3000 cx33`. This loopback boundary compensates for the application's lack of authentication.

## Normal release

Run from the intended local checkout:

```bash
./deploy/deploy-backend.sh
```

The script builds Rust, a Python wheel/locked requirements, and Vite assets; records commit/time/dirty state; uploads to a temporary remote path; creates an immutable release and content-addressed Python environment; installs units; atomically switches `current`; restarts services; and polls `/health` for up to 30 seconds. A failed activation restores the prior symlink/backend when possible.

Dirty deployments are allowed and marked in `REVISION`, but cannot be reconstructed from Git. The current marker checks tracked staged/unstaged diffs only (`git diff` and `git diff --cached`), so untracked source files can enter a build while `worktree_dirty=false` is recorded. Prefer a clean committed tree, especially while the stress feature and deployment scripts are uncommitted.

Do not use the legacy manual binary-copy instructions in `README.md`. Do not overwrite `current`, `shared/.env`, or `shared/data` manually.

## Verification

On the VPS:

```bash
readlink -f /home/rz/Agent-Foundry/current
cat /home/rz/Agent-Foundry/current/REVISION
curl -fsS http://127.0.0.1:8080/health
sudo systemctl status agent-foundry-backend
sudo systemctl status agent-foundry-hermes-cron-sync.path
sudo journalctl -u agent-foundry-backend -n 200 --no-pager
```

The deployment health gate proves only that the backend health endpoint responds. It does not verify Caddy, frontend assets, migrations/queries, Python commands, providers, scheduled enrichment, or Hermes sync. After high-impact changes, also load the SSH-tunneled UI, call affected endpoints, inspect refresh status, and exercise the changed workflow.

## Rollback

Automatic rollback handles activation-time restart/health failure. For a later regression:

```bash
ssh cx33
sudo ln -sfn /home/rz/Agent-Foundry/releases/<known-good-release> \
  /home/rz/Agent-Foundry/current
sudo systemctl restart agent-foundry-backend
curl -fsS http://127.0.0.1:8080/health
```

Retain the active release and at least one known-good rollback target. Cleanup is manual. Before deleting a shared Python environment, verify no retained release symlink points to it.

## Operational diagnostics

| Symptom | Check |
|---|---|
| UI cannot load at all | backend `/health`; `/data/portfolio-summary.json`; Caddy; frontend bundle; stale `generate:data` error text is misleading |
| Portfolio stale after import | upload response/archive, transaction count, summary cache refresh, page reload |
| Empty structured products | enrichment status/error, normalized run/item tables, Python command/workdir/cache, provider fallback |
| Quotes stale | Alpaca credentials/enable flag, endpoint `cacheOnly`, TTL, FX cache/fallback, query invalidation |
| Macro unavailable | FRED cache/key, ApeWisdom file/poller, macro command, cached JSON timestamp |
| Cron status stale | Hermes source file, `.path` unit, sync service logs, copied shared-data target |
| Stress review unavailable | WIP files deployed together, `HERMES_PATH`, executable permission, model config, timeout/JSON validation |

## Known hazards

- `install-hermes-cron-sync-local.sh` does not mirror every rollback behavior of the remote installer.
- `REVISION` dirty-state detection omits untracked files even though untracked source can be packaged.
- Release/Python/browser caches can grow without automated pruning.
- Upload archive files and database updates are not one transaction.
- Relative subprocess paths are sensitive to working directory outside the production runtime env.
- Provider failures may appear as empty frontend data because some hooks intentionally degrade silently.
- The market-calendar fallback ends in 2030.
- The stress feature is uncommitted and requires synchronized backend/frontend deployment.

For task-specific test targets, follow the [source map](../architecture/source-map.md); for the end-user sequence being protected, use the [workflow guide](../workflows/engineer-and-user-flows.md).
