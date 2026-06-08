from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any, Callable, Protocol

from agent_foundry_python.structured_products.models import Greek, InstrumentMetadata, Quote


@dataclass(frozen=True)
class ProductData:
    metadata: InstrumentMetadata
    greek: Greek | None = None
    source: str = "unknown"
    url: str | None = None


class QuoteProvider(Protocol):
    async def get_quote(self, isin: str) -> Quote | None: ...


class ProductDataProvider(Protocol):
    async def get_product_data(self, isin: str) -> ProductData | None: ...


class MetadataProviderProductAdapter:
    def __init__(self, provider, *, source: str) -> None:
        self.provider = provider
        self.source = source

    async def get_product_data(self, isin: str) -> ProductData | None:
        metadata = await self.provider.get_metadata(isin)
        if metadata is None:
            return None
        return ProductData(metadata=metadata, greek=None, source=self.source)


async def enrich_structured_product_rows(
    rows: list[dict],
    *,
    quote_provider: QuoteProvider | None = None,
    product_providers: list[ProductDataProvider] | None = None,
    request_delay_seconds: float = 0.0,
    live_enrichment_tier: str | None = None,
    progress_callback: Callable[[dict[str, Any]], None] | None = None,
) -> list[dict]:
    """Enrich rows with live quotes, metadata, and greeks.

    Product providers are tried in order. Provider failures are expected to
    return None so the pipeline can continue with the next provider or Rust
    summary data.
    """
    enriched_rows: list[dict] = []
    live_total = sum(1 for row in rows if _should_live_enrich(row, live_enrichment_tier))
    live_completed = 0
    for row in rows:
        enriched = dict(row)
        isin = str(enriched.get("isin") or "")
        if not isin:
            enriched_rows.append(enriched)
            continue

        should_live_enrich = _should_live_enrich(enriched, live_enrichment_tier)

        for field in ("delta", "omega", "theta", "iv"):
            enriched.setdefault(field, None)

        if not should_live_enrich:
            enriched["live_enrichment_enabled"] = False
            enriched_rows.append(enriched)
            continue

        if progress_callback is not None:
            progress_callback({
                "event": "structured_products_progress",
                "phase": "fetching",
                "current": live_completed,
                "total": live_total,
                "isin": isin,
                "label": f"Fetching {isin}",
            })

        if quote_provider is not None:
            quote = await quote_provider.get_quote(isin)
            if quote is not None:
                enriched["quote_price"] = quote.price
                enriched["quote_currency"] = quote.currency
                enriched["quote_source"] = "boerse_frankfurt"
                enriched["quote_day_high"] = quote.day_high
                enriched["quote_day_low"] = quote.day_low
                enriched["quote_timestamp"] = quote.timestamp.isoformat()

        metadata_sources: list[str] = []
        greek_sources: list[str] = []
        metadata_urls: list[str] = []
        for provider in product_providers or []:
            product = await provider.get_product_data(isin)
            if product is None:
                continue
            metadata_changed = _merge_metadata(enriched, product.metadata, overwrite=not metadata_sources)
            if metadata_changed:
                metadata_sources.append(product.source)
            if product.greek is not None:
                greek_changed = _merge_greek(enriched, product.greek, overwrite=not greek_sources)
                if greek_changed:
                    greek_sources.append(product.source)
            if product.url:
                metadata_urls.append(product.url)
            if not _needs_product_fallback(enriched):
                break

        if metadata_sources:
            enriched["metadata_source"] = "+".join(dict.fromkeys(metadata_sources))
        if greek_sources:
            enriched["greeks_source"] = "+".join(dict.fromkeys(greek_sources))
        if metadata_urls:
            enriched["metadata_url"] = metadata_urls[-1]

        enriched["live_enrichment_enabled"] = _has_live_enrichment(enriched)
        enriched_rows.append(enriched)
        live_completed += 1
        if progress_callback is not None:
            progress_callback({
                "event": "structured_products_progress",
                "phase": "fetched",
                "current": live_completed,
                "total": live_total,
                "isin": isin,
                "label": f"Fetched {isin}",
            })
        if request_delay_seconds > 0:
            await asyncio.sleep(request_delay_seconds)
    return enriched_rows


def _should_live_enrich(row: dict, live_enrichment_tier: str | None) -> bool:
    return live_enrichment_tier is None or row.get("enrichment_tier") == live_enrichment_tier


def _has_live_enrichment(row: dict) -> bool:
    return row.get("quote_source") == "boerse_frankfurt" or row.get("metadata_source") not in (None, "")



def _needs_product_fallback(row: dict) -> bool:
    return any(
        _is_missing(row.get(field))
        for field in (
            "leverage",
            "break_even",
            "ratio",
            "expiry",
            "delta",
            "omega",
            "theta",
            "iv",
        )
    )


def _is_missing(value: Any) -> bool:
    return value is None or value == ""


def _merge_metadata(row: dict, metadata: InstrumentMetadata, *, overwrite: bool = True) -> bool:
    changed = False
    for field in (
        "wkn",
        "issuer",
        "underlying",
        "product_type",
        "leverage",
        "strike_price",
        "knockout_price",
        "break_even",
        "ratio",
        "expiry",
    ):
        value = getattr(metadata, field)
        if value is not None and value != "" and (overwrite or _is_missing(row.get(field))):
            changed = changed or row.get(field) != value
            row[field] = value
    return changed



def _merge_greek(row: dict, greek: Greek, *, overwrite: bool = True) -> bool:
    changed = False
    for field in ("delta", "omega", "theta", "iv"):
        value = getattr(greek, field)
        if value is not None and (overwrite or _is_missing(row.get(field))):
            changed = changed or row.get(field) != value
            row[field] = value
    return changed
