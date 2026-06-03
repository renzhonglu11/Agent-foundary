import pytest

from agent_foundry_python.structured_products.enrichment import ProductData, enrich_structured_product_rows
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
    gs_de = FakeProductProvider(
        {
            "DE000PARTIAL": ProductData(
                metadata=InstrumentMetadata(isin="DE000PARTIAL", issuer="GS fallback issuer should not replace", underlying="AMD - Advanced Micro Devices", ratio=0.1, expiry="2026-12-18"),
                greek=Greek(isin="DE000PARTIAL", iv=0.614),
                source="gs.de",
                url="https://www.gs.de/de/optionsschein-rechner?isin=DE000PARTIAL",
            )
        }
    )

    enriched = await enrich_structured_product_rows(rows, product_providers=[onvista, gs_de])

    assert enriched[0]["issuer"] == "HSBC"
    assert enriched[0]["underlying"] == "AMD"
    assert enriched[0]["strike_price"] == 160
    assert enriched[0]["ratio"] == 0.1
    assert enriched[0]["expiry"] == "2026-12-18"
    assert enriched[0]["iv"] == 0.614
    assert enriched[0]["metadata_source"] == "onvista+gs.de"
    assert enriched[0]["greeks_source"] == "gs.de"
    assert enriched[0]["metadata_url"] == "https://www.gs.de/de/optionsschein-rechner?isin=DE000PARTIAL"
