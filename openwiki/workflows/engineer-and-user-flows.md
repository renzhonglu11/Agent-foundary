---
type: Workflow Guide
title: Engineer and User Flows
description: End-to-end dashboard, import, enrichment, monitoring, macro, stress-review, and engineering change workflows in Agent Foundry.
tags: [workflows, frontend, api, development]
---

# Engineer and user flows

The UI translates the [portfolio and risk rules](../domain/portfolio-and-risk.md) into six top-level views. These flows call the API and cache layers described in the [architecture overview](../architecture/overview.md).

## Application entry and navigation

`web/src/App.jsx` loads `/data/portfolio-summary.json` before rendering `DashboardShell`. A failure blocks the whole app; its current message incorrectly suggests the removed `npm run generate:data` workflow. Navigation uses component state rather than URLs, so reloads always return to overview.

Views are:

- **Overview:** summary cards, allocation/monthly charts, positions, recent transactions.
- **Positions:** holdings plus the Tier 1 action board and product simulation.
- **Dividends:** aggregate, monthly/cumulative, top-source, searchable and exportable records.
- **Stock Analysis:** underlying-group watchlist with quotes, enrichment/risk status, filters, and details.
- **Events:** FRED series, cached macro commentary, and ApeWisdom trends.
- **Hermes Cron:** cron snapshot, systemd units, and structured-product scheduler/refresh health.

## Import and portfolio recomputation

```text
DataImportSpeedDial
  -> multipart POST /api/upload-data
  -> validate one CSV + one PDF
  -> Python PDF extraction when present
  -> archive files/text
  -> replace transactions when CSV present
  -> recalculate and cache portfolio
  -> record archive metadata
  -> spawn fallback-only structured refresh
  -> frontend reloads the page
```

Validation rejects the whole request if any file fails. Upload completion currently calls `window.location.reload()` instead of query invalidation. When changing this flow, verify transaction replacement, PDF-only behavior, archives, summary cache freshness, and structured-product refresh—not merely the HTTP response.

## Structured-product refresh and synchronization

Startup and successful uploads request **fallback-only** enrichment; manual and scheduled refreshes use **live** providers. `StructuredProductsService` serializes refreshes with a nonblocking lock, so a concurrent request is logged and treated as already in progress.

The market-hours loop starts after 10 seconds. On XETRA trading days it refreshes at the configured interval between 08:00 and 22:00 Berlin time, takes one post-close snapshot, and checks off-hours every 30 minutes. FinCal is preferred and a hardcoded holiday calendar is fallback.

The frontend status hook polls every 3 seconds while a refresh runs and every 30 seconds otherwise. A changed completion timestamp invalidates enrichment, risk, and Alpaca query keys. `HermesCronTab` also polls status separately; avoid introducing a third cache model.

## Monitoring and action workflow

`PositionsActionBoard.jsx` joins portfolio positions, structured enrichment/risk, and cache-only Alpaca quotes. It prioritizes SELL, ROLL, HOLD, and BUY actions, opens a responsive detail panel, and passes simulation records up to `App.jsx`.

`ProductMonitoringDashboard.jsx` calculates expiry, drawdown, and decay scenarios. Records are ephemeral until `DataImportSpeedDial.jsx` sends a P&L snapshot. Listing/deleting snapshots is manual local state rather than shared TanStack Query state.

`StockAnalysisTab.jsx` uses the same underlying grouping layer but asks for live quotes, supports search and action/expiry/data-risk filters, and can trigger enrichment. A structured refresh can therefore update both positions and stock-analysis views through shared query invalidation.

## Macro and operational workflow

The Events view requests normalized FRED data and `/data/macro-analysis.json`. Macro refresh returns quickly, then a detached backend task refreshes ApeWisdom and invokes the Python/Hermes analysis command. UI loaders often degrade errors to empty or unavailable data, so distinguish a valid empty result from an outage during troubleshooting.

The Hermes Cron view combines three independent sources: copied Hermes job JSON, `systemctl` status, and structured-products refresh status. The [integration guide](../integrations/external-systems.md) explains their provenance; the [operations guide](../operations/testing-and-deployment.md) gives service-level checks.

## Stress comparison WIP

The uncommitted positions flow opens `PortfolioStressTestPanel.jsx`, builds client-side current/defensive/balanced/elastic portfolios, and optionally POSTs those bounded results to `/api/portfolio-stress/hermes-review`. Hermes reviews and ranks the supplied candidates; it does not generate them. The feature should degrade to local deterministic comparison when Hermes is unavailable.

Because this workflow crosses new uncommitted frontend and backend files, verify both sides together: utility tests, backend handler tests, frontend build, request validation, unavailable state, timeout/error states, and a real UI interaction.

## Engineer change recipes

### Change portfolio summary fields

1. Update `backend/src/domain/portfolio.rs` and calculator/service producers.
2. Search frontend components and utilities for the camelCase field.
3. Preserve `/data/portfolio-summary.json` compatibility or migrate all consumers atomically.
4. Add Rust calculation tests and frontend utility tests where derived behavior changes.

### Change structured-product/risk fields

1. Update Python models, provider merge logic, exposure/risk output, and Python tests.
2. Add/adjust main SQLite migrations and `SqliteMarketDataRepository` persistence/reconstruction.
3. Update frontend grouping, hooks, action UI, stress calculations, and Node tests.
4. Exercise fallback-only and live refresh status behavior.

### Add a dashboard data source

1. Decide whether it belongs behind an application port or pragmatic external service.
2. Add configuration using non-secret sample names only.
3. Compose the service in `backend/src/lib.rs`/`AppState` and add a thin handler/router entry.
4. Add one frontend ownership model—prefer the existing TanStack Query cache for polled server data.
5. Document fallback, TTL, operational status, and deployment dependencies in [external systems](../integrations/external-systems.md).

### Frontend-only worktree

Follow `docs/frontend-worktree-development.md`: run the main checkout backend, install dependencies inside the worktree, and start Vite directly. Do not copy `.env` or run `npm run dev` in the worktree because it launches another backend.
