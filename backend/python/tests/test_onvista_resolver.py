import httpx
import pytest

from agent_foundry_python.structured_products.providers.onvista import OnvistaUrlResolver, parse_onvista_metadata, parse_onvista_product_data


ONVISTA_PRODUCT_HTML = """
<html>
  <head><title>HM0T29 • DE000HM0T297 • Knock-Out auf Micron</title></head>
  <body>
    <h1>Open End-Turbo-Optionsschein auf Micron Technology</h1>
    <section>
      <div><div><span>Basispreis</span></div><div><data value="256.7567">256,757 USD</data></div></div>
      <div><div><span>K.O.</span></div><div><data value="256.7567">256,757 USD</data></div></div>
      <div><div><span>Hebel</span></div><div><data value="1.58410080523">1,58x</data></div></div>
      <div><div><span>Bezugsverhältnis</span></div><div><data value="0.01">0,010</data></div></div>
      <div><div><span>Delta</span></div><div><data value="0.582">0,582</data></div></div>
      <div><div><span>Omega</span></div><div><data value="4.21">4,21</data></div></div>
      <div><div><span>Volatilität</span></div><div><data value="63.08">63,08 %</data></div></div>
      <div><span>Bewertungstag</span><div>open end</div></div>
    </section>
    <script id="__NEXT_DATA__" type="application/json">
      {"props":{"pageProps":{"data":{"snapshot":{"instrument":{"isin":"DE000HM0T297","wkn":"HM0T29","name":"OPEN END-TURBO-OPTIONSSCHEIN AUF MICRON TECHNOLOGY INC"}}}}}}
    </script>
  </body>
</html>
"""


@pytest.mark.asyncio
async def test_onvista_url_resolver_uses_public_search_redirect_final_url():
    seen = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        return httpx.Response(
            200,
            text="<html>ok</html>",
            request=request,
            extensions={"history": []},
        )

    resolver = OnvistaUrlResolver(transport=httpx.MockTransport(handler))
    url = await resolver.resolve("DE000HM0T297")

    assert seen["url"] == "https://www.onvista.de/suche?searchValue=DE000HM0T297"
    assert url == "https://www.onvista.de/suche?searchValue=DE000HM0T297"
    await resolver.aclose()


def test_parse_onvista_modern_product_page_extracts_data_value_cards_and_next_data():
    metadata = parse_onvista_metadata(ONVISTA_PRODUCT_HTML)

    assert metadata.isin == "DE000HM0T297"
    assert metadata.wkn == "HM0T29"
    assert metadata.product_type == "open_end_turbo"
    assert metadata.underlying == "Micron Technology"
    assert metadata.leverage == 1.58410080523
    assert metadata.strike_price == 256.7567
    assert metadata.knockout_price == 256.7567
    assert metadata.ratio == 0.01
    assert metadata.expiry is None

    product = parse_onvista_product_data(ONVISTA_PRODUCT_HTML)
    assert product.greek.delta == 0.582
    assert product.greek.omega == 4.21
    assert product.greek.iv == 0.6308
