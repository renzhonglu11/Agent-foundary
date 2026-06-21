from datetime import datetime, timedelta, timezone

from agent_foundry_python.structured_products.risk import evaluate_portfolio_risk


def _leg(report, isin):
    for group in report:
        for leg in group["legs"]:
            if leg["isin"] == isin:
                return group, leg
    raise AssertionError(f"missing risk leg {isin}")


def test_factor_certificate_with_leverage_is_not_blocked_for_missing_delta():
    rows = [
        {
            "isin": "DE000SX1Y9R4",
            "instrument": "FaktL O.End Tesla 304,05",
            "product_type": "factor_certificate",
            "enrichment_tier": "tier1",
            "quantity": 83,
            "quote_price": 2.83,
            "quote_currency": "EUR",
            "market_value": 234.89,
            "leverage": 3.0,
            "option_type": "call",
        }
    ]
    positions = [
        {
            "assetClass": "STOCK",
            "displayName": "Tesla Inc",
            "marketValue": 1000,
            "lastPrice": 406.28,
        }
    ]

    report = evaluate_portfolio_risk(rows, positions, nav=10_000)
    _, leg = _leg(report, "DE000SX1Y9R4")

    assert leg["deltaExposure"] == 704.67
    assert leg["exposureConfidence"] == "estimated_leverage"
    assert leg["dataCompletenessRiskScore"] <= 2
    assert leg["legRiskStatus"] != "HARD_BLOCKED"


def test_optionsschein_without_greeks_uses_market_value_estimate_instead_of_no_data():
    rows = [
        {
            "isin": "DE000SJ7BGU6",
            "instrument": "Call 18.06.99 TaiwanSM 215",
            "product_type": "optionsschein",
            "enrichment_tier": "tier1",
            "quantity": 25,
            "quote_price": 17.54,
            "quote_currency": "EUR",
            "market_value": 438.5,
            "ratio": 0.1,
            "expiry": "2099-06-18",
            "option_type": "call",
        }
    ]
    positions = [
        {
            "assetClass": "STOCK",
            "displayName": "Taiwan Semiconductor Manufacturing Company Ltd.",
            "marketValue": 1000,
            "lastPrice": 424.57,
        }
    ]

    report = evaluate_portfolio_risk(rows, positions, nav=10_000)
    _, leg = _leg(report, "DE000SJ7BGU6")

    assert leg["deltaExposure"] == 438.5
    assert leg["exposureConfidence"] == "estimated_market_value"
    assert leg["dataCompletenessRiskScore"] <= 4
    assert leg["legRiskStatus"] != "HARD_BLOCKED"
    assert leg["primaryAction"] == "HOLD"


def test_expired_product_is_exit_now():
    rows = [
        {
            "isin": "DE000EXPIRED",
            "instrument": "Call Expired",
            "product_type": "optionsschein",
            "enrichment_tier": "tier1",
            "quantity": 10,
            "quote_price": 2.0,
            "quote_currency": "EUR",
            "market_value": 20,
            "delta": 0.5,
            "ratio": 0.1,
            "expiry": "2000-01-01",
            "option_type": "call",
        }
    ]
    positions = [
        {
            "assetClass": "STOCK",
            "displayName": "Expired Inc",
            "marketValue": 1000,
            "lastPrice": 100,
        }
    ]

    report = evaluate_portfolio_risk(rows, positions, nav=10_000)
    group, leg = _leg(report, "DE000EXPIRED")

    assert group["groupActionLabel"] == "HOLD_MONITOR"
    assert leg["legRiskStatus"] == "HARD_BLOCKED"
    assert leg["primaryAction"] == "SELL"


def test_near_expiry_product_is_roll_candidate():
    near_expiry = (datetime.now(timezone.utc) + timedelta(days=3)).date().isoformat()
    rows = [
        {
            "isin": "DE000ROLL",
            "instrument": "Call Near Expiry",
            "product_type": "optionsschein",
            "enrichment_tier": "tier1",
            "quantity": 10,
            "quote_price": 2.0,
            "quote_currency": "EUR",
            "market_value": 20,
            "delta": 0.5,
            "ratio": 0.1,
            "expiry": near_expiry,
            "option_type": "call",
        }
    ]
    positions = [
        {
            "assetClass": "STOCK",
            "displayName": "Roll Inc",
            "marketValue": 1000,
            "lastPrice": 100,
        }
    ]

    report = evaluate_portfolio_risk(rows, positions, nav=10_000)
    group, leg = _leg(report, "DE000ROLL")

    assert group["groupActionLabel"] == "HOLD_MONITOR"
    assert leg["legRiskStatus"] == "WATCH"
    assert leg["primaryAction"] == "ROLL"


def test_group_concentration_blocks_add_allowed_at_group_level():
    rows = [
        {
            "isin": "DE000BIG",
            "instrument": "Call Big",
            "product_type": "optionsschein",
            "enrichment_tier": "tier1",
            "quantity": 1000,
            "quote_price": 10,
            "quote_currency": "EUR",
            "market_value": 10_000,
            "delta": 0.8,
            "ratio": 1.0,
            "expiry": "2099-01-01",
            "option_type": "call",
        }
    ]
    positions = [
        {
            "assetClass": "STOCK",
            "displayName": "Big Inc",
            "marketValue": 5_000,
            "lastPrice": 100,
        }
    ]

    report = evaluate_portfolio_risk(rows, positions, nav=50_000)
    group, leg = _leg(report, "DE000BIG")

    assert group["groupActionLabel"] == "REDUCE_CONCENTRATION"
    assert "BUY" in group["action"]["blockedActions"]
    assert leg["primaryAction"] == "SELL"


def test_strategy_uses_exposure_delta_and_leverage_for_buy_more_and_hold():
    rows = [
        {
            "isin": "DE000SMALL",
            "instrument": "Call Small",
            "underlying": "Small Inc",
            "product_type": "optionsschein",
            "enrichment_tier": "tier1",
            "quantity": 10,
            "quote_price": 2,
            "quote_currency": "EUR",
            "market_value": 20,
            "delta": 0.5,
            "leverage": 2.0,
            "ratio": 0.1,
            "expiry": "2099-01-01",
            "option_type": "call",
        },
        {
            "isin": "DE000MEDIUM",
            "instrument": "Call Medium",
            "underlying": "Small Inc",
            "product_type": "optionsschein",
            "enrichment_tier": "tier1",
            "quantity": 100,
            "quote_price": 20,
            "quote_currency": "EUR",
            "market_value": 2_000,
            "delta": 0.8,
            "leverage": 7.0,
            "ratio": 1.0,
            "expiry": "2099-01-01",
            "option_type": "call",
        },
    ]
    positions = [
        {
            "assetClass": "STOCK",
            "displayName": "Small Inc",
            "marketValue": 0,
            "lastPrice": 100,
        }
    ]

    report = evaluate_portfolio_risk(rows, positions, nav=100_000)
    group, small_leg = _leg(report, "DE000SMALL")
    _, medium_leg = _leg(report, "DE000MEDIUM")

    assert group["groupActionLabel"] == "ADD_ALLOWED"
    assert small_leg["primaryAction"] == "BUY"
    assert medium_leg["primaryAction"] == "HOLD"


def test_add_allowed_for_acceptable_but_not_buy_more_sized_exposure():
    rows = [
        {
            "isin": "DE000ADD",
            "instrument": "Call Add",
            "underlying": "Add Inc",
            "product_type": "optionsschein",
            "enrichment_tier": "tier1",
            "quantity": 40,
            "quote_price": 2,
            "quote_currency": "EUR",
            "market_value": 20,
            "delta": 0.5,
            "leverage": 2.0,
            "ratio": 1.0,
            "expiry": "2099-01-01",
            "option_type": "call",
        }
    ]
    positions = [
        {
            "assetClass": "STOCK",
            "displayName": "Add Inc",
            "marketValue": 0,
            "lastPrice": 100,
        }
    ]

    report = evaluate_portfolio_risk(rows, positions, nav=100_000)
    group, leg = _leg(report, "DE000ADD")

    assert group["groupActionLabel"] == "ADD_ALLOWED"
    assert leg["primaryAction"] == "BUY"


def test_large_stock_position_does_not_block_small_derivative_buy_more():
    rows = [
        {
            "isin": "DE000STOCKHEAVY",
            "instrument": "Call Stock Heavy",
            "underlying": "Stock Heavy Inc",
            "product_type": "optionsschein",
            "enrichment_tier": "tier1",
            "quantity": 10,
            "quote_price": 2,
            "quote_currency": "EUR",
            "market_value": 20,
            "delta": 0.5,
            "leverage": 2.0,
            "ratio": 0.1,
            "expiry": "2099-01-01",
            "option_type": "call",
        }
    ]
    positions = [
        {
            "assetClass": "STOCK",
            "displayName": "Stock Heavy Inc",
            "marketValue": 30_000,
            "lastPrice": 100,
        }
    ]

    report = evaluate_portfolio_risk(rows, positions, nav=100_000)
    group, leg = _leg(report, "DE000STOCKHEAVY")

    assert group["grossWeightPct"] > 0.20
    assert group["derivativeGrossWeightPct"] < 0.01
    assert group["groupActionLabel"] == "ADD_ALLOWED"
    assert leg["primaryAction"] == "BUY"
