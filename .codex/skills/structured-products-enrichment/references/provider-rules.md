# Agent Foundry Structured Products Provider Rules

This reference documents current structured-products enrichment behavior in the Agent Foundry repo. Treat it as the first checklist when an ISIN shows missing Greeks, incorrect factor leverage, wrong direction, `N/A`, or `HARD_BLOCKED`.

## Entry Points

- CLI: `backend/python/src/agent_foundry_python/structured_products/cli.py`
- Live provider order:
  1. `BoerseFrankfurtQuoteProvider` for quote price/currency/timestamp.
  2. `OnvistaProductProvider` for product metadata and Greeks.
  3. `GsDeProductProvider` as product fallback after Onvista/cache cannot satisfy required fields.
- Product providers are configured as `[onvista_provider, gs_de_provider]`.
- Only rows matching `live_enrichment_tier` are live-enriched; default is `tier1`.
- `assign_enrichment_tiers(..., tier1_limit=20)` promotes top underlying groups into Tier 1.

## Onvista Provider

Source file: `backend/python/src/agent_foundry_python/structured_products/providers/onvista.py`.

### Fetch Rule

- Resolve ISIN through `https://www.onvista.de/suche?searchValue=<ISIN>`.
- Use the redirected URL as the product page URL.
- Fetch server-rendered HTML from that URL.
- Parse metadata/Greeks from HTML; no documented stable ISIN API is used.
- On HTTP or parse failure, return `None` so gs.de can run.

### Parsed HTML Sources

Parser tries:

1. `<dt>/<dd>` definition list fields.
2. Table-like `<tr><th|td>...`.
3. Data-card style `<data value=...>` with nearby labels.
4. `__NEXT_DATA__` snapshot fallback for `isin`, `wkn`, and underlying inferred from `name`.
5. Title/first heading/full text for product type and direction detection.

### Onvista Label Mapping

Metadata fields:

- `emittent`, `issuer` -> `issuer`
- `wkn` -> `wkn`
- `isin` -> `isin`
- `basiswert`, `underlying` -> `underlying`
- `produkttyp`, `produktart`, `product type` -> `product_type`
- `hebel`, `leverage`, `faktor`, `factor` -> `leverage`
- `basispreis`, `strike`, `strike price`, `akt. basispreis` -> `strike_price`
- `knock-out`, `k.o.`, `ko`, `knock out`, `knockout`, `ko-schwelle`, `k.o.-schwelle` -> `knockout_price`
- `break-even`, `break even`, `break-even-punkt`, `gewinnschwelle` -> `break_even`
- `bezugsverhaeltnis`, `bezugsverhältnis`, `ratio` -> `ratio`
- `faelligkeit`, `fälligkeit`, `expiry` -> `expiry`
- `typ`, `optionstyp` -> `option_type`
- `akt. reset-barriere`, `reset-barriere`, `reset barrier` -> `reset_barrier`

Greek fields:

- `delta` -> `delta`
- `omega` -> `omega`
- `theta` -> `theta`
- `impl. volatilitaet`, `impl. volatilität`, `implizite volatilitaet`, `implizite volatilität`, `volatilitaet`, `volatilität` -> `iv`

### Onvista Normalization

- Product type mapping:
  - `optionsschein` -> `optionsschein`
  - `open-end turbo`, `open end turbo`, `turbo-optionsschein`, `turbo` -> `open_end_turbo`
  - `knock-out`, `knock out` -> `knock_out`
  - `faktor zertifikat`, `faktor-zertifikat`, `factor certificate`, `faktor-optionsschein`, `faktor optionsschein` -> `factor_certificate`
- Direction detection:
  - `put`, `bear`, `short`, `turbop`, `fakts` -> `put`
  - `call`, `bull`, `long`, `turboc`, `faktl` -> `call`
- Numeric values use German decimal parsing.
- `iv` is divided by 100 when source includes `%` or numeric value is greater than 1.
- Expiry accepts `DD.MM.YYYY` and `YYYY-MM-DD`; open-ended text becomes `None`.

## gs.de Provider

Source file: `backend/python/src/agent_foundry_python/structured_products/providers/gs_de.py`.

### Fetch Rule

1. First try GraphQL:
   - URL: `https://www.gs.de/graphql`
   - Operation: `getSecuritizedProduct`
   - Variable: `{"id": "<ISIN>"}`
   - Referer: `https://www.gs.de/de/optionsschein-rechner?isin=<ISIN>`
2. If GraphQL fails or mismatches ISIN, fall back to calculator HTML:
   - URL: `https://www.gs.de/de/optionsschein-rechner?isin=<ISIN>`
   - Use Playwright when not using a mock transport.
   - Wait for client-side JS before parsing HTML.
3. Provider returns `None` on expected network/parse failures so enrichment can continue.

GraphQL is the preferred metadata path. It avoids unnecessary Playwright use and exposes structured fields for products whose page visibly works but HTML parsing fails. If GraphQL returns an optionsschein with missing Greeks, still try calculator HTML/Playwright and merge calculator `Delta %`, `Omega`, `Theta`, and `IV` back into the GraphQL metadata.

### gs.de GraphQL Fields Used

Metadata:

- `synonyms.isn` or `id` -> `isin`
- `synonyms.wpk` -> `wkn`
- `issuanceInfo.issuer.name` or `.symbol` -> `issuer`
- first `assets[].fullName` or `.name` -> `underlying`
- `classificationInfo.flavour.code/description` -> `product_type`
- `economics.realTimeData.leverage` or `productTerms.factor` -> `leverage`
- `productTerms.strike` -> `strike_price`
- `productTerms.knockOut` -> `knockout_price`
- `economics.realTimeData.breakEven` -> `break_even`
- `productTerms.ratio` or inverse of first `productTerms.underlyers[].ratio` -> `ratio`
- `productTerms.expirationDate` -> `expiry`
- `productTerms.levels[].claimType` or `levels[].direction` -> `option_type`

Greeks:

- `economics.realTimeData.delta` -> `delta`
- `economics.realTimeData.omega` -> `omega`
- `economics.realTimeData.impliedVolatility` -> `iv`
- `theta` is generally not available from current GraphQL parser.

### gs.de Type and Direction Rules

- Product type:
  - flavour text containing `faktor` or `factor` -> `factor_certificate`
  - flavour text containing `turbo` or `knock` -> `open_end_turbo`
  - flavour text containing `optionsschein`, `warrant`, or `covplain` -> `optionsschein`
- Direction:
  - `claimType.key/description` containing `CALL` -> `call`
  - `claimType.key/description` containing `PUT` -> `put`
  - factor `direction.description` containing `Long` -> `call`
  - factor `direction.description` containing `Short` -> `put`

Important examples:

- `DE000HT0Q0Z8` returns optionsschein metadata plus `delta`, `omega`, `iv`.
- `DE000SJ7BGU6` returns GraphQL metadata (`strike`, `ratio`, `expiry`, `break_even`) with `realTimeData.delta = null`, but the calculator page can still expose `Delta %`; do not return early from GraphQL when optionsschein Greeks are incomplete.
- `DE000SX1Y9R4` returns `factor_certificate`, `factor=3`, `ratio=1`, direction `Long`; real-time Greeks can be absent.

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
4. Greek cache is fresh for 1 hour.
5. Merge cached metadata and fresh cached Greek first with overwrite.
6. Keep expired cached Greek as a stale fallback. Do not use it before live providers, but if providers cannot fill Greek fields, merge it into missing fields and mark `greeks_source = cache_stale`.
7. If `_needs_product_fallback(row)` is true, try product providers in order: Onvista, then gs.de.

### Fallback Trigger

`_needs_product_fallback` currently checks missing:

- `leverage`
- `break_even`
- `ratio`
- `expiry`
- `delta`
- `omega`
- `theta`
- `iv`

Because `theta` often remains missing, providers may continue through the list even after useful metadata was fetched. Do not assume provider call means complete data exists.

### Merge Behavior

Metadata merge fields:

- `wkn`, `issuer`, `underlying`, `product_type`, `leverage`, `strike_price`, `knockout_price`, `break_even`, `ratio`, `expiry`, `option_type`, `reset_barrier`

Greek merge fields:

- `delta`, `omega`, `theta`, `iv`

Overwrite rule:

- Cached metadata and fresh cached Greek are merged first.
- Provider data uses `overwrite=not metadata_sources` and `overwrite=not greek_sources`.
- If cache supplied a field, later provider data may not overwrite it unless merge logic changes.
- Expired cached Greek is merged only after provider attempts and only into missing fields; it is not reinserted as a fresh cache record.

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
7. For factor certificates, verify `leverage` comes from Onvista `faktor` or gs.de `productTerms.factor`.
8. For gs.de products, inspect raw GraphQL before adding HTML parsing, but remember calculator Greeks may exist even when GraphQL `realTimeData` Greeks are `null`.
9. Check exposure fallback order before editing risk status.
10. Add tests with the failing ISIN's real response shape.

Provider direct-check pattern:

```bash
UV_CACHE_DIR=/tmp/uv-cache uv run --directory backend/python python -c "exec('''
import asyncio, json
from agent_foundry_python.structured_products.providers.gs_de import GsDeProductProvider
async def main():
    p = GsDeProductProvider(timeout=10)
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

Onvista parser tests should use representative HTML snippets. gs.de parser tests should prefer GraphQL fixtures for the real response shape.

## Test Targets

- `backend/python/tests/test_gs_de_provider.py`
- `backend/python/tests/test_onvista_parser.py`
- `backend/python/tests/test_enrichment.py`
- `backend/python/tests/test_exposure.py`
- `backend/python/tests/test_risk.py`
- `backend/python/tests/test_storage.py`

For frontend group/action display issues, also inspect:

- `web/src/utils/watchlistGrouping.js`
- `web/src/components/stock-analysis/WatchlistTable.jsx`
- `web/src/components/stock-analysis/GroupDetailPanel.jsx`
