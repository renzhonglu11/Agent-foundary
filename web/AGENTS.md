# Web Agent Instructions

These instructions apply to work under `web/`.

## Scope

- This directory contains the React + Vite frontend for the Agent-Foundry dashboard.
- Keep frontend-only changes inside `web/` unless the backend API contract or repository documentation must change.
- The frontend requests `/data/portfolio-summary.json`; in local development Vite proxies that path to the Rust backend at `http://127.0.0.1:8080`.

## Commands

- Install dependencies from `web/` with `npm install` when needed.
- Start the development server from `web/` with `npm run dev`.
- After changing frontend code, run `npm run build`.
- Use `npm run preview` from `web/` to inspect the production build when layout or routing behavior changes.

## React Conventions

- Use functional React components and hooks.
- Keep data loading logic in `src/hooks` and presentation logic in `src/components`.
- Reuse existing formatting helpers from `src/utils/formatters.js` for numbers, dates, durations, and currency-like values.
- Keep imports explicit and local. Prefer existing MUI components, MUI X components, and the current charting libraries before adding new dependencies.
- Ask before adding production dependencies.

## UI Expectations

- Match the current dashboard style: MUI-based, compact, data-dense, and suitable for repeated portfolio review.
- Keep layouts responsive across mobile and desktop. Avoid fixed widths that can clip table cells, tabs, cards, or toolbar controls.
- Use existing shared classes in `src/styles.css` where practical; add component-scoped `sx` styles for local layout details.
- For tabular data, prefer `DataGrid` patterns already used in the app, including compact density and useful quick filtering/export affordances.
- Keep visible user-facing text in the app's current language style. Existing dashboard copy is primarily Chinese with finance and job-status labels where appropriate.

## Data Contracts

- Preserve compatibility with the backend portfolio summary payload unless the backend is updated in the same task.
- Treat missing or partial data defensively in hooks and components; show useful loading, empty, and error states.
- Do not reintroduce the old generated-data flow. The backend is now the source for portfolio summary data.
