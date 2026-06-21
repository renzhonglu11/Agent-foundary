from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any

from agent_foundry_python.structured_products.agent_foundry import _canonical_group_key, _infer_underlying
from agent_foundry_python.structured_products.exposure import compute_delta_exposure
from agent_foundry_python.structured_products.models import Greek, InstrumentMetadata, Position, Quote

BUY_MORE_MAX_GROUP_GROSS_WEIGHT = 0.15
BUY_MORE_MAX_LEG_EXPOSURE_WEIGHT = 0.015
BUY_MORE_MIN_DTE = 90
BUY_MORE_MIN_BARRIER_DISTANCE = 0.25
BUY_MORE_MIN_ABS_DELTA = 0.25
BUY_MORE_MAX_ABS_DELTA = 0.70
BUY_MORE_MAX_OPTION_LEVERAGE = 6.0
BUY_MORE_MAX_TURBO_LEVERAGE = 4.0
BUY_MORE_MAX_FACTOR_LEVERAGE = 3.0

ADD_ALLOWED_MAX_GROUP_GROSS_WEIGHT = 0.18
ADD_ALLOWED_MAX_LEG_EXPOSURE_WEIGHT = 0.03
ADD_ALLOWED_MIN_DTE = 60
ADD_ALLOWED_MIN_BARRIER_DISTANCE = 0.20
ADD_ALLOWED_MAX_LEVERAGE = 8.0

GROUP_ADD_ALLOWED_MAX_SCORE = 4
GROUP_REDUCE_CONCENTRATION_MIN_SCORE = 7

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
    leverage: float | None
    delta_exposure: float
    exposure_weight_pct: float
    days_to_expiry: int | None
    barrier_distance_pct: float | None
    quote_age_hours: float | None
    exposure_confidence: str
    data_completeness_risk_score: int
    leg_risk_status: str
    primary_action: str
    action_reason: str

@dataclass
class RiskGroup:
    symbol: str
    pre_enrichment_tier: int
    group_market_value: float
    net_equivalent_exposure: float
    gross_equivalent_exposure: float
    net_weight_pct: float
    gross_weight_pct: float
    derivative_net_equivalent_exposure: float
    derivative_gross_equivalent_exposure: float
    derivative_net_weight_pct: float
    derivative_gross_weight_pct: float
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
        derivative_net_exposure_sum = 0.0
        derivative_gross_exposure_sum = 0.0
        
        legs: list[RiskLeg] = []
        for row in rows:
            isin = row.get("isin", "")
            market_value = _float_or_zero(row.get("market_value"))
            group_market_value += market_value

            delta = _optional_float(row.get("delta"))
            leverage = _optional_float(row.get("leverage"))
            
            # Construct models to use compute_delta_exposure
            pos_model = Position(isin=isin, quantity=_float_or_zero(row.get("quantity")), avg_cost=0, source="risk")
            greek_model = Greek(isin=isin, delta=delta, omega=_optional_float(row.get("omega")))
            quote_model = Quote(isin=isin, price=_float_or_zero(row.get("quote_price")), currency=row.get("quote_currency", "EUR"))
            meta_model = InstrumentMetadata(
                isin=isin,
                product_type=row.get("product_type"),
                leverage=leverage,
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
            derivative_net_exposure_sum += delta_exposure
            derivative_gross_exposure_sum += abs(delta_exposure)
            exposure_weight_pct = abs(delta_exposure) / nav if nav > 0 else 0.0

            # Days to expiry
            expiry_str = row.get("expiry")
            days_to_expiry = None
            if expiry_str:
                try:
                    expiry_date = datetime.fromisoformat(expiry_str.replace("Z", "+00:00"))
                    if expiry_date.tzinfo is None:
                        expiry_date = expiry_date.replace(tzinfo=timezone.utc)
                    days_to_expiry = (expiry_date - now).days
                except Exception:
                    pass

            # Barrier Distance
            knockout_price = _optional_float(row.get("knockout_price"))
            barrier_distance_pct = None
            if knockout_price and underlying_price > 0:
                barrier_distance_pct = abs(underlying_price - knockout_price) / underlying_price

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
            status = _leg_risk_status(
                confidence=confidence,
                missing_score=missing_score,
                days_to_expiry=days_to_expiry,
                barrier_distance_pct=barrier_distance_pct,
                exposure_weight_pct=exposure_weight_pct,
            )
            primary_action, action_reason = _leg_primary_action(
                row,
                status=status,
                confidence=confidence,
                missing_score=missing_score,
                days_to_expiry=days_to_expiry,
                barrier_distance_pct=barrier_distance_pct,
                exposure_weight_pct=exposure_weight_pct,
            )
            legs.append(RiskLeg(
                isin=isin,
                product_type=row.get("product_type", ""),
                market_value=market_value,
                delta=delta,
                leverage=leverage,
                delta_exposure=delta_exposure,
                exposure_weight_pct=exposure_weight_pct,
                days_to_expiry=days_to_expiry,
                barrier_distance_pct=barrier_distance_pct,
                quote_age_hours=quote_age_hours,
                exposure_confidence=confidence,
                data_completeness_risk_score=missing_score,
                leg_risk_status=status,
                primary_action=primary_action,
                action_reason=action_reason,
            ))

        net_weight_pct = net_exposure_sum / nav if nav > 0 else 0.0
        gross_weight_pct = gross_exposure_sum / nav if nav > 0 else 0.0
        derivative_net_weight_pct = derivative_net_exposure_sum / nav if nav > 0 else 0.0
        derivative_gross_weight_pct = derivative_gross_exposure_sum / nav if nav > 0 else 0.0

        for leg in legs:
            if leg.primary_action == "HOLD" and leg.leg_risk_status == "OK":
                leg.primary_action, leg.action_reason = _leg_strategy_action(
                    leg,
                    group_derivative_gross_weight_pct=derivative_gross_weight_pct,
                )

        group_action_label = _group_action_from_score(
            legs,
            derivative_net_weight_pct=derivative_net_weight_pct,
            derivative_gross_weight_pct=derivative_gross_weight_pct,
        )
        blocked_actions = []
        allowed_actions = ["HOLD_MONITOR"]

        if group_action_label == "REDUCE_CONCENTRATION":
            blocked_actions.append("BUY")
        elif group_action_label == "ADD_ALLOWED":
            allowed_actions.append("BUY")

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
            derivative_net_equivalent_exposure=derivative_net_exposure_sum,
            derivative_gross_equivalent_exposure=derivative_gross_exposure_sum,
            derivative_net_weight_pct=derivative_net_weight_pct,
            derivative_gross_weight_pct=derivative_gross_weight_pct,
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


def _leg_risk_status(
    *,
    confidence: str,
    missing_score: int,
    days_to_expiry: int | None,
    barrier_distance_pct: float | None,
    exposure_weight_pct: float,
) -> str:
    if confidence == "no_data" or (days_to_expiry is not None and days_to_expiry <= 0):
        return "HARD_BLOCKED"
    if (
        missing_score >= 6
        or (days_to_expiry is not None and days_to_expiry < 7)
        or (barrier_distance_pct is not None and barrier_distance_pct < 0.10)
        or exposure_weight_pct > 0.08
    ):
        return "WATCH"
    return "OK"


def _group_action_from_score(
    legs: list[RiskLeg],
    *,
    derivative_net_weight_pct: float,
    derivative_gross_weight_pct: float,
) -> str:
    score = _group_risk_score(
        legs,
        derivative_net_weight_pct=derivative_net_weight_pct,
        derivative_gross_weight_pct=derivative_gross_weight_pct,
    )
    if (
        derivative_gross_weight_pct > 0.20
        or abs(derivative_net_weight_pct) > 0.15
        or score >= GROUP_REDUCE_CONCENTRATION_MIN_SCORE
    ):
        return "REDUCE_CONCENTRATION"

    has_buy_candidate = any(leg.primary_action == "BUY" for leg in legs)
    has_product_risk_action = any(leg.primary_action in {"SELL", "ROLL"} for leg in legs)
    if has_buy_candidate and not has_product_risk_action and score <= GROUP_ADD_ALLOWED_MAX_SCORE:
        return "ADD_ALLOWED"
    return "HOLD_MONITOR"


def _group_risk_score(
    legs: list[RiskLeg],
    *,
    derivative_net_weight_pct: float,
    derivative_gross_weight_pct: float,
) -> int:
    score = 0

    if derivative_gross_weight_pct > 0.18:
        score += 4
    elif derivative_gross_weight_pct > 0.12:
        score += 2
    elif derivative_gross_weight_pct > 0.08:
        score += 1

    abs_net_weight = abs(derivative_net_weight_pct)
    if abs_net_weight > 0.14:
        score += 4
    elif abs_net_weight > 0.10:
        score += 2
    elif abs_net_weight > 0.06:
        score += 1

    leverages = [abs(leg.leverage) for leg in legs if leg.leverage is not None and abs(leg.leverage) > 1]
    leveraged_count = len(leverages)
    if leveraged_count >= 5:
        score += 2
    elif leveraged_count >= 3:
        score += 1

    high_leverage_count = sum(1 for leverage in leverages if leverage > 6)
    medium_leverage_count = sum(1 for leverage in leverages if leverage > 3)
    score += min(high_leverage_count, 2)
    if medium_leverage_count >= 3:
        score += 1

    max_leverage = max(leverages, default=0.0)
    if max_leverage > 8:
        score += 2
    elif max_leverage > 5:
        score += 1

    return score


def _leg_primary_action(
    row: dict[str, Any],
    *,
    status: str,
    confidence: str,
    missing_score: int,
    days_to_expiry: int | None,
    barrier_distance_pct: float | None,
    exposure_weight_pct: float,
) -> tuple[str, str]:
    if days_to_expiry is not None and days_to_expiry <= 0:
        return "SELL", "Product is expired or expires today."
    if barrier_distance_pct is not None and barrier_distance_pct < 0.05:
        return "SELL", "Knock-out barrier is less than 5% away."
    if status == "HARD_BLOCKED":
        return "SELL", "Exposure cannot be trusted because required data is unavailable."
    if days_to_expiry is not None and days_to_expiry < 7:
        return "ROLL", "Expiry is less than 7 days away; roll or close the position."
    if barrier_distance_pct is not None and barrier_distance_pct < 0.10:
        return "SELL", "Knock-out barrier is less than 10% away."
    if exposure_weight_pct > 0.08:
        return "SELL", "Single product exposure is above 8% of NAV."
    if status == "WATCH":
        return "SELL", "Product is on watch due to data quality or risk limits."
    if confidence == "estimated_market_value":
        return "HOLD", "Exposure uses market-value fallback; do not add risk from this estimate alone."
    if days_to_expiry is not None and days_to_expiry < 30:
        return "HOLD", "Expiry is less than 30 days away."
    if barrier_distance_pct is not None and barrier_distance_pct < 0.20:
        return "HOLD", "Knock-out barrier is less than 20% away."
    return "HOLD", "Risk is acceptable, but add criteria are not strong enough."


def _leg_strategy_action(
    leg: RiskLeg,
    *,
    group_derivative_gross_weight_pct: float,
) -> tuple[str, str]:
    if leg.exposure_confidence not in {"live_delta", "estimated_delta", "estimated_leverage", "estimated_omega"}:
        return "HOLD", "Exposure confidence is not strong enough to add risk."
    if leg.data_completeness_risk_score > 2:
        return "HOLD", "Data completeness is acceptable for monitoring, not for adding."
    if group_derivative_gross_weight_pct > ADD_ALLOWED_MAX_GROUP_GROSS_WEIGHT:
        return "HOLD", "Derivative group exposure is already near the concentration limit."
    if leg.exposure_weight_pct > ADD_ALLOWED_MAX_LEG_EXPOSURE_WEIGHT:
        return "HOLD", "Single product exposure is already above the add budget."
    if leg.days_to_expiry is not None and leg.days_to_expiry < ADD_ALLOWED_MIN_DTE:
        return "HOLD", "Time to expiry is too short for adding risk."
    if leg.barrier_distance_pct is not None and leg.barrier_distance_pct < ADD_ALLOWED_MIN_BARRIER_DISTANCE:
        return "HOLD", "Knock-out barrier distance is too narrow for adding risk."
    if not _leverage_allows_add(leg):
        return "HOLD", "Leverage is too high or missing for this product type."

    score = _buy_more_score(leg, group_derivative_gross_weight_pct=group_derivative_gross_weight_pct)
    if score >= 7 and _buy_more_gates_pass(leg, group_derivative_gross_weight_pct=group_derivative_gross_weight_pct):
        return "BUY", "Exposure, Delta, leverage, expiry and concentration support adding."
    return "BUY", "Risk budget allows adding, but the buy score is lower priority."


def _buy_more_gates_pass(leg: RiskLeg, *, group_derivative_gross_weight_pct: float) -> bool:
    if group_derivative_gross_weight_pct > BUY_MORE_MAX_GROUP_GROSS_WEIGHT:
        return False
    if leg.exposure_weight_pct > BUY_MORE_MAX_LEG_EXPOSURE_WEIGHT:
        return False
    if leg.days_to_expiry is not None and leg.days_to_expiry < BUY_MORE_MIN_DTE:
        return False
    if leg.barrier_distance_pct is not None and leg.barrier_distance_pct < BUY_MORE_MIN_BARRIER_DISTANCE:
        return False
    if leg.product_type in {"open_end_turbo", "knock_out"} and leg.barrier_distance_pct is None:
        return False
    if not _delta_allows_buy_more(leg):
        return False
    return _leverage_profile_score(leg) > 0


def _buy_more_score(leg: RiskLeg, *, group_derivative_gross_weight_pct: float) -> int:
    score = 0

    if group_derivative_gross_weight_pct <= BUY_MORE_MAX_GROUP_GROSS_WEIGHT / 2:
        score += 2
    elif group_derivative_gross_weight_pct <= BUY_MORE_MAX_GROUP_GROSS_WEIGHT:
        score += 1

    if leg.exposure_weight_pct <= BUY_MORE_MAX_LEG_EXPOSURE_WEIGHT / 2:
        score += 2
    elif leg.exposure_weight_pct <= BUY_MORE_MAX_LEG_EXPOSURE_WEIGHT:
        score += 1

    if leg.days_to_expiry is None or leg.days_to_expiry >= BUY_MORE_MIN_DTE * 2:
        score += 2
    elif leg.days_to_expiry >= BUY_MORE_MIN_DTE:
        score += 1

    if leg.barrier_distance_pct is None:
        if leg.product_type not in {"open_end_turbo", "knock_out"}:
            score += 1
    elif leg.barrier_distance_pct >= BUY_MORE_MIN_BARRIER_DISTANCE * 1.4:
        score += 2
    elif leg.barrier_distance_pct >= BUY_MORE_MIN_BARRIER_DISTANCE:
        score += 1

    score += _delta_profile_score(leg)
    score += _leverage_profile_score(leg)
    return score


def _delta_profile_score(leg: RiskLeg) -> int:
    if leg.delta is None:
        return 1 if leg.product_type in {"factor_certificate", "open_end_turbo", "knock_out"} else 0

    abs_delta = abs(leg.delta)
    if 0.35 <= abs_delta <= 0.60:
        return 2
    if BUY_MORE_MIN_ABS_DELTA <= abs_delta <= BUY_MORE_MAX_ABS_DELTA:
        return 1
    return 0


def _delta_allows_buy_more(leg: RiskLeg) -> bool:
    if leg.delta is None:
        return leg.product_type in {"factor_certificate", "open_end_turbo", "knock_out"}
    abs_delta = abs(leg.delta)
    return BUY_MORE_MIN_ABS_DELTA <= abs_delta <= BUY_MORE_MAX_ABS_DELTA


def _leverage_profile_score(leg: RiskLeg) -> int:
    if leg.leverage is None:
        return 1 if leg.product_type == "optionsschein" and leg.delta is not None else 0

    leverage = abs(leg.leverage)
    max_buy_more = _buy_more_leverage_limit(leg.product_type)
    if leverage <= max_buy_more / 2:
        return 2
    if leverage <= max_buy_more:
        return 1
    return 0


def _leverage_allows_add(leg: RiskLeg) -> bool:
    if leg.leverage is None:
        return leg.product_type == "optionsschein" and leg.delta is not None
    return abs(leg.leverage) <= ADD_ALLOWED_MAX_LEVERAGE


def _buy_more_leverage_limit(product_type: str) -> float:
    if product_type == "factor_certificate":
        return BUY_MORE_MAX_FACTOR_LEVERAGE
    if product_type in {"open_end_turbo", "knock_out"}:
        return BUY_MORE_MAX_TURBO_LEVERAGE
    return BUY_MORE_MAX_OPTION_LEVERAGE


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
