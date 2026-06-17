from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any

from agent_foundry_python.structured_products.agent_foundry import _canonical_group_key, _infer_underlying
from agent_foundry_python.structured_products.exposure import compute_delta_exposure
from agent_foundry_python.structured_products.models import Greek, InstrumentMetadata, Position, Quote

@dataclass
class RiskAction:
    group_action_label: str
    blocked_actions: list[str]
    allowed_actions: list[str]

@dataclass
class RiskLeg:
    isin: str
    product_type: str
    market_value: float
    delta: float | None
    delta_exposure: float
    days_to_expiry: int | None
    barrier_distance_pct: float | None
    quote_age_hours: float | None
    exposure_confidence: str
    data_completeness_risk_score: int
    leg_risk_status: str

@dataclass
class RiskGroup:
    symbol: str
    pre_enrichment_tier: int
    group_market_value: float
    net_equivalent_exposure: float
    gross_equivalent_exposure: float
    net_weight_pct: float
    gross_weight_pct: float
    group_action_label: str
    action: RiskAction
    legs: list[RiskLeg] = field(default_factory=list)


def evaluate_portfolio_risk(
    enriched_rows: list[dict[str, Any]],
    all_positions: list[dict[str, Any]],
    nav: float,
) -> list[dict[str, Any]]:
    # Map group_key to stock_position
    stock_map: dict[str, dict[str, Any]] = {}
    for pos in all_positions:
        asset_class = str(pos.get("assetClass") or pos.get("asset_class") or "").casefold()
        if asset_class in ("stock", "equity"):
            # Try to determine the group key for the stock
            # Usually the stock name or symbol matches the derivative's underlying
            display_name = str(pos.get("displayName") or pos.get("name") or "")
            key = _canonical_group_key(_infer_underlying(display_name))
            stock_map[key] = pos

    # Group the enriched rows (which are already Tier 1 if they have enrichment_tier == "tier1")
    groups_data: dict[str, list[dict[str, Any]]] = {}
    for row in enriched_rows:
        if row.get("enrichment_tier") == "tier1":
            from agent_foundry_python.structured_products.agent_foundry import _structured_product_group_key
            key = _structured_product_group_key(row)
            groups_data.setdefault(key, []).append(row)

    now = datetime.now(timezone.utc)
    risk_reports: list[dict[str, Any]] = []

    for group_key, rows in groups_data.items():
        stock_pos = stock_map.get(group_key, {})
        stock_market_value = _float_or_zero(stock_pos.get("marketValue") or stock_pos.get("market_value"))
        stock_price = _float_or_zero(stock_pos.get("lastPrice") or stock_pos.get("last_price"))

        group_market_value = stock_market_value
        net_exposure_sum = stock_market_value
        gross_exposure_sum = abs(stock_market_value)
        
        legs: list[RiskLeg] = []
        any_hard_blocked = False
        any_days_to_expiry_under_7 = False
        any_barrier_distance_under_5 = False

        for row in rows:
            isin = row.get("isin", "")
            market_value = _float_or_zero(row.get("market_value"))
            group_market_value += market_value

            delta = _optional_float(row.get("delta"))
            
            # Construct models to use compute_delta_exposure
            pos_model = Position(isin=isin, quantity=_float_or_zero(row.get("quantity")), avg_cost=0, source="risk")
            greek_model = Greek(isin=isin, delta=delta, omega=_optional_float(row.get("omega")))
            quote_model = Quote(isin=isin, price=_float_or_zero(row.get("quote_price")), currency=row.get("quote_currency", "EUR"))
            meta_model = InstrumentMetadata(
                isin=isin,
                product_type=row.get("product_type"),
                leverage=_optional_float(row.get("leverage")),
                ratio=_optional_float(row.get("ratio")),
                option_type=row.get("option_type"),
                reset_barrier=_optional_float(row.get("reset_barrier")),
            )
            
            # If we don't have stock price, try to use the derivative's strike/barrier as a proxy or just 0
            underlying_price = stock_price
            
            exposure_result = compute_delta_exposure(
                pos_model, greek_model, quote_model, meta_model, underlying_price=underlying_price
            )
            
            delta_exposure = exposure_result.delta_exposure
            net_exposure_sum += delta_exposure
            gross_exposure_sum += abs(delta_exposure)

            # Days to expiry
            expiry_str = row.get("expiry")
            days_to_expiry = None
            if expiry_str:
                try:
                    expiry_date = datetime.fromisoformat(expiry_str.replace("Z", "+00:00"))
                    if expiry_date.tzinfo is None:
                        expiry_date = expiry_date.replace(tzinfo=timezone.utc)
                    days_to_expiry = (expiry_date - now).days
                    if days_to_expiry < 7:
                        any_days_to_expiry_under_7 = True
                except Exception:
                    pass

            # Barrier Distance
            knockout_price = _optional_float(row.get("knockout_price"))
            barrier_distance_pct = None
            if knockout_price and underlying_price > 0:
                barrier_distance_pct = abs(underlying_price - knockout_price) / underlying_price
                if barrier_distance_pct < 0.05:
                    any_barrier_distance_under_5 = True

            # Quote Age
            quote_timestamp_str = row.get("quote_timestamp")
            quote_age_hours = None
            if quote_timestamp_str:
                try:
                    quote_time = datetime.fromisoformat(quote_timestamp_str.replace("Z", "+00:00"))
                    if quote_time.tzinfo is None:
                        quote_time = quote_time.replace(tzinfo=timezone.utc)
                    quote_age_hours = (now - quote_time).total_seconds() / 3600.0
                except Exception:
                    pass

            # Completeness & Status
            missing_score = _data_completeness_score(
                row,
                product_type=row.get("product_type"),
                delta=delta,
                quote_age_hours=quote_age_hours,
                underlying_price=underlying_price,
                market_value=market_value,
            )
            confidence = _exposure_confidence(
                row,
                product_type=row.get("product_type"),
                delta=delta,
                quote_age_hours=quote_age_hours,
                underlying_price=underlying_price,
                market_value=market_value,
            )
            
            status = "OK"
            if confidence == "no_data" or (days_to_expiry is not None and days_to_expiry <= 0):
                status = "HARD_BLOCKED"
                any_hard_blocked = True
            elif missing_score > 3 or (days_to_expiry is not None and days_to_expiry < 7) or (barrier_distance_pct and barrier_distance_pct < 0.10):
                status = "WATCH"

            legs.append(RiskLeg(
                isin=isin,
                product_type=row.get("product_type", ""),
                market_value=market_value,
                delta=delta,
                delta_exposure=delta_exposure,
                days_to_expiry=days_to_expiry,
                barrier_distance_pct=barrier_distance_pct,
                quote_age_hours=quote_age_hours,
                exposure_confidence=confidence,
                data_completeness_risk_score=missing_score,
                leg_risk_status=status
            ))

        net_weight_pct = net_exposure_sum / nav if nav > 0 else 0.0
        gross_weight_pct = gross_exposure_sum / nav if nav > 0 else 0.0

        # Group Risk Engine
        group_action_label = "HOLD_MONITOR"
        blocked_actions = []
        allowed_actions = ["HOLD", "REDUCE"]

        if gross_weight_pct > 0.20:
            group_action_label = "REDUCE_CONCENTRATION"
            blocked_actions.append("BUY_MORE")
        elif net_weight_pct > 0.15:
            group_action_label = "REDUCE_CONCENTRATION"
            blocked_actions.append("BUY_MORE")
        elif any_hard_blocked:
            group_action_label = "REDUCE_DERIVATIVE_RISK"
            blocked_actions.append("BUY_MORE_DERIVATIVE")
        elif any_days_to_expiry_under_7:
            group_action_label = "CLOSE_OR_ROLL_DERIVATIVE"
            allowed_actions.append("ROLL")
        elif any_barrier_distance_under_5:
            group_action_label = "REDUCE_DERIVATIVE_RISK"
        else:
            group_action_label = "ADD_ALLOWED"
            allowed_actions.append("BUY_MORE")

        action = RiskAction(
            group_action_label=group_action_label,
            blocked_actions=blocked_actions,
            allowed_actions=allowed_actions
        )

        group = RiskGroup(
            symbol=group_key,
            pre_enrichment_tier=1,
            group_market_value=group_market_value,
            net_equivalent_exposure=net_exposure_sum,
            gross_equivalent_exposure=gross_exposure_sum,
            net_weight_pct=net_weight_pct,
            gross_weight_pct=gross_weight_pct,
            group_action_label=group_action_label,
            action=action,
            legs=legs
        )
        
        # Convert to camelCase dict for frontend compatibility
        def to_camel_case(d: dict[str, Any]) -> dict[str, Any]:
            result = {}
            for k, v in d.items():
                camel_key = "".join(word.capitalize() if i > 0 else word for i, word in enumerate(k.split("_")))
                if isinstance(v, dict):
                    result[camel_key] = to_camel_case(v)
                elif isinstance(v, list):
                    result[camel_key] = [to_camel_case(item) if isinstance(item, dict) else item for item in v]
                else:
                    result[camel_key] = v
            return result

        risk_reports.append(to_camel_case(asdict(group)))

    return risk_reports


def _float_or_zero(value: Any) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0

def _optional_float(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _positive_float(value: Any) -> float | None:
    number = _optional_float(value)
    if number is None or number <= 0:
        return None
    return number


def _has_fresh_quote(quote_age_hours: float | None) -> bool:
    return quote_age_hours is not None and quote_age_hours <= 24


def _has_recent_quote(quote_age_hours: float | None) -> bool:
    return quote_age_hours is not None and quote_age_hours <= 72


def _has_portfolio_price(row: dict[str, Any], market_value: float) -> bool:
    return _positive_float(row.get("quote_price")) is not None or market_value > 0


def _has_option_exposure_input(
    row: dict[str, Any],
    *,
    delta: float | None,
    underlying_price: float,
    market_value: float,
) -> bool:
    has_delta_model = (
        delta is not None
        and _positive_float(row.get("ratio")) is not None
        and underlying_price > 0
    )
    return (
        has_delta_model
        or _optional_float(row.get("omega")) is not None
        or _optional_float(row.get("leverage")) is not None
        or _has_portfolio_price(row, market_value)
    )


def _data_completeness_score(
    row: dict[str, Any],
    *,
    product_type: Any,
    delta: float | None,
    quote_age_hours: float | None,
    underlying_price: float,
    market_value: float,
) -> int:
    score = 0
    product_type_text = str(product_type or "")

    if _has_fresh_quote(quote_age_hours):
        pass
    elif _has_recent_quote(quote_age_hours):
        score += 1
    elif _has_portfolio_price(row, market_value):
        score += 2
    else:
        score += 4

    if product_type_text == "factor_certificate":
        if _optional_float(row.get("leverage")) is not None or _optional_float(row.get("omega")) is not None:
            pass
        elif _has_portfolio_price(row, market_value):
            score += 2
        else:
            score += 4
        return min(score, 10)

    if _has_option_exposure_input(row, delta=delta, underlying_price=underlying_price, market_value=market_value):
        if delta is None:
            score += 2
        elif underlying_price == 0 and _positive_float(row.get("ratio")) is not None:
            score += 2
    else:
        score += 4

    return min(score, 10)


def _exposure_confidence(
    row: dict[str, Any],
    *,
    product_type: Any,
    delta: float | None,
    quote_age_hours: float | None,
    underlying_price: float,
    market_value: float,
) -> str:
    product_type_text = str(product_type or "")
    if (
        delta is not None
        and _positive_float(row.get("ratio")) is not None
        and underlying_price > 0
        and quote_age_hours is not None
        and quote_age_hours < 4
    ):
        return "live_delta"

    if product_type_text == "factor_certificate":
        if _optional_float(row.get("leverage")) is not None:
            return "estimated_leverage"
        if _optional_float(row.get("omega")) is not None:
            return "estimated_omega"
        if _has_portfolio_price(row, market_value):
            return "estimated_market_value"
        return "no_data"

    if _optional_float(row.get("omega")) is not None:
        return "estimated_omega"
    if _optional_float(row.get("leverage")) is not None:
        return "estimated_leverage"
    if delta is not None and _positive_float(row.get("ratio")) is not None and underlying_price > 0:
        return "estimated_delta"
    if _has_portfolio_price(row, market_value):
        return "estimated_market_value"
    return "no_data"
