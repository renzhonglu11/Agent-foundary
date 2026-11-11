from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

import httpx

from agent_foundry_python.structured_products.enrichment import ProductData
from agent_foundry_python.structured_products.models import Greek, InstrumentMetadata, Quote
from agent_foundry_python.structured_products.providers.refusal import SourceGuard

SOURCE = "boerse_frankfurt"
HEADERS = {
    "Accept": "application/json",
    "User-Agent": "Mozilla/5.0 (compatible; Agent-Foundry/structured-products)",
}


class BoerseFrankfurtQuoteProvider:
    """Quote provider using Börse Frankfurt's public price-information endpoint."""

    BASE_URL = "https://api.boerse-frankfurt.de/v1/data/price_information/single"
    source = SOURCE

    def __init__(
        self,
        *,
        mic: str = "XSTU",
        timeout: float = 20.0,
        transport: httpx.AsyncBaseTransport | None = None,
        guard: SourceGuard | None = None,
    ) -> None:
        self.mic = mic
        self._owns_guard = guard is None
        self.guard = guard or SourceGuard("api.boerse-frankfurt.de")
        self._client = httpx.AsyncClient(timeout=timeout, transport=transport, headers=HEADERS)

    async def get_quote(self, isin: str) -> Quote | None:
        if self.guard.refused:
            return None
        try:
            response = await self.guard.get(self._client, self.BASE_URL, params={"isin": isin, "mic": self.mic})
            if response is None:
                return None
            response.raise_for_status()
            payload = response.json()
            return parse_quote_payload(isin, payload)
        except (httpx.HTTPError, ValueError, TypeError):
            return None

    async def aclose(self) -> None:
        await self._client.aclose()
        if self._owns_guard:
            self.guard.close()

    async def __aenter__(self) -> "BoerseFrankfurtQuoteProvider":
        return self

    async def __aexit__(self, *_exc: object) -> None:
        await self.aclose()


class BoerseFrankfurtProductProvider:
    """Terms and Greeks from the master-data endpoint behind boerse-frankfurt.de.

    One JSON request per product, no browser. The endpoint serves the exchange's
    own website and is not a documented API, so its shape can change.
    """

    BASE_URL = "https://api.boerse-frankfurt.de/v1/data/derivatives_master_data"

    def __init__(
        self,
        *,
        timeout: float = 20.0,
        transport: httpx.AsyncBaseTransport | None = None,
        guard: SourceGuard | None = None,
    ) -> None:
        self._owns_guard = guard is None
        self.guard = guard or SourceGuard("api.boerse-frankfurt.de")
        self._client = httpx.AsyncClient(timeout=timeout, transport=transport, headers=HEADERS)

    async def get_product_data(self, isin: str) -> ProductData | None:
        if self.guard.refused:
            return None
        try:
            response = await self.guard.get(self._client, self.BASE_URL, params={"isin": isin})
            if response is None:
                return None
            response.raise_for_status()
            return parse_product_payload(isin, response.json())
        except (httpx.HTTPError, ValueError, TypeError):
            return None

    async def aclose(self) -> None:
        await self._client.aclose()
        if self._owns_guard:
            self.guard.close()


# EUSIPA derivative map codes seen on the endpoint; other products are
# recognised by their German type name.
EUSIPA_PRODUCT_TYPES = {
    2100: "optionsschein",
    2205: "open_end_turbo",
    2300: "factor_certificate",
}


def parse_product_payload(isin: str, payload: Any) -> ProductData:
    if not isinstance(payload, dict) or str(payload.get("isin") or "").upper() != isin.upper():
        raise ValueError(f"Börse Frankfurt master data does not describe {isin}")

    underlyings = payload.get("underlyings")
    underlying = underlyings[0] if isinstance(underlyings, list) and underlyings and isinstance(underlyings[0], dict) else {}
    product_type = _product_type(payload)
    # A factor certificate states its factor as a participation in percent.
    leverage = (
        _scaled(payload.get("participation"), 0.01)
        if product_type == "factor_certificate"
        else _number(payload.get("figureOptionLeverage"))
    )
    metadata = InstrumentMetadata(
        isin=isin,
        wkn=_text(payload.get("wkn")),
        issuer=_text(payload.get("issuer")),
        underlying=_text(underlying.get("underlyingName")),
        product_type=product_type,
        leverage=abs(leverage) if leverage else None,
        strike_price=_number(underlying.get("strikeValue")),
        knockout_price=_number(underlying.get("knockOutBarrierValue")),
        ratio=_number(payload.get("ratio")),
        expiry=_date(payload.get("finalValuationDate") or payload.get("lastListingDate")),
        option_type=_option_type(payload),
    )

    greeks = {
        "delta": _number(payload.get("figureOptionDelta")),
        "omega": _number(payload.get("figureOptionOmega")),
        "theta": _number(payload.get("figureOptionTheta")),
        # Reported in percent; the pipeline carries volatility as a fraction.
        "iv": _scaled(payload.get("figureImplVolaMid"), 0.01) or None,
    }
    greek = None
    if any(value is not None for value in greeks.values()):
        greek = Greek(isin=isin, timestamp=_timestamp(payload.get("figureQuoteTime")), **greeks)
    return ProductData(metadata=metadata, greek=greek, source=SOURCE)


def _product_type(payload: dict[str, Any]) -> str | None:
    known = EUSIPA_PRODUCT_TYPES.get(payload.get("eusipaCode"))
    if known is not None:
        return known
    text = str(payload.get("productType") or "").lower()
    if "faktor" in text or "factor" in text:
        return "factor_certificate"
    if "open-end" in text or "open end" in text or "turbo" in text or "mini" in text:
        return "open_end_turbo"
    if "knock" in text:
        return "knock_out"
    if "optionsschein" in text or "warrant" in text:
        return "optionsschein"
    return None


def _option_type(payload: dict[str, Any]) -> str | None:
    text = f"{payload.get('participationTypeName') or ''} {payload.get('productType') or ''}".lower()
    if any(word in text for word in ("put", "short", "bear")):
        return "put"
    if any(word in text for word in ("call", "long", "bull")):
        return "call"
    return None


def _text(value: Any) -> str | None:
    if isinstance(value, dict):
        value = value.get("originalValue")
    text = str(value).strip() if value is not None else ""
    return text or None


def _number(value: Any) -> float | None:
    if isinstance(value, dict):
        value = value.get("value")
    if value is None or value == "" or isinstance(value, bool):
        return None
    number = float(value)
    return number if number == number and abs(number) != float("inf") else None


def _scaled(value: Any, factor: float) -> float | None:
    number = _number(value)
    return None if number is None else number * factor


def _date(value: Any) -> str | None:
    text = str(value or "")[:10]
    try:
        return datetime.strptime(text, "%Y-%m-%d").date().isoformat()
    except ValueError:
        return None


def _timestamp(value: Any) -> datetime:
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return datetime.now(timezone.utc)
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def parse_quote_payload(isin: str, payload: dict[str, Any]) -> Quote:
    if not isinstance(payload, dict) or str(payload.get("isin") or "").upper() != isin.upper():
        raise ValueError("Quote does not match requested ISIN")
    price = payload.get("lastPrice")
    if price is None or isinstance(price, bool) or not (0 <= float(price) < float("inf")):
        raise ValueError(f"Börse Frankfurt response for {isin} is missing lastPrice")
    currency = _parse_currency(payload.get("currency"))
    if not currency:
        raise ValueError("Quote has no currency")
    # Never turn the retrieval time into a market timestamp.
    timestamp = datetime.fromisoformat(str(payload.get("timestampLastPrice")).replace("Z", "+00:00"))
    if timestamp.tzinfo is None:
        raise ValueError("Quote has no timezone")

    return Quote(
        isin=isin,
        price=float(price),
        currency=currency,
        timestamp=timestamp,
        day_high=_optional_float(payload.get("dayHigh")),
        day_low=_optional_float(payload.get("dayLow")),
    )


def _parse_currency(value: Any) -> str:
    if isinstance(value, dict):
        return str(value.get("originalValue") or value.get("value") or "")
    return str(value or "")


def _optional_float(value: Any) -> float | None:
    if value is None or value == "":
        return None
    return float(value)
