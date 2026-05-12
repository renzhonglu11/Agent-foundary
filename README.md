# Agent-Foundry

React + MUI dashboard for observing the portfolio data under `data/`.

## What it shows

- Portfolio summary cards: estimated market value, unrealized P/L, realized P/L + income, fees + taxes.
- Allocation chart by asset class.
- Monthly cashflow and buy/sell activity.
- Top positions table with weight and P/L.
- Recent transactions list.

## Data flow

```text
data/Transaktionsexport(2).csv
  -> scripts/generatePortfolioData.js
  -> public/data/portfolio-summary.json
  -> React dashboard
```

The dashboard intentionally uses a generated JSON file so the UI remains simple and maintainable. When the CSV changes, run:

```bash
npm run generate:data
```

## Run locally

```bash
npm install
npm run generate:data
npm run dev
```

Production build:

```bash
npm run build
npm run preview
```

## Notes

- Market value is estimated from the latest transaction price in the CSV, not from live market quotes.
- Cost basis and P/L are transaction-based approximations using average cost logic.
- The PDF file remains in `data/` as a source document, but this dashboard currently derives structured data from the CSV export.
