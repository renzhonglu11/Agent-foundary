from __future__ import annotations

from agent_foundry_python.structured_products.models import Exposure, Greek, InstrumentMetadata, Position, Quote


def compute_delta_exposure(
    position: Position,
    greek: Greek,
    quote: Quote,
    metadata: InstrumentMetadata,
    *,
    underlying_price: float,
) -> Exposure:
    """Compute directional exposure for a structured product position."""
    market_value = position.quantity * quote.price
    delta = float(greek.delta or 0.0)
    delta_exposure = 0.0

    direction_sign = -1.0 if metadata.option_type == "put" else 1.0

    if metadata.product_type == "factor_certificate":
        if metadata.leverage is not None and metadata.leverage != 0.0:
            delta_exposure = market_value * metadata.leverage * direction_sign
        elif greek.omega is not None and greek.omega != 0.0:
            omega = greek.omega
            if metadata.option_type == "put" and omega > 0:
                omega = -omega
            delta_exposure = market_value * omega
        else:
            delta_exposure = market_value * direction_sign
    else:
        # Optionscheine, Knock-Outs, Open-End Turbos
        ratio = float(metadata.ratio or 0.0)

        # Enforce correct delta sign based on option type
        if delta != 0.0:
            if metadata.option_type == "put" and delta > 0:
                delta = -delta
            elif metadata.option_type == "call" and delta < 0:
                delta = abs(delta)

        # Priority 1: Delta * Ratio * Underlying
        if delta != 0.0 and ratio > 0.0 and underlying_price > 0.0:
            delta_exposure = position.quantity * delta * ratio * underlying_price
        # Priority 2: Omega
        elif greek.omega is not None and greek.omega != 0.0:
            omega = greek.omega
            if metadata.option_type == "put" and omega > 0:
                omega = -omega
            delta_exposure = market_value * omega
        # Priority 3: Leverage
        elif metadata.leverage is not None and metadata.leverage != 0.0:
            delta_exposure = market_value * metadata.leverage * direction_sign

    return Exposure(
        isin=position.isin,
        quantity=position.quantity,
        delta=delta,
        underlying_price=underlying_price,
        delta_exposure=round(delta_exposure, 2),
        market_value=round(market_value, 2),
        currency=quote.currency,
    )
