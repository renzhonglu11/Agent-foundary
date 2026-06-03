from __future__ import annotations

import json
import re
from collections.abc import Callable
from datetime import datetime
from inspect import isawaitable
from typing import Awaitable, Iterable

import httpx
from bs4 import BeautifulSoup

from agent_foundry_python.structured_products.models import Greek, InstrumentMetadata

LABEL_ALIASES = {
    "emittent": "issuer",
    "issuer": "issuer",
    "wkn": "wkn",
    "isin": "isin",
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
    "k.o.": "knockout_price",
    "ko": "knockout_price",
    "knock out": "knockout_price",
    "knockout": "knockout_price",
    "ko-schwelle": "knockout_price",
    "break-even": "break_even",
    "break even": "break_even",
    "break-even-punkt": "break_even",
    "break even punkt": "break_even",
    "break-even point": "break_even",
    "gewinnschwelle": "break_even",
    "bezugsverhältnis": "ratio",
    "bezugsverhaeltnis": "ratio",
    "ratio": "ratio",
    "fälligkeit": "expiry",
    "faelligkeit": "expiry",
    "expiry": "expiry",
    "delta": "delta",
    "omega": "omega",
    "theta": "theta",
    "impl. volatilität": "iv",
    "impl. volatilitaet": "iv",
    "implizite volatilität": "iv",
    "implizite volatilitaet": "iv",
    "volatilität": "iv",
    "volatilitaet": "iv",
}

PRODUCT_TYPES = {
    "optionsschein": "optionsschein",
    "knock-out": "knock_out",
    "knock out": "knock_out",
    "open-end turbo": "open_end_turbo",
    "open end turbo": "open_end_turbo",
    "turbo": "open_end_turbo",
    "faktor zertifikat": "factor_certificate",
    "faktor-zertifikat": "factor_certificate",
    "factor certificate": "factor_certificate",
}


class OnvistaUrlResolver:
    """Resolve ISIN to an Onvista product URL through the public search route."""

    SEARCH_URL = "https://www.onvista.de/suche"

    def __init__(self, *, timeout: float = 20.0, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self._client = httpx.AsyncClient(
            timeout=timeout,
            transport=transport,
            follow_redirects=True,
            headers={
                "User-Agent": "Mozilla/5.0 (compatible; Agent-Foundry/structured-products)",
                "Accept-Language": "de-DE,de;q=0.9,en;q=0.8",
            },
        )

    async def resolve(self, isin: str) -> str | None:
        try:
            response = await self._client.get(self.SEARCH_URL, params={"searchValue": isin})
            response.raise_for_status()
            return str(response.url)
        except httpx.HTTPError:
            return None

    async def aclose(self) -> None:
        await self._client.aclose()


class OnvistaProductData:
    def __init__(self, *, metadata: InstrumentMetadata, greek: Greek | None = None, source: str = "onvista", url: str | None = None) -> None:
        self.metadata = metadata
        self.greek = greek
        self.source = source
        self.url = url


class OnvistaProductProvider:
    def __init__(self, *, timeout: float = 20.0, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self._resolver = OnvistaUrlResolver(timeout=timeout, transport=transport)
        self._metadata_provider = OnvistaMetadataProvider(
            timeout=timeout,
            transport=transport,
            url_resolver=self._resolver.resolve,
        )

    async def get_product_data(self, isin: str) -> OnvistaProductData | None:
        result = self._metadata_provider._url_resolver(isin) if self._metadata_provider._url_resolver is not None else None
        url = await result if isawaitable(result) else result
        if not url:
            return None
        try:
            response = await self._metadata_provider._client.get(url)
            response.raise_for_status()
            return parse_onvista_product_data(response.text)
        except (httpx.HTTPError, ValueError):
            return None

    async def aclose(self) -> None:
        await self._metadata_provider.aclose()
        await self._resolver.aclose()


class OnvistaMetadataProvider:
    """SSR HTML metadata provider for Onvista derivative pages.

    Onvista pages do not expose a stable documented "ISIN -> page URL" API.
    Inject ``url_resolver`` from an orchestrator or cache layer so the provider
    can still satisfy the MetadataProvider interface without hardcoding an
    undocumented search endpoint.
    """

    def __init__(
        self,
        *,
        timeout: float = 20.0,
        transport: httpx.AsyncBaseTransport | None = None,
        url_resolver: Callable[[str], str | Awaitable[str | None] | None] | None = None,
    ) -> None:
        self._url_resolver = url_resolver
        self._client = httpx.AsyncClient(
            timeout=timeout,
            transport=transport,
            follow_redirects=True,
            headers={
                "User-Agent": "Mozilla/5.0 (compatible; Agent-Foundry/structured-products)",
                "Accept-Language": "de-DE,de;q=0.9,en;q=0.8",
            },
        )

    async def get_metadata(self, isin: str) -> InstrumentMetadata | None:
        if self._url_resolver is None:
            return None
        result = self._url_resolver(isin)
        url = await result if isawaitable(result) else result
        if not url:
            return None
        return await self.get_metadata_from_url(url)

    async def get_metadata_from_url(self, url: str) -> InstrumentMetadata | None:
        try:
            response = await self._client.get(url)
            response.raise_for_status()
            return parse_onvista_metadata(response.text)
        except (httpx.HTTPError, ValueError):
            return None

    async def aclose(self) -> None:
        await self._client.aclose()



def parse_onvista_metadata(html: str) -> InstrumentMetadata:
    """Parse normalized metadata from an Onvista server-rendered HTML page."""
    return parse_onvista_product_data(html).metadata


def parse_onvista_product_data(html: str) -> OnvistaProductData:
    normalized = _parse_onvista_normalized(html)
    metadata_keys = {
        "isin",
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
    }
    metadata = InstrumentMetadata(**{key: value for key, value in normalized.items() if key in metadata_keys})
    greek_values = {key: normalized.get(key) for key in ("delta", "omega", "theta", "iv") if normalized.get(key) is not None}
    greek = Greek(isin=metadata.isin, **greek_values) if greek_values else None
    return OnvistaProductData(metadata=metadata, greek=greek, source="onvista")


def _parse_onvista_normalized(html: str) -> dict[str, object]:
    soup = BeautifulSoup(html, "lxml")
    fields = _definition_list_fields(soup)
    if not fields:
        fields = _table_like_fields(soup)
    fields.update(_data_card_fields(soup))

    normalized: dict[str, object] = {}
    for raw_label, raw_value in fields.items():
        key = LABEL_ALIASES.get(_normalize_label(raw_label))
        if key is None:
            continue
        normalized[key] = _normalize_value(key, raw_value)

    title_text = " ".join(chunk for chunk in [soup.title.get_text(" ", strip=True) if soup.title else "", _first_heading(soup)] if chunk)
    next_data = _next_data_snapshot(soup)
    if next_data:
        normalized.setdefault("isin", next_data.get("isin"))
        normalized.setdefault("wkn", next_data.get("wkn"))
        if not normalized.get("underlying"):
            normalized["underlying"] = _underlying_from_name(str(next_data.get("name") or ""))
        title_text = f"{title_text} {next_data.get('name') or ''}"
    if not normalized.get("product_type"):
        normalized["product_type"] = _detect_product_type(title_text)

    isin = str(normalized.get("isin") or _find_isin(soup.get_text(" ", strip=True)) or "")
    if not isin:
        raise ValueError("Onvista HTML does not contain an ISIN")
    normalized["isin"] = isin

    return normalized


def _definition_list_fields(soup: BeautifulSoup) -> dict[str, str]:
    fields: dict[str, str] = {}
    for term in soup.find_all("dt"):
        value = term.find_next_sibling("dd")
        if value is not None:
            fields[term.get_text(" ", strip=True)] = value.get_text(" ", strip=True)
    return fields


def _table_like_fields(soup: BeautifulSoup) -> dict[str, str]:
    fields: dict[str, str] = {}
    for row in soup.find_all("tr"):
        cells = row.find_all(["th", "td"])
        if len(cells) >= 2:
            fields[cells[0].get_text(" ", strip=True)] = cells[1].get_text(" ", strip=True)
    return fields


def _data_card_fields(soup: BeautifulSoup) -> dict[str, str]:
    fields: dict[str, str] = {}
    for data in soup.find_all("data"):
        value = str(data.get("value") or data.get_text(" ", strip=True))
        if not value:
            continue
        for container in data.parents:
            if getattr(container, "name", None) not in {"div", "section", "article"}:
                continue
            label = container.find("span")
            if label is None:
                continue
            label_text = label.get_text(" ", strip=True)
            if label_text and data not in label.parents:
                fields[label_text] = value
                break
    return fields


def _normalize_label(label: str) -> str:
    return " ".join(label.casefold().replace(":", " ").split())


def _normalize_value(key: str, value: str) -> object:
    cleaned = " ".join(value.split())
    if key in {"leverage", "strike_price", "knockout_price", "break_even", "ratio", "delta", "omega", "theta", "iv"}:
        number = _parse_decimal(cleaned)
        if key == "iv" and number is not None and ("%" in cleaned or number > 1):
            return number / 100
        return number
    if key == "product_type":
        return _detect_product_type(cleaned)
    if key == "expiry":
        return _parse_expiry(cleaned)
    return cleaned


def _parse_decimal(text: str) -> float | None:
    match = re.search(r"[-+]?\d+(?:[.,]\d+)?", text.replace("\u202f", " "))
    if not match:
        return None
    return float(match.group(0).replace(".", "").replace(",", ".") if "," in match.group(0) else match.group(0))


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
    priority = [
        ("open-end turbo", "open_end_turbo"),
        ("open end turbo", "open_end_turbo"),
        ("turbo-optionsschein", "open_end_turbo"),
        ("knock-out", "knock_out"),
        ("knock out", "knock_out"),
        ("turbo", "open_end_turbo"),
        ("faktor zertifikat", "factor_certificate"),
        ("faktor-zertifikat", "factor_certificate"),
        ("factor certificate", "factor_certificate"),
        ("optionsschein", "optionsschein"),
    ]
    for needle, product_type in priority:
        if needle in lowered:
            return product_type
    return None


def _next_data_snapshot(soup: BeautifulSoup) -> dict[str, object]:
    script = soup.find("script", id="__NEXT_DATA__")
    if script is None:
        return {}
    try:
        payload = json.loads(script.get_text(strip=True))
    except json.JSONDecodeError:
        return {}
    current: object = payload
    for key in ("props", "pageProps", "data", "snapshot", "instrument"):
        if not isinstance(current, dict):
            return {}
        current = current.get(key)
    return current if isinstance(current, dict) else {}


def _underlying_from_name(name: str) -> str | None:
    match = re.search(r"\bAUF\s+(.+?)(?:\s+INC\.?|\s+CORP\.?|\s+AG\b|$)", name, flags=re.IGNORECASE)
    if not match:
        return None
    return " ".join(part.capitalize() for part in match.group(1).split())


def _first_heading(soup: BeautifulSoup) -> str:
    heading = soup.find(["h1", "h2"])
    return heading.get_text(" ", strip=True) if heading else ""


def _find_isin(text: str) -> str | None:
    match = re.search(r"\b[A-Z]{2}[A-Z0-9]{9}\d\b", text)
    return match.group(0) if match else None
