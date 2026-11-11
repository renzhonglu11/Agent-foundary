"""Terms and Greeks from the product snapshot behind onvista.de.

The website itself answers some hosts with a bot-protection page, among them
the production server; the JSON endpoint its pages read from does not. It is
not a documented API, so its shape can change.
"""

from __future__ import annotations

import asyncio
import time
from datetime import datetime, timezone
from typing import Any

import httpx

from agent_foundry_python.structured_products.enrichment import ProductData
from agent_foundry_python.structured_products.models import Greek, InstrumentMetadata, Quote
from agent_foundry_python.structured_products.providers.refusal import SourceGuard

SOURCE = "onvista"


class OnvistaProductProvider:
    """One JSON request per product."""

    BASE_URL = "https://api.onvista.de/api/v1/derivatives"
    source = SOURCE

    def __init__(
        self,
        *,
        timeout: float = 20.0,
        transport: httpx.AsyncBaseTransport | None = None,
        guard: SourceGuard | None = None,
    ) -> None:
        self._owns_guard = guard is None
        self.guard = guard or SourceGuard("api.onvista.de")
        self._snapshots: dict[str, tuple[float, dict]] = {}
        self._snapshot_lock = asyncio.Lock()
        self._client = httpx.AsyncClient(
            timeout=timeout,
            transport=transport,
            headers={
                "Accept": "application/json",
                "User-Agent": "Mozilla/5.0 (compatible; Agent-Foundry/structured-products)",
            },
        )

    async def get_product_data(self, isin: str) -> ProductData | None:
        payload = await self._snapshot(isin)
        try:
            return parse_snapshot(isin, payload) if payload is not None else None
        except (ValueError, TypeError):
            return None

    async def get_quote(self, isin: str) -> Quote | None:
        payload = await self._snapshot(isin)
        try:
            return parse_quote(isin, payload) if payload is not None else None
        except (ValueError, TypeError):
            return None

    async def _snapshot(self, isin: str) -> dict | None:
        # Quote fallback and product enrichment consume the same JSON response.
        async with self._snapshot_lock:
            cached = self._snapshots.get(isin)
            if cached and time.monotonic() - cached[0] < 300:
                return cached[1]
            payload = await self._fetch_snapshot(isin)
            if payload is not None:
                if len(self._snapshots) >= 256:
                    del self._snapshots[next(iter(self._snapshots))]
                self._snapshots[isin] = (time.monotonic(), payload)
            return payload

    async def _fetch_snapshot(self, isin: str) -> dict | None:
        if self.guard.refused:
            return None
        try:
            response = await self.guard.get(self._client, f"{self.BASE_URL}/ISIN:{isin}/snapshot")
            if response is None:
                return None
            response.raise_for_status()
            payload = response.json()
            parse_snapshot(isin, payload)  # Reject wrong instruments before caching.
            return payload
        except (httpx.HTTPError, ValueError, TypeError):
            return None

    async def aclose(self) -> None:
        await self._client.aclose()
        if self._owns_guard:
            self.guard.close()


def parse_quote(isin: str, payload: dict) -> Quote:
    if str(_dict(payload.get("instrument")).get("isin") or "").upper() != isin.upper():
        raise ValueError("Quote does not match requested ISIN")
    quote = _dict(payload.get("quote"))
    price = _number(quote.get("last"))
    currency = quote.get("isoCurrency")
    timestamp = datetime.fromisoformat(str(quote.get("datetimeLast")).replace("Z", "+00:00"))
    if price is None or price < 0 or not currency or timestamp.tzinfo is None:
        raise ValueError("Quote needs a price, currency and market timestamp")
    return Quote(isin=isin, price=price, currency=currency, timestamp=timestamp,
                 day_high=_number(quote.get("high")), day_low=_number(quote.get("low")))


def parse_snapshot(isin: str, payload: Any) -> ProductData:
    instrument = payload.get("instrument") if isinstance(payload, dict) else None
    if not isinstance(instrument, dict) or str(instrument.get("isin") or "").upper() != isin.upper():
        raise ValueError(f"onvista snapshot does not describe {isin}")

    details = _dict(payload.get("derivativesDetails"))
    figure = _dict(payload.get("derivativesFigure"))
    underlyings = _dict(payload.get("derivativesUnderlyingList")).get("list")
    underlying = underlyings[0] if isinstance(underlyings, list) and underlyings and isinstance(underlyings[0], dict) else {}
    barriers = {
        barrier.get("typeBarrier"): _number(barrier.get("barrier"))
        for barrier in _dict(underlying.get("derivativesBarrierList")).get("list") or []
        if isinstance(barrier, dict)
    }
    open_ended = details.get("openEnded") is True
    product_type = _product_type(instrument.get("entitySubType"), open_ended)
    # A factor certificate states its factor as a participation rate.
    leverage = (
        _number(details.get("participationRateWin"))
        if product_type == "factor_certificate"
        else _number(figure.get("gearing")) or _number(figure.get("gearingAsk"))
    )
    urls = _dict(instrument.get("urls"))
    metadata = InstrumentMetadata(
        isin=isin,
        wkn=_text(instrument.get("wkn")),
        issuer=_text(_dict(payload.get("derivativesIssuer")).get("name")),
        underlying=_text(_dict(underlying.get("instrument")).get("name")),
        product_type=product_type,
        leverage=abs(leverage) if leverage else None,
        strike_price=barriers.get("STRIKE"),
        knockout_price=barriers.get("KNOCK_OUT"),
        break_even=_number(figure.get("breakEven")),
        ratio=_number(underlying.get("coverRatio")),
        expiry=None if open_ended else _date(details.get("datetimeMaturity")),
        option_type={"C": "call", "P": "put"}.get(details.get("codeExerciseRight")),
        reset_barrier=barriers.get("RESET_LEVEL"),
    )

    implied = _number(figure.get("impliedVolatility")) or _number(figure.get("impliedVolatilityAsk"))
    greeks = {
        "delta": _number(figure.get("delta")),
        # onvista calls the option's elasticity "leverage".
        "omega": _number(figure.get("leverage")),
        "theta": _number(figure.get("thetaDay")),
        # Reported in percent; the pipeline carries volatility as a fraction.
        "iv": implied / 100 if implied else None,
    }
    greek = None
    if any(value is not None for value in greeks.values()):
        greek = Greek(isin=isin, timestamp=_timestamp(figure.get("datetimePrice")), **greeks)
    return ProductData(metadata=metadata, greek=greek, source=SOURCE, url=_text(urls.get("WEBSITE")))


def _product_type(sub_type: Any, open_ended: bool) -> str | None:
    if sub_type == "WARRANT":
        return "optionsschein"
    if sub_type == "KNOCKOUT_CERTIFICATE":
        return "open_end_turbo" if open_ended else "knock_out"
    if sub_type == "FACTOR_CERTIFICATE":
        return "factor_certificate"
    return None


def _dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _text(value: Any) -> str | None:
    text = str(value).strip() if value is not None else ""
    return text or None


def _number(value: Any) -> float | None:
    if value is None or value == "" or isinstance(value, bool):
        return None
    number = float(value)
    return number if number == number and abs(number) != float("inf") else None


def _date(value: Any) -> str | None:
    try:
        return datetime.fromisoformat(str(value)).date().isoformat()
    except ValueError:
        return None


def _timestamp(value: Any) -> datetime:
    try:
        parsed = datetime.fromisoformat(str(value))
    except ValueError:
        return datetime.now(timezone.utc)
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
