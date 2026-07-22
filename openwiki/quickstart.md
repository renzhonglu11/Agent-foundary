---
type: Repository Guide
title: Agent Foundry Quickstart
description: Entry point for understanding, running, changing, and operating the Agent Foundry personal portfolio dashboard across its Rust, React, and Python runtimes.
tags: [agent-foundry, quickstart, portfolio, engineering]
---

# Agent Foundry quickstart

Agent Foundry is a private personal-investment dashboard. It imports broker transactions and statement PDFs, calculates portfolio and dividend views, enriches structured products, assesses derivative exposure and risk, fetches market and macro data, and exposes pipeline health in a React UI. The current implementation combines a Rust/Axum API, React/Vite frontend, Python sidecar, and SQLite persistence.

## Start here

- [Architecture overview](architecture/overview.md) explains runtime boundaries, startup, APIs, storage, and cache behavior.
- [Source map](architecture/source-map.md) maps common engineering tasks to source files.
- [Portfolio and risk domain](domain/portfolio-and-risk.md) is the canonical guide to transaction accounting, enrichment tiers, exposure, actions, P&L snapshots, and stress testing.
- [Engineer and user flows](workflows/engineer-and-user-flows.md) follows imports, refreshes, dashboard paths, and practical change recipes.
- [External systems](integrations/external-systems.md) covers market, macro, scraping, Hermes, cron, and systemd integrations and their fallback behavior.
- [Testing and deployment](operations/testing-and-deployment.md) gives checks, release topology, rollback steps, and operational hazards.

## Runtime shape

```text
Browser: React 19 + Vite + MUI
        │ /api/* and compatibility /data/*.json
        ▼
Rust: Axum + application/domain services + SQLx
        ├── SQLite: transactions, uploads, caches, enrichment/risk, P&L
        ├── remote APIs: Alpaca, Frankfurter, FRED, ApeWisdom, FinCal
        └── Python commands: PDF extraction, macro analysis, structured products
                    └── provider scraping + separate Python cache SQLite
```

The Rust backend is authoritative for CSV/PDF ingestion and the normalized portfolio summary. Python consumes that summary; it does not reparse portfolio source files in the production structured-products path (`backend/python/README.md`). See [architecture](architecture/overview.md) for the lifecycle and [domain rules](domain/portfolio-and-risk.md) before changing cross-runtime contracts.

## Local setup

Prerequisites are Rust 1.88, Node 20+, Python 3.12 for deployment parity, and `uv`. Although `backend/python/pyproject.toml` permits Python 3.11+, production explicitly selects 3.12.

1. Copy `.env.example` to `.env` and configure local paths. Never commit or inspect live secret files. `DATABASE_URL` defaults to `sqlite://data/agent_foundry.db`; Alpaca, FRED, and FinCal credentials are optional.
2. Install Python dependencies:

   ```bash
   cd backend/python
   uv sync --dev
   cd ../..
   ```

3. Install frontend dependencies and run the combined developer launcher:

   ```bash
   cd web
   npm ci
   npm run dev
   ```

   `web/scripts/dev-with-backend.sh` starts the Rust backend, waits for `/health`, then starts Vite. The UI defaults to `http://127.0.0.1:5173`; Vite proxies API/data requests to `127.0.0.1:8080` (`web/vite.config.js`).

For frontend-only worktrees, start the backend from the main checkout and invoke the worktree's Vite binary directly; `npm run dev` would start a second backend. The detailed procedure is in `docs/frontend-worktree-development.md`.

## Baseline checks

```bash
cargo fmt --all
cargo clippy --all-targets -- -D warnings
cargo test
npm --prefix web test
npm --prefix web run build
cd backend/python && uv run pytest
```

No application CI currently runs these checks; the only GitHub workflow updates OpenWiki. Treat local verification as the release gate and consult [testing guidance](operations/testing-and-deployment.md) for targeted checks.

## Current working-tree state

This wiki reflects the working tree at Git `HEAD` `1336c30`, including uncommitted changes. In particular, portfolio stress comparison spans untracked `backend/src/api/handlers/portfolio_stress.rs`, `web/src/components/PortfolioStressTestPanel.jsx`, `web/src/utils/portfolioStress.js`, and its test, plus modified router/components. Treat that endpoint and UI as work in progress until committed and verified together.

Recent evolution matters when navigating the design:

- Data serving moved from file/blob caches to normalized realtime SQLite tables (`36e4198`).
- Richer risk actions and normalized, deduplicated P&L snapshots followed (`388cb9b`).
- The frontend then coordinated refresh caches and added P&L import/monitoring (`6eadf15`).
- Deployment moved to immutable releases plus an atomic `current` symlink and loopback-only Caddy access (`6db61a2`).
- The latest committed UI work prioritizes watchlist actions and makes the positions action board responsive (`c231a2f`, `1336c30`).

## Important invariants

- Preserve the `/data/portfolio-summary.json` compatibility contract; the frontend blocks on it.
- A CSV import replaces all transactions rather than merging incrementally.
- Structured-product field names cross Python snake_case, normalized SQLite columns, and frontend camelCase; change all three deliberately.
- Production secrets and mutable data live only in the VPS `shared/` tree. Follow the [deployment runbook](operations/testing-and-deployment.md), not the legacy manual-copy section in `README.md`.
- A clean commit is the safest release input: current `REVISION` dirty detection misses untracked files, even though the build can package them.
- The application has no documented authentication layer. Caddy deliberately binds only to VPS loopback and is reached through SSH forwarding.

## Backlog

- **Macro-analysis decision rules** — `backend/python/src/agent_foundry_python/macro_analysis.py`, `web/src/components/EventsTab.jsx`: deferred because the initial wiki covers the integration and workflow, while the large presentation-level indicator logic deserves a focused later pass.
- **Planned watchlist providers** — `docs/stock-analysis-api-plan.md`, `docs/watchlist-tier-plan.md`: deferred because Trading 212, Trade Republic, and yfinance are design plans rather than evidenced runtime integrations.
- **Detailed schema catalog** — `backend/migrations/`: deferred in favor of the architecture-level storage map; add when schema-level troubleshooting or external data access becomes common.
