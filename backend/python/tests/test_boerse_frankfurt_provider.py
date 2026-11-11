import httpx
import pytest

from agent_foundry_python.structured_products.providers.boerse_frankfurt import BoerseFrankfurtQuoteProvider


@pytest.mark.asyncio
async def test_boerse_frankfurt_quote_provider_requests_xstu_and_normalizes_quote():
    seen = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["user_agent"] = request.headers.get("User-Agent")
        return httpx.Response(
            200,
            json={
                "isin": "DE000HM0T297",
                "timestampLastPrice": "2026-11-11T14:01:21+01:00",
                "lastPrice": 4.24,
                "currency": {"originalValue": "EUR", "translations": {"others": "Euro"}},
                "dayHigh": 4.33,
                "dayLow": 4.02,
            },
        )

    provider = BoerseFrankfurtQuoteProvider(
        transport=httpx.MockTransport(handler),
    )

    quote = await provider.get_quote("DE000HM0T297")

    assert "isin=DE000HM0T297" in seen["url"]
    assert "mic=XSTU" in seen["url"]
    assert seen["user_agent"]
    assert quote.isin == "DE000HM0T297"
    assert quote.price == 4.24
    assert quote.currency == "EUR"
    assert quote.day_high == 4.33
    assert quote.day_low == 4.02
    assert quote.timestamp.isoformat() == "2026-11-11T14:01:21+01:00"


@pytest.mark.asyncio
async def test_boerse_frankfurt_quote_provider_treats_missing_price_as_unavailable():
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"currency": "EUR"})

    provider = BoerseFrankfurtQuoteProvider(transport=httpx.MockTransport(handler))

    quote = await provider.get_quote("DE000HM0T297")

    assert quote is None
    await provider.aclose()


@pytest.mark.parametrize("changes", [{"isin": "DE000WRONG00"}, {"timestampLastPrice": None}, {"currency": None}, {"lastPrice": True}])
def test_quote_identity_currency_and_market_time_must_be_verifiable(changes):
    from agent_foundry_python.structured_products.providers.boerse_frankfurt import parse_quote_payload
    payload = {"isin": "DE000VY42C94", "timestampLastPrice": "2026-11-11T14:01:21+01:00", "lastPrice": 4.94, "currency": {"originalValue": "EUR"}, **changes}
    with pytest.raises(ValueError):
        parse_quote_payload("DE000VY42C94", payload)


# Shapes copied from the live endpoint on 2026-11-10, reduced to the fields read.
WARRANT_MASTER_DATA = {
    "isin": "DE000VY42C94",
    "wkn": "VY42C9",
    "eusipaCode": 2100,
    "productType": "Optionsschein Call",
    "participationTypeName": "Call",
    "participation": None,
    "issuer": {"originalValue": "Vontobel", "translations": {}},
    "ratio": 0.1,
    "finalValuationDate": "2027-06-17",
    "lastListingDate": "2027-06-17",
    "figureOptionDelta": 0.6515,
    "figureOptionOmega": 2.5024,
    "figureOptionTheta": -0.0087,
    "figureImplVolaMid": 83.5451,
    "figureOptionLeverage": 3.8413,
    "figureQuoteTime": "2026-11-10T19:03:49Z",
    "underlyings": [
        {
            "underlyingName": "Zscaler",
            "underlyingIsin": "US98980G1022",
            "strikeValue": {"value": 180, "unitCode": "USD"},
            "knockOutBarrierValue": None,
        }
    ],
}
KNOCK_OUT_MASTER_DATA = {
    "isin": "DE000HM0T297",
    "wkn": "HM0T29",
    "eusipaCode": 2205,
    "productType": "Open-End Knock-Out Call",
    "participationTypeName": "Call",
    "issuer": {"originalValue": "HSBC Trinkaus & Burkhardt GmbH", "translations": {}},
    "ratio": 0.01,
    "finalValuationDate": None,
    "lastListingDate": None,
    "figureOptionDelta": None,
    "figureOptionOmega": None,
    "figureOptionTheta": None,
    "figureImplVolaMid": None,
    "figureOptionLeverage": 1.5963,
    "figureQuoteTime": "2026-11-10T20:36:51Z",
    "underlyings": [
        {
            "underlyingName": "Micron Technology Inc",
            "strikeValue": {"value": 265.7459, "unitCode": "USD"},
            "knockOutBarrierValue": {"value": 265.7459, "unitCode": "USD"},
        }
    ],
}
FACTOR_MASTER_DATA = {
    "isin": "DE000SU2ED95",
    "wkn": "SU2ED9",
    "eusipaCode": 2300,
    "productType": "Faktor Long Optionsschein",
    "participationTypeName": "Call",
    "participation": 200,
    "issuer": {"originalValue": "Société Générale Effekten GmbH", "translations": {}},
    "ratio": None,
    "finalValuationDate": None,
    "figureOptionLeverage": None,
    "figureQuoteTime": "2026-11-10T20:42:29Z",
    "underlyings": [{"underlyingName": "GlobalFoundries", "strikeValue": None, "knockOutBarrierValue": None}],
}


def master_data_provider(payloads, requests=None, **kwargs):
    from agent_foundry_python.structured_products.providers.boerse_frankfurt import BoerseFrankfurtProductProvider

    async def handler(request: httpx.Request) -> httpx.Response:
        if requests is not None:
            requests.append(str(request.url))
        answer = payloads[request.url.params["isin"]]
        return answer if isinstance(answer, httpx.Response) else httpx.Response(200, json=answer)

    return BoerseFrankfurtProductProvider(transport=httpx.MockTransport(handler), **kwargs)


@pytest.mark.asyncio
async def test_master_data_gives_a_warrant_its_terms_and_greeks_in_one_request():
    from datetime import datetime, timezone

    requests = []
    provider = master_data_provider({"DE000VY42C94": WARRANT_MASTER_DATA}, requests)

    product = await provider.get_product_data("DE000VY42C94")

    assert len(requests) == 1
    assert "derivatives_master_data" in requests[0] and "isin=DE000VY42C94" in requests[0]
    assert product.source == "boerse_frankfurt"
    metadata = product.metadata
    assert (metadata.wkn, metadata.issuer, metadata.underlying) == ("VY42C9", "Vontobel", "Zscaler")
    assert (metadata.product_type, metadata.option_type) == ("optionsschein", "call")
    assert (metadata.strike_price, metadata.ratio, metadata.expiry) == (180.0, 0.1, "2027-06-17")
    assert metadata.leverage == 3.8413
    assert metadata.knockout_price is None
    greek = product.greek
    assert (greek.delta, greek.omega, greek.theta) == (0.6515, 2.5024, -0.0087)
    # Percent at the source, a fraction in the pipeline.
    assert greek.iv == pytest.approx(0.835451)
    # The Greeks carry the time the exchange calculated them, not the fetch time.
    assert greek.timestamp == datetime(2026, 11, 10, 19, 3, 49, tzinfo=timezone.utc)


@pytest.mark.asyncio
async def test_master_data_reads_knock_out_and_factor_terms_without_inventing_greeks():
    provider = master_data_provider({"DE000HM0T297": KNOCK_OUT_MASTER_DATA, "DE000SU2ED95": FACTOR_MASTER_DATA})

    knock_out = await provider.get_product_data("DE000HM0T297")
    assert knock_out.metadata.product_type == "open_end_turbo"
    assert (knock_out.metadata.strike_price, knock_out.metadata.knockout_price) == (265.7459, 265.7459)
    assert (knock_out.metadata.ratio, knock_out.metadata.leverage) == (0.01, 1.5963)
    assert knock_out.metadata.expiry is None
    assert knock_out.greek is None

    factor = await provider.get_product_data("DE000SU2ED95")
    assert factor.metadata.product_type == "factor_certificate"
    # A participation of 200 percent is a factor of two.
    assert factor.metadata.leverage == 2.0
    assert factor.metadata.option_type == "call"
    assert factor.greek is None


def test_master_data_falls_back_to_the_type_name_and_reads_the_direction():
    from agent_foundry_python.structured_products.providers.boerse_frankfurt import parse_product_payload

    def parsed(product_type, direction=None):
        payload = {"isin": "DE000EXAMPLE", "productType": product_type, "participationTypeName": direction}
        metadata = parse_product_payload("DE000EXAMPLE", payload).metadata
        return metadata.product_type, metadata.option_type

    # "Faktor ... Optionsschein" is a factor certificate, not a warrant.
    assert parsed("Faktor Short Optionsschein") == ("factor_certificate", "put")
    assert parsed("Optionsschein Put", "Put") == ("optionsschein", "put")
    assert parsed("Knock-Out Call", "Call") == ("knock_out", "call")
    assert parsed("Mini Future Long") == ("open_end_turbo", "call")
    assert parsed("Discount-Zertifikat") == (None, None)


@pytest.mark.asyncio
async def test_master_data_for_another_or_unknown_product_is_unavailable():
    provider = master_data_provider(
        {
            "DE000OTHER00": WARRANT_MASTER_DATA,
            "US0378331005": httpx.Response(404, json={"messages": ["Given ISIN: US0378331005 is not a type of [DERIVATIVE]"]}),
            "DE000LIST000": [],
        }
    )

    assert await provider.get_product_data("DE000OTHER00") is None
    assert await provider.get_product_data("US0378331005") is None
    assert await provider.get_product_data("DE000LIST000") is None
    # A product the exchange does not know is not a refusal of the client.
    assert provider.guard.refused is False


@pytest.mark.asyncio
async def test_a_refusal_ends_requests_to_the_exchange_for_the_rest_of_the_run(caplog):
    requests = []
    refused = httpx.Response(403, text="<html>Access Denied</html>")
    quotes = BoerseFrankfurtQuoteProvider(
        transport=httpx.MockTransport(lambda request: requests.append(str(request.url)) or refused)
    )
    products = master_data_provider(
        {"DE000VY42C94": refused, "DE000HM0T297": KNOCK_OUT_MASTER_DATA}, requests, guard=quotes.guard
    )

    with caplog.at_level("WARNING"):
        assert await products.get_product_data("DE000VY42C94") is None
        # Neither the next product nor the quote endpoint on the same host is asked.
        assert await products.get_product_data("DE000HM0T297") is None
        assert await quotes.get_quote("DE000HM0T297") is None

    assert len(requests) == 1
    assert [record.message for record in caplog.records].count(
        "api.boerse-frankfurt.de refused/unavailable HTTP 403; pausing source for at least 86400 seconds (persisted)"
    ) == 1
