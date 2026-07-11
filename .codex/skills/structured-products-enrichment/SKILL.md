---
name: structured-products-enrichment
description: Debug and implement Agent Foundry structured-products enrichment, especially Onvista and gs.de provider behavior, fallback order, metadata/Greek merge rules, factor certificate handling, delta exposure, risk status, and stale or missing fields in structured-products-enrichment/risk payloads. Use when fixing financial derivative data issues such as N/A risk actions, missing Greeks, incorrect factor leverage, wrong call/put direction, stale cache, or provider fallback failures.
---

# Structured Products Enrichment

Use this skill before changing structured-products provider, enrichment, exposure, or risk code.

## Quick Workflow

1. Read `references/provider-rules.md`.
2. Inspect these files in the repo before editing:
   - `backend/python/src/agent_foundry_python/structured_products/providers/onvista.py`
   - `backend/python/src/agent_foundry_python/structured_products/providers/gs_de.py`
   - `backend/python/src/agent_foundry_python/structured_products/enrichment.py`
   - `backend/python/src/agent_foundry_python/structured_products/exposure.py`
   - `backend/python/src/agent_foundry_python/structured_products/risk.py`
   - `backend/python/src/agent_foundry_python/structured_products/cli.py`
3. Reproduce the failing ISIN through the provider directly before changing risk logic.
4. Check whether the issue is provider fetch, provider parse, merge/cache overwrite, exposure calculation, or risk completeness scoring.
5. Add or update focused tests for the exact product class: vanilla optionsschein, open-end turbo, knock-out, or factor certificate.

## Required Validation

Run at least:

```bash
UV_CACHE_DIR=/tmp/uv-cache uv run --directory backend/python pytest tests/test_gs_de_provider.py tests/test_enrichment.py tests/test_exposure.py tests/test_risk.py
```

Run full Python tests when touching shared enrichment, storage, or risk behavior:

```bash
UV_CACHE_DIR=/tmp/uv-cache uv run --directory backend/python pytest
```

If a fix depends on current provider behavior, verify the specific ISIN against the live provider. Network may require approval.
