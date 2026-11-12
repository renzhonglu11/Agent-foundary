import pytest

from agent_foundry_python.structured_products.enrichment import ProductData, apply_cached_enrichment, enrich_structured_product_rows
from agent_foundry_python.structured_products.models import Greek, InstrumentMetadata, Quote


class FakeQuoteProvider:
    async def get_quote(self, isin):
        if isin == "DE000LIVE001":
            return Quote(isin=isin, price=12.34, currency="EUR", day_high=12.8, day_low=11.9)
        return None


class FakeProductProvider:
    def __init__(self, products):
        self.products = products
        self.calls = []

    async def get_product_data(self, isin):
        self.calls.append(isin)
        return self.products.get(isin)


@pytest.mark.asyncio
async def test_quote_failover_reports_its_actual_source_and_keeps_existing_quote_when_all_fail():
    class Quotes:
        def __init__(self, source, quote): self.source, self.quote, self.calls = source, quote, []
        async def get_quote(self, isin): self.calls.append(isin); return self.quote
    from datetime import datetime, timezone
    at = datetime(2026, 11, 11, 12, tzinfo=timezone.utc)
    primary = Quotes("boerse_frankfurt", None)
    fallback = Quotes("onvista", Quote(isin="DE000TEST001", price=3.5, timestamp=at))
    row = {"isin": "DE000TEST001", "quote_price": 2.0, "quote_source": "rust_portfolio_summary"}
    actual = (await enrich_structured_product_rows([row], quote_provider=primary, quote_fallback_providers=[fallback]))[0]
    assert (actual["quote_price"], actual["quote_source"], actual["quote_timestamp"]) == (3.5, "onvista", at.isoformat())
    assert actual["live_enrichment_enabled"] is True
    primary.quote = fallback.quote
    fallback.calls.clear()
    await enrich_structured_product_rows([row], quote_provider=primary, quote_fallback_providers=[fallback])
    assert fallback.calls == []
    primary.quote = fallback.quote = None
    actual = (await enrich_structured_product_rows([row], quote_provider=primary, quote_fallback_providers=[fallback]))[0]
    assert (actual["quote_price"], actual["quote_source"]) == (2.0, "rust_portfolio_summary")


@pytest.mark.asyncio
async def test_enrich_rows_uses_finanzen_first_onvista_fallback_and_boerse_quote():
    rows = [
        {
            "isin": "DE000LIVE001",
            "display_name": "TurboC O.End Micron",
            "issuer": "HSBC",
            "instrument": "TurboC O.End Micron",
            "asset_class": "DERIVATIVE",
            "product_type": "open_end_turbo",
            "quantity": 10,
            "avg_cost": 1.0,
            "cost_basis": 10.0,
            "quote_price": 9.99,
            "quote_currency": "EUR",
            "quote_source": "rust_portfolio_summary",
            "market_value": 99.9,
            "last_trade_date": "2026-05-15",
            "source_generated_at": "2026-05-18T12:00:00Z",
        },
        {
            "isin": "DE000FALLBACK",
            "display_name": "Call Optionsschein Intel",
            "issuer": "SG",
            "instrument": "Call Intel",
            "asset_class": "DERIVATIVE",
            "product_type": "optionsschein",
            "quantity": 5,
            "avg_cost": 2.0,
            "cost_basis": 10.0,
            "quote_price": 2.5,
            "quote_currency": "EUR",
            "quote_source": "rust_portfolio_summary",
            "market_value": 12.5,
            "last_trade_date": "2026-05-15",
            "source_generated_at": "2026-05-18T12:00:00Z",
        },
    ]
    finanzen = FakeProductProvider(
        {
            "DE000LIVE001": ProductData(
                metadata=InstrumentMetadata(isin="DE000LIVE001", leverage=3.2, underlying="Micron"),
                greek=Greek(isin="DE000LIVE001", delta=0.88, omega=2.7),
                source="finanzen.net",
            )
        }
    )
    onvista = FakeProductProvider(
        {
            "DE000FALLBACK": ProductData(
                metadata=InstrumentMetadata(isin="DE000FALLBACK", leverage=1.7, underlying="Intel"),
                greek=None,
                source="onvista",
            )
        }
    )

    enriched = await enrich_structured_product_rows(
        rows,
        quote_provider=FakeQuoteProvider(),
        product_providers=[finanzen, onvista],
    )

    assert enriched[0]["quote_price"] == 12.34
    assert enriched[0]["quote_source"] == "boerse_frankfurt"
    assert enriched[0]["quote_day_high"] == 12.8
    assert enriched[0]["leverage"] == 3.2
    assert enriched[0]["delta"] == 0.88
    assert enriched[0]["metadata_source"] == "finanzen.net"
    assert enriched[1]["leverage"] == 1.7
    assert enriched[1]["metadata_source"] == "onvista"
    assert enriched[1]["delta"] is None
    assert finanzen.calls == ["DE000LIVE001", "DE000FALLBACK"]
    assert onvista.calls == ["DE000LIVE001", "DE000FALLBACK"]


@pytest.mark.asyncio
async def test_enrich_rows_uses_later_product_provider_to_fill_missing_fields():
    rows = [
        {
            "isin": "DE000PARTIAL",
            "display_name": "Call AMD",
            "issuer": "HSBC",
            "instrument": "Call AMD",
            "asset_class": "DERIVATIVE",
            "product_type": "optionsschein",
            "quantity": 1,
            "quote_price": 30.18,
            "quote_currency": "EUR",
            "quote_source": "rust_portfolio_summary",
            "market_value": 30.18,
        },
    ]
    onvista = FakeProductProvider(
        {
            "DE000PARTIAL": ProductData(
                metadata=InstrumentMetadata(isin="DE000PARTIAL", issuer="HSBC", underlying="AMD", product_type="optionsschein", strike_price=160),
                greek=None,
                source="onvista",
                url="https://www.onvista.de/suche?searchValue=DE000PARTIAL",
            )
        }
    )
    exchange = FakeProductProvider(
        {
            "DE000PARTIAL": ProductData(
                metadata=InstrumentMetadata(isin="DE000PARTIAL", issuer="GS fallback issuer should not replace", underlying="AMD - Advanced Micro Devices", ratio=0.1, expiry="2026-12-18"),
                greek=Greek(isin="DE000PARTIAL", iv=0.614),
                source="boerse_frankfurt",
                url="https://example.test/product/DE000PARTIAL",
            )
        }
    )

    enriched = await enrich_structured_product_rows(rows, product_providers=[onvista, exchange])

    assert enriched[0]["issuer"] == "HSBC"
    assert enriched[0]["underlying"] == "AMD"
    assert enriched[0]["strike_price"] == 160
    assert enriched[0]["ratio"] == 0.1
    assert enriched[0]["expiry"] == "2026-12-18"
    assert enriched[0]["iv"] == 0.614
    assert enriched[0]["metadata_source"] == "onvista+boerse_frankfurt"
    assert enriched[0]["greeks_source"] == "boerse_frankfurt"
    assert enriched[0]["metadata_url"] == "https://example.test/product/DE000PARTIAL"


@pytest.mark.asyncio
async def test_enrich_rows_discards_invalid_greeks_and_falls_back_to_next_provider():
    rows = [
        {
            "isin": "DE000INVALID",
            "display_name": "Call NVIDIA 220",
            "issuer": "Vontobel",
            "instrument": "Call NVIDIA 220",
            "asset_class": "DERIVATIVE",
            "product_type": "optionsschein",
            "quantity": 1,
            "quote_price": 3.21,
            "quote_currency": "EUR",
            "quote_source": "rust_portfolio_summary",
            "market_value": 3.21,
        },
    ]
    onvista = FakeProductProvider(
        {
            "DE000INVALID": ProductData(
                metadata=InstrumentMetadata(isin="DE000INVALID", leverage=-5.0, underlying="NVIDIA"),
                greek=Greek(isin="DE000INVALID", delta=1.0, omega=-18.36),
                source="onvista",
            )
        }
    )
    exchange = FakeProductProvider(
        {
            "DE000INVALID": ProductData(
                metadata=InstrumentMetadata(isin="DE000INVALID", leverage=15.0, underlying="NVIDIA"),
                greek=Greek(isin="DE000INVALID", delta=0.95, omega=18.0),
                source="boerse_frankfurt",
            )
        }
    )

    enriched = await enrich_structured_product_rows(rows, product_providers=[onvista, exchange])

    assert enriched[0]["metadata_source"] == "onvista+boerse_frankfurt"
    assert enriched[0]["greeks_source"] == "boerse_frankfurt"
    assert enriched[0]["leverage"] == 15.0  # fell back because leverage was negative
    assert enriched[0]["delta"] == 0.95     # fell back because omega was negative
    assert enriched[0]["omega"] == 18.0


class FakeCacheStore:
    def __init__(self, metadata=None, greeks=None):
        self.metadata = metadata or {}
        self.greeks = greeks or {}
        self.upserted_metadata = []
        self.inserted_greeks = []

    def get_metadata(self, isin):
        return self.metadata.get(isin)

    def get_latest_greek(self, isin):
        return self.greeks.get(isin)

    def upsert_metadata(self, metadata):
        self.upserted_metadata.append(metadata)

    def insert_greek(self, greek):
        self.inserted_greeks.append(greek)


@pytest.mark.asyncio
async def test_enrich_rows_uses_valid_cached_metadata_and_greeks():
    from datetime import datetime, timezone
    rows = [
        {
            "isin": "DE000CACHED",
            "display_name": "Call NVIDIA 220",
            "issuer": "Vontobel",
            "instrument": "Call NVIDIA 220",
            "asset_class": "DERIVATIVE",
            "product_type": "optionsschein",
            "quantity": 1,
            "quote_price": 3.21,
            "quote_currency": "EUR",
            "quote_source": "rust_portfolio_summary",
            "market_value": 3.21,
        },
    ]
    
    # 5 minutes old greeks (valid) with all fields populated to prevent fallback
    cached_greek = Greek(isin="DE000CACHED", delta=0.9, omega=15.0, theta=-0.01, iv=0.4, timestamp=datetime.now(timezone.utc))
    cached_metadata = InstrumentMetadata(isin="DE000CACHED", strike_price=220.0, leverage=12.0, break_even=230.0, ratio=0.1, expiry="2026-12-18", underlying="NVIDIA")
    
    cache = FakeCacheStore(
        metadata={"DE000CACHED": cached_metadata},
        greeks={"DE000CACHED": cached_greek}
    )
    
    # Provider returns different values but should NOT be called
    onvista = FakeProductProvider({
        "DE000CACHED": ProductData(
            metadata=InstrumentMetadata(isin="DE000CACHED", leverage=9.0, underlying="NVIDIA"),
            greek=Greek(isin="DE000CACHED", delta=0.8, omega=10.0),
            source="onvista",
        )
    })

    enriched = await enrich_structured_product_rows(rows, product_providers=[onvista], cache_store=cache)

    assert enriched[0]["metadata_source"] == "cache"
    assert enriched[0]["greeks_source"] == "cache"
    assert enriched[0]["leverage"] == 12.0
    assert enriched[0]["delta"] == 0.9
    assert enriched[0]["omega"] == 15.0
    # Provider should not be called
    assert not onvista.calls


@pytest.mark.asyncio
async def test_enrich_rows_refreshes_cached_metadata_from_live_provider():
    rows = [
        {
            "isin": "DE000HM0T297",
            "display_name": "TurboC O.End Micron",
            "issuer": "HSBC",
            "instrument": "TurboC O.End Micron",
            "asset_class": "DERIVATIVE",
            "product_type": "open_end_turbo",
            "quantity": 348,
            "quote_price": 6.7,
            "quote_currency": "EUR",
            "quote_source": "rust_portfolio_summary",
            "market_value": 2185.44,
        },
    ]
    cached_metadata = InstrumentMetadata(
        isin="DE000HM0T297",
        leverage=1.20,
        ratio=0.01,
        knockout_price=257.9722,
        underlying="Micron",
        product_type="open_end_turbo",
        option_type="call",
    )
    cache = FakeCacheStore(metadata={"DE000HM0T297": cached_metadata})
    exchange = FakeProductProvider(
        {
            "DE000HM0T297": ProductData(
                metadata=InstrumentMetadata(
                    isin="DE000HM0T297",
                    leverage=1.33,
                    ratio=0.01,
                    knockout_price=257.9722,
                    underlying="Micron",
                    product_type="open_end_turbo",
                    option_type="call",
                ),
                greek=None,
                source="boerse_frankfurt",
                url="https://example.test/product/DE000HM0T297",
            )
        }
    )

    enriched = await enrich_structured_product_rows(rows, product_providers=[exchange], cache_store=cache)

    assert exchange.calls == ["DE000HM0T297"]
    assert enriched[0]["leverage"] == 1.33
    assert enriched[0]["metadata_source"] == "boerse_frankfurt"
    assert enriched[0]["metadata_url"] == "https://example.test/product/DE000HM0T297"
    assert len(cache.upserted_metadata) == 1
    assert cache.upserted_metadata[0].leverage == 1.33


@pytest.mark.asyncio
async def test_enrich_rows_ignores_expired_cached_greeks():
    from datetime import datetime, timedelta, timezone
    rows = [
        {
            "isin": "DE000EXPIRED",
            "display_name": "Call NVIDIA 220",
            "issuer": "Vontobel",
            "instrument": "Call NVIDIA 220",
            "asset_class": "DERIVATIVE",
            "product_type": "optionsschein",
            "quantity": 1,
            "quote_price": 3.21,
            "quote_currency": "EUR",
            "quote_source": "rust_portfolio_summary",
            "market_value": 3.21,
        },
    ]
    
    # 2 hours old greeks (expired)
    expired_time = datetime.now(timezone.utc) - timedelta(hours=2)
    cached_greek = Greek(isin="DE000EXPIRED", delta=0.9, omega=15.0, timestamp=expired_time)
    cached_metadata = InstrumentMetadata(isin="DE000EXPIRED", leverage=12.0, underlying="NVIDIA")
    
    cache = FakeCacheStore(
        metadata={"DE000EXPIRED": cached_metadata},
        greeks={"DE000EXPIRED": cached_greek}
    )
    
    # Provider should be called to fetch new greeks, but metadata is still loaded from cache
    onvista = FakeProductProvider({
        "DE000EXPIRED": ProductData(
            metadata=InstrumentMetadata(isin="DE000EXPIRED", leverage=12.0, underlying="NVIDIA"),
            greek=Greek(isin="DE000EXPIRED", delta=0.8, omega=10.0),
            source="onvista",
        )
    })

    enriched = await enrich_structured_product_rows(rows, product_providers=[onvista], cache_store=cache)

    assert enriched[0]["metadata_source"] == "cache"  # loaded from cache
    assert enriched[0]["greeks_source"] == "onvista"  # loaded from provider because cache was expired
    assert enriched[0]["leverage"] == 12.0
    assert enriched[0]["delta"] == 0.8
    assert enriched[0]["omega"] == 10.0
    # Provider was called
    assert onvista.calls == ["DE000EXPIRED"]
    # New greeks should be saved back to cache
    assert len(cache.inserted_greeks) == 1
    assert cache.inserted_greeks[0].omega == 10.0
    # Metadata was not changed/fetched, so not saved back
    assert len(cache.upserted_metadata) == 0


@pytest.mark.asyncio
async def test_enrich_rows_uses_expired_cached_greeks_as_stale_fallback():
    from datetime import datetime, timedelta, timezone
    rows = [
        {
            "isin": "DE000STALE",
            "display_name": "Call NVIDIA 220",
            "issuer": "Vontobel",
            "instrument": "Call NVIDIA 220",
            "asset_class": "DERIVATIVE",
            "product_type": "optionsschein",
            "quantity": 1,
            "quote_price": 3.21,
            "quote_currency": "EUR",
            "quote_source": "rust_portfolio_summary",
            "market_value": 3.21,
        },
    ]

    expired_time = datetime.now(timezone.utc) - timedelta(hours=2)
    cached_greek = Greek(isin="DE000STALE", delta=0.9, omega=15.0, iv=0.4, timestamp=expired_time)
    cached_metadata = InstrumentMetadata(isin="DE000STALE", leverage=12.0, underlying="NVIDIA")

    cache = FakeCacheStore(
        metadata={"DE000STALE": cached_metadata},
        greeks={"DE000STALE": cached_greek}
    )
    provider = FakeProductProvider({})

    enriched = await enrich_structured_product_rows(rows, product_providers=[provider], cache_store=cache)

    assert provider.calls == ["DE000STALE"]
    assert enriched[0]["metadata_source"] == "cache"
    assert enriched[0]["greeks_source"] == "cache_stale"
    assert enriched[0]["delta"] == 0.9
    assert enriched[0]["omega"] == 15.0
    assert enriched[0]["iv"] == 0.4
    assert len(cache.inserted_greeks) == 0


@pytest.mark.asyncio
async def test_enrich_rows_treats_fresh_incomplete_cached_greeks_as_stale_fallback():
    from datetime import datetime, timezone

    rows = [
        {
            "isin": "DE000INCOMPLETE",
            "display_name": "Call NVIDIA 220",
            "instrument": "Call NVIDIA 220",
            "product_type": "optionsschein",
            "quantity": 1,
            "quote_price": 3.21,
            "quote_currency": "EUR",
            "market_value": 3.21,
        },
    ]
    cached_greek = Greek(
        isin="DE000INCOMPLETE",
        delta=0.9,
        omega=15.0,
        iv=0.4,
        timestamp=datetime.now(timezone.utc),
    )
    cached_metadata = InstrumentMetadata(
        isin="DE000INCOMPLETE",
        leverage=12.0,
        break_even=230.0,
        ratio=0.1,
        expiry="2026-12-18",
        underlying="NVIDIA",
    )
    cache = FakeCacheStore(
        metadata={"DE000INCOMPLETE": cached_metadata},
        greeks={"DE000INCOMPLETE": cached_greek},
    )

    enriched = await enrich_structured_product_rows(rows, cache_store=cache)

    assert enriched[0]["metadata_source"] == "cache"
    assert enriched[0]["greeks_source"] == "cache_stale"
    assert enriched[0]["delta"] == 0.9
    assert enriched[0]["omega"] == 15.0
    assert enriched[0]["iv"] == 0.4
    assert len(cache.inserted_greeks) == 0


def test_apply_cached_enrichment_restores_metadata_and_greeks_without_network():
    from datetime import datetime, timedelta, timezone
    base = {
        "asset_class": "DERIVATIVE",
        "product_type": "optionsschein",
        "quantity": 1,
        "quote_price": 3.21,
        "quote_source": "rust_portfolio_summary",
        "leverage": None,
        "strike_price": None,
        "ratio": None,
        "expiry": None,
        "delta": None,
    }
    rows = [
        {**base, "isin": "DE000FRESH", "instrument": "Call NVIDIA 220"},
        {**base, "isin": "DE000OLD", "instrument": "Call NVIDIA 240"},
        {**base, "isin": "DE000BADPUT", "instrument": "Put NVIDIA 180"},
        {**base, "isin": "DE000NONE", "instrument": "Call NVIDIA 260"},
    ]
    now = datetime.now(timezone.utc)
    cache = FakeCacheStore(
        metadata={
            "DE000FRESH": InstrumentMetadata(isin="DE000FRESH", strike_price=220.0, ratio=0.1, expiry="2026-12-18"),
            "DE000OLD": InstrumentMetadata(isin="DE000OLD", strike_price=240.0, ratio=0.1),
        },
        greeks={
            "DE000FRESH": Greek(isin="DE000FRESH", delta=0.6, omega=8.0, theta=-0.01, iv=0.5, timestamp=now),
            "DE000OLD": Greek(isin="DE000OLD", delta=0.4, iv=0.55, timestamp=now - timedelta(days=3)),
            "DE000BADPUT": Greek(isin="DE000BADPUT", delta=0.3, timestamp=now),
        },
    )

    fresh, old, bad_put, missing = apply_cached_enrichment(rows, cache)

    assert (fresh["strike_price"], fresh["ratio"], fresh["expiry"], fresh["delta"]) == (220.0, 0.1, "2026-12-18", 0.6)
    assert (fresh["metadata_source"], fresh["greeks_source"]) == ("cache", "cache")
    assert (old["strike_price"], old["delta"], old["greeks_source"]) == (240.0, 0.4, "cache_stale")
    assert bad_put["delta"] is None and "greeks_source" not in bad_put
    assert missing["delta"] is None and "metadata_source" not in missing
    assert all(row["quote_source"] == "rust_portfolio_summary" for row in (fresh, old, bad_put, missing))
    assert not cache.upserted_metadata and not cache.inserted_greeks


def _warrant_row(isin="DE000VY42C94"):
    return {
        "isin": isin,
        "display_name": "Call 17.06.27 Zscaler 180",
        "instrument": "Call 17.06.27 Zscaler 180",
        "asset_class": "DERIVATIVE",
        "product_type": "optionsschein",
        "quantity": 100,
        "quote_price": 4.6,
        "quote_currency": "EUR",
        "quote_source": "rust_portfolio_summary",
        "market_value": 460.0,
    }


@pytest.mark.asyncio
async def test_a_complete_first_source_spares_the_second_one_the_request():
    exchange = FakeProductProvider(
        {
            "DE000VY42C94": ProductData(
                metadata=InstrumentMetadata(
                    isin="DE000VY42C94", leverage=3.84, strike_price=180.0, ratio=0.1, expiry="2027-06-17", option_type="call"
                ),
                greek=Greek(isin="DE000VY42C94", delta=0.65, omega=2.5, theta=-0.0087, iv=0.835),
                source="boerse_frankfurt",
            )
        }
    )
    onvista = FakeProductProvider({})

    enriched = await enrich_structured_product_rows([_warrant_row()], product_providers=[exchange, onvista])

    # No source stated a break-even, and that alone is no reason to ask another.
    assert enriched[0].get("break_even") is None
    assert enriched[0]["greeks_source"] == "boerse_frankfurt"
    assert exchange.calls == ["DE000VY42C94"]
    assert onvista.calls == []


@pytest.mark.asyncio
async def test_a_stored_break_even_is_not_served_and_stored_names_are_kept():
    cache = FakeCacheStore(
        metadata={
            "DE000VY42C94": InstrumentMetadata(
                isin="DE000VY42C94",
                issuer="Vontobel",
                underlying="Zscaler",
                leverage=3.2,
                break_even=231.36,
                strike_price=180.0,
                ratio=0.1,
                expiry="2027-06-17",
            )
        }
    )
    exchange = FakeProductProvider(
        {
            "DE000VY42C94": ProductData(
                metadata=InstrumentMetadata(
                    isin="DE000VY42C94",
                    issuer="Bank Vontobel Europe AG",
                    underlying="Zscaler Inc",
                    leverage=3.84,
                    strike_price=180.0,
                    ratio=0.1,
                    expiry="2027-06-17",
                ),
                greek=Greek(isin="DE000VY42C94", delta=0.65, omega=2.5, theta=-0.0087, iv=0.835),
                source="boerse_frankfurt",
            )
        }
    )

    enriched = await enrich_structured_product_rows([_warrant_row()], product_providers=[exchange], cache_store=cache)

    row = enriched[0]
    # Yesterday's break-even would be wrong at today's quote.
    assert row.get("break_even") is None
    # The quote-dependent leverage is refreshed, the names are not rewritten.
    assert row["leverage"] == 3.84
    assert (row["issuer"], row["underlying"]) == ("Vontobel", "Zscaler")
    assert cache.upserted_metadata[0].underlying == "Zscaler"


@pytest.mark.asyncio
async def test_a_product_without_stored_names_takes_them_from_the_source():
    exchange = FakeProductProvider(
        {
            "DE000VY42C94": ProductData(
                metadata=InstrumentMetadata(isin="DE000VY42C94", issuer="Vontobel", underlying="Zscaler", leverage=3.84, ratio=0.1, expiry="2027-06-17"),
                greek=Greek(isin="DE000VY42C94", delta=0.65, omega=2.5, theta=-0.0087, iv=0.835),
                source="boerse_frankfurt",
            )
        }
    )

    enriched = await enrich_structured_product_rows([_warrant_row()], product_providers=[exchange], cache_store=FakeCacheStore())

    assert (enriched[0]["issuer"], enriched[0]["underlying"]) == ("Vontobel", "Zscaler")


def _complete_product(source="boerse_frankfurt", delta=0.65):
    return ProductData(
        metadata=InstrumentMetadata(isin="DE000VY42C94", leverage=3.84, strike_price=180.0, ratio=0.1, expiry="2027-06-17"),
        greek=Greek(isin="DE000VY42C94", delta=delta, omega=2.5, theta=-0.0087, iv=0.835),
        source=source,
    )


@pytest.mark.asyncio
async def test_greeks_from_the_previous_hourly_run_are_fetched_again():
    from datetime import datetime, timedelta, timezone

    metadata = InstrumentMetadata(isin="DE000VY42C94", leverage=3.2, strike_price=180.0, ratio=0.1, expiry="2027-06-17")

    async def run(age_minutes):
        stored = Greek(
            isin="DE000VY42C94", delta=0.5, omega=2.0, theta=-0.01, iv=0.8,
            timestamp=datetime.now(timezone.utc) - timedelta(minutes=age_minutes),
        )
        cache = FakeCacheStore(metadata={"DE000VY42C94": metadata}, greeks={"DE000VY42C94": stored})
        exchange = FakeProductProvider({"DE000VY42C94": _complete_product()})
        rows = await enrich_structured_product_rows([_warrant_row()], product_providers=[exchange], cache_store=cache)
        return rows[0], exchange.calls

    # A second refresh a few minutes later reuses what was just fetched.
    row, calls = await run(10)
    assert (row["delta"], row["greeks_source"], calls) == (0.5, "cache", [])
    # An hourly run finds Greeks 59 minutes old; they must not count as current.
    row, calls = await run(59)
    assert (row["delta"], row["greeks_source"], calls) == (0.65, "boerse_frankfurt", ["DE000VY42C94"])


class RememberingCacheStore(FakeCacheStore):
    def upsert_metadata(self, metadata):
        super().upsert_metadata(metadata)
        self.metadata[metadata.isin] = metadata


def _outside_live_tier(**changes):
    return {**_warrant_row(), "enrichment_tier": "tier2", **changes}


@pytest.mark.asyncio
async def test_a_product_outside_the_live_tier_gets_its_terms_once_a_day():
    from datetime import datetime, timedelta, timezone

    cache = RememberingCacheStore()
    exchange = FakeProductProvider({"DE000VY42C94": _complete_product()})
    quotes = FakeQuoteProvider()

    async def run():
        rows = await enrich_structured_product_rows(
            [_outside_live_tier()], quote_provider=quotes, product_providers=[exchange],
            cache_store=cache, live_enrichment_tier="tier1",
        )
        return rows[0]

    row = await run()
    # The fixed terms arrive; nothing that moves with the quote does.
    assert (row["strike_price"], row["ratio"], row["expiry"]) == (180.0, 0.1, "2027-06-17")
    assert row.get("leverage") is None and row["delta"] is None and row.get("greeks_source") is None
    assert (row["metadata_source"], row["live_enrichment_enabled"]) == ("boerse_frankfurt", False)
    assert exchange.calls == ["DE000VY42C94"]

    # The next hourly run reads the terms from the cache and asks nobody.
    row = await run()
    assert (row["strike_price"], row["metadata_source"]) == (180.0, "cache")
    assert exchange.calls == ["DE000VY42C94"]

    # A day later the terms are renewed.
    cache.metadata["DE000VY42C94"] = cache.metadata["DE000VY42C94"].model_copy(
        update={"last_updated": datetime.now(timezone.utc) - timedelta(hours=25)}
    )
    await run()
    assert exchange.calls == ["DE000VY42C94", "DE000VY42C94"]


@pytest.mark.asyncio
async def test_daily_terms_follow_a_knock_out_keep_a_factor_and_remember_a_miss():
    from datetime import datetime, timedelta, timezone

    day_old = datetime.now(timezone.utc) - timedelta(hours=25)
    cache = RememberingCacheStore(
        metadata={
            "DE000TURBO01": InstrumentMetadata(
                isin="DE000TURBO01", issuer="HSBC", underlying="Micron", product_type="open_end_turbo",
                strike_price=265.0, knockout_price=265.0, ratio=0.01, leverage=1.5, last_updated=day_old,
            )
        }
    )
    exchange = FakeProductProvider(
        {
            "DE000TURBO01": ProductData(
                metadata=InstrumentMetadata(
                    isin="DE000TURBO01", issuer="HSBC Trinkaus & Burkhardt GmbH", underlying="Micron Technology Inc",
                    product_type="open_end_turbo", strike_price=265.8, knockout_price=265.8, ratio=0.01, leverage=1.42,
                ),
                source="boerse_frankfurt",
            ),
            "DE000FACTOR1": ProductData(
                metadata=InstrumentMetadata(isin="DE000FACTOR1", product_type="factor_certificate", leverage=2.0, reset_barrier=33.9),
                source="boerse_frankfurt",
            ),
        }
    )
    rows = [
        _outside_live_tier(isin="DE000TURBO01", display_name="TurboC O.End Micron", instrument="TurboC O.End Micron", product_type="open_end_turbo"),
        _outside_live_tier(isin="DE000FACTOR1", display_name="FaktL O.End GlobalF", instrument="FaktL O.End GlobalF", product_type="factor_certificate"),
        _outside_live_tier(isin="DE000UNKNOWN", display_name="Call 17.06.27 Nobody 10", instrument="Call 17.06.27 Nobody 10"),
    ]

    async def run():
        return await enrich_structured_product_rows(rows, product_providers=[exchange], cache_store=cache, live_enrichment_tier="tier1")

    turbo, factor, unknown = await run()
    # An open-end knock-out's strike and barrier move every day; its names stay as stored.
    assert (turbo["strike_price"], turbo["knockout_price"]) == (265.8, 265.8)
    assert (turbo["issuer"], turbo["underlying"]) == ("HSBC", "Micron")
    # Its leverage moves with the quote and is not kept for a product nobody refreshes hourly.
    assert turbo.get("leverage") is None
    # A factor certificate's leverage is its fixed factor; its reset barrier moves.
    assert (factor["leverage"], factor.get("reset_barrier")) == (2.0, None)
    assert unknown.get("strike_price") is None and unknown.get("metadata_source") is None
    assert sorted(exchange.calls) == ["DE000FACTOR1", "DE000TURBO01", "DE000UNKNOWN"]

    # The product no source knew is not asked about again on the next run.
    await run()
    assert len(exchange.calls) == 3


@pytest.mark.asyncio
async def test_a_second_source_never_overrides_the_first_one_that_answered():
    cached = InstrumentMetadata(
        isin="DE000TURBO01", product_type="open_end_turbo", strike_price=265.8, knockout_price=265.8, leverage=1.51
    )
    confirming = ProductData(metadata=cached.model_copy(), source="boerse_frankfurt")
    disagreeing = ProductData(
        metadata=InstrumentMetadata(
            isin="DE000TURBO01", product_type="knock_out", strike_price=265.8, knockout_price=265.8, ratio=0.01,
            leverage=1.42, reset_barrier=250.0,
        ),
        source="onvista",
    )
    row = {**_warrant_row("DE000TURBO01"), "display_name": "TurboC O.End Micron", "instrument": "TurboC O.End Micron", "product_type": "open_end_turbo"}

    enriched = await enrich_structured_product_rows(
        [row],
        product_providers=[FakeProductProvider({"DE000TURBO01": confirming}), FakeProductProvider({"DE000TURBO01": disagreeing})],
        cache_store=FakeCacheStore(metadata={"DE000TURBO01": cached}),
    )

    # The first source only confirmed the cache; that does not let the second one rewrite it.
    assert (enriched[0]["product_type"], enriched[0]["leverage"]) == ("open_end_turbo", 1.51)
    # The missing ratio triggers fallback; it still supplies what nobody had.
    assert enriched[0]["ratio"] == 0.01
    assert enriched[0]["reset_barrier"] == 250.0


@pytest.mark.asyncio
async def test_complete_open_end_products_refresh_moving_terms_without_searching_for_nonexistent_greeks():
    isin = "DE000TURBO01"
    cached = InstrumentMetadata(isin=isin, product_type="open_end_turbo", strike_price=100, knockout_price=100, ratio=0.01, leverage=2)
    first = FakeProductProvider({isin: ProductData(metadata=cached.model_copy(update={"strike_price": 101, "knockout_price": 101}), source="boerse_frankfurt")})
    fallback = FakeProductProvider({})
    actual = (await enrich_structured_product_rows(
        [{**_warrant_row(isin), "product_type": "open_end_turbo"}], product_providers=[first, fallback],
        cache_store=FakeCacheStore(metadata={isin: cached}),
    ))[0]
    assert first.calls == [isin] and fallback.calls == []
    assert actual["knockout_price"] == 101 and actual["delta"] is None


@pytest.mark.asyncio
async def test_factor_reset_is_renewed_even_when_the_first_source_confirms_other_cached_terms():
    isin = "DE000FACTOR1"
    cached = InstrumentMetadata(isin=isin, product_type="factor_certificate", leverage=2, reset_barrier=100)
    first = FakeProductProvider({isin: ProductData(metadata=cached.model_copy(update={"reset_barrier": None}), source="boerse_frankfurt")})
    fallback = FakeProductProvider({isin: ProductData(metadata=cached.model_copy(update={"leverage": 12, "reset_barrier": 101}), source="onvista")})
    actual = (await enrich_structured_product_rows(
        [{**_warrant_row(isin), "product_type": "factor_certificate"}], product_providers=[first, fallback],
        cache_store=FakeCacheStore(metadata={isin: cached}),
    ))[0]
    assert fallback.calls == [isin]
    assert (actual["leverage"], actual["reset_barrier"]) == (2, 101)
