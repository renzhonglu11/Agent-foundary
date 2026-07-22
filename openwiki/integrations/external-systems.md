---
type: Integration Guide
title: External Systems and Runtime Integrations
description: Provider responsibilities, configuration names, caching, fallback behavior, and operational boundaries for Agent Foundry integrations.
tags: [integrations, market-data, macro, hermes, providers]
---

# External systems and runtime integrations

Integrations feed the [portfolio and risk domain](../domain/portfolio-and-risk.md) and are composed by the [Rust architecture](../architecture/overview.md). Configuration is environment-driven; use `.env.example` for names and never read, copy, or commit live `.env` values.

## Integration matrix

| System | Purpose | Implementation | Cache/fallback |
|---|---|---|---|
| Alpaca IEX | Latest US equity quotes | `backend/src/services/alpaca_market_data.rs` | RAM + SQLite; configurable TTL; frontend can request cache-only |
| Frankfurter | USD→EUR conversion | `application/services/fx_rate_service.rs` | SQLite TTL; falls back to `ALPACA_USD_EUR_RATE` |
| FRED | Seven fixed US macro series and derived CPI YoY | `backend/src/services/fred.rs` | normalized SQLite; retries/rate delay; short-lived mock fallback |
| ApeWisdom | Top Reddit stock trends | `backend/src/services/apewisdom.rs` | memory + `data/reddit-trends.json`; background polling |
| FinCal | XETRA trading-day check | `backend/src/services/market_calendar.rs` | hardcoded holiday fallback through 2030 |
| Onvista | Product metadata and Greeks | Python `structured_products/providers/onvista.py` | Python SQLite history/cache; first provider |
| GS Markets | Issuer metadata/Greeks fallback | Python GS provider | retried when cached Greeks are incomplete |
| Börse Frankfurt | Structured-product quote by ISIN | Python Frankfurt provider | cached quote history; positive prices may update portfolio valuation |
| finanzen.net | Implemented provider, not default | Python provider/tests | excluded because deployment receives Akamai 403 |
| Hermes executable | Macro commentary and WIP stress review | Python macro command; Rust stress handler | explicit unavailable responses; stress timeout 120 seconds |
| Hermes cron files | External job status | `services/hermes_cron_status.rs`, deploy sync units | event-driven copy into shared data |
| systemd | Backend/sync observability | `services/systemd_status.rs` | queried at request time |

## Configuration boundaries

Core configuration is parsed in `backend/src/config/mod.rs`:

- runtime: `APP_ENV`, `HOST`, `PORT`, `FRONTEND_ORIGIN`, `DATABASE_URL`, `LOG_FORMAT`, `RUST_LOG`;
- Python commands: `PDF_EXTRACT_COMMAND`, `MACRO_ANALYSIS_COMMAND`, `STRUCTURED_PRODUCTS_ENRICHMENT_COMMAND`, `STRUCTURED_PRODUCTS_ENRICHMENT_WORKDIR`;
- structured products: output/cache paths, live/export flags, auto-refresh interval and market hours under `STRUCTURED_PRODUCTS_*`;
- quotes/FX: `ALPACA_*`, `APCA_API_KEY_ID`, `APCA_API_SECRET_KEY`, `FX_RATES_ENABLED`, `FRANKFURTER_USD_LATEST_URL`, `FX_RATE_CACHE_TTL_SECONDS`;
- macro/calendar: `FRED_API_KEY`, `FRED_*` retry/TTL settings, `FINCAL_API_KEY`;
- operational files: `HERMES_CRON_JOBS_PATH` and sync-service source/target variables;
- WIP stress review: `HERMES_PATH`, `PORTFOLIO_STRESS_HERMES_MODEL`.

Production stores secrets only in VPS `shared/.env`; release-specific executable/cache paths come from `deploy/agent-foundry-runtime.env`. `.env.remote.example` is currently less complete than `.env.example` and should not be treated as an authoritative production template.

## Market and FX data flow

The stock-analysis endpoint batches symbols within `ALPACA_MAX_SYMBOLS_PER_REQUEST`, fetches IEX quotes when allowed, converts USD values to EUR, persists them, and can fall back through in-memory and SQLite caches. Positions monitoring deliberately requests cache-only data, while Stock Analysis can request live quotes.

USD derivative levels must be normalized before comparison with EUR spot. Commit `f01c873` fixed break-even normalization; `watchlistGrouping.js` now carries raw price/currency and USD/EUR rate. Preserve those provenance fields when changing quote contracts.

## Structured-product provider flow

Only Tier 1 groups call live providers. Python orchestration merges cached and live data, rate-limits requests, and persists history in its own SQLite database. Provider order is Onvista -> GS fallback for metadata/Greeks, plus Börse Frankfurt quote refresh. Unit tests use mocked transports and must not hit providers.

Provider HTML/GraphQL formats are unstable. A parser change should include representative fixture/response tests, absence/incomplete-data cases, and verification that stale cache fallback still works. Browser dependency changes must also be reflected in the [deployment process](../operations/testing-and-deployment.md).

## Macro and social data

FRED warms asynchronously at startup and refreshes on miss/expiry. Missing credentials or live failure produce a short-lived fallback payload rather than failing the app. ApeWisdom loads its persisted file, begins polling after startup, and supplies trends to macro analysis/UI.

Macro refresh is asynchronous from the caller's perspective. The cached JSON may remain old or unavailable while the detached task runs. The Python macro script protects existing analysis data when AI commentary is unavailable (commit `4c4cb95`).

## Hermes, cron, and systemd

Hermes has two roles:

- Python macro analysis may invoke it for commentary.
- The uncommitted Rust stress handler sends already-calculated candidate portfolios and validates the returned ranking.

These paths use separate command/model logic; do not assume one availability check covers both.

Hermes cron monitoring is file-based. A systemd `.path` unit watches the source jobs JSON and triggers an atomic copy into Agent Foundry's shared data. The backend then serves the copied snapshot. The UI's “latest” status is therefore the latest synchronized file, not a direct Hermes API call.

Systemd status is exposed for operational visibility. It is platform-specific and should degrade cleanly in local environments without the production units.

## Security and resilience notes

- No API authentication is evidenced. Do not expose Caddy/backend publicly without an explicit security design.
- Never log provider credentials or upload production `.env` files during deployment.
- Treat provider emptiness separately from provider failure; several UI hooks intentionally return empty arrays on non-2xx responses.
- FinCal's hardcoded fallback ends in 2030 and DST/hour calculations deserve review near boundary conditions.
- Planned Trading 212, Trade Republic, and yfinance integrations exist only in `docs/*plan.md`; do not describe them as runtime capabilities.
