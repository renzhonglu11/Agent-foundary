# Stock Analysis API Allocation Plan

Date: 2026-05-16

This plan covers how the Stock Picks / 选股分析 feature should use yfinance, Trading 212, Alpaca, and local PDF-derived portfolio data.

## Goal

Build one backend aggregation layer that returns a normalized stock-analysis payload to the frontend. The frontend should not call any provider directly. It should display the final merged result, the selected source for each field, and whether any value came from stale/local fallback data.

If yfinance, Trading 212, and Alpaca cannot identify or price a financial product, fall back to the local PDF-derived data already parsed by the backend.

## Provider Roles

### Trading 212

Use Trading 212 as the broker/account source of truth.

- Best for: current portfolio holdings, actual position quantity, average price paid, current position price where available, wallet impact, account currency, Trading 212 instrument ticker, ISIN, instrument name, instrument type, and tradability inside Trading 212.
- Use first for assets that are already held in the Trading 212 account or appear in Trading 212 instrument metadata.
- Do not use it as the main research or fundamental-analysis source.
- Cache instrument metadata aggressively because the official metadata endpoint is rate-limited and refreshed periodically.

Important constraints:

- Trading 212 Public API is beta.
- It is enabled for Invest and Stocks ISA account types.
- Metadata endpoints expose instruments, exchanges, tickers, ISINs, names, types, and currencies.

### Alpaca

Use Alpaca as the market-data and tradability source for US-listed assets, crypto, and later options-related signals.

- Best for: US equity symbol validation, asset status, exchange, tradable flag, fractional/extended-hours attributes, recent bars/quotes/trades, US market calendar, and future options availability.
- Use it before yfinance when the normalized candidate is clearly a US ticker or maps to an Alpaca asset.
- Do not assume Alpaca covers European listings or all Trading 212 instruments.
- Treat Alpaca data as strong for tradability and current market state, but not as the only source for analyst/fundamental enrichment.

### yfinance

Use yfinance as the broad research/enrichment source.

- Best for: historical prices, basic quote metadata, financial statements, analyst price targets, earnings/calendar fields, sector/industry, market cap, and broad ticker lookup.
- Use it after Trading 212/Alpaca for enrichment, or as the first research source for non-held watchlist candidates.
- Do not treat yfinance as authoritative for account holdings or broker tradability.
- Mark yfinance-derived fields as research/personal-use enrichment, not broker-confirmed data.

Important constraint:

- yfinance is an open-source library using Yahoo Finance data. It is not affiliated with Yahoo and is intended for research/personal use, so failures and field gaps must be expected.

### Local PDF Data

Use PDF-derived data as the final fallback and local audit trail.

- Best for: products present in the uploaded portfolio PDF but missing from all external APIs, especially unusual instruments, non-US listings, renamed products, broker-specific labels, and products with only ISIN/name data.
- Use existing parsed fields such as symbol, PDF name, issuer, instrument, asset class, last price, quantity, market value, and source file timestamp.
- Always label these rows as `source: "pdf"` or field-level `source: "pdf_fallback"`.
- Show a stale-data warning when the PDF extraction date is older than the latest successful external refresh.

## Field-Level Source Priority

### Identity Resolution

1. Local existing portfolio identifiers from CSV/PDF: symbol, ISIN-like values, PDF name, issuer, instrument.
2. Trading 212 instrument metadata by exact Trading 212 ticker, ISIN, or normalized name.
3. Alpaca assets by exact US symbol.
4. yfinance Search / Ticker lookup by symbol and name.
5. PDF-only fallback row when none of the APIs match.

The normalized internal key should prefer ISIN when available. If ISIN is missing, use provider namespace plus ticker, for example `alpaca:NVDA`, `trading212:AAPL_US_EQ`, or `yfinance:ASML.AS`.

### Holdings And Account Context

1. Trading 212 portfolio endpoint.
2. Backend portfolio summary calculated from CSV/PDF.
3. PDF-derived position data.

Fields: quantity, average cost, current value, unrealized P/L, account currency, holding days, holding status.

### Current Price

1. Trading 212 `currentPrice` for Trading 212-held positions.
2. Alpaca latest quote/trade/bar for US assets.
3. yfinance `fast_info`, `history`, or recent download result.
4. PDF last known price / backend-calculated last price.

Return `priceSource`, `priceAsOf`, and `isStale` so the UI can make the fallback visible.

### Instrument Metadata

1. Trading 212 metadata for ISIN, Trading 212 ticker, type, currency, and platform availability.
2. Alpaca assets for US exchange, status, tradable flag, fractional/extended-hours attributes, options availability attributes.
3. yfinance metadata for sector, industry, country, exchange name, market cap, and long name.
4. PDF fields for issuer, PDF name, instrument, and asset class.

### Research And Rating Inputs

1. yfinance analyst targets, earnings data, financial statements, price history, sector/industry, and market cap.
2. Alpaca market bars/news/snapshots for recent momentum and market-state signals.
3. Internal portfolio context from Trading 212/backend: current holding size, concentration, cost basis, realized/unrealized P/L, and holding days.
4. PDF fallback only for identity and local valuation context, not for fresh research signals.

Trading 212 should affect whether an asset is actually held or tradable in the account; it should not drive the investment rating by itself.

## Recommended Provider Order By Use Case

### Existing Held Position

1. Resolve with Trading 212 portfolio/instrument metadata.
2. Enrich US market/tradability data with Alpaca if the symbol maps cleanly.
3. Enrich research/fundamentals with yfinance.
4. Fall back missing identity/valuation fields to PDF data.

### New Watchlist Candidate

1. Resolve by Alpaca when it is a US ticker.
2. Resolve/enrich by yfinance for global coverage and analyst/fundamental fields.
3. Check Trading 212 metadata to see whether it is tradable in the user account.
4. Use PDF only if the product already exists in uploaded local data but APIs cannot resolve it.

### Trading 212-Specific Product

1. Resolve by Trading 212 ticker or ISIN.
2. Try yfinance by ISIN/name/ticker mapping for research enrichment.
3. Try Alpaca only if it maps to a US ticker.
4. Fall back to PDF if external lookup fails.

## Normalized Backend Shape

Add a backend endpoint later, for example:

```text
GET /data/stock-analysis.json
```

Suggested top-level shape:

```json
{
  "generatedAt": "2026-05-16T12:00:00Z",
  "sources": {
    "trading212": { "status": "ok", "refreshedAt": "..." },
    "alpaca": { "status": "partial", "refreshedAt": "..." },
    "yfinance": { "status": "ok", "refreshedAt": "..." },
    "pdf": { "status": "ok", "path": "data/asset_overview_extracted.txt" }
  },
  "rows": [
    {
      "id": "isin:US67066G1040",
      "symbol": "NVDA",
      "displayName": "NVIDIA",
      "isin": "US67066G1040",
      "assetClass": "STOCK",
      "currency": "USD",
      "price": 143.85,
      "priceSource": "alpaca",
      "fallbackLevel": "none",
      "holding": {
        "quantity": 10,
        "source": "trading212"
      },
      "research": {
        "targetPrice": 172,
        "rating": "买入",
        "source": "yfinance"
      },
      "warnings": []
    }
  ]
}
```

## Fallback Rules

- A provider result counts as missing when the API returns not found, the identifier maps ambiguously, the price is null/zero for a live product, or the returned currency/exchange clearly conflicts with the expected product.
- Do not merge two products only because names are similar. Prefer exact ISIN, then exact ticker in the correct namespace, then high-confidence name match with matching currency/exchange.
- If all external providers fail, create a row from PDF data with:
  - `fallbackLevel: "pdf_only"`
  - `priceSource: "pdf"`
  - `research.source: null`
  - warning: `外部 API 未找到该产品，当前显示 PDF 本地数据`
- If only research fields fail but identity/price succeeds, keep the row and mark missing research fields as unavailable.

## Caching And Refresh

- Cache Trading 212 instrument metadata for at least 10 minutes and respect endpoint rate limits.
- Cache Alpaca assets by symbol/exchange for one trading day, but refresh prices on the UI refresh cadence or a short backend TTL.
- Cache yfinance research/fundamental fields for several hours or one day. Refresh prices separately from fundamentals.
- Cache PDF fallback until a new PDF upload or extraction changes `PDF_TEXT_PATH`.
- Store per-provider `refreshedAt`, `status`, and `errorSummary` so the UI can distinguish provider outages from product misses.

## UI Behavior

- Replace the current mock `apiStatus` with actual `priceSource` or `primarySource`.
- Show source badges: `Trading 212`, `Alpaca`, `yfinance`, `PDF fallback`.
- Add a warning chip for `pdf_only` and stale prices.
- Keep the current tier tables, but drive tiers from backend scoring:
  - Tier 1: high conviction and actionable based on rating, valuation gap, momentum, and portfolio fit.
  - Tier 2: good candidate but missing one major confirmation.
  - Tier 3: watch only, insufficient data, weak signal, or PDF-only fallback.
- Expanded row should show source breakdown, last refresh time, identifier mapping, and missing fields.

## Implementation Phases

1. Define the normalized stock-analysis DTO in the backend.
2. Build provider adapters behind one trait/interface:
   - Trading 212 adapter
   - Alpaca adapter
   - yfinance adapter
   - PDF fallback adapter using existing portfolio summary/PDF extraction data
3. Implement identifier resolution and confidence scoring.
4. Implement field-level merge logic and fallback warnings.
5. Add `GET /data/stock-analysis.json`.
6. Replace `StockAnalysisTab` mock rows with a hook that fetches the new endpoint.
7. Add backend tests for provider merge/fallback logic using fixture responses.
8. Add frontend empty/loading/error/fallback-source states.

## Open Decisions

- Whether to run yfinance through a Python helper process or replace it with direct HTTP/provider-specific calls in Rust.
- Whether Trading 212 API credentials should be optional, with CSV/PDF-only mode still supported.
- Whether Alpaca should be used only for market data or also for optional trading actions later.
- How aggressive the scoring/rating model should be, especially for user-visible labels like `强烈买入`.

## Source Notes

- Trading 212 Public API docs: https://docs.trading212.com/api/instruments/instruments
- Trading 212 OpenAPI description: https://docs.trading212.com/_bundle/api.json
- Alpaca `/v2/assets` docs: https://docs.alpaca.markets/us/reference/get-v2-assets-1
- Alpaca assets guide: https://docs.alpaca.markets/us/docs/working-with-assets
- yfinance project README: https://github.com/ranaroussi/yfinance/blob/main/README.md
- yfinance API reference: https://ericpien.github.io/yfinance/reference/api/yfinance.Ticker.html
