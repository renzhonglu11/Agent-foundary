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

## Backend

Configuration is loaded from environment variables. Start from:

```bash
cp .env.example .env
```

Important values:

```text
DATABASE_URL=sqlite://data/agent_foundry.db
CSV_PATH=data/Transaktionsexport.csv
PDF_PATH=data/Vermögensübersicht.pdf
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
ssh user@vps 'sudo mkdir -p /opt/agent-foundry/bin /opt/agent-foundry/data'
scp target/release/agent-foundry-backend user@vps:/tmp/agent-foundry-backend
scp .env.example user@vps:/tmp/agent-foundry.env
scp deploy/agent-foundry-backend.service user@vps:/tmp/agent-foundry-backend.service
scp data/Transaktionsexport.csv user@vps:/tmp/Transaktionsexport.csv
```

On the VPS, install:

```bash
sudo useradd --system --home /opt/agent-foundry --shell /usr/sbin/nologin agentfoundry || true
sudo mv /tmp/agent-foundry-backend /opt/agent-foundry/bin/agent-foundry-backend
sudo mv /tmp/agent-foundry.env /opt/agent-foundry/.env
sudo mv /tmp/Transaktionsexport.csv /opt/agent-foundry/data/Transaktionsexport.csv
sudo mv /tmp/agent-foundry-backend.service /etc/systemd/system/agent-foundry-backend.service
sudo chown -R agentfoundry:agentfoundry /opt/agent-foundry
sudo chmod +x /opt/agent-foundry/bin/agent-foundry-backend
sudo systemctl daemon-reload
sudo systemctl enable --now agent-foundry-backend
sudo systemctl status agent-foundry-backend
```
