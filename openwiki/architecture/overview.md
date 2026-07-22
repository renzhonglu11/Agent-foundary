---
type: Architecture Guide
title: Agent Foundry Architecture Overview
description: Runtime topology, startup lifecycle, API boundaries, persistence strategy, frontend state model, and architectural change history for Agent Foundry.
tags: [architecture, rust, react, python, sqlite]
---

# Architecture overview

Agent Foundry is a three-runtime application with Rust as the orchestration and persistence center. The [portfolio and risk domain](../domain/portfolio-and-risk.md) flows through Axum APIs into React, while provider-specific extraction and enrichment are delegated to Python and the [external systems](../integrations/external-systems.md).

## Runtime boundaries

| Runtime | Responsibility | Primary entrypoints |
|---|---|---|
| Rust/Axum | HTTP, configuration, portfolio calculation, repositories, caches, subprocess orchestration, schedulers | `backend/src/main.rs`, `backend/src/lib.rs`, `backend/src/api/router.rs` |
| React/Vite | Dashboard navigation, monitoring/action UI, client-side grouping and simulations | `web/src/main.jsx`, `web/src/App.jsx` |
| Python | PDF extraction, macro JSON generation, structured-product provider enrichment/exposure/risk | `backend/python/src/agent_foundry_python/`, console scripts in `backend/python/pyproject.toml` |
| SQLite | Durable transactions, upload metadata, FX/market/FRED caches, normalized enrichment/risk, P&L snapshots | `backend/migrations/`, `backend/src/infrastructure/db/` |

The backend broadly follows ports and adapters: `domain/` contains serialized/value types, `application/ports/` defines repository traits, `application/services/` owns portfolio/import orchestration, and `infrastructure/db/` implements those ports. `services/` is a pragmatic integration layer for remote systems and long-running refresh behavior. Use the [source map](source-map.md) to locate concrete implementations.

```text
                                      ┌─────────────────────────────┐
                                      │ External data and commands  │
                                      │ Alpaca · FRED · Frankfurter │
                                      │ ApeWisdom · FinCal · Hermes │
                                      │ product-provider websites   │
                                      └──────────────┬──────────────┘
                                                     │ HTTP / subprocess
┌─────────────────────────┐   /api/*, /data/*   ┌───▼──────────────────────────┐
│ React/Vite browser      │◄───────────────────►│ Axum router + handlers       │
│ tabs, query caches,     │                     │ AppState service composition │
│ grouping, simulations  │                     └───┬───────────────┬──────────┘
└─────────────────────────┘                         │               │
                                        ports/services             │ Python CLI
                                                   │               ▼
                                         ┌─────────▼───────┐  ┌──────────────────────┐
                                         │ Main SQLite     │  │ Python sidecar       │
                                         │ domain records, │  │ PDF, macro, product  │
                                         │ caches, runs    │  │ enrichment and risk  │
                                         └─────────────────┘  └──────────┬───────────┘
                                                                         │
                                                              ┌──────────▼───────────┐
                                                              │ Python cache SQLite  │
                                                              │ + optional exports   │
                                                              └──────────────────────┘
```

Rust is the authority for ingestion, normalized portfolio state, API serving, and durable application records. Python is a subprocess boundary for extraction and specialist analysis; the browser additionally owns presentation-oriented grouping and the current deterministic stress model. This split explains why structured-product contract changes often require coordinated Rust, Python, and JavaScript edits.

## Startup lifecycle

`App::build` in `backend/src/lib.rs` performs startup in this order:

1. Connect to SQLite and run SQLx migrations.
2. Construct transaction, upload, market-data, and cache repositories.
3. Build `PortfolioService`, calculate the portfolio summary synchronously, and warm its in-memory cache.
4. Build `StructuredProductsService`; if persisted enrichment or risk is missing, spawn a fallback-only refresh.
5. Build Alpaca/FX, Hermes cron, systemd, P&L, ApeWisdom, and FRED services.
6. Load the ApeWisdom file cache and start its polling task.
7. Start the structured-products market-hours scheduler and asynchronous FRED warmup.
8. Assemble shared `AppState`, build the router/CORS layer, bind the configured address, and install graceful SIGTERM/Ctrl-C shutdown.

This order means a database or initial portfolio-calculation failure prevents serving, while enrichment, ApeWisdom, and FRED warmups degrade asynchronously.

## HTTP surface

Routes are centralized in `backend/src/api/router.rs`:

| Area | Routes |
|---|---|
| Health/portfolio/import | `GET /health`; `GET /api/portfolio/summary`; compatibility `GET /data/portfolio-summary.json`; `POST /api/upload-data` (50 MiB limit) |
| Structured products | enrichment GET/refresh/status; risk GET under `/api/structured-products-*` |
| Market/macro | Alpaca quote GET; FRED macro GET; macro-analysis cached GET and refresh POST |
| Monitoring | Hermes cron compatibility JSON; systemd unit GET |
| P&L | list/create `/api/pnl-snapshots`; delete `/api/pnl-snapshots/{id}` |
| Stress WIP | GET/POST `/api/portfolio-stress/hermes-review` |

CORS allows one configured `FRONTEND_ORIGIN` and GET/POST/DELETE. There is no authentication middleware in the router. Production access therefore depends on the loopback-only topology described in [operations](../operations/testing-and-deployment.md).

Handlers are intentionally thin where possible and use services in `AppState`. Internal failures are logged and generally exposed as generic HTTP errors (`backend/src/api/error.rs`).

## Persistence and cache layers

The main SQLite database defaults to `data/agent_foundry.db`; startup creates it and applies `backend/migrations/*.sql`. Major persisted areas are:

- transactions;
- FX rates;
- upload batches/files and extracted PDF text;
- Alpaca quotes and generic realtime payload metadata;
- FRED cache and normalized time series;
- normalized structured-product enrichment runs/items and risk groups/legs/actions;
- normalized P&L snapshots and records with a deduplication fingerprint.

`SqliteMarketDataRepository` reconstructs enrichment and risk response JSON from normalized tables (`backend/src/infrastructure/db/sqlite_market_data_repository.rs`). This is a deliberate evolution from file/blob-backed serving in commit `36e4198`. Export JSON/CSV files remain optional compatibility/debug artifacts, not the primary API read path.

Python also owns a separate yoyo-migrated structured-products cache (`backend/python/migrations/`) for positions, metadata, quotes, and Greek history. Do not confuse it with the main Rust database.

Runtime caches are layered:

- portfolio summary: in memory, refreshed after import and when structured-product persistence changes;
- Alpaca: RAM plus SQLite, with configurable TTL and cache-only requests;
- FX: Frankfurter-backed SQLite TTL with configured fallback rate;
- FRED: normalized SQLite with live/fallback TTLs;
- structured products: normalized main SQLite, plus Python history/cache and optional exports;
- ApeWisdom: memory plus `data/reddit-trends.json`.

## Frontend composition and state

`web/src/main.jsx` installs MUI and one TanStack Query client. `App.jsx` blocks initial rendering on `/data/portfolio-summary.json`, then selects six tabs through local state: overview, positions, dividends, stock analysis, events, and Hermes Cron. There is no URL router, so tab/filter state is not deep-linkable or persisted.

TanStack Query manages structured products, risk, refresh status, and Alpaca quotes. Portfolio, macro, FRED, and some operational loaders retain custom `useEffect` state. `useStructuredProductsDataSync` polls status every 3 seconds while active and 30 seconds otherwise; a changed `lastFinishedAt` invalidates enrichment, risk, and Alpaca queries. This hybrid model is important when changing refresh behavior in the [engineer and user flows](../workflows/engineer-and-user-flows.md).

## Cross-runtime contracts and hazards

- Rust portfolio structs serialize camelCase (`backend/src/domain/portfolio.rs`). Python accepts Rust summary fields, emits enrichment largely in snake_case, Rust normalizes/persists them, and frontend utilities adapt them again. Add contract tests when changing shared fields.
- Several Python commands and data paths are working-directory-sensitive. Production supplies release-aware paths through `deploy/agent-foundry-runtime.env`.
- Upload validation is all-or-nothing from the user's perspective, but archive filesystem writes, transaction replacement, and archive database records do not share one transaction.
- Refresh scheduling and subprocesses are background behavior with limited integration coverage.
- The current stress route is uncommitted and should not be considered stable API surface.

The release topology [operates and protects](../operations/testing-and-deployment.md) these runtime assumptions, while [external systems](../integrations/external-systems.md) documents provider degradation paths.
