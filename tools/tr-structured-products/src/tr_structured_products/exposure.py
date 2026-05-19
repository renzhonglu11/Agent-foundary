from __future__ import annotations

from tr_structured_products.models import Exposure, Greek, Position, Quote


def compute_delta_exposure(
    position: Position,
    greek: Greek,
    quote: Quote,
    *,
    underlying_price: float,
) -> Exposure:
    """Compute simple delta exposure for a structured product position.

    Formula from the implementation note:
    Exposure = Quantity × Delta × UnderlyingPrice
    """
    delta = float(greek.delta or 0.0)
    delta_exposure = position.quantity * delta * underlying_price
    market_value = position.quantity * quote.price
    return Exposure(
        isin=position.isin,
        quantity=position.quantity,
        delta=delta,
        underlying_price=underlying_price,
        delta_exposure=round(delta_exposure, 2),
        market_value=round(market_value, 2),
        currency=quote.currency,
    )
