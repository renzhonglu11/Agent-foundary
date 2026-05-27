import httpx
import pytest

from tr_structured_products.providers.gs_de import GsDeProductProvider, parse_gs_de_product_html


GS_OPTIONSSCHEIN_HTML = """
<html>
  <body>
    <div id="root">
      <h2>Optionsschein-Rechner</h2>
      <div class="issuer-badges">
        <div class="issuer-label">Morgan Stanley</div>
        <span>Aktie</span>
      </div>
      <div class="synonyms">
        <div><span>WKN: MM358P</span></div>
        <div><span>ISIN: DE000MM358P1</span></div>
      </div>
      <ul>
        <li><div>Abst.zum Basispreis</div><div>-20,3100 (-79,1%)</div></li>
        <li><div>Basispreis</div><div>46,00</div></li>
        <li><div>Laufzeit</div><div>17.6.2027</div></li>
        <li><div>Bezugsverhältnis</div><div>1</div></li>
      </ul>
      <div>
        <h3>Parameter</h3>
        <div>Volatilität (jährlich)</div>
        <div>Aktuelle Indikation =</div>
        <div>54,8</div>
      </div>
      <div>
        <h3>Ergebnisse</h3>
        <div>Hebel (Omega)</div>
        <div>2,35</div>
        <div>Delta %</div>
        <div>62,50</div>
        <div>Theta (EUR)</div>
        <div>-0,01 €</div>
      </div>
      <div>
        <h3>Informationen zum Basiswert</h3>
        <div>Live (Indikativ)</div>
        <div>Stand:</div>
        <div>00:53:05</div>
        <a>Mehr Informationen</a>
        <div>Carnival Corporation</div>
        <div>ISIN</div>
        <div>:</div>
        <div>BMG2004J1036</div>
      </div>
    </div>
  </body>
</html>
"""


def test_parse_gs_de_optionsschein_calculator_html_extracts_metadata_and_greeks():
    product = parse_gs_de_product_html(GS_OPTIONSSCHEIN_HTML)

    assert product.metadata.isin == "DE000MM358P1"
    assert product.metadata.wkn == "MM358P"
    assert product.metadata.issuer == "Morgan Stanley"
    assert product.metadata.underlying == "Carnival Corporation"
    assert product.metadata.product_type == "optionsschein"
    assert product.metadata.strike_price == 46.0
    assert product.metadata.expiry == "2027-06-17"
    assert product.metadata.ratio == 1.0
    assert product.greek.delta == 0.625
    assert product.greek.omega == 2.35
    assert product.greek.theta == -0.01
    assert product.greek.iv == pytest.approx(0.548)


@pytest.mark.asyncio
async def test_gs_de_provider_fetches_optionsschein_calculator_by_isin():
    seen = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        return httpx.Response(200, text=GS_OPTIONSSCHEIN_HTML, request=request)

    provider = GsDeProductProvider(transport=httpx.MockTransport(handler))
    product = await provider.get_product_data("DE000MM358P1")

    assert seen["url"] == "https://www.gs.de/de/optionsschein-rechner?isin=DE000MM358P1"
    assert product.metadata.isin == "DE000MM358P1"
    assert product.source == "gs.de"
    assert product.url == seen["url"]
    await provider.aclose()


@pytest.mark.asyncio
async def test_gs_de_provider_ignores_mismatched_isin_response():
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text=GS_OPTIONSSCHEIN_HTML, request=request)

    provider = GsDeProductProvider(transport=httpx.MockTransport(handler))
    product = await provider.get_product_data("DE000OTHER01")

    assert product is None
    await provider.aclose()
