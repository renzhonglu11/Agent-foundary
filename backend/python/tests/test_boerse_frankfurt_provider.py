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


@pytest.mark.asyncio
async def test_boerse_frankfurt_quote_provider_treats_missing_price_as_unavailable():
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"currency": "EUR"})

    provider = BoerseFrankfurtQuoteProvider(transport=httpx.MockTransport(handler))

    quote = await provider.get_quote("DE000HM0T297")

    assert quote is None
    await provider.aclose()
