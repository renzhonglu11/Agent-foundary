"""Provider interfaces for structured product enrichment."""

from __future__ import annotations

from typing import Protocol

from .models import InstrumentMetadata, Quote


class MetadataProvider(Protocol):
    async def get_metadata(self, isin: str) -> InstrumentMetadata | None:
        ...


class QuoteProvider(Protocol):
    async def get_quote(self, isin: str) -> Quote | None:
        ...


class GreeksProvider(Protocol):
    async def get_greeks(self, isin: str) -> dict | None:
        ...
