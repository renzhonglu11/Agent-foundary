import httpx
import pytest

from tr_structured_products.providers.finanzen_net import (
    FinanzenNetProductProvider,
    FinanzenNetUrlResolver,
    parse_finanzen_product_html,
)


PRODUCT_HTML = """
<html>
  <head><title>Optionsschein DE000ABC1234</title></head>
  <body>
    <h1>Call Optionsschein auf Micron</h1>
    <table>
      <tr><td>ISIN</td><td>DE000ABC1234</td></tr>
      <tr><td>WKN</td><td>ABC123</td></tr>
      <tr><td>Emittent</td><td>HSBC Trinkaus & Burkhardt GmbH</td></tr>
      <tr><td>Basiswert</td><td>Micron Technology</td></tr>
      <tr><td>Produkttyp</td><td>Optionsschein</td></tr>
      <tr><td>Hebel</td><td>4,32</td></tr>
      <tr><td>Delta</td><td>0,61</td></tr>
      <tr><td>Omega</td><td>3,40</td></tr>
      <tr><td>Theta</td><td>-0,02</td></tr>
      <tr><td>Impl. Volatilität</td><td>54,2 %</td></tr>
      <tr><td>Basispreis</td><td>104,00 USD</td></tr>
      <tr><td>Bezugsverhältnis</td><td>0,1</td></tr>
      <tr><td>Fälligkeit</td><td>18.12.2026</td></tr>
    </table>
  </body>
</html>
"""


SEARCH_HTML = """
<html><body>
  <a href="/optionsscheine/de000abc1234-call-optionsschein-micron">DE000ABC1234 Call Optionsschein Micron</a>
  <a href="/aktien/micron-aktie">Micron Aktie</a>
</body></html>
"""


def test_parse_finanzen_product_html_extracts_metadata_and_greeks():
    product = parse_finanzen_product_html(PRODUCT_HTML)

    assert product.metadata.isin == "DE000ABC1234"
    assert product.metadata.wkn == "ABC123"
    assert product.metadata.issuer == "HSBC Trinkaus & Burkhardt GmbH"
    assert product.metadata.underlying == "Micron Technology"
    assert product.metadata.product_type == "optionsschein"
    assert product.metadata.leverage == 4.32
    assert product.metadata.strike_price == 104.0
    assert product.metadata.ratio == 0.1
    assert product.metadata.expiry == "2026-12-18"
    assert product.greek.delta == 0.61
    assert product.greek.omega == 3.40
    assert product.greek.theta == -0.02
    assert product.greek.iv == 0.542


@pytest.mark.asyncio
async def test_finanzen_url_resolver_searches_by_isin_and_returns_matching_product_url():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        return httpx.Response(200, text=SEARCH_HTML)

    resolver = FinanzenNetUrlResolver(transport=httpx.MockTransport(handler))

    url = await resolver.resolve("DE000ABC1234")

    assert "DE000ABC1234" in seen["url"]
    assert url == "https://www.finanzen.net/optionsscheine/de000abc1234-call-optionsschein-micron"
    await resolver.aclose()


@pytest.mark.asyncio
async def test_finanzen_provider_resolves_url_and_parses_product_page():
    requests = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(str(request.url))
        if "suchergebnis" in str(request.url):
            return httpx.Response(200, text=SEARCH_HTML)
        return httpx.Response(200, text=PRODUCT_HTML)

    provider = FinanzenNetProductProvider(transport=httpx.MockTransport(handler))

    product = await provider.get_product_data("DE000ABC1234")

    assert product is not None
    assert product.metadata.leverage == 4.32
    assert product.greek.delta == 0.61
    assert any("suchergebnis" in url for url in requests)
    assert any("optionsscheine" in url for url in requests)
    await provider.aclose()
