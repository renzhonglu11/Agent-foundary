from __future__ import annotations

from typing import Any

import httpx

from tr_structured_products.models import Quote


class BoerseFrankfurtQuoteProvider:
    """Quote provider using Börse Frankfurt's public price-information endpoint."""

    BASE_URL = "https://api.boerse-frankfurt.de/v1/data/price_information/single"

    def __init__(
        self,
        *,
        mic: str = "XSTU",
        timeout: float = 20.0,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.mic = mic
        self._client = httpx.AsyncClient(
            timeout=timeout,
            transport=transport,
            headers={
                "Accept": "application/json",
                "User-Agent": "Mozilla/5.0 (compatible; Agent-Foundry/structured-products)",
            },
        )

    async def get_quote(self, isin: str) -> Quote | None:
        try:
            response = await self._client.get(self.BASE_URL, params={"isin": isin, "mic": self.mic})
            response.raise_for_status()
            payload = response.json()
            return parse_quote_payload(isin, payload)
        except (httpx.HTTPError, ValueError, TypeError):
            return None

    async def aclose(self) -> None:
        await self._client.aclose()

    async def __aenter__(self) -> "BoerseFrankfurtQuoteProvider":
        return self

    async def __aexit__(self, *_exc: object) -> None:
        await self.aclose()


def parse_quote_payload(isin: str, payload: dict[str, Any]) -> Quote:
    price = payload.get("lastPrice")
    if price is None:
        raise ValueError(f"Börse Frankfurt response for {isin} is missing lastPrice")

    return Quote(
        isin=isin,
        price=float(price),
        currency=_parse_currency(payload.get("currency")),
        day_high=_optional_float(payload.get("dayHigh")),
        day_low=_optional_float(payload.get("dayLow")),
    )


def _parse_currency(value: Any) -> str:
    if isinstance(value, dict):
        return str(value.get("originalValue") or value.get("value") or "EUR")
    return str(value or "EUR")


def _optional_float(value: Any) -> float | None:
    if value is None or value == "":
        return None
    return float(value)
