# Backend Agent Instructions

These instructions apply to work under `backend/`.

## Scope

- This directory contains the Rust Axum API, SQLx SQLite migrations, portfolio domain logic, and PDF/CSV import integration.
- Keep backend changes inside `backend/` unless the API contract requires coordinated frontend or documentation updates.
- Treat files in `data/` as local runtime input/output. Do not commit generated databases, private CSV exports, PDFs, or extracted portfolio data.

## Commands

- Run the backend locally from the repository root with `cargo run -p agent-foundry-backend`.
- After changing Rust code, run:
  - `cargo fmt --all`
  - `cargo clippy --all-targets -- -D warnings`
  - `cargo test`
- For release validation, run `cargo build --release`.

## Rust Conventions

- The workspace forbids `unsafe_code` and denies `unwrap_used` and `expect_used`; propagate errors with `?`, `anyhow::Context`, or typed errors instead.
- Keep domain calculations in `src/domain` or `src/services`, persistence in `src/db`, and HTTP request/response handling in `src/api`.
- Prefer small, testable functions for parsing, importing, and portfolio calculations.
- Keep async boundaries explicit. Do not block inside request handlers unless the existing code already isolates that operation.
- When changing migrations, add a new migration file under `backend/migrations/`; do not edit applied migrations unless the change is only for an unshared local draft.

## API And Data Contracts

- Preserve the frontend-facing `/data/portfolio-summary.json` response shape unless the web app is updated in the same task.
- Keep upload validation strict for file type and filename handling.
- Include useful context in backend errors, but do not leak private local file contents or secrets in API responses.

## Python Helper

- `backend/python` installs backend-only Python CLI tools such as `agent-foundry-extract-pdf`. Keep Python dependencies listed in `backend/python/pyproject.toml`.
- If this helper changes, verify the upload/extraction path still refreshes the portfolio summary cache.
