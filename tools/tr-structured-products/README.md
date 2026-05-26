# Trade Republic Structured Products Enrichment

Lightweight Python subproject for enriching structured products already parsed by the Rust Agent-Foundry backend. Rust remains the source of truth for Trade Republic CSV/PDF ingestion; Python does not re-parse those files in the production path.

## Scope

Current implementation covers the first usable slice:

- Adapter from Rust `PortfolioSummaryResponse.positions` into structured-product enrichment rows.
- CSV, JSON, and SQLite output generation from Rust-normalized positions.
- SQLite schema for positions, instrument metadata, quotes, and greeks.
- Börse Frankfurt quote provider using `price_information/single`.
- Onvista public search resolver + SSR HTML metadata/greeks parser.
- finanzen.net SSR provider remains available in code/tests, but is not part of the default pipeline because the current VPS receives Akamai `403 Forbidden` from finanzen.net live search.
- Live enrichment orchestrator: Onvista metadata/greeks first, then Börse Frankfurt quote refresh by ISIN.
- Tiered enrichment policy: at most 20 Tier 1 underlying groups call live providers; all structured products inside a Tier 1 group inherit Tier 1, while remaining structured products are Tier 2 and ETF/bond/non-derivative rows are Tier 3.
- Normalized Pydantic models.
- SQLite repository helpers for storing normalized positions, metadata, and quotes.
- Simple delta exposure calculation: `quantity × delta × underlying_price`.

Supported structured product keywords detected from Rust position fields:

- Optionsschein / Call / Put
- Knock-Out / Knock Out
- Turbo / Open-End Turbo
- Faktor Zertifikat

Generate current outputs from the running Rust backend:

```bash
uv run --with httpx --with beautifulsoup4 --with lxml --with pydantic \
  python scripts/generate_agent_foundry_outputs.py
```

Default behavior uses tiered live enrichment:

1. Assign Tier 1 to at most 20 live-eligible underlying groups ranked by total structured-product market value.
2. Only Tier 1 rows call Onvista public search (`/suche?searchValue=ISIN`) to resolve product pages and parse metadata/greeks from SSR HTML.
3. Only Tier 1 rows call Börse Frankfurt quote refresh by ISIN.
4. Tier 2/3 rows keep Rust summary price/metadata as fallback and do not call live derivative providers by default.

For cautious smoke runs, limit the number of products and slow the request rate:

```bash
uv run --with httpx --with beautifulsoup4 --with lxml --with pydantic \
  python scripts/generate_agent_foundry_outputs.py \
  --limit 10 \
  --tier1-limit 20 \
  --request-delay 3 \
  --csv ../../data/structured-products-enrichment-onvista-smoke10.csv \
  --json ../../data/structured-products-enrichment-onvista-smoke10.json \
  --db ../../data/structured-products-enrichment-onvista-smoke10.sqlite3
```

Default outputs:

- `../../data/structured-products-enrichment.csv`
- `../../data/structured-products-enrichment.sqlite3`
- `../../web/public/data/structured-products-enrichment.json`

## Development

From this directory:

```bash
uv run --with pytest --with pytest-asyncio --with httpx --with beautifulsoup4 --with lxml --with pydantic pytest -q
uv run --with pytest --with pytest-asyncio --with httpx --with beautifulsoup4 --with lxml --with pydantic python -m compileall -q src tests
```

## Design Notes

- Unit tests use `httpx.MockTransport`; they do not hit live provider endpoints.
- Onvista parsing is DOM-based (`BeautifulSoup` + `lxml`) rather than regex-only scraping.
- Provider interfaces are intentionally small so finanzen.net and issuer-specific parsers can be added as fallbacks later.
- Issuer pages should become source of truth for greeks and official leverage/KO values in the next phase.
