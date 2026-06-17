# Agent-Foundry

Monorepo for a React dashboard and a Rust backend.

## Layout

```text
backend/      Rust Axum API, SQLx SQLite migrations, portfolio domain logic
web/          React + Vite frontend
data/         Local input files and SQLite database, ignored by git
deploy/       systemd unit templates
```

The old `scripts/generatePortfolioData.js` flow has been migrated into the Rust backend. The frontend still requests `/data/portfolio-summary.json`; in local development Vite proxies that path to `http://127.0.0.1:8080`.
Structured-products enrichment and risk reports are served from the Rust backend's `realtime_payloads` SQLite cache; JSON/CSV files are fallback or debug exports and are only refreshed when `STRUCTURED_PRODUCTS_EXPORT_FILES=true`.

## Backend

Configuration is loaded from environment variables. Start from:

```bash
cp .env.example .env
```

Important values:

```text
DATABASE_URL=sqlite://data/agent_foundry.db
CSV_PATH=data/portfolio-transactions.csv
PDF_PATH=data/asset-overview.pdf
PDF_TEXT_PATH=data/asset_overview_extracted.txt
HOST=127.0.0.1
PORT=8080
```

Run locally:

```bash
cargo run -p agent-foundry-backend
```

Checks:

```bash
cargo fmt --all
cargo clippy --all-targets -- -D warnings
cargo test
```

Production binary:

```bash
cargo build --release
```

The binary is written to:

```text
target/release/agent-foundry-backend
```

## Frontend

```bash
cd web
npm install
npm run dev
```

Build:

```bash
cd web
npm run build
```

## VPS Deployment

Local:

```bash
cargo build --release
```

Upload the binary and runtime files:

```bash
ssh user@vps 'mkdir -p /home/rz/Agent-Foundry/bin /home/rz/Agent-Foundry/data'
scp target/release/agent-foundry-backend user@vps:/tmp/agent-foundry-backend
scp .env.example user@vps:/tmp/agent-foundry.env
scp deploy/agent-foundry-backend.service user@vps:/tmp/agent-foundry-backend.service
scp data/portfolio-transactions.csv user@vps:/tmp/portfolio-transactions.csv
```

On the VPS, install:

```bash
sudo mv /tmp/agent-foundry-backend /home/rz/Agent-Foundry/bin/agent-foundry-backend
sudo mv /tmp/agent-foundry.env /home/rz/Agent-Foundry/.env
sudo mv /tmp/portfolio-transactions.csv /home/rz/Agent-Foundry/data/portfolio-transactions.csv
sudo mv /tmp/agent-foundry-backend.service /etc/systemd/system/agent-foundry-backend.service
sudo chown -R rz:rz /home/rz/Agent-Foundry
sudo chmod +x /home/rz/Agent-Foundry/bin/agent-foundry-backend
sudo systemctl daemon-reload
sudo systemctl enable --now agent-foundry-backend
sudo systemctl status agent-foundry-backend
```
