from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime
from typing import Any

import httpx
from bs4 import BeautifulSoup

from agent_foundry_python.structured_products.models import Greek, InstrumentMetadata


@dataclass(frozen=True)
class ProductData:
    metadata: InstrumentMetadata
    greek: Greek | None = None
    source: str = "gs.de"
    url: str | None = None


import asyncio
from playwright.async_api import async_playwright, Browser, Playwright, Page

class GsDeProductProvider:
    """GS Markets optionsschein calculator metadata + Greeks provider."""

    BASE_URL = "https://www.gs.de/de/optionsschein-rechner"

    def __init__(self, *, timeout: float = 20.0, transport: Any | None = None) -> None:
        self._timeout = timeout * 1000  # Playwright uses milliseconds
        self._transport = transport
        self._playwright: Playwright | None = None
        self._browser: Browser | None = None
        self._page: Page | None = None

    async def _init_browser(self) -> Page:
        if self._page is not None:
            return self._page
        
        self._playwright = await async_playwright().start()
        self._browser = await self._playwright.chromium.launch(headless=True)
        context = await self._browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            locale="de-DE",
        )
        self._page = await context.new_page()
        return self._page

    async def get_product_data(self, isin: str) -> ProductData | None:
        try:
            url = f"{self.BASE_URL}?isin={isin}"
            if self._transport is not None:
                async with httpx.AsyncClient(transport=self._transport) as client:
                    response = await client.get(url)
                    response.raise_for_status()
                    html = response.text
            else:
                page = await self._init_browser()
                await page.goto(url, wait_until="domcontentloaded", timeout=self._timeout)
                # Wait to allow client-side JS to execute Black-Scholes calculation
                await page.wait_for_timeout(2000)
                html = await page.content()

            product = parse_gs_de_product_html(html)
            if product.metadata.isin.upper() != isin.upper():
                return None
            return ProductData(metadata=product.metadata, greek=product.greek, source="gs.de", url=url)
        except Exception:
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
