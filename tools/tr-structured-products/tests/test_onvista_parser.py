import httpx
import pytest

from tr_structured_products.providers.onvista import OnvistaMetadataProvider, parse_onvista_metadata


ONVISTA_HTML = """
<html>
  <body>
    <main>
      <h1>Open End Turbo Long auf Micron Technology</h1>
      <dl>
        <dt>Emittent</dt><dd>HSBC</dd>
        <dt>WKN</dt><dd>HM0T29</dd>
        <dt>ISIN</dt><dd>DE000HM0T297</dd>
        <dt>Basiswert</dt><dd>Micron Technology</dd>
        <dt>Produkttyp</dt><dd>Open-End Turbo</dd>
        <dt>Hebel</dt><dd>1,55</dd>
        <dt>Basispreis</dt><dd>256,757 USD</dd>
        <dt>Knock-Out</dt><dd>256,757 USD</dd>
        <dt>Bezugsverhältnis</dt><dd>0,01</dd>
        <dt>Fälligkeit</dt><dd>Open End</dd>
      </dl>
    </main>
  </body>
</html>
"""


def test_parse_onvista_metadata_from_server_rendered_definition_list():
    metadata = parse_onvista_metadata(ONVISTA_HTML)

    assert metadata.isin == "DE000HM0T297"
    assert metadata.wkn == "HM0T29"
    assert metadata.issuer == "HSBC"
    assert metadata.underlying == "Micron Technology"
    assert metadata.product_type == "open_end_turbo"
    assert metadata.leverage == 1.55
    assert metadata.strike_price == 256.757
    assert metadata.knockout_price == 256.757
    assert metadata.ratio == 0.01
    assert metadata.expiry is None


def test_parse_onvista_metadata_handles_optionsschein_product_type():
    html = ONVISTA_HTML.replace("Open-End Turbo", "Optionsschein").replace("Open End", "19.06.2026")

    metadata = parse_onvista_metadata(html)

    assert metadata.product_type == "optionsschein"
    assert metadata.expiry == "2026-06-19"


@pytest.mark.asyncio
async def test_onvista_provider_get_metadata_uses_injected_isin_url_resolver():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        return httpx.Response(200, text=ONVISTA_HTML)

    provider = OnvistaMetadataProvider(
        transport=httpx.MockTransport(handler),
        url_resolver=lambda isin: f"https://www.onvista.de/derivate/{isin}",
    )

    metadata = await provider.get_metadata("DE000HM0T297")
    await provider.aclose()

    assert seen["url"] == "https://www.onvista.de/derivate/DE000HM0T297"
    assert metadata is not None
    assert metadata.isin == "DE000HM0T297"


@pytest.mark.asyncio
async def test_onvista_provider_get_metadata_returns_none_without_url_resolver():
    provider = OnvistaMetadataProvider()

    metadata = await provider.get_metadata("DE000HM0T297")
    await provider.aclose()

    assert metadata is None
