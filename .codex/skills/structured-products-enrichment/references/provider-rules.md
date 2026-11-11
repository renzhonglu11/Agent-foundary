# Agent Foundry Structured Products Provider Rules

This reference documents current structured-products enrichment behavior in the Agent Foundry repo. Treat it as the first checklist when an ISIN shows missing Greeks, incorrect factor leverage, wrong direction, `N/A`, or `HARD_BLOCKED`.

## Entry Points

- CLI: `backend/python/src/agent_foundry_python/structured_products/cli.py`
- Live provider order:
  1. `BoerseFrankfurtQuoteProvider` for quote price/currency/timestamp.
  2. `BoerseFrankfurtProductProvider` for terms and Greeks, one JSON request per product.
  3. `OnvistaProductProvider` only for what Börse Frankfurt leaves open.
- Product providers are configured as `[boerse_frankfurt_provider, onvista_provider]`.
- There is no gs.de provider and no headless browser any more (removed
  2026-11-11): gs.de answers the production server with HTTP 403, and its
  calculator fallback was the only user of Playwright.
- A source that answers HTTP 403 or 429 is not asked again in the same run
  (`providers/refusal.py`). The two Börse Frankfurt providers share one guard.
- Only rows matching `live_enrichment_tier` are live-enriched; default is `tier1`.
- Rows outside the live tier get contract terms only: from the cache, renewed
  from the product providers once a day (`TERMS_REFRESH_SECONDS`). They never
  get Greeks, a break-even, a reset barrier, or a leverage that moves with the
  quote; a factor certificate's leverage is its fixed factor and is kept. A
  product no source knows is remembered and asked about again a day later.
- `assign_enrichment_tiers(..., tier1_limit=20)` promotes top underlying groups into Tier 1.

## Börse Frankfurt Product Provider

Source file: `backend/python/src/agent_foundry_python/structured_products/providers/boerse_frankfurt.py`.

### Fetch Rule

- `GET https://api.boerse-frankfurt.de/v1/data/derivatives_master_data?isin=<ISIN>`.
- The endpoint serves the exchange's own website; it is not a documented API.
- HTTP 400 means an invalid ISIN and 404 a non-derivative; both return `None`.
- A payload whose `isin` differs from the request returns `None`.

### Fields Used

Metadata:

- `wkn` -> `wkn`
- `issuer.originalValue` -> `issuer`
- `underlyings[0].underlyingName` -> `underlying`
- `eusipaCode` (2100 warrant, 2205 open-end knock-out, 2300 factor), else the
  German `productType` text -> `product_type`
- `participationTypeName` / `productType` text -> `option_type`
- `figureOptionLeverage`; for factor certificates `participation / 100` -> `leverage`
- `underlyings[0].strikeValue.value` -> `strike_price`
- `underlyings[0].knockOutBarrierValue.value` -> `knockout_price`
- `ratio` -> `ratio`
- `finalValuationDate`, else `lastListingDate` -> `expiry`

Greeks:

- `figureOptionDelta`, `figureOptionOmega`, `figureOptionTheta` -> `delta`, `omega`, `theta`
- `figureImplVolaMid / 100` -> `iv`
- `figureQuoteTime` -> `Greek.timestamp`. It can be hours older than the fetch.

Not provided: `break_even`, `reset_barrier`.

Measured on 2026-11-11 over 62 live products: every warrant (55) had strike,
ratio, expiry and all four Greeks; knock-outs and factor certificates have no
Greeks by design.

## Onvista Provider

Source file: `backend/python/src/agent_foundry_python/structured_products/providers/onvista.py`.

### Fetch Rule

- `GET https://api.onvista.de/api/v1/derivatives/ISIN:<ISIN>/snapshot`, one JSON
  request per product.
- The website `www.onvista.de` is not used. It answers the production server
  with a bot-protection page (HTTP 403/429), and old snapshots show it never
  supplied data there. The JSON endpoint its pages read from answers normally.
- The endpoint is not a documented API.
- A payload whose `instrument.isin` differs from the request returns `None`.

### Fields Used

Metadata:

- `instrument.wkn` -> `wkn`
- `derivativesIssuer.name` -> `issuer`
- `derivativesUnderlyingList.list[0].instrument.name` -> `underlying`
- `instrument.entitySubType`: `WARRANT` -> `optionsschein`,
  `KNOCKOUT_CERTIFICATE` -> `open_end_turbo` when `derivativesDetails.openEnded`
  else `knock_out`, `FACTOR_CERTIFICATE` -> `factor_certificate`
- `derivativesDetails.codeExerciseRight` (`C`/`P`) -> `option_type`
- `derivativesFigure.gearing`; for factor certificates
  `derivativesDetails.participationRateWin` -> `leverage`
- barrier list by `typeBarrier`: `STRIKE` -> `strike_price`, `KNOCK_OUT` ->
  `knockout_price`, `RESET_LEVEL` -> `reset_barrier`
- `derivativesFigure.breakEven` -> `break_even`
- `coverRatio` of the underlying -> `ratio`
- `derivativesDetails.datetimeMaturity` -> `expiry`, `None` for open-end products

Greeks:

- `derivativesFigure.delta` -> `delta`
- `derivativesFigure.leverage` (onvista's name for the elasticity) -> `omega`
- `derivativesFigure.thetaDay` -> `theta`
- `derivativesFigure.impliedVolatility / 100` -> `iv`
- `derivativesFigure.datetimePrice` -> `Greek.timestamp`

## Enrichment Merge Rules

Source file: `backend/python/src/agent_foundry_python/structured_products/enrichment.py`.

### Cache and Provider Order

For each live-enriched row:

1. Initialize `delta`, `omega`, `theta`, `iv` keys to `None`.
2. Try quote provider first. On success set:
   - `quote_price`
   - `quote_currency`
   - `quote_source = boerse_frankfurt`
   - `quote_day_high`
   - `quote_day_low`
   - `quote_timestamp`
3. Load metadata and latest Greek from `StructuredProductStore`.
4. Greek cache is fresh for 30 minutes (`GREEK_CACHE_SECONDS`). It must stay shorter than the refresh interval: with one hour and an hourly schedule, most products reused the previous run's Greeks and were refreshed only every second hour.
5. Merge cached metadata and fresh cached Greek first with overwrite.
6. Keep expired cached Greek as a stale fallback. Do not use it before live providers, but if providers cannot fill Greek fields, merge it into missing fields and mark `greeks_source = cache_stale`.
7. If `_needs_product_fallback(row)` is true, try product providers in order: Börse Frankfurt, then Onvista.

### Fallback Trigger

`_needs_product_fallback` currently checks missing:

- `leverage`
- `ratio`
- `expiry`
- `delta`
- `omega`
- `theta`
- `iv`

`break_even` is deliberately not a trigger: consumers derive it from strike,
ratio and the current quote, and asking a second source for it alone would
double the requests of every refresh. Knock-outs and factor certificates never
have Greeks, so every provider is asked for them on each run.

### Merge Behavior

Metadata merge fields:

- `wkn`, `issuer`, `underlying`, `product_type`, `leverage`, `strike_price`, `knockout_price`, `break_even`, `ratio`, `expiry`, `option_type`, `reset_barrier`

Greek merge fields:

- `delta`, `omega`, `theta`, `iv`

Overwrite rule:

- Cached metadata and fresh cached Greek are merged first.
- The first provider that answers may replace cached metadata; providers after it only fill what is still missing. This holds even when the first answer merely confirms the cache.
- Greeks use `overwrite=not greek_sources`.
- Expired cached Greek is merged only after provider attempts and only into missing fields; it is not reinserted as a fresh cache record.
- A cached `break_even` is never served: it moves with the quote.
- `issuer` and `underlying` are sticky. Sources spell them differently, so once
  the cache holds a name, providers do not rewrite it.

Validity rules:

- For call-like names (`call`, `bull`, `long`, `turboc`, `faktl`), negative delta/omega is invalid and is cleaned or dropped.
- For put-like names (`put`, `bear`, `short`, `turbop`, `fakts`), positive delta/omega is invalid and is cleaned or dropped.
- Leverage is magnitude; negative leverage is treated as invalid/cleaned.

Persistence:

- New non-cache metadata is upserted into SQLite `instrument_metadata`.
- New non-cache Greeks are inserted into SQLite `greeks`.
- `metadata_source`, `greeks_source`, and `metadata_url` are set on output rows when available.

## Storage Fields

Source file: `backend/python/src/agent_foundry_python/structured_products/storage.py`.

`instrument_metadata` stores:

- `isin`, `wkn`, `issuer`, `underlying`, `product_type`, `leverage`, `strike_price`, `knockout_price`, `break_even`, `ratio`, `expiry`, `option_type`, `reset_barrier`, `last_updated`

`greeks` stores:

- `isin`, `timestamp`, `delta`, `omega`, `theta`, `iv`

`quotes` stores:

- `isin`, `timestamp`, `price`, `currency`

## Exposure Rules

Source file: `backend/python/src/agent_foundry_python/structured_products/exposure.py`.

Direction:

- `option_type == "put"` -> sign `-1`
- otherwise sign `+1`

Factor certificate:

1. If `leverage` exists: `market_value * leverage * direction_sign`
2. Else if `omega` exists: `market_value * signed_omega`
3. Else: `market_value * direction_sign`

Optionscheine, knock-outs, open-end turbos:

1. If `delta`, `ratio`, and underlying price exist: `quantity * delta * ratio * underlying_price`
2. Else if `omega` exists: `market_value * signed_omega`
3. Else if `leverage` exists: `market_value * leverage * direction_sign`
4. Else: `market_value * direction_sign`

Do not let missing Greeks force exposure to zero when market value is available.

## Risk Completeness Rules

Source file: `backend/python/src/agent_foundry_python/structured_products/risk.py`.

Risk is evaluated only for Tier 1 structured-product groups.

Completeness scoring must be product-aware:

- Factor products do not require `delta`.
- A factor product with `leverage`, `omega`, or at least market-value fallback is not `no_data`.
- An optionschein with missing Greeks but usable quote/market value can be `estimated_market_value`, not `no_data`.
- Expired products (`days_to_expiry <= 0`) remain `HARD_BLOCKED`.
- Products with less than 7 days to expiry should be `WATCH` or close/roll candidates.
- Quote timestamp absence should reduce confidence, but should not automatically hard-block when portfolio price/market value exists.

Expected confidence labels:

- `live_delta`
- `estimated_delta`
- `estimated_leverage`
- `estimated_omega`
- `estimated_market_value`
- `no_data`

## Debug Checklist

When an ISIN still shows missing data:

1. Run the provider directly for the ISIN and print metadata/Greek.
2. Check whether provider returned `None`, partial metadata, or missing Greeks by design.
3. Confirm `metadata.isin` equals requested ISIN; mismatches are ignored.
4. Check cache: stale or incomplete cached metadata can prevent provider overwrite.
5. Check `_needs_product_fallback`; missing `theta`/`iv` can keep fallback active.
6. Check direction detection from instrument/display name and provider fields.
7. For factor certificates, verify `leverage` comes from Börse Frankfurt `participation` or Onvista `participationRateWin`.
8. For a missing field, inspect the raw Börse Frankfurt master data, then the raw Onvista snapshot.
9. Check exposure fallback order before editing risk status.
10. Add tests with the failing ISIN's real response shape.

Provider direct-check pattern:

```bash
UV_CACHE_DIR=/tmp/uv-cache uv run --directory backend/python python -c "exec('''
import asyncio, json
from agent_foundry_python.structured_products.providers.boerse_frankfurt import BoerseFrankfurtProductProvider
async def main():
    p = BoerseFrankfurtProductProvider(timeout=10)
    r = await p.get_product_data(\"DE000EXAMPLE\")
    print(json.dumps({
        \"metadata\": r.metadata.model_dump() if r else None,
        \"greek\": r.greek.model_dump() if r and r.greek else None,
        \"source\": r.source if r else None,
        \"url\": r.url if r else None,
    }, default=str, ensure_ascii=False, indent=2))
    await p.aclose()
asyncio.run(main())
''')"
```

Provider tests should use fixtures in the shape of the real JSON responses.

## Test Targets

- `backend/python/tests/test_boerse_frankfurt_provider.py`
- `backend/python/tests/test_onvista_provider.py`
- `backend/python/tests/test_enrichment.py`
- `backend/python/tests/test_exposure.py`
- `backend/python/tests/test_risk.py`
- `backend/python/tests/test_storage.py`

For frontend group/action display issues, also inspect:

- `web/src/utils/watchlistGrouping.js`
- `web/src/components/stock-analysis/WatchlistTable.jsx`
- `web/src/components/stock-analysis/GroupDetailPanel.jsx`
