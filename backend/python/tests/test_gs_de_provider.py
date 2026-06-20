import json

import httpx
import pytest

from agent_foundry_python.structured_products.providers.gs_de import (
    GsDeProductProvider,
    parse_gs_de_product_graphql,
    parse_gs_de_product_html,
)


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

GS_AMD_GRAPHQL = {
    "data": {
        "getSecuritizedProduct": {
            "id": "DE000HT0Q0Z8",
            "status": "ACTIVE",
            "synonyms": {"isn": "DE000HT0Q0Z8", "wpk": "HT0Q0Z", "ticker": None, "trn": None},
            "issuanceInfo": {"issuer": {"symbol": "HSBC", "name": "HSBC Trinkaus & Burkhardt GmbH"}},
            "classificationInfo": {"flavour": {"code": "COVPLAIN", "description": "Optionsschein"}},
            "assets": [
                {
                    "name": "AMD",
                    "fullName": "AMD - Advanced Micro Devices",
                    "currency": "USD",
                    "assetSynonyms": {"isn": "US0079031078", "ticker": None},
                    "assetPrice": {"spotPrice": 488.44},
                    "lastDayPrice": {"spotPrice": 452.5},
                }
            ],
            "productTerms": {
                "ratio": 0.1,
                "expirationDate": {"year": 2026, "month": "DECEMBER", "day": 18, "localeFormatted": "2026-12-18"},
                "levels": [{"direction": None, "claimType": {"key": "CALL", "description": "Call"}}],
                "underlyers": [{"ratio": 10}],
                "strike": 160,
            },
            "economics": {
                "realTimeData": {
                    "tradableStatus": False,
                    "delta": 0.89,
                    "breakEven": 273.044,
                    "impliedVolatility": 61.36,
                    "leverage": None,
                    "omega": 2.05,
                    "vega": 0.0408,
                    "distanceToStrike": {"absolute": 328.44, "relative": 67.24},
                },
                "price": {"bid": 28.93000030517578, "ask": 0, "spot": None, "time": 1781207977000},
            },
        }
    }
}

GS_FACTOR_GRAPHQL = {
    "data": {
        "getSecuritizedProduct": {
            "id": "DE000SX1Y9R4",
            "status": "INVALID",
            "synonyms": {"isn": "DE000SX1Y9R4", "wpk": "SX1Y9R", "ticker": None, "trn": None},
            "issuanceInfo": {"issuer": {"symbol": "Société Générale", "name": "Société Générale Effekten GmbH"}},
            "classificationInfo": {"flavour": {"code": "RFACTPLAIN", "description": "Faktor Optionsschein"}},
            "assets": [
                {
                    "name": "Tesla",
                    "fullName": "Tesla Inc",
                    "currency": "USD",
                    "assetSynonyms": {"isn": "US88160R1014", "ticker": None},
                    "assetPrice": {"spotPrice": 406.28},
                    "lastDayPrice": {"spotPrice": 398.86},
                }
            ],
            "productTerms": {
                "ratio": 1,
                "expirationDate": None,
                "levels": [{"direction": {"key": "DOWN", "description": "Long"}, "claimType": None}],
                "underlyers": [{"ratio": 1}],
                "factor": 3,
                "strike": None,
            },
            "economics": {
                "realTimeData": {"tradableStatus": False},
                "price": {"bid": 3.0399999618530273, "ask": 3.049999952316284, "spot": None, "time": 1755530570000},
            },
        }
    }
}

GS_TSMC_GRAPHQL_WITHOUT_GREEKS = {
    "data": {
        "getSecuritizedProduct": {
            "id": "DE000SJ7BGU6",
            "status": "ACTIVE",
            "synonyms": {"isn": "DE000SJ7BGU6", "wpk": "SJ7BGU", "ticker": None, "trn": None},
            "issuanceInfo": {"issuer": {"symbol": "Société Générale", "name": "Société Générale Effekten GmbH"}},
            "classificationInfo": {"flavour": {"code": "COVPLAIN", "description": "Optionsschein"}},
            "assets": [
                {
                    "name": "Taiwan Semiconductor Manufacturing Company",
                    "fullName": "Taiwan Semiconductor Manufacturing Company Ltd.",
                    "currency": "USD",
                    "assetSynonyms": {"isn": "US8740391003", "ticker": None},
                    "assetPrice": {"spotPrice": 424.57},
                    "lastDayPrice": {"spotPrice": 421.34},
                }
            ],
            "productTerms": {
                "ratio": 0.1,
                "expirationDate": {"year": 2026, "month": "JUNE", "day": 18, "localeFormatted": "2026-06-18"},
                "levels": [{"direction": None, "claimType": {"key": "CALL", "description": "Call"}}],
                "underlyers": [{"ratio": 10}],
                "strike": 215,
            },
            "economics": {
                "realTimeData": {
                    "tradableStatus": False,
                    "delta": None,
                    "breakEven": 411.134,
                    "impliedVolatility": None,
                    "leverage": None,
                    "omega": None,
                    "vega": None,
                    "distanceToStrike": {"absolute": 209.57, "relative": 49.36},
                },
                "price": {"bid": 18.040000915527344, "ask": 0, "spot": None, "time": 1781294425000},
            },
        }
    }
}

GS_TSMC_CALCULATOR_HTML = """
<html>
  <body>
    <div id="root">
      <div class="issuer-badges"><div>Société Générale Effekten GmbH</div></div>
      <span>WKN: SJ7BGU</span>
      <span>ISIN: DE000SJ7BGU6</span>
      <ul>
        <li><div>Basispreis</div><div>215,00</div></li>
        <li><div>Laufzeit</div><div>18.6.2026</div></li>
        <li><div>Bezugsverhältnis</div><div>0,1</div></li>
      </ul>
      <div>Volatilität (jährlich)</div>
      <div>Aktuelle Indikation =</div>
      <div>42,0</div>
      <div>Hebel (Omega)</div>
      <div>8,50</div>
      <div>Delta %</div>
      <div>88,00</div>
      <div>Theta (EUR)</div>
      <div>-0,04 €</div>
      <div>Informationen zum Basiswert</div>
      <a>Mehr Informationen</a>
      <div>Taiwan Semiconductor Manufacturing Company Ltd.</div>
    </div>
  </body>
</html>
"""

GS_AMD_CALCULATOR_HTML = """
<html>
  <body>
    <div id="root">
      <h2>Optionsschein-Rechner</h2>
      <span>WKN: HT0Q0Z</span>
      <span>ISIN: DE000HT0Q0Z8</span>
      <ul>
        <li><div>Basispreis</div><div>160,00</div></li>
        <li><div>Laufzeit</div><div>18.12.2026</div></li>
        <li><div>Bezugsverhältnis</div><div>0,1</div></li>
      </ul>
      <div>Delta %</div>
      <div>82,00</div>
      <div>Hebel (Omega)</div>
      <div>3,50</div>
      <div>Theta (EUR)</div>
      <div>-0,01</div>
      <div>Volatilität (jährlich)</div>
      <div>Aktuelle Indikation =</div>
      <div>62,0</div>
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


def test_parse_gs_de_graphql_extracts_amd_optionsschein_metadata_and_greeks():
    product = parse_gs_de_product_graphql(GS_AMD_GRAPHQL)

    assert product.metadata.isin == "DE000HT0Q0Z8"
    assert product.metadata.wkn == "HT0Q0Z"
    assert product.metadata.issuer == "HSBC Trinkaus & Burkhardt GmbH"
    assert product.metadata.underlying == "AMD - Advanced Micro Devices"
    assert product.metadata.product_type == "optionsschein"
    assert product.metadata.strike_price == 160
    assert product.metadata.expiry == "2026-12-18"
    assert product.metadata.ratio == 0.1
    assert product.metadata.option_type == "call"
    assert product.metadata.break_even == 273.044
    assert product.greek.delta == 0.89
    assert product.greek.omega == 2.05
    assert product.greek.iv == pytest.approx(0.6136)


def test_parse_gs_de_graphql_extracts_factor_certificate_leverage_and_direction():
    product = parse_gs_de_product_graphql(GS_FACTOR_GRAPHQL)

    assert product.metadata.isin == "DE000SX1Y9R4"
    assert product.metadata.wkn == "SX1Y9R"
    assert product.metadata.underlying == "Tesla Inc"
    assert product.metadata.product_type == "factor_certificate"
    assert product.metadata.leverage == 3
    assert product.metadata.ratio == 1
    assert product.metadata.option_type == "call"
    assert product.greek is None


@pytest.mark.asyncio
async def test_gs_de_provider_prefers_graphql_product_by_isin():
    seen = []

    async def handler(request: httpx.Request) -> httpx.Response:
        seen.append((request.method, str(request.url)))
        if request.method == "POST":
            return httpx.Response(200, json=GS_AMD_GRAPHQL, request=request)
        # Calculator HTML fallback — GraphQL lacks theta, so fallback is triggered
        return httpx.Response(
            200,
            text=GS_AMD_CALCULATOR_HTML,
            request=request,
        )

    provider = GsDeProductProvider(transport=httpx.MockTransport(handler))
    product = await provider.get_product_data("DE000HT0Q0Z8")

    assert seen == [
        ("POST", "https://www.gs.de/graphql"),
        ("GET", "https://www.gs.de/de/optionsschein-rechner?isin=DE000HT0Q0Z8"),
    ]
    assert product.metadata.isin == "DE000HT0Q0Z8"
    assert product.greek.delta == 0.89  # GraphQL value preferred
    assert product.greek.theta == -0.01  # Filled from calculator fallback
    assert product.url == "https://www.gs.de/de/optionsschein-rechner?isin=DE000HT0Q0Z8"
    await provider.aclose()


@pytest.mark.asyncio
async def test_gs_de_provider_merges_calculator_greeks_when_graphql_has_metadata_only():
    seen = []

    async def handler(request: httpx.Request) -> httpx.Response:
        seen.append((request.method, str(request.url)))
        if request.method == "POST":
            return httpx.Response(200, json=GS_TSMC_GRAPHQL_WITHOUT_GREEKS, request=request)
        return httpx.Response(200, text=GS_TSMC_CALCULATOR_HTML, request=request)

    provider = GsDeProductProvider(transport=httpx.MockTransport(handler))
    product = await provider.get_product_data("DE000SJ7BGU6")

    assert seen == [
        ("POST", "https://www.gs.de/graphql"),
        ("GET", "https://www.gs.de/de/optionsschein-rechner?isin=DE000SJ7BGU6"),
    ]
    assert product.metadata.isin == "DE000SJ7BGU6"
    assert product.metadata.underlying == "Taiwan Semiconductor Manufacturing Company Ltd."
    assert product.metadata.break_even == 411.134
    assert product.greek.delta == 0.88
    assert product.greek.omega == 8.5
    assert product.greek.theta == -0.04
    assert product.greek.iv == pytest.approx(0.42)
    await provider.aclose()


@pytest.mark.asyncio
async def test_gs_de_provider_falls_back_to_optionsschein_calculator_by_isin():
    seen = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        if request.method == "POST":
            return httpx.Response(503, json={"errors": [{"message": "unavailable"}]}, request=request)
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
        if request.method == "POST":
            payload = json.loads(json.dumps(GS_AMD_GRAPHQL))
            payload["data"]["getSecuritizedProduct"]["synonyms"]["isn"] = "DE000MM358P1"
            return httpx.Response(200, json=payload, request=request)
        return httpx.Response(200, text=GS_OPTIONSSCHEIN_HTML, request=request)

    provider = GsDeProductProvider(transport=httpx.MockTransport(handler))
    product = await provider.get_product_data("DE000OTHER01")

    assert product is None
    await provider.aclose()
