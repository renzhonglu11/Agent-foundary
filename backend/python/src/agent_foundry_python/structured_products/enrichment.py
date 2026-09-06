from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from typing import Any, Callable, Protocol

from agent_foundry_python.structured_products.models import Greek, InstrumentMetadata, Quote
from agent_foundry_python.structured_products.storage import StructuredProductStore

logger = logging.getLogger(__name__)


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
    cache_store: StructuredProductStore | None = None,
    request_delay_seconds: float = 0.0,
    live_enrichment_tier: str | None = None,
    progress_callback: Callable[[dict[str, Any]], None] | None = None,
    max_concurrency: int = 3,
) -> list[dict]:
    """Enrich rows with live quotes, metadata, and greeks.

    Product providers are tried in order. Provider failures are expected to
    return None so the pipeline can continue with the next provider or Rust
    summary data.
    """
    live_total = sum(1 for row in rows if _should_live_enrich(row, live_enrichment_tier))
    completed_counter = [0]
    semaphore = asyncio.Semaphore(max_concurrency)

    async def process_row(row: dict) -> dict:
        enriched = dict(row)
        isin = str(enriched.get("isin") or "")
        if not isin:
            return enriched

        should_live_enrich = _should_live_enrich(enriched, live_enrichment_tier)

        for field in ("delta", "omega", "theta", "iv"):
            enriched.setdefault(field, None)

        if not should_live_enrich:
            enriched["live_enrichment_enabled"] = False
            return enriched

        async with semaphore:
            if progress_callback is not None:
                progress_callback({
                    "event": "structured_products_progress",
                    "phase": "fetching",
                    "current": completed_counter[0],
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

            cached_metadata = None
            cached_greek = None
            stale_cached_greek = None
            
            if cache_store is not None:
                cached_metadata = cache_store.get_metadata(isin)
                cached_greek = cache_store.get_latest_greek(isin)

                # Check if greek is expired or incomplete
                if cached_greek is not None:
                    from datetime import datetime, timezone
                    g_time = cached_greek.timestamp
                    if g_time.tzinfo is None:
                        g_time = g_time.replace(tzinfo=timezone.utc)
                    age = datetime.now(timezone.utc) - g_time
                    expired = age.total_seconds() > 3600  # 1 hour
                    incomplete = any(
                        getattr(cached_greek, field) is None
                        for field in ("delta", "omega", "theta", "iv")
                    )
                    if expired or incomplete:
                        stale_cached_greek = cached_greek
                        cached_greek = None
                        if incomplete and not expired:
                            logger.debug("Cached greek for %s is fresh but incomplete, treating as stale", isin)

            metadata_sources: list[str] = []
            greek_sources: list[str] = []
            metadata_urls: list[str] = []

            if cached_metadata is not None:
                _merge_metadata(enriched, cached_metadata, overwrite=True)
                metadata_sources.append("cache")
                
            if cached_greek is not None:
                _merge_greek(enriched, cached_greek, overwrite=True)
                greek_sources.append("cache")

            if _needs_product_fallback(enriched):
                for provider in product_providers or []:
                    product = await provider.get_product_data(isin)
                    if product is None:
                        continue

                    name = enriched.get("instrument") or enriched.get("display_name") or ""
                    
                    greek_to_merge = product.greek
                    if greek_to_merge is not None and _is_greek_invalid(greek_to_merge, name):
                        greek_to_merge = None
                        
                    metadata_to_merge = product.metadata
                    if metadata_to_merge is not None and _is_metadata_invalid(metadata_to_merge, name):
                        metadata_to_merge = metadata_to_merge.model_copy(update={"leverage": None})

                    metadata_changed = _merge_metadata(
                        enriched,
                        metadata_to_merge,
                        overwrite=not metadata_sources or metadata_sources == ["cache"],
                    )
                    if metadata_changed:
                        if "cache" in metadata_sources:
                            metadata_sources.remove("cache")
                        metadata_sources.append(product.source)
                    if greek_to_merge is not None:
                        greek_changed = _merge_greek(enriched, greek_to_merge, overwrite=not greek_sources)
                        if greek_changed:
                            if "cache" in greek_sources:
                                greek_sources.remove("cache")
                            greek_sources.append(product.source)
                    if product.url:
                        metadata_urls.append(product.url)
                        
                    _clean_invalid_greeks(enriched)
                    
                    if not _needs_product_fallback(enriched):
                        break

            if stale_cached_greek is not None:
                name = enriched.get("instrument") or enriched.get("display_name") or ""
                if not _is_greek_invalid(stale_cached_greek, name):
                    stale_greek_changed = _merge_greek(enriched, stale_cached_greek, overwrite=False)
                    if stale_greek_changed:
                        greek_sources.append("cache_stale")

            # Save back to cache if we fetched new data from network and they are clean
            if cache_store is not None:
                name = enriched.get("instrument") or enriched.get("display_name") or ""
                
                if metadata_sources and "cache" not in metadata_sources:
                    metadata_to_save = InstrumentMetadata(
                        isin=isin,
                        wkn=enriched.get("wkn"),
                        issuer=enriched.get("issuer"),
                        underlying=enriched.get("underlying"),
                        product_type=enriched.get("product_type"),
                        leverage=enriched.get("leverage"),
                        strike_price=enriched.get("strike_price"),
                        knockout_price=enriched.get("knockout_price"),
                        break_even=enriched.get("break_even"),
                        ratio=enriched.get("ratio"),
                        expiry=enriched.get("expiry"),
                        option_type=enriched.get("option_type"),
                        reset_barrier=enriched.get("reset_barrier"),
                    )
                    if not _is_metadata_invalid(metadata_to_save, name):
                        cache_store.upsert_metadata(metadata_to_save)

                if greek_sources and "cache" not in greek_sources and "cache_stale" not in greek_sources:
                    greek_to_save = Greek(
                        isin=isin,
                        delta=enriched.get("delta"),
                        omega=enriched.get("omega"),
                        theta=enriched.get("theta"),
                        iv=enriched.get("iv"),
                    )
                    if not _is_greek_invalid(greek_to_save, name):
                        cache_store.insert_greek(greek_to_save)

            if metadata_sources:
                enriched["metadata_source"] = "+".join(dict.fromkeys(metadata_sources))
            if greek_sources:
                enriched["greeks_source"] = "+".join(dict.fromkeys(greek_sources))
            if metadata_urls:
                enriched["metadata_url"] = metadata_urls[-1]

            enriched["live_enrichment_enabled"] = _has_live_enrichment(enriched)
            
            completed_counter[0] += 1
            if progress_callback is not None:
                progress_callback({
                    "event": "structured_products_progress",
                    "phase": "fetched",
                    "current": completed_counter[0],
                    "total": live_total,
                    "isin": isin,
                    "label": f"Fetched {isin}",
                })
            if request_delay_seconds > 0:
                await asyncio.sleep(request_delay_seconds)
                
            return enriched

    tasks = [process_row(row) for row in rows]
    return list(await asyncio.gather(*tasks))


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

def _clean_invalid_greeks(row: dict) -> None:
    name = str(row.get("instrument") or row.get("display_name") or row.get("underlying") or "").lower()
    is_call = any(k in name for k in ("call", "bull", "long", "turboc", "faktl"))
    is_put = any(k in name for k in ("put", "bear", "short", "turbop", "fakts"))
    
    if is_call:
        if row.get("delta") is not None and row["delta"] < 0:
            row["delta"] = abs(row["delta"])
        if row.get("omega") is not None and row["omega"] < 0:
            row["omega"] = abs(row["omega"])
        if row.get("leverage") is not None and row["leverage"] < 0:
            row["leverage"] = abs(row["leverage"])
    elif is_put:
        if row.get("delta") is not None and row["delta"] > 0:
            row["delta"] = -abs(row["delta"])
        if row.get("omega") is not None and row["omega"] > 0:
            row["omega"] = -abs(row["omega"])
        # Leverage is ALWAYS positive as a magnitude; do not modify or set it to None!
        if row.get("leverage") is not None and row["leverage"] < 0:
            row["leverage"] = abs(row["leverage"])


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
        "option_type",
        "reset_barrier",
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


def _is_greek_invalid(greek: Greek, name: str) -> bool:
    name_lower = name.lower()
    is_call = any(k in name_lower for k in ("call", "bull", "long", "turboc", "faktl"))
    is_put = any(k in name_lower for k in ("put", "bear", "short", "turbop", "fakts"))
    
    if is_call:
        if greek.delta is not None and greek.delta < 0:
            return True
        if greek.omega is not None and greek.omega < 0:
            return True
    elif is_put:
        if greek.delta is not None and greek.delta > 0:
            return True
        if greek.omega is not None and greek.omega > 0:
            return True
    return False


def _is_metadata_invalid(metadata: InstrumentMetadata, name: str) -> bool:
    name_lower = name.lower()
    is_call = any(k in name_lower for k in ("call", "bull", "long", "turboc", "faktl"))
    is_put = any(k in name_lower for k in ("put", "bear", "short", "turbop", "fakts"))
    
    if is_call:
        if metadata.leverage is not None and metadata.leverage < 0:
            return True
    elif is_put:
        if metadata.leverage is not None and metadata.leverage < 0:
            return True
    return False
