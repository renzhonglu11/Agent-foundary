from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from pydantic import BaseModel, Field


class Position(BaseModel):
    isin: str
    quantity: float
    avg_cost: float | None = None
    source: str = "trade_republic"


class Quote(BaseModel):
    isin: str
    price: float
    currency: str = "EUR"
    timestamp: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    day_high: Optional[float] = None
    day_low: Optional[float] = None


class Greek(BaseModel):
    isin: str
    timestamp: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    delta: Optional[float] = None
    omega: Optional[float] = None
    theta: Optional[float] = None
    iv: Optional[float] = None


class Exposure(BaseModel):
    isin: str
    quantity: float
    delta: float
    underlying_price: float
    delta_exposure: float
    market_value: float
    currency: str


class InstrumentMetadata(BaseModel):
    isin: str
    wkn: Optional[str] = None
    issuer: Optional[str] = None
    underlying: Optional[str] = None
    product_type: Optional[str] = None
    leverage: Optional[float] = None
    strike_price: Optional[float] = None
    knockout_price: Optional[float] = None
    break_even: Optional[float] = None
    ratio: Optional[float] = None
    expiry: Optional[str] = None
    option_type: Optional[str] = None
    reset_barrier: Optional[float] = None
    last_updated: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))

