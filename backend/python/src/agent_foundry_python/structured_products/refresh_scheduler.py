"""Tier 1 first; optional Tier 2 refreshes with a persistent per-product cadence."""
from __future__ import annotations

import json
import math
import sqlite3
import time
from datetime import datetime, timezone

from .enrichment import apply_cached_enrichment, enrich_structured_product_rows

TIER2_SOURCE_NAMES = frozenset({"boerse_frankfurt", "onvista"})
QUOTE_FIELDS = ("quote_price", "quote_currency", "quote_source", "quote_timestamp", "quote_day_high", "quote_day_low")


def _claim(store, isin, interval):
    # Written before work, so process failure or restart cannot trigger a catch-up
    # burst. Each attempted ISIN has its own clock, including failed attempts.
    now = time.time()
    with sqlite3.connect(store.db_path, timeout=5) as db:
        db.execute("BEGIN IMMEDIATE")
        db.execute("INSERT OR IGNORE INTO product_refresh_schedule(isin) VALUES (?)", (isin,))
        row = db.execute(
            "UPDATE product_refresh_schedule SET last_attempt_at=? WHERE isin=? AND (last_attempt_at=0 OR last_attempt_at<=?) RETURNING isin",
            (now, isin, now - interval),
        ).fetchone()
    return row is not None


def _restore_quote(store, row):
    enriched = dict(row)
    with sqlite3.connect(store.db_path) as db:
        cached = db.execute("SELECT quote_json FROM product_refresh_schedule WHERE isin=?", (row.get("isin"),)).fetchone()
    if cached and cached[0]:
        quote = json.loads(cached[0])
        old_time = datetime.fromisoformat(quote["quote_timestamp"])
        current_time = row.get("quote_timestamp")
        # Never copy quantity, cost basis, portfolio value or tier from an older
        # position. Only restore the actual quote, retaining its market time.
        if not current_time or old_time > datetime.fromisoformat(current_time):
            enriched.update({key: quote.get(key) for key in QUOTE_FIELDS})
    return enriched


def _save_quote(store, row, sources):
    price = row.get("quote_price")
    if row.get("quote_source") not in sources or not row.get("quote_timestamp"):
        return
    if not isinstance(price, (int, float)) or not math.isfinite(price) or price < 0:
        return
    with sqlite3.connect(store.db_path) as db:
        db.execute("UPDATE product_refresh_schedule SET quote_json=? WHERE isin=?",
                   (json.dumps({key: row.get(key) for key in QUOTE_FIELDS}), row["isin"]))


def _priority(row, store):
    # Approaching expiry first, then larger positions. This is scheduling, not a
    # trading recommendation; it never promotes a product into the Tier 1 model.
    metadata = store.get_metadata(row["isin"])
    expiry = row.get("expiry") or (metadata.expiry if metadata else None)
    urgent = False
    if expiry:
        try:
            expiry_day = datetime.fromisoformat(str(expiry).replace("Z", "+00:00")).date()
            urgent = 0 <= (expiry_day - datetime.now(timezone.utc).date()).days <= 7
        except ValueError:
            pass
    return not urgent, -abs(float(row.get("market_value") or 0))


async def refresh_with_tiers(rows, *, cache_store, tier2_sources=(), tier2_interval_seconds=7200,
                             progress_callback=None, **kwargs):
    sources = frozenset(tier2_sources)
    if not sources <= TIER2_SOURCE_NAMES:
        raise ValueError("Unknown Tier 2 source; expected boerse_frankfurt and/or onvista")
    if tier2_interval_seconds < 7200:
        raise ValueError("Tier 2 interval must be at least two hours")
    if not sources:
        # Existing Tier 2 daily contract-term refreshes remain background work.
        return await enrich_structured_product_rows(rows, cache_store=cache_store,
                                                    progress_callback=progress_callback, **kwargs)
    if kwargs.get("live_enrichment_tier") != "tier1":
        raise ValueError("Tier 2 scheduling requires the Tier 1 primary refresh")

    secondary = [r for r in rows if r.get("enrichment_tier") == "tier2" and r.get("isin")]
    primary = [r for r in rows if r not in secondary]
    restored = {r["isin"]: _restore_quote(cache_store, r) for r in secondary}
    due = [restored[r["isin"]] for r in sorted(secondary, key=lambda r: _priority(r, cache_store))
           if _claim(cache_store, r["isin"], tier2_interval_seconds)]
    primary_total = sum(r.get("enrichment_tier") == "tier1" for r in primary)
    total = primary_total + len(due)

    def progress(offset):
        def report(event):
            if progress_callback:
                progress_callback({**event, "total": total, "current": offset + event["current"]})
        return report

    results = await enrich_structured_product_rows(primary, cache_store=cache_store,
                                                   progress_callback=progress(0), **kwargs)
    secondary_kwargs = dict(kwargs)
    quotes = ([kwargs.get("quote_provider")] if kwargs.get("quote_provider") else []) + list(kwargs.get("quote_fallback_providers") or [])
    quotes = [p for p in quotes if getattr(p, "source", None) in sources]
    secondary_kwargs.update(
        quote_provider=quotes[0] if quotes else None,
        quote_fallback_providers=quotes[1:],
        product_providers=[p for p in kwargs.get("product_providers", []) if getattr(p, "source", None) in sources],
        live_enrichment_tier=None,
        preserve_order=True,
    )
    # The source allowlist applies to quotes AND metadata/Greeks/fallback calls.
    refreshed = await enrich_structured_product_rows(due, cache_store=cache_store,
                                                     progress_callback=progress(primary_total), **secondary_kwargs)
    for row in refreshed:
        row["enrichment_refresh_state"] = "attempted"
        _save_quote(cache_store, row, sources)
    due_isins = {r["isin"] for r in due}
    cached = apply_cached_enrichment([r for isin, r in restored.items() if isin not in due_isins], cache_store)
    for row in cached:
        row["live_enrichment_enabled"] = True
        row["enrichment_refresh_state"] = "interval_wait"
    by_isin = {r["isin"]: r for r in results + refreshed + cached}
    return [by_isin.get(r.get("isin"), r) for r in rows]
