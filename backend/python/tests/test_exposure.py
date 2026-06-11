from agent_foundry_python.structured_products.exposure import compute_delta_exposure
from agent_foundry_python.structured_products.models import Greek, InstrumentMetadata, Position, Quote


def test_compute_delta_exposure_uses_quantity_delta_and_underlying_price():
    position = Position(isin="DE000HM0T297", quantity=12, avg_cost=3.9, source="trade_republic")
    greek = Greek(isin="DE000HM0T297", delta=0.42, omega=1.2, theta=-0.01, iv=0.33)
    quote = Quote(isin="DE000HM0T297", price=4.24, currency="EUR")
    metadata = InstrumentMetadata(isin="DE000HM0T297", product_type="optionsschein", ratio=1.0) # ratio is set so delta_exposure matches 12 * 0.42 * 1.0 * 156.5 = 788.76

    exposure = compute_delta_exposure(position, greek, quote, metadata, underlying_price=156.5)

    assert exposure.isin == "DE000HM0T297"
    assert exposure.delta_exposure == 788.76
    assert exposure.market_value == 50.88
    assert exposure.currency == "EUR"
