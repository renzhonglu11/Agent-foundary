# Agent Foundry

Personal portfolio dashboard — Rust backend + React frontend + Python sidecar for structured-product enrichment.

## Architecture

```
React (Vite + MUI)  →  Axum API (Rust)  →  SQLite
                              ↓
                       Python sidecar (uv)
                       - structured products enrichment
                       - macro analysis
                       - PDF extraction
```

Backend uses **hexagonal architecture**:
- `backend/src/domain/` — pure data types (Transaction, Portfolio, Money)
- `backend/src/application/` — ports (traits) + orchestrating services
- `backend/src/infrastructure/` — SQLite-driven implementations
- `backend/src/services/` — external API integrations (Alpaca, FRED, ApeWisdom, Hermes Cron)
- `backend/src/api/` — Axum routes + handlers

## Key Commands

### Rust Backend

```bash
# Run
cargo run -p agent-foundry-backend

# Check
cargo fmt --all
cargo clippy --all-targets -- -D warnings
cargo test

# Production build
cargo build --release
# → target/release/agent-foundry-backend
```

### Python Sidecar

```bash
cd backend/python
uv sync
uv run pytest                           # all tests
UV_CACHE_DIR=/tmp/uv-cache uv run pytest tests/test_gs_de_provider.py tests/test_enrichment.py tests/test_exposure.py tests/test_risk.py
```

### Frontend

```bash
cd web
npm install
npm run dev       # starts Vite + backend concurrently
npm run build     # production → web/dist/
npm test
```

## Environment

Copy `.env.example` → `.env` and configure:
- `DATABASE_URL` — SQLite path
- `ALPACA_*` — optional live quotes
- `FRED_API_KEY` — optional US macro data
- `STRUCTURED_PRODUCTS_*` — enrichment pipeline flags

## Code Standards

- `unsafe_code = "forbid"` — zero unsafe blocks
- `unwrap_used = "deny"` / `expect_used = "deny"` — all errors are explicit `Result`
- Edition 2024, MSRV 1.88

<!-- OPENWIKI:START -->

## OpenWiki

This repository uses OpenWiki for recurring code documentation. Start with `openwiki/quickstart.md`, then follow its links to architecture, workflows, domain concepts, operations, integrations, testing guidance, and source maps.

The scheduled OpenWiki GitHub Actions workflow refreshes the repository wiki. Do not hand-edit generated OpenWiki pages unless explicitly asked; prefer updating source code/docs and letting OpenWiki regenerate.

<!-- OPENWIKI:END -->
