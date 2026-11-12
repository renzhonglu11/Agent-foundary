import asyncio
import sqlite3
from datetime import datetime, timezone

import pytest

from agent_foundry_python.structured_products import refresh_scheduler as scheduler
from agent_foundry_python.structured_products.enrichment import ProductData
from agent_foundry_python.structured_products.models import Greek, InstrumentMetadata, Quote
from agent_foundry_python.structured_products.providers.refusal import REQUEST_PRIORITY
from agent_foundry_python.structured_products.storage import StructuredProductStore
from agent_foundry_python.structured_products.agent_foundry import write_structured_product_rows_outputs


class Provider:
    source = "boerse_frankfurt"

    def __init__(self):
        self.calls = []
        self.fail_secondary = False

    async def get_quote(self, isin):
        self.calls.append((isin, "quote", REQUEST_PRIORITY.get()))
        await asyncio.sleep(0)
        if self.fail_secondary and isin.startswith("S"):
            return None
        return Quote(isin=isin, price=12.0, currency="EUR", timestamp=datetime(2026, 11, 12, 10, tzinfo=timezone.utc))

    async def get_product_data(self, isin):
        self.calls.append((isin, "terms", REQUEST_PRIORITY.get()))
        await asyncio.sleep(0)
        if self.fail_secondary and isin.startswith("S"):
            return None
        return ProductData(InstrumentMetadata(isin=isin, product_type="optionsschein", leverage=2, ratio=0.1,
                                              strike_price=100, expiry="2027-12-17"),
                           Greek(isin=isin, delta=0.5, omega=2, theta=-0.01, iv=0.3), self.source)


def row(isin, tier, value=100):
    return dict(isin=isin, instrument="Call example", product_type="optionsschein", enrichment_tier=tier,
                quote_source="rust_portfolio_summary", quote_price=9, quote_currency="EUR", quantity=10, avg_cost=8, market_value=value)


async def run(rows, store, provider, **kwargs):
    return await scheduler.refresh_with_tiers(rows, cache_store=store, tier2_sources=["boerse_frankfurt"],
                                             quote_provider=provider, product_providers=[provider],
                                             live_enrichment_tier="tier1", **kwargs)


@pytest.mark.asyncio
async def test_tier1_completes_before_tier2_and_progress_does_not_reset(tmp_path):
    store = StructuredProductStore(tmp_path / "db")
    provider = Provider()
    rows = [row("S1", "tier2", 1000), row("P1", "tier1", 100), row("P2", "tier1", 200)]
    progress = []
    result = await run(rows, store, provider, progress_callback=progress.append)
    calls = provider.calls
    assert calls[0][0] == "P2"
    first_secondary = next(i for i, call in enumerate(calls) if call[0] == "S1")
    assert all(call[0] != "S1" for call in calls[:first_secondary])
    assert all(call[0] == "S1" for call in calls[first_secondary:])
    assert all(p == ("background" if isin == "S1" else "tier1") for isin, _, p in calls)
    assert [r["isin"] for r in result] == [r["isin"] for r in rows]
    assert result[0]["enrichment_tier"] == "tier2"
    assert [e["current"] for e in progress] == sorted(e["current"] for e in progress)
    assert all(e["total"] == 3 for e in progress)
    assert progress[-1]["current"] == 3


@pytest.mark.asyncio
async def test_secondary_interval_survives_restart_and_preserves_quote_without_old_position_size(tmp_path, monkeypatch):
    clock = [100_000.0]
    monkeypatch.setattr(scheduler.time, "time", lambda: clock[0])
    path = tmp_path / "db"
    provider = Provider()
    rows = [row("P1", "tier1"), row("S1", "tier2")]
    first = await run(rows, StructuredProductStore(path), provider)
    assert first[1]["quote_price"] == 12
    count = len([c for c in provider.calls if c[0] == "S1"])
    rows[1]["quantity"] = 7
    second = await run(rows, StructuredProductStore(path), provider)
    assert len([c for c in provider.calls if c[0] == "S1"]) == count
    assert second[1]["quantity"] == 7 and second[1]["quote_price"] == 12
    assert second[1]["quote_timestamp"] == first[1]["quote_timestamp"]
    assert second[1]["enrichment_refresh_state"] == "interval_wait"
    clock[0] += 7200
    provider.fail_secondary = True
    third = await run(rows, StructuredProductStore(path), provider)
    assert len([c for c in provider.calls if c[0] == "S1"]) > count
    assert third[1]["quote_price"] == 12 and third[1]["quote_timestamp"] == first[1]["quote_timestamp"]
    count = len(provider.calls)
    await run([rows[1]], StructuredProductStore(path), provider)
    assert len(provider.calls) == count  # failed attempts also obey cadence


@pytest.mark.asyncio
async def test_secondary_never_falls_back_to_a_source_outside_allowlist(tmp_path):
    primary = Provider()
    primary.fail_secondary = True
    excluded = Provider()
    excluded.source = "onvista"
    await scheduler.refresh_with_tiers([row("S1", "tier2")], cache_store=StructuredProductStore(tmp_path / "db"),
                                      tier2_sources=["boerse_frankfurt"], live_enrichment_tier="tier1",
                                      quote_provider=primary, quote_fallback_providers=[excluded],
                                      product_providers=[primary, excluded])
    assert primary.calls and not excluded.calls


@pytest.mark.asyncio
async def test_no_opt_in_keeps_daily_terms_but_they_run_after_tier1(tmp_path):
    provider = Provider()
    result = await scheduler.refresh_with_tiers([row("S1", "tier2"), row("P1", "tier1")],
                                               cache_store=StructuredProductStore(tmp_path / "db"),
                                               quote_provider=provider, product_providers=[provider],
                                               live_enrichment_tier="tier1")
    assert provider.calls[-1] == ("S1", "terms", "background")
    assert not result[0]["live_enrichment_enabled"]
    assert result[0]["quote_price"] == 9


@pytest.mark.asyncio
async def test_secondary_near_expiry_then_larger_positions_first(tmp_path):
    provider = Provider()
    urgent = row("S3", "tier2", 1)
    urgent["expiry"] = datetime.now(timezone.utc).date().isoformat()
    await run([row("S1", "tier2", 50), row("S2", "tier2", 100), urgent],
              StructuredProductStore(tmp_path / "db"), provider, max_concurrency=1)
    assert [isin for isin, kind, _ in provider.calls if kind == "quote"] == ["S3", "S2", "S1"]


@pytest.mark.asyncio
async def test_export_of_cached_or_budget_deferred_rows_cannot_renew_data_timestamps(tmp_path):
    path = tmp_path / "db"
    store = StructuredProductStore(path)
    provider = Provider()
    rows = [row("S1", "tier2")]
    result = await run(rows, store, provider)
    greek_time = store.get_latest_greek("S1").timestamp
    metadata_time = store.get_metadata("S1").last_updated
    for _ in range(2):
        write_structured_product_rows_outputs(result, csv_path=tmp_path / "out.csv", json_path=tmp_path / "out.json",
                                               db_path=path, market_data_already_persisted=True)
        result = await run(rows, StructuredProductStore(path), provider)
    assert store.get_latest_greek("S1").timestamp == greek_time
    assert store.get_metadata("S1").last_updated == metadata_time
    with sqlite3.connect(path) as db:
        assert db.execute("SELECT COUNT(*) FROM greeks WHERE isin='S1'").fetchone()[0] == 1
        assert db.execute("SELECT COUNT(*),MIN(timestamp) FROM quotes WHERE isin='S1'").fetchone() == (1, "2026-11-12T10:00:00+00:00")


@pytest.mark.asyncio
async def test_invalid_source_and_shortened_interval_fail_before_any_requests(tmp_path):
    provider = Provider()
    for overrides in [{"tier2_sources": ["unknown"]}, {"tier2_sources": ["boerse_frankfurt"], "tier2_interval_seconds": 60}]:
        with pytest.raises(ValueError):
            await scheduler.refresh_with_tiers([row("S1", "tier2")], cache_store=StructuredProductStore(tmp_path / "db"),
                                              quote_provider=provider, product_providers=[provider], **overrides)
    assert not provider.calls
