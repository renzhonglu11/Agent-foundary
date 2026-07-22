---
type: Source Map
title: Agent Foundry Source Map
description: Task-oriented map from Agent Foundry engineering concerns to authoritative source files, tests, and change boundaries.
tags: [source-map, navigation, engineering]
---

# Source map

Use this page to minimize repository exploration. It locates implementations for the [architecture](overview.md), business rules in the [portfolio and risk domain](../domain/portfolio-and-risk.md), and checks in [testing and deployment](../operations/testing-and-deployment.md).

## Repository roots

| Path | Role |
|---|---|
| `Cargo.toml`, `rust-toolchain.toml` | Rust workspace, edition/MSRV, strict lint policy |
| `backend/` | Axum application and Python sidecar |
| `web/` | React/Vite application and pure JS domain utilities |
| `docs/` | Deployment source of truth, frontend worktree guide, and future stock-analysis plans |
| `deploy/` | systemd, Caddy, release build/install, Hermes cron synchronization |
| `data/` | local mutable runtime data; do not treat as source or commit secrets |
| `.github/workflows/openwiki-update.yml` | scheduled wiki update; no application CI |

## Rust backend

| Concern | Start here | Related files |
|---|---|---|
| Process startup/composition | `backend/src/main.rs`, `backend/src/lib.rs` | `app_state.rs`, `telemetry.rs`, `config/mod.rs` |
| Routes/contracts | `backend/src/api/router.rs` | `api/handlers/*.rs`, `api/error.rs` |
| Portfolio summary | `application/services/portfolio_service.rs` | `portfolio_calculator.rs`, `domain/portfolio.rs` |
| CSV parsing/import | `application/services/transaction_importer.rs` | `domain/transaction.rs`, `sqlite_transaction_repository.rs` |
| Upload workflow | `application/services/upload_data_service.rs` | `api/handlers/upload.rs`, upload archive repository/migration |
| Persistence abstractions | `application/ports/*.rs` | `infrastructure/db/sqlite_*.rs` |
| Structured products orchestration | `services/structured_products_service.rs` | structured handlers, market repository, calendar |
| Quotes/FX | `services/alpaca_market_data.rs` | `application/services/fx_rate_service.rs`, FX/market repositories |
| FRED/macro | `services/fred.rs`, `api/handlers/macro_analysis.rs` | FRED repository, Python macro script |
| P&L snapshots | `services/pnl_snapshots.rs` | `api/handlers/pnl_snapshots.rs`, three P&L migrations |
| Operational status | `services/hermes_cron_status.rs`, `services/systemd_status.rs` | matching handlers |
| Stress review WIP | `api/handlers/portfolio_stress.rs` | router/export changes, frontend stress files |
| Schema | `backend/migrations/*.sql` | `infrastructure/db/migrations.rs` |

When adding an API, register it in `api/handlers/mod.rs` and `api/router.rs`, add state only if a reusable service is needed, and then update frontend consumers. Preserve generic error exposure and explicit logging patterns.

## Python sidecar

| Concern | Start here | Tests |
|---|---|---|
| Console commands/package | `backend/python/pyproject.toml`, `backend/python/README.md` | package-wide pytest configuration |
| PDF extraction | `src/agent_foundry_python/pdf_extract.py` | upload behavior is mainly Rust-tested indirectly |
| Structured CLI/orchestration | `structured_products/cli.py`, `agent_foundry.py` | `tests/test_agent_foundry_adapter.py`, enrichment tests |
| Provider fetching/parsing | `structured_products/providers/` | provider-specific tests using `httpx.MockTransport` |
| Enrichment/cache freshness | `structured_products/enrichment.py`, `storage.py` | `test_enrichment.py`, `test_storage.py` |
| Exposure/risk actions | `structured_products/exposure.py`, `risk.py` | `test_exposure.py`, `test_risk.py` |
| Python cache schema | `backend/python/migrations/` | migration/storage tests |
| Macro analysis | `src/agent_foundry_python/macro_analysis.py` | limited dedicated coverage |

Provider parsers are brittle by nature. Preserve fixture-driven tests, cache fallback semantics, rate limiting, and the rule that Rust-normalized positions are the input source.

## React frontend

| Concern | Start here | Tests/related code |
|---|---|---|
| App bootstrap/navigation | `web/src/main.jsx`, `web/src/App.jsx` | `DashboardShell.jsx`, `SidebarNav.jsx` |
| Portfolio overview/positions | `PortfolioTabs.jsx`, `PositionsTable.jsx` | summary contract from Rust |
| Action monitoring | `PositionsActionBoard.jsx`, `ProductMonitoringDashboard.jsx` | `utils/productCalculations.test.js` |
| Import/P&L snapshots | `DataImportSpeedDial.jsx` | backend upload/P&L routes |
| Stock analysis | `StockAnalysisTab.jsx`, `components/stock-analysis/` | `stockAnalysisUi.test.js` |
| Data normalization/grouping | `utils/watchlistGrouping.js` | `watchlistGrouping.test.js` |
| Structured data/cache sync | `hooks/useStructuredProducts*.js`, `useRiskData.js` | `hooks/queryKeys.js` |
| Alpaca quotes | `hooks/useAlpacaQuotes.js` | grouping tests cover quote selection/FX |
| Macro/events | `EventsTab.jsx`, macro/FRED hooks | large component; change cautiously |
| Operational UI | `HermesCronTab.jsx` | three separate polling paths |
| Stress comparison WIP | `PortfolioStressTestPanel.jsx`, `utils/portfolioStress.js` | `portfolioStress.test.js`, backend stress handler |
| Dev proxy/commands | `web/vite.config.js`, `web/scripts/dev-with-backend.sh` | `web/package.json` |

Frontend shared contracts are untyped JavaScript. Prefer pure utility changes with Node tests before modifying presentation. Verify compact DataGrid changes visually in addition to running `npm test` and `npm run build`.

## Operations and documentation

- `docs/deployment-runbook.md` is authoritative for production. The manual-copy section in `README.md` is legacy and conflicts with release invariants.
- `deploy/deploy-backend.sh` builds/uploads a release; `deploy/install-release-remote.sh` prepares, activates, health-checks, and rolls back.
- `deploy/agent-foundry-backend.service` and `agent-foundry-runtime.env` define runtime paths and write boundaries.
- `deploy/Caddyfile.ssh-tunnel` and `install-caddy-ssh-tunnel.sh` keep the UI loopback-only.
- `deploy/agent-foundry-hermes-cron-sync.{path,service}` and `sync-hermes-cron-jobs.sh` copy Hermes status into shared data.

## Change-oriented entrypoints

- **Portfolio arithmetic:** calculator + domain serialization + calculator tests; then inspect every dashboard consumer.
- **Structured-product field:** Python model/provider/enrichment -> Python risk -> Rust migration/repository reconstruction -> frontend grouping/action UI -> tests in both languages.
- **Refresh timing:** Rust structured service + market calendar -> status hook and Hermes Cron tab -> deployment env examples.
- **New external provider:** Python provider interface/tests -> enrichment fallback order -> [integration behavior](../integrations/external-systems.md) -> deploy browser/runtime dependencies.
- **Deployment path:** runbook -> all install/build scripts -> systemd/runtime env/Caddy; run `bash -n` and relevant builds.
