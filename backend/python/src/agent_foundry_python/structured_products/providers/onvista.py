"""Terms and Greeks from the product snapshot behind onvista.de.

The website itself answers some hosts with a bot-protection page, among them
the production server; the JSON endpoint its pages read from does not. It is
not a documented API, so its shape can change.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

import httpx

from agent_foundry_python.structured_products.enrichment import ProductData
from agent_foundry_python.structured_products.models import Greek, InstrumentMetadata
from agent_foundry_python.structured_products.providers.refusal import SourceGuard

SOURCE = "onvista"


class OnvistaProductProvider:
    """One JSON request per product."""

    BASE_URL = "https://api.onvista.de/api/v1/derivatives"

    def __init__(
        self,
        *,
        timeout: float = 20.0,
        transport: httpx.AsyncBaseTransport | None = None,
        guard: SourceGuard | None = None,
    ) -> None:
        self.guard = guard or SourceGuard("onvista.de")
        self._client = httpx.AsyncClient(
            timeout=timeout,
            transport=transport,
            headers={
                "Accept": "application/json",
                "User-Agent": "Mozilla/5.0 (compatible; Agent-Foundry/structured-products)",
            },
        )

    async def get_product_data(self, isin: str) -> ProductData | None:
        if self.guard.refused:
            return None
        try:
            response = await self._client.get(f"{self.BASE_URL}/ISIN:{isin}/snapshot")
            self.guard.check(response)
            response.raise_for_status()
            return parse_snapshot(isin, response.json())
        except (httpx.HTTPError, ValueError, TypeError):
            return None

    async def aclose(self) -> None:
        await self._client.aclose()


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
