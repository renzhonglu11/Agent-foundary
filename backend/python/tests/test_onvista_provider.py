import httpx
import pytest

from agent_foundry_python.structured_products.providers.onvista import OnvistaProductProvider, parse_snapshot


# Shapes copied from the live endpoint on 2026-11-10/11, reduced to the fields read.
WARRANT = {
    "instrument": {
        "entityType": "DERIVATIVE",
        "entitySubType": "WARRANT",
        "isin": "DE000UG3NHT9",
        "wkn": "UG3NHT",
        "urls": {"WEBSITE": "https://www.onvista.de/derivate/Optionsscheine/293020236-UG3NHT-DE000UG3NHT9"},
    },
    "derivativesIssuer": {"name": "UniCredit"},
    "derivativesDetails": {
        "codeExerciseRight": "C",
        "datetimeMaturity": "2027-06-16T12:00:00.000+00:00",
        "openEnded": False,
    },
    "derivativesFigure": {
        "delta": 0.774692605048,
        "leverage": 2.73789537637,
        "thetaDay": -0.0114,
        "impliedVolatility": 57.2199020386,
        "gearing": 3.5341,
        "breakEven": 407.9,
        "datetimePrice": "2026-11-10T20:59:52.170+00:00",
    },
    "derivativesUnderlyingList": {
        "list": [
            {
                "isoCurrency": "USD",
                "coverRatio": 0.1,
                "instrument": {"entityType": "STOCK", "name": "Tesla", "isin": "US88160R1014"},
                "derivativesBarrierList": {"list": [{"typeBarrier": "STRIKE", "barrier": 300.0}]},
            }
        ]
    },
}
KNOCK_OUT = {
    "instrument": {"entitySubType": "KNOCKOUT_CERTIFICATE", "isin": "DE000HM0T297", "wkn": "HM0T29", "urls": {}},
    "derivativesIssuer": {"name": "HSBC"},
    "derivativesDetails": {"codeExerciseRight": "C", "datetimeMaturity": None, "openEnded": True},
    "derivativesFigure": {"gearing": 1.42362854076, "delta": None, "leverage": None, "thetaDay": None, "impliedVolatility": None},
    "derivativesUnderlyingList": {
        "list": [
            {
                "coverRatio": 0.01,
                "instrument": {"name": "Micron Technology"},
                "derivativesBarrierList": {
                    "list": [{"typeBarrier": "KNOCK_OUT", "barrier": 265.8004}, {"typeBarrier": "STRIKE", "barrier": 265.8004}]
                },
            }
        ]
    },
}
FACTOR = {
    "instrument": {"entitySubType": "FACTOR_CERTIFICATE", "isin": "DE000SU2ED95", "wkn": "SU2ED9", "urls": {}},
    "derivativesIssuer": {"name": "Société Générale"},
    "derivativesDetails": {"codeExerciseRight": "C", "openEnded": True, "participationRateWin": 2.0},
    "derivativesFigure": {"gearing": 12.4144521811},
    "derivativesUnderlyingList": {
        "list": [
            {
                "coverRatio": 1.0,
                "instrument": {"name": "GlobalFoundries"},
                "derivativesBarrierList": {
                    "list": [{"typeBarrier": "RESET_LEVEL", "barrier": 33.877}, {"typeBarrier": "STRIKE", "barrier": 56.462}]
                },
            }
        ]
    },
}


def provider_for(answers, requests):
    async def handler(request: httpx.Request) -> httpx.Response:
        requests.append(str(request.url))
        answer = answers[request.url.path.split("ISIN:")[1].split("/")[0]]
        return answer if isinstance(answer, httpx.Response) else httpx.Response(200, json=answer)

    return OnvistaProductProvider(transport=httpx.MockTransport(handler))


@pytest.mark.asyncio
async def test_snapshot_gives_a_warrant_its_terms_and_greeks_in_one_request():
    from datetime import datetime, timezone

    requests = []
    provider = provider_for({"DE000UG3NHT9": WARRANT}, requests)

    product = await provider.get_product_data("DE000UG3NHT9")

    # The JSON endpoint, not the website that turns the production server away.
    assert requests == ["https://api.onvista.de/api/v1/derivatives/ISIN:DE000UG3NHT9/snapshot"]
    assert product.source == "onvista"
    assert product.url.startswith("https://www.onvista.de/derivate/")
    metadata = product.metadata
    assert (metadata.wkn, metadata.issuer, metadata.underlying) == ("UG3NHT", "UniCredit", "Tesla")
    assert (metadata.product_type, metadata.option_type) == ("optionsschein", "call")
    assert (metadata.strike_price, metadata.ratio, metadata.expiry) == (300.0, 0.1, "2027-06-16")
    assert (metadata.leverage, metadata.break_even) == (3.5341, 407.9)
    greek = product.greek
    # onvista's "leverage" is the elasticity; its volatility is in percent.
    assert (greek.delta, greek.omega, greek.theta) == (0.774692605048, 2.73789537637, -0.0114)
    assert greek.iv == pytest.approx(0.572199020386)
    assert greek.timestamp == datetime(2026, 11, 10, 20, 59, 52, 170000, tzinfo=timezone.utc)
    await provider.aclose()


def test_snapshot_reads_knock_out_and_factor_terms():
    knock_out = parse_snapshot("DE000HM0T297", KNOCK_OUT)
    assert knock_out.metadata.product_type == "open_end_turbo"
    assert (knock_out.metadata.strike_price, knock_out.metadata.knockout_price) == (265.8004, 265.8004)
    assert (knock_out.metadata.ratio, knock_out.metadata.leverage) == (0.01, 1.42362854076)
    assert knock_out.metadata.expiry is None
    assert knock_out.greek is None

    factor = parse_snapshot("DE000SU2ED95", FACTOR)
    assert factor.metadata.product_type == "factor_certificate"
    # The factor, not the gearing of the day.
    assert factor.metadata.leverage == 2.0
    assert (factor.metadata.reset_barrier, factor.metadata.ratio) == (33.877, 1.0)
    assert factor.greek is None

    # A knock-out with an end date is not an open-end product.
    dated = {**KNOCK_OUT, "derivativesDetails": {"codeExerciseRight": "P", "openEnded": False, "datetimeMaturity": "2027-01-15T12:00:00.000+00:00"}}
    dated_metadata = parse_snapshot("DE000HM0T297", dated).metadata
    assert (dated_metadata.product_type, dated_metadata.option_type, dated_metadata.expiry) == ("knock_out", "put", "2027-01-15")


@pytest.mark.asyncio
async def test_unknown_products_are_unavailable_and_a_refusal_ends_the_requests():
    requests = []
    provider = provider_for(
        {
            "DE000OTHER00": WARRANT,
            "DE000MISSING": httpx.Response(404, json={"message": "not found"}),
            "DE000LIMITED": httpx.Response(429, text="Too Many Requests"),
            "DE000UG3NHT9": WARRANT,
        },
        requests,
    )

    assert await provider.get_product_data("DE000OTHER00") is None
    assert await provider.get_product_data("DE000MISSING") is None
    assert provider.guard.refused is False
    assert await provider.get_product_data("DE000LIMITED") is None
    assert provider.guard.refused is True
    # Not asked again in this run, even for a product it would know.
    assert await provider.get_product_data("DE000UG3NHT9") is None
    assert len(requests) == 3
    await provider.aclose()


@pytest.mark.asyncio
async def test_quote_and_product_reuse_one_snapshot_and_keep_market_time():
    payload = {**WARRANT, "quote": {
        "last": 10.09, "isoCurrency": "EUR", "datetimeLast": "2026-11-11T13:42:57.182+00:00",
        "high": 10.33, "low": 9.96,
    }}
    requests = []
    provider = provider_for({"DE000UG3NHT9": payload}, requests)
    quote = await provider.get_quote("DE000UG3NHT9")
    product = await provider.get_product_data("DE000UG3NHT9")
    assert len(requests) == 1
    assert quote.price == 10.09 and quote.currency == "EUR"
    assert quote.timestamp.isoformat() == "2026-11-11T13:42:57.182000+00:00"
    assert product.metadata.isin == quote.isin
    await provider.aclose()


@pytest.mark.asyncio
@pytest.mark.parametrize("changes", [{"datetimeLast": None}, {"last": float("nan")}, {"last": -1}, {"isoCurrency": None}])
async def test_quote_with_unverifiable_price_or_time_is_unavailable(changes):
    payload = {**WARRANT, "quote": {"last": 10.09, "isoCurrency": "EUR", "datetimeLast": "2026-11-11T13:42:57Z", **changes}}
    provider = OnvistaProductProvider()
    # Inject an already received response; JSON itself cannot encode NaN.
    import time
    provider._snapshots["DE000UG3NHT9"] = (time.monotonic(), payload)
    assert await provider.get_quote("DE000UG3NHT9") is None
    await provider.aclose()
