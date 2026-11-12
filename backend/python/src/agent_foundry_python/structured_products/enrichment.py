from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from typing import Any, Callable, Protocol

from agent_foundry_python.structured_products.models import Greek, InstrumentMetadata, Quote
from agent_foundry_python.structured_products.storage import StructuredProductStore
from agent_foundry_python.structured_products.providers.refusal import REQUEST_PRIORITY

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class ProductData:
    metadata: InstrumentMetadata
    greek: Greek | None = None
    source: str = "unknown"
    url: str | None = None


NAME_FIELDS = ("issuer", "underlying")
# Shorter than any sensible refresh interval. With a lifetime equal to the
# hourly interval, the Greeks stored by one run were still a few seconds
# short of expiry when the next run began, so most products were refreshed
# only every second hour.
GREEK_CACHE_SECONDS = 30 * 60
# Products outside the live tier get their contract terms from the cache and
# have them renewed from the sources once a day: a warrant's terms are fixed,
# an open-end knock-out's strike and barrier are adjusted daily.
TERMS_REFRESH_SECONDS = 24 * 60 * 60


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
    quote_fallback_providers: list[QuoteProvider] | None = None,
    product_providers: list[ProductDataProvider] | None = None,
    cache_store: StructuredProductStore | None = None,
    request_delay_seconds: float = 0.0,
    live_enrichment_tier: str | None = None,
    progress_callback: Callable[[dict[str, Any]], None] | None = None,
    max_concurrency: int = 3,
    preserve_order: bool = False,
) -> list[dict]:
    """Enrich rows with live quotes, metadata, and greeks.

    Product providers are tried in order. Provider failures are expected to
    return None so the pipeline can continue with the next provider or Rust
    summary data.
    """
    live_total = sum(1 for row in rows if _should_live_enrich(row, live_enrichment_tier))
    completed_counter = [0]
    semaphore = asyncio.Semaphore(max_concurrency)

    async def refresh_terms(enriched: dict, isin: str) -> None:
        """Contract terms for a product that is not live-enriched."""
        name = enriched.get("instrument") or enriched.get("display_name") or ""
        cached = cache_store.get_metadata(isin)
        sources: list[str] = []
        cached_names: dict[str, None] = {}
        if cached is not None:
            if _merge_metadata(enriched, _terms_only(cached, enriched, name), overwrite=True):
                sources.append("cache")
            cached_names = {field: None for field in NAME_FIELDS if getattr(cached, field)}
            if _age_seconds(cached.last_updated) < TERMS_REFRESH_SECONDS:
                if sources:
                    enriched["metadata_source"] = "cache"
                return

        async with semaphore:
            for provider in product_providers or []:
                product = await provider.get_product_data(isin)
                if product is None:
                    continue
                terms = _terms_only(product.metadata, enriched, name).model_copy(update=cached_names)
                if _merge_metadata(enriched, terms, overwrite=True):
                    sources = [source for source in sources if source != "cache"] + [product.source]
                if not _terms_missing(enriched):
                    break
            if request_delay_seconds > 0:
                await asyncio.sleep(request_delay_seconds)

        # Stored even when no source knew the product, so it is asked about
        # once a day and not on every run.
        cache_store.upsert_metadata(
            InstrumentMetadata(
                isin=isin,
                wkn=enriched.get("wkn"),
                issuer=enriched.get("issuer"),
                underlying=enriched.get("underlying"),
                product_type=enriched.get("product_type"),
                leverage=enriched.get("leverage"),
                strike_price=enriched.get("strike_price"),
                knockout_price=enriched.get("knockout_price"),
                ratio=enriched.get("ratio"),
                expiry=enriched.get("expiry"),
                option_type=enriched.get("option_type"),
            )
        )
        if sources:
            enriched["metadata_source"] = "+".join(dict.fromkeys(sources))

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
            if cache_store is not None:
                await refresh_terms(enriched, isin)
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

            quote_providers = ([quote_provider] if quote_provider else []) + (quote_fallback_providers or [])
            for provider in quote_providers:
                quote = await provider.get_quote(isin)
                if quote is not None and quote.isin == isin:
                    enriched["quote_price"] = quote.price
                    enriched["quote_currency"] = quote.currency
                    enriched["quote_source"] = getattr(provider, "source", "boerse_frankfurt")
                    enriched["quote_day_high"] = quote.day_high
                    enriched["quote_day_low"] = quote.day_low
                    enriched["quote_timestamp"] = quote.timestamp.isoformat()
                    break

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
                    expired = age.total_seconds() > GREEK_CACHE_SECONDS
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

            cached_names: dict[str, None] = {}
            if cached_metadata is not None:
                # The break-even moves with the quote, so a stored one is not served.
                cached_metadata = cached_metadata.model_copy(update={"break_even": None})
                _merge_metadata(enriched, cached_metadata, overwrite=True)
                metadata_sources.append("cache")
                # Sources spell issuers and underlyings differently; a product
                # keeps the names it was first stored with.
                cached_names = {field: None for field in NAME_FIELDS if getattr(cached_metadata, field)}
                
            if cached_greek is not None:
                _merge_greek(enriched, cached_greek, overwrite=True)
                greek_sources.append("cache")

            # Live knock-out barriers and factor reset levels can move even
            # when every cached field is present. Refresh once, then stop as
            # soon as the fields relevant to this product type are complete.
            if _needs_product_fallback(enriched) or enriched.get("product_type") in ("open_end_turbo", "knock_out", "factor_certificate"):
                # The first source that answers may replace cached values; the
                # ones after it only fill what is still missing. Judging this by
                # whether the first answer changed anything would hand the right
                # to overwrite to the second source whenever the first one
                # merely confirmed the cache.
                first_answer = True
                live_reset_received = False
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
                    if metadata_to_merge is not None and cached_names:
                        metadata_to_merge = metadata_to_merge.model_copy(update=cached_names)

                    # Frankfurt does not publish a factor reset level. A cached
                    # one must not prevent its actual source from renewing it.
                    reset_changed = False
                    if enriched.get("product_type") == "factor_certificate" and not live_reset_received and metadata_to_merge.reset_barrier is not None:
                        reset_changed = enriched.get("reset_barrier") != metadata_to_merge.reset_barrier
                        enriched["reset_barrier"] = metadata_to_merge.reset_barrier
                        live_reset_received = True
                    metadata_changed = _merge_metadata(enriched, metadata_to_merge, overwrite=first_answer) or reset_changed
                    first_answer = False
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
                    
                    if not _needs_product_fallback(enriched) and (enriched.get("product_type") != "factor_certificate" or live_reset_received):
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

    async def prioritized_row(index, row):
        token = REQUEST_PRIORITY.set("tier1" if row.get("enrichment_tier") == "tier1" else "background")
        try:
            return index, await process_row(row)
        finally:
            REQUEST_PRIORITY.reset(token)

    # Tier 2 term lookups used to run concurrently and could take the request
    # slots before Tier 1. Complete Tier 1 first, with larger positions first.
    result = [None] * len(rows)
    for tier1 in (True, False):
        batch = [(i, row) for i, row in enumerate(rows) if (row.get("enrichment_tier") == "tier1") == tier1]
        if not preserve_order:
            batch.sort(key=lambda pair: -abs(float(pair[1].get("market_value") or 0)))
        for index, enriched in await asyncio.gather(*(prioritized_row(i, row) for i, row in batch)):
            result[index] = enriched
    return result


def apply_cached_enrichment(rows: list[dict], cache_store: StructuredProductStore) -> list[dict]:
    """Merge previously fetched metadata and greeks without network access.

    Refreshes that skip live providers would otherwise publish rows without
    strike, ratio, expiry or greeks and overwrite the last enriched payload.
    Greeks past the cache lifetime are labelled ``cache_stale``.
    """
    from datetime import datetime, timezone

    enriched_rows = []
    for row in rows:
        enriched = dict(row)
        for field in ("delta", "omega", "theta", "iv"):
            enriched.setdefault(field, None)
        isin = str(enriched.get("isin") or "")
        if not isin:
            enriched_rows.append(enriched)
            continue

        name = enriched.get("instrument") or enriched.get("display_name") or ""
        metadata = cache_store.get_metadata(isin)
        if metadata is not None and not _is_metadata_invalid(metadata, name) and _merge_metadata(enriched, metadata):
            enriched["metadata_source"] = "cache"

        greek = cache_store.get_latest_greek(isin)
        if greek is not None and not _is_greek_invalid(greek, name) and _merge_greek(enriched, greek):
            timestamp = greek.timestamp if greek.timestamp.tzinfo else greek.timestamp.replace(tzinfo=timezone.utc)
            fresh = (datetime.now(timezone.utc) - timestamp).total_seconds() <= GREEK_CACHE_SECONDS
            enriched["greeks_source"] = "cache" if fresh else "cache_stale"

        _clean_invalid_greeks(enriched)
        enriched_rows.append(enriched)
    return enriched_rows


def _should_live_enrich(row: dict, live_enrichment_tier: str | None) -> bool:
    return live_enrichment_tier is None or row.get("enrichment_tier") == live_enrichment_tier


def _has_live_enrichment(row: dict) -> bool:
    return row.get("quote_source") in ("boerse_frankfurt", "onvista") or row.get("metadata_source") not in (None, "")



def _age_seconds(moment) -> float:
    from datetime import datetime, timezone

    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return (datetime.now(timezone.utc) - moment).total_seconds()


def _terms_only(metadata: InstrumentMetadata, row: dict, name: str) -> InstrumentMetadata:
    """The contract terms, without the figures that move with the quote.

    A factor certificate's leverage is its fixed factor and counts as a term.
    """
    product_type = metadata.product_type or row.get("product_type")
    keep_leverage = product_type == "factor_certificate" and not _is_metadata_invalid(metadata, name)
    moving = {"break_even": None, "reset_barrier": None}
    if not keep_leverage:
        moving["leverage"] = None
    return metadata.model_copy(update=moving)


def _terms_missing(row: dict) -> bool:
    product_type = row.get("product_type")
    if product_type == "factor_certificate":
        needed = ("leverage",)
    elif product_type in ("open_end_turbo", "knock_out"):
        needed = ("strike_price", "knockout_price", "ratio")
    else:
        needed = ("strike_price", "ratio", "expiry")
    return any(_is_missing(row.get(field)) for field in needed)


def _needs_product_fallback(row: dict) -> bool:
    # The break-even is left out: consumers derive it from strike, ratio and
    # the current quote, and asking a second source for it alone would double
    # the requests of every refresh.
    product_type = row.get("product_type")
    if product_type == "factor_certificate":
        needed = ("leverage", "reset_barrier")
    elif product_type in ("open_end_turbo", "knock_out"):
        needed = ("strike_price", "knockout_price", "ratio", "leverage")
        if product_type == "knock_out":
            needed += ("expiry",)
    else:
        needed = ("strike_price", "leverage", "ratio", "expiry", "delta", "omega", "theta", "iv")
    return any(
        _is_missing(row.get(field))
        for field in needed
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
