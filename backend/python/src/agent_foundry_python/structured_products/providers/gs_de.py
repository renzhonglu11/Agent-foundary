from __future__ import annotations

import asyncio
import logging
import re
from dataclasses import dataclass
from datetime import datetime
from typing import Any

import httpx
from bs4 import BeautifulSoup

from agent_foundry_python.structured_products.models import Greek, InstrumentMetadata

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class ProductData:
    metadata: InstrumentMetadata
    greek: Greek | None = None
    source: str = "gs.de"
    url: str | None = None


from playwright.async_api import async_playwright, Browser, Playwright, Page


GS_PRODUCT_QUERY = """
query getSecuritizedProduct($id: ID!) {
  getSecuritizedProduct(id: $id) {
    id
    status
    synonyms {
      isn
      wpk
      ticker
      trn
    }
    issuanceInfo {
      issuer {
        symbol
        name
      }
    }
    classificationInfo {
      flavour {
        code
        description
      }
    }
    assets {
      name
      fullName
      currency
      assetSynonyms {
        isn
        ticker
      }
      assetPrice {
        spotPrice
      }
      lastDayPrice {
        spotPrice
      }
    }
    productTerms {
      ratio
      expirationDate {
        year
        month
        day
        localeFormatted
      }
      levels {
        direction {
          key
          description
        }
        claimType {
          key
          description
        }
      }
      underlyers {
        ratio
      }
      ... on VanillaWarrantTerms {
        strike
      }
      ... on DiscountWarrantTerms {
        strike
        cap
      }
      ... on LeveragedOneDeltaTerms {
        strike
        knockOut
      }
      ... on FactorCertificateTerms {
        factor
        strike
      }
    }
    economics {
      realTimeData {
        tradableStatus
        ... on LeveragedOneDeltaRealTime {
          leverage
          distanceToKnockout {
            absolute
            relative
          }
        }
        ... on VanillaWarrantRealTime {
          delta
          breakEven
          impliedVolatility
          leverage
          omega
          vega
          distanceToStrike {
            absolute
            relative
          }
        }
        ... on DiscountWarrantRealTime {
          delta
          breakEven
          impliedVolatility
          leverage
          omega
          vega
        }
      }
      price {
        bid
        ask
        spot
        time
      }
    }
  }
}
"""


class GsDeProductProvider:
    """GS Markets optionsschein calculator metadata + Greeks provider."""

    BASE_URL = "https://www.gs.de/de/optionsschein-rechner"
    GRAPHQL_URL = "https://www.gs.de/graphql"

    def __init__(self, *, timeout: float = 20.0, transport: Any | None = None) -> None:
        self._timeout_seconds = timeout
        self._playwright_timeout = timeout * 1000
        self._transport = transport
        self._playwright: Playwright | None = None
        self._browser: Browser | None = None
        self._page: Page | None = None
        self._page_lock = asyncio.Lock()

    async def _init_browser(self) -> Page:
        if self._page is not None:
            return self._page
        
        self._playwright = await async_playwright().start()
        self._browser = await self._playwright.chromium.launch(
            headless=True,
            args=["--no-sandbox", "--disable-setuid-sandbox"],
        )
        context = await self._browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            locale="de-DE",
        )
        self._page = await context.new_page()
        return self._page

    async def get_product_data(self, isin: str) -> ProductData | None:
        url = f"{self.BASE_URL}?isin={isin}"
        try:
            graphql_product = await self._fetch_graphql_product(isin, url)
            if graphql_product is not None and not _needs_calculator_fallback(graphql_product):
                return graphql_product

            calculator_product = await self._fetch_calculator_product(url)
            if calculator_product is not None and calculator_product.metadata.isin.upper() == isin.upper():
                if graphql_product is not None:
                    product = _merge_product_data(graphql_product, calculator_product)
                    return ProductData(metadata=product.metadata, greek=product.greek, source="gs.de", url=url)
                return ProductData(metadata=calculator_product.metadata, greek=calculator_product.greek, source="gs.de", url=url)

            return graphql_product
        except Exception as exc:
            logger.debug("gs.de product fallback failed for %s: %s", isin, exc)
            return None

    async def _fetch_calculator_product(self, url: str) -> ProductData | None:
        try:
            if self._transport is not None:
                async with httpx.AsyncClient(transport=self._transport) as client:
                    response = await client.get(url)
                    response.raise_for_status()
                    html = response.text
            else:
                async with self._page_lock:
                    page = await self._init_browser()
                    await page.goto(url, wait_until="domcontentloaded", timeout=self._playwright_timeout)
                    # Wait to allow client-side JS to execute Black-Scholes calculation.
                    await page.wait_for_timeout(2000)
                    html = await page.content()
            return parse_gs_de_product_html(html)
        except Exception as exc:
            logger.debug("gs.de calculator lookup failed for %s: %s", url, exc)
            return None

    async def _fetch_graphql_product(self, isin: str, product_url: str) -> ProductData | None:
        try:
            async with httpx.AsyncClient(transport=self._transport, timeout=self._timeout_seconds) as client:
                response = await client.post(
                    self.GRAPHQL_URL,
                    headers={
                        "accept": "*/*",
                        "content-type": "application/json",
                        "origin": "https://www.gs.de",
                        "referer": product_url,
                        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                    },
                    json={
                        "operationName": "getSecuritizedProduct",
                        "variables": {"id": isin},
                        "query": GS_PRODUCT_QUERY,
                    },
                )
                response.raise_for_status()
                product = parse_gs_de_product_graphql(response.json())
                if product.metadata.isin.upper() != isin.upper():
                    return None
                return ProductData(metadata=product.metadata, greek=product.greek, source="gs.de", url=product_url)
        except Exception as exc:
            logger.debug("gs.de GraphQL lookup failed for %s: %s", isin, exc)
            return None

    async def aclose(self) -> None:
        if self._browser is not None:
            await self._browser.close()
            self._browser = None
        if self._playwright is not None:
            await self._playwright.stop()
            self._playwright = None


def parse_gs_de_product_html(html: str) -> ProductData:
    soup = BeautifulSoup(html, "lxml")
    tokens = _visible_tokens(soup)
    fields = _extract_fields(soup, tokens)

    isin = str(fields.get("isin") or _find_isin(" ".join(tokens)) or "")
    if not isin:
        raise ValueError("gs.de HTML does not contain an ISIN")

    # Determine option direction
    is_put = any("put" in token.lower() or "bear" in token.lower() or "short" in token.lower() for token in tokens)
    option_type = "put" if is_put else "call"

    metadata = InstrumentMetadata(
        isin=isin,
        wkn=_as_text(fields.get("wkn")),
        issuer=_as_text(fields.get("issuer")),
        underlying=_as_text(fields.get("underlying")),
        product_type="optionsschein",
        strike_price=_parse_decimal(fields.get("strike_price")),
        ratio=_parse_decimal(fields.get("ratio")),
        expiry=_parse_expiry(_as_text(fields.get("expiry"))),
        option_type=option_type,
    )

    greek_values = {
        "delta": _parse_delta(fields.get("delta")),
        "omega": _parse_decimal(fields.get("omega")),
        "theta": _parse_decimal(fields.get("theta")),
        "iv": _parse_percent(fields.get("iv")),
    }
    greek_values = {key: value for key, value in greek_values.items() if value is not None}
    greek = Greek(isin=isin, **greek_values) if greek_values else None
    return ProductData(metadata=metadata, greek=greek, source="gs.de")


def parse_gs_de_product_graphql(payload: dict[str, Any]) -> ProductData:
    product = _get_path(payload, "data", "getSecuritizedProduct")
    if not isinstance(product, dict):
        raise ValueError("gs.de GraphQL response does not contain product data")

    synonyms = _as_dict(product.get("synonyms"))
    product_terms = _as_dict(product.get("productTerms"))
    economics = _as_dict(product.get("economics"))
    real_time = _as_dict(economics.get("realTimeData"))
    issuer = _as_dict(_get_path(product, "issuanceInfo", "issuer"))
    flavour = _as_dict(_get_path(product, "classificationInfo", "flavour"))
    assets = product.get("assets") if isinstance(product.get("assets"), list) else []
    first_asset = _as_dict(assets[0]) if assets else {}

    isin = _as_text(synonyms.get("isn") or product.get("id"))
    if not isin:
        raise ValueError("gs.de GraphQL product does not contain an ISIN")

    option_type = _option_type_from_graphql(product_terms)
    product_type = _product_type_from_graphql(flavour)

    metadata = InstrumentMetadata(
        isin=isin,
        wkn=_as_text(synonyms.get("wpk")),
        issuer=_as_text(issuer.get("name") or issuer.get("symbol")),
        underlying=_as_text(first_asset.get("fullName") or first_asset.get("name")),
        product_type=product_type,
        leverage=_parse_number(real_time.get("leverage") or product_terms.get("factor")),
        strike_price=_parse_number(product_terms.get("strike")),
        knockout_price=_parse_number(product_terms.get("knockOut")),
        break_even=_parse_number(real_time.get("breakEven")),
        ratio=_parse_number(product_terms.get("ratio")) or _ratio_from_underlyers(product_terms),
        expiry=_parse_graphql_date(product_terms.get("expirationDate")),
        option_type=option_type,
    )

    greek_values = {
        "delta": _parse_graphql_ratio(real_time.get("delta")),
        "omega": _parse_number(real_time.get("omega")),
        "iv": _parse_graphql_ratio(real_time.get("impliedVolatility")),
    }
    greek_values = {key: value for key, value in greek_values.items() if value is not None}
    greek = Greek(isin=isin, **greek_values) if greek_values else None
    return ProductData(metadata=metadata, greek=greek, source="gs.de")


def _needs_calculator_fallback(product: ProductData) -> bool:
    if product.metadata.product_type != "optionsschein":
        return False
    greek = product.greek
    return greek is None or any(getattr(greek, field) is None for field in ("delta", "omega", "iv"))


def _merge_product_data(primary: ProductData, fallback: ProductData) -> ProductData:
    metadata_updates = {}
    for field in (
        "wkn",
        "issuer",
        "underlying",
        "product_type",
        "leverage",
        "strike_price",
        "knockout_price",
        "break_even",
        "ratio",
        "expiry",
        "option_type",
        "reset_barrier",
    ):
        if getattr(primary.metadata, field) in (None, "") and getattr(fallback.metadata, field) not in (None, ""):
            metadata_updates[field] = getattr(fallback.metadata, field)
    metadata = primary.metadata.model_copy(update=metadata_updates) if metadata_updates else primary.metadata

    greek = primary.greek
    if fallback.greek is not None:
        if greek is None:
            greek = fallback.greek
        else:
            greek_updates = {}
            for field in ("delta", "omega", "theta", "iv"):
                if getattr(greek, field) is None and getattr(fallback.greek, field) is not None:
                    greek_updates[field] = getattr(fallback.greek, field)
            if greek_updates:
                greek = greek.model_copy(update=greek_updates)

    return ProductData(metadata=metadata, greek=greek, source=primary.source, url=primary.url)


def _option_type_from_graphql(product_terms: dict[str, Any]) -> str | None:
    levels = product_terms.get("levels")
    if not isinstance(levels, list):
        return None
    for level in levels:
        level_data = _as_dict(level)
        claim_type = _as_dict(level_data.get("claimType"))
        value = _as_text(claim_type.get("key") or claim_type.get("description"))
        option_type = _direction_text_to_option_type(value)
        if option_type is not None:
            return option_type

        direction = _as_dict(level_data.get("direction"))
        direction_value = _as_text(direction.get("description") or direction.get("key"))
        option_type = _direction_text_to_option_type(direction_value)
        if option_type is not None:
            return option_type
    return None


def _direction_text_to_option_type(value: str | None) -> str | None:
    if value is None:
        return None
    normalized = value.casefold()
    if "put" in normalized or "short" in normalized:
        return "put"
    if "call" in normalized or "long" in normalized:
        return "call"
    return None


def _product_type_from_graphql(flavour: dict[str, Any]) -> str | None:
    text = " ".join(
        value
        for value in (_as_text(flavour.get("code")), _as_text(flavour.get("description")))
        if value
    ).casefold()
    if "faktor" in text or "factor" in text:
        return "factor_certificate"
    if "turbo" in text or "knock" in text:
        return "open_end_turbo"
    if "optionsschein" in text or "warrant" in text or "covplain" in text:
        return "optionsschein"
    return _as_text(flavour.get("description"))


def _ratio_from_underlyers(product_terms: dict[str, Any]) -> float | None:
    underlyers = product_terms.get("underlyers")
    if not isinstance(underlyers, list) or not underlyers:
        return None
    raw_ratio = _parse_number(_as_dict(underlyers[0]).get("ratio"))
    if raw_ratio is None or raw_ratio == 0:
        return None
    return 1 / raw_ratio


def _parse_graphql_date(value: Any) -> str | None:
    data = _as_dict(value)
    formatted = _as_text(data.get("localeFormatted"))
    if formatted:
        return _parse_expiry(formatted)

    year = _parse_int(data.get("year"))
    day = _parse_int(data.get("day"))
    month = _parse_graphql_month(data.get("month"))
    if year is None or month is None or day is None:
        return None
    try:
        return datetime(year, month, day).date().isoformat()
    except ValueError:
        return None


def _parse_graphql_month(value: Any) -> int | None:
    if isinstance(value, int):
        return value
    text = _as_text(value)
    if text is None:
        return None
    month_names = {
        "JANUARY": 1,
        "FEBRUARY": 2,
        "MARCH": 3,
        "APRIL": 4,
        "MAY": 5,
        "JUNE": 6,
        "JULY": 7,
        "AUGUST": 8,
        "SEPTEMBER": 9,
        "OCTOBER": 10,
        "NOVEMBER": 11,
        "DECEMBER": 12,
    }
    if text.upper() in month_names:
        return month_names[text.upper()]
    return _parse_int(text)


def _parse_int(value: Any) -> int | None:
    number = _parse_number(value)
    return int(number) if number is not None else None


def _parse_number(value: Any) -> float | None:
    if isinstance(value, int | float):
        return float(value)
    return _parse_decimal(value)


def _parse_graphql_ratio(value: Any) -> float | None:
    number = _parse_number(value)
    if number is None:
        return None
    return number / 100 if abs(number) > 1 else number


def _as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _get_path(value: Any, *path: str) -> Any:
    current = value
    for key in path:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return current


def _extract_fields(soup: BeautifulSoup, tokens: list[str]) -> dict[str, str]:
    fields: dict[str, str] = {}
    fields.update(_extract_product_header_fields(soup))
    fields.update(_extract_detail_list_fields(soup))
    fields.update(_extract_token_fields(tokens))
    return fields


def _extract_product_header_fields(soup: BeautifulSoup) -> dict[str, str]:
    fields: dict[str, str] = {}
    issuer_badges = soup.select_one(".issuer-badges")
    if issuer_badges is not None:
        badges = [node.get_text(" ", strip=True) for node in issuer_badges.find_all(["div", "span"], recursive=False)]
        if badges:
            fields["issuer"] = badges[0]

    for span in soup.find_all("span"):
        text = span.get_text(" ", strip=True)
        if text.startswith("WKN:"):
            fields["wkn"] = text.split(":", 1)[1].strip()
        elif text.startswith("ISIN:"):
            fields["isin"] = text.split(":", 1)[1].strip()
    return fields


def _extract_detail_list_fields(soup: BeautifulSoup) -> dict[str, str]:
    aliases = {
        "basispreis": "strike_price",
        "laufzeit": "expiry",
        "bezugsverhältnis": "ratio",
    }
    fields: dict[str, str] = {}
    for item in soup.find_all("li"):
        children = [child for child in item.find_all("div", recursive=False) if child.get_text(" ", strip=True)]
        if len(children) < 2:
            continue
        key = aliases.get(_normalize_label(children[0].get_text(" ", strip=True)))
        if key:
            fields[key] = children[1].get_text(" ", strip=True)
    return fields


def _extract_token_fields(tokens: list[str]) -> dict[str, str]:
    fields: dict[str, str] = {}
    token_aliases = {
        "WKN:": "wkn",
        "ISIN:": "isin",
        "Basispreis": "strike_price",
        "Laufzeit": "expiry",
        "Bezugsverhältnis": "ratio",
        "Hebel (Omega)": "omega",
        "Delta %": "delta",
        "Theta (EUR)": "theta",
    }
    for token, key in token_aliases.items():
        value = _token_after(tokens, token)
        if value is not None:
            fields[key] = value

    iv = _value_after_current_indication(tokens, "Volatilität (jährlich)")
    if iv is not None:
        fields["iv"] = iv

    underlying = _underlying_from_tokens(tokens)
    if underlying is not None:
        fields["underlying"] = underlying
    return fields


def _value_after_current_indication(tokens: list[str], label: str) -> str | None:
    start = _index_of(tokens, label)
    if start is None:
        return None
    for index in range(start + 1, min(len(tokens), start + 8)):
        if tokens[index] == "Aktuelle Indikation =":
            return _next_value(tokens, index + 1)
    return None


def _underlying_from_tokens(tokens: list[str]) -> str | None:
    info_index = _index_of(tokens, "Informationen zum Basiswert")
    if info_index is None:
        return None
    more_info_index = _index_of(tokens, "Mehr Informationen", start=info_index)
    if more_info_index is not None:
        value = _next_value(tokens, more_info_index + 1)
        if value and value not in {"ISIN", ":"}:
            return value
    isin_index = _index_of(tokens, "ISIN", start=info_index)
    if isin_index is not None and isin_index > info_index:
        candidates = [token for token in tokens[info_index + 1 : isin_index] if token not in {"Live (Indikativ)", "Stand:", "Mehr Informationen"}]
        candidates = [token for token in candidates if not re.fullmatch(r"\d{1,2}:\d{2}:\d{2}", token)]
        if candidates:
            return candidates[-1]
    return None


def _token_after(tokens: list[str], token: str) -> str | None:
    index = _index_of(tokens, token)
    if index is None:
        return None
    return _next_value(tokens, index + 1)


def _next_value(tokens: list[str], start: int) -> str | None:
    for token in tokens[start:]:
        if token in {":", "(", ")"}:
            continue
        return token
    return None


def _index_of(tokens: list[str], needle: str, *, start: int = 0) -> int | None:
    try:
        return tokens.index(needle, start)
    except ValueError:
        return None


def _visible_tokens(soup: BeautifulSoup) -> list[str]:
    root = soup.find(id="root") or soup.body or soup
    return [token.strip() for token in root.get_text("\n", strip=True).splitlines() if token.strip()]


def _normalize_label(label: str) -> str:
    return " ".join(label.casefold().replace(":", " ").split())


def _as_text(value: Any) -> str | None:
    if value is None:
        return None
    text = " ".join(str(value).split()).strip()
    return text or None


def _parse_decimal(value: Any) -> float | None:
    text = _as_text(value)
    if text is None or text == "-":
        return None
    match = re.search(r"[-+]?\d+(?:[.,]\d+)?", text.replace("\u00a0", " ").replace("\u202f", " "))
    if not match:
        return None
    raw = match.group(0)
    return float(raw.replace(".", "").replace(",", ".") if "," in raw else raw)


def _parse_delta(value: Any) -> float | None:
    number = _parse_decimal(value)
    if number is None or number == 0:
        return None
    return number / 100


def _parse_percent(value: Any) -> float | None:
    number = _parse_decimal(value)
    if number is None:
        return None
    return number / 100


def _parse_expiry(text: str | None) -> str | None:
    if not text or "open" in text.casefold():
        return None
    for fmt in ("%d.%m.%Y", "%d.%m.%y", "%Y-%m-%d"):
        try:
            return datetime.strptime(text.strip(), fmt).date().isoformat()
        except ValueError:
            continue
    return text.strip()


def _find_isin(text: str) -> str | None:
    match = re.search(r"\b[A-Z]{2}[A-Z0-9]{9}\d\b", text)
    return match.group(0) if match else None
