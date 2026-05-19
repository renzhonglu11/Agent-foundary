from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime
from typing import Any
from urllib.parse import urljoin

import httpx
from bs4 import BeautifulSoup

from tr_structured_products.models import Greek, InstrumentMetadata
from tr_structured_products.providers.onvista import PRODUCT_TYPES


LABEL_ALIASES = {
    "isin": "isin",
    "wkn": "wkn",
    "emittent": "issuer",
    "issuer": "issuer",
    "basiswert": "underlying",
    "underlying": "underlying",
    "produkttyp": "product_type",
    "produktart": "product_type",
    "product type": "product_type",
    "hebel": "leverage",
    "leverage": "leverage",
    "basispreis": "strike_price",
    "strike": "strike_price",
    "strike price": "strike_price",
    "knock-out": "knockout_price",
    "knock out": "knockout_price",
    "knockout": "knockout_price",
    "ko-schwelle": "knockout_price",
    "bezugsverhältnis": "ratio",
    "bezugsverhaeltnis": "ratio",
    "ratio": "ratio",
    "fälligkeit": "expiry",
    "faelligkeit": "expiry",
    "laufzeitende": "expiry",
    "expiry": "expiry",
    "delta": "delta",
    "omega": "omega",
    "theta": "theta",
    "impl. volatilität": "iv",
    "impl. volatilitaet": "iv",
    "implizite volatilität": "iv",
    "implizite volatilitaet": "iv",
    "iv": "iv",
}

PRODUCT_URL_MARKERS = ("/optionsscheine/", "/zertifikate/", "/hebelprodukte/", "/knock-outs/", "/turbos/")


@dataclass(frozen=True)
class ProductData:
    metadata: InstrumentMetadata
    greek: Greek | None = None
    source: str = "finanzen.net"
    url: str | None = None


class FinanzenNetUrlResolver:
    """Resolve ISINs to finanzen.net SSR product URLs via the public search page."""

    BASE_URL = "https://www.finanzen.net"
    SEARCH_URL = "https://www.finanzen.net/suchergebnis.asp"

    def __init__(self, *, timeout: float = 20.0, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self._client = httpx.AsyncClient(
            timeout=timeout,
            transport=transport,
            headers={"User-Agent": "Mozilla/5.0 (compatible; Agent-Foundry/structured-products)"},
        )

    async def resolve(self, isin: str) -> str | None:
        try:
            response = await self._client.get(self.SEARCH_URL, params={"_search": isin})
            response.raise_for_status()
        except httpx.HTTPError:
            return None
        return resolve_finanzen_url_from_search_html(response.text, isin, base_url=self.BASE_URL)

    async def aclose(self) -> None:
        await self._client.aclose()


class FinanzenNetProductProvider:
    """finanzen.net SSR product metadata + Greeks provider."""

    def __init__(self, *, timeout: float = 20.0, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self._resolver = FinanzenNetUrlResolver(timeout=timeout, transport=transport)
        self._client = httpx.AsyncClient(
            timeout=timeout,
            transport=transport,
            headers={"User-Agent": "Mozilla/5.0 (compatible; Agent-Foundry/structured-products)"},
        )

    async def get_product_data(self, isin: str) -> ProductData | None:
        url = await self._resolver.resolve(isin)
        if not url:
            return None
        return await self.get_product_data_from_url(url)

    async def get_product_data_from_url(self, url: str) -> ProductData | None:
        try:
            response = await self._client.get(url)
            response.raise_for_status()
            product = parse_finanzen_product_html(response.text)
            return ProductData(metadata=product.metadata, greek=product.greek, source="finanzen.net", url=url)
        except (httpx.HTTPError, ValueError):
            return None

    async def aclose(self) -> None:
        await self._resolver.aclose()
        await self._client.aclose()



def resolve_finanzen_url_from_search_html(html: str, isin: str, *, base_url: str = "https://www.finanzen.net") -> str | None:
    soup = BeautifulSoup(html, "lxml")
    isin_upper = isin.upper()
    for anchor in soup.find_all("a", href=True):
        href = str(anchor.get("href") or "")
        text = anchor.get_text(" ", strip=True).upper()
        href_upper = href.upper()
        if isin_upper not in f"{text} {href_upper}":
            continue
        if not any(marker in href.casefold() for marker in PRODUCT_URL_MARKERS):
            continue
        return urljoin(base_url, href)
    return None



def parse_finanzen_product_html(html: str) -> ProductData:
    soup = BeautifulSoup(html, "lxml")
    fields = _extract_fields(soup)
    normalized: dict[str, Any] = {}
    greek_values: dict[str, Any] = {}

    for label, value in fields.items():
        key = LABEL_ALIASES.get(_normalize_label(label))
        if not key:
            continue
        if key in {"delta", "omega", "theta", "iv"}:
            greek_values[key] = _normalize_greek_value(key, value)
        else:
            normalized[key] = _normalize_metadata_value(key, value)

    title_text = " ".join(chunk for chunk in [soup.title.get_text(" ", strip=True) if soup.title else "", _first_heading(soup)] if chunk)
    if not normalized.get("product_type"):
        normalized["product_type"] = _detect_product_type(title_text)

    isin = str(normalized.get("isin") or _find_isin(soup.get_text(" ", strip=True)) or "")
    if not isin:
        raise ValueError("finanzen.net HTML does not contain an ISIN")
    normalized["isin"] = isin

    metadata = InstrumentMetadata(**normalized)
    greek = Greek(isin=isin, **greek_values) if greek_values else None
    return ProductData(metadata=metadata, greek=greek, source="finanzen.net")



def _extract_fields(soup: BeautifulSoup) -> dict[str, str]:
    fields: dict[str, str] = {}
    for term in soup.find_all("dt"):
        value = term.find_next_sibling("dd")
        if value is not None:
            fields[term.get_text(" ", strip=True)] = value.get_text(" ", strip=True)
    for row in soup.find_all("tr"):
        cells = row.find_all(["th", "td"])
        if len(cells) >= 2:
            fields[cells[0].get_text(" ", strip=True)] = cells[1].get_text(" ", strip=True)
    return fields



def _normalize_label(label: str) -> str:
    return " ".join(label.casefold().replace(":", " ").split())



def _normalize_metadata_value(key: str, value: str) -> Any:
    cleaned = " ".join(value.split())
    if key in {"leverage", "strike_price", "knockout_price", "ratio"}:
        return _parse_decimal(cleaned)
    if key == "product_type":
        return _detect_product_type(cleaned)
    if key == "expiry":
        return _parse_expiry(cleaned)
    return cleaned



def _normalize_greek_value(key: str, value: str) -> float | None:
    number = _parse_decimal(value)
    if number is None:
        return None
    if key == "iv" and "%" in value:
        return number / 100
    return number



def _parse_decimal(text: str) -> float | None:
    cleaned = text.replace("\u202f", " ").replace("%", " ")
    match = re.search(r"[-+]?\d+(?:[.,]\d+)?", cleaned)
    if not match:
        return None
    raw = match.group(0)
    return float(raw.replace(".", "").replace(",", ".") if "," in raw else raw)



def _parse_expiry(text: str) -> str | None:
    if not text or "open" in text.casefold():
        return None
    for fmt in ("%d.%m.%Y", "%Y-%m-%d"):
        try:
            return datetime.strptime(text.strip(), fmt).date().isoformat()
        except ValueError:
            continue
    return text.strip()



def _detect_product_type(text: str) -> str | None:
    lowered = text.casefold()
    for needle, product_type in PRODUCT_TYPES.items():
        if needle in lowered:
            return product_type
    return None



def _first_heading(soup: BeautifulSoup) -> str:
    heading = soup.find(["h1", "h2"])
    return heading.get_text(" ", strip=True) if heading else ""



def _find_isin(text: str) -> str | None:
    match = re.search(r"\b[A-Z]{2}[A-Z0-9]{9}\d\b", text)
    return match.group(0) if match else None
