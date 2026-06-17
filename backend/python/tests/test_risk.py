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
