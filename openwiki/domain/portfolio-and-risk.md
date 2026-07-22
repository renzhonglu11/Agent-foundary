---
type: Domain Guide
title: Portfolio and Structured-Product Risk Domain
description: Canonical business rules for transaction import, portfolio accounting, structured-product enrichment and exposure, action labels, P&L snapshots, and portfolio stress comparison.
tags: [portfolio, structured-products, risk, accounting, stress-testing]
---

# Portfolio and structured-product risk domain

This page owns the principal business rules. They are calculated across Rust, Python, and frontend utilities, then surfaced through the [user workflows](../workflows/engineer-and-user-flows.md) and fueled by [external market data](../integrations/external-systems.md).

## Transaction import contract

`backend/src/application/services/transaction_importer.rs` requires these CSV columns: `transaction_id`, `date`, `type`, `category`, `asset_class`, `name`, `symbol`, `description`, `amount`, `fee`, `tax`, `shares`, `price`, and `currency`.

Important semantics:

- Import is a wholesale replacement of `transactions`, performed in one SQLite transaction; it is not an incremental merge.
- Missing transaction IDs become deterministic values based on date, type, symbol, and row number.
- Blank asset classes normalize to `CASH`; blank currencies become `EUR`.
- Blank numeric fields become zero. Malformed numeric strings also currently become zero, which is permissive and can hide bad input.
- The upload endpoint permits one CSV and one PDF per atomic request, validates every submitted file before updating data, sanitizes filenames, and enforces a 50 MiB request limit.
- PDF text augments names, issuers, quantities, and statement values; Python extracts text, but Rust remains the ingestion source of truth.

The upload archive and transaction replacement are not one cross-resource transaction. Files can be written before later database steps fail, so troubleshoot both `data/uploads` and upload tables.

## Portfolio accounting

`backend/src/application/services/portfolio_calculator.rs` derives the response in `backend/src/domain/portfolio.rs`.

- **BUY:** quantity increases by absolute shares. Cost is `max(-(amount + fee + tax), 0)` and is added to cost basis.
- **SELL/REDEMPTION:** average cost per share determines removed basis. Realized P&L is `(amount + fee + tax) - removed_cost`.
- **Dividend-like records:** `DIVIDEND`, `DISTRIBUTION`, `DIVIDEND_EQUIVALENT_PAYMENT`, and `INTEREST_PAYMENT` contribute net income as `amount + tax` and feed dividend summaries.
- **CASH:** positive amounts are deposits and negative amounts are withdrawals.
- Positions with near-zero quantity are removed. Open positions are sorted by market value.
- Market value defaults to `quantity × last_price`; positive Börse Frankfurt prices and statement-derived values may override transaction prices according to provenance rules.
- Unrealized P&L is market value minus cost basis; portfolio allocation is grouped by asset class. Monthly activity and only the 20 most recent transactions are returned.

`/data/portfolio-summary.json` serializes these structures in camelCase and is the frontend's boot contract. Changes should be treated as API migrations, not local refactors.

## Structured-product classification and tiers

Python adapts Rust `positions` into enrichment rows (`backend/python/src/agent_foundry_python/structured_products/agent_foundry.py`). Supported detection includes warrants/options (`Optionsschein`, Call, Put), knock-outs/turbos, and factor certificates.

Products are grouped by inferred underlying. At most 20 groups, ranked by aggregate derivative market value, become Tier 1; all products in those groups inherit Tier 1 and may call live providers. Remaining derivatives are Tier 2, while ETF/bond/non-derivative rows are Tier 3. This bounds provider load and directs the action-focused UI toward the most material derivative exposures.

Live enrichment tries Onvista metadata/Greeks first, then GS Markets fallback, and Börse Frankfurt for quotes. Existing cached data remains fallback evidence; the recent `1d9a3e4` change deliberately marks fresh-but-incomplete Greeks stale so providers retry before old values are reused.

## Exposure and risk actions

`backend/python/src/agent_foundry_python/structured_products/exposure.py` computes directional equivalent exposure in priority order:

1. delta × ratio × underlying price × quantity;
2. omega-based estimate;
3. leverage-based estimate;
4. signed market value fallback.

Put delta/omega are normalized negative, while leverage remains a positive magnitude combined with inferred direction. Every consumer should preserve exposure confidence; live delta and market-value fallback are not equivalent evidence.

`risk.py` evaluates only Tier 1 groups. Each leg records market value, Greeks/leverage, equivalent exposure and NAV weight, days to expiry, barrier distance, quote age, confidence, completeness score, risk status, primary action, and explanation. Heuristics combine:

- missing/stale data;
- expiry proximity;
- barrier proximity;
- leverage and leg exposure weight;
- group concentration.

Outputs include leg statuses `HARD_BLOCKED`, `WATCH`, or `OK`; actions such as `BUY`, `HOLD`, `SELL`, and `ROLL`; and group labels `ADD_ALLOWED`, `HOLD_MONITOR`, or `REDUCE_CONCENTRATION`. Threshold constants live at the top of `risk.py`; change them with `backend/python/tests/test_risk.py`, repository persistence expectations, and UI filtering together.

The React normalization layer (`web/src/utils/watchlistGrouping.js`) joins portfolio positions, enrichment by ISIN, risk legs/groups, aliases, and Alpaca quotes. It also converts comparable USD levels to EUR and repeats a confidence-aware exposure fallback. This duplicated cross-runtime logic is a major drift risk.

## Monitoring and P&L snapshots

The positions action board converts group and leg risk into SELL/ROLL/HOLD/BUY queues. Product simulations use `web/src/utils/productCalculations.js`:

- movement prefers Delta, then Omega, then intrinsic/leverage approximations;
- option time decay prefers Theta, then linear amortization, then a coarse fallback;
- projected product prices are floored at zero.

Generated records stay in `App.jsx` memory until saved. The backend persists a P&L snapshot and normalized records. It sorts records, computes a fingerprint, and makes create idempotent for duplicate content; list returns the newest 50. The fingerprint uses Rust `DefaultHasher`, so it is an internal deduplication mechanism rather than a portable content identifier.

## Portfolio stress comparison (work in progress)

Uncommitted `web/src/utils/portfolioStress.js` compares current Tier 1 exposure with defensive, balanced, and elastic candidate subsets over 7, 30, or 90 days and fixed underlying shocks of -10%, -5%, 0%, +5%, and +10%.

Calculation behavior:

- factor certificates use signed leverage;
- turbo/knock-out products become zero if the scenario endpoint crosses the barrier;
- warrants expiring within the horizon use expiry intrinsic value;
- other products use movement plus decay estimates;
- candidates exclude `HARD_BLOCKED`, imminent-roll, untrusted-data, and ordinary SELL products;
- near-barrier WATCH products are elastic-only;
- products above 8% exposure weight are scaled down;
- deterministic scores and an initial one-per-underlying pass build diversified candidate subsets.

The current portfolio baseline still includes excluded positions. Outputs distinguish candidate allocation, percentage of total market value, and percentage of total cost basis.

This is a deterministic endpoint stress comparison—not a probability distribution, expected return, path-dependent barrier simulation, issuer-credit model, liquidity model, or spread model. Barrier checks use only the terminal level. Products lacking positive price, quantity, or spot are omitted. IDs may collide when duplicate holdings share a symbol.

The WIP backend handler validates bounded candidate payloads, invokes Hermes with a 120-second timeout, validates returned portfolio IDs/JSON, and allows Hermes to rank existing candidates only. It must not invent allocations or recalculate scenarios. Frontend and backend stress changes must be committed and deployed together.
