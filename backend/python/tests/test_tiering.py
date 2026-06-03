import pytest

from agent_foundry_python.structured_products.agent_foundry import assign_enrichment_tiers
from agent_foundry_python.structured_products.enrichment import ProductData, enrich_structured_product_rows
from agent_foundry_python.structured_products.models import Greek, InstrumentMetadata, Quote


def _row(isin, product_type="optionsschein", asset_class="DERIVATIVE", instrument=None, market_value=1.0):
    return {
        "isin": isin,
        "instrument": instrument or isin,
        "product_type": product_type,
        "asset_class": asset_class,
        "quote_price": 1.0,
        "quote_source": "rust_portfolio_summary",
        "market_value": market_value,
    }


def test_assign_enrichment_tiers_caps_tier1_at_20_groups_and_routes_remaining_structured_products_to_tier2():
    rows = [_row(f"DE000TIER{i:03d}") for i in range(25)]

    tiered = assign_enrichment_tiers(rows, tier1_limit=20)

    assert [row["enrichment_tier"] for row in tiered[:20]] == ["tier1"] * 20
    assert [row["live_enrichment_enabled"] for row in tiered[:20]] == [True] * 20
    assert [row["enrichment_tier"] for row in tiered[20:]] == ["tier2"] * 5
    assert [row["live_enrichment_enabled"] for row in tiered[20:]] == [False] * 5


def test_assign_enrichment_tiers_uses_group_market_value_and_promotes_whole_group():
    rows = [
        _row("DE000ARM001", instrument="Call 18.06.26 ARM 150", market_value=100.0),
        _row("DE000ARM002", instrument="Call 18.06.26 ARM 170", market_value=90.0),
        _row("DE000NVDA001", instrument="Call 18.06.26 NVIDIA 180", market_value=150.0),
        _row("DE000MSFT001", instrument="Call 18.06.26 Microsoft 500", market_value=120.0),
    ]

    tiered = assign_enrichment_tiers(rows, tier1_limit=2)

    assert [row["enrichment_tier"] for row in tiered] == ["tier1", "tier1", "tier1", "tier2"]
    assert [row["live_enrichment_enabled"] for row in tiered] == [True, True, True, False]


def test_assign_enrichment_tiers_routes_etf_bond_and_non_derivatives_to_tier3():
    rows = [
        _row("ETF001", product_type=None, asset_class="ETF"),
        _row("BOND001", product_type=None, asset_class="BOND"),
        _row("STOCK001", product_type=None, asset_class="EQUITY"),
    ]

    tiered = assign_enrichment_tiers(rows, tier1_limit=20)

    assert [row["enrichment_tier"] for row in tiered] == ["tier3", "tier3", "tier3"]
    assert [row["live_enrichment_enabled"] for row in tiered] == [False, False, False]


class TrackingQuoteProvider:
    def __init__(self):
        self.calls = []

    async def get_quote(self, isin):
        self.calls.append(isin)
        return Quote(isin=isin, price=2.0, currency="EUR")


class TrackingProductProvider:
    def __init__(self):
        self.calls = []

    async def get_product_data(self, isin):
        self.calls.append(isin)
        return ProductData(
            metadata=InstrumentMetadata(isin=isin, leverage=1.5),
            greek=Greek(isin=isin, delta=0.7),
            source="onvista",
        )


@pytest.mark.asyncio
async def test_live_enrichment_only_calls_providers_for_tier1_rows():
    rows = [
        _row("DE000LIVE001") | {"enrichment_tier": "tier1", "live_enrichment_enabled": True},
        _row("DE000SKIP002") | {"enrichment_tier": "tier2", "live_enrichment_enabled": False},
        _row("ETF001", product_type=None, asset_class="ETF") | {"enrichment_tier": "tier3", "live_enrichment_enabled": False},
    ]
    quote_provider = TrackingQuoteProvider()
    product_provider = TrackingProductProvider()

    enriched = await enrich_structured_product_rows(
        rows,
        quote_provider=quote_provider,
        product_providers=[product_provider],
        live_enrichment_tier="tier1",
    )

    assert quote_provider.calls == ["DE000LIVE001"]
    assert product_provider.calls == ["DE000LIVE001"]
    assert enriched[0]["quote_source"] == "boerse_frankfurt"
    assert enriched[0]["live_enrichment_enabled"] is True
    assert enriched[0]["delta"] == 0.7
    assert enriched[1]["quote_source"] == "rust_portfolio_summary"
    assert enriched[1]["live_enrichment_enabled"] is False
    assert enriched[1]["delta"] is None
    assert enriched[2]["quote_source"] == "rust_portfolio_summary"
    assert enriched[2]["live_enrichment_enabled"] is False
